# -*- coding: utf-8 -*-
"""pid_pfd_rev_split_20260830.py 를 되돌리는 스크립트 (2026-08-30).

Rev별 폴더 나누기를 실행하기 전 상태로 돌린다.
  - [Rev5 (2025)]·[Rev4 (2024)] 폴더로 떼어냈던 구본 파일을 원래 자료의 리비전 이력으로
    되돌리고, 그때 새로 만든 자료 행을 없앤다(이 스크립트가 만든 것만).
  - 현재본 자료를 [Rev6 (2026)]·[Rev5 (2026)] 폴더에서 원래 폴더로 되돌린다.

되돌리기 전에 새 폴더에서 자료를 더 손댔다면(이름변경·이동·자료교체 등) 그 자료는
건너뛰고 알려준다 — 그건 사람이 판단할 문제라 자동으로 덮어쓰지 않는다.

실행:  python scripts/pid_pfd_rev_restore_20260830.py backup/pid_pfd_rev_split_백업_*.json --dry-run
       python scripts/pid_pfd_rev_restore_20260830.py backup/pid_pfd_rev_split_백업_*.json
"""

import argparse
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")

from app import storage
from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import AuditLog, Document, File

SYSTEM_USER_ID = 1


def restore(db, data: dict, dry: bool) -> list[str]:
    summary, skipped = [], []
    now = datetime.now(timezone.utc)

    for rec in data["targets"]:
        label = rec["label"]
        restored_files = removed_docs = moved_back = 0

        # ① 떼어냈던 구본을 원래 자료의 이력으로 되돌린다
        for created in rec["created_documents"]:
            new_id = created.get("new_document_id")
            new_doc = db.get(Document, new_id) if new_id else None
            if new_doc is None:
                skipped.append(f"{label} {created['drawing_no']}: 새 자료(id={new_id})가 이미 없음")
                continue
            if new_doc.source_path != created["source_path"] or new_doc.drawing_no != created["drawing_no"]:
                skipped.append(f"{label} {created['drawing_no']}: 그 뒤 손댄 자료라 건너뜀")
                continue

            for fb in created["files"]:
                f = db.get(File, fb["file_id"])
                if f is None:
                    skipped.append(f"{label} {created['drawing_no']}: 파일(id={fb['file_id']})이 이미 없음")
                    continue
                old_dest = Path(STORAGE_ROOT) / f.file_path
                new_dest = Path(STORAGE_ROOT) / fb["file_path"]
                if not dry:
                    if storage.move_stored_file(old_dest, new_dest):
                        f.file_path = fb["file_path"]
                    storage.prune_empty_dirs(old_dest.parent)
                    f.document_id = fb["document_id"]
                    f.is_current = fb["is_current"]
                restored_files += 1

            if not dry:
                db.delete(new_doc)
            removed_docs += 1

        # ② 현재본 자료를 원래 폴더로 되돌린다
        for moved in rec["moved_documents"]:
            doc = db.get(Document, moved["document_id"])
            if doc is None:
                skipped.append(f"{label} {moved['drawing_no']}: 자료(id={moved['document_id']})가 이미 없음")
                continue
            if doc.source_path != moved["new_source_path"]:
                skipped.append(f"{label} {moved['drawing_no']}: 그 뒤 다른 폴더로 옮겨져 건너뜀")
                continue
            if not dry:
                for fb in moved["files"]:
                    f = db.get(File, fb["file_id"])
                    if f is None:
                        continue
                    old_dest = Path(STORAGE_ROOT) / f.file_path
                    new_dest = Path(STORAGE_ROOT) / fb["file_path"]
                    if storage.move_stored_file(old_dest, new_dest):
                        f.file_path = fb["file_path"]
                    storage.prune_empty_dirs(old_dest.parent)
                doc.source_path = moved["old_source_path"]
                doc.updated_at = now
            moved_back += 1

        line = (f"{label}: 원래 폴더로 되돌린 자료 {moved_back}건, "
                f"이력으로 되돌린 파일 {restored_files}개, 없앤 자료 {removed_docs}건")
        print("  " + line)
        summary.append(line)

    if skipped:
        print("\n건너뜀:")
        for s in skipped:
            print("   - " + s)
    return summary + ([f"건너뜀 {len(skipped)}건"] if skipped else [])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("backup_file", help="pid_pfd_rev_split_백업_*.json 경로")
    ap.add_argument("--dry-run", action="store_true", help="실제로 바꾸지 않고 보기만")
    args = ap.parse_args()

    with open(args.backup_file, encoding="utf-8") as handle:
        data = json.load(handle)

    db = SessionLocal()
    try:
        print("=" * 78)
        summary = restore(db, data, args.dry_run)
        print("=" * 78)
        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return
        db.add(AuditLog(
            user_id=SYSTEM_USER_ID, action="PID_PFD_REV_SPLIT_RESTORE",
            screen="폴더·자료 편집(스크립트)",
            detail={"note": "Rev별 폴더 나누기 되돌리기",
                    "backup": Path(args.backup_file).name, "summary": summary},
        ))
        db.commit()
        print("\n완료 — 시스템 로그에 PID_PFD_REV_SPLIT_RESTORE로 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
