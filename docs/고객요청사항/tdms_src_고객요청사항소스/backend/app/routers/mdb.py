"""MDB 조회 — 설비 Tag No로 자료를 찾고 목록·상세·다운로드를 제공한다.

**여기서 다루는 단위는 "파일"이 아니라 "자료"다** (2026-08-17 CM 확정). 원본(xls·dwg 등)과
PDF 사본이 같은 폴더에 같은 이름으로 있으면 목록에 한 줄로 나온다. 묶는 규칙은 app/mdb_group.py에
한 곳으로 모아뒀고, 이 파일은 그렇게 묶인 자료를 걸러내고 화면 모양으로 바꿔 내려주는 일만 한다.
"""

import re
from io import BytesIO
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import distinct, func, or_
from sqlalchemy.orm import Session, joinedload

from app.auth import current_user
from app.config import STORAGE_ROOT
from app.database import get_db
from app.mdb_group import MdbGroup, build_groups, filename_of, folder_of, group_of, load_tags_map, sort_groups
from app.mdb_note import build_note_items
from app.mdb_types import matches as type_matches, type_set
from app.models import AuditLog, EquipmentType, MdbDocType, MdbFile, MdbFileTag, Project, User
from app.retire import MDB_RETIRE_KIND, is_retired_row
from app.schemas import (
    MdbDocFile,
    MdbFileDetail,
    MdbFileItem,
    MdbFolderItem,
    MdbListResponse,
    MdbMeta,
    MdbNavItem,
    MdbSearchResponse,
    MdbTreeFileItem,
    MdbTreeResponse,
)
from app.utils import (
    build_export_filename,
    content_disposition_header,
    filename_timestamp,
    kst_now,
    neutralize_formulas,
    sanitize_path_component,
)

router = APIRouter(prefix="/mdb", tags=["mdb"])


def short_project_label(name: Optional[str]) -> Optional[str]:
    """화면(mdb.js shortProjectLabel)과 동일하게, 소속공사명 앞의 "2013. 08. - " 같은
    연도.월 표기를 떼고 공사명만 남긴다."""
    if not name:
        return name
    return re.sub(r"^\d{4}\.\s*\d{1,2}\.\s*-\s*", "", name).strip() or name


def ext_flags(exts: list[str]) -> tuple[str, str, str, str]:
    """화면(mdb.js extCell)과 같은 규칙으로 DWG/XLSX/ETC/PDF 칸에 Y를 찍는다.

    자료가 가진 형식마다 찍으므로, 원본(xlsx)+사본(pdf)을 가진 자료는 XLSX와 PDF 두 칸에
    Y가 들어간다 — 예전처럼 한 칸만 찍히지 않는다(자료 1건에 파일이 여럿이므로).
    """
    lowered = {(e or "").lower() for e in exts if e}
    return (
        "Y" if "dwg" in lowered else "",
        "Y" if lowered & {"xlsx", "xls"} else "",
        "Y" if lowered - {"dwg", "xlsx", "xls", "pdf"} else "",
        "Y" if "pdf" in lowered else "",
    )


MEDIA_TYPES = {"pdf": "application/pdf", "dwg": "application/acad"}


def to_item(group: MdbGroup) -> MdbFileItem:
    """자료 1건을 화면용 항목으로. id는 대표 파일 id(mdb_group.MdbGroup 설명 참고)."""
    return MdbFileItem(
        id=group.id,
        name=group.name,
        source_path=group.key,
        folder=group.folder,
        files=[
            MdbDocFile(
                id=r.id, original_filename=r.original_filename, file_ext=r.file_ext,
                file_size=r.file_size, is_pdf=r.is_pdf, pairing_folder=r.pairing_folder,
            )
            for r in group.rows
        ],
        exts=group.exts,
        has_original=group.has_original,
        has_pdf=group.has_pdf,
        pdf_file_id=group.pdf_row.id if group.pdf_row else None,
        file_size=group.file_size,
        equipment_type=group.equipment_type,
        doc_type=group.doc_type,
        project_id=group.project_id,
        project_name=group.project_name,
        year=group.year,
        note=group.note,
        tags=group.tags,
        category=group.category,
        uploaded_at=group.uploaded_at,
        updated_at=group.updated_at,
    )


