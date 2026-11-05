"""로그인 및 권한 (화면 1, D-12: 2026-08-04 CM 결정으로 동료 로그인 허용).

비밀번호는 stdlib pbkdf2_hmac로 해시한다.

권한은 두 단계만 둔다(상세 등급은 나중에 필요해지면 추가):
- ADMIN: CM과 동일한 전체 권한 (반출·반입·폴더편집·MDB관리·사용자관리 등)
- VIEWER: 조회·다운로드만. 그 외 화면·기능은 API 단에서 403으로 막는다(화면에서도 숨김)

2026-09-17 Azure(외부 클라우드) 시험 설치를 앞두고 시큐어코딩으로 고친 것 (CM 지시):
- 로그인 없이 관리자(CM) 계정으로 자동 접속하던 임시 방식(2026-08-16)을 없앴다.
- 비밀번호 규칙은 영문과 숫자를 섞어 8자 이상이다(2026-09-29 CM 지시). 2026-09-17~09-28에는
  4자 이상뿐이었다.
- 비밀번호를 5번 연속 틀리면 15분 동안 그 계정으로 로그인할 수 없다.
- 새 계정·비밀번호 초기화의 기본 비밀번호는 ghub+아이디이고(2026-09-18 CM 지시),
  그 비밀번호로 처음 로그인하면 새 비밀번호를 정하라는 안내가 뜬다
  (2026-09-28 CM 승인 — 아래 DEFAULT_PASSWORD_PREFIX·must_change_password 설명 참고).
  급하면 [다음에 변경하기]로 이번만 미루고 그대로 쓸 수 있고, 다음 로그인 때 다시 안내한다
  (2026-09-29 CM 지시 — 아래 PASSWORD_CHANGE_DEFER_KEY 설명 참고).
- 비밀번호가 바뀌면 그 전에 다른 브라우저에서 해 둔 로그인은 풀린다.
"""

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import SECRET_KEY
from app.database import get_db
from app.models import User

ADMIN_USERNAME = "0023"
_PBKDF2_ROUNDS = 600_000  # 새로 만드는 비밀번호에만 적용된다. 예전 해시는 저장된 반복 횟수로 그대로 확인한다

ROLE_ADMIN = "ADMIN"
ROLE_VIEWER = "VIEWER"
ROLES = (ROLE_ADMIN, ROLE_VIEWER)

# 로그인 잠금 — 연속으로 이만큼 틀리면 잠시 잠근다
MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15

# 비밀번호 규칙 — 영문과 숫자를 섞어 8자 이상(2026-09-29 CM 지시).
# 2026-09-17~09-28에는 4자 이상뿐이었는데, 초기 비밀번호(ghub+아이디)를 그대로 쓰는 계정이
# 많다는 것이 확인돼 CM이 다시 규칙을 넣으라고 했다. 특수문자는 써도 되고 안 써도 된다.
# 규칙 문구는 /auth/me가 내려줘 로그인 화면·마이페이지가 그대로 보여준다.
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 128  # 지나치게 긴 입력으로 서버를 오래 붙잡지 못하게 하는 한도
PASSWORD_RULE_TEXT = f"영문과 숫자를 섞어 {PASSWORD_MIN_LENGTH}자 이상"

# 새 계정·비밀번호 초기화에 쓰는 기본 비밀번호(2026-09-18 CM 지시로 예전 방식으로 되돌림).
# 2026-09-17 하루 동안은 무작위 임시 비밀번호를 쓰고 첫 로그인 때 바꾸게 했는데, CM이 쓰기 불편하다고
# 해서 없앴다. **무작위 임시 비밀번호는 다시 넣지 말 것** — 이 값(ghub+아이디)은 그대로 둔다.
DEFAULT_PASSWORD_PREFIX = "ghub"

# 아래 둘은 "첫 로그인 때 비밀번호 바꾸기" 장치가 쓰는 값이다. 2026-09-18~09-27에는 그 상태로
# 만드는 곳이 없어 잠들어 있었는데, 모의해킹에서 "초기 비밀번호가 언제까지고 그대로 쓰인다"는
# 지적이 나와 2026-09-28 CM 승인으로 다시 켰다(users.py의 계정 추가·비밀번호 초기화가
# must_change_password=True로 만든다). 기본 비밀번호를 쉬운 값으로 두되 그 값으로는 첫 로그인
# 한 번밖에 못 쓰게 하는 것이 목적이다.
PASSWORD_CHANGE_OPEN_PATHS = {"/auth/me", "/auth/password", "/auth/password/defer"}
PASSWORD_CHANGE_REQUIRED_HEADER = "X-Password-Change-Required"

# [다음에 변경하기] — 급할 때 이번만 미루고 그대로 쓰게 하는 표시 (2026-09-29 CM 지시).
# users.must_change_password는 그대로 true로 두고 이 표시만 세션에 남기므로, 로그아웃하거나
# 다음에 다시 로그인하면(start_login_session이 세션을 비운다) 변경 안내가 다시 뜬다.
PASSWORD_CHANGE_DEFER_KEY = "pw_change_deferred"


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    expected = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
    )
    return hmac.compare_digest(expected.hex(), digest_hex)


@lru_cache(maxsize=1)
def _dummy_password_hash() -> str:
    return hash_password(secrets.token_hex(16))


def spend_password_check_time(password: str) -> None:
    """없는 아이디로 로그인할 때도 비밀번호 확인과 같은 시간을 쓴다.

    이게 없으면 "없는 아이디는 바로 거절되고 있는 아이디는 조금 늦게 거절되는" 차이로
    어떤 아이디가 실제로 있는지 알아낼 수 있다.
    """
    verify_password(password, _dummy_password_hash())


