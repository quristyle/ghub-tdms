# -*- coding: utf-8 -*-
"""초기 비밀번호 그대로인 계정에 "첫 로그인 때 변경"을 걸어 두는 1회성 스크립트 (2026-09-28 CM 승인).

배경
  모의해킹 보고서가 "새 계정·초기화 계정의 비밀번호가 ghub+아이디로 예측 가능하다"고 지적했다.
  확인해 보니 쓰는 계정 8개 중 7개가 아직 초기값 그대로였다(관리자 계정만 바꿔 둔 상태).
  그래서 ① 앞으로 만드는 계정·초기화하는 계정은 그 비밀번호를 첫 로그인 한 번만 쓸 수 있게
  고치고(routers/users.py) ② 이미 초기값 그대로인 계정에도 같은 표시를 달아 다음 로그인 때
  새 비밀번호를 정하게 한다. 이 스크립트가 ②다.

하는 일 (딱 이것뿐)
  · 지금 비밀번호가 "ghub+아이디"와 같은 계정을 찾아 must_change_password를 True로 만든다.
    그 사람이 로그인하면 비밀번호 변경 칸이 먼저 열리고, 새 비밀번호를 정해야 화면이 열린다.

손대지 않는 것 (지시 범위 밖)
  · 비밀번호 자체는 바꾸지 않는다 — 지금 쓰던 값으로 그대로 로그인할 수 있다.
  · 비밀번호를 이미 바꾼 계정(관리자 등)은 건드리지 않는다.
  · 로그인 잠금·권한·그룹·계정 상태는 건드리지 않는다.

실행
  python scripts/require_password_change_20260928.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/require_password_change_20260928.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  백업 파일(backup/must_change_password_백업_*.json)에 계정 id와 바꾸기 전 값이 들어 있다.
"""

import argparse
import io
import json
import os
import sys
from datetime import datetime

# Windows 콘솔 기본 인코딩(cp949)으로는 한글이 깨지거나 오류가 난다.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.auth import default_password, verify_password  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, User  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    db = SessionLocal()
    targets = []
    for user in db.query(User).order_by(User.id).all():
        if not verify_password(default_password(user.username), user.password_hash):
            continue
        if user.must_change_password:
            continue  # 이미 걸려 있는 계정은 그대로 둔다
        targets.append(user)

    print("초기 비밀번호 그대로인 계정: %d개" % len(targets))
    for u in targets:
        print("  [%d] 아이디 %s · %s · 권한 %s · 사용 %s · 마지막접속 %s"
              % (u.id, u.username, u.name, u.role, "예" if u.is_active else "아니오",
                 u.last_login_at.strftime("%Y-%m-%d") if u.last_login_at else "없음"))

    if not targets:
        print("\n손댈 계정이 없습니다.")
        return

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "must_change_password_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump(
            [{"id": u.id, "username": u.username, "name": u.name,
              "must_change_password_before": bool(u.must_change_password)} for u in targets],
            handle, ensure_ascii=False, indent=2,
        )
    print("\n백업 저장: %s" % backup_path)

    for u in targets:
        u.must_change_password = True

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID, action="USER_UPDATE", screen="사용자 관리",
        detail={"script": "require_password_change_20260928",
                "reason": "초기 비밀번호 그대로인 계정에 첫 로그인 변경 요구",
                "user_ids": [u.id for u in targets],
                "usernames": [u.username for u in targets],
                "backup": os.path.basename(backup_path)},
    ))
    db.commit()
    print("계정 %d개에 '첫 로그인 때 비밀번호 변경'을 걸었습니다." % len(targets))


if __name__ == "__main__":
    main()
