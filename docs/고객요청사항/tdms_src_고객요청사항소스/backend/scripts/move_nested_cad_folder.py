"""3.1.4.3 Steam Tracing Isometric 밑의 CAD\\D3S, CAD\\T7S 폴더(한 단계 더 깊이 들어간
경우라 D-33 짝 인식 대상이 아니었음)를 DWG\\D3S, DWG\\T7S로 옮긴다 (2026-08-19 CM 요청).

CAD가 마지막 조각이 아니라 중간 조각이라 이전 스크립트(move_real_cad_folders_to_dwg.py)의
탐지 조건(문서.source_path 마지막 조각 == 'CAD')에 걸리지 않았던 8건을 마저 처리한다.
"""

import sys

sys.path.insert(0, ".")

from app.database import SessionLocal
from app.models import AuditLog, Document, File
from app import storage

NEEDLE = "\\CAD\\"
REPLACEMENT = "\\DWG\\"


def main():
    db = SessionLocal()
    try:
        docs = [
            d for d in db.query(Document).filter(Document.is_archived.is_(False)).all()
            if d.source_path and NEEDLE in d.source_path
        ]
        print(f"대상 문서 {len(docs)}건")

        moved = 0
        for d in docs:
            old_source = d.source_path
            new_source = old_source.replace(NEEDLE, REPLACEMENT)
            files = db.query(File).filter(File.document_id == d.id).all()
            for f in files:
                if f.is_current:
                    old_dest = storage.latest_file_path(old_source, d.drawing_no, f.file_ext, None)
                    new_dest = storage.latest_file_path(new_source, d.drawing_no, f.file_ext, None)
                    if old_dest.is_file():
                        if new_dest.exists():
                            raise RuntimeError(f"충돌: {new_dest}")
                        new_dest.parent.mkdir(parents=True, exist_ok=True)
                        old_dest.rename(new_dest)
                        f.file_path = storage.to_relative(new_dest)
                        moved += 1
                    else:
                        print(f"경고: 원본 없음 - 문서 {d.id} {d.drawing_no}")
            d.source_path = new_source

        db.add(AuditLog(
            user_id=None, action="MOVE_REAL_CAD_TO_DWG", screen="폴더·자료 편집(스크립트)",
            detail={
                "note": "중첩된 CAD\\D3S, CAD\\T7S 폴더를 DWG\\D3S, DWG\\T7S로 이동",
                "affected_documents": len(docs), "moved_physical": moved,
            },
        ))
        db.commit()
        print(f"완료: 이동 {moved}건")
    finally:
        db.close()


if __name__ == "__main__":
    main()
