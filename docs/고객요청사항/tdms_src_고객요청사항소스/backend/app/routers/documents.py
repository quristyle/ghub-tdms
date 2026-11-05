from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_db
from app.models import AuditLog, Document, File, FolderPlaceholder, Project, Distribution, User
from app.schemas import (
    DistributionHistoryItem,
    DocumentDetail,
    DocumentListItem,
    DocumentListResponse,
    DocumentNavItem,
    FileHistoryItem,
    FolderItem,
    RecentChangeItem,
    RecentChangesResponse,
    RecentChangesSummary,
    RevisionSetItem,
)
from app.rev_folders import outdated_rev_folders
from app.rev_naming import distribution_display_name, document_display_name, strip_rev_tail
from app.revision_sets import group_revision_sets, set_name, set_note, set_originals, set_pdf
from app.utils import build_export_filename, content_disposition_header, neutralize_formulas, sanitize_path_component

router = APIRouter(prefix="/documents", tags=["documents"])


# ---- "최근 수정" 기준일 (2026-08-14 CM 확정) --------------------------------
# 이 두 숫자 하나만 바꾸면 목록의 날짜 색·수정일 드롭다운·[최근수정본] 버튼이 전부 같이 바뀐다.
#   RECENT_STRONG_DAYS : 이 안에 수정됐으면 "진한 색" (오늘~30일)
#   RECENT_SOFT_DAYS   : 여기까지가 "연한 색" (31일~90일). 이걸 넘으면 색 없음.
RECENT_STRONG_DAYS = 30
RECENT_SOFT_DAYS = 90

# ---- "등록"도 수정으로 볼 것인가 (2026-08-14 CM 확정) ------------------------
# 이 날짜 **이후**에 새로 등록된 자료는 등록 그 자체를 수정으로 본다(새로 들어온 자료도
# 사용자 눈에 띄어야 하므로). 이 날짜 이전부터 이미 들어와 있던 자료(초기 일괄적재 10,827건
# 등)는 예전 규칙 그대로 — 실제로 손댄 적이 있을 때(updated_at > created_at)만 수정으로 본다.
# 그렇게 안 하면 이미 등록돼 있는 만 건이 통째로 "최근 수정" 색으로 물들어 표시가 무의미해진다.
REGISTRATION_COUNTS_FROM = datetime(2026, 8, 14, tzinfo=timezone.utc)


