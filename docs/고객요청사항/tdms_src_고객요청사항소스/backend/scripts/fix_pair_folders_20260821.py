# -*- coding: utf-8 -*-
"""DWG·PDF 짝 폴더 정리 1회성 스크립트 (2026-08-21 CM 지시).

배경 — 두 가지 문제가 겹쳐 있었다.

① 8/19에 돌린 정리 스크립트(move_real_cad_folders_to_dwg.py)가 지시 범위를 넘어,
   **PDF 짝이 없는 진짜 CAD 폴더까지** 숨은 DWG 짝 폴더로 만들어 버렸다. 그래서
   5.11 ISBL·5.11 OSBL·5.14·5.4.4 FONT의 폴더가 화면에서 사라졌다.
   → 새 규칙(짝은 DWG·PDF가 둘 다 있을 때만)에 맞게 되돌린다.

② 8/16에 CM이 `0.PDF` 폴더를 `PDF`로 이름 변경하면서, 실제 폴더 이름이 숨은 짝 폴더
   이름과 똑같아졌다. 그 결과 TDB 조회는 `PDF` 폴더에 14건, TDB 관리(숨김 폴더 보기)는
   같은 폴더에 155건으로 서로 다르게 보였다.
   → PDF 폴더에 남아있던 자료를 상위 자료에 합치거나 짝 폴더로 편입해 이름 충돌을 없앤다.

이름은 대소문자를 무시하고 맞춘다 — `14010pb06`과 `14010PB06`은 같은 도면이고, Windows에서
이미 같은 파일 취급을 받고 있다.

실행:  python scripts/fix_pair_folders_20260821.py --dry-run   (무엇을 할지 보기만)
       python scripts/fix_pair_folders_20260821.py             (실제 실행)
"""

import argparse
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, ".")

from app import storage
from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import ArchiveBatch, AuditLog, Distribution, Document, File

# 8/19 스크립트가 잘못 숨긴 자리 — 자료를 상위 폴더로 올리고 DWG 폴더를 없앤다.
LIFT_TO_PARENT = [
    "5. DRAWINGS\\5.11  Instrument Loop Diagram (ISBL & OSBL)\\ISBL",
    "5. DRAWINGS\\5.11  Instrument Loop Diagram (ISBL & OSBL)\\OSBL",
    "5. DRAWINGS\\5.14  Instrument X-Y Sketch Drawing",
]

# 폴더 이름만 원래대로(CAD) 돌리고 자료는 그 안에 그대로 두는 자리.
RENAME_TO_REAL_CAD = {
    "5. DRAWINGS\\5.4   Civil & Steel Structure Drawing\\5.4.4  가스부두 및 제3부두 Drawing\\1.가스부두 준공도면\\FONT": "CAD",
}

SYSTEM_USER_ID = 1  # 일괄등록 계정


