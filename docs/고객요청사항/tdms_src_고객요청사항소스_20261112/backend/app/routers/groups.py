"""사용자 그룹 + 권한 트리 관리 (2026-08-11 CM 요청).

그룹을 만들고 이름을 바꾸고, 그룹별로 소속 사용자를 확인·이동할 수 있다. 그룹별 권한은
app/permission_tree.py에 고정된 트리의 최하위(액션) 노드마다 Y/N을 저장한다. 상위 노드를
Y로 켜면 하위 액션 전부에 적용되는 계산은 화면(프론트)에서 하고, 여기엔 항상 leaf 키만
저장한다(app/permission_tree.LEAF_KEYS로 검증).

D-6: 삭제 기능 없음 — 그룹도 이름만 바꿀 뿐 지우지 않는다.

퇴직·삭제 처리된 계정은 이 화면에 아예 나오지 않는다 — 로그인이 막힌 계정이라 그룹(권한)을
배정할 일이 없기 때문이다(2026-08-12 CM 요청). 원래는 "전체 인원" 목록에만 그 규칙이
들어가 있어서, 그룹을 고르면 삭제한 계정이 그대로 보이고 인원수에도 잡혔다
(2026-09-30 CM 확인 후 아래 _active_members로 통일).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AuditLog, Group, GroupPermission, User
from app.permission_tree import LEAF_KEYS, PERMISSION_TREE
from app.permissions import require_permission
from app.schemas import (
    GroupCreate,
    GroupItem,
    GroupMemberItem,
    GroupPermissionsUpdate,
    GroupUpdate,
)

router = APIRouter(prefix="/groups", tags=["groups"])

# 그룹·권한 트리 편집도 "사용자 관리" 접속 권한과 같은 문(screen.users.access)을 쓴다
# (2026-08-12 CM 확정: 이 권한을 가진 그룹원은 사용자 관리뿐 아니라 그룹·권한 편집까지 가능).
require_users_access = require_permission("screen.users.access")


def _active_members(db: Session, group_id: int):
    """그 그룹에 속한 **재직 계정만** 고르는 공통 조건.

    퇴직·삭제는 둘 다 is_active=False로 저장되므로(users.py 참고) 이 한 줄로 걸러진다.
    """
    return db.query(User).filter(User.group_id == group_id, User.is_active.is_(True))


def _to_item(db: Session, group: Group) -> GroupItem:
    count = _active_members(db, group.id).with_entities(func.count(User.id)).scalar()
    return GroupItem(id=group.id, name=group.name, member_count=count, created_at=group.created_at)


@router.get("", response_model=list[GroupItem])
def list_groups(db: Session = Depends(get_db), _: User = Depends(require_users_access)):
    groups = db.query(Group).order_by(Group.created_at).all()
    return [_to_item(db, g) for g in groups]


@router.post("", response_model=GroupItem)
def create_group(body: GroupCreate, db: Session = Depends(get_db), admin: User = Depends(require_users_access)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="그룹명을 입력해 주세요")
    if db.query(Group).filter_by(name=name).one_or_none():
        raise HTTPException(status_code=400, detail="이미 있는 그룹명입니다")

    group = Group(name=name)
    db.add(group)
    db.flush()

    db.add(AuditLog(
        user_id=admin.id, action="GROUP_CREATE", screen="권한 관리",
        detail={"name": name},
    ))
    db.commit()
    db.refresh(group)
    return _to_item(db, group)


@router.patch("/{group_id}", response_model=GroupItem)
def rename_group(
    group_id: int, body: GroupUpdate, db: Session = Depends(get_db), admin: User = Depends(require_users_access)
):
    group = db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="그룹명을 입력해 주세요")
    dup = db.query(Group).filter(Group.name == name, Group.id != group_id).one_or_none()
    if dup:
        raise HTTPException(status_code=400, detail="이미 있는 그룹명입니다")

    old_name = group.name
    group.name = name

    db.add(AuditLog(
        user_id=admin.id, action="GROUP_RENAME", screen="권한 관리",
        detail={"old_name": old_name, "new_name": name},
    ))
    db.commit()
    db.refresh(group)
    return _to_item(db, group)


@router.get("/{group_id}/members", response_model=list[GroupMemberItem])
def list_group_members(
    group_id: int, db: Session = Depends(get_db), _: User = Depends(require_users_access)
):
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다")
    return _active_members(db, group_id).order_by(User.name).all()


@router.get("/permission-tree", response_model=list[dict])
def get_permission_tree(_: User = Depends(require_users_access)):
    return PERMISSION_TREE


@router.get("/{group_id}/permissions", response_model=list[str])
def get_group_permissions(
    group_id: int, db: Session = Depends(get_db), _: User = Depends(require_users_access)
):
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다")
    rows = (
        db.query(GroupPermission.node_key)
        .filter(GroupPermission.group_id == group_id, GroupPermission.allowed.is_(True))
        .all()
    )
    return [r[0] for r in rows]


@router.put("/{group_id}/permissions", response_model=list[str])
def set_group_permissions(
    group_id: int,
    body: GroupPermissionsUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_users_access),
):
    group = db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다")

    # 권한 트리는 CM 요청으로 계속 바뀐다. 브라우저 화면을 새로고침하기 전에 저장을 누르면
    # 화면이 들고 있던 트리가 서버의 최신 트리보다 옛것이라 이미 없어진 항목 키가 섞여 올 수
    # 있다 — 이건 사용자 잘못이 아니라 타이밍 문제이므로 저장 전체를 막지 않고 조용히 걸러낸다.
    keys = set(body.allowed_keys) & LEAF_KEYS

    db.query(GroupPermission).filter(GroupPermission.group_id == group_id).delete()
    for key in sorted(keys):
        db.add(GroupPermission(group_id=group_id, node_key=key, allowed=True))

    db.add(AuditLog(
        user_id=admin.id, action="GROUP_PERMISSION_UPDATE", screen="권한 관리",
        detail={"group": group.name, "count": len(keys)},
    ))
    db.commit()
    return sorted(keys)
