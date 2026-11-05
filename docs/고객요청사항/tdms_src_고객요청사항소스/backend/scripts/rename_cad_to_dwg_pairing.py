"""기존에 'CAD'로 합쳐진 DWG·PDF 짝 폴더 5곳의 이름을 병합을 깨지 않고 'DWG'로 바꾼다.

TDB 관리 화면의 폴더편집(이름변경)은 D-41 규칙상 항상 병합을 깨므로(자료가 두 건으로
나뉨), 이 스크립트는 그 절차를 거치지 않고 DB의 files.pairing_folder 값과 '최신' 폴더의
실제 물리 폴더명을 CAD -> DWG로 직접 맞바꾼다. pairing_folder 값 자체는 어떤 문자열이든
동일하게 동작하므로(app/utils.py의 pairing_folder_for_ext 참고) 값만 바꿔도 안전하다.

- is_current=True 파일만 '최신' 폴더 실제 경로에 pairing_folder가 쓰인다 -> 물리 이동 필요
- is_current=False(이력) 파일은 이력 폴더 경로에 pairing_folder를 안 쓴다 -> DB 값만 변경

2026-08-19 1회성 실행, CM 요청.
"""

import sys

sys.path.insert(0, ".")

from app.database import SessionLocal
from app.models import AuditLog, Document, File
from app import storage

SYSTEM_NOTE = "CAD->DWG 짝 폴더명 일괄 정리 (병합 유지, 1회성 스크립트)"


def main():
    db = SessionLocal()
    try:
        pairs = (
            db.query(File, Document)
            .join(Document, File.document_id == Document.id)
            .filter(File.pairing_folder == "CAD")
            .all()
        )
        print(f"대상 파일 총 {len(pairs)}건")

        moved = 0
        skipped_missing = 0
        for f, d in pairs:
            if f.is_current:
                old_dest = storage.latest_file_path(d.source_path, d.drawing_no, f.file_ext, "CAD")
                new_dest = storage.latest_file_path(d.source_path, d.drawing_no, f.file_ext, "DWG")
                if old_dest.is_file():
                    if new_dest.exists():
                        raise RuntimeError(f"충돌: {new_dest} 이미 존재")
                    new_dest.parent.mkdir(parents=True, exist_ok=True)
                    old_dest.rename(new_dest)
                    f.file_path = storage.to_relative(new_dest)
                    moved += 1
                else:
                    skipped_missing += 1
            f.pairing_folder = "DWG"

        db.add(AuditLog(
            user_id=None, action="RENAME_PAIR_FOLDER_BULK", screen="폴더·자료 편집(스크립트)",
            detail={
                "old_name": "CAD", "new_name": "DWG", "affected_files": len(pairs),
                "moved_physical": moved, "missing_source": skipped_missing,
                "note": SYSTEM_NOTE,
                "source_paths": [
                    "5. DRAWINGS\\5.1   Plot Plan & ELP & Piping Plan Drawing\\5.1.5  Steam Tracing Isometric Drawing List (ISBL)\\B Area",
                    "5. DRAWINGS\\5.1   Plot Plan & ELP & Piping Plan Drawing\\5.1.5  Steam Tracing Isometric Drawing List (ISBL)\\C Area",
                    "5. DRAWINGS\\5.1   Plot Plan & ELP & Piping Plan Drawing\\5.1.5  Steam Tracing Isometric Drawing List (ISBL)\\D Area",
                    "5. DRAWINGS\\5.1   Plot Plan & ELP & Piping Plan Drawing\\5.1.5  Steam Tracing Isometric Drawing List (ISBL)\\E Area",
                    "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)",
                ],
            },
        ))
        db.commit()
        print(f"완료: 물리 이동 {moved}건, DB만 변경(이력본) {len(pairs) - moved}건, 원본 없어 건너뜀 {skipped_missing}건")
    finally:
        db.close()


if __name__ == "__main__":
    main()