class Runner:
    def __init__(self, db, dry_run: bool):
        self.db = db
        self.dry = dry_run
        self.now = datetime.now(timezone.utc)
        self.log: list[str] = []

    def say(self, msg: str) -> None:
        self.log.append(msg)
        print(msg)

    # -- 물리 파일 -------------------------------------------------------
    def move_file(self, file_row: File, old_dest: Path, new_dest: Path) -> None:
        if self.dry:
            return
        if storage.move_stored_file(old_dest, new_dest):
            file_row.file_path = storage.to_relative(new_dest)

    def remove_dir_if_empty(self, path: Path) -> None:
        if self.dry or not path.is_dir():
            return
        if not any(path.iterdir()):
            path.rmdir()

    # -- ① 짝이 아닌데 숨겨진 폴더 되돌리기 -------------------------------
    def lift_to_parent(self) -> int:
        """숨은 DWG 폴더 안 파일을 상위(자료) 폴더로 올리고 그 폴더를 없앤다."""
        moved = 0
        for source_path in LIFT_TO_PARENT:
            rows = (
                self.db.query(Document, File)
                .join(File, File.document_id == Document.id)
                .filter(
                    Document.is_archived.is_(False),
                    Document.source_path == source_path,
                    File.pairing_folder.isnot(None),
                )
                .all()
            )
            if not rows:
                self.say(f"  [건너뜀] 숨은 폴더 없음 — ...{source_path[-42:]}")
                continue
            folders = {f.pairing_folder for _d, f in rows}
            for doc, f in rows:
                old = storage.latest_file_path(source_path, doc.drawing_no, f.file_ext, f.pairing_folder)
                new = storage.latest_file_path(source_path, doc.drawing_no, f.file_ext, None)
                self.say(f"  {doc.drawing_no}.{f.file_ext}: {f.pairing_folder}/ → 상위 폴더")
                self.move_file(f, old, new)
                if not self.dry:
                    f.pairing_folder = None
                    doc.updated_at = self.now
                moved += 1
            for name in folders:
                self.remove_dir_if_empty(Path(STORAGE_ROOT) / "최신" / Path(*storage.source_parts(source_path)) / name)
        return moved

    def rename_to_real_cad(self) -> int:
        """숨은 DWG 폴더를 보통 폴더(CAD)로 되돌린다 — 자료는 그 폴더 안에 그대로 둔다."""
        moved = 0
        for source_path, new_name in RENAME_TO_REAL_CAD.items():
            rows = (
                self.db.query(Document, File)
                .join(File, File.document_id == Document.id)
                .filter(
                    Document.is_archived.is_(False),
                    Document.source_path == source_path,
                    File.pairing_folder.isnot(None),
                )
                .all()
            )
            if not rows:
                self.say(f"  [건너뜀] 숨은 폴더 없음 — ...{source_path[-42:]}")
                continue
            old_names = {f.pairing_folder for _d, f in rows}
            new_path = f"{source_path}\\{new_name}"
            for doc, f in rows:
                old = storage.latest_file_path(source_path, doc.drawing_no, f.file_ext, f.pairing_folder)
                new = storage.latest_file_path(new_path, doc.drawing_no, f.file_ext, None)
                self.say(f"  {doc.drawing_no}.{f.file_ext}: {f.pairing_folder}/ → 보통 폴더 {new_name}/")
                self.move_file(f, old, new)
                if not self.dry:
                    f.pairing_folder = None
                    doc.source_path = new_path
                    doc.updated_at = self.now
                moved += 1
            for name in old_names:
                self.remove_dir_if_empty(Path(STORAGE_ROOT) / "최신" / Path(*storage.source_parts(source_path)) / name)
        return moved

    # -- ② 이름이 겹친 PDF 폴더 정리 --------------------------------------
    def pdf_folder_documents(self) -> dict[str, list[Document]]:
        """실제 폴더 이름이 DWG/PDF인 자료 폴더별 자료 목록."""
        found: dict[str, list[Document]] = {}
        for doc in self.db.query(Document).filter(Document.is_archived.is_(False)).all():
            if not doc.source_path:
                continue
            if doc.source_path.split("\\")[-1].lower() in ("dwg", "pdf"):
                found.setdefault(doc.source_path, []).append(doc)
        return found

    def archive(self, doc: Document, reason: str) -> None:
        if self.dry:
            return
        batch = ArchiveBatch(
            kind="DOCUMENT", label=doc.drawing_no, original_path=doc.source_path,
            archived_by=SYSTEM_USER_ID, reason=reason,
        )
        self.db.add(batch)
        self.db.flush()
        doc.is_archived = True
        doc.archive_batch_id = batch.id
        doc.updated_at = self.now

    def fix_pdf_folders(self) -> tuple[int, int, int, list[str]]:
        merged = duplicated = kept = 0
        skipped: list[str] = []

        for folder, docs in sorted(self.pdf_folder_documents().items()):
            parent = "\\".join(folder.split("\\")[:-1])
            pair_name = folder.split("\\")[-1]
            self.say(f"\n  [{folder[-52:]}] 자료 {len(docs)}건")

            by_lower: dict[str, list[Document]] = {}
            for d in self.db.query(Document).filter(
                Document.is_archived.is_(False), Document.source_path == parent
            ):
                by_lower.setdefault(d.drawing_no.lower(), []).append(d)

            for doc in sorted(docs, key=lambda d: d.drawing_no):
                cands = by_lower.get(doc.drawing_no.lower(), [])
                files = self.db.query(File).filter(File.document_id == doc.id).all()
                cur = [f for f in files if f.is_current]

                if len(cands) > 1:
                    skipped.append(f"{doc.drawing_no}: 상위에 같은 이름 자료가 {len(cands)}건")
                    continue

                if not cands:
                    # 짝이 없는 자료 — 숨김 폴더 안에 그대로 둔다(CM 규칙 3).
                    self.say(f"    · {doc.drawing_no}: 짝 없음 → 숨김 {pair_name} 폴더에 그대로 유지")
                    if not self.dry:
                        doc.source_path = parent
                        for f in files:
                            f.pairing_folder = pair_name
                        doc.updated_at = self.now
                    kept += 1
                    continue

                target = cands[0]
                owned = {
                    f.file_ext for f in self.db.query(File).filter(
                        File.document_id == target.id, File.is_current.is_(True)
                    )
                }
                mine = {f.file_ext for f in cur}

                if mine & owned:
                    # 상위 자료가 이미 그 형식을 갖고 있다 — 같은 파일인지 확인하고 정리한다.
                    same = self.is_same_content(target, doc, mine & owned)
                    if not same:
                        skipped.append(
                            f"{doc.drawing_no}: 상위 '{target.drawing_no}'에 같은 형식이 있는데 내용이 다름"
                        )
                        self.say(f"    · {doc.drawing_no}: ★ 내용이 달라 건너뜀 (CM 확인 필요)")
                        continue
                    self.say(f"    · {doc.drawing_no}: 상위 '{target.drawing_no}'와 같은 파일 → 보관함")
                    if not self.dry:
                        ids = [f.id for f in files]
                        if ids:
                            self.db.query(Distribution).filter(
                                Distribution.returned_file_id.in_(ids)
                            ).update({Distribution.returned_file_id: None}, synchronize_session=False)
                        # 물리 파일은 상위 자료의 것이므로 건드리지 않고 중복 장부만 없앤다.
                        self.db.query(File).filter(File.document_id == doc.id).delete(
                            synchronize_session=False
                        )
                    self.archive(doc, f"중복 사본 정리 — 자료 #{target.id}가 같은 파일을 이미 갖고 있음")
                    duplicated += 1
                    continue

                # 상위 자료에 없는 형식 → 그 자료의 파일로 합친다(이름도 상위 표기에 맞춘다).
                self.say(f"    · {doc.drawing_no} → '{target.drawing_no}'에 합침 ({','.join(sorted(mine))})")
                for f in cur:
                    old = storage.latest_file_path(folder, doc.drawing_no, f.file_ext, f.pairing_folder)
                    new = storage.latest_file_path(parent, target.drawing_no, f.file_ext, pair_name)
                    self.move_file(f, old, new)
                    if not self.dry:
                        f.document_id = target.id
                        f.pairing_folder = pair_name
                if not self.dry:
                    for f in files:
                        if not f.is_current:
                            f.document_id = target.id
                    if "pdf" in mine:
                        target.has_pdf = True
                    if "dwg" in mine:
                        target.has_dwg = True
                    target.updated_at = self.now
                    self.db.flush()
                self.archive(doc, f"DWG·PDF 짝 정리 — 자료 #{target.id}에 합쳐짐")
                merged += 1

        return merged, duplicated, kept, skipped

    def is_same_content(self, target: Document, doc: Document, exts: set[str]) -> bool:
        """두 자료가 그 형식에서 실제로 같은 파일을 가리키는지 (해시 또는 같은 물리 파일)."""
        for ext in exts:
            a = self.db.query(File).filter(
                File.document_id == target.id, File.is_current.is_(True), File.file_ext == ext
            ).first()
            b = self.db.query(File).filter(
                File.document_id == doc.id, File.is_current.is_(True), File.file_ext == ext
            ).first()
            if a is None or b is None:
                return False
            if a.sha256 and b.sha256 and a.sha256 == b.sha256:
                continue
            pa, pb = Path(STORAGE_ROOT) / a.file_path, Path(STORAGE_ROOT) / b.file_path
            if not storage.is_same_file(pa, pb):
                return False
        return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="실제로 바꾸지 않고 무엇을 할지만 보여준다")
    args = ap.parse_args()

    db = SessionLocal()
    r = Runner(db, args.dry_run)
    try:
        print("=" * 78)
        print("① 짝이 아닌데 숨겨진 폴더 되돌리기 (8/19 스크립트가 지나쳤던 부분)")
        print("=" * 78)
        lifted = r.lift_to_parent()
        renamed = r.rename_to_real_cad()

        print()
        print("=" * 78)
        print("② 이름이 겹친 PDF 폴더 정리")
        print("=" * 78)
        merged, duplicated, kept, skipped = r.fix_pdf_folders()

        print()
        print("=" * 78)
        print(f"상위 폴더로 올림      : {lifted}건")
        print(f"보통 폴더(CAD)로 되돌림: {renamed}건")
        print(f"상위 자료에 합침      : {merged}건")
        print(f"중복 사본 보관함으로  : {duplicated}건")
        print(f"짝 없어 숨김 폴더 유지: {kept}건")
        print(f"건너뜀                : {len(skipped)}건")
        for s in skipped:
            print(f"   - {s}")

        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return

        db.add(AuditLog(
            user_id=SYSTEM_USER_ID, action="FIX_PAIR_FOLDERS", screen="폴더·자료 편집(스크립트)",
            detail={
                "note": "짝 폴더 규칙 정리 — DWG·PDF가 둘 다 있을 때만 짝으로 본다(2026-08-21 CM 확정)",
                "lifted_to_parent": lifted, "renamed_to_real_folder": renamed,
                "merged_into_parent": merged, "duplicates_archived": duplicated,
                "kept_in_pair_folder": kept, "skipped": skipped,
            },
        ))
        db.commit()
        print("\n완료 — 시스템 로그에 FIX_PAIR_FOLDERS로 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
