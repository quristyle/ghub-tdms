"""그룹 권한(권한.xlsx 기반 permission_tree.py) 실제 적용 (2026-08-12 CM 요청).

groups.py는 그룹별 허용 리프 키를 group_permissions 표에 저장만 한다. 이 파일이 그 표를
실제 화면·API 접근 통제로 연결한다 — 요청마다 DB를 그대로 조회하므로 캐시가 없고, 관리자가
권한을 저장한 다음 요청부터 바로 반영된다(원칙 4, 재로그인 불필요).

role=ADMIN은 그룹·권한 트리와 무관하게 항상 전체 권한을 갖는다. 그룹이 없는 사용자는
트리에 있는 기능은 전부 N(안전 기본값) — 트리에 없는 화면·기능(조회·다운로드 등)은
이 파일과 무관하게 원래부터 로그인만 하면 열려 있다.
"""

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import ROLE_ADMIN, current_user
from app.database import get_db
from app.models import GroupPermission, User
from app.permission_tree import LEAF_KEYS


def user_allowed_leaves(db: Session, user: User) -> set[str]:
    if user.role == ROLE_ADMIN:
        return set(LEAF_KEYS)
    if not user.group_id:
        return set()
    rows = (
        db.query(GroupPermission.node_key)
        .filter(GroupPermission.group_id == user.group_id, GroupPermission.allowed.is_(True))
        .all()
    )
    return {r[0] for r in rows} & LEAF_KEYS


def has_permission(db: Session, user: User, leaf_key: str) -> bool:
    return user.role == ROLE_ADMIN or leaf_key in user_allowed_leaves(db, user)


def require_permission(leaf_key: str):
    """특정 리프 권한이 있어야만 쓸 수 있는 엔드포인트에 Depends로 건다."""

    def _dep(user: User = Depends(current_user), db: Session = Depends(get_db)) -> User:
        if not has_permission(db, user, leaf_key):
            raise HTTPException(status_code=403, detail="이 기능을 사용할 권한이 없습니다")
        return user

    return _dep
