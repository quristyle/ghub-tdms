"""아직 병합되지 않은 '실제' CAD 폴더(문서.source_path가 문자 그대로 "...\\CAD"로 끝나는 경우)
안의 자료를 전부 DWG 짝 폴더로 옮기고 CAD 폴더는 없앤다 (2026-08-19 CM 요청).

D-33~D-46이 다루는 "짝 인식"은 같은 상위 폴더에 DWG·PDF 폴더가 둘 다 있고 이름이 겹치는
자료만 자동/버튼으로 병합해준다. 이 스크립트가 다루는 30건은 그 조건에 안 맞아
(PDF 짝이 없거나, 폴더 자체가 도면과 무관한 자료) 병합 후보에도 안 뜨고 실제 폴더로 그대로
남아 있던 것들이다. CM 요청은 "매칭 파일이 없어도 무조건 옮기고 CAD는 지워라"이므로,
files.pairing_folder 값을 'DWG'로 채워 기존에 CAD->DWG로 옮겨둔 것과 같은 방식(숨은 짝 폴더)으로
편입시킨다 — 화면 트리에서는 폴더가 사라지고(자료가 상위 폴더로 올라와 보임), 저장 위치는
그 폴더 밑 'DWG' 폴더에 그대로 남는다.

B/D/E Area는 상위 폴더에 이미 숨은 DWG 짝 폴더(이전 CAD->DWG 병합)가 있어, 이 자료들도
같은 자리로 편입된다 — 사전에 (도면번호, 확장자) 충돌이 없음을 확인함.

2026-08-19 1회성 실행, CM 요청.
"""

import sys

sys.path.insert(0, ".")

from app.database import SessionLocal
from app.models import AuditLog, Document, File
from app import storage

TARGET_FOLDER = "DWG"


def split_last_segment(path: str) -> tuple[str, str]:
    parts = [p for p in path.replace("/", "\\").split("\\") if p]
    return "\\".join(parts[:-1]), (parts[-1] if parts else "")


def main():
    db = SessionLocal()
    try:
        docs = db.query(Document).filter(Document.is_archived.is_(False)).all()
        targets = []
        for d in docs:
            if not d.source_path:
                continue
            parent, last = split_last_segment(d.source_path)
            if last == "CAD":
                targets.append((d, parent))

        print(f"대상 문서 {len(targets)}건")

        moved = 0
        db_only = 0
        for doc, parent in targets:
            files = db.query(File).filter(File.document_id == doc.id).all()
            for f in files:
                if f.is_current:
                    old_dest = storage.latest_file_path(doc.source_path, doc.drawing_no, f.file_ext, None)
                    new_dest = storage.latest_file_path(parent, doc.drawing_no, f.file_ext, TARGET_FOLDER)
                    if old_dest.is_file():
                        if new_dest.exists():
                            raise RuntimeError(f"충돌: {new_dest} 이미 존재 (문서 {doc.id})")
                        new_dest.parent.mkdir(parents=True, exist_ok=True)
                        old_dest.rename(new_dest)
                        f.file_path = storage.to_relative(new_dest)
                        moved += 1
                    else:
                        print(f"경고: 원본 파일 없음 - 문서 {doc.id} {doc.drawing_no}.{f.file_ext}")
                    f.pairing_folder = TARGET_FOLDER
                else:
                    f.pairing_folder = TARGET_FOLDER
                    db_only += 1
            doc.source_path = parent or None

        db.add(AuditLog(
            user_id=None, action="MOVE_REAL_CAD_TO_DWG", screen="폴더·자료 편집(스크립트)",
            detail={
                "affected_documents": len(targets), "moved_physical": moved, "db_only": db_only,
                "note": "매칭 PDF 없는 실제 CAD 폴더 30건을 숨은 DWG 짝 폴더로 편입, CAD 폴더 삭제",
                "folders": sorted({parent for _d, parent in targets}),
            },
        ))
        db.commit()
        print(f"완료: 물리 이동 {moved}건, DB만 변경 {db_only}건")
    finally:
        db.close()


if __name__ == "__main__":
    main()
