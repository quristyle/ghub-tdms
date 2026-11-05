"""원본 미리보기 주소 (D-102).

  GET  /preview/sources?kind=TDB&doc_id=… (또는 pdf_file_id=…) / kind=MDB&file_id=…
       → 이 자료가 가진 사본(PDF)·원본을 알려준다. 미리보기 화면이 [사본]/[원본] 버튼을 켜고 끄는 데 쓴다.
       kind=TDB&set_file_id=… 이면 현재본이 아니라 그 파일이 속한 리비전 세트의 사본·원본
       (자료 상세보기 Revision 이력의 돋보기 — 구 리비전도 원본/사본을 바꿔 본다).
  POST /preview/original/{TDB|MDB}/{file_id}/prepare
       → 원본을 미리보기용 PDF로 바꿔 둔다(이미 있으면 바로 끝). 못 바꾸면 422 + 사용자용 설명.
  GET  /preview/original/{TDB|MDB}/{file_id}/view
       → 바꿔 둔 PDF를 돌려준다(뷰어가 연다).
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.config import STORAGE_ROOT
from app.database import get_db
from app.mdb_group import MdbGroup
from app.models import Document, File, MdbFile
from app.rev_naming import document_display_name, file_display_name
from app.revision_sets import files_in_same_set
from app.original_preview import PreviewError, ensure_preview, preview_kind, unsupported_here_reason
from app.routers.mdb import visible_group
from app.utils import content_disposition_header, sanitize_path_component

router = APIRouter(prefix="/preview", tags=["preview"])


def pick_original(rows):
    """원본이 여러 개면(드물다 — 예: dwg+xls) 미리보기할 수 있는 것 중 DWG를 먼저 고른다."""
    originals = [r for r in rows if (r.file_ext or "").lower() != "pdf"]
    convertible = [r for r in originals if preview_kind(r.file_ext)]
    convertible.sort(key=lambda r: (preview_kind(r.file_ext) != "dwg", r.id))
    return (convertible or originals or [None])[0]


def original_payload(kind: str, row, download_url: str) -> dict:
    ext = (row.file_ext or "").lower()
    return {
        "file_id": row.id,
        "ext": ext,
        "label": ext.upper(),
        # 미리보기를 만들 수 없는 형식(HWP 등)이거나 이 컴퓨터 설정으로 못 바꾸는 경우 그 이유
        "unsupported_reason": unsupported_here_reason(ext),
        "prepare_url": f"/preview/original/{kind}/{row.id}/prepare",
        "view_url": f"/preview/original/{kind}/{row.id}/view",
        "download_url": download_url,
    }


def tdb_current_files(db: Session, doc_id: int) -> list[File]:
    return db.query(File).filter(File.document_id == doc_id, File.is_current.is_(True)).all()


def tdb_sources_payload(document: Document, rows: list[File]) -> dict:
    pdf = next((r for r in rows if r.file_ext == "pdf"), None)
    original = pick_original(rows)
    return {
        # 자료명은 보여 주는 세트의 리비전으로 꼬리를 붙인다 — 과거 Rev 세트를 열면 그 Rev 이름
        "kind": "TDB", "doc_id": document.id,
        "name": file_display_name(document, rows[0]) if rows else document_display_name(document),
        "pdf": {"file_id": pdf.id, "view_url": f"/files/{pdf.id}/view"} if pdf else None,
        "original": original_payload("TDB", original, f"/files/{original.id}/download") if original else None,
    }


@router.get("/sources")
def preview_sources(
    kind: str,
    doc_id: Optional[int] = None,
    pdf_file_id: Optional[int] = None,
    file_id: Optional[int] = None,
    set_file_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    if kind == "TDB" and set_file_id is not None:
        member = db.get(File, set_file_id)
        document = db.get(Document, member.document_id) if member else None
        if document is None:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        return tdb_sources_payload(document, files_in_same_set(db, member))
    if kind == "TDB":
        if doc_id is None and pdf_file_id is not None:
            f = db.get(File, pdf_file_id)
            doc_id = f.document_id if f else None
        document = db.get(Document, doc_id) if doc_id is not None else None
        if document is None:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        return tdb_sources_payload(document, tdb_current_files(db, document.id))
    if kind == "MDB":
        group = visible_group(db, file_id) if file_id is not None else None
        if group is None:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        pdf = group.pdf_row
        original = pick_original(group.rows)
        return {
            "kind": "MDB", "mdb_file_id": group.id, "name": group.name,
            "pdf": {"file_id": pdf.id, "view_url": f"/mdb/files/{pdf.id}/view"} if pdf else None,
            "original": original_payload("MDB", original, f"/mdb/files/{original.id}/download") if original else None,
        }
    raise HTTPException(status_code=400, detail="kind는 TDB 또는 MDB여야 합니다")


def resolve_original(kind: str, file_id: int, db: Session) -> tuple[Path, str, Optional[str], str]:
    """(원본 경로, 확장자, sha256, 자료명)"""
    if kind == "TDB":
        row = db.get(File, file_id)
        if row is None or row.file_ext == "pdf":
            raise HTTPException(status_code=404, detail="원본 파일을 찾을 수 없습니다")
        document = db.get(Document, row.document_id)
        name = file_display_name(document, row) if document else Path(row.file_path).stem
        return Path(STORAGE_ROOT) / row.file_path, row.file_ext, row.sha256, name
    if kind == "MDB":
        row = db.get(MdbFile, file_id)
        group: Optional[MdbGroup] = visible_group(db, file_id) if row else None
        if row is None or group is None or row.is_pdf:
            raise HTTPException(status_code=404, detail="원본 파일을 찾을 수 없습니다")
        return Path(STORAGE_ROOT) / row.storage_path, row.file_ext, row.sha256, group.name
    raise HTTPException(status_code=400, detail="kind는 TDB 또는 MDB여야 합니다")


@router.post("/original/{kind}/{file_id}/prepare")
def prepare_original(kind: str, file_id: int, db: Session = Depends(get_db)):
    src, ext, sha, _ = resolve_original(kind, file_id, db)
    # 변환은 길게는 몇 분 걸린다 — 그동안 DB 연결을 붙잡고 있지 않게 먼저 돌려준다.
    db.close()
    try:
        ensure_preview(src, ext, sha)
    except PreviewError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"ready": True}


@router.get("/original/{kind}/{file_id}/view")
def view_original(kind: str, file_id: int, db: Session = Depends(get_db)):
    src, ext, sha, name = resolve_original(kind, file_id, db)
    db.close()
    try:
        pdf = ensure_preview(src, ext, sha)
    except PreviewError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return FileResponse(
        pdf, media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition_header("inline", f"{sanitize_path_component(name)}.pdf"),
            "Cache-Control": "no-store",
        },
    )