def to_nav(group: MdbGroup) -> MdbNavItem:
    return MdbNavItem(
        id=group.id, name=group.name, source_path=group.key,
        has_pdf=group.has_pdf, pdf_file_id=group.pdf_row.id if group.pdf_row else None,
    )


@router.get("/meta", response_model=MdbMeta)
def get_meta(db: Session = Depends(get_db)):
    types = [
        t for (t,) in db.query(EquipmentType.name)
        .filter(EquipmentType.is_hidden.is_(False)).order_by(EquipmentType.name).all()
    ]
    doc_types = [
        t for (t,) in db.query(MdbDocType.name)
        .filter(MdbDocType.is_hidden.is_(False)).order_by(MdbDocType.name).all()
    ]
    projects = db.query(Project).filter(Project.is_hidden.is_(False)).order_by(Project.name).all()
    years = [y for (y,) in db.query(distinct(MdbFile.year)).filter(MdbFile.year.isnot(None)).all()]
    return MdbMeta(
        equipment_types=types, doc_types=doc_types, projects=projects,
        years=sorted(years, reverse=True),
    )


@router.get("/tags/suggest")
def suggest_tags(q: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """태그 번호 일부만 입력했을 때(예: '1101A') 이 문자열을 포함하는 실제 태그들을
    보여주기 위한 후보 목록. TT-T1101A, TT-P1101A처럼 같은 조각을 공유하는 여러 설비를
    화면에서 골라 검색하게 해준다."""
    q_norm = q.strip().upper()
    rows = (
        db.query(MdbFileTag.tag_no, func.count(MdbFileTag.id))
        .filter(MdbFileTag.tag_no.ilike(f"%{q_norm}%"))
        .group_by(MdbFileTag.tag_no)
        .order_by(MdbFileTag.tag_no)
        .limit(50)
        .all()
    )
    return [{"tag_no": t, "count": c} for t, c in rows]


def matches_folder(path: str):
    """이 폴더 자신이거나 그 하위 경로인지 (editor.py의 문서 폴더 필터와 같은 방식).
    백슬래시를 LIKE 이스케이프 문자로 PostgreSQL이 먹어버리는 문제가 있어 반드시 이 형태를 유지."""
    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return or_(MdbFile.source_path == path, MdbFile.source_path.like(f"{escaped}%", escape="\\"))


# ---------------------------------------------------------------------------
# 자료 목록 만들기
#
# 자료 하나가 파일 여러 개로 이뤄지므로, 조건에 맞는 "행"만 골라서는 자료를 제대로 볼 수 없다
# (예: 자료명에 "xlsx"가 든 자료를 검색하면 원본 행만 걸려서 "사본이 없는 자료"처럼 보인다).
# 그래서 자료를 통째로 만든 뒤 자료 단위로 거른다. MDB는 전체가 1,200건 규모라 한 번에 읽어
# 묶어도 수십 밀리초면 끝난다 — SQL로 묶는 것보다 읽기 쉽고 규칙이 한 군데 모인다.
# ---------------------------------------------------------------------------

def load_all_groups(db: Session) -> list[MdbGroup]:
    """보관함에 들어가지 않은 MDB 자료 전체 (경로·이름순)."""
    rows = (
        db.query(MdbFile)
        .options(joinedload(MdbFile.project))
        .filter(MdbFile.is_archived.is_(False))
        .all()
    )
    return build_groups(rows, load_tags_map(db, [r.id for r in rows]))


def group_in_folder(group: MdbGroup, folder_path: str, recursive: bool) -> bool:
    if recursive:
        # 위 matches_folder(SQL)와 같은 판정 — 폴더 자신이거나 그 경로로 시작하는 것.
        return any(
            r.source_path == folder_path or r.source_path.startswith(folder_path)
            for r in group.rows
        )
    return group.folder == folder_path


def group_matches_query(group: MdbGroup, q: str) -> bool:
    """자료명 검색 — 자료에 속한 파일 중 하나라도 이름·경로에 검색어가 있으면 그 자료를 보여준다."""
    needle = q.lower()
    return any(
        needle in (r.original_filename or "").lower() or needle in (r.source_path or "").lower()
        for r in group.rows
    )


def filter_groups(
    groups: list[MdbGroup], *, category: Optional[str] = None, q: Optional[str] = None,
    equipment_type: Optional[str] = None, doc_type: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_path: Optional[str] = None, recursive: bool = True,
    holding: Optional[str] = None, tag: Optional[str] = None, q_any: Optional[str] = None,
) -> list[MdbGroup]:
    result = groups
    if folder_path:
        result = [g for g in result if group_in_folder(g, folder_path, recursive)]
    if tag:
        # 검색칸 좌측 드롭박스에서 "Tag No"를 골라 검색했을 때 — 이 Tag No가 붙어 있는(전용) 자료만.
        # (자료명 검색 q와는 별개 경로다: q는 파일명·경로 부분일치, tag는 Tag No 정확일치)
        wanted = tag.strip().upper()
        result = [g for g in result if wanted in {t.upper() for t in g.tags}]
    if q:
        result = [g for g in result if group_matches_query(g, q)]
    if q_any:
        # 검색대상=전체 — 자료명(파일명·경로 부분일치) 또는 Tag No(부분일치) 어느 쪽이든 걸리면 포함.
        needle = q_any.strip().lower()
        result = [
            g for g in result
            if group_matches_query(g, q_any) or any(needle in t.lower() for t in g.tags)
        ]
    # 설비유형·자료유형은 자료 1건에 여러 개가 붙을 수 있으므로(예: "Pump/Strainer") 값을 통째로
    # 비교하지 않고 **하나라도 맞으면** 걸리게 한다 — Pump로 검색하면 Pump/Strainer도 나온다
    # (2026-08-28 CM 확정, app/mdb_types.py).
    if equipment_type:
        result = [g for g in result if type_matches(g.equipment_type, equipment_type)]
    if doc_type:
        result = [g for g in result if type_matches(g.doc_type, doc_type)]
    if project_id:
        result = [g for g in result if g.project_id == project_id]
    if holding == "BOTH":
        # 원본과 PDF 사본 둘 다 있는 자료
        result = [g for g in result if g.has_original and g.has_pdf]
    elif holding == "ORIGINAL_ONLY":
        # 원본은 있고 PDF 사본이 없는 자료 (TDB 조회의 같은 이름 필터와 같은 뜻)
        result = [g for g in result if g.has_original and not g.has_pdf]
    elif holding == "COPY_ONLY":
        result = [g for g in result if g.has_pdf and not g.has_original]
    if category:
        result = [g for g in result if g.category == category]
    return result


def load_groups(db: Session, **filters) -> list[MdbGroup]:
    return filter_groups(load_all_groups(db), **filters)


def search_direct_common(db: Session, tag: str) -> tuple[list[MdbGroup], list[MdbGroup], Optional[str]]:
    """Tag No로 검색: ① 이 Tag No가 직접 붙어있는 전용 자료, ② Tag No는 없지만 같은 설비유형이라
    참고할 만한 공용 자료. 둘 다 소속공사 연도 최신순으로 정렬한다. /search 화면 조회와
    /export 내보내기(전용·공용 표 각각)가 같은 로직을 쓰도록 여기 하나로 모아둔다."""
    tag_norm = tag.strip().upper()
    groups = load_all_groups(db)

    def by_year(items: list[MdbGroup]) -> list[MdbGroup]:
        return sorted(items, key=lambda g: (-(g.year or 0), g.name.lower()))

    direct = by_year([g for g in groups if tag_norm in {t.upper() for t in g.tags}])
    equipment_type = next((g.equipment_type for g in direct if g.equipment_type), None)

    # 전용 자료들에 붙은 설비유형과 **하나라도 겹치는** 공용 자료를 참고 자료로 모은다
    # (설비유형이 "Pump/Strainer"처럼 여러 개일 수 있어 통째로 비교하면 안 된다).
    wanted = {t for g in direct for t in type_set(g.equipment_type)}
    common: list[MdbGroup] = []
    if wanted:
        common = by_year([
            g for g in groups if not g.tags and (type_set(g.equipment_type) & wanted)
        ])
    return direct, common, equipment_type


@router.get("/search", response_model=MdbSearchResponse)
def search(tag: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    tag_norm = tag.strip().upper()
    direct, common, equipment_type = search_direct_common(db, tag_norm)
    return MdbSearchResponse(
        tag=tag_norm,
        equipment_type=equipment_type,
        direct=[to_item(g) for g in direct],
        common=[to_item(g) for g in common],
    )


@router.get("/tree", response_model=MdbTreeResponse)
def get_tree(db: Session = Depends(get_db)):
    """왼쪽 폴더 트리용. 괄호 숫자는 자료 수다 — 원본과 PDF 사본이 나뉘어 있어도 1건으로 센다.
    폴더뿐 아니라 그 안의 자료 이름까지 트리에서 펼쳐 볼 수 있도록 자료 목록도 같이 내려준다.
    조회 전용이라 폴더·자료 편집처럼 이름 변경/이동 대상은 아니다."""
    counts: dict[str, int] = {}
    files: list[MdbTreeFileItem] = []
    for g in load_all_groups(db):
        folder = g.folder
        if folder:
            counts[folder] = counts.get(folder, 0) + 1
        files.append(MdbTreeFileItem(
            id=g.id, name=g.name, folder=folder, exts=g.exts,
            has_pdf=g.has_pdf, pdf_file_id=g.pdf_row.id if g.pdf_row else None,
        ))
    folders = [MdbFolderItem(path=path, file_count=count) for path, count in counts.items()]
    return MdbTreeResponse(folders=folders, files=files)


@router.get("/list", response_model=MdbListResponse)
def list_files(
    category: Optional[str] = None,
    q: Optional[str] = None,
    equipment_type: Optional[str] = None,
    doc_type: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_path: Optional[str] = None,
    recursive: bool = True,
    holding: Optional[str] = None,
    tag: Optional[str] = None,
    q_any: Optional[str] = None,
    ids: Optional[str] = None,
    sort: Optional[str] = None,
    dir: str = "asc",
    page: int = 1,
    page_size: int = 50,
    db: Session = Depends(get_db),
):
    if ids:
        # 다운대기함(선택 항목) 조회용 — 다른 필터 무시하고 지정된 자료들만, 담은 순서대로
        groups = groups_by_ids(db, ids)
        items = [to_item(g) for g in groups]
        return MdbListResponse(total=len(items), page=1, page_size=len(items) or 1, items=items)

    groups = load_groups(
        db, category=category, q=q, equipment_type=equipment_type, doc_type=doc_type,
        project_id=project_id,
        folder_path=folder_path, recursive=recursive, holding=holding, tag=tag, q_any=q_any,
    )
    # 정렬은 화면의 50건이 아니라 조회 결과 전체가 기준이다(공통 규칙, documents.py와 동일).
    groups = sort_groups(groups, sort, dir)
    start = (page - 1) * page_size
    return MdbListResponse(
        total=len(groups), page=page, page_size=page_size,
        items=[to_item(g) for g in groups[start:start + page_size]],
    )


def groups_by_ids(db: Session, ids: str) -> list[MdbGroup]:
    """쉼표로 이어진 대표 파일 id 목록 → 자료 목록 (화면에 담은 순서 유지)."""
    id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
    by_id = {g.id: g for g in load_all_groups(db)}
    return [by_id[i] for i in id_list if i in by_id]


@router.get("/nav", response_model=list[MdbNavItem])
def list_files_nav(
    category: Optional[str] = None,
    q: Optional[str] = None,
    equipment_type: Optional[str] = None,
    doc_type: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_path: Optional[str] = None,
    recursive: bool = True,
    holding: Optional[str] = None,
    tag: Optional[str] = None,
    q_any: Optional[str] = None,
    sort: Optional[str] = None,
    dir: str = "asc",
    db: Session = Depends(get_db),
):
    """미리보기의 "이전/다음 넘겨보기"용. 결과 표는 페이지당 50건씩만 보여주지만, 넘겨보기는
    지금 검색조건에 맞는 전체 자료를 순서대로 오갈 수 있어야 한다(documents/nav와 같은 목적).
    표가 정렬돼 있으면 넘겨보기도 같은 순서를 따라가야 하므로 sort/dir을 그대로 받는다."""
    groups = load_groups(
        db, category=category, q=q, equipment_type=equipment_type, doc_type=doc_type,
        project_id=project_id,
        folder_path=folder_path, recursive=recursive, holding=holding, tag=tag, q_any=q_any,
    )
    groups = sort_groups(groups, sort, dir)
    return [to_nav(g) for g in groups]


@router.get("/ids-by-path", response_model=list[int])
def mdb_ids_by_path(
    folder_path: str,
    recursive: bool = True,
    db: Session = Depends(get_db),
):
    """"폴더 다운"용: 폴더(하위 포함 여부는 recursive) 안 자료의 대표 id 전부. 페이지 제한 없이."""
    groups = load_groups(db, folder_path=folder_path, recursive=recursive)
    return [g.id for g in groups]


def zip_arcname(row: MdbFile, keep_paths: bool = True) -> str:
    """zip 안에서 이 파일이 놓일 자리. 화면에서 숨겨둔 DWG·PDF 폴더까지 원래 모양대로 재현한다.
    keep_paths=False면 폴더를 전부 떼고 파일명만 남겨 zip 바로 밑에 평평하게 담는다
    (숨겨둔 DWG·PDF 폴더도 같이 빠진다 — 2026-08-28 CM 확정)."""
    name = filename_of(row.source_path)
    if not keep_paths:
        return name
    parts = [p for p in (folder_of(row.source_path), row.pairing_folder, name) if p]
    return "/".join(parts)


def build_mdb_zip_bytes(groups: list[MdbGroup], keep_paths: bool = True) -> bytes:
    """선택한 MDB 자료들을 zip에 담고, 자료목록 엑셀을 동봉한다.
    자료에 원본과 PDF 사본이 둘 다 있으면 **둘 다** 담긴다(자료 1건 = 파일 여러 개).
    TDB 반출 zip과 같은 방식(폴더 상위/하위 유지 + 엑셀 List). MDB는 반출 기록 개념이 없어
    (CM 확정) 이력은 남기지 않고 파일만 묶는다.

    keep_paths=False면 다운대기함의 [폴더 경로 유지]를 끈 것이다 — 폴더 없이 자료와
    엑셀 목록이 zip 바로 밑에 나란히 들어가서, 압축을 풀면 zip 이름과 같은 폴더 하나에
    전부 모인다. 엑셀 목록 내용은 켜든 끓든 같다(2026-08-28 CM 확정)."""
    import zipfile
    from pathlib import Path

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        used_names: set[str] = set()
        for g in groups:
            for r in g.rows:
                src = Path(STORAGE_ROOT) / r.storage_path
                if not src.is_file():
                    continue
                arcname = zip_arcname(r, keep_paths)
                # 혹시 모를 중복 이름은 뒤에 (2),(3)… 을 붙여 덮어쓰기 방지
                base = arcname
                n = 2
                while arcname in used_names:
                    stem, dot, ext = base.rpartition(".")
                    arcname = f"{stem} ({n}).{ext}" if dot else f"{base} ({n})"
                    n += 1
                used_names.add(arcname)
                zf.write(src, arcname)
        zf.writestr(f"MDB 다운목록_{filename_timestamp()}.xlsx", build_mdb_manifest_bytes(groups))
    buf.seek(0)
    return buf.getvalue()


def build_mdb_manifest_bytes(groups: list[MdbGroup]) -> bytes:
    """다운로드 zip에 동봉하는 자료목록 엑셀. 화면 결과 표와 같은 컬럼 구성 + 다운로드 시각."""
    downloaded_at = kst_now().strftime("%Y-%m-%d %H:%M")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "MDB다운목록"
    ws.append([
        "No", "자료명", "연도", "공사", "경로", "설비유형", "자료유형",
        "DWG", "XLSX", "ETC", "PDF", "반출일시",
    ])
    for i, g in enumerate(groups, start=1):
        dwg, xlsx, etc, pdf = ext_flags(g.exts)
        ws.append([
            i, g.name, g.year, short_project_label(g.project_name),
            g.key, g.equipment_type or "-", g.doc_type or "-",
            dwg, xlsx, etc, pdf, downloaded_at,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 40, 8, 22, 55, 14, 14, 7, 7, 7, 7, 17], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width
    out = BytesIO()
    neutralize_formulas(wb)
    wb.save(out)
    return out.getvalue()


@router.get("/download-zip")
def mdb_download_zip(
    ids: str = Query(..., description="자료의 대표 파일 id 쉼표구분"),
    keep_paths: bool = Query(True, description="폴더 경로 유지(기본). 끄면 zip 바로 밑에 평평하게 담는다"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """다운대기함/선택 자료를 zip으로 내려준다. (반출이 아니라 단순 다운로드라
    별도 기록은 남기지 않는다 — 다운로드 자체는 감사로그에만 남긴다.)
    keep_paths=false면 폴더 구조 없이 자료와 엑셀 목록을 한데 모아 담는다(2026-08-28 CM 확정)."""
    groups = groups_by_ids(db, ids)
    if not groups:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")

    content = build_mdb_zip_bytes(groups, keep_paths)
    filename = f"MDB 다운_{filename_timestamp()}.zip"

    db.add(AuditLog(
        user_id=user.id, action="DOWNLOAD", screen="MDB", document_id=None,
        detail={"kind": "MDB_ZIP", "count": len(groups),
                "files": sum(len(g.rows) for g in groups),
                "keep_paths": keep_paths},
    ))
    db.commit()

    return StreamingResponse(
        BytesIO(content),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


def visible_group(db: Session, file_id: int) -> Optional[MdbGroup]:
    """자료 1건 — 폐기 보관함에 들어간 자료도 열어준다.

    폐기는 "나중에 이력을 찾을 수 있게" 하는 것이 목적이라 상세보기·미리보기·다운로드가
    되어야 한다. 삭제 보관함에 들어간 자료는 지금처럼 열리지 않는다 (2026-08-30 CM 확정).
    """
    group = group_of(db, file_id)
    if group is not None:
        return group
    archived = group_of(db, file_id, include_archived=True)
    if archived is None:
        return None
    return archived if is_retired_row(db, archived.rep.archive_batch_id, MDB_RETIRE_KIND) else None


@router.get("/files/{file_id}", response_model=MdbFileDetail)
def get_file(file_id: int, db: Session = Depends(get_db)):
    """자료 1건 — 대표 id로도, 그 자료에 속한 아무 파일 id로도 열린다(옛 주소 호환).

    목록과 같은 값에 note_items(Note를 조각낸 것)만 더해 내려준다 — 상세보기가 Note를
    구분·Tag No·연도·공사명·사유로 줄 맞춰 표로 보여주는 데 쓴다(2026-09-01 CM 확정).
    목록(1,200건)에는 필요 없는 값이라 여기서만 채운다.
    """
    group = visible_group(db, file_id)
    if group is None:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    return with_note_items(db, group)


def with_note_items(db: Session, group: MdbGroup) -> MdbFileDetail:
    """자료 1건 + Note를 조각낸 것. 상세보기 조회와 "자료명·정보 변경" 저장 결과가 함께 쓴다
    (저장한 뒤에도 화면이 Note 표를 새로 그려야 하므로 같은 값이 필요하다)."""
    return MdbFileDetail(
        **to_item(group).model_dump(), note_items=build_note_items(db, group.note),
    )


@router.get("/files/{file_id}/view")
def view_file(file_id: int, db: Session = Depends(get_db)):
    """웹 미리보기. 자료의 대표가 원본(엑셀 등)이어도 그 자료의 PDF 사본을 찾아 열어준다."""
    row = db.get(MdbFile, file_id)
    if row is None:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    group = visible_group(db, file_id)
    if group is None:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    pdf_row = row if row.file_ext == "pdf" else group.pdf_row
    if pdf_row is None:
        raise HTTPException(status_code=400, detail="PDF만 웹에서 열람할 수 있습니다")
    path = f"{STORAGE_ROOT}/{pdf_row.storage_path}"
    filename = f"{sanitize_path_component(group.name)}.pdf"
    return FileResponse(
        path, media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition_header("inline", filename),
            "Cache-Control": "no-store",
        },
    )


@router.get("/files/{file_id}/view/{markup_filename}")
def view_file_with_markup_name(file_id: int, markup_filename: str, db: Session = Depends(get_db)):
    """미리보기와 내용은 같고, 주소 맨 뒤에 파일명만 덧붙인 것.
    마크업(그리기) 후 [저장]할 때의 파일명을 위한 것 — 자세한 설명은 files.py의 같은 이름 함수 참고."""
    return view_file(file_id, db)


@router.get("/files/{file_id}/download")
def download_file(file_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """파일 1개 내려받기 — 상세보기의 원본/사본 각각의 다운로드 버튼이 쓴다.
    자료에 딸린 파일을 한꺼번에 받는 것은 /download-zip이다."""
    row = db.get(MdbFile, file_id)
    if row is None:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    group = visible_group(db, file_id)
    path = f"{STORAGE_ROOT}/{row.storage_path}"
    media_type = MEDIA_TYPES.get(row.file_ext, "application/octet-stream")
    filename = f"{sanitize_path_component(group.name)}.{row.file_ext}" if group else row.original_filename

    db.add(AuditLog(
        user_id=user.id, action="DOWNLOAD", screen="MDB", document_id=None,
        detail={"mdb_file_id": file_id, "original_filename": row.original_filename},
    ))
    db.commit()

    return FileResponse(
        path, media_type=media_type,
        headers={
            "Content-Disposition": content_disposition_header("attachment", filename),
            "Cache-Control": "no-store",
        },
    )


@router.get("/export")
def export_files(
    category: Optional[str] = None,
    q: Optional[str] = None,
    equipment_type: Optional[str] = None,
    doc_type: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_path: Optional[str] = None,
    recursive: bool = True,
    holding: Optional[str] = None,
    tag: Optional[str] = None,
    q_any: Optional[str] = None,
    group: Optional[str] = None,  # "direct" | "common" — Tag No 검색의 전용/공용 표 각각 내보내기
    ids: Optional[str] = None,    # 다운대기함(선택 항목)만 내보낼 때
    sort: Optional[str] = None,
    dir: str = "asc",
    # 어느 화면(표)에서 눌렀는지 — 표마다 컬럼 구성이 다르므로 그에 맞춰 내보낸다.
    #   list(기본)=MDB 조회/관리 결과 표, cart=다운대기함 팝업, unclassified=Tag No·유형 미분류 관리 팝업
    columns: str = "list",
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    if ids:
        rows = groups_by_ids(db, ids)
        filename = build_export_filename("MDB 조회", "다운대기함")
    elif tag and group:
        # 옛 Tag No 검색 결과 화면의 전용/공용 표 각각 내보내기(전용=direct, 공용=common).
        direct, common, _equipment_type = search_direct_common(db, tag)
        rows = direct if group == "direct" else common
        title = f"{tag.strip()} {'전용자료' if group == 'direct' else '공용자료'}"
        filename = build_export_filename("MDB 조회", title)
    else:
        # 결과 표(검색조건 그대로) 내보내기 — tag가 있으면 그 Tag No가 붙은 전용 자료만.
        # 표에서 정렬해둔 상태로 눌렀으면 엑셀도 같은 순서로 내려간다(D-25, 화면과 어긋나지 않게).
        rows = load_groups(
            db, category=category, q=q, equipment_type=equipment_type, doc_type=doc_type,
            project_id=project_id,
            folder_path=folder_path, recursive=recursive, holding=holding, tag=tag, q_any=q_any,
        )
        rows = sort_groups(rows, sort, dir)
        if columns == "unclassified":
            filename = build_export_filename("MDB 관리", "Tag No·유형 미분류 관리")
        elif tag:
            filename = build_export_filename("MDB 조회", f"{tag.strip()} 자료")
        else:
            filename = build_export_filename("MDB 조회")

    # 화면 표와 같은 컬럼 구성으로 내보낸다(화면마다 표가 달라 셋으로 나뉜다).
    #  - cart(다운대기함)        : No/자료명/경로
    #  - unclassified(미분류 관리): No/자료명/연도/공사/경로/DWG/XLSX/ETC/PDF  (설비유형·자료유형 없음)
    #  - list(결과 표, 기본)      : No/자료명/연도/공사/경로/설비유형/자료유형/DWG/XLSX/ETC/PDF/최종수정
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "MDB자료"

    if columns == "cart":
        ws.append(["No", "자료명", "경로"])
        for i, g in enumerate(rows, start=1):
            ws.append([i, g.name, g.key])
        widths = [6, 40, 60]
    elif columns == "unclassified":
        ws.append(["No", "자료명", "연도", "공사", "경로", "DWG", "XLSX", "ETC", "PDF"])
        for i, g in enumerate(rows, start=1):
            dwg, xlsx, etc, pdf = ext_flags(g.exts)
            ws.append([
                i, g.name, g.year, short_project_label(g.project_name),
                g.key, dwg, xlsx, etc, pdf,
            ])
        widths = [6, 40, 8, 22, 55, 7, 7, 7, 7]
    else:
        ws.append([
            "No", "자료명", "연도", "공사", "경로", "설비유형", "자료유형",
            "DWG", "XLSX", "ETC", "PDF", "최종수정",
        ])
        for i, g in enumerate(rows, start=1):
            dwg, xlsx, etc, pdf = ext_flags(g.exts)
            ws.append([
                i, g.name, g.year, short_project_label(g.project_name),
                g.key, g.equipment_type or "-", g.doc_type or "-",
                dwg, xlsx, etc, pdf,
                g.updated_at.strftime("%Y-%m-%d %H:%M") if g.updated_at else None,
            ])
        widths = [6, 40, 8, 22, 55, 14, 14, 7, 7, 7, 7, 17]

    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="MDB", document_id=None,
        detail={"scope": "mdb", "count": len(rows), "category": category, "q": q, "tag": tag,
                "equipment_type": equipment_type, "doc_type": doc_type,
                "group": group, "columns": columns},
    ))
    db.commit()

    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )
