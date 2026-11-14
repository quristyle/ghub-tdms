from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth import current_user
from app.config import STORAGE_ROOT
from app.database import get_db
from app.models import AuditLog, Document, File, User
from app.permissions import require_permission
from app.rev_naming import file_display_name
from app.revision_sets import files_in_same_set
from app.schemas import UpdateNoteRequest
from app.utils import content_disposition_header, sanitize_path_component

router = APIRouter(prefix="/files", tags=["files"])

require_note_edit = require_permission("common.note_edit.revision")

MEDIA_TYPES = {
    "pdf": "application/pdf",
    "dwg": "application/acad",
}


def resolve_path(file_row: File) -> Path:
    path = Path(STORAGE_ROOT) / file_row.file_path
    if not path.is_file():
        raise HTTPException(status_code=404, detail="파일이 저장소에 없습니다")
    return path


def download_filename(document: Document, file_row: File) -> str:
    """다운로드 파일명은 내부 관리용 이름이 아니라 화면의 '자료명' 그대로 — `도면번호_Rev00.dwg`.

    꼬리는 그 파일의 리비전으로 붙인다(rev_naming). 이력 파일은 디스크 이름이 업체가 보낸
    그대로(`_R0` 등)일 수 있지만 받을 때는 화면 Revision 이력에 보이는 이름으로 내려준다.
    """
    return f"{sanitize_path_component(file_display_name(document, file_row))}.{file_row.file_ext}"


@router.get("/{file_id}/view")
def view_file(file_id: int, db: Session = Depends(get_db)):
    file_row = db.get(File, file_id)
    if file_row is None:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    if file_row.file_ext != "pdf":
        raise HTTPException(status_code=400, detail="PDF만 웹에서 열람할 수 있습니다")

    document = db.get(Document, file_row.document_id)
    path = resolve_path(file_row)
    return FileResponse(
        path,
        media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition_header(
                "inline", download_filename(document, file_row)
            ),
            # 리비전이 바뀌어도 file_id가 다르므로 내용 자체가 캐시로 꼬일 일은 없지만,
            # 브라우저가 예전 응답(파일명 없던 시절 등)을 그대로 재사용해 "저장" 시 엉뚱한
            # 이름이 뜨는 걸 막기 위해 항상 새로 받아오게 한다.
            "Cache-Control": "no-store",
        },
    )


@router.get("/{file_id}/view/{markup_filename}")
def view_file_with_markup_name(
    file_id: int, markup_filename: str, db: Session = Depends(get_db)
):
    """미리보기와 내용은 똑같고, 주소 맨 뒤에 파일명만 덧붙일 수 있게 한 것.

    브라우저 내장 PDF 뷰어는 [저장]할 때 파일명을 두 가지 방법으로 정한다.
      · 손대지 않은 PDF  → 서버가 내려준 Content-Disposition 파일명(= 자료명.pdf)
      · 그리기·형광펜으로 고친 PDF → 그 헤더를 무시하고 **주소 맨 뒤**를 파일명으로 쓴다
    그래서 예전에는 주소가 `/files/12/view`로 끝나 마크업 후 저장하면 `view.pdf`가 됐다.
    화면이 주소 뒤에 `자료명(Markup).pdf`를 붙여 부르면 그 이름으로 저장된다.
    붙은 이름은 서버가 쓰지 않는다(어느 파일인지는 file_id로만 정한다)."""
    return view_file(file_id, db)


@router.get("/{file_id}/download")
def download_file(
    file_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    file_row = db.get(File, file_id)
    if file_row is None:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    document = db.get(Document, file_row.document_id)

    path = resolve_path(file_row)
    media_type = MEDIA_TYPES.get(file_row.file_ext, "application/octet-stream")

    db.add(AuditLog(
        user_id=user.id,
        action="DOWNLOAD",
        screen="도면 목록",
        document_id=file_row.document_id,
        detail={"file_id": file_row.id, "rev": file_row.rev, "branch": file_row.branch,
                "file_ext": file_row.file_ext},
    ))
    db.commit()

    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Content-Disposition": content_disposition_header(
                "attachment", download_filename(document, file_row)
            ),
            "Cache-Control": "no-store",
        },
    )


@router.post("/{file_id}/note")
def update_file_note(
    file_id: int,
    body: UpdateNoteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_note_edit),
):
    """Revision 이력의 비고를 자유롭게 적어둔다 (검수 반려 사유와 별개로, 언제든 다시 고쳐 쓸 수 있는 메모).

    작성(수정)은 권한(공통 > 비고 작성 > Revision 이력 비고 작성)이 있어야만 가능하다 —
    조회는 누구나, 작성은 관리자 또는 권한을 받은 그룹만(2026-08-17 CM 확정)."""
    file_row = db.get(File, file_id)
    if file_row is None:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    # Revision 이력은 세트(같은 rev의 원본+PDF)마다 한 줄이라, 비고도 세트의 파일 전부에 같이 적는다.
    for f in files_in_same_set(db, file_row):
        f.review_note = body.note
    db.commit()
    return {"status": "ok"}
