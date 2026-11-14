"""Revision 이력을 "세트" 단위로 묶는 규칙 (2026-09-27 CM 지시).

한 번의 리비전 업로드는 같은 rev를 공유하는 파일 여러 개(원본 + PDF)로 이뤄지고(D-19),
승인·반려·이력 이동도 늘 세트째 함께 움직인다. 그래서 자료 상세보기의 Revision 이력은
파일마다 한 줄이 아니라 세트마다 한 줄로 보여준다.

세트를 가르는 기준은 검수(imports.review_revision)가 세트를 집어 올 때 쓰는 것과 같다 —
같은 문서 + 같은 rev + 같은 branch + 같은 검수상태.
이 규칙은 여기 한 곳에만 둔다(화면 목록·엑셀 내보내기·비고 저장·미리보기가 함께 쓴다).
"""

from typing import Optional

from sqlalchemy.orm import Session

from app.models import File
from app.rev_naming import file_display_name


def set_key(f: File) -> tuple:
    return (f.document_id, f.rev, f.branch, f.review_status)


def group_revision_sets(files: list[File]) -> list[list[File]]:
    """파일 목록을 세트로 묶는다. 세트 순서는 들어온 파일 순서(처음 나온 자리)를 따른다."""
    groups: dict[tuple, list[File]] = {}
    for f in files:
        groups.setdefault(set_key(f), []).append(f)
    return list(groups.values())


def files_in_same_set(db: Session, file_row: File) -> list[File]:
    q = db.query(File).filter(
        File.document_id == file_row.document_id,
        File.rev == file_row.rev,
        File.review_status == file_row.review_status,
    )
    q = q.filter(File.branch.is_(None)) if file_row.branch is None else q.filter(File.branch == file_row.branch)
    return q.order_by(File.id).all()


def set_name(doc, files: list[File]) -> str:
    """세트의 자료명 — `도면번호_Rev01`처럼 그 세트의 리비전으로 꼬리를 붙인 이름(rev_naming).

    예전에는 업체가 보낸 파일명(original_filename)을 그대로 보여줬는데, 2026-10-01부터 모든
    화면의 자료명을 시스템 규칙 이름으로 통일했다(이력 폴더 파일의 실제 이름은 그대로 둔다).
    한 세트의 파일은 rev·branch가 같으므로 이름도 하나다.
    """
    return file_display_name(doc, files[0])


def set_note(files: list[File]) -> Optional[str]:
    """세트의 비고. 예전에는 파일마다 따로 적을 수 있어 서로 다를 수 있으므로, 다르면 이어서 보여준다."""
    notes: list[str] = []
    for f in files:
        if f.review_note and f.review_note not in notes:
            notes.append(f.review_note)
    return " / ".join(notes) if notes else None


def set_pdf(files: list[File]) -> Optional[File]:
    return next((f for f in files if (f.file_ext or "").lower() == "pdf"), None)


def set_originals(files: list[File]) -> list[File]:
    return [f for f in files if (f.file_ext or "").lower() != "pdf"]