def validate_new_password(password: str) -> Optional[str]:
    """새 비밀번호가 규칙에 맞으면 None, 안 맞으면 사용자에게 보여줄 이유를 돌려준다."""
    if len(password) > PASSWORD_MAX_LENGTH:
        return f"비밀번호는 {PASSWORD_MAX_LENGTH}자 이하로 정해 주세요."
    has_letter = any("a" <= c <= "z" or "A" <= c <= "Z" for c in password)
    has_digit = any("0" <= c <= "9" for c in password)
    if len(password) < PASSWORD_MIN_LENGTH or not has_letter or not has_digit:
        return f"새 비밀번호는 {PASSWORD_RULE_TEXT}이어야 합니다."
    return None


def defer_password_change(request: Request) -> None:
    """[다음에 변경하기] — 이번 로그인에서만 비밀번호 변경 안내를 넘긴다 (2026-09-29)."""
    request.session[PASSWORD_CHANGE_DEFER_KEY] = True


def password_change_pending(request: Request, user: User) -> bool:
    """지금 이 사람에게 비밀번호 변경 화면을 띄워야 하는지.

    비밀번호를 바꿔야 하는 상태라도 [다음에 변경하기]로 미뤘으면 이번 로그인 동안은 안 띄운다.
    API(current_user)와 화면 파일(main.py의 _serve_page)이 같은 판단을 쓰도록 여기 한 곳에 둔다.
    """
    if not user.must_change_password:
        return False
    return not request.session.get(PASSWORD_CHANGE_DEFER_KEY)


def default_password(username: str) -> str:
    """신규 계정·비밀번호 초기화 시 쓰는 기본 비밀번호. 예: 아이디 1234 → ghub1234"""
    return f"{DEFAULT_PASSWORD_PREFIX}{username}"


def session_password_mark(password_hash: str) -> str:
    """로그인 세션에 함께 적어 두는 "비밀번호 표식".

    비밀번호가 바뀌면 이 값도 바뀌어, 그 전에 다른 브라우저에서 해 둔 로그인이 풀린다.
    세션 쿠키 내용은 사용자에게 보이므로 해시를 그대로 넣지 않고 비밀 키로 한 번 더 감싼다.
    """
    return hmac.new(SECRET_KEY.encode("utf-8"), password_hash.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def start_login_session(request: Request, user: User) -> None:
    """로그인 성공 시 세션을 새로 채운다. 예전 세션 내용은 남기지 않는다."""
    request.session.clear()
    request.session["username"] = user.username
    request.session["pw"] = session_password_mark(user.password_hash)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def locked_minutes_left(user: User, now: datetime) -> int:
    """잠겨 있으면 풀릴 때까지 남은 분(올림), 안 잠겨 있으면 0."""
    if user.locked_until is None or user.locked_until <= now:
        return 0
    return max(1, -(-int((user.locked_until - now).total_seconds()) // 60))


def lock_after_failed_login(user: User, now: datetime) -> bool:
    """비밀번호를 틀린 횟수를 올리고, 한도에 닿으면 잠근다. 방금 잠갔으면 True."""
    user.failed_login_count = (user.failed_login_count or 0) + 1
    if user.failed_login_count < MAX_FAILED_LOGINS:
        return False
    user.failed_login_count = 0
    user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
    return True


def clear_login_lock(user: User) -> None:
    user.failed_login_count = 0
    user.locked_until = None


def get_or_create_admin_user(db: Session) -> User:
    user = db.query(User).filter_by(username=ADMIN_USERNAME).one_or_none()
    if user is not None:
        return user
    user = User(
        username=ADMIN_USERNAME,
        password_hash="!unset",  # 로그인 불가 상태. set_password.py로 설정해야 함
        name="CM",
        role="ADMIN",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def session_user(request: Request, db: Session) -> Optional[User]:
    """세션에 담긴 로그인 사용자. 로그인 상태가 아니면 None을 돌려준다(예외를 던지지 않는다).

    화면 파일을 내려줄지 정할 때(main.py의 "페이지 접속" 검사)처럼, 로그인하지 않았으면
    401로 끊는 대신 로그인 화면으로 보내야 하는 자리에서 쓴다.
    """
    username = request.session.get("username")
    if not username:
        return None
    user = db.query(User).filter_by(username=username, is_active=True).one_or_none()
    if user is None:
        return None
    if not hmac.compare_digest(
        str(request.session.get("pw", "")), session_password_mark(user.password_hash)
    ):
        return None
    return user


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """로그인한 사용자. 로그인하지 않았으면 401.

    2026-08-16부터 잠시 "세션이 비면 관리자 계정으로 자동 로그인"시켰던 것을 2026-09-17 CM 지시로
    없앴다 — 여러 사람이 네트워크로 접속하면 로그인하지 않은 사람이 전부 관리자가 되기 때문이다.
    """
    user = session_user(request, db)
    if user is None:
        request.session.clear()
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    if password_change_pending(request, user) and request.url.path not in PASSWORD_CHANGE_OPEN_PATHS:
        # 화면(auth-guard.js)이 이 표시를 보고 비밀번호 변경 칸으로 보낸다
        raise HTTPException(
            status_code=403, detail="비밀번호를 먼저 바꿔 주세요",
            headers={PASSWORD_CHANGE_REQUIRED_HEADER: "1"},
        )
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    """관리자 전용 화면·API에 건다. VIEWER(조회·다운로드만)는 403."""
    if user.role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="관리자만 사용할 수 있습니다")
    return user
