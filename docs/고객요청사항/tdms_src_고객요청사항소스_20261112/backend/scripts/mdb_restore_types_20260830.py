# -*- coding: utf-8 -*-
"""MDB 자료유형·설비유형 되돌리기 — mdb_apply_types_20260830.py가 남긴 백업으로 원상복구한다.

백업 파일은 backup/mdb_types_백업_YYYYMMDD_HHMMSS.json 이고, 그 시점의
 · mdb_doc_types / equipment_types 목록
 · 파일마다의 doc_type / equipment_type 값
이 들어 있다.

새로 만들어진 자료유형은 그 뒤에 CM이 자료에 직접 지정했을 수 있으므로 **지우지 않는다**
(원칙 1 — 목록에서 지우는 것은 CM이 화면에서 판단할 일이다). 자료에 붙은 값만 되돌린다.

실행
  python scripts/mdb_restore_types_20260830.py backup/mdb_types_백업_....json
  python scripts/mdb_restore_types_20260830.py backup/mdb_types_백업_....json --apply
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
from app.models import AuditLog, MdbFile  # noqa: E402

SYSTEM_USER_ID = 1  # 일괄등록 계정


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", help="되돌릴 백업 json 파일 경로")
    parser.add_argument("--apply", action="store_true", help="실제로 되돌린다(없으면 dry-run)")
    args = parser.parse_args()

    with open(args.backup, encoding="utf-8") as handle:
        saved = json.load(handle)
    saved_files = {row["id"]: row for row in saved["mdb_files"]}

    db = SessionLocal()
    rows = db.query(MdbFile).all()
    changes = []
    missing = 0
    for row in rows:
        old = saved_files.get(row.id)
        if old is None:
            missing += 1
            continue
        if row.doc_type != old["doc_type"] or row.equipment_type != old["equipment_type"]:
            changes.append((row, old))

    print("백업 시점 파일 %d개 / 지금 파일 %d개" % (len(saved_files), len(rows)))
    if missing:
        print("백업에 없는 파일 %d개는 건드리지 않는다(그 뒤에 새로 등록된 것)." % missing)
    print("되돌릴 파일: %d개" % len(changes))

    if not args.apply:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 실행은 --apply 를 붙이세요.")
        db.close()
        return

    for row, old in changes:
        row.doc_type = old["doc_type"]
        row.equipment_type = old["equipment_type"]
    db.add(AuditLog(
        user_id=SYSTEM_USER_ID,
        action="MDB_TYPES_RESTORE",
        document_id=None,
        detail={
            "script": "mdb_restore_types_20260830.py",
            "backup": os.path.basename(args.backup),
            "restored_files": len(changes),
        },
    ))
    db.commit()
    print("되돌리기 완료: 파일 %d개" % len(changes))
    print("(새로 만들어진 자료유형 목록 자체는 그대로 둡니다 — 필요하면 MDB 관리 화면에서 지우세요.)")
    db.close()


if __name__ == "__main__":
    main()
