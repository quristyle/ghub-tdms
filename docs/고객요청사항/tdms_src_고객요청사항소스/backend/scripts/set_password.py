"""계정 비밀번호를 서버 컴퓨터에서 직접 정하는 스크립트.

관리자(CM) 계정의 비밀번호를 잊었거나, 비밀번호를 여러 번 틀려 잠겼을 때 쓴다.
다른 사람 계정은 보통 사용자 관리 화면의 [비밀번호 초기화]를 쓰면 된다.

사용법 (backend 폴더에서):
    venv\\Scripts\\python.exe scripts\\set_password.py
      → 관리자(CM) 계정. 비밀번호는 화면에 안 보이게 두 번 입력받는다.
    venv\\Scripts\\python.exe scripts\\set_password.py --username 1234
      → 다른 계정

비밀번호를 명령줄에 바로 적는 방식은 없앴다(2026-09-17) — 명령 기록에 비밀번호가 남기 때문이다.
여기서 정한 비밀번호는 서버 앞에 앉은 본인이 정한 것이므로 로그인 후 다시 바꾸라고 묻지 않고,
로그인 잠금도 함께 푼다.
"""

import argparse
import getpass
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.auth import (  # noqa: E402
    ADMIN_USERNAME,
    PASSWORD_RULE_TEXT,
    clear_login_lock,
    get_or_create_admin_user,
    hash_password,
    validate_new_password,
)
from app.database import SessionLocal  # noqa: E402
from app.models import User  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Set an account password")
    parser.add_argument("--username", default=ADMIN_USERNAME, help="account id (default: CM admin account)")
    args = parser.parse_args()

    session = SessionLocal()
    try:
        if args.username == ADMIN_USERNAME:
            user = get_or_create_admin_user(session)
        else:
            user = session.query(User).filter_by(username=args.username).one_or_none()
            if user is None:
                print(f"No account with id '{args.username}'. Nothing changed.")
                return

        print(f"Account: {user.username}")
        print(f"Rule: {PASSWORD_RULE_TEXT}")
        password = getpass.getpass("New password: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("The two passwords are different. Nothing changed.")
            return
        problem = validate_new_password(password)
        if problem:
            print(problem)
            print("Nothing changed.")
            return

        user.password_hash = hash_password(password)
        user.must_change_password = False
        clear_login_lock(user)
        session.commit()
        print(f"Password for '{user.username}' has been set.")
    finally:
        session.close()


if __name__ == "__main__":
    main()
