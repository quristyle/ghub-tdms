from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import (
    LOCKOUT_MINUTES,
    MAX_FAILED_LOGINS,
    PASSWORD_CHANGE_DEFER_KEY,
    PASSWORD_RULE_TEXT,
    clear_login_lock,
    current_user,
    defer_password_change,
    hash_password,
    lock_after_failed_login,
    locked_minutes_left,
    spend_password_check_time,
    start_login_session,
    utc_now,
    validate_new_password,
    verify_password,
)
from app.database import get_db
from app.models import AuditLog, User
from app.permission_tree import PAGE_ORDER, PAGE_PERMISSIONS
from app.permissions import user_allowed_leaves

router = APIRouter(prefix="/auth", tags=["auth"])

LOGIN_FAILED_MESSAGE = "아이디 또는 비밀번호가 올바르지 않습니다"


class LoginRequest(BaseModel):
    username: str
    password: str


class MeResponse(BaseModel):
    id: int
    username: str
    name: str
    role: str
    group_id: int | None = None
    group_name: str | None = None
    permissions: list[str] = []
    # 임시 비밀번호로 들어온 사람은 true — 화면이 비밀번호 변경 칸으로 보낸다 (2026-09-17)
    must_change_password: bool = False
    # 그중 [다음에 변경하기]로 이번만 미룬 사람은 true — 화면이 변경 칸으로 보내지 않는다 (2026-09-29).
    # 이 표시는 세션에만 있어 다음에 다시 로그인하면 false로 돌아간다.
    password_change_deferred: bool = False
    password_rule: str = PASSWORD_RULE_TEXT
    # 화면 파일 → 그 화면에 들어가는 데 필요한 권한, 그리고 상단 메뉴 차례 (2026-09-28).
    # 화면(auth-guard.js)이 이것으로 메뉴 링크를 빼고, 권한 없는 화면에 들어왔을 때
    # 들어갈 수 있는 첫 화면으로 보낸다. 서버(main.py)도 같은 표를 보므로 둘이 어긋나지 않는다.
    page_permissions: dict[str, str] = {}
    page_order: list[str] = []


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


def _me_response(db: Session, user: User, deferred: bool = False) -> MeResponse:
    """권한.xlsx 기준 그룹 권한(리프 키)까지 함께 내려준다 — 프론트가 화면·버튼을
    role 하나가 아니라 실제 그룹 권한으로 가리도록(2026-08-12 CM 확정)."""
    return MeResponse(
        id=user.id,
        username=user.username,
        name=user.name,
        role=user.role,
        group_id=user.group_id,
        group_name=user.group.name if user.group_id else None,
        permissions=sorted(user_allowed_leaves(db, user)),
        must_change_password=user.must_change_password,
        password_change_deferred=deferred,
        page_permissions=dict(PAGE_PERMISSIONS),
        page_order=list(PAGE_ORDER),
    )


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _locked_message(minutes: int) -> str:
    return (
        f"비밀번호를 {MAX_FAILED_LOGINS}번 잘못 입력해 로그인이 잠겼습니다. "
        f"{minutes}분 뒤에 다시 시도하거나, 관리자에게 비밀번호 초기화를 요청하세요."
    )


@router.post("/login", response_model=MeResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """로그인. 비밀번호를 5번 연속 틀리면 15분 동안 잠근다(2026-09-17).

    로그인 실패도 시스템 로그에 남긴다(LOGIN_FAIL, 접속 주소 포함) — 누가 남의 계정으로
    들어오려 했는지 나중에 확인할 수 있어야 하기 때문이다. 없는 아이디로 시도한 경우는
    입력한 글자를 남기지 않는다(비밀번호를 아이디 칸에 잘못 쳐 넣는 경우가 있어서).
    """
    now = utc_now()
    username = body.username.strip()
    user = db.query(User).filter_by(username=username).one_or_none()
    if user is not None and not user.is_active:
        user = None  # 퇴직·삭제 계정은 없는 아이디와 똑같이 다룬다

    if user is not None:
        minutes = locked_minutes_left(user, now)
        if minutes:
            db.add(AuditLog(
                user_id=user.id, action="LOGIN_FAIL", screen="로그인",
                detail={"ip": _client_ip(request), "locked": True},
            ))
            db.commit()
            raise HTTPException(status_code=403, detail=_locked_message(minutes))

    if user is None or user.password_hash in (None, "!unset"):
        spend_password_check_time(body.password)
        ok = False
    else:
        ok = verify_password(body.password, user.password_hash)

    if not ok:
        just_locked = user is not None and lock_after_failed_login(user, now)
        db.add(AuditLog(
            user_id=user.id if user else None, action="LOGIN_FAIL", screen="로그인",
            detail={"ip": _client_ip(request), "locked": just_locked},
        ))
        db.commit()
        if just_locked:
            raise HTTPException(status_code=403, detail=_locked_message(LOCKOUT_MINUTES))
        raise HTTPException(status_code=401, detail=LOGIN_FAILED_MESSAGE)

    clear_login_lock(user)
    start_login_session(request, user)
    user.last_login_at = now
    db.add(AuditLog(
        user_id=user.id, action="LOGIN", screen="로그인", document_id=None,
        detail={"ip": _client_ip(request)},
    ))
    db.commit()
    return _me_response(db, user)


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    username = request.session.get("username")
    if username:
        user = db.query(User).filter_by(username=username).one_or_none()
        if user:
            db.add(AuditLog(user_id=user.id, action="LOGOUT", screen="로그인", document_id=None, detail=None))
            db.commit()
    request.session.clear()
    return {"status": "ok"}


@router.get("/me", response_model=MeResponse)
def me(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _me_response(db, user, bool(request.session.get(PASSWORD_CHANGE_DEFER_KEY)))


@router.post("/password")
def change_own_password(
    body: PasswordChangeRequest, request: Request,
    db: Session = Depends(get_db), user: User = Depends(current_user),
):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="현재 비밀번호가 올바르지 않습니다")
    problem = validate_new_password(body.new_password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if verify_password(body.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail="지금 쓰는 비밀번호와 다른 비밀번호로 정해 주세요")

    # 임시 비밀번호를 바꾸는 것은 로그인 화면에서, 스스로 바꾸는 것은 마이페이지에서 한다
    screen = "로그인" if user.must_change_password else "마이페이지"
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    # 비밀번호가 바뀌면 다른 브라우저의 로그인은 풀리지만, 지금 이 화면의 로그인은 그대로 이어간다
    start_login_session(request, user)
    db.add(AuditLog(user_id=user.id, action="PASSWORD_CHANGE", screen=screen, detail=None))
    db.commit()
    return {"status": "ok"}


@router.post("/password/defer")
def defer_own_password_change(
    request: Request, db: Session = Depends(get_db), user: User = Depends(current_user),
):
    """[다음에 변경하기] — 급할 때 이번만 미루고 그대로 쓴다 (2026-09-29 CM 지시).

    users.must_change_password는 그대로 true로 둔다. 미뤘다는 표시는 세션에만 남으므로
    로그아웃하거나 다음에 다시 로그인하면 비밀번호 변경 안내가 다시 뜬다.
    """
    if user.must_change_password:
        defer_password_change(request)
        db.add(AuditLog(
            user_id=user.id, action="PASSWORD_CHANGE_DEFER", screen="로그인", detail=None,
        ))
        db.commit()
    return {"status": "ok"}
