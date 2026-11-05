import shutil
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, tuple_
from sqlalchemy.orm import Session, aliased

from app import storage
from app.auth import current_user
from app.config import STORAGE_ROOT
from app.database import get_db
from app.models import AuditLog, Distribution, Document, File, ImportIssue, Project, User
from app.permissions import has_permission
from app.rev_naming import distribution_display_name, strip_rev_tail
from app.routers.documents import path_after_category
from app.schemas import (
    DistributedForImportItem,
    DistributeRequest,
    DistributeResponse,
    DistributeResultItem,
    DistributionFilterOption,
    DistributionListItem,
    DistributionZipListItem,
    OutstandingItem,
    OutstandingSummary,
    ReturnRequest,
    UpdateNoteRequest,
    ZipMaterialItem,
    ZipReturnRequest,
)
from app.utils import (
    build_export_filename,
    content_disposition_header,
    filename_timestamp,
    neutralize_formulas,
    sanitize_path_component,
)

router = APIRouter(prefix="/distributions", tags=["distributions"])

PURPOSE_LABELS = {"MODIFY": "수정용", "REFERENCE": "참조용", "OTHER": "기타"}

# 반출목록 엑셀 헤더. 반입(대량 반입)에서 이 엑셀을 그대로 읽어 매칭하므로
# "문서ID"와 "업체" 이름은 바꾸지 말 것 (순서는 이름으로 찾으므로 자유롭게 바꿔도 됨).
# 문서ID는 도면번호 중복(1,702종)이 있어도 정확히 매칭하기 위한 키. 숨김 열은 CM이 원치 않아
# 그냥 보이는 열로 둔다(대량 반입 매칭 로직은 헤더 이름으로 찾으므로 보이든 숨기든 상관없음).
MANIFEST_HEADERS = [
    "No", "공사", "업체", "자료명", "경로", "반출Rev",
    "DWG", "XLSX", "ETC", "PDF", "반출자", "반출일시", "문서ID",
]

# 열 너비 (엑셀에서 바로 읽기 편하도록)
MANIFEST_WIDTHS = [6, 16, 12, 26, 55, 9, 7, 7, 7, 7, 12, 17, 9]


def exts_by_document_rev(db: Session, pairs: set[tuple[int, int]]) -> dict[tuple[int, int], set[str]]:
    """(문서ID, rev) 조합별로 그 시점에 있던 파일 확장자 집합을 한 번에 조회한다.

    반출 건이 많을 때 건마다 File 조회를 따로 하지 않도록(N+1 방지) 미리 모아서 한 번에 가져온다.
    """
    if not pairs:
        return {}
    result: dict[tuple[int, int], set[str]] = {}
    for document_id, rev, ext in db.query(File.document_id, File.rev, File.file_ext).filter(
        tuple_(File.document_id, File.rev).in_(pairs)
    ):
        result.setdefault((document_id, rev), set()).add((ext or "").lower())
    return result


def build_manifest_bytes(db: Session, rows: list[tuple]) -> bytes:
    """반출 대상 (Distribution, Document, Project) 목록으로 반출목록 엑셀 생성.

    반출 시 zip에 동봉되고, 반출이력 화면에서도 같은 양식으로 내보낸다.
    이 파일을 그대로 '대량 반입'에 넣으면 문서ID(숨김 컬럼)로 자동 매칭된다.
    """
    names_by_id = user_names_by_id(db, [dist.distributed_by for dist, _doc, _proj in rows])
    exts_by_pair = exts_by_document_rev(db, {(doc.id, dist.rev_at_distribution) for dist, doc, _proj in rows})

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "반출목록"
    ws.append(MANIFEST_HEADERS)

    for no, (dist, doc, project) in enumerate(rows, start=1):
        # 반출 시점에 그 도면이 갖고 있던 파일 확장자 = 반출자료
        exts = exts_by_pair.get((doc.id, dist.rev_at_distribution), set())
        ws.append([
            no,
            project.name if project else None,
            dist.vendor,
            distribution_display_name(doc, dist),
            doc.source_path,
            dist.rev_at_distribution,
            "Y" if "dwg" in exts else "",
            "Y" if exts & {"xlsx", "xls"} else "",
            "Y" if exts - {"dwg", "xlsx", "xls", "pdf"} else "",
            "Y" if "pdf" in exts else "",
            names_by_id.get(dist.distributed_by),
            dist.distributed_at.strftime("%Y-%m-%d %H:%M") if dist.distributed_at else None,
            doc.id,
        ])

    # 헤더 굵게 + 고정, 열 너비, 매칭용 숨김 컬럼
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(MANIFEST_WIDTHS, start=1):
        letter = openpyxl.utils.get_column_letter(idx)
        ws.column_dimensions[letter].width = width

    out = BytesIO()
    neutralize_formulas(wb)
    wb.save(out)
    return out.getvalue()


