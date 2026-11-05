# -*- coding: utf-8 -*-
"""Note에 이미 적혀 있는 "->"를 화살표 기호(→)로 바꾸는 1회성 스크립트 (2026-08-30 CM 지시).

CM 지시 내용
  "Note에 Tag No 변경 표시 화살표는 -> 말고 화살표 기호를 사용하라."
  앞으로 만들어지는 문구는 코드(mdb_tag_history.py의 NOTE_ARROW)에서 이미 화살표 기호를
  쓰도록 고쳤다. 이 스크립트는 그 전에 이미 자료 Note에 들어가 버린 문장을 맞춰주는 것이다.

손대는 것 (지시 범위 그대로)
  · Tag No 이력관리(mdb_tag_histories)가 만든 문장 — 이력에 보관된 완성 문장(note_line)과
    글자 하나까지 똑같은 Note 줄만 바꾼다.
  · 이력의 note_line 자체도 같이 바꾼다(안 바꾸면 [되돌리기]가 옛 문장을 찾다 못 찾는다).

손대지 않는 것 (지시 범위 밖)
  · 사람이 직접 적은 Note 줄은 "->"가 들어 있어도 그대로 둔다 — 이력이 만든 문장인지
    확실한 것만 바꾼다.
  · Tag No·설비유형·자료유형·자료명·경로·파일은 건드리지 않는다.

실행
  python scripts/mdb_note_arrow_20260830.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/mdb_note_arrow_20260830.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  백업 파일(backup/mdb_note_arrow_백업_*.json)에 이력·파일의 원래 문장이 그대로 들어 있다.
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
from app.models import AuditLog, MdbFile, MdbTagHistory  # noqa: E402
from app.routers.mdb_tag_history import NOTE_ARROW, build_note_line  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정
OLD_ARROW = "->"


def rebuilt_line(history):
    """이력에 남아 있는 조각들로 문장을 다시 만든다(화살표만 새 기호로 바뀐 문장)."""
    return build_note_line(
        label=history.note_label, base_tag=history.base_tag, new_tag=history.new_tag,
        year=history.note_year, project=history.note_project,
        reason=history.note_reason, memo=history.note_memo,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    db = SessionLocal()
    histories = db.query(MdbTagHistory).order_by(MdbTagHistory.id).all()

    plans = []   # (이력, 옛 문장, 새 문장, [바꿀 파일...])
    skipped = []
    for history in histories:
        old_line = history.note_line
        if not old_line or OLD_ARROW not in old_line:
            continue
        new_line = rebuilt_line(history)
        # 이력에 남은 조각으로 다시 만든 문장이 "화살표만 다른 같은 문장"이어야 안심하고 바꾼다.
        if new_line.replace(" %s " % NOTE_ARROW, " %s " % OLD_ARROW) != old_line:
            skipped.append((history, old_line, new_line))
            continue
        files = [
            row for row in db.query(MdbFile).order_by(MdbFile.id).all()
            if any(line.strip() == old_line for line in (row.note or "").split("\n"))
        ]
        plans.append((history, old_line, new_line, files))

    if skipped:
        print("!! 문장이 이력의 조각과 안 맞아 건너뛴 이력 %d건 (직접 확인 필요)" % len(skipped))
        for history, old_line, new_line in skipped:
            print("   [이력 %d] 지금: %s" % (history.id, old_line))
            print("             다시 만들면: %s" % new_line)
        print("")

    total_files = sum(len(files) for _h, _o, _n, files in plans)
    print("바꿀 이력 %d건 · 자료 파일 %d개" % (len(plans), total_files))
    for history, old_line, new_line, files in plans:
        print("  [이력 %d] %s" % (history.id, old_line))
        print("        -> %s   (파일 %d개)" % (new_line, len(files)))

    if not plans:
        print("\n바꿀 것이 없습니다.")
        return
    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "mdb_note_arrow_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump(
            [{
                "history_id": history.id, "old_note_line": old_line, "new_note_line": new_line,
                "files": [{"id": row.id, "note": row.note} for row in files],
            } for history, old_line, new_line, files in plans],
            handle, ensure_ascii=False, indent=2,
        )
    print("\n백업 저장: %s" % backup_path)

    changed_files = 0
    for history, old_line, new_line, files in plans:
        for row in files:
            lines = (row.note or "").split("\n")
            row.note = "\n".join(new_line if ln.strip() == old_line else ln for ln in lines)
            changed_files += 1
        history.note_line = new_line

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID, action="MDB_EDIT", screen="MDB 편집",
        detail={
            "scope": "mdb", "script": "mdb_note_arrow_20260830",
            "history_count": len(plans), "changed_files": changed_files,
            "backup": os.path.basename(backup_path),
        },
    ))
    db.commit()
    print("이력 %d건 · 자료 파일 %d개의 Note 문장을 화살표 기호로 바꿨습니다."
          % (len(plans), changed_files))


if __name__ == "__main__":
    main()
