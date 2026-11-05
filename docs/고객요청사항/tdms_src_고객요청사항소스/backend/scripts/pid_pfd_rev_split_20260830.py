# -*- coding: utf-8 -*-
"""P&ID·PFD 폴더를 Rev별(년도별) 하위 폴더로 나누는 1회성 스크립트 (2026-08-30 CM 지시).

배경 — CM이 "P&ID, PFD 폴더는 하위에 폴더를 Rev별(년도별)로 구분하여 생성하라"고 지시했다.
지금은 자료 1건 안에 현재본(P&ID Rev6 / PFD Rev5)과 구본(Rev5 / Rev4)이 리비전 이력으로
함께 들어 있는데, 이것을 Rev별 폴더로 나눈다.

CM이 고른 방식은 **"이력에서 떼어내 옮긴다"**이다(2026-08-30 확정, 두 선택지 중 선택).
  - 현재본 자료는 통째로 `Rev6 (2026)`(PFD는 `Rev5 (2026)`) 폴더로 옮긴다.
  - 구본(Rev5 / Rev4)은 리비전 이력에서 **떼어내** `Rev5 (2025)`(PFD는 `Rev4 (2024)`)
    폴더의 **별도 자료**로 만든다. 그 결과 원래 자료의 리비전 이력에서 구본이 빠진다.

바꾸지 않는 것
  - 반려본(rev6a·rev6b 등)은 그 Rev에 이르는 과정이므로 현재본 자료에 그대로 남긴다.
  - 반려본의 이력 파일은 물리적으로 옮기지 않는다 — 화면의 [위치 이동]도 이력 파일은
    건드리지 않으므로 같은 동작을 따른다(DB의 file_path 그대로라 열람·다운로드 정상).
  - 반출 기록(distributions)은 현재본 자료에 그대로 붙어 있다.

실행:  python scripts/pid_pfd_rev_split_20260830.py --dry-run   (무엇을 할지 보기만)
       python scripts/pid_pfd_rev_split_20260830.py             (실제 실행)

되돌리기: backup/pid_pfd_rev_split_백업_*.json + scripts/pid_pfd_rev_restore_20260830.py
"""

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")

from app import storage
from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import AuditLog, Document, File

SYSTEM_USER_ID = 1  # 일괄등록 계정
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
BACKUP_DIR = os.path.join(os.path.dirname(ROOT), "backup")

# (이름, 부모 폴더, (현재본 폴더명, 그 Rev), (구본 폴더명, 그 Rev))
TARGETS = [
    (
        "P&ID",
        "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)",
        ("Rev6 (2026)", 6),
        ("Rev5 (2025)", 5),
    ),
    (
        "PFD",
        "3. PROCESS & FACILITIES DESCRIPTION\\3.2 Process Flow Diagram (PFD)",
        ("Rev5 (2026)", 5),
        ("Rev4 (2024)", 4),
    ),
]

# 새 자료를 만들 때 원래 자료에서 그대로 물려받는 분류 정보
COPIED_FIELDS = (
    "doc_class", "category", "discipline", "doc_type", "isbl_osbl",
    "elevation", "area", "is_isometric", "equipment_tag", "project_id",
)