@router.post("", response_model=DistributeResponse)
def create_distributions(
    body: DistributeRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    # 반출자(누가 반출을 실행했는지)는 지금 로그인된 사용자여야 한다(D-12 동료 로그인 이후
    # 실행자가 CM 한 명으로 고정이 아니게 됐다) — 고정 관리자 계정(get_or_create_admin_user)을
    # 쓰던 예전 코드를 지우고 실제 세션 사용자를 쓴다.
    # 수정용(MODIFY) 반출만 권한.xlsx의 리프 권한이 필요하다 — 참조용/기타는 로그인만 하면 된다
    # (2026-08-12 CM 확정).
    if body.purpose == "MODIFY" and not has_permission(db, user, "screen.tdb_list.distribute.modify"):
        raise HTTPException(status_code=403, detail="이 기능을 사용할 권한이 없습니다")

    docs = db.query(Document).filter(Document.id.in_(body.document_ids)).all()
    docs_by_id = {d.id: d for d in docs}
    missing_ids = set(body.document_ids) - docs_by_id.keys()
    if missing_ids:
        raise HTTPException(status_code=404, detail=f"존재하지 않는 문서: {sorted(missing_ids)}")

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y%m%d")
    vendor = body.vendor.strip() or "해당없음"
    purpose_note = body.purpose_note.strip() if body.purpose_note and body.purpose_note.strip() else None
    # 수정용은 반드시 폴더 경로를 유지한다 — 업체가 받은 폴더 구조 그대로 작업해 그대로 돌려줘야
    # 반입할 때 어느 도면 것인지 자동으로 찾을 수 있기 때문(2026-08-28 CM 확정).
    # 화면에서도 체크를 못 풀게 잠가두지만, 서버에서도 한 번 더 고정한다.
    keep_paths = True if body.purpose == "MODIFY" else body.keep_paths

    results = []
    for document_id in body.document_ids:
        doc = docs_by_id[document_id]

        duplicate_warning = (
            db.query(Distribution)
            .filter(
                Distribution.document_id == document_id,
                Distribution.purpose == "MODIFY",
                Distribution.returned_at.is_(None),
            )
            .first()
            is not None
        )

        current_files = (
            db.query(File)
            .filter(File.document_id == document_id, File.is_current.is_(True))
            .all()
        )

        # 원본이 DWG·PDF 폴더로 나뉘어 있던 자료면 반출 사본도 같은 모양으로 만든다
        # (업체가 받은 폴더 구조 그대로 작업하고 그대로 돌려줄 수 있게 — 2026-08-16 CM 확정).
        dest_dir = storage.distributed_dir_path(vendor, date_str, doc.drawing_no)
        for f in current_files:
            src = Path(STORAGE_ROOT) / f.file_path
            if src.is_file():
                dest = storage.distributed_file_path(dest_dir, src.name, f.pairing_folder)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)

        distribution = Distribution(
            document_id=document_id,
            rev_at_distribution=doc.current_rev,
            vendor=vendor,
            project_id=body.project_id,
            purpose=body.purpose,
            purpose_note=purpose_note,
            distributed_by=user.id,
            distributed_at=now,
            file_saved_path=str(dest_dir.relative_to(STORAGE_ROOT)).replace("\\", "/"),
            keep_paths=keep_paths,
        )
        db.add(distribution)
        db.flush()

        if body.purpose == "MODIFY" and doc.status == "ACTIVE":
            doc.status = "CHECKED_OUT"

        db.add(AuditLog(
            user_id=user.id,
            action="DISTRIBUTE",
            screen="도면 목록",
            document_id=document_id,
            detail={
                "distribution_id": distribution.id,
                "vendor": vendor,
                "purpose": body.purpose,
                "purpose_note": purpose_note,
                "keep_paths": keep_paths,
                "duplicate_warning": duplicate_warning,
            },
        ))

        results.append(DistributeResultItem(
            document_id=document_id,
            distribution_id=distribution.id,
            drawing_no=doc.drawing_no,
            display_name=distribution_display_name(doc, distribution),
            duplicate_warning=duplicate_warning,
        ))

    db.commit()
    return DistributeResponse(results=results)


def build_zip_bytes(db: Session, rows: list[tuple]) -> bytes:
    """반출 대상 (Distribution, Document, Project) 목록으로 반출 zip 파일 내용을 만든다.

    최초 반출(download-zip)과 반출이력 Zip 다운로드가 같은 결과를 내도록 공용화.
    반출 당시 storage/distributed에 저장해 둔 사본을 그대로 담고, 반출목록 엑셀을 동봉한다.

    반출할 때 [폴더 경로 유지]를 꺼둔 묶음(keep_paths=false, 참조용·기타만 가능)은 폴더 없이
    파일과 엑셀 목록을 zip 바로 밑에 평평하게 담는다 — 저장된 반출 사본 자체는 어느 쪽이든
    항상 폴더 구조대로 남으므로, 나중에 반출이력에서 다시 받을 때도 그때 고른 모양 그대로
    내려줄 수 있다(2026-08-28 CM 확정). 한 번의 반출하기 = zip 1개라 묶음 안 값은 전부 같다.
    """
    keep_paths = all(dist.keep_paths for dist, _doc, _project in rows)
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        used_names: set[str] = set()
        for dist, doc, _project in rows:
            folder = Path(STORAGE_ROOT) / dist.file_saved_path
            if not folder.is_dir():
                continue
            # 업체가 폴더 구조만 보고도 도면 위치를 알 수 있도록 원래 폴더 경로를 그대로 재현한다.
            # 반출 사본 안의 DWG·PDF 폴더까지 그대로 담기 위해 하위 폴더도 따라 들어간다
            # (rglob — 예전에는 바로 밑 파일만 담아서 DWG·PDF 폴더 안이 통째로 빠졌다).
            source_path = (doc.source_path or "").strip("\\/").replace("\\", "/")
            for file_path in sorted(folder.rglob("*")):
                if not file_path.is_file():
                    continue
                inner = file_path.relative_to(folder).as_posix()
                if keep_paths:
                    arcname = f"{source_path}/{inner}" if source_path else inner
                else:
                    # 폴더를 전부 떼고 파일명만 남긴다. 다른 폴더에 같은 이름이 있었으면
                    # 덮어쓰지 않고 뒤에 (2),(3)…을 붙인다(MDB 다운 zip과 같은 방식).
                    arcname = file_path.name
                    base = arcname
                    n = 2
                    while arcname in used_names:
                        stem, dot, ext = base.rpartition(".")
                        arcname = f"{stem} ({n}).{ext}" if dot else f"{base} ({n})"
                        n += 1
                used_names.add(arcname)
                zf.write(file_path, arcname)
        # 반출목록 엑셀 동봉 (반입 시 자동 매칭용, 문서ID 숨김 컬럼 포함)
        zf.writestr(f"TDB 반출목록_{filename_timestamp()}.xlsx", build_manifest_bytes(db, rows))
    buf.seek(0)
    return buf.getvalue()


