"""3.1.4.3 Steam Tracing Isometric 밑 DWG\\D3S/T7S, PDF\\D3S/T7S를 D3S/T7S 밑 숨은 DWG·PDF
짝 폴더로 재구성한다 (2026-08-19 CM 요청, 스크린샷 기준).

기존(방금 옮긴 상태): 3.1.4.3\\DWG\\D3S, 3.1.4.3\\DWG\\T7S, 3.1.4.3\\PDF\\D3S, 3.1.4.3\\PDF\\T7S
  각각 별개 문서(도면번호당 dwg 전용 문서 1개 + pdf 전용 문서 1개, 총 16건)

목표: 3.1.4.3\\D3S, 3.1.4.3\\T7S 밑에서 dwg+pdf가 도면번호당 문서 1건으로 합쳐지고
  DWG/PDF는 화면에서 숨은 짝 폴더로만 남는다(총 8건: D3S 1 + T7S 7).

app/routers/editor.py의 merge_one_pair_folder_document와 완전히 같은 규칙(리비전 없는
가장 단순한 rev0·파일 1개 경우만, DWG 쪽 자료를 살리고 PDF 쪽은 보관함으로) 그대로 따른다.
"""

import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")

from app.database import SessionLocal
from app.models import ArchiveBatch, AuditLog, Document, File
from app import storage

SYSTEM_USER_ID = 1  # bulk_import_system

BASE = (
    "5. DRAWINGS\\5.1   Plot Plan & ELP & Piping Plan Drawing\\"
    "5.1.10 Steam Tracing Isometric Drawing List (OSBL)\\3.1.4.3 Steam Tracing Isometric"
)
SUBFOLDERS = ["D3S", "T7S"]


def move_file_to_pair_slot(old_source, old_pairing, new_source, new_pairing, drawing_no, file_row):
    old_dest = storage.latest_file_path(old_source, drawing_no, file_row.file_ext, old_pairing)
    new_dest = storage.latest_file_path(new_source, drawing_no, file_row.file_ext, new_pairing)
    file_row.pairing_folder = new_pairing
    if old_dest == new_dest:
        return
    if not old_dest.is_file():
        print(f"경고: 원본 없음 {old_dest}")
        return
    if new_dest.exists():
        raise RuntimeError(f"충돌: {new_dest}")
    new_dest.parent.mkdir(parents=True, exist_ok=True)
    old_dest.rename(new_dest)
    file_row.file_path = storage.to_relative(new_dest)


def main():
    db = SessionLocal()
    now = datetime.now(timezone.utc)
    try:
        merged = 0
        for sub in SUBFOLDERS:
            new_parent = f"{BASE}\\{sub}"
            dwg_path = f"{BASE}\\DWG\\{sub}"
            pdf_path = f"{BASE}\\PDF\\{sub}"

            dwg_docs = {d.drawing_no: d for d in db.query(Document).filter(
                Document.is_archived.is_(False), Document.source_path == dwg_path).all()}
            pdf_docs = {d.drawing_no: d for d in db.query(Document).filter(
                Document.is_archived.is_(False), Document.source_path == pdf_path).all()}

            common = sorted(set(dwg_docs) & set(pdf_docs))
            print(f"--- {sub}: dwg {len(dwg_docs)}건 / pdf {len(pdf_docs)}건 / 짝 맞는 도면 {len(common)}건 ---")

            for drawing_no in common:
                dwg_doc, pdf_doc = dwg_docs[drawing_no], pdf_docs[drawing_no]
                dwg_files = db.query(File).filter(File.document_id == dwg_doc.id).all()
                pdf_files = db.query(File).filter(File.document_id == pdf_doc.id).all()
                if len(dwg_files) != 1 or len(pdf_files) != 1:
                    print(f"건너뜀(이력 있음): {drawing_no}")
                    continue
                dwg_file, pdf_file = dwg_files[0], pdf_files[0]

                move_file_to_pair_slot(dwg_path, None, new_parent, "DWG", drawing_no, dwg_file)
                move_file_to_pair_slot(pdf_path, None, new_parent, "PDF", drawing_no, pdf_file)
                pdf_file.document_id = dwg_doc.id

                dwg_doc.source_path = new_parent
                dwg_doc.has_dwg = True
                dwg_doc.has_pdf = True
                dwg_doc.updated_at = now

                batch = ArchiveBatch(
                    kind="DOCUMENT", label=pdf_doc.drawing_no, original_path=pdf_doc.source_path,
                    archived_by=SYSTEM_USER_ID,
                    reason=f"DWG·PDF 폴더 병합으로 자료 #{dwg_doc.id}에 합쳐짐 (D3S/T7S 재구성, 스크립트)",
                )
                db.add(batch)
                db.flush()
                pdf_doc.is_archived = True
                pdf_doc.archive_batch_id = batch.id
                pdf_doc.updated_at = now

                db.add(AuditLog(
                    user_id=SYSTEM_USER_ID, action="MERGE_PAIR_FOLDER", screen="폴더·자료 편집(스크립트)",
                    document_id=dwg_doc.id,
                    detail={"parent": new_parent, "dwg_path": dwg_path, "pdf_path": pdf_path,
                            "drawing_no": drawing_no, "merged_document_id": pdf_doc.id},
                ))
                merged += 1

        db.commit()
        print(f"완료: {merged}건 병합")
    finally:
        db.close()


if __name__ == "__main__":
    main()
