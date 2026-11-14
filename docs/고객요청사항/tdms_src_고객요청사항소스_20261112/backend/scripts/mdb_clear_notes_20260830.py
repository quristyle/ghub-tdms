# -*- coding: utf-8 -*-
"""MDB 자료 Note 비우기 1회성 스크립트 (2026-08-30 CM 지시).

CM 지시 내용
  "기존에 Note에 내가 몇개 적은게 있는데 그것은 지워도 된다."
  이력관리(Tag No 변경이력) 기능을 새로 만들면서, 앞으로 Note는 이력이 한 줄씩 쌓이는
  자리가 된다. 그 전에 손으로 적어둔 옛 Note를 비워 새로 시작하려는 것이다.

손대지 않는 것 (지시 범위 밖)
  · Tag No·설비유형·자료유형·자료명·경로·파일은 건드리지 않는다.
  · 보관함(삭제)에 들어가 있는 자료의 Note도 함께 비운다 — 되살렸을 때만 옛 Note가
    남아있으면 앞뒤가 안 맞기 때문. (이것 말고 보관함 자료에 하는 일은 없다.)

실행
  python scripts/mdb_clear_notes_20260830.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/mdb_clear_notes_20260830.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  백업 파일(backup/mdb_notes_백업_*.json)에 파일 id와 Note 원문이 그대로 들어 있다.
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

from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, MdbFile  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    db = SessionLocal()
    rows = db.query(MdbFile).filter(MdbFile.note.isnot(None)).order_by(MdbFile.id).all()
    rows = [r for r in rows if (r.note or "").strip()]

    print("Note가 적혀 있는 파일: %d개" % len(rows))
    for r in rows:
        print("  [%d] %s" % (r.id, r.original_filename))
        for line in (r.note or "").split("\n"):
            print("        %s" % line)

    if not rows:
        print("\n비울 Note가 없습니다.")
        return

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "mdb_notes_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump(
            [{"id": r.id, "original_filename": r.original_filename,
              "source_path": r.source_path, "note": r.note} for r in rows],
            handle, ensure_ascii=False, indent=2,
        )
    print("\n백업 저장: %s" % backup_path)

    for r in rows:
        r.note = None

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID, action="MDB_EDIT", screen="MDB 편집",
        detail={
            "scope": "mdb", "script": "mdb_clear_notes_20260830",
            "cleared_files": len(rows), "mdb_file_ids": [r.id for r in rows],
            "backup": os.path.basename(backup_path),
        },
    ))
    db.commit()
    print("파일 %d개의 Note를 비웠습니다." % len(rows))


if __name__ == "__main__":
    main()