@router.get("/download-zip")
def download_zip(ids: str = Query(..., description="distribution id 쉼표구분"), db: Session = Depends(get_db)):
    distribution_ids = [int(x) for x in ids.split(",") if x]
    rows = (
        db.query(Distribution, Document, Project)
        .join(Document, Distribution.document_id == Document.id)
        .outerjoin(Project, Distribution.project_id == Project.id)
        .filter(Distribution.id.in_(distribution_ids))
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail="반출 기록을 찾을 수 없습니다")

    filename = f"TDB 반출_{filename_timestamp()}.zip"
    content = build_zip_bytes(db, rows)

    # 이 묶음(반출하기 한 번)의 zip 파일명을 기록 — 반출이력 화면 "Zip" 모드에서
    # 이 값으로 묶어 zip 1개당 1행으로 보여준다.
    db.query(Distribution).filter(Distribution.id.in_(distribution_ids)).update(
        {"zip_filename": filename}, synchronize_session=False
    )
    db.commit()

    return StreamingResponse(
        BytesIO(content),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.get("/zip-file")
def download_zip_by_filename(
    zip_filename: str = Query(..., description="반출 시 생성된 zip 파일명"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """반출이력 Zip 모드의 [Zip 다운] — 그 zip_filename으로 나갔던 자료들을 다시 묶어
    원래 파일명 그대로 내려준다. (반출 당시 저장한 사본으로 만들어 내용도 동일하다)

    최초 반출(POST /distributions + download-zip)과는 별개로 자료가 다시 외부로 나가는
    행위라 DOWNLOAD로 기록한다 (CM 규칙 5번, 2026-08-11)."""
    rows = (
        db.query(Distribution, Document, Project)
        .join(Document, Distribution.document_id == Document.id)
        .outerjoin(Project, Distribution.project_id == Project.id)
        .filter(Distribution.zip_filename == zip_filename)
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail="해당 Zip 파일을 찾을 수 없습니다")

    content = build_zip_bytes(db, rows)

    db.add(AuditLog(
        user_id=user.id, action="DOWNLOAD", screen="반출 이력",
        detail={"kind": "반출Zip 재다운로드", "zip_filename": zip_filename, "document_count": len(rows)},
    ))
    db.commit()

    return StreamingResponse(
        BytesIO(content),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition_header("attachment", zip_filename)},
    )


def outstanding_rows(db: Session):
    """도면이 곧 바뀔 수 있는 반출 건 — 오래 나가 있는 순.
    팝업 목록과 엑셀 내보내기가 같은 내용을 쓰도록 조회를 한 곳에 모아둔다.

    두 가지를 함께 센다(2026-08-14 CM 확정 — 검수대기도 승인되면 리비전이 바뀌므로
    "곧 바뀔 수 있다"는 이 표시의 대상에 포함돼야 함):
    ① 아직 안 돌아온 것(returned_at NULL)
    ② 이미 돌아왔지만 아직 검수 전인 것(review_status=PENDING_REVIEW) — 승인되는 순간 바뀜
    검수까지 끝나 승인/반려된 것은 더 이상 "곧 바뀔 수 있는" 상태가 아니므로 빠진다."""
    ReturnedFile = aliased(File)
    return (
        db.query(Distribution, Document, Project, User)
        .join(Document, Distribution.document_id == Document.id)
        .outerjoin(Project, Distribution.project_id == Project.id)
        .outerjoin(User, Distribution.distributed_by == User.id)
        .outerjoin(ReturnedFile, Distribution.returned_file_id == ReturnedFile.id)
        .filter(
            Distribution.purpose == "MODIFY",
            or_(
                Distribution.returned_at.is_(None),
                ReturnedFile.review_status == "PENDING_REVIEW",
            ),
        )
        .order_by(Distribution.distributed_at.asc())
        .all()
    )


def outstanding_status(dist: Distribution) -> str:
    """미반납(NOT_RETURNED)인지 검수대기(REVIEWING)인지 — 팝업·엑셀에서 표시용."""
    return "NOT_RETURNED" if dist.returned_at is None else "REVIEWING"


@router.get("/outstanding", response_model=list[OutstandingItem])
def list_outstanding(db: Session = Depends(get_db)):
    rows = outstanding_rows(db)

    # 자료명 옆 돋보기(미리보기)가 열 PDF — 목록 화면과 같은 "현재 리비전 PDF"다.
    doc_ids = [doc.id for _, doc, _, _ in rows]
    pdf_file_id_by_doc = dict(
        db.query(File.document_id, File.id)
        .filter(
            File.document_id.in_(doc_ids),
            File.is_current.is_(True),
            File.file_ext == "pdf",
        )
        .all()
    ) if doc_ids else {}

    return [
        OutstandingItem(
            distribution_id=dist.id,
            document_id=doc.id,
            drawing_no=doc.drawing_no,
            display_name=distribution_display_name(doc, dist),
            title=doc.title,
            category=doc.category,
            path=path_after_category(doc),
            vendor=dist.vendor,
            project_id=dist.project_id,
            project_name=project.name if project else None,
            rev_at_distribution=dist.rev_at_distribution,
            distributed_at=dist.distributed_at,
            distributed_by_name=user.name if user else None,
            current_pdf_file_id=pdf_file_id_by_doc.get(doc.id),
            status=outstanding_status(dist),
        )
        for dist, doc, project, user in rows
    ]


@router.get("/outstanding/summary", response_model=OutstandingSummary)
def outstanding_summary(db: Session = Depends(get_db)):
    """상단 [TDB 반출] 버튼의 건수.

    세는 대상은 "도면이 곧 바뀔 수 있는 것" — 수정용으로 나가서 아직 안 돌아온 것 +
    이미 돌아왔지만 검수 전인 것(검수대기)이다. 참조용은 도면이 바뀌지 않으니
    "곧 바뀔 수 있으니 조심하라"는 이 표시의 뜻에 해당하지 않는다(CM 확정, 2026-08-14 개정).
    로그인한 사람이면 누구나 같은 숫자를 본다.
    """
    ReturnedFile = aliased(File)
    count = (
        db.query(func.count(Distribution.id))
        .outerjoin(ReturnedFile, Distribution.returned_file_id == ReturnedFile.id)
        .filter(
            Distribution.purpose == "MODIFY",
            or_(
                Distribution.returned_at.is_(None),
                ReturnedFile.review_status == "PENDING_REVIEW",
            ),
        )
        .scalar() or 0
    )
    return OutstandingSummary(count=count)


@router.get("/outstanding/export")
def export_outstanding(
    label: Optional[str] = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """상단 [TDB 반출] 팝업의 표를 화면과 같은 컬럼·같은 순서(오래 나가 있는 순)로 내보낸다.

    파일명은 화면·팝업 제목을 그대로 따라가야 하므로(2026-08-11 CM 확정),
    팝업에서 열었을 땐 label로 팝업 제목을 넘긴다.
    """
    rows = outstanding_rows(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "반출중"
    # 컬럼 구성은 팝업 표와 반드시 같아야 한다(엑셀 내보내기 공통 규칙).
    OUTSTANDING_STATUS_LABELS = {"NOT_RETURNED": "미반납", "REVIEWING": "검수대기"}
    ws.append(["No", "상태", "반출일", "자료명", "공사", "업체", "분류", "경로", "반출자"])
    for no, (dist, doc, project, user) in enumerate(rows, start=1):
        ws.append([
            no,
            OUTSTANDING_STATUS_LABELS[outstanding_status(dist)],
            dist.distributed_at.strftime("%Y-%m-%d %H:%M") if dist.distributed_at else None,
            distribution_display_name(doc, dist),
            project.name if project else None,
            dist.vendor,
            doc.category,
            path_after_category(doc),
            user.name if user else None,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 12, 18, 30, 22, 16, 16, 45, 12], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = (
        build_export_filename(label) if label
        else build_export_filename("TDB 반출이력", "미입고 현황")
    )

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반출 이력", document_id=None,
        detail={"kind": "미입고현황", "count": len(rows)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


def compute_for_import_rows(
    db: Session,
    vendor: str,
    project_id: Optional[int],
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
) -> list[dict]:
    """자료검색(반입 대상) 목록 계산 — JSON 조회·엑셀 내보내기 공용.

    상태: INCOMPLETE(반입미완료) / REVIEWING(검수대기) / DONE(반입완료).
    """
    query = db.query(Distribution, Document).join(
        Document, Distribution.document_id == Document.id
    ).filter(
        Distribution.purpose == "MODIFY",
        Distribution.vendor == vendor,
    )
    if project_id:
        query = query.filter(Distribution.project_id == project_id)
    if date_from:
        query = query.filter(Distribution.distributed_at >= date_from)
    if date_to:
        query = query.filter(Distribution.distributed_at <= date_to)
    rows = query.order_by(Distribution.distributed_at.desc()).all()
    exts_by_pair = exts_by_document_rev(db, {(doc.id, dist.rev_at_distribution) for dist, doc in rows})

    result = []
    for dist, doc in rows:
        # 반출 시점에 그 도면이 갖고 있던 파일 확장자 = 반출자료
        exts = exts_by_pair.get((doc.id, dist.rev_at_distribution), set())
        if dist.returned_at is None:
            status = "INCOMPLETE"
        else:
            returned = db.get(File, dist.returned_file_id) if dist.returned_file_id else None
            if returned and returned.review_status == "PENDING_REVIEW":
                status = "REVIEWING"
            else:
                status = "DONE"

        result.append({
            "distribution_id": dist.id,
            "document_id": doc.id,
            "drawing_no": doc.drawing_no,
            "display_name": distribution_display_name(doc, dist),
            "category": doc.category,
            "source_path": doc.source_path,
            "rev_at_distribution": dist.rev_at_distribution,
            "has_dwg": "dwg" in exts,
            "has_xlsx": bool(exts & {"xlsx", "xls"}),
            "has_etc": bool(exts - {"dwg", "xlsx", "xls", "pdf"}),
            "has_pdf": "pdf" in exts,
            "status": status,
        })
    return result


@router.get("/for-import", response_model=list[DistributedForImportItem])
def distributions_for_import(
    vendor: str = Query(...),
    project_id: Optional[int] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    db: Session = Depends(get_db),
):
    """자료검색 팝업: 한 공사·업체가 수정용으로 반출한 도면 목록 + 반입 진행 상태.

    반입미완료만 반입 대상으로 체크할 수 있다(프론트에서 제한). date_from/date_to는 반출일시 기준.
    """
    return [
        DistributedForImportItem(**row)
        for row in compute_for_import_rows(db, vendor, project_id, date_from, date_to)
    ]


STATUS_LABELS = {"INCOMPLETE": "반입미완료", "REVIEWING": "검수대기", "DONE": "반입완료"}


@router.get("/for-import/export")
def export_for_import(
    vendor: str = Query(...),
    project_id: Optional[int] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    status: Optional[str] = Query(None, description="ALL/INCOMPLETE/REVIEWING/DONE"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """자료검색 팝업에 지금 보이는 목록(업체·공사·상태탭·기간) 그대로 xlsx로 내려준다."""
    rows = compute_for_import_rows(db, vendor, project_id, date_from, date_to)
    if status and status != "ALL":
        rows = [r for r in rows if r["status"] == status]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "자료검색"
    ws.append(["No", "자료명", "분류", "경로", "반출Rev", "DWG", "XLSX", "ETC", "PDF", "상태"])
    for i, r in enumerate(rows, start=1):
        ws.append([
            i, r["display_name"], r["category"], r["source_path"], r["rev_at_distribution"],
            "Y" if r["has_dwg"] else "N", "Y" if r["has_xlsx"] else "N",
            "Y" if r["has_etc"] else "N", "Y" if r["has_pdf"] else "N",
            STATUS_LABELS.get(r["status"], r["status"]),
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 26, 16, 55, 9, 7, 7, 7, 7, 11], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 반입·검수", "업체별 반출·반입자료 현황")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반입·검수", document_id=None,
        detail={"kind": "자료검색", "vendor": vendor, "project_id": project_id,
                "status": status, "count": len(rows)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


def compute_distribution_status_map(db: Session, rows: list[tuple[Distribution, Document]]) -> dict[int, Optional[str]]:
    """반출 건 하나하나의 상태를 매긴다: INCOMPLETE(반입미완료)/ISSUE(확인필요)/
    REVIEWING(검수대기)/DONE(반입완료). 참조용이면서 아직 반입 전이면 해당 없음(None)
    — 반입 개념 자체가 적용 안 되므로 필터에서 걸리지 않고 '전체'에서만 보인다.
    """
    returned_ids = [d.returned_file_id for d, _doc in rows if d.returned_file_id]
    review_status_by_file: dict[int, str] = {}
    if returned_ids:
        review_status_by_file = dict(
            db.query(File.id, File.review_status).filter(File.id.in_(returned_ids)).all()
        )

    # 아직 해결 안 된 '확인 필요'(ImportIssue) — (도면, 업체) 조합으로 대응시킨다.
    issue_keys = set(
        db.query(ImportIssue.intended_document_id, ImportIssue.vendor_name)
        .filter(ImportIssue.status == "PENDING", ImportIssue.intended_document_id.isnot(None))
        .all()
    )

    result: dict[int, Optional[str]] = {}
    for dist, doc in rows:
        if dist.returned_at is not None:
            review_status = review_status_by_file.get(dist.returned_file_id)
            result[dist.id] = "REVIEWING" if review_status == "PENDING_REVIEW" else "DONE"
        elif dist.purpose != "MODIFY":
            result[dist.id] = None
        elif (doc.id, dist.vendor) in issue_keys:
            result[dist.id] = "ISSUE"
        else:
            result[dist.id] = "INCOMPLETE"
    return result


def effective_distributed_by(db: Session, user: User, requested: list[int]) -> list[int]:
    """screen.tdb_distributions.viewer.other_user 권한이 없으면, 요청 값과 무관하게
    본인 것만 보이도록 조용히 [본인 id]로 고정한다(에러 대신 "이름만 조회 가능" — CM 확정)."""
    if has_permission(db, user, "screen.tdb_distributions.viewer.other_user"):
        return requested
    return [user.id]


def filtered_distribution_rows(
    db, vendor=None, project=None, purpose=None, date_from=None, date_to=None,
    status=None, q=None, distributed_by=None,
):
    """반출 이력 검색. 화면 조회와 엑셀 내보내기가 같은 결과를 쓰도록 공용화.

    공사는 업체와 마찬가지로 화면에서 "입력 또는 선택"(자동완성) 텍스트라 이름 부분일치로
    찾는다 — 반출 기록을 새로 만들 때(D-21)와 달리 여기는 조회 전용이라 자유 텍스트가 문제없다.
    distributed_by: 반출자(반출을 실행한 사용자) id 목록. 비어 있으면(= "전체") 필터 없음.
    """
    query = (
        db.query(Distribution, Document, Project)
        .join(Document, Distribution.document_id == Document.id)
        .outerjoin(Project, Distribution.project_id == Project.id)
    )

    # 공사·업체는 "수정용" 반출에만 의미가 있다(참조용·기타는 특정 공사·업체 없이도 반출된다).
    # 목적을 참조용/기타로 딱 집어 골랐으면 공사·업체 조건은 아예 무시하고,
    # 목적을 "전체"로 두고 공사·업체만 입력했다면 수정용 건만 그 조건으로 거르고
    # 참조용·기타 건은 공사·업체와 무관하게(기간 등 나머지 조건만 적용해) 그대로 포함한다.
    vendor_project_filters = []
    if vendor:
        vendor_project_filters.append(Distribution.vendor.ilike(f"%{vendor}%"))
    if project:
        vendor_project_filters.append(Project.name.ilike(f"%{project}%"))

    if purpose:
        query = query.filter(Distribution.purpose == purpose)
        if purpose == "MODIFY" and vendor_project_filters:
            query = query.filter(*vendor_project_filters)
    elif vendor_project_filters:
        query = query.filter(
            or_(Distribution.purpose != "MODIFY", and_(Distribution.purpose == "MODIFY", *vendor_project_filters))
        )

    if date_from:
        query = query.filter(Distribution.distributed_at >= date_from)
    if date_to:
        query = query.filter(Distribution.distributed_at <= date_to)
    if q:
        # 화면 자료명(꼬리 붙은 이름)을 붙여 넣어도 찾히게 꼬리를 떼고 찾는다(DB엔 꼬리가 없다)
        like = f"%{strip_rev_tail(q)}%"
        query = query.filter(
            or_(Document.drawing_no.ilike(like), Document.title.ilike(like))
        )
    if distributed_by:
        query = query.filter(Distribution.distributed_by.in_(distributed_by))
    rows = query.order_by(Distribution.distributed_at.desc()).all()

    if status and status != "ALL":
        status_map = compute_distribution_status_map(db, [(d, doc) for d, doc, _p in rows])
        rows = [(d, doc, p) for d, doc, p in rows if status_map.get(d.id) == status]
    return rows


# Zip 모드 상태 코드(반출/반입미완료) — 자료 모드의 세부 상태(검수대기 등)와 다르게 딱 둘뿐.
ZIP_STATUS_SHIPPED = "SHIPPED"        # 반출 (그 Zip의 수정용 자료가 전부 반입됨, 또는 반입 대상 아님)
ZIP_STATUS_INCOMPLETE = "INCOMPLETE"  # 반입미완료 (수정용 자료 중 아직 안 돌아온 게 하나라도 있음)
ZIP_STATUS_LABELS = {ZIP_STATUS_SHIPPED: "반출", ZIP_STATUS_INCOMPLETE: "반입미완료"}


def zip_groups(
    db, vendor=None, project=None, purpose=None, date_from=None, date_to=None, q=None, status=None,
    distributed_by=None,
):
    """반출이력 "Zip" 모드: zip_filename별로 묶어 (대표 dist, project, 상태코드)를 만든다.

    Zip 하나는 반출하기 한 번이라 그 안의 모든 자료가 vendor/project/purpose/반출자가 같다.
    그래서 공사·업체·목적·기간을 '있는 그대로 엄격하게' 건다 — 자료 모드처럼
    참조용·기타를 공사·업체와 무관하게 포함시키는 예외는 두지 않는다(CM 확정, Zip은 엄격).
    상태: 그 Zip 안 수정용 자료 중 아직 반납 안 된 게 하나라도 있으면 반입미완료, 아니면 반출.
    distributed_by: 반출자(반출을 실행한 사용자) id 목록. 비어 있으면(= "전체") 필터 없음.
    """
    query = (
        db.query(Distribution, Project)
        .outerjoin(Project, Distribution.project_id == Project.id)
        .filter(Distribution.zip_filename.isnot(None))
    )
    if vendor:
        query = query.filter(Distribution.vendor.ilike(f"%{vendor}%"))
    if project:
        query = query.filter(Project.name.ilike(f"%{project}%"))
    if purpose:
        query = query.filter(Distribution.purpose == purpose)
    if date_from:
        query = query.filter(Distribution.distributed_at >= date_from)
    if date_to:
        query = query.filter(Distribution.distributed_at <= date_to)
    if q:
        query = query.filter(Distribution.zip_filename.ilike(f"%{q}%"))
    if distributed_by:
        query = query.filter(Distribution.distributed_by.in_(distributed_by))

    rows = query.order_by(Distribution.distributed_at.desc()).all()

    # 같은 Zip은 vendor/project/purpose가 동일해 필터에 걸리면 그 Zip 행이 전부 함께 나온다.
    # 따라서 여기 나온 행들만으로 각 Zip의 상태를 정확히 계산할 수 있다.
    incomplete_zips = {
        dist.zip_filename
        for dist, _proj in rows
        if dist.purpose == "MODIFY" and dist.returned_at is None
    }

    reps = {}
    order = []
    for dist, proj in rows:
        if dist.zip_filename not in reps:
            reps[dist.zip_filename] = (dist, proj)
            order.append(dist.zip_filename)

    result = []
    for name in order:
        dist, proj = reps[name]
        code = ZIP_STATUS_INCOMPLETE if name in incomplete_zips else ZIP_STATUS_SHIPPED
        if status and status != "ALL" and code != status:
            continue
        result.append((dist, proj, code))
    return result


def user_names_by_id(db: Session, ids) -> dict[int, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return dict(db.query(User.id, User.name).filter(User.id.in_(ids)).all())


@router.get("/zip-exports", response_model=list[DistributionZipListItem])
def list_zip_exports(
    vendor: Optional[str] = None,
    project: Optional[str] = None,
    purpose: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    status: Optional[str] = None,  # SHIPPED / INCOMPLETE
    q: Optional[str] = None,
    distributed_by: list[int] = Query([]),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    distributed_by = effective_distributed_by(db, user, distributed_by)
    groups = zip_groups(db, vendor, project, purpose, date_from, date_to, q, status, distributed_by)
    names_by_id = user_names_by_id(db, [dist.distributed_by for dist, _proj, _code in groups])
    return [
        DistributionZipListItem(
            zip_filename=dist.zip_filename,
            vendor=dist.vendor,
            project_name=proj.name if proj else None,
            purpose=dist.purpose,
            purpose_note=dist.purpose_note,
            distributed_at=dist.distributed_at,
            distributed_by=dist.distributed_by,
            distributed_by_name=names_by_id.get(dist.distributed_by),
            status=code,
        )
        for dist, proj, code in groups
    ]


@router.get("/zip-exports/export")
def export_zip_exports(
    vendor: Optional[str] = None,
    project: Optional[str] = None,
    purpose: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    distributed_by: list[int] = Query([]),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """반출이력 "Zip" 모드에서 지금 보이는 목록을 그대로 엑셀로 내보낸다."""
    distributed_by = effective_distributed_by(db, user, distributed_by)
    groups = zip_groups(db, vendor, project, purpose, date_from, date_to, q, status, distributed_by)
    if not groups:
        raise HTTPException(status_code=404, detail="내보낼 반출 이력이 없습니다")

    # 화면 표(Zip 모드)와 같은 컬럼 구성. Zip 단위라 반출Rev·반입일시는 화면에서도 빈칸이고,
    # "확인"은 버튼 칸이라 엑셀에는 넣지 않는다.
    names_by_id = user_names_by_id(db, [dist.distributed_by for dist, _proj, _code in groups])
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "반출이력(Zip)"
    ws.append(["No", "자료명", "공사", "업체", "목적", "반출일시", "상태", "반출자"])
    for no, (dist, proj, code) in enumerate(groups, start=1):
        ws.append([
            no,
            dist.zip_filename,
            proj.name if proj else None,
            "" if dist.vendor == "해당없음" else dist.vendor,
            PURPOSE_LABELS.get(dist.purpose, dist.purpose),
            dist.distributed_at.strftime("%Y-%m-%d %H:%M") if dist.distributed_at else None,
            ZIP_STATUS_LABELS.get(code, code),
            names_by_id.get(dist.distributed_by),
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 34, 18, 14, 10, 18, 12, 12], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 반출이력", "Zip")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반출 이력", document_id=None,
        detail={"kind": "반출이력_Zip", "count": len(groups),
                "filters": {"vendor": vendor, "project": project, "purpose": purpose,
                            "status": status, "q": q}},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# 자료별 상태 라벨(현황 팝업/엑셀 공용) — 자료 모드 상태맵 코드와 같은 체계.
MATERIAL_STATUS_LABELS = {
    "INCOMPLETE": "반입미완료", "ISSUE": "확인필요",
    "REVIEWING": "검수대기", "DONE": "반입완료",
}


def zip_material_rows(db, zip_filename: str) -> list[tuple]:
    rows = (
        db.query(Distribution, Document)
        .join(Document, Distribution.document_id == Document.id)
        .filter(Distribution.zip_filename == zip_filename)
        .order_by(Distribution.id.asc())
        .all()
    )
    return rows


@router.get("/zip-status", response_model=list[ZipMaterialItem])
def zip_status(zip_filename: str = Query(...), db: Session = Depends(get_db)):
    """Zip 현황 팝업: 그 Zip에 담겼던 자료 하나하나가 지금 어떤 상태인지 보여준다."""
    rows = zip_material_rows(db, zip_filename)
    if not rows:
        raise HTTPException(status_code=404, detail="해당 Zip 파일을 찾을 수 없습니다")
    status_map = compute_distribution_status_map(db, [(d, doc) for d, doc in rows])
    return [
        ZipMaterialItem(
            distribution_id=d.id,
            document_id=doc.id,
            drawing_no=doc.drawing_no,
            display_name=distribution_display_name(doc, d),
            rev_at_distribution=d.rev_at_distribution,
            purpose=d.purpose,
            status=status_map.get(d.id),
            distributed_at=d.distributed_at,
            returned_at=d.returned_at,
        )
        for d, doc in rows
    ]


@router.get("/zip-status/export")
def export_zip_status(
    zip_filename: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """Zip 현황 팝업에 보이는 자료별 상태를 그대로 엑셀로 내려준다."""
    rows = zip_material_rows(db, zip_filename)
    if not rows:
        raise HTTPException(status_code=404, detail="해당 Zip 파일을 찾을 수 없습니다")
    status_map = compute_distribution_status_map(db, [(d, doc) for d, doc in rows])

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Zip 현황"
    ws.append(["No", "자료명", "반출Rev", "목적", "상태", "반출일시", "반입일시"])
    for no, (d, doc) in enumerate(rows, start=1):
        code = status_map.get(d.id)
        ws.append([
            no, distribution_display_name(doc, d), d.rev_at_distribution,
            PURPOSE_LABELS.get(d.purpose, d.purpose),
            MATERIAL_STATUS_LABELS.get(code, "반입대상 아님"),
            d.distributed_at.strftime("%Y-%m-%d %H:%M") if d.distributed_at else None,
            d.returned_at.strftime("%Y-%m-%d %H:%M") if d.returned_at else None,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 26, 9, 10, 12, 18, 18], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 반출이력", "세부 현황")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반출 이력", document_id=None,
        detail={"kind": "Zip현황", "zip_filename": zip_filename, "count": len(rows)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.post("/zip-return")
def zip_return(
    body: ZipReturnRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    """Zip 단위 '수정 없이 반납 처리'.

    그 Zip 안에 이미 반납된(검수대기·반입완료) 자료가 하나라도 있으면 섞인 상태이므로
    전체를 처리하지 않고 사유를 돌려준다(CM 확정). 하나도 반납 안 됐을 때만 수정용 자료를
    한꺼번에 '수정 없이 반납'으로 처리한다.

    반출했던 사용자 본인이거나 관리자만 처리할 수 있다.
    """
    rows = zip_material_rows(db, body.zip_filename)
    if not rows:
        raise HTTPException(status_code=404, detail="해당 Zip 파일을 찾을 수 없습니다")

    modify = [(d, doc) for d, doc in rows if d.purpose == "MODIFY"]
    if not modify:
        raise HTTPException(status_code=400, detail="이 Zip에는 반입 대상(수정용) 자료가 없습니다.")

    can_return_others = has_permission(db, user, "screen.tdb_distributions.confirm.manual_return")
    if not can_return_others and any(d.distributed_by != user.id for d, _doc in modify):
        raise HTTPException(status_code=403, detail="본인이 반출한 건만 처리할 수 있습니다")

    status_map = compute_distribution_status_map(db, modify)
    already = [(d, doc) for d, doc in modify if d.returned_at is not None]
    if already:
        names = ", ".join(
            f"{distribution_display_name(doc, d)}({MATERIAL_STATUS_LABELS.get(status_map.get(d.id), '반입완료')})"
            for d, doc in already
        )
        raise HTTPException(
            status_code=409,
            detail=(
                "이 Zip에는 이미 반입 처리된 자료가 있어 '수정 없이 반납 처리'를 할 수 없습니다.\n"
                f"먼저 처리된 자료: {names}"
            ),
        )

    now = datetime.now(timezone.utc)
    for d, doc in modify:
        d.returned_at = now
        d.return_note = "수정 없이 반입 처리(Zip 일괄)"
        db.add(AuditLog(
            user_id=user.id, action="RETURN", screen="반출 이력",
            document_id=doc.id,
            detail={"distribution_id": d.id, "zip_filename": body.zip_filename,
                    "return_note": d.return_note},
        ))

    # 문서 상태 복귀: 이 Zip 처리 후에도 남은 미반납 수정용이 없으면 CHECKED_OUT→ACTIVE.
    for doc_id in {doc.id for _d, doc in modify}:
        remaining = (
            db.query(Distribution)
            .filter(
                Distribution.document_id == doc_id,
                Distribution.purpose == "MODIFY",
                Distribution.returned_at.is_(None),
            )
            .first()
        )
        if remaining is None:
            doc = db.get(Document, doc_id)
            if doc and doc.status == "CHECKED_OUT":
                doc.status = "ACTIVE"

    db.commit()
    return {"status": "ok", "returned_count": len(modify)}


@router.get("/filter-options", response_model=list[DistributionFilterOption])
def distribution_filter_options(db: Session = Depends(get_db)):
    """반출이력 검색의 공사·업체 연동 드롭다운 재료.

    실제 수정용 반출 기록에 쓰인 (공사, 업체) 조합만 준다. 참조용·기타는 업체가
    '해당없음'이라 여기 들어가지 않는다(그건 목적 드롭다운으로 찾는다).
    """
    rows = (
        db.query(Distribution.project_id, Project.name, Distribution.vendor)
        .outerjoin(Project, Distribution.project_id == Project.id)
        .filter(Distribution.purpose == "MODIFY")
        .distinct()
        .all()
    )
    seen = set()
    out = []
    for project_id, project_name, vendor in rows:
        key = (project_id, vendor)
        if key in seen:
            continue
        seen.add(key)
        out.append(DistributionFilterOption(
            project_id=project_id, project_name=project_name, vendor=vendor,
        ))
    out.sort(key=lambda o: ((o.project_name or ""), o.vendor))
    return out


@router.get("/export")
def export_distributions(
    vendor: Optional[str] = None,
    project: Optional[str] = None,
    purpose: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    distributed_by: list[int] = Query([]),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """반출 이력(자료 모드) 검색 결과를 화면 표와 같은 컬럼 구성으로 내보낸다.

    맨 끝 "문서ID" 열은 화면에는 없지만 반드시 남겨둔다 — 이 파일을 그대로 '대량 반입'에
    넣으면 그 열(과 "업체")로 어느 도면 건인지 자동 매칭하기 때문(imports.parse_manifest_rows는
    열 위치가 아니라 열 이름으로 찾으므로 순서가 바뀌어도 안전하다).
    """
    distributed_by = effective_distributed_by(db, user, distributed_by)
    rows = filtered_distribution_rows(
        db, vendor, project, purpose, date_from, date_to, status, q, distributed_by
    )
    if not rows:
        raise HTTPException(status_code=404, detail="내보낼 반출 이력이 없습니다")

    status_map = compute_distribution_status_map(db, [(d, doc) for d, doc, _p in rows])
    names_by_id = user_names_by_id(db, [d.distributed_by for d, _doc, _p in rows])

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "반출이력"
    ws.append([
        "No", "자료명", "공사", "업체", "목적", "반출Rev", "반출일시", "반입일시",
        "상태", "반출자", "비고", "문서ID",
    ])
    for i, (dist, doc, proj) in enumerate(rows, start=1):
        code = status_map.get(dist.id)
        ws.append([
            i,
            distribution_display_name(doc, dist),
            proj.name if proj else None,
            "" if dist.vendor == "해당없음" else dist.vendor,
            PURPOSE_LABELS.get(dist.purpose, dist.purpose),
            dist.rev_at_distribution,
            dist.distributed_at.strftime("%Y-%m-%d %H:%M") if dist.distributed_at else None,
            dist.returned_at.strftime("%Y-%m-%d %H:%M") if dist.returned_at else None,
            MATERIAL_STATUS_LABELS.get(code, "반입대상 아님"),
            names_by_id.get(dist.distributed_by),
            dist.return_note,
            doc.id,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 26, 18, 14, 9, 9, 17, 17, 12, 12, 30, 9], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)

    filename = build_export_filename("TDB 반출이력")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반출 이력", document_id=None,
        detail={"kind": "반출이력", "count": len(rows),
                "filters": {"vendor": vendor, "project": project,
                            "purpose": purpose, "status": status, "q": q,
                            "distributed_by": distributed_by}},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.get("", response_model=list[DistributionListItem])
def list_distributions(
    vendor: Optional[str] = None,
    project: Optional[str] = None,
    purpose: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    status: Optional[str] = None,  # ALL/INCOMPLETE/ISSUE/REVIEWING/DONE
    q: Optional[str] = None,
    distributed_by: list[int] = Query([]),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    distributed_by = effective_distributed_by(db, user, distributed_by)
    rows = filtered_distribution_rows(
        db, vendor, project, purpose, date_from, date_to, status, q, distributed_by
    )
    status_map = compute_distribution_status_map(db, [(d, doc) for d, doc, _p in rows])

    # 자료명 옆 돋보기 미리보기용 — TDB 조회와 같은 규칙으로 항상 "현재 리비전"의 PDF만 연결한다.
    doc_ids = list({doc.id for _d, doc, _p in rows})
    pdf_file_id_by_doc: dict[int, int] = dict(
        db.query(File.document_id, File.id)
        .filter(File.document_id.in_(doc_ids), File.is_current.is_(True), File.file_ext == "pdf")
        .all()
        if doc_ids else []
    )
    names_by_id = user_names_by_id(db, [dist.distributed_by for dist, _doc, _p in rows])

    return [
        DistributionListItem(
            id=dist.id,
            document_id=doc.id,
            drawing_no=doc.drawing_no,
            display_name=distribution_display_name(doc, dist),
            area=doc.area,
            source_path=doc.source_path,
            current_pdf_file_id=pdf_file_id_by_doc.get(doc.id),
            vendor=dist.vendor,
            project_name=proj.name if proj else None,
            purpose=dist.purpose,
            purpose_note=dist.purpose_note,
            rev_at_distribution=dist.rev_at_distribution,
            distributed_at=dist.distributed_at,
            distributed_by=dist.distributed_by,
            distributed_by_name=names_by_id.get(dist.distributed_by),
            returned_at=dist.returned_at,
            return_note=dist.return_note,
            status=status_map.get(dist.id),
        )
        for dist, doc, proj in rows
    ]


@router.post("/{distribution_id}/return")
def return_distribution(
    distribution_id: int,
    body: ReturnRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    dist = db.get(Distribution, distribution_id)
    if dist is None:
        raise HTTPException(status_code=404, detail="반출 기록을 찾을 수 없습니다")
    if dist.returned_at is not None:
        raise HTTPException(status_code=400, detail="이미 반입 처리된 건입니다")
    # 반출했던 사용자 본인이거나, screen.tdb_distributions.confirm.manual_return 권한이
    # 있어야 처리할 수 있다(role=ADMIN은 has_permission이 자동으로 통과시킴).
    if not has_permission(db, user, "screen.tdb_distributions.confirm.manual_return") and dist.distributed_by != user.id:
        raise HTTPException(status_code=403, detail="본인이 반출한 건만 처리할 수 있습니다")

    dist.returned_at = datetime.now(timezone.utc)
    dist.return_note = body.return_note or "수정 없이 반입 처리"

    remaining = (
        db.query(Distribution)
        .filter(
            Distribution.document_id == dist.document_id,
            Distribution.purpose == "MODIFY",
            Distribution.returned_at.is_(None),
            Distribution.id != dist.id,
        )
        .first()
    )
    if remaining is None:
        doc = db.get(Document, dist.document_id)
        if doc.status == "CHECKED_OUT":
            doc.status = "ACTIVE"

    db.add(AuditLog(
        user_id=user.id,
        action="RETURN",
        screen="반출 이력",
        document_id=dist.document_id,
        detail={"distribution_id": dist.id, "return_note": dist.return_note},
    ))
    db.commit()
    return {"status": "ok"}


@router.post("/{distribution_id}/note")
def update_distribution_note(
    distribution_id: int,
    body: UpdateNoteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """반출 이력의 비고를 자유롭게 적어둔다 (반입 처리와 무관 — 그냥 메모).

    실수로 잘못 입력해도 언제든 다시 고쳐 쓸 수 있다. 조회는 누구나 가능하지만 작성(수정)은
    권한(공통 > 비고 작성 > 반출 이력 비고 작성)이 있어야만 한다(2026-08-17 CM 확정).
    """
    if not has_permission(db, user, "common.note_edit.distribution"):
        raise HTTPException(status_code=403, detail="이 기능을 사용할 권한이 없습니다")

    dist = db.get(Distribution, distribution_id)
    if dist is None:
        raise HTTPException(status_code=404, detail="반출 기록을 찾을 수 없습니다")

    dist.return_note = body.note
    db.add(AuditLog(
        user_id=user.id,
        action="UPDATE_NOTE",
        screen="도면 목록",
        document_id=dist.document_id,
        detail={"distribution_id": dist.id, "note": body.note},
    ))
    db.commit()
    return {"status": "ok", "note": dist.return_note}
