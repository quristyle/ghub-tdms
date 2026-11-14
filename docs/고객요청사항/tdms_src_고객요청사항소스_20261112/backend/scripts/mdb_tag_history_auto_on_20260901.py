# -*- coding: utf-8 -*-
"""이미 등록돼 있던 Tag No 이력의 "앞으로 자동 적용"을 켜는 1회성 스크립트 (2026-09-01 CM 지시).

CM 지시 내용
  이력에 [앞으로 이 Tag No가 붙는 자료에도 자동으로 적용] 스위치를 새로 만들면서, 그 전에
  등록돼 있던 이력은 일단 꺼짐으로 넣어두었다(무엇이 있는지 모르는 채로 저절로 발동하면
  놀라기 때문). CM에게 물었더니 "지금부터 전부 켜주세요"라고 확정해 이 스크립트로 켠다.

이 스크립트가 하는 일은 그 스위치를 켜는 것뿐이다
  · 자료(Tag No·Note)는 하나도 건드리지 않는다. 스위치는 **앞으로** 어떤 자료에 그 Tag No를
    새로 달았을 때 발동하는 것이라, 켠다고 지금 있는 자료가 바뀌지 않는다.
  · 되돌린(취소됨) 이력의 스위치도 함께 켜지지만, 취소된 이력은 켜져 있어도 발동하지 않는다
    ([다시 적용]을 눌러야 다시 살아난다). 2026-09-01 현재 취소됨 이력은 없다.

실행
  python scripts/mdb_tag_history_auto_on_20260901.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/mdb_tag_history_auto_on_20260901.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  백업 파일(backup/mdb_tag_history_auto_백업_*.json)에 이력 id와 켜기 전 값이 들어 있다.
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
from app.models import AuditLog, MdbTagHistory  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    db = SessionLocal()
    rows = (
        db.query(MdbTagHistory)
        .filter(MdbTagHistory.auto_apply.is_(False))
        .order_by(MdbTagHistory.id)
        .all()
    )

    print("자동 적용이 꺼져 있는 이력: %d건" % len(rows))
    for r in rows:
        state = "취소됨" if r.reverted_at else "적용됨"
        print("  [%d] %s -> %s (%s)" % (r.id, r.base_tag, r.new_tag or "-", state))
        if r.note_line:
            print("        %s" % r.note_line)

    if not rows:
        print("\n켤 이력이 없습니다.")
        return

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "mdb_tag_history_auto_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump(
            [{"id": r.id, "base_tag": r.base_tag, "new_tag": r.new_tag,
              "note_line": r.note_line, "auto_apply": bool(r.auto_apply)} for r in rows],
            handle, ensure_ascii=False, indent=2,
        )
    print("\n백업 저장: %s" % backup_path)

    for r in rows:
        r.auto_apply = True

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID, action="MDB_TAG_HISTORY_UPDATE", screen="MDB 편집",
        detail={
            "scope": "mdb", "script": "mdb_tag_history_auto_on_20260901",
            "turned_on": len(rows), "history_ids": [r.id for r in rows],
            "backup": os.path.basename(backup_path),
        },
    ))
    db.commit()
    print("이력 %d건의 자동 적용을 켰습니다. (자료는 손대지 않았습니다)" % len(rows))


if __name__ == "__main__":
    main()
