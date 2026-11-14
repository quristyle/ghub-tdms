# -*- coding: utf-8 -*-
"""apply_rev_tail_20261001.py --apply 로 바꾼 파일 이름을 원래대로 되돌린다.

반영할 때 남긴 기록 파일(backup\\rev_tail_20261001_기록_날짜.jsonl)을 한 줄씩 거꾸로 읽어,
지금 새 이름으로 있는 파일만 옛 이름으로 돌리고 files.file_path도 옛 값으로 되돌린다.
중간에 멈춘 반영이라도 실제로 바뀐 것만 되돌린다(새 이름 파일이 없으면 이미 옛 이름이다).

주의: 이 되돌리기만 하면 app/storage.py는 여전히 꼬리를 붙이는 규칙이다. 화면 규칙까지
예전으로 돌리려면 코드도 함께 되돌려야 한다.

실행 (backend 폴더에서)
  venv\\Scripts\\python.exe scripts\\restore_rev_tail_20261001.py ..\\backup\\rev_tail_20261001_기록_날짜.jsonl
  끝에 --apply 를 붙여야 실제로 되돌린다(없으면 몇 개를 되돌릴지만 센다).
"""

import argparse
import io
import json
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app import storage  # noqa: E402
from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, File, User  # noqa: E402

COMMIT_EVERY = 500


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("journal", help="반영할 때 남긴 기록 파일(.jsonl)")
    parser.add_argument("--apply", action="store_true", help="실제로 되돌린다(기본은 세기만)")
    args = parser.parse_args()

    entries = [json.loads(line) for line in open(args.journal, encoding="utf-8") if line.strip()]
    db = SessionLocal()
    try:
        restorable = [e for e in entries if (Path(STORAGE_ROOT) / e["new_file_path"]).is_file()]
        print(f"기록 {len(entries)}줄 중 되돌릴 파일 {len(restorable)}개")
        if not args.apply:
            print("(세기만 했습니다. 실제로 되돌리려면 --apply 를 붙이세요.)")
            return

        done = 0
        for e in reversed(restorable):
            new_abs = Path(STORAGE_ROOT) / e["new_file_path"]
            old_abs = Path(STORAGE_ROOT) / e["old_file_path"]
            if storage.move_stored_file(new_abs, old_abs):
                row = db.get(File, e["file_id"])
                if row is not None and row.file_path == e["new_file_path"]:
                    row.file_path = e["old_file_path"]
                done += 1
                if done % COMMIT_EVERY == 0:
                    db.commit()
                    print(f"  {done} / {len(restorable)}")

        admin = db.query(User).filter(User.role == "ADMIN").order_by(User.id).first()
        db.add(AuditLog(
            user_id=admin.id, action="RENAME_REV_TAIL", screen="폴더·자료 편집",
            detail={"batch": "rev_tail_20261001", "restored": True, "file_count": done,
                    "journal": Path(args.journal).name},
        ))
        db.commit()
        print(f"되돌림 완료: {done}개")
    finally:
        db.close()


if __name__ == "__main__":
    main()
