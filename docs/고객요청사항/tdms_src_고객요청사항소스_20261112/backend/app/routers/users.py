"""사용자 관리 (D-12, 2026-08-04 CM 결정으로 동료 로그인 허용).

D-6: 삭제 기능 없음 — 계정도 지우지 않는다. 화면엔 재직/퇴직/삭제 3단계로 보이지만,
"삭제"도 겉보기만 삭제고 실제로는 퇴직과 똑같이 비활성화 처리한다(2026-08-11 CM 확정 —
계정을 잘못 만들었을 때 쓰는 용도라 실사용 기록에 영향이 없고, 굳이 실제 삭제를 만들어
D-6 원칙을 깰 이유가 없다는 판단).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import (
    ROLES,
    clear_login_lock,
    current_user,
    default_password,
    hash_password,
    validate_new_password,
)
from app.database import get_db
from app.models import AuditLog, Group, User
from app.permissions import require_permission
from app.schemas import UserCreate, UserGroupUpdate, UserItem, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])

EMPLOYMENT_STATUSES = ("ACTIVE", "RETIRED", "DELETED")

# "사용자 관리" 화면 접속 권한(screen.users.access) — role=ADMIN은 자동 통과, 그 외엔
# 그룹에 이 권한이 켜져 있어야 한다(2026-08-12, 권한.xlsx 기준 CM 확정).
require_users_access = require_permission("screen.users.access")


def _with_group_name(user: User) -> User:
    """UserItem.group_name은 DB 컬럼이 아니라 group 관계에서 그때그때 채우는 표시용 값."""
    user.group_name = user.group.name if user.group_id else None
    return user


@router.get("", response_model=list[UserItem])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_users_access)):
    users = db.query(User).order_by(User.created_at).all()
    return [_with_group_name(u) for u in users]


@router.get("/names")
def list_user_names(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """반출이력·감사로그 화면의 "담당자/사용자" 필터 드롭다운 재료 — 이름·활성여부만
    보여줄 뿐이라 screen.users.access 권한 없이도(로그인만 하면) 쓸 수 있다. 감사로그는
    퇴직자 과거 기록도 찾아야 해서 비활성 계정도 포함해 내려주고, 화면별로 필요하면
    거기서(distributions.js는 활성만) 걸러 쓴다. 그 필터로 실제 남의 기록을 보는지는
    각 화면의 다른사용자 리프 권한이 따로 막는다(distributions.py/audit.py)."""
    rows = db.query(User.id, User.name, User.is_active).order_by(User.name).all()
    return [{"id": r[0], "name": r[1], "is_active": r[2]} for r in rows]


@router.post("", response_model=UserItem)
def create_user(
    body: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_users_access)
):
    """계정 추가. 비밀번호는 기본값(ghub+아이디)으로 만들고, 그 비밀번호는 **첫 로그인 한 번만**
    쓸 수 있다 — 로그인한 뒤 새 비밀번호를 정하기 전에는 비밀번호 변경 말고 아무 기능도 못 쓴다
    (2026-09-28 CM 승인, 모의해킹 지적 반영). 기본값 자체는 외우기 쉽게 예전 방식 그대로 둔다."""
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail="역할은 관리자 또는 조회전용만 가능합니다")
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="아이디를 입력해 주세요")
    if db.query(User).filter_by(username=username).one_or_none():
        raise HTTPException(status_code=400, detail="이미 있는 아이디입니다")

    user = User(
        username=username,
        name=body.name.strip(),
        password_hash=hash_password(default_password(username)),
        role=body.role,
        is_active=True,
        employment_status="ACTIVE",
        must_change_password=True,
    )
    db.add(user)
    db.flush()

    db.add(AuditLog(
        user_id=admin.id, action="USER_CREATE", screen="사용자 관리",
        detail={"username": username, "name": user.name, "role": user.role},
    ))
    db.commit()
    db.refresh(user)
    return _with_group_name(user)


@router.patch("/{user_id}", response_model=UserItem)
def update_user(
    user_id: int, body: UserUpdate, db: Session = Depends(get_db), admin: User = Depends(require_users_access)
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")

    changes = {}
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="이름을 입력해 주세요")
        user.name = name
        changes["name"] = name
    if body.role is not None:
        if body.role not in ROLES:
            raise HTTPException(status_code=400, detail="역할은 관리자 또는 조회전용만 가능합니다")
        if user.id == admin.id and body.role != "ADMIN":
            raise HTTPException(status_code=400, detail="본인 계정의 관리자 권한은 스스로 내릴 수 없습니다")
        user.role = body.role
        changes["role"] = body.role
    if body.employment_status is not None:
        if body.employment_status not in EMPLOYMENT_STATUSES:
            raise HTTPException(status_code=400, detail="계정 상태는 재직/퇴직/삭제만 가능합니다")
        if user.id == admin.id and body.employment_status != "ACTIVE":
            raise HTTPException(status_code=400, detail="본인 계정은 스스로 퇴직·삭제 처리할 수 없습니다")
        user.employment_status = body.employment_status
        user.is_active = body.employment_status == "ACTIVE"
        changes["employment_status"] = body.employment_status
    if body.password:
        problem = validate_new_password(body.password)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        user.password_hash = hash_password(body.password)
        clear_login_lock(user)
        changes["password"] = "변경됨"

    db.add(AuditLog(
        user_id=admin.id, action="USER_UPDATE", screen="사용자 관리",
        detail={"target_username": user.username, **changes},
    ))
    db.commit()
    db.refresh(user)
    return _with_group_name(user)


@router.patch("/{user_id}/group", response_model=UserItem)
def update_user_group(
    user_id: int, body: UserGroupUpdate, db: Session = Depends(get_db), admin: User = Depends(require_users_access)
):
    """사용자를 다른 그룹으로 이동(또는 미배정으로 뺌). 권한 관리 화면에서 사용."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")

    old_group = user.group.name if user.group_id else None
    new_group_name = None
    if body.group_id is not None:
        group = db.get(Group, body.group_id)
        if group is None:
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다")
        new_group_name = group.name
    user.group_id = body.group_id

    db.add(AuditLog(
        user_id=admin.id, action="USER_GROUP_CHANGE", screen="권한 관리",
        detail={"target_username": user.username, "old_group": old_group, "new_group": new_group_name},
    ))
    db.commit()
    db.refresh(user)
    return _with_group_name(user)


@router.post("/{user_id}/reset-password", response_model=UserItem)
def reset_password(
    user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_users_access)
):
    """비밀번호를 기본값(ghub+아이디)으로 되돌리고 로그인 잠금도 푼다.

    되돌린 비밀번호는 계정 추가 때와 마찬가지로 **첫 로그인 한 번만** 쓸 수 있다
    (2026-09-28 CM 승인) — 본인이 새 비밀번호를 정해야 다른 화면이 열린다."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")

    user.password_hash = hash_password(default_password(user.username))
    user.must_change_password = True
    clear_login_lock(user)

    db.add(AuditLog(
        user_id=admin.id, action="USER_PASSWORD_RESET", screen="사용자 관리",
        detail={"target_username": user.username},
    ))
    db.commit()
    db.refresh(user)
    return _with_group_name(user)