def days_ago(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def is_modified_condition():
    """"수정된 자료"로 볼 것인가 (목록의 최종수정 색·수정일 필터·최근수정본 팝업 공통 기준).

    ① 등록된 뒤로 실제로 무언가 바뀐 것(updated_at이 created_at보다 뒤), 또는
    ② REGISTRATION_COUNTS_FROM 이후에 새로 등록된 것(등록 자체를 수정으로 봄).
    """
    return or_(
        Document.updated_at > Document.created_at,
        Document.created_at >= REGISTRATION_COUNTS_FROM,
    )


def is_modified_value(doc: Document) -> bool:
    """is_modified_condition()의 파이썬 판(이미 읽어온 행 하나를 판단할 때). 조건이 어긋나면
    화면 색과 필터 결과가 서로 안 맞으므로 두 곳을 항상 같이 고친다."""
    if not doc.created_at:
        return False
    return bool(
        (doc.updated_at and doc.updated_at > doc.created_at)
        or doc.created_at >= REGISTRATION_COUNTS_FROM
    )


def modified_scope_condition(scopes: list[str]):
    """수정일 드롭다운(오늘~30일 / 31일~90일 / 91일 이전) 필터 조건.

    세 구간은 겹치지 않고, 셋을 다 고르면 전체와 같아진다. 목록의 날짜 색 두 단계와도
    정확히 같은 구간을 쓴다(진한 색 = 오늘~30일, 연한 색 = 31일~90일, 색 없음 = 91일 이전).
    반환값이 None이면 필터를 안 거는 것(전체).
    """
    if not scopes or "ALL" in scopes:
        return None

    strong_cut = days_ago(RECENT_STRONG_DAYS)
    soft_cut = days_ago(RECENT_SOFT_DAYS)
    modified = is_modified_condition()

    conditions = []
    if "D30" in scopes:
        conditions.append(and_(modified, Document.updated_at >= strong_cut))
    if "D31_90" in scopes:
        conditions.append(and_(
            modified, Document.updated_at >= soft_cut, Document.updated_at < strong_cut
        ))
    if "D91" in scopes:
        # 91일 이전 = 90일보다 오래전에 수정됐거나, 등록 후 한 번도 수정된 적 없는 것
        conditions.append(or_(~modified, Document.updated_at < soft_cut))
    if not conditions:
        return None
    return or_(*conditions)


def has_non_pdf_current(document_id_col):
    """이 문서의 현재 리비전 파일 중 pdf가 아닌 게 하나라도 있는지(= 원본류 보유).

    has_dwg 컬럼만으로는 xlsx/doc 등 dwg가 아닌 원본을 놓치므로 파일 테이블을 직접 본다.
    """
    return (
        select(File.id)
        .where(File.document_id == document_id_col, File.is_current.is_(True), File.file_ext != "pdf")
        .exists()
    )


def isometric_condition(iso):
    """Isometric 드롭다운(다중선택: ALL/PROCESS/STEAM)에 따른 필터 조건을 만든다.

    체크 안 함(빈 목록) = 기존 "Isometric 포함" 미체크와 동일하게 isometric 전부 제외.
    ALL = isometric도 전부 포함해서 보여준다(제외 없음, 필터 안 걸음).
    PROCESS = isometric이면서 폴더 경로에 "Steam Tracing"이 없는 것.
    STEAM = isometric이면서 폴더 경로에 "Steam Tracing"이 있는 것.
    여러 개 고르면 OR로 합쳐진다(항상 isometric 아닌 문서는 그대로 다 보인다 — "포함" 토글이므로).
    반환값이 None이면 필터를 안 거는 것(ALL이 섞여 있을 때).
    """
    if not iso:
        return Document.is_isometric.is_(False)
    if "ALL" in iso:
        return None

    conditions = [Document.is_isometric.is_(False)]
    if "PROCESS" in iso:
        conditions.append(and_(
            Document.is_isometric.is_(True),
            ~Document.source_path.ilike("%Steam Tracing%"),
        ))
    if "STEAM" in iso:
        conditions.append(and_(
            Document.is_isometric.is_(True),
            Document.source_path.ilike("%Steam Tracing%"),
        ))
    return or_(*conditions)


def real_folder_expr():
    """파일이 실제로 놓여 있는 폴더 경로 — 자료 폴더(source_path) 밑에 숨어 있는 DWG·PDF 폴더
    (files.pairing_folder)까지 한 단계 더 들어간 경로다. TDB 관리 화면의 "숨김 폴더 보기"에서만 쓴다."""
    return case(
        (File.pairing_folder.is_(None), Document.source_path),
        else_=Document.source_path + "\\" + File.pairing_folder,
    )


def real_path_condition(path: str, recursive: bool):
    """"숨김 폴더 보기"용 폴더 필터 — 자료가 어느 폴더 소속인지가 아니라, 그 자료의 현재 파일이
    실제로 어느 폴더에 들어 있는지로 거른다. 원본이 DWG 폴더, 사본이 PDF 폴더로 나뉘어 있으면
    같은 자료가 두 폴더 모두에서 보인다(폴더별로 한 번씩)."""
    expr = real_folder_expr()
    if recursive:
        escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        match = expr.like(f"{escaped}%", escape="\\")
    else:
        match = expr == path
    return (
        select(File.id)
        .where(File.document_id == Document.id, File.is_current.is_(True), match)
        .exists()
    )


def apply_filters(query, q=None, iso=None, path=None,
                  kind_scope="FILE", status=None, holding=None, recursive=True,
                  modified=None, real_path=False):
    """목록 검색 조건.

    폴더 계층은 좌측 폴더 트리(path)가 담당하고, 여기는 검색어(q)와 성격 조건만 다룬다.
      kind_scope : 검색어(q)를 어디서 찾을지 — FILE(자료명: 도면번호·제목),
                   FOLDER(폴더명: source_path 전체 경로 중 어느 단계든 일치하면 매칭), BOTH(둘 다)
      status     : ACTIVE(정상) / CHECKED_OUT(반출) / REVIEW(검수 대기 중)
      holding    : BOTH(원본·사본 둘 다 있음) / ORIGINAL_ONLY(원본만, 사본 없음) /
                   COPY_ONLY(사본만, 원본 없음). 비우면 전체.
      recursive  : 폴더 선택(path) 시 하위 폴더까지 포함할지. false면 그 폴더에 바로 담긴 것만.
      iso        : Isometric 드롭다운 다중선택값 목록(ALL/PROCESS/STEAM). 위 isometric_condition 참고.
      modified   : 수정일 드롭다운 다중선택값 목록(ALL/D30/D31_90/D91). 위 modified_scope_condition 참고.
      real_path  : TDB 관리 "숨김 폴더 보기" 전용. 폴더(path)를 자료 소속이 아니라 파일이 실제로
                   놓인 자리로 해석한다. 위 real_path_condition 참고.
    """
    # 폴더·자료 편집(기존 수정) 화면에서 보관함으로 옮긴 자료는 다른 모든 화면에서 보이지 않는다.
    query = query.filter(Document.is_archived.is_(False))

    iso_cond = isometric_condition(iso)
    if iso_cond is not None:
        query = query.filter(iso_cond)

    modified_cond = modified_scope_condition(modified or [])
    if modified_cond is not None:
        query = query.filter(modified_cond)

    if q:
        like = f"%{q}%"
        # 화면 자료명(꼬리 붙은 이름)을 그대로 붙여 넣어도 찾히게 꼬리를 떼고 찾는다(DB엔 꼬리가 없다)
        name_like = f"%{strip_rev_tail(q)}%"
        file_match = or_(Document.drawing_no.ilike(name_like), Document.title.ilike(name_like))
        # 폴더명 검색은 그 자료가 바로 담긴 폴더만이 아니라, 경로 어느 단계에 그 이름이
        # 있어도 매칭한다 — 예를 들어 "Calculation"으로 검색하면 "4. CALCULATION SHEETS"
        # 밑에 몇 단계 더 들어간 자료까지 전부 걸린다(안 그러면 최하위 폴더 이름에만 그
        # 글자가 있어야 해서, 상위 폴더로 찾을 때 결과가 크게 줄어 보인다).
        folder_match = Document.source_path.ilike(like)
        if real_path:
            # "숨김 폴더 보기"에서는 DWG·PDF 폴더도 화면에 보이는 폴더이므로 폴더명 검색에 걸려야 한다
            folder_match = or_(folder_match, select(File.id).where(
                File.document_id == Document.id,
                File.is_current.is_(True),
                File.pairing_folder.ilike(like),
            ).exists())
        if kind_scope == "FOLDER":
            query = query.filter(folder_match)
        elif kind_scope == "BOTH":
            query = query.filter(or_(file_match, folder_match))
        else:  # FILE
            query = query.filter(file_match)

    if status == "REVIEW":
        # 검수 = 아직 승인 안 된 리비전이 올라와 있는 문서
        query = query.filter(
            Document.id.in_(
                select(File.document_id).where(File.review_status == "PENDING_REVIEW")
            )
        )
    elif status == "CHECKED_OUT":
        # 통합필요(MERGE_REQUIRED)도 화면엔 "반출"로 보이므로, "반출"로 검색하면 같이 걸려야 한다.
        query = query.filter(Document.status.in_(["CHECKED_OUT", "MERGE_REQUIRED"]))
    elif status:
        query = query.filter(Document.status == status)

    if holding == "BOTH":
        # 원본(dwg/엑셀/기타, pdf 제외)과 사본(pdf) 둘 다 있는 것
        query = query.filter(
            or_(Document.has_dwg.is_(True), has_non_pdf_current(Document.id)),
            Document.has_pdf.is_(True),
        )
    elif holding == "ORIGINAL_ONLY":
        # 원본(dwg/엑셀/기타, pdf 제외)은 있고 사본(pdf)은 없는 것
        query = query.filter(
            or_(Document.has_dwg.is_(True), has_non_pdf_current(Document.id)),
            Document.has_pdf.is_(False),
        )
    elif holding == "COPY_ONLY":
        # 사본(pdf)만 있고 원본은 없는 것
        query = query.filter(
            Document.has_pdf.is_(True),
            Document.has_dwg.is_(False),
            ~has_non_pdf_current(Document.id),
        )

    if path:
        if real_path:
            query = query.filter(real_path_condition(path, recursive))
        elif recursive:
            # 해당 폴더와 그 하위 전부. LIKE 특수문자는 이스케이프.
            escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            query = query.filter(Document.source_path.like(f"{escaped}%", escape="\\"))
        else:
            # 그 폴더에 바로 담긴 것만(하위 폴더 제외).
            query = query.filter(Document.source_path == path)
    return query


STATUS_LABEL = {
    "ACTIVE": "정상",
    "CHECKED_OUT": "반출",
    "MERGE_REQUIRED": "반출",  # 통합필요도 반출의 일부라 목록 화면·엑셀은 구분하지 않는다
    "PENDING": "대기",
    "SUPERSEDED": "구본",
}


def path_after_category(item) -> str:
    """"경로" 열: 목록 화면과 동일하게, 분류(대분류) 다음부터 시작하는 하위 폴더 경로만 보여준다."""
    rest = item.source_path or ""
    if item.category and rest.startswith(item.category):
        rest = rest[len(item.category):].lstrip("\\")
    return rest.replace("\\", " / ")


def format_rev_label(rev: int, branch: Optional[str]) -> str:
    return f"{rev}-{branch}" if branch else str(rev)


def attach_holding_flags(db: Session, docs: list[Document]) -> list[DocumentListItem]:
    """DWG/XLSX/ETC/PDF 보유 표시는 저장 안 해두므로(has_dwg/has_pdf 외엔) 조회 시점에 계산한다."""
    doc_ids = [d.id for d in docs]
    ext_rows = (
        db.query(File.document_id, File.file_ext, File.id)
        .filter(File.document_id.in_(doc_ids), File.is_current.is_(True))
        .all() if doc_ids else []
    )
    xlsx_ids, etc_ids = set(), set()
    pdf_file_id_by_doc: dict[int, int] = {}
    for doc_id, ext, file_id in ext_rows:
        e = (ext or "").lower()
        if e in ("xlsx", "xls"):
            xlsx_ids.add(doc_id)
        elif e == "pdf":
            pdf_file_id_by_doc[doc_id] = file_id
        elif e != "dwg":
            etc_ids.add(doc_id)

    return [
        DocumentListItem(
            id=d.id,
            drawing_no=d.drawing_no,
            display_name=document_display_name(d),
            doc_class=d.doc_class,
            category=d.category,
            source_path=d.source_path,
            is_isometric=d.is_isometric,
            current_rev=d.current_rev,
            status=d.status,
            has_dwg=d.has_dwg,
            has_xlsx=d.id in xlsx_ids,
            has_etc=d.id in etc_ids,
            has_pdf=d.has_pdf,
            current_pdf_file_id=pdf_file_id_by_doc.get(d.id),
            updated_at=d.updated_at,
            is_modified=is_modified_value(d),
        )
        for d in docs
    ]


# ---- 표 헤더 클릭 정렬 (2026-08-14 CM 확정 공통 규칙) -----------------------
# 정렬은 화면에 보이는 50건이 아니라 "조회 결과 전체"를 기준으로 한다. 그래서 화면에서
# 헤더를 누르면 여기로 정렬 조건이 넘어오고, DB가 전체를 정렬한 뒤 그 1페이지를 돌려준다.
# 키 이름은 화면 표의 열 순서(자료명/분류/경로/Rev/상태/DWG/XLSX/ETC/PDF/최종수정)와 같다.
def has_current_ext(*exts):
    """이 문서의 현재 리비전 파일 중 지정한 확장자가 하나라도 있는지."""
    return (
        select(File.id)
        .where(
            File.document_id == Document.id,
            File.is_current.is_(True),
            func.lower(File.file_ext).in_(exts),
        )
        .exists()
    )


def has_current_etc():
    """DWG·PDF·엑셀 어디에도 안 들어가는 나머지 파일(ETC 열)을 가졌는지."""
    return (
        select(File.id)
        .where(
            File.document_id == Document.id,
            File.is_current.is_(True),
            ~func.lower(File.file_ext).in_(["dwg", "pdf", "xlsx", "xls"]),
        )
        .exists()
    )


SORT_COLUMNS = {
    "drawing_no": Document.drawing_no,
    "category": Document.category,
    "path": Document.source_path,
    "rev": Document.current_rev,
    "status": Document.status,
    "dwg": Document.has_dwg,
    "xlsx": has_current_ext("xlsx", "xls"),
    "etc": has_current_etc(),
    "pdf": Document.has_pdf,
    "updated_at": Document.updated_at,
}


def apply_sort(query, sort: Optional[str], direction: str):
    """정렬 조건을 붙인다. sort가 없거나 모르는 값이면 기본 순서(자료명순).

    같은 값이 여러 건일 때 페이지마다 순서가 흔들리지 않도록 항상 id를 마지막 기준으로 둔다.
    """
    column = SORT_COLUMNS.get(sort or "")
    if column is None:
        return query.order_by(Document.drawing_no, Document.id)
    ordered = column.desc() if direction == "desc" else column.asc()
    return query.order_by(ordered, Document.drawing_no, Document.id)


@router.get("", response_model=DocumentListResponse)
def list_documents(
    q: Optional[str] = None,
    iso: list[str] = Query([]),
    path: Optional[str] = None,
    kind_scope: str = "FILE",
    status: Optional[str] = None,
    holding: Optional[str] = None,
    recursive: bool = True,
    modified: list[str] = Query([]),
    real_path: bool = False,
    sort: Optional[str] = None,
    dir: str = "asc",
    ids: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    if ids:
        # 반출대기함(선택 항목) 조회용 — 다른 필터 무시하고 지정된 id들만
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
        docs = db.query(Document).filter(Document.id.in_(id_list)).all()
        docs_by_id = {d.id: d for d in docs}
        ordered = [docs_by_id[i] for i in id_list if i in docs_by_id]
        items = attach_holding_flags(db, ordered)
        return DocumentListResponse(total=len(items), page=1, page_size=len(items) or 1, items=items)

    query = apply_filters(
        db.query(Document), q, iso, path, kind_scope, status, holding, recursive, modified, real_path
    )
    total = query.count()
    docs = (
        apply_sort(query, sort, dir)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = attach_holding_flags(db, docs)
    return DocumentListResponse(total=total, page=page, page_size=page_size, items=items)


@router.get("/nav", response_model=list[DocumentNavItem])
def list_documents_nav(
    q: Optional[str] = None,
    iso: list[str] = Query([]),
    path: Optional[str] = None,
    kind_scope: str = "FILE",
    status: Optional[str] = None,
    holding: Optional[str] = None,
    recursive: bool = True,
    modified: list[str] = Query([]),
    real_path: bool = False,
    sort: Optional[str] = None,
    dir: str = "asc",
    db: Session = Depends(get_db),
):
    """미리보기·상세보기의 "이전/다음 넘겨보기"용. 화면 표는 페이지당 50건씩만 보여주지만,
    넘겨보기는 지금 검색조건에 맞는 전체 자료를 순서대로 오갈 수 있어야 한다. 표에 쓰는 무거운
    필드(상태·Rev·보유여부 등)는 빼고 넘겨보기에 꼭 필요한 값만 돌려줘서, 폴더 전체(몇천 건)를
    열어도 가볍다.

    정렬도 표와 같은 조건을 받는다 — 표를 최종수정 내림차순으로 봐놓고 넘겨보기는 자료명순으로
    움직이면 "다음"이 화면 아래 행이 아닌 엉뚱한 자료로 가버리기 때문.
    """
    query = apply_filters(
        db.query(Document), q, iso, path, kind_scope, status, holding, recursive, modified, real_path
    )
    docs = apply_sort(query, sort, dir).all()

    doc_ids = [d.id for d in docs]
    pdf_rows = (
        db.query(File.document_id, File.id)
        .filter(File.document_id.in_(doc_ids), File.is_current.is_(True), File.file_ext == "pdf")
        .all()
        if doc_ids
        else []
    )
    pdf_file_id_by_doc = dict(pdf_rows)

    return [
        DocumentNavItem(
            id=d.id,
            drawing_no=d.drawing_no,
            display_name=document_display_name(d),
            path=path_after_category(d),
            current_pdf_file_id=pdf_file_id_by_doc.get(d.id),
        )
        for d in docs
    ]


@router.get("/ids-by-path", response_model=list[int])
def ids_by_path(
    path: str,
    iso: list[str] = Query([]),
    recursive: bool = True,
    db: Session = Depends(get_db),
):
    """반출 폴더추가용: 폴더(하위 포함 여부는 recursive 따름)에 속한 문서 id 전부. 페이지 제한 없이 통째로 반환."""
    query = apply_filters(
        db.query(Document.id), iso=iso, path=path, recursive=recursive
    )
    return [doc_id for (doc_id,) in query.all()]


@router.get("/folders", response_model=list[FolderItem])
def list_folders(db: Session = Depends(get_db)):
    """폴더 트리용. 원본 폴더 경로(source_path)별 도면 수. 프론트에서 트리로 조립한다.

    Isometric 토글(원칙 5)과 무관하게 폴더별 건수는 항상 전체(Isometric 포함) 기준으로
    센다 — TDB 관리 화면(editor.py get_tree)의 건수와 일치시키기 위함
    (2026-08-15 CM 확정: "ISO 건수를 포함하는 것으로 통일"). 실제 목록에 뭐가 보이는지는
    Isometric 토글이 별도로 걸러낸다 — 트리 숫자는 "이 폴더 전체 자료 수" 안내용이다.
    """
    query = db.query(Document.source_path, func.count(Document.id)).filter(
        Document.is_archived.is_(False)
    )
    rows = query.group_by(Document.source_path).all()
    counts = {path: count for path, count in rows if path}

    # TDB 관리 화면(D-27)에서 만든 빈 폴더도 여기(TDB 조회)에서 똑같이 보여야 한다.
    # P&ID(5.2, D-9)도 folder_placeholders에 실제 행으로 등록돼 있어(마이그레이션
    # b1c4d7e9f2a3) 이 경로로 함께 걸러진다.
    # 자료가 하나도 없다는 이유로 폴더 자체가 안 보이면 CM이 "폴더가 사라졌다"고 오인한다.
    for (placeholder_path,) in db.query(FolderPlaceholder.path):
        counts.setdefault(placeholder_path, 0)

    return [FolderItem(path=path, doc_count=count) for path, count in counts.items()]


@router.get("/rev-folders")
def list_rev_folders(db: Session = Depends(get_db)):
    """연도별 Rev 폴더 가운데 "최신이 아닌" 폴더 목록 (2026-09-29 CM 지시).

    P&ID·PFD처럼 리비전을 `Rev0 (2012)` 같은 하위 폴더로 나눠 둔 자리에서, 최신 폴더가
    아닌 폴더를 골라 준다(판정 규칙은 app/rev_folders.py 한 곳에만 있다).
    화면(ui.js)이 이 목록을 한 번 받아 두었다가, 자료를 열 때 그 자료가 이 폴더 안에 있으면
    "최신 버전이 아닙니다" 안내창을 띄운다.
    """
    return {"outdated": outdated_rev_folders(db)}


@router.get("/export")
def export_documents(
    q: Optional[str] = None,
    iso: list[str] = Query([]),
    path: Optional[str] = None,
    kind_scope: str = "FILE",
    status: Optional[str] = None,
    holding: Optional[str] = None,
    recursive: bool = True,
    modified: list[str] = Query([]),
    sort: Optional[str] = None,
    dir: str = "asc",
    ids: Optional[str] = None,
    columns: str = "full",  # full(도면 목록 표) / cart(반출대기함 표 — No/자료명/분류/경로만)
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    query = apply_filters(
        db.query(Document), q, iso, path, kind_scope, status, holding, recursive, modified
    )
    # ids가 오면 장바구니에 담은 것만 (D-25의 '현재 결과'를 장바구니로 좁히는 경우)
    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
        query = db.query(Document).filter(Document.id.in_(id_list))
    # 화면에서 헤더를 눌러 정렬해뒀으면 엑셀도 그 순서 그대로 나와야 한다.
    docs = apply_sort(query, sort, dir).all()
    items = attach_holding_flags(db, docs)

    wb = openpyxl.Workbook()
    ws = wb.active

    if columns == "cart":
        # 반출대기함 표(No/자료명/분류/경로)와 동일한 컬럼 구성
        ws.title = "반출대기함"
        ws.append(["No", "자료명", "분류", "경로"])
        for i, item in enumerate(items, start=1):
            ws.append([i, item.display_name, item.category, path_after_category(item)])
        widths = [6, 26, 16, 60]
    else:
        ws.title = "도면목록"
        # 목록 화면 표(No/자료명/분류/경로/Rev/상태/DWG/XLSX/ETC/PDF/최종수정)와 동일한 컬럼 구성
        headers = [
            "No", "자료명", "분류", "경로", "Rev", "상태",
            "DWG", "XLSX", "ETC", "PDF", "최종수정",
        ]
        ws.append(headers)
        for i, item in enumerate(items, start=1):
            ws.append([
                i,
                item.display_name,
                item.category,
                path_after_category(item),
                str(item.current_rev),
                STATUS_LABEL.get(item.status, item.status),
                "Y" if item.has_dwg else "",
                "Y" if item.has_xlsx else "",
                "Y" if item.has_etc else "",
                "Y" if item.has_pdf else "",
                item.updated_at.strftime("%Y-%m-%d %H:%M") if item.updated_at else None,
            ])
        widths = [6, 26, 16, 45, 10, 10, 7, 7, 7, 7, 17]

    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)

    # 파일명 규칙(2026-08-11 CM 확정): 화면이름_표(팝업)제목_날짜시각. 제목 없으면 화면이름_날짜시각.
    filename = (
        build_export_filename("TDB 조회", "반출대기함") if columns == "cart"
        else build_export_filename("TDB 조회")
    )

    db.add(AuditLog(
        user_id=user.id,
        action="EXPORT",
        screen="도면 목록",
        document_id=None,
        detail={
            "count": len(docs),
            "columns": columns,
            "filters": {
                "q": q, "path": path, "kind_scope": kind_scope,
                "status": status, "holding": holding,
                "iso": iso,
                "modified": modified,
                "recursive": recursive,
                "selected_only": bool(ids),
            },
        },
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---- 최근수정본 (상단 [최근수정본] 버튼 → 팝업) ---------------------------------
# 반출이력 화면에서 조건을 걸면 알 수 있는 내용이지만, 일반 사용자는 거기까지 찾아 들어가지
# 않는다. "요즘 뭐가 바뀌었나"를 어느 화면에서든 한 번에 볼 수 있게 따로 뽑아준다.

# 아래 동작들은 자료를 바꾼 게 아니라 보기만 한 기록이라 "누가 수정했나"에서 제외한다.
NON_CHANGE_ACTIONS = ["EXPORT", "DOWNLOAD", "DISTRIBUTE", "LOGIN", "LOGOUT"]


def collect_recent_changes(db: Session, days: int) -> tuple[list[RecentChangeItem], int]:
    """최근 days일 안에 수정된 자료들과, 그중 리비전이 오른 건수를 돌려준다.

    수정 판단은 documents.updated_at 하나로 한다 — 이 값은 자료 편집·리비전 승인처럼 실제로
    무언가 바뀔 때만 갱신되고(반출·다운로드로는 안 움직인다), 목록 화면의 "최종수정" 열에
    보이는 날짜와도 같은 값이라 화면과 팝업이 절대 어긋나지 않는다.
    """
    cutoff = days_ago(days)
    docs = (
        db.query(Document)
        .filter(
            Document.is_archived.is_(False),
            is_modified_condition(),
            Document.updated_at >= cutoff,
        )
        .order_by(Document.updated_at.desc(), Document.id)
        .all()
    )
    doc_ids = [d.id for d in docs]
    if not doc_ids:
        return [], 0

    # 이 기간에 승인된 리비전(rev 1 이상)이 있으면 "내용이 바뀐 것", 없으면 "정보만 수정".
    rev_files = (
        db.query(File)
        .filter(
            File.document_id.in_(doc_ids),
            File.rev >= 1,
            File.review_status == "APPROVED",
            File.uploaded_at >= cutoff,
        )
        .order_by(File.document_id, File.rev.desc(), File.id.desc())
        .all()
    )
    latest_rev_by_doc: dict[int, File] = {}
    for f in rev_files:
        latest_rev_by_doc.setdefault(f.document_id, f)

    project_ids = {f.project_id for f in latest_rev_by_doc.values() if f.project_id}
    projects = (
        {p.id: p.name for p in db.query(Project).filter(Project.id.in_(project_ids)).all()}
        if project_ids else {}
    )

    # 누가 수정했는지는 시스템 로그(audit_log)에서 그 자료의 마지막 기록으로 찾는다.
    # 폴더 이름 바꾸기처럼 여러 자료가 한꺼번에 움직인 작업은 자료별 기록이 남지 않아 빈칸이 된다.
    audit_rows = (
        db.query(AuditLog.document_id, User.name)
        .join(User, AuditLog.user_id == User.id)
        .filter(
            AuditLog.document_id.in_(doc_ids),
            AuditLog.created_at >= cutoff,
            ~AuditLog.action.in_(NON_CHANGE_ACTIONS),
        )
        .order_by(AuditLog.document_id, AuditLog.created_at.desc())
        .all()
    )
    changed_by: dict[int, str] = {}
    for doc_id, name in audit_rows:
        changed_by.setdefault(doc_id, name)

    # 팝업 표의 자료명 옆 돋보기(미리보기)가 열 PDF — 목록 화면과 같은 "현재 리비전 PDF"다.
    pdf_file_id_by_doc = dict(
        db.query(File.document_id, File.id)
        .filter(
            File.document_id.in_(doc_ids),
            File.is_current.is_(True),
            File.file_ext == "pdf",
        )
        .all()
    )

    items = []
    for d in docs:
        rev_file = latest_rev_by_doc.get(d.id)
        items.append(RecentChangeItem(
            document_id=d.id,
            drawing_no=d.drawing_no,
            display_name=document_display_name(d),
            category=d.category,
            path=path_after_category(d),
            updated_at=d.updated_at,
            rev_label=str(d.current_rev),
            change_kind="REVISION" if rev_file else "INFO",
            rev_from=max(rev_file.rev - 1, 0) if rev_file else None,
            rev_to=rev_file.rev if rev_file else None,
            vendor_name=rev_file.vendor_name if rev_file else None,
            project_name=projects.get(rev_file.project_id) if rev_file else None,
            changed_by=changed_by.get(d.id),
            current_pdf_file_id=pdf_file_id_by_doc.get(d.id),
        ))
    return items, len(latest_rev_by_doc)


def filter_recent_changes(items, kind: list[str], modified: list[str]):
    """최근수정본 팝업의 두 드롭다운(수정 구분 / 수정일)을 그대로 적용한다.

    화면은 이미 받아둔 목록을 그 자리에서 걸러 보여주고, 엑셀 내보내기는 같은 조건을
    여기로 넘겨 똑같이 거른다 — 화면 표와 엑셀 내용이 어긋나지 않게 하기 위함.
    """
    if kind and "ALL" not in kind:
        items = [i for i in items if i.change_kind in kind]

    if modified and "ALL" not in modified:
        strong_cut = days_ago(RECENT_STRONG_DAYS)
        soft_cut = days_ago(RECENT_SOFT_DAYS)

        def in_scope(updated_at) -> bool:
            if "D30" in modified and updated_at >= strong_cut:
                return True
            if "D31_90" in modified and soft_cut <= updated_at < strong_cut:
                return True
            if "D91" in modified and updated_at < soft_cut:
                return True
            return False

        items = [i for i in items if in_scope(i.updated_at)]
    return items


@router.get("/recent-changes", response_model=RecentChangesResponse)
def list_recent_changes(
    days: int = Query(RECENT_SOFT_DAYS, ge=1, le=3650),
    db: Session = Depends(get_db),
):
    items, revision_count = collect_recent_changes(db, days)
    return RecentChangesResponse(
        days=days, total=len(items), revision_count=revision_count, items=items
    )


@router.get("/recent-changes/summary", response_model=RecentChangesSummary)
def recent_changes_summary(db: Session = Depends(get_db)):
    """상단 [TDB 최근수정] 버튼의 건수. 로그인한 사람이면 누구나 같은 숫자를 본다
    (권한에 따라 숫자가 달라지면 서로 보고한 건수가 안 맞아 혼란이 생기므로 — CM 확정)."""
    count = (
        db.query(func.count(Document.id))
        .filter(
            Document.is_archived.is_(False),
            is_modified_condition(),
            Document.updated_at >= days_ago(RECENT_SOFT_DAYS),
        )
        .scalar()
        or 0
    )
    return RecentChangesSummary(count=count)


def change_text(item: RecentChangeItem) -> str:
    if item.change_kind == "REVISION":
        return f"Rev {item.rev_from} → {item.rev_to}"
    return "일반 수정"


@router.get("/recent-changes/export")
def export_recent_changes(
    days: int = Query(RECENT_SOFT_DAYS, ge=1, le=3650),
    kind: list[str] = Query([]),      # ALL / REVISION / INFO — 팝업의 "수정 구분" 드롭다운
    modified: list[str] = Query([]),  # ALL / D30 / D31_90 / D91 — 팝업의 "수정일" 드롭다운
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """최근수정본 팝업의 표를 화면과 같은 컬럼·같은 내용으로 xlsx로 내려준다."""
    items, _ = collect_recent_changes(db, days)
    items = filter_recent_changes(items, kind, modified)

    # 컬럼 구성은 팝업 표와 반드시 같아야 한다(엑셀 내보내기 공통 규칙).
    wb, ws = start_export_workbook(
        "최근수정본",
        ["No", "수정일", "자료명", "분류", "경로", "Rev", "공사", "업체", "변경 내용", "수정자"],
    )
    for no, item in enumerate(items, start=1):
        ws.append([
            no,
            item.updated_at.strftime("%Y-%m-%d %H:%M") if item.updated_at else None,
            item.display_name, item.category, item.path, item.rev_label,
            item.project_name, item.vendor_name, change_text(item), item.changed_by,
        ])
    buf = finish_export_workbook(wb, ws, [6, 17, 26, 16, 40, 8, 16, 14, 14, 12])

    # 이 팝업은 어느 화면에서든 상단 바에서 열 수 있어 특정 화면에 속하지 않는다.
    # 파일명 규칙(화면·팝업 제목 그대로)에 맞춰 팝업 제목만 쓴다.
    filename = build_export_filename("최근수정본")
    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="도면 목록",
        detail={"kind": "최근수정본", "days": days, "change_kind": kind,
                "modified": modified, "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.get("/{document_id}", response_model=DocumentDetail)
def get_document(document_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다")

    files = (
        db.query(File)
        .filter(File.document_id == document_id)
        .order_by(File.rev.desc(), File.branch.is_(None).desc(), File.branch, File.id.desc())
        .all()
    )
    distributions = (
        db.query(Distribution)
        .filter(Distribution.document_id == document_id)
        .order_by(Distribution.distributed_at.desc())
        .all()
    )

    project_ids = {f.project_id for f in files if f.project_id} | {
        d.project_id for d in distributions if d.project_id
    }
    projects = {}
    if project_ids:
        for p in db.query(Project).filter(Project.id.in_(project_ids)).all():
            projects[p.id] = p.name

    current_pdf = next((f for f in files if f.is_current and f.file_ext == "pdf"), None)
    current_originals = [f for f in files if f.is_current and f.file_ext != "pdf"]
    current_dwg = next((f for f in current_originals if f.file_ext == "dwg"), None)
    current_xlsx = next((f for f in current_originals if f.file_ext in ("xlsx", "xls")), None)
    current_etc = next(
        (f for f in current_originals if f.file_ext not in ("dwg", "xlsx", "xls")), None
    )
    current_original = current_dwg or current_xlsx or current_etc

    revisions = []
    for f in files:
        item = FileHistoryItem.model_validate(f)
        item.project_name = projects.get(f.project_id)
        revisions.append(item)
    revision_sets = [revision_set_item(doc, group, projects) for group in group_revision_sets(files)]

    dist_items = []
    for d in distributions:
        item = DistributionHistoryItem.model_validate(d)
        item.project_name = projects.get(d.project_id)
        item.display_name = distribution_display_name(doc, d)
        dist_items.append(item)

    return DocumentDetail(
        id=doc.id,
        drawing_no=doc.drawing_no,
        display_name=document_display_name(doc),
        title=doc.title,
        doc_class=doc.doc_class,
        category=doc.category,
        discipline=doc.discipline,
        doc_type=doc.doc_type,
        isbl_osbl=doc.isbl_osbl,
        elevation=doc.elevation,
        area=doc.area,
        source_path=doc.source_path,
        is_isometric=doc.is_isometric,
        equipment_tag=doc.equipment_tag,
        project_id=doc.project_id,
        current_rev=doc.current_rev,
        status=doc.status,
        has_dwg=current_dwg is not None,
        has_xlsx=current_xlsx is not None,
        has_etc=current_etc is not None,
        has_pdf=doc.has_pdf,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        current_pdf_file_id=current_pdf.id if current_pdf else None,
        current_original_file_id=current_original.id if current_original else None,
        revisions=revisions,
        revision_sets=revision_sets,
        distributions=dist_items,
    )


def revision_set_item(doc: Document, group: list[File], projects: dict) -> RevisionSetItem:
    """세트(같은 rev로 함께 올라온 원본+PDF) 하나를 Revision 이력 한 줄로 만든다."""
    first = group[0]
    pdf = set_pdf(group)
    project_id = next((f.project_id for f in group if f.project_id), None)
    return RevisionSetItem(
        id=first.id,
        rev=first.rev,
        branch=first.branch,
        name=set_name(doc, group),
        exts=[f.file_ext for f in group],
        pdf_file_id=pdf.id if pdf else None,
        has_original=bool(set_originals(group)),
        vendor_name=next((f.vendor_name for f in group if f.vendor_name), None),
        project_name=projects.get(project_id),
        rev_mismatch_warning=any(f.rev_mismatch_warning for f in group),
        review_status=first.review_status,
        review_note=set_note(group),
        uploaded_at=max(f.uploaded_at for f in group),
        is_current=any(f.is_current for f in group),
    )


REVIEW_STATUS_LABELS = {
    "PENDING_REVIEW": "검수대기", "APPROVED": "승인", "REJECTED": "반려", "MERGED": "통합됨",
}


def start_export_workbook(sheet_title: str, headers: list[str]):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_title
    ws.append(headers)
    return wb, ws


def finish_export_workbook(wb, ws, widths: list[int]) -> BytesIO:
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width
    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    return buf


@router.get("/{document_id}/revisions/export")
def export_revisions(
    document_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """자료 상세의 Revision 이력을 화면과 같은 내용으로 xlsx로 내려준다."""
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다")

    files = (
        db.query(File)
        .filter(File.document_id == document_id)
        .order_by(File.rev.desc(), File.branch.is_(None).desc(), File.branch, File.id.desc())
        .all()
    )
    project_ids = {f.project_id for f in files if f.project_id}
    projects = {p.id: p.name for p in db.query(Project).filter(Project.id.in_(project_ids)).all()} if project_ids else {}

    # 화면 표(No/Rev/자료명/공사/업체/검수상태/업로드일시/최신본/비고)와 같은 컬럼 구성
    wb, ws = start_export_workbook(
        "Revision이력", ["No", "Rev", "자료명", "공사", "업체", "검수상태", "업로드일시", "최신본", "비고"]
    )
    # 화면과 같이 세트(같은 rev의 원본+PDF)마다 한 줄
    sets = [revision_set_item(doc, group, projects) for group in group_revision_sets(files)]
    for i, r in enumerate(sets, start=1):
        ws.append([
            i, format_rev_label(r.rev, r.branch), r.name,
            r.project_name, r.vendor_name,
            REVIEW_STATUS_LABELS.get(r.review_status, r.review_status),
            r.uploaded_at.strftime("%Y-%m-%d %H:%M") if r.uploaded_at else None,
            "Y" if r.is_current else "",
            r.review_note,
        ])
    buf = finish_export_workbook(wb, ws, [6, 10, 26, 16, 12, 10, 17, 8, 30])

    filename = build_export_filename("자료 상세 보기", "Revision 이력", suffix=sanitize_path_component(document_display_name(doc)))
    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="도면 목록", document_id=document_id,
        detail={"kind": "Revision이력", "count": len(sets)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.get("/{document_id}/distributions/export")
def export_document_distributions(
    document_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """자료 상세의 반출 이력을 화면과 같은 내용으로 xlsx로 내려준다."""
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다")

    dists = (
        db.query(Distribution)
        .filter(Distribution.document_id == document_id)
        .order_by(Distribution.distributed_at.desc())
        .all()
    )
    project_ids = {d.project_id for d in dists if d.project_id}
    projects = {p.id: p.name for p in db.query(Project).filter(Project.id.in_(project_ids)).all()} if project_ids else {}

    wb, ws = start_export_workbook(
        "반출이력", ["No", "반출Rev", "자료명", "공사", "업체", "목적", "반출일시", "반입일시", "비고"]
    )
    for i, d in enumerate(dists, start=1):
        purpose_label = {"MODIFY": "수정용", "REFERENCE": "참조용", "OTHER": "기타"}.get(d.purpose, d.purpose)
        ws.append([
            # 자료명은 그때 업체에 나간 파일 이름 그대로(반출 당시 Rev의 꼬리)
            i, d.rev_at_distribution, distribution_display_name(doc, d),
            projects.get(d.project_id), d.vendor,
            purpose_label,
            d.distributed_at.strftime("%Y-%m-%d %H:%M") if d.distributed_at else None,
            d.returned_at.strftime("%Y-%m-%d %H:%M") if d.returned_at else "미반입",
            d.return_note,
        ])
    buf = finish_export_workbook(wb, ws, [6, 9, 26, 16, 12, 9, 17, 17, 30])

    filename = build_export_filename("자료 상세 보기", "반출 이력", suffix=sanitize_path_component(document_display_name(doc)))
    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="도면 목록", document_id=document_id,
        detail={"kind": "반출이력(상세)", "count": len(dists)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )
