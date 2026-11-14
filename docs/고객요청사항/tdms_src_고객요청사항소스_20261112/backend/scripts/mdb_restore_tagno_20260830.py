# -*- coding: utf-8 -*-
"""MDB Tag No 되돌리기 — mdb_apply_tagno_20260830.py가 남긴 백업 파일로 원상복구한다.

백업 파일은 backup/mdb_file_tags_백업_YYYYMMDD_HHMMSS.json 이고,
그 시점의 mdb_file_tags 표 전체(자료-태그 연결 전부)가 들어 있다.

실행
  python scripts/mdb_restore_tagno_20260830.py backup/mdb_file_tags_백업_...json --dry-run
  python scripts/mdb_restore_tagno_20260830.py backup/mdb_file_tags_백업_...json --apply
"""

import argparse
import io
import json
import os
import sys

# Windows 콘솔 기본 인코딩(cp949)으로는 한글·기호가 깨지거나 오류가 난다.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, MdbFile, MdbFileTag  # noqa: E402

SYSTEM_USER_ID = 1  # 일괄등록 계정


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", help="되돌릴 백업 json 파일 경로")
    parser.add_argument("--apply", action="store_true", help="실제로 되돌린다(없으면 dry-run)")
    args = parser.parse_args()

    with open(args.backup, encoding="utf-8") as handle:
        saved = json.load(handle)

    db = SessionLocal()
    current = db.query(MdbFileTag).all()
    print("지금 Tag No 연결: %d줄" % len(current))
    print("백업 파일 안:     %d줄" % len(saved))

    # 백업에 있는 파일 id가 지금도 있는지 확인한다(그 사이 자료가 지워졌을 수 있다).
    live_ids = {row.id for row in db.query(MdbFile.id).all()}
    missing = {row["mdb_file_id"] for row in saved} - live_ids
    if missing:
        print("!! 백업에 있는 파일 %d개가 지금은 없다 — 그 줄은 건너뛴다." % len(missing))

    restorable = [row for row in saved if row["mdb_file_id"] in live_ids]
    print("되돌릴 줄: %d줄" % len(restorable))

    if not args.apply:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 실행은 --apply 를 붙이세요.")
        db.close()
        return

    db.query(MdbFileTag).delete()
    for row in restorable:
        db.add(MdbFileTag(mdb_file_id=row["mdb_file_id"], tag_no=row["tag_no"]))
    db.add(AuditLog(
        user_id=SYSTEM_USER_ID,
        action="MDB_TAGNO_RESTORE",
        document_id=None,
        detail={
            "script": "mdb_restore_tagno_20260830.py",
            "backup": os.path.basename(args.backup),
            "restored": len(restorable),
            "skipped_missing_files": len(missing),
        },
    ))
    db.commit()
    print("되돌리기 완료: %d줄" % len(restorable))
    db.close()


if __name__ == "__main__":
    main()