class Runner:
    def __init__(self, db, dry_run: bool):
        self.db = db
        self.dry = dry_run
        self.now = datetime.now(timezone.utc)
        self.backup = {"created_at": self.now.isoformat(), "targets": []}
        self.summary = []

    def say(self, msg: str) -> None:
        print(msg)

    # ------------------------------------------------------------------
    def run_target(self, label: str, parent: str, current: tuple, old: tuple) -> dict:
        cur_folder, cur_rev = current
        old_folder, old_rev = old
        cur_path = f"{parent}\\{cur_folder}"
        old_path = f"{parent}\\{old_folder}"

        docs = (
            self.db.query(Document)
            .filter(Document.source_path == parent, Document.is_archived.is_(False))
            .order_by(Document.drawing_no)
            .all()
        )
        self.say("=" * 78)
        self.say(f"{label}  —  {parent}")
        self.say(f"   자료 {len(docs)}건 → [{cur_folder}] 로 이동, 구본 rev{old_rev} → [{old_folder}] 로 분리")
        self.say("=" * 78)

        rec = {
            "label": label, "parent": parent,
            "current_folder": cur_folder, "current_rev": cur_rev,
            "old_folder": old_folder, "old_rev": old_rev,
            "moved_documents": [], "created_documents": [], "skipped": [],
        }

        moved = created = split_files = 0
        for doc in docs:
            if doc.current_rev != cur_rev:
                msg = f"{doc.drawing_no}: 현재 Rev가 {doc.current_rev}라 {cur_rev}가 아님 — 건너뜀"
                self.say(f"   [건너뜀] {msg}")
                rec["skipped"].append(msg)
                continue

            # ── ① 구본(rev N, 분기 없음)을 떼어내 새 자료로 ──────────────────
            old_files = (
                self.db.query(File)
                .filter(File.document_id == doc.id, File.rev == old_rev,
                        File.branch.is_(None))
                .order_by(File.id)
                .all()
            )
            if old_files:
                new_doc = Document(
                    drawing_no=doc.drawing_no, title=doc.title,
                    source_path=old_path, current_rev=old_rev, status="ACTIVE",
                    has_dwg=any(f.file_ext == "dwg" for f in old_files),
                    has_pdf=any(f.file_ext == "pdf" for f in old_files),
                    is_archived=False, created_at=self.now, updated_at=self.now,
                    **{name: getattr(doc, name) for name in COPIED_FIELDS},
                )
                self.db.add(new_doc)
                if not self.dry:
                    self.db.flush()

                file_backup = []
                for f in old_files:
                    file_backup.append({
                        "file_id": f.id, "document_id": doc.id,
                        "file_path": f.file_path, "is_current": f.is_current,
                    })
                    new_dest = storage.latest_file_path(
                        old_path, doc.drawing_no, f.file_ext, f.pairing_folder
                    )
                    old_dest = Path(STORAGE_ROOT) / f.file_path
                    if not self.dry:
                        if storage.move_stored_file(old_dest, new_dest):
                            f.file_path = storage.to_relative(new_dest)
                        storage.prune_empty_dirs(old_dest.parent)
                        f.document_id = new_doc.id
                        f.is_current = True
                    split_files += 1

                created += 1
                rec["created_documents"].append({
                    "from_document_id": doc.id, "drawing_no": doc.drawing_no,
                    "new_document_id": (new_doc.id if not self.dry else None),
                    "source_path": old_path, "rev": old_rev,
                    "files": file_backup,
                })
                exts = "+".join(sorted({f.file_ext.upper() for f in old_files}))
                self.say(f"   [분리] rev{old_rev} {exts:9} → {old_folder}\\  {doc.drawing_no}")
            else:
                self.say(f"   [분리없음] rev{old_rev} 구본이 없음  {doc.drawing_no}")

            # ── ② 현재본 자료를 Rev 폴더로 이동 ─────────────────────────────
            current_files = (
                self.db.query(File)
                .filter(File.document_id == doc.id, File.is_current.is_(True))
                .all()
            )
            rec["moved_documents"].append({
                "document_id": doc.id, "drawing_no": doc.drawing_no,
                "old_source_path": doc.source_path, "new_source_path": cur_path,
                "files": [{"file_id": f.id, "file_path": f.file_path} for f in current_files],
            })
            if not self.dry:
                for f in current_files:
                    old_dest = storage.latest_file_path(
                        doc.source_path, doc.drawing_no, f.file_ext, f.pairing_folder
                    )
                    new_dest = storage.latest_file_path(
                        cur_path, doc.drawing_no, f.file_ext, f.pairing_folder
                    )
                    if storage.move_stored_file(old_dest, new_dest):
                        f.file_path = storage.to_relative(new_dest)
                doc.source_path = cur_path
                doc.updated_at = self.now
            moved += 1

        self.say("")
        self.say(f"   → [{cur_folder}] 로 옮긴 자료 : {moved}건")
        self.say(f"   → [{old_folder}] 로 만든 자료 : {created}건 (파일 {split_files}개)")
        if rec["skipped"]:
            self.say(f"   → 건너뛴 자료             : {len(rec['skipped'])}건")

        rec["counts"] = {"moved": moved, "created": created, "split_files": split_files}
        self.backup["targets"].append(rec)
        self.summary.append(
            f"{label}: {cur_folder} {moved}건 / {old_folder} {created}건(파일 {split_files}개)"
        )
        return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="실제로 바꾸지 않고 무엇을 할지만 보여준다")
    args = ap.parse_args()

    db = SessionLocal()
    r = Runner(db, args.dry_run)
    try:
        for label, parent, current, old in TARGETS:
            r.run_target(label, parent, current, old)
            print()

        print("=" * 78)
        for line in r.summary:
            print("  " + line)
        print("=" * 78)

        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return

        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = os.path.join(BACKUP_DIR, "pid_pfd_rev_split_백업_%s.json" % stamp)
        with open(backup_path, "w", encoding="utf-8") as handle:
            json.dump(r.backup, handle, ensure_ascii=False, indent=2)

        db.add(AuditLog(
            user_id=SYSTEM_USER_ID, action="PID_PFD_REV_SPLIT", screen="폴더·자료 편집(스크립트)",
            detail={
                "note": "P&ID·PFD를 Rev별 폴더로 분리 — 구본을 이력에서 떼어내 별도 자료로 "
                        "(2026-08-30 CM 확정)",
                "summary": r.summary,
                "backup": os.path.basename(backup_path),
            },
        ))
        db.commit()
        print("\n백업 저장: %s" % backup_path)
        print("완료 — 시스템 로그에 PID_PFD_REV_SPLIT으로 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
