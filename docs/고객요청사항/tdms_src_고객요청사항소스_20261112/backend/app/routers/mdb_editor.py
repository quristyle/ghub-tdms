"""MDB 편집 — 폴더·자료 편집(editor.py) 화면과 같은 기능을 mdb_files 대상으로 제공한다.

- mdb_files.source_path는 폴더뿐 아니라 파일명까지 포함한 전체 상대경로다(documents와 다름).
  그래서 "폴더" 연산은 항상 source_path에서 마지막 조각(파일명)을 뗀 부분만 다루고,
  이름변경 재번호(cascade) 로직도 마지막 조각(파일명)은 절대 건드리지 않는다.
- **자료 1건은 파일 여러 개일 수 있다** (원본 + PDF 사본, 2026-08-17 CM 확정). 화면은 자료의
  대표 파일 id 하나만 보내오므로, 편집 API는 그 id로 자료 전체(mdb_group.rows_in_group)를
  집어와 원본과 사본에 **함께** 적용한다 — 한쪽만 옮기거나 지우면 자료가 쪼개진다.
- 삭제는 mdb_files.is_archived=true로만 숨긴다(D-6). documents와 같은 archive_batches
  테이블을 kind="MDB_FOLDER"/"MDB_FILE"로 공유해서 보관함 이력을 남긴다.
- 여기서 다루는 물리 파일은 시스템 백업 사본(storage/MDB)뿐이다. CM이 갖고 있는 원본
  MDB 폴더(도면관리시스템\\MDB)는 이 화면이 건드리지 않는다 — 그건 CM이 탐색기에서
  직접 관리하고, 필요하면 별도 재동기화 스크립트(mdb_resync.py)로 반영한다.
"""

import re
import shutil
import zipfile
from collections import Counter
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, File as UploadFileMarker, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app import storage
from app.auth import current_user, require_admin
from app.config import STORAGE_ROOT
from app.database import get_db
from app.mdb_group import (
    MdbGroup,
    build_groups,
    doc_name,
    find_group_rows,
    group_key,
    load_tags_map,
    row_key,
    rows_in_group,
)
from app.mdb_types import normalize as normalize_types
from app.mdb_utils import get_or_create_project, project_name_for, year_for
from app.models import (
    ArchiveBatch,
    AuditLog,
    MdbFile,
    MdbFileTag,
    MdbFolderPlaceholder,
    Project,
    User,
    UserFavorite,
)
from app.permissions import require_permission
from app.retire import MDB_RETIRE_KIND
from app.routers.imports import file_ext_of
from app.routers.mdb import ext_flags, matches_folder, short_project_label, to_item, with_note_items
# Tag No 이력의 "앞으로 자동 적용"(2026-09-01 CM 확정) — 자료에 Tag No를 새로 달면 그 Tag No에
# 걸린 이력을 이 자리에서 자동으로 넣는다. 규칙은 이력 화면 쪽 한 곳에 두고 여기서 부르기만 한다.
from app.routers.mdb_tag_history import apply_auto_rules, group_of_rows
from app.schemas import (
    MdbBulkRegisterResult,
    MdbDuplicateGroup,
    MdbEditorFileItem,
    MdbEditorFolderItem,
    MdbEditorTreeResponse,
    MdbFileArchiveRequest,
    MdbFileArchiveResult,
    MdbFileBulkArchiveRequest,
    MdbFileBulkArchiveResult,
    MdbFileBulkEquipmentTypeUpdate,
    MdbFileBulkMoveRequest,
    MdbFileBulkMoveResult,
    MdbFileBulkUpdateResult,
    MdbFileInfoUpdate,
    MdbFileInfoUpdateResult,
    MdbFileItem,
    MdbFileMoveRequest,
    MdbFolderArchiveRequest,
    MdbFolderArchiveResult,
    MdbFolderPlaceholderCreate,
    MdbFolderReparentRequest,
    MdbFolderReparentResult,
    MdbPairFolderMergeResult,
    MdbPairFolderMergeSkipped,
    MdbReplaceResult,
    MdbRetireRequest,
    MdbRetireResult,
    MdbRetiredItem,
    MdbTrashItem,
    MdbTrashPurgeResult,
    MdbTrashRestoreResult,
    MdbZipRegisterResult,
    PairFolderCandidate,
    PairFolderCandidateList,
    PairFolderMergeRequest,
    RetireRestoreBlocked,
    RetireRestoreRequest,
    RetireRestoreResult,
    TrashCount,
    TrashPurgeRequest,
    UpdateNoteRequest,
)
from app.utils import (
    is_pairing_name,
    pairing_folder_paths,
    split_pairing_folder,
    build_export_filename,
    content_disposition_header,
    filename_timestamp,
    neutralize_formulas,
    pairing_folder_for_ext,
    sanitize_path_component,
    save_upload,
)

router = APIRouter(prefix="/mdb-editor", tags=["mdb-editor"])

# 권한.xlsx 기준(2026-08-12 CM 확정) 리프 권한 — role=ADMIN은 자동 통과.
# MDB는 폴더 체계가 설비 Tag No라 트리 라벨은 "폴더 편집"이지만 리프 키는 "tag"로 남아 있다.
require_folder_edit = require_permission("screen.mdb_editor.tag")
require_document_edit = require_permission("screen.mdb_editor.document")
require_zip_register = require_permission("screen.mdb_editor.zip_register")
require_restore = require_permission("screen.mdb_editor.restore")
# 폐기 보관함 — 목록 조회는 권한 없이 열리고(MDB 조회 화면에서도 이력을 봐야 한다),
# 복구·비고 작성만 이 권한으로 막는다 (2026-08-30 CM 확정).
require_retire = require_permission("screen.mdb_editor.retire")
require_trash_note_edit = require_permission("common.note_edit.mdb_trash")
# 삭제 보관함 완전삭제는 권한 트리로 넘기지 않고 관리자 전용으로 고정한다(2026-08-17 CM 확정,
# D-38 개정 — 삭제 보관함 자체가 사실상 관리자만 쓰는 기능이라 별도 그룹 토글이 무의미했다).
require_purge = require_admin

# archive_batches 표는 TDB 관리 화면과 같이 쓴다(kind로만 구분).
MDB_BATCH_KINDS = ("MDB_FOLDER", "MDB_FILE")


# ---------------------------------------------------------------------------
# 경로 문자열 유틸 — source_path = "폴더\\...\\파일명". 폴더 연산은 마지막 조각(파일명)을
# 뗀 부분만 다루고, 다시 붙일 때 파일명은 그대로 이어붙인다.
# ---------------------------------------------------------------------------

def folder_of(source_path: str) -> str:
    return source_path.rsplit("\\", 1)[0] if "\\" in source_path else ""


def filename_of(source_path: str) -> str:
    return source_path.rsplit("\\", 1)[-1]


def folder_basename(path: str) -> str:
    parts = [p for p in path.replace("/", "\\").split("\\") if p]
    return parts[-1] if parts else path


def leading_num(name: str) -> Optional[str]:
    m = re.match(r"^\s*(\d+)", name)
    return m.group(1) if m else None


def transform_mdb_path(source_path: str, old_folder: str, new_folder: str,
                        old_num: Optional[str], new_num: Optional[str], cascade: bool) -> str:
    """old_folder 접두어를 new_folder로 바꾼다. 파일명(마지막 조각)은 절대 재번호 대상이 아니다."""
    folder = folder_of(source_path)
    filename = filename_of(source_path)
    if folder == old_folder:
        new_full_folder = new_folder
    else:
        remainder = folder[len(old_folder):]  # "\\하위폴더\\..." 형태
        if cascade and old_num and new_num and old_num != new_num:
            segments = remainder.split("\\")
            new_segments = []
            for seg in segments:
                if not seg:
                    new_segments.append(seg)
                    continue
                m = re.match(r"^(\d+)", seg)
                if m and m.group(1) == old_num:
                    seg = new_num + seg[len(old_num):]
                new_segments.append(seg)
            remainder = "\\".join(new_segments)
        new_full_folder = new_folder + remainder
    return f"{new_full_folder}\\{filename}" if new_full_folder else filename


def resync_project_and_year(db: Session, row: MdbFile) -> None:
    """폴더 이동으로 최상위 폴더(=공사)가 바뀌면 소속 공사·연도를 새 경로 기준으로 다시 정한다.
    태그·설비유형·비고 등 그 외 필드는 건드리지 않는다."""
    project = get_or_create_project(db, project_name_for(row.source_path))
    row.project_id = project.id
    row.year = year_for(row.source_path)


def move_backup_file(
    old_source_path: str, new_source_path: str, storage_path: str, pairing_folder: Optional[str] = None
) -> str:
    """파일의 시스템 백업 사본 위치를 새 경로에 맞게 옮긴다. 새 storage_path(상대경로)를 반환한다.

    pairing_folder(숨겨둔 DWG·PDF 폴더)는 자료를 어디로 옮기든 따라다닌다 — 저장소에는 원본
    폴더와 같은 모양을 유지해야 하기 때문(TDB move_current_file과 같은 규칙).

    "옮길 필요가 있는지"는 경로 문자열이 아니라 **실제 파일 자리**로 판단해야 한다. DWG·PDF
    폴더 병합처럼 source_path에서 폴더 조각이 pairing_folder로 옮겨가는 경우, 기록상 경로는
    바뀌지만 파일이 놓일 자리는 그대로다(…\\DWG\\A.dwg 그대로) — 문자열로 비교하면 같은
    자리로 옮기려다 오류가 난다."""
    old_dest = Path(STORAGE_ROOT) / storage_path
    new_dest = storage.mdb_file_path(new_source_path, pairing_folder)
    if old_dest == new_dest:
        return storage_path
    new_dest.parent.mkdir(parents=True, exist_ok=True)
    if old_dest.is_file():
        if new_dest.exists():
            new_dest.unlink()
        shutil.move(str(old_dest), str(new_dest))
    return storage.to_relative(new_dest)


def move_row(db: Session, row: MdbFile, new_source_path: str, now) -> None:
    """파일 행 하나를 새 경로로 옮긴다(백업 사본 이동 + 소속공사·연도 재계산)."""
    row.storage_path = move_backup_file(
        row.source_path, new_source_path, row.storage_path, row.pairing_folder
    )
    row.source_path = new_source_path
    resync_project_and_year(db, row)
    row.updated_at = now


def group_rows_or_404(db: Session, file_id: int) -> list[MdbFile]:
    """대표 파일 id → 그 자료의 파일 행 전부(원본+사본). 편집은 항상 이 묶음 단위로 한다."""
    rows = rows_in_group(db, file_id)
    if not rows:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    return rows


def ensure_placeholder_if_emptied(db: Session, folder: Optional[str], user: User) -> None:
    """자료 이동·삭제(보관함행)로 어떤 폴더의 마지막 자료가 빠져나가 그 폴더가(하위 포함) 완전히
    비게 되면, 표시용 placeholder를 자동으로 남겨 폴더 자체가 화면에서 사라지지 않게 한다
    (CM 지시: 자료가 없다고 폴더까지 안 보이면 안 됨 — 2026-08-15, TDB editor.py와 동일 규칙)."""
    if not folder:
        return
    still_has_files = db.query(MdbFile.id).filter(MdbFile.is_archived.is_(False), matches_folder(folder)).first()
    if still_has_files:
        return
    existing = db.query(MdbFolderPlaceholder).filter_by(path=folder).one_or_none()
    if existing:
        return
    db.add(MdbFolderPlaceholder(path=folder, created_by=user.id))
    db.add(AuditLog(
        user_id=user.id, action="ADD_FOLDER", screen="MDB 편집",
        detail={"scope": "mdb", "path": folder, "auto": "자료가 빠져나가 빈 폴더가 되어 자동 생성됨"},
    ))


# ---------------------------------------------------------------------------
# 트리 조회
# ---------------------------------------------------------------------------

def real_folder_of(row: MdbFile) -> str:
    """파일이 실제로 놓인 폴더 — 화면에서 숨겨둔 DWG·PDF 폴더까지 포함한 자리."""
    folder = folder_of(row.source_path)
    if not row.pairing_folder:
        return folder
    return f"{folder}\\{row.pairing_folder}" if folder else row.pairing_folder


def pair_folder_paths(db: Session) -> set[str]:
    """지금 존재하는 숨은 DWG·PDF 폴더의 전체 경로 목록."""
    rows = (
        db.query(MdbFile.source_path, MdbFile.pairing_folder)
        .filter(MdbFile.is_archived.is_(False), MdbFile.pairing_folder.isnot(None))
        .all()
    )
    paths = set()
    for source_path, pairing in rows:
        folder = folder_of(source_path)
        paths.add(f"{folder}\\{pairing}" if folder else pairing)
    return paths


def is_inside_pair_folder(path: str, pair_paths: set[str]) -> bool:
    return any(path == p or path.startswith(f"{p}\\") for p in pair_paths)


def rows_under_pair_folder(db: Session, path: str) -> list[MdbFile]:
    """이 경로(또는 그 하위)에 있는 숨은 DWG·PDF 폴더에 담긴 파일들."""
    return [
        r for r in db.query(MdbFile).filter(
            MdbFile.is_archived.is_(False), MdbFile.pairing_folder.isnot(None)
        ).all()
        if real_folder_of(r) == path or real_folder_of(r).startswith(f"{path}\\")
    ]


def split_out_pair_folder(db: Session, path: str, now) -> int:
    """DWG·PDF 폴더를 보통 폴더로 되돌린다 — **합쳐져 있던 자료는 다시 두 건으로 나뉜다.**

    CM이 이 폴더를 직접 고치겠다고 하면(이름 변경·위치 이동·삭제) 더 이상 "원본과 사본을 한 건으로
    묶어주는 표시"로 남을 수 없다. 한쪽만 딴 데로 가면 한 자료의 원본과 사본이 서로 다른 자리에
    놓이기 때문이다. 그래서 폴더 작업을 하기 전에 먼저 짝을 푼다
    (2026-08-17 CM 확정: "한쪽 폴더가 갑자기 바뀌면 병합이 깨져야 한다". TDB editor.py도 같은 규칙).

    MDB는 자료를 "폴더 + 자료명"으로 묶으므로(mdb_group.py), 숨겨둔 폴더 이름을 경로에 되돌려
    넣기만 하면 그 파일은 자연히 별도 자료가 된다. 반대쪽 파일은 원래 자리에 그대로 남는다.
    파일은 원래부터 그 폴더 안에 저장돼 있어 실제로 옮겨지는 파일은 없다.
    """
    rows = rows_under_pair_folder(db, path)
    split_keys = {row_key(r) for r in rows if len(rows_in_group(db, r.id)) > 1}
    for r in rows:
        folder = folder_of(r.source_path)
        filename = filename_of(r.source_path)
        new_folder = f"{folder}\\{r.pairing_folder}" if folder else r.pairing_folder
        r.pairing_folder = None
        r.source_path = f"{new_folder}\\{filename}"
        r.updated_at = now
    db.flush()
    return len(split_keys)


def ensure_registerable_folder(db: Session, path: str) -> str:
    """자료를 새로 놓을 자리로 쓸 수 있는 폴더인지 확인한다.

    숨은 DWG·PDF 폴더는 실체가 있는 폴더가 아니라 "이 파일이 원본이냐 사본이냐"를 적어둔
    표시일 뿐이라, 거기에 자료를 직접 등록하면 원본과 사본이 서로 다른 자료로 갈라진다.
    그래서 등록·이동 대상으로는 쓸 수 없게 막는다 (TDB 관리와 같은 규칙)."""
    if path and is_inside_pair_folder(path, pair_folder_paths(db)):
        raise HTTPException(
            status_code=400,
            detail="DWG·PDF 폴더에는 자료를 직접 넣을 수 없습니다. 한 단계 위 폴더를 선택하세요.",
        )
    return path


@router.get("/tree", response_model=MdbEditorTreeResponse)
def get_tree(show_hidden: bool = False, db: Session = Depends(get_db)):
    """폴더 트리. "숨김 폴더 보기" 체크에 따라 세는 기준이 달라진다 (TDB 관리와 같은 규칙).

    show_hidden=false (기본)
      자료 기준. DWG·PDF 폴더는 트리에 안 나오고, 원본과 사본이 그 안에 나뉘어 있어도
      자료는 자기 폴더에 1건으로 보인다. 괄호 숫자 = 자료 수.

    show_hidden=true
      파일이 실제로 놓인 자리 기준. DWG·PDF 폴더가 트리에 나오고 원본·사본이 각각 그 폴더
      안에 들어가 보인다. 괄호 숫자 = 파일 수 — 원본+사본 한 쌍은 1이 아니라 2로 세어진다.
    """
    rows = db.query(MdbFile).filter(MdbFile.is_archived.is_(False)).order_by(MdbFile.source_path).all()
    groups = build_groups(rows)

    folder_counts: dict[str, int] = {}
    pair_paths: set[str] = set()
    split_counts: dict[str, int] = {}
    files: list[MdbEditorFileItem] = []
    placeholders = db.query(MdbFolderPlaceholder).all()

    if show_hidden:
        for g in groups:
            for r in g.rows:
                folder = real_folder_of(r)
                if r.pairing_folder:
                    pair_paths.add(folder)
                    # 이 폴더를 고치면 이 자료가 두 건으로 나뉜다(파일이 둘 이상일 때만).
                    # 화면 경고 팝업이 이 숫자를 그대로 보여준다.
                    if len(g.rows) > 1:
                        split_counts[folder] = split_counts.get(folder, 0) + 1
                if folder:
                    folder_counts[folder] = folder_counts.get(folder, 0) + 1
                files.append(MdbEditorFileItem(
                    id=r.id, name=g.name, source_path=g.key, exts=[r.file_ext],
                    has_pdf=r.is_pdf, pdf_file_id=r.id if r.is_pdf else None,
                ))
        visible_placeholders = placeholders
    else:
        for g in groups:
            if g.folder:
                folder_counts[g.folder] = folder_counts.get(g.folder, 0) + 1
            files.append(MdbEditorFileItem(
                id=g.id, name=g.name, source_path=g.key, exts=g.exts,
                has_pdf=g.has_pdf, pdf_file_id=g.pdf_row.id if g.pdf_row else None,
            ))
        # DWG·PDF 폴더 안에 만들어 둔 빈 폴더는, 그 DWG·PDF 폴더가 안 보이는 화면에서는
        # 같이 감춘다(안 그러면 숨은 폴더 안의 폴더만 트리에 튀어나온다)
        hidden = pair_folder_paths(db)
        visible_placeholders = [p for p in placeholders if not is_inside_pair_folder(p.path, hidden)]

    folders = [
        MdbEditorFolderItem(
            path=path, file_count=count, is_placeholder=False, is_pair=path in pair_paths,
            split_count=split_counts.get(path, 0),
        )
        for path, count in folder_counts.items()
    ]
    for p in visible_placeholders:
        if p.path not in folder_counts:
            folders.append(MdbEditorFolderItem(path=p.path, file_count=0, is_placeholder=True))

    return MdbEditorTreeResponse(folders=folders, files=files)


# ---------------------------------------------------------------------------
# DWG·PDF 폴더 병합 — 원본은 DWG 폴더, 사본은 PDF 폴더에 따로 들어와 각각 별개 자료로
# 등록돼 버린 것을 나중에라도 한 자료로 합친다 (2026-08-17 CM 확정, TDB 관리와 같은 기능).
#
# 합치면 두 파일의 폴더 이름을 mdb_files.pairing_folder로 옮긴다 — 화면에서는 자료 1건으로
# 보이고, 실제 저장 위치와 다운로드 zip에는 DWG/PDF 폴더 모양이 그대로 남는다.
# ---------------------------------------------------------------------------

def split_parent(path: str) -> tuple[str, str]:
    parts = path.split("\\")
    return "\\".join(parts[:-1]), parts[-1]


def find_mdb_pair_folder_candidates(db: Session) -> list[tuple[str, str, str]]:
    """DWG 폴더와 PDF 폴더가 나란히 있는(둘 다 실제 자료 폴더로 존재하는) 상위 폴더 목록.
    (상위 폴더, DWG 폴더 전체경로, PDF 폴더 전체경로)로 돌려준다.

    한쪽만 있는 자리는 후보가 아니다 — 그런 폴더는 짝이 아니라 보통 폴더다
    (2026-08-21 CM 확정, TDB find_pair_folder_candidates와 같은 규칙).
    """
    rows = db.query(MdbFile.source_path).filter(MdbFile.is_archived.is_(False)).distinct().all()
    by_parent: dict[str, dict[str, str]] = {}
    for (source_path,) in rows:
        folder = folder_of(source_path)
        if not folder:
            continue
        parent, name = split_parent(folder)
        if is_pairing_name(name):
            by_parent.setdefault(parent, {})[name.lower()] = folder
    return [
        (parent, found["dwg"], found["pdf"])
        for parent, found in by_parent.items()
        if "dwg" in found and "pdf" in found
    ]


def docs_directly_in(db: Session, folder: str) -> list[MdbGroup]:
    """그 폴더 바로 밑(하위 폴더 제외)에 있는 자료들."""
    rows = [
        r for r in db.query(MdbFile).filter(MdbFile.is_archived.is_(False), matches_folder(folder)).all()
        if folder_of(r.source_path) == folder
    ]
    return build_groups(rows)


def mdb_mergeable_names(db: Session, dwg_path: str, pdf_path: str) -> list[str]:
    """DWG·PDF 양쪽에 이름이 겹치는 자료명 목록 (같은 이름이 한쪽에 2건 이상이면 어디에 붙일지
    알 수 없으므로 그 이름은 뺀다 — TDB matching_drawing_nos와 같은 원칙).

    이름은 **대소문자까지 정확히 같아야** 짝으로 본다 (2026-08-21 CM 확정, D-47 ④).
    대소문자만 다른 것은 mdb_case_mismatch_names가 따로 세어 알린다.
    """
    dwg_counts = Counter(g.name for g in docs_directly_in(db, dwg_path))
    pdf_counts = Counter(g.name for g in docs_directly_in(db, pdf_path))
    return sorted(
        name for name in (set(dwg_counts) & set(pdf_counts))
        if dwg_counts[name] == 1 and pdf_counts[name] == 1
    )


def mdb_case_mismatch_names(db: Session, dwg_path: str, pdf_path: str) -> list[tuple[str, str]]:
    """**대소문자만 달라서** 짝으로 안 잡히는 이름 쌍 (TDB case_mismatch_names와 같은 규칙)."""
    dwg = Counter(g.name for g in docs_directly_in(db, dwg_path))
    pdf = Counter(g.name for g in docs_directly_in(db, pdf_path))
    exact = set(dwg) & set(pdf)
    pdf_by_lower: dict[str, list[str]] = {}
    for name in pdf:
        pdf_by_lower.setdefault(name.lower(), []).append(name)

    found: list[tuple[str, str]] = []
    for name in dwg:
        if name in exact:
            continue
        others = [p for p in pdf_by_lower.get(name.lower(), []) if p not in exact]
        if len(others) == 1 and dwg[name] == 1 and pdf[others[0]] == 1:
            found.append((name, others[0]))
    return sorted(found)


def merge_one_mdb_pair(
    db: Session, parent: str, dwg_path: str, pdf_path: str, name: str, user: User, now,
) -> Optional[str]:
    """자료명 하나를 상위 폴더의 자료 1건으로 합친다. 실패 사유가 있으면 그 문자열을,
    성공하면 None을 돌려준다."""
    dwg_docs = [g for g in docs_directly_in(db, dwg_path) if g.name == name]
    pdf_docs = [g for g in docs_directly_in(db, pdf_path) if g.name == name]
    if len(dwg_docs) != 1 or len(pdf_docs) != 1:
        return "같은 이름 자료가 여러 건이라 어디에 합칠지 알 수 없습니다"

    rows = dwg_docs[0].rows + pdf_docs[0].rows
    exts = [(r.file_ext or "").lower() for r in rows]
    if len(exts) != len(set(exts)):
        return "같은 형식(확장자) 파일이 양쪽에 있어 합칠 수 없습니다"
    if find_group_rows(db, parent, name):
        return "상위 폴더에 같은 이름 자료가 이미 있습니다"

    dwg_folder = folder_basename(dwg_path)
    pdf_folder = folder_basename(pdf_path)
    for r in rows:
        r.pairing_folder = pdf_folder if r.source_path.startswith(f"{pdf_path}\\") else dwg_folder
        filename = filename_of(r.source_path)
        move_row(db, r, f"{parent}\\{filename}" if parent else filename, now)

    db.add(AuditLog(
        user_id=user.id, action="MERGE_PAIR_FOLDER", screen="MDB 편집",
        detail={"scope": "mdb", "parent": parent, "dwg_path": dwg_path, "pdf_path": pdf_path,
                "name": name, "mdb_file_ids": [r.id for r in rows]},
    ))
    return None


@router.get("/pair-folders/candidates", response_model=PairFolderCandidateList)
def get_pair_folder_candidates(db: Session = Depends(get_db), user: User = Depends(require_folder_edit)):
    candidates: list[PairFolderCandidate] = []
    for parent, dwg_path, pdf_path in find_mdb_pair_folder_candidates(db):
        matches = mdb_mergeable_names(db, dwg_path, pdf_path)
        # 대소문자만 달라 못 합치는 것도 띄운다 — 합칠 게 0건이어도 CM이 이름을 바로잡을
        # 수 있게 보여줘야 하므로 둘 다 0일 때만 후보에서 뺀다 (TDB와 같은 규칙).
        case_pairs = mdb_case_mismatch_names(db, dwg_path, pdf_path)
        if not matches and not case_pairs:
            continue
        candidates.append(PairFolderCandidate(
            path=parent, dwg_folder=folder_basename(dwg_path), pdf_folder=folder_basename(pdf_path),
            dwg_count=len(docs_directly_in(db, dwg_path)), pdf_count=len(docs_directly_in(db, pdf_path)),
            mergeable_count=len(matches),
            case_mismatch_count=len(case_pairs),
            case_mismatch_names=[f"{a} ↔ {b}" for a, b in case_pairs[:50]],
        ))
    candidates.sort(key=lambda c: c.path.lower())
    return PairFolderCandidateList(candidates=candidates)


@router.post("/pair-folders/merge", response_model=MdbPairFolderMergeResult)
def merge_pair_folders_bulk(
    body: PairFolderMergeRequest, db: Session = Depends(get_db), user: User = Depends(require_folder_edit),
):
    now = datetime.now(timezone.utc)
    all_candidates = {
        parent: (dwg_path, pdf_path)
        for parent, dwg_path, pdf_path in find_mdb_pair_folder_candidates(db)
    }
    merged = 0
    skipped: list[MdbPairFolderMergeSkipped] = []
    for parent in dict.fromkeys(p.strip("\\") for p in body.paths):
        if parent not in all_candidates:
            continue
        dwg_path, pdf_path = all_candidates[parent]
        for name in mdb_mergeable_names(db, dwg_path, pdf_path):
            reason = merge_one_mdb_pair(db, parent, dwg_path, pdf_path, name, user, now)
            if reason:
                skipped.append(MdbPairFolderMergeSkipped(path=parent, name=name, reason=reason))
            else:
                merged += 1
        ensure_placeholder_if_emptied(db, dwg_path, user)
        ensure_placeholder_if_emptied(db, pdf_path, user)
    db.commit()
    return MdbPairFolderMergeResult(merged=merged, skipped=skipped)


@router.get("/pair-folders/candidates/export")
def export_pair_folder_candidates(db: Session = Depends(get_db), user: User = Depends(require_folder_edit)):
    """[DWG·PDF 폴더 병합] 팝업의 목록을 그대로 xlsx로 내려준다."""
    candidates = get_pair_folder_candidates(db, user).candidates
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "확인"
    ws.append([
        "No", "병합 대상 폴더 경로", "DWG 자료", "PDF 자료", "합칠 수 있는 자료",
        "대소문자만 다름", "대소문자가 다른 자료명",
    ])
    for i, c in enumerate(candidates, start=1):
        ws.append([
            i, c.path, c.dwg_count, c.pdf_count, c.mergeable_count,
            c.case_mismatch_count, "\n".join(c.case_mismatch_names),
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 70, 10, 10, 14, 14, 46], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("MDB 관리", "DWG·PDF 폴더 병합")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="MDB 편집",
        detail={"scope": "mdb", "kind": "DWG·PDF 폴더 병합", "count": len(candidates)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---------------------------------------------------------------------------
# 폴더 편집
# ---------------------------------------------------------------------------

@router.post("/folders/placeholder")
def create_folder_placeholder(
    body: MdbFolderPlaceholderCreate, db: Session = Depends(get_db), user: User = Depends(require_folder_edit)
):
    path = body.path.strip("\\")
    if not path:
        raise HTTPException(status_code=400, detail="폴더 경로가 비어 있습니다")

    already_real = (
        db.query(MdbFile.id)
        .filter(MdbFile.is_archived.is_(False), matches_folder(path))
        .first()
    )
    if already_real:
        return {"ok": True, "note": "이미 자료가 있는 폴더입니다"}

    existing = db.query(MdbFolderPlaceholder).filter_by(path=path).one_or_none()
    if existing:
        return {"ok": True}

    db.add(MdbFolderPlaceholder(path=path, created_by=user.id))
    db.add(AuditLog(user_id=user.id, action="ADD_FOLDER", screen="MDB 편집", detail={"scope": "mdb", "path": path}))
    db.commit()
    return {"ok": True}


@router.post("/folders/reparent", response_model=MdbFolderReparentResult)
def reparent_folder(
    body: MdbFolderReparentRequest, db: Session = Depends(get_db), user: User = Depends(require_folder_edit)
):
    old_path = body.old_path.strip("\\")
    new_path = body.new_path.strip("\\")
    if not old_path or not new_path:
        raise HTTPException(status_code=400, detail="경로가 비어 있습니다")
    if old_path == new_path:
        return MdbFolderReparentResult(affected_files=0, affected_placeholders=0, new_path=new_path)

    now = datetime.now(timezone.utc)
    # 숨은 DWG·PDF 폴더를 고치는 경우 — 먼저 짝을 풀어 보통 폴더로 만든다(합쳐져 있던 자료는
    # 두 건으로 나뉜다). 화면에서 경고 팝업으로 미리 알리고 승인받은 뒤에 여기까지 온다.
    split_documents = split_out_pair_folder(db, old_path, now)

    old_num = leading_num(folder_basename(old_path))
    new_num = leading_num(folder_basename(new_path))
    cascade = body.cascade_numbering

    # 최상위 폴더(=공사) 자체의 이름을 바꾸는 경우, 새 공사를 따로 만들지 않고
    # 기존에 연결된 공사 레코드의 이름을 그대로 바꾼다. 그래야 자료들이 계속 같은
    # 공사를 가리키고, 옛 이름의 빈 공사 항목이 남지 않는다.
    if "\\" not in old_path:
        old_project_name = project_name_for(old_path)
        new_project_name = project_name_for(new_path)
        if old_project_name != new_project_name:
            old_project = db.query(Project).filter(Project.name == old_project_name).first()
            if old_project is not None:
                conflict = db.query(Project).filter(
                    Project.name == new_project_name, Project.id != old_project.id
                ).first()
                if conflict is None:
                    old_project.name = new_project_name
                    db.flush()  # autoflush=False라 아래 resync_project_and_year의 조회가 이 이름 변경을 곧바로 보게 한다

    rows = (
        db.query(MdbFile)
        .filter(MdbFile.is_archived.is_(False), matches_folder(old_path))
        .all()
    )
    for r in rows:
        new_full = transform_mdb_path(r.source_path, old_path, new_path, old_num, new_num, cascade)
        if new_full == r.source_path:
            continue
        r.storage_path = move_backup_file(r.source_path, new_full, r.storage_path, r.pairing_folder)
        r.source_path = new_full
        r.original_filename = filename_of(new_full)
        resync_project_and_year(db, r)
        r.updated_at = now

    # 플레이스홀더는 폴더 자체(파일명 없는 순수 경로)라 접두어 매칭을 직접 적용한다
    escaped_old = old_path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    placeholders = db.query(MdbFolderPlaceholder).filter(
        or_(MdbFolderPlaceholder.path == old_path, MdbFolderPlaceholder.path.like(f"{escaped_old}%", escape="\\"))
    ).all()
    moved_placeholders = 0
    for p in placeholders:
        if p.path == old_path:
            new_full = new_path
        else:
            remainder = p.path[len(old_path):]
            if cascade and old_num and new_num and old_num != new_num:
                segments = remainder.split("\\")
                new_segments = []
                for seg in segments:
                    if not seg:
                        new_segments.append(seg)
                        continue
                    m = re.match(r"^(\d+)", seg)
                    if m and m.group(1) == old_num:
                        seg = new_num + seg[len(old_num):]
                    new_segments.append(seg)
                remainder = "\\".join(new_segments)
            new_full = new_path + remainder
        if new_full == p.path:
            continue
        conflict = db.query(MdbFolderPlaceholder).filter(
            MdbFolderPlaceholder.path == new_full, MdbFolderPlaceholder.id != p.id
        ).one_or_none()
        if conflict:
            db.delete(p)
        else:
            p.path = new_full
        moved_placeholders += 1

    db.add(AuditLog(
        user_id=user.id, action="RENAME_FOLDER", screen="MDB 편집",
        detail={"scope": "mdb", "old_path": old_path, "new_path": new_path, "cascade_numbering": cascade,
                "affected_files": len(rows), "affected_placeholders": moved_placeholders,
                "split_documents": split_documents},
    ))
    db.commit()

    return MdbFolderReparentResult(
        affected_files=len(rows), affected_placeholders=moved_placeholders, new_path=new_path,
        split_documents=split_documents,
    )


@router.post("/folders/archive", response_model=MdbFolderArchiveResult)
def archive_folder(
    body: MdbFolderArchiveRequest, db: Session = Depends(get_db), user: User = Depends(require_folder_edit)
):
    path = body.path.strip("\\")
    if not path:
        raise HTTPException(status_code=400, detail="폴더 경로가 비어 있습니다")

    now = datetime.now(timezone.utc)
    # 숨은 DWG·PDF 폴더를 삭제하는 경우 — 먼저 짝을 풀어 이 폴더 안 파일을 별도 자료로 떼어낸다.
    # 그 자료만 보관함으로 가고 반대쪽 원본·사본은 원래 자리에 남는다 (2026-08-17 CM 확정).
    split_documents = split_out_pair_folder(db, path, now)

    rows = db.query(MdbFile).filter(MdbFile.is_archived.is_(False), matches_folder(path)).all()

    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    placeholders = db.query(MdbFolderPlaceholder).filter(
        or_(MdbFolderPlaceholder.path == path, MdbFolderPlaceholder.path.like(f"{escaped}%", escape="\\"))
    ).all()
    removed_placeholders = len(placeholders)
    for p in placeholders:
        db.delete(p)  # 자료가 없는 표시용 행이라 실제 삭제해도 데이터 손실 없음

    parent_path = "\\".join(path.split("\\")[:-1])

    if not rows:
        db.add(AuditLog(user_id=user.id, action="DELETE_EMPTY_FOLDER", screen="MDB 편집", detail={"scope": "mdb", "path": path}))
        ensure_placeholder_if_emptied(db, parent_path, user)
        db.commit()
        return MdbFolderArchiveResult(batch_id=0, archived_files=0, removed_placeholders=removed_placeholders)

    batch = ArchiveBatch(
        kind="MDB_FOLDER", label=folder_basename(path), original_path=path, archived_by=user.id,
        reason=body.reason,
    )
    db.add(batch)
    db.flush()

    for r in rows:
        r.is_archived = True
        r.archive_batch_id = batch.id
        r.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="ARCHIVE_FOLDER", screen="MDB 편집",
        detail={"scope": "mdb", "path": path, "batch_id": batch.id, "file_count": len(rows),
                "split_documents": split_documents},
    ))
    ensure_placeholder_if_emptied(db, parent_path, user)
    db.commit()

    return MdbFolderArchiveResult(
        batch_id=batch.id, archived_files=len(rows), removed_placeholders=removed_placeholders,
        split_documents=split_documents,
    )


# ---------------------------------------------------------------------------
# 자료 편집
# ---------------------------------------------------------------------------

@router.post("/files/{file_id}/update-info", response_model=MdbFileInfoUpdateResult)
def update_file_info(
    file_id: int, body: MdbFileInfoUpdate,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """"자료명·정보 변경" — 자료명(선택)·Tag No·설비유형·자료유형·Note를 한 번에 저장한다.
    소속공사·연도는 폴더 경로로 정해지므로 여기서 건드리지 않는다(위치 이동으로만 바뀜).

    자료에 원본과 PDF 사본이 함께 있으면 **양쪽 파일에 똑같이 적용한다** — 자료명을 바꾸면
    파일마다 자기 확장자는 그대로 두고 이름 부분만 바뀌고(A.xls·A.pdf → B.xls·B.pdf),
    Tag No·설비유형·자료유형·Note도 두 파일에 같은 값이 들어간다.

    설비유형·자료유형은 화면에서 체크한 것들이 슬래시로 이어진 문자열("Pump/Strainer")로
    오므로, 저장 전에 app/mdb_types.py 규칙으로 한 번 정리한다(2026-08-28 CM 확정).

    Tag No를 **새로** 달면, 그 Tag No에 걸린 "자동 적용" 이력이 이 자리에서 함께 들어간다
    (2026-09-01 CM 확정 — apply_auto_rules). 묻지 않고 넣되 무엇이 들어갔는지는 응답에 담아
    화면이 저장 직후 알려준다.
    """
    rows = group_rows_or_404(db, file_id)
    old_name = doc_name(rows[0].original_filename, rows[0].file_ext)
    now = datetime.now(timezone.utc)
    # 자동 적용은 "이번에 새로 붙은 Tag No"에만 걸린다 — 원래 달려 있던 것까지 다시 보면
    # 자료를 저장할 때마다 옛 이력이 되풀이해 발동한다.
    tags_before = {
        t.tag_no.upper() for t in db.query(MdbFileTag)
        .filter(MdbFileTag.mdb_file_id.in_([r.id for r in rows])).all()
    }

    # 화면에서 받은 자료명에 확장자가 딸려 왔으면 떼어낸다(자료명은 확장자 없는 이름이다).
    new_name = sanitize_path_component(body.filename.strip()) if body.filename else None
    if new_name:
        new_name = doc_name(new_name, file_ext_of(new_name))
    if new_name and new_name != old_name:
        folder = folder_of(rows[0].source_path)
        for r in rows:
            new_filename = f"{new_name}.{r.file_ext}" if r.file_ext else new_name
            new_source_path = f"{folder}\\{new_filename}" if folder else new_filename
            move_row(db, r, new_source_path, now)
            r.original_filename = new_filename

    # Tag No는 적은 그대로 저장한다 — 대문자로 자동 변환하지 않는다(2026-08-28 CM 확정).
    # 다만 대소문자만 다른 것은 같은 설비로 보고 하나만 남긴다(P1201C ↔ p1201c).
    # 찾기는 원래부터 대·소문자를 가리지 않으므로(mdb.py search_direct_common) 검색에는 영향이 없다.
    new_tags: list[str] = []
    seen: set[str] = set()
    for raw_tag in body.tags:
        t = raw_tag.strip()
        if not t or t.upper() in seen:
            continue
        seen.add(t.upper())
        new_tags.append(t)
    new_tags.sort(key=str.upper)
    equipment_type = normalize_types(body.equipment_type)
    doc_type = normalize_types(body.doc_type, sort=True)
    # Note는 적은 그대로 저장하되, 공백만 남은 것은 "안 적은 것"으로 본다.
    note = (body.note or "").strip() or None
    for r in rows:
        r.equipment_type = equipment_type
        r.doc_type = doc_type
        r.note = note
        r.updated_at = now
        # Tag No는 자료 단위 값이라 자료에 속한 파일 전부에 같은 것을 달아둔다 — 파일 하나로
        # 검색해도(전용자료 조회 등) 같은 자료가 잡히게 하기 위함.
        db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id == r.id).delete()
        for t in new_tags:
            db.add(MdbFileTag(mdb_file_id=r.id, tag_no=t))

    db.add(AuditLog(
        user_id=user.id, action="MDB_EDIT", screen="MDB 편집",
        detail={
            "scope": "mdb", "mdb_file_ids": [r.id for r in rows], "old_name": old_name,
            "new_name": new_name or old_name, "tags": new_tags,
            "equipment_type": equipment_type, "doc_type": doc_type, "note": note,
        },
    ))

    # 새로 붙은 Tag No에 걸린 "자동 적용" 이력을 그 자리에서 넣는다(Tag No 추가·Note 한 줄).
    # 저장과 한 번에 묶어 커밋하므로 반쪽만 반영되는 일이 없다.
    auto_applied = apply_auto_rules(
        db, rows, [t for t in new_tags if t.upper() not in tags_before], user,
    )
    db.commit()

    # 자동 적용으로 Tag No·Note가 더 붙었을 수 있어, 저장된 내용을 다시 묶어 돌려준다.
    return MdbFileInfoUpdateResult(
        **with_note_items(db, group_of_rows(db, rows)).model_dump(), auto_applied=auto_applied,
    )


@router.post("/files/{file_id}/move")
def move_file(
    file_id: int, body: MdbFileMoveRequest,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """자료 위치 이동 — 자료에 딸린 파일(원본·사본)을 모두 함께 옮긴다."""
    rows = group_rows_or_404(db, file_id)
    new_folder = ensure_registerable_folder(db, body.new_folder.strip("\\"))
    old_folder = folder_of(rows[0].source_path)
    now = datetime.now(timezone.utc)

    for r in rows:
        filename = filename_of(r.source_path)
        move_row(db, r, f"{new_folder}\\{filename}" if new_folder else filename, now)

    db.add(AuditLog(
        user_id=user.id, action="MOVE_DOCUMENT", screen="MDB 편집",
        detail={"scope": "mdb", "mdb_file_ids": [r.id for r in rows],
                "old_path": old_folder, "new_path": new_folder},
    ))
    ensure_placeholder_if_emptied(db, old_folder, user)
    db.commit()
    return {"ok": True}


@router.post("/files/{file_id}/archive", response_model=MdbFileArchiveResult)
def archive_file(
    file_id: int, body: MdbFileArchiveRequest = MdbFileArchiveRequest(),
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """자료 삭제(보관함으로) — 자료에 딸린 파일(원본·사본)이 함께 들어간다."""
    rows = group_rows_or_404(db, file_id)
    name = doc_name(rows[0].original_filename, rows[0].file_ext)

    batch = ArchiveBatch(
        kind="MDB_FILE", label=name, original_path=row_key(rows[0]), archived_by=user.id,
        reason=body.reason,
    )
    db.add(batch)
    db.flush()

    now = datetime.now(timezone.utc)
    for r in rows:
        r.is_archived = True
        r.archive_batch_id = batch.id
        r.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="ARCHIVE_DOCUMENT", screen="MDB 편집",
        detail={"scope": "mdb", "mdb_file_ids": [r.id for r in rows], "batch_id": batch.id, "name": name},
    ))
    ensure_placeholder_if_emptied(db, folder_of(rows[0].source_path), user)
    db.commit()
    return MdbFileArchiveResult(batch_id=batch.id)


@router.post("/files/{file_id}/replace", response_model=MdbReplaceResult)
async def replace_file(
    file_id: int,
    file: UploadFile = UploadFileMarker(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_document_edit),
):
    """자료 교체 — 이름·Tag No·설비유형 등은 그대로 두고 내용(파일)만 바꾼다.

    자료가 원본과 PDF 사본을 함께 갖고 있으므로, 올린 파일의 **형식(확장자)이 같은 쪽**을
    바꾼다(엑셀을 올리면 엑셀만, PDF를 올리면 PDF만). 그 형식이 아직 없는 자료면 새로 붙여
    원본·사본 세트를 채운다 — 이때 파일명은 자료명에 맞춰 저장한다(그래야 같은 자료로 묶인다).
    """
    rows = group_rows_or_404(db, file_id)
    name = doc_name(rows[0].original_filename, rows[0].file_ext)
    folder = folder_of(rows[0].source_path)
    ext = file_ext_of(file.filename)
    data = await file.read()
    now = datetime.now(timezone.utc)

    target = next((r for r in rows if (r.file_ext or "").lower() == ext), None)
    if target is not None:
        file_size, sha256_hex = save_upload(data, Path(STORAGE_ROOT) / target.storage_path)
        target.file_size = file_size
        target.sha256 = sha256_hex
        target.updated_at = now
        message = f"자료를 교체했습니다. ({ext.upper()})"
    else:
        # 이 형식이 아직 없는 자료 — 새 파일로 붙인다. 이름은 자료명 + 올린 파일의 확장자.
        pairing = pairing_folder_for_ext([(r.file_ext, r.pairing_folder) for r in rows], ext)
        filename = f"{name}.{ext}" if ext else name
        source_path = f"{folder}\\{filename}" if folder else filename
        dest = storage.mdb_file_path(source_path, pairing)
        file_size, sha256_hex = save_upload(data, dest)
        target = MdbFile(
            storage_path=storage.to_relative(dest), source_path=source_path,
            pairing_folder=pairing, original_filename=filename, file_ext=ext,
            file_size=file_size, sha256=sha256_hex, is_pdf=(ext == "pdf"),
            equipment_type=rows[0].equipment_type, doc_type=rows[0].doc_type,
            note=rows[0].note, project_id=rows[0].project_id,
            year=rows[0].year, uploaded_at=now, updated_at=now,
        )
        db.add(target)
        db.flush()
        for t in {t.tag_no for t in db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id == rows[0].id)}:
            db.add(MdbFileTag(mdb_file_id=target.id, tag_no=t))
        message = f"이 자료에 {ext.upper()}가 없어 새로 추가했습니다. (저장 이름: {filename})"

    db.add(AuditLog(
        user_id=user.id, action="APPROVE", screen="MDB 편집",
        detail={"scope": "mdb", "mdb_file_id": target.id, "name": name, "file_ext": ext,
                "added": target.id not in [r.id for r in rows], "via": "MDB 편집(자료 교체)"},
    ))
    db.commit()

    return MdbReplaceResult(file_id=rows[0].id, message=message)


def load_selected_mdb_files(db: Session, file_ids: list[int]) -> list[MdbFile]:
    """체크한 자료들의 파일 행 전부. 화면은 자료마다 대표 id 하나만 보내오므로, 여기서
    각 자료에 딸린 원본·사본까지 펼쳐야 일괄 이동·삭제가 자료를 쪼개지 않는다."""
    ids = list(dict.fromkeys(file_ids))  # 순서 유지하며 중복 제거
    if not ids:
        raise HTTPException(status_code=400, detail="선택한 자료가 없습니다")
    rows: list[MdbFile] = []
    seen: set[int] = set()
    for file_id in ids:
        group = rows_in_group(db, file_id)
        if not group:
            raise HTTPException(status_code=404, detail="선택한 자료 중 일부를 찾을 수 없습니다")
        for r in group:
            if r.id not in seen:
                seen.add(r.id)
                rows.append(r)
    return rows


@router.post("/files/move-bulk", response_model=MdbFileBulkMoveResult)
def move_files_bulk(
    body: MdbFileBulkMoveRequest, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    rows = load_selected_mdb_files(db, body.file_ids)
    new_folder = ensure_registerable_folder(db, body.new_folder.strip("\\"))
    doc_count = len({row_key(r) for r in rows})

    old_folders: set[str] = set()
    now = datetime.now(timezone.utc)
    for row in rows:
        old_path = row.source_path
        old_folders.add(folder_of(old_path))
        filename = filename_of(row.source_path)
        new_source_path = f"{new_folder}\\{filename}" if new_folder else filename
        move_row(db, row, new_source_path, now)

        db.add(AuditLog(
            user_id=user.id, action="MOVE_DOCUMENT", screen="MDB 편집",
            detail={"scope": "mdb", "mdb_file_id": row.id, "old_path": old_path, "new_path": new_source_path,
                    "bulk": True, "count": doc_count},
        ))

    for folder in old_folders:
        ensure_placeholder_if_emptied(db, folder, user)
    db.commit()
    return MdbFileBulkMoveResult(moved_files=doc_count)


@router.post("/files/archive-bulk", response_model=MdbFileBulkArchiveResult)
def archive_files_bulk(
    body: MdbFileBulkArchiveRequest, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    rows = load_selected_mdb_files(db, body.file_ids)
    names = sorted({doc_name(r.original_filename, r.file_ext) for r in rows})
    label = names[0] if len(names) == 1 else f"{names[0]} 외"

    batch = ArchiveBatch(
        kind="MDB_FILE", label=label,
        original_path=row_key(rows[0]) if len(names) == 1 else None,
        archived_by=user.id, reason=body.reason,
    )
    db.add(batch)
    db.flush()

    now = datetime.now(timezone.utc)
    old_folders: set[str] = set()
    for row in rows:
        old_folders.add(folder_of(row.source_path))
        row.is_archived = True
        row.archive_batch_id = batch.id
        row.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="ARCHIVE_DOCUMENT", screen="MDB 편집",
        detail={"scope": "mdb", "batch_id": batch.id, "doc_count": len(names),
                "file_count": len(rows), "bulk": True, "names": names},
    ))
    for folder in old_folders:
        ensure_placeholder_if_emptied(db, folder, user)
    db.commit()
    return MdbFileBulkArchiveResult(batch_id=batch.id, archived_files=len(names))


@router.post("/files/update-equipment-type-bulk", response_model=MdbFileBulkUpdateResult)
def update_equipment_type_bulk(
    body: MdbFileBulkEquipmentTypeUpdate, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """자료를 여러 건 선택했을 때의 "자료명·정보 변경" — 위치·이름·Tag No·Note는 자료마다 달라
    일괄로 못 바꾸므로 설비유형·자료유형만 골라 한 번에 지정한다(2026-08-17 CM 확정,
    2026-08-28 자료유형 추가)."""
    rows = load_selected_mdb_files(db, body.file_ids)
    equipment_type = normalize_types(body.equipment_type)
    doc_type = normalize_types(body.doc_type, sort=True)
    doc_count = len({row_key(r) for r in rows})
    now = datetime.now(timezone.utc)
    for row in rows:
        row.equipment_type = equipment_type
        row.doc_type = doc_type
        row.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="MDB_EDIT", screen="MDB 편집",
        detail={"scope": "mdb", "doc_count": doc_count, "file_count": len(rows), "bulk": True,
                "equipment_type": equipment_type, "doc_type": doc_type,
                "mdb_file_ids": [r.id for r in rows]},
    ))
    db.commit()
    return MdbFileBulkUpdateResult(updated_files=doc_count)


# ---------------------------------------------------------------------------
# 보관함 (휴지통)
# ---------------------------------------------------------------------------

def mdb_trash_target_label(batch: ArchiveBatch, names: list[str]) -> str:
    """보관함 목록 "대상" 칸 — TDB 관리 보관함(editor.py trash_target_label)과 같은 규칙.
    자료가 여러 건이면 폴더명·배치 라벨보다 실제 자료명이 알아보기 쉬워서, 가나다순 첫
    자료명 하나 + " 외"로 보여준다. 자료가 0~1건이면 그대로 label을 쓴다."""
    if len(names) > 1:
        return f"{sorted(names)[0]} 외"
    return batch.label


def mdb_trash_docs_by_batch(db: Session) -> dict[int, list[tuple[int, str]]]:
    """보관함에 남아있는 배치별 **자료** 목록 [(대표 파일ID, 자료명), ...].

    원본과 사본은 한 자료이므로 두 건으로 세지 않는다. TDB 관리와 같은 이유로 배치마다
    따로 조회하지 않고 한 번에 읽어 나눈다(editor.trash_docs_by_batch 참고)."""
    rows = (
        db.query(MdbFile.archive_batch_id, MdbFile.id, MdbFile.original_filename,
                 MdbFile.file_ext, MdbFile.source_path)
        .join(ArchiveBatch, ArchiveBatch.id == MdbFile.archive_batch_id)
        .filter(ArchiveBatch.restored_at.is_(None), ArchiveBatch.kind.in_(MDB_BATCH_KINDS))
        .all()
    )
    # (배치, 자료열쇠)마다 대표(가장 작은 id) 하나만 남긴다
    seen: dict[tuple[int, str], tuple[int, str]] = {}
    for batch_id, file_id, filename, file_ext, source_path in rows:
        key = (batch_id, group_key(source_path, file_ext))
        name = doc_name(filename, file_ext)
        if key not in seen or file_id < seen[key][0]:
            seen[key] = (file_id, name)
    grouped: dict[int, list[tuple[int, str]]] = {}
    for (batch_id, _key), value in seen.items():
        grouped.setdefault(batch_id, []).append(value)
    return grouped


@router.get("/trash", response_model=list[MdbTrashItem])
def list_trash(db: Session = Depends(get_db)):
    batches = (
        db.query(ArchiveBatch)
        .filter(ArchiveBatch.restored_at.is_(None), ArchiveBatch.kind.in_(MDB_BATCH_KINDS))
        .order_by(ArchiveBatch.archived_at.desc())
        .all()
    )
    docs_by_batch = mdb_trash_docs_by_batch(db)
    result = []
    for b in batches:
        rows = sorted(docs_by_batch.get(b.id, []))
        result.append(MdbTrashItem(
            batch_id=b.id, kind=b.kind, label=b.label,
            target_label=mdb_trash_target_label(b, [name for _id, name in rows]),
            original_path=b.original_path, file_count=len(rows), archived_at=b.archived_at,
            reason=b.reason, sample_file_id=rows[0][0] if rows else None,
        ))
    return result


@router.get("/trash/count", response_model=TrashCount)
def count_trash(db: Session = Depends(get_db)):
    """화면 위 [삭제 보관함] 버튼 옆 괄호 숫자 전용 — TDB 관리와 같은 방식."""
    count = (
        db.query(func.count(ArchiveBatch.id))
        .filter(ArchiveBatch.restored_at.is_(None), ArchiveBatch.kind.in_(MDB_BATCH_KINDS))
        .scalar()
    )
    return TrashCount(count=count or 0)


@router.post("/trash/{batch_id}/note")
def update_trash_note(
    batch_id: int,
    body: UpdateNoteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_trash_note_edit),
):
    """삭제 보관함 "비고" 칸 — TDB 관리 삭제 보관함과 같은 방식으로 삭제 사유를 나중에도 고쳐 쓸 수 있다.

    조회는 누구나, 작성(수정)은 권한(공통 > 비고 작성 > MDB 삭제 보관함 비고 작성)이 있어야
    한다(2026-08-17 CM 확정)."""
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.kind not in MDB_BATCH_KINDS:
        raise HTTPException(status_code=404, detail="삭제 보관함 항목을 찾을 수 없습니다")
    batch.reason = body.note
    db.commit()
    return {"status": "ok"}


@router.get("/trash/export")
def export_trash(db: Session = Depends(get_db), user: User = Depends(current_user)):
    items = list_trash(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "MDB삭제보관함"
    ws.append(["종류", "대상", "기존 경로", "자료 수", "삭제 시각", "비고"])
    for it in items:
        ws.append([
            "폴더" if it.kind == "MDB_FOLDER" else "자료",
            it.target_label, it.original_path, it.file_count,
            it.archived_at.strftime("%Y-%m-%d %H:%M") if it.archived_at else None,
            it.reason,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([9, 26, 50, 9, 17, 30], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("MDB 관리", "삭제 보관함")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="MDB 편집", detail={"scope": "mdb", "kind": "삭제 보관함", "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.post("/trash/{batch_id}/restore", response_model=MdbTrashRestoreResult)
def restore_trash(batch_id: int, db: Session = Depends(get_db), user: User = Depends(require_restore)):
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.restored_at is not None or batch.kind not in MDB_BATCH_KINDS:
        raise HTTPException(status_code=404, detail="삭제 보관함 항목을 찾을 수 없습니다")

    rows = db.query(MdbFile).filter(MdbFile.archive_batch_id == batch.id).all()
    doc_count = len({row_key(r) for r in rows})
    now = datetime.now(timezone.utc)
    for r in rows:
        r.is_archived = False
        r.updated_at = now
    batch.restored_at = now

    db.add(AuditLog(
        user_id=user.id, action="RESTORE_FROM_TRASH", screen="MDB 편집",
        detail={"scope": "mdb", "batch_id": batch.id, "kind": batch.kind, "label": batch.label,
                "doc_count": doc_count, "file_count": len(rows)},
    ))
    db.commit()
    return MdbTrashRestoreResult(restored_files=doc_count)


def purge_one_mdb_batch(db: Session, batch: ArchiveBatch) -> tuple[int, int, int]:
    """MDB 보관함 배치 1건을 디스크·DB에서 실제로 지운다. (자료 수, 파일 수, 확보 바이트) 반환.

    TDB 관리(editor.purge_one_batch)와 같은 성격이지만, MDB 자료는 리비전·반출 개념이 없어
    딸린 표가 Tag No 목록(mdb_file_tags)뿐이라 훨씬 단순하다. 자료 1건이 원본+사본 두 파일일
    수 있어 자료 수와 파일 수를 따로 센다.
    """
    rows = db.query(MdbFile).filter(MdbFile.archive_batch_id == batch.id).all()
    if not rows:
        return 0, 0, 0

    freed = 0
    for r in rows:
        freed += storage.delete_stored_file(r.storage_path)

    doc_count = len({row_key(r) for r in rows})
    file_ids = [r.id for r in rows]
    # 누군가 보관 목록에 담아 둔 자료면, 그 보관 줄은 남기고 가리키던 칸만 비운다 — 목록에서
    # "삭제됨"으로 보이고 본인이 지울 수 있다. 안 비우면 외래키에 걸려 완전 삭제 자체가 실패한다.
    db.query(UserFavorite).filter(UserFavorite.mdb_file_id.in_(file_ids)).update(
        {UserFavorite.mdb_file_id: None}, synchronize_session=False
    )
    db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id.in_(file_ids)).delete(synchronize_session=False)
    db.query(MdbFile).filter(MdbFile.id.in_(file_ids)).delete(synchronize_session=False)
    db.flush()
    return doc_count, len(file_ids), freed


@router.post("/trash/purge", response_model=MdbTrashPurgeResult)
def purge_trash(
    body: TrashPurgeRequest, db: Session = Depends(get_db), user: User = Depends(require_purge)
):
    """MDB 삭제 보관함에서 고른 항목을 완전히 삭제한다 — 되살릴 수 없다 (2026-08-17 CM 확정).

    여기서 지우는 것은 시스템이 갖고 있는 백업 사본(storage/MDB)이다. CM PC의 원본 MDB
    폴더는 이 화면이 원래 건드리지 않으므로 그대로 남는다.
    """
    if not body.batch_ids:
        raise HTTPException(status_code=400, detail="완전 삭제할 항목을 선택해 주세요")

    batches = (
        db.query(ArchiveBatch)
        .filter(
            ArchiveBatch.id.in_(body.batch_ids),
            ArchiveBatch.restored_at.is_(None),
            ArchiveBatch.kind.in_(MDB_BATCH_KINDS),
        )
        .all()
    )

    purged_docs = deleted_files = freed_bytes = 0
    purged_labels: list[str] = []
    for batch in batches:
        docs, files, freed = purge_one_mdb_batch(db, batch)
        purged_docs += docs
        deleted_files += files
        freed_bytes += freed
        purged_labels.append(batch.label)
        db.delete(batch)

    db.add(AuditLog(
        user_id=user.id, action="PURGE_TRASH", screen="MDB 편집",
        detail={
            "scope": "mdb", "batch_count": len(batches), "doc_count": purged_docs,
            "file_count": deleted_files, "freed_bytes": freed_bytes, "labels": purged_labels[:50],
        },
    ))
    db.commit()

    return MdbTrashPurgeResult(
        purged_batches=len(batches), purged_files=purged_docs,
        deleted_files=deleted_files, freed_bytes=freed_bytes,
        skipped_batches=len(set(body.batch_ids)) - len(batches),
    )


def build_mdb_trash_manifest_bytes(db: Session, batch: ArchiveBatch, files: list[MdbFile]) -> bytes:
    """삭제 보관함 배치 다운로드 zip에 함께 담는 목록 엑셀 — TDB 관리 삭제 보관함 zip과 같은 성격."""
    deleted_by = db.get(User, batch.archived_by)
    deleted_by_name = deleted_by.name if deleted_by else None
    deleted_at = batch.archived_at.strftime("%Y-%m-%d %H:%M") if batch.archived_at else None

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "MDB삭제보관함목록"
    ws.append([
        "No", "자료명", "연도", "공사", "기존 경로", "설비유형", "자료유형",
        "DWG", "XLSX", "ETC", "PDF", "삭제담당", "삭제시간", "문서ID", "비고",
    ])
    for no, g in enumerate(build_groups(files), start=1):
        dwg, xlsx, etc, pdf = ext_flags(g.exts)
        ws.append([
            no, g.name, g.year, short_project_label(g.project_name),
            g.key, g.equipment_type or "-", g.doc_type or "-",
            dwg, xlsx, etc, pdf,
            deleted_by_name, deleted_at, g.id, batch.reason,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 40, 8, 22, 55, 14, 14, 7, 7, 7, 7, 12, 17, 9, 30], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width
    out = BytesIO()
    neutralize_formulas(wb)
    wb.save(out)
    return out.getvalue()


@router.get("/trash/{batch_id}/download")
def download_trash_batch(batch_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.kind not in MDB_BATCH_KINDS:
        raise HTTPException(status_code=404, detail="삭제 보관함 항목을 찾을 수 없습니다")
    rows = db.query(MdbFile).filter(MdbFile.archive_batch_id == batch.id).all()
    if not rows:
        raise HTTPException(status_code=404, detail="다운로드할 자료가 없습니다")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in rows:
            path = Path(STORAGE_ROOT) / r.storage_path
            if not path.is_file():
                continue
            # 숨겨둔 DWG·PDF 폴더까지 원래 모양대로 재현한다(MDB 조회의 다운로드 zip과 같은 규칙).
            parts = [p for p in (folder_of(r.source_path), r.pairing_folder) if p]
            folder_part = "/".join(parts).replace("\\", "/")
            name = sanitize_path_component(r.original_filename)
            arcname = f"{folder_part}/{name}" if folder_part else name
            zf.write(path, arcname)
        zf.writestr(f"MDB 삭제 보관함 목록_{filename_timestamp()}.xlsx", build_mdb_trash_manifest_bytes(db, batch, rows))
    buf.seek(0)

    db.add(AuditLog(
        user_id=user.id, action="DOWNLOAD", screen="MDB 편집", detail={"scope": "mdb", "kind": "삭제 보관함", "batch_id": batch.id},
    ))
    db.commit()

    filename = f"MDB 삭제 보관함_{sanitize_path_component(batch.label)}_{filename_timestamp()}.zip"
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---------------------------------------------------------------------------
# 폐기 보관함 (2026-08-30 CM 확정) — TDB 관리(editor.py)와 같은 기능·같은 화면 구성이다.
# 다른 점은 MDB에 리비전이 없어 Rev 칸이 없다는 것뿐. 자세한 설명은 app/retire.py 참고.
# ---------------------------------------------------------------------------

def move_mdb_files_to_or_from_retired(rows: list[MdbFile], *, to_retired: bool) -> None:
    """자료에 딸린 파일(원본·사본)을 MDB 폴더 ↔ 폐기 폴더 사이에서 옮긴다.

    폐기한 자료를 원래 자리에 그대로 두면 같은 폴더에 같은 이름 자료가 새로 등록될 때 폐기본
    파일이 덮어써진다(TDB와 같은 이유). 지금 파일이 실제로 있는 자리(storage_path)에서
    가져와 새 자리로 옮기므로, 복구할 때 CM이 다른 폴더를 골라도 어긋나지 않는다.
    """
    build_dest = storage.retired_mdb_file_path if to_retired else storage.mdb_file_path
    for row in rows:
        old_dest = Path(STORAGE_ROOT) / row.storage_path
        new_dest = build_dest(row.source_path, row.pairing_folder)
        if old_dest == new_dest:
            continue
        storage.move_stored_file(old_dest, new_dest)
        # 파일이 없어 못 옮겼더라도 기록상 자리는 새 자리로 맞춘다 — 그래야 나중에 복구·
        # 다운로드가 같은 규칙으로 계산한 자리를 본다(move_backup_file과 같은 방침).
        row.storage_path = storage.to_relative(new_dest)
        if not to_retired:
            # 되살리고 나면 폐기 폴더에 빈 껍데기만 남으므로 그때그때 정리한다.
            storage.prune_empty_dirs(old_dest.parent)


@router.post("/files/retire-bulk", response_model=MdbRetireResult)
def retire_files_bulk(
    body: MdbRetireRequest, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """자료 삭제 팝업의 [폐기 보관함으로 이동]. 자료 1건마다 이력을 따로 남긴다."""
    rows = load_selected_mdb_files(db, body.file_ids)
    now = datetime.now(timezone.utc)
    old_folders: set[str] = set()
    names: list[str] = []

    # 파일 행들을 자료(폴더+자료명)별로 다시 묶는다 — 폐기 이력은 자료 1건에 하나씩이다.
    by_group: dict[str, list[MdbFile]] = {}
    for row in rows:
        by_group.setdefault(row_key(row), []).append(row)

    for group_rows in by_group.values():
        rep = sorted(group_rows, key=lambda r: r.id)[0]
        name = doc_name(rep.original_filename, rep.file_ext)
        names.append(name)
        batch = ArchiveBatch(
            kind=MDB_RETIRE_KIND, label=name, original_path=folder_of(rep.source_path),
            archived_by=user.id, reason=body.reason,
        )
        db.add(batch)
        db.flush()
        move_mdb_files_to_or_from_retired(group_rows, to_retired=True)
        old_folders.add(folder_of(rep.source_path))
        for row in group_rows:
            row.is_archived = True
            row.archive_batch_id = batch.id
            row.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="RETIRE_DOCUMENT", screen="MDB 편집",
        detail={"scope": "mdb", "doc_count": len(names), "file_count": len(rows),
                "names": names, "reason": body.reason},
    ))
    for folder in old_folders:
        ensure_placeholder_if_emptied(db, folder, user)
    db.commit()
    return MdbRetireResult(retired_files=len(names))


def retired_groups(db: Session) -> list[tuple[ArchiveBatch, MdbGroup]]:
    """폐기 보관함에 남아있는(복구하지 않은) 이력 + 그 자료. 최근 폐기한 순.

    배치마다 자료를 따로 조회하지 않고 한 번에 읽어 파이썬에서 묶는다(D-38 ㉡의 교훈)."""
    rows = (
        db.query(MdbFile)
        .join(ArchiveBatch, ArchiveBatch.id == MdbFile.archive_batch_id)
        .filter(ArchiveBatch.kind == MDB_RETIRE_KIND, ArchiveBatch.restored_at.is_(None))
        .all()
    )
    if not rows:
        return []
    tags = load_tags_map(db, [r.id for r in rows])
    by_batch: dict[int, list[MdbFile]] = {}
    for row in rows:
        by_batch.setdefault(row.archive_batch_id, []).append(row)

    batches = (
        db.query(ArchiveBatch)
        .filter(ArchiveBatch.id.in_(list(by_batch.keys())))
        .order_by(ArchiveBatch.archived_at.desc())
        .all()
    )
    result: list[tuple[ArchiveBatch, MdbGroup]] = []
    for batch in batches:
        group_rows = by_batch.get(batch.id) or []
        if not group_rows:
            continue
        group_tags = [t for r in group_rows for t in tags.get(r.id, [])]
        result.append((batch, MdbGroup(row_key(group_rows[0]), group_rows, group_tags)))
    return result


@router.get("/retired", response_model=list[MdbRetiredItem])
def list_retired(db: Session = Depends(get_db)):
    """폐기 보관함 목록. MDB 조회 화면도 같은 목록을 보므로 권한을 걸지 않는다(고치는 것만 막는다)."""
    rows = retired_groups(db)
    return [
        MdbRetiredItem(
            batch_id=batch.id, file_id=group.id, name=group.name, category=group.category,
            path=batch.original_path,
            pdf_file_id=group.pdf_row.id if group.pdf_row else None,
            retired_at=batch.archived_at, reason=batch.reason,
        )
        for batch, group in rows
    ]


@router.get("/retired/count", response_model=TrashCount)
def count_retired(db: Session = Depends(get_db)):
    """화면 위 [폐기 보관함] 버튼 옆 괄호 숫자 전용."""
    count = (
        db.query(func.count(ArchiveBatch.id))
        .filter(ArchiveBatch.kind == MDB_RETIRE_KIND, ArchiveBatch.restored_at.is_(None))
        .scalar()
    )
    return TrashCount(count=count or 0)


@router.post("/retired/{batch_id}/note")
def update_retired_note(
    batch_id: int, body: UpdateNoteRequest,
    db: Session = Depends(get_db), user: User = Depends(require_retire),
):
    """폐기 보관함 "비고" — 보는 것은 누구나, 고치는 것은 폐기 보관함 권한이 있어야 한다."""
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.kind != MDB_RETIRE_KIND:
        raise HTTPException(status_code=404, detail="폐기 보관함 항목을 찾을 수 없습니다")
    batch.reason = body.note
    db.commit()
    return {"status": "ok"}


@router.get("/retired/export")
def export_retired(
    screen: str = "MDB 관리", db: Session = Depends(get_db), user: User = Depends(current_user),
):
    """폐기 보관함 목록을 화면 표와 같은 칸으로 xlsx로 내려준다(TDB와 같되 Rev 칸이 없다)."""
    items = list_retired(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "폐기보관함"
    ws.append(["자료명", "분류", "경로", "폐기 시간", "비고"])
    for it in items:
        ws.append([
            it.name, it.category, it.path,
            it.retired_at.strftime("%Y-%m-%d %H:%M") if it.retired_at else None,
            it.reason,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([30, 12, 50, 17, 30], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename(screen, "MDB 폐기 보관함")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen=screen,
        detail={"scope": "mdb", "kind": "폐기 보관함", "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


def folder_exists(db: Session, folder: Optional[str]) -> bool:
    """그 폴더가 지금도 트리에 있는지(자료의 경로 또는 빈 폴더 표시로 존재). 최상위는 항상 있다."""
    if not folder:
        return True
    has_file = db.query(MdbFile.id).filter(MdbFile.is_archived.is_(False), matches_folder(folder)).first()
    if has_file:
        return True
    escaped = folder.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return (
        db.query(MdbFolderPlaceholder.id)
        .filter(or_(MdbFolderPlaceholder.path == folder,
                    MdbFolderPlaceholder.path.like(f"{escaped}%", escape="\\")))
        .first()
    ) is not None


@router.post("/retired/restore", response_model=RetireRestoreResult)
def restore_retired(
    body: RetireRestoreRequest, db: Session = Depends(get_db), user: User = Depends(require_retire),
):
    """폐기 자료를 원래 자리로 되돌린다. 원래 폴더가 없어졌거나 그 자리에 같은 이름 자료가
    이미 있으면 아무것도 복구하지 않고 그 목록을 돌려준다(TDB와 같은 방식)."""
    if not body.batch_ids:
        raise HTTPException(status_code=400, detail="복구할 항목을 선택하세요")

    wanted = set(body.batch_ids)
    rows = [(batch, group) for batch, group in retired_groups(db) if batch.id in wanted]
    if not rows:
        raise HTTPException(status_code=404, detail="폐기 보관함 항목을 찾을 수 없습니다")

    blocked: list[RetireRestoreBlocked] = []
    targets: list[tuple[ArchiveBatch, MdbGroup, str]] = []
    for batch, group in rows:
        chosen = body.new_paths.get(batch.id)
        new_folder = chosen if chosen is not None else (batch.original_path or "")
        if chosen:
            ensure_registerable_folder(db, chosen)
        if not folder_exists(db, new_folder):
            reason = "NO_FOLDER"
        elif find_group_rows(db, new_folder, group.name):
            reason = "NAME_TAKEN"
        else:
            targets.append((batch, group, new_folder))
            continue
        blocked.append(RetireRestoreBlocked(
            batch_id=batch.id, label=group.name, original_path=batch.original_path, reason=reason,
        ))

    if blocked:
        return RetireRestoreResult(restored=0, blocked=blocked)

    now = datetime.now(timezone.utc)
    moved: dict[str, str] = {}
    for batch, group, new_folder in targets:
        if new_folder != (batch.original_path or ""):
            moved[group.name] = new_folder
        for row in group.rows:
            filename = filename_of(row.source_path)
            row.source_path = f"{new_folder}\\{filename}" if new_folder else filename
        move_mdb_files_to_or_from_retired(group.rows, to_retired=False)
        for row in group.rows:
            resync_project_and_year(db, row)
            row.is_archived = False
            row.updated_at = now
        batch.restored_at = now

    db.add(AuditLog(
        user_id=user.id, action="RESTORE_FROM_RETIRED", screen="MDB 편집",
        detail={"scope": "mdb", "doc_count": len(targets),
                "names": [g.name for _b, g, _p in targets], "moved_paths": moved},
    ))
    db.commit()
    return RetireRestoreResult(restored=len(targets), blocked=[])


# ---------------------------------------------------------------------------
# Zip으로 폴더째 넣기 / 신규추가
#
# 같은 폴더에 이름이 같고 확장자만 다른 파일들(A.xls + A.pdf)은 자료 1건으로 들어간다 —
# 물어보지 않고 바로 합친다(2026-08-17 CM 확정). 이름이 같은 파일이 **같은 형식**으로 2개 이상
# 들어있는 경우만 비정상이라 확인창을 띄운다.
#
# 이미 같은 자리에 같은 자료명이 있으면 새 자료를 만들지 않는다: 아직 없는 형식만 그 자료에
# 붙이고, 이미 있는 형식은 덮어쓰지 않고 건너뛴다(TDB 관리와 같은 규칙). 예전에는 같은 zip을
# 두 번 올리면 자료가 두 벌 생기고 물리 파일은 조용히 덮어써졌다.
# ---------------------------------------------------------------------------

# (폴더, 자료명) → [(파일명, 확장자, 짝폴더 이름 또는 None, 내용), ...]
UploadBuckets = dict[tuple[str, str], list[tuple[str, str, Optional[str], bytes]]]


def bucket_uploads(entries: list[tuple[str, Optional[str], str, str, bytes]]) -> UploadBuckets:
    """올린 파일들을 (폴더, 자료명)별로 모은다.
    entries = [(폴더, 짝폴더 이름 또는 None, 파일명, 확장자, 내용), ...]

    자료명은 **대소문자까지 정확히 같아야** 한 자료로 묶는다 — `A.xls`와 `a.pdf`는 별개다
    (2026-08-21 CM 확정, D-47 ④. TDB Zip 등록과 같은 규칙).
    """
    buckets: UploadBuckets = {}
    for folder, pairing, filename, ext, data in entries:
        buckets.setdefault((folder, doc_name(filename, ext)), []).append((filename, ext, pairing, data))
    return buckets


def duplicate_groups(buckets: UploadBuckets) -> list[MdbDuplicateGroup]:
    """자료 하나에 같은 형식(확장자)이 2개 이상 들어있는 경우 — 어느 게 맞는 파일인지
    시스템이 판단할 수 없으므로 CM 확인이 먼저 필요하다."""
    found = []
    for (folder, name), items in sorted(buckets.items()):
        dup_exts = sorted(ext for ext, c in Counter(ext for _f, ext, _p, _d in items).items() if c > 1)
        if dup_exts:
            found.append(MdbDuplicateGroup(stem=name, folder=folder, exts=dup_exts))
    return found


def store_uploads(db: Session, buckets: UploadBuckets, user: User) -> tuple[int, int, list[str]]:
    """모아둔 파일들을 자료 단위로 등록한다. (새 자료 수, 기존 자료에 붙인 파일 수, 건너뛴 자료명)."""
    now = datetime.now(timezone.utc)
    created = attached = 0
    skipped: list[str] = []

    for (folder, name), items in buckets.items():
        existing = find_group_rows(db, folder, name)
        # 같은 이름 자료가 2건 이상이면 어디 붙일지 알 수 없으므로 새로 만들지도 붙이지도 않는다.
        if len({row_key(r) for r in existing}) > 1:
            skipped.append(name)
            continue
        existing_exts = {(r.file_ext or "").lower() for r in existing}
        is_new_doc = not existing

        for filename, ext, zip_pairing, data in items:
            if ext in existing_exts:
                skipped.append(f"{name}.{ext}")
                continue
            existing_exts.add(ext)
            # 이미 있는 자료에 붙일 때는 그 자료가 쓰는 자리를 따르고, 새 자료면 압축파일에서
            # 짝으로 인식한 폴더(DWG·PDF가 나란히 있던 자리)를 그대로 쓴다.
            pairing = pairing_folder_for_ext(
                [(r.file_ext, r.pairing_folder) for r in existing], ext
            ) if existing else zip_pairing
            stored_name = f"{name}.{ext}" if ext else name
            source_path = f"{folder}\\{stored_name}" if folder else stored_name
            dest = storage.mdb_file_path(source_path, pairing)
            file_size, sha256_hex = save_upload(data, dest)

            row = MdbFile(
                storage_path=storage.to_relative(dest), source_path=source_path,
                pairing_folder=pairing, original_filename=stored_name, file_ext=ext,
                file_size=file_size, sha256=sha256_hex, is_pdf=(ext == "pdf"),
                uploaded_at=now, updated_at=now,
            )
            if existing:
                # 기존 자료에 채워 넣는 파일 — 자료 단위 정보(설비유형·자료유형·Note·공사·연도)를
                # 물려받는다. 한 자료의 파일끼리 값이 어긋나면 화면·검색이 서로 다른 답을 낸다.
                row.equipment_type = existing[0].equipment_type
                row.doc_type = existing[0].doc_type
                row.note = existing[0].note
                row.project_id = existing[0].project_id
                row.year = existing[0].year
                attached += 1
            db.add(row)
            db.flush()
            if existing:
                for t in {t.tag_no for t in db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id == existing[0].id)}:
                    db.add(MdbFileTag(mdb_file_id=row.id, tag_no=t))
            else:
                resync_project_and_year(db, row)
        if is_new_doc and existing_exts:
            created += 1

    return created, attached, skipped


@router.post("/zip-register", response_model=MdbZipRegisterResult)
async def zip_register(
    target_path: str = Form(""),
    confirm_duplicates: bool = Form(False),
    zip_file: UploadFile = UploadFileMarker(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_zip_register),
):
    target_path = ensure_registerable_folder(db, target_path.strip("\\"))

    zip_bytes = await zip_file.read()
    try:
        zf = zipfile.ZipFile(BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="올바른 zip 파일이 아닙니다")

    raw_entries: list[tuple[str, str, bytes]] = []  # (zip 안 폴더 경로, 파일명, 내용)
    for info in zf.infolist():
        if info.is_dir():
            continue
        raw = info.filename.replace("\\", "/")
        filename = raw.split("/")[-1]
        if not filename:
            continue
        raw_entries.append(("/".join(raw.split("/")[:-1]), filename, zf.read(info)))

    # 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 둘 다 있는 자리만 짝으로 보고 자료를 합친다.
    # 한쪽만 있으면 보통 폴더로 두고 압축파일 구조 그대로 등록한다 (2026-08-21 CM 확정).
    pair_paths = pairing_folder_paths({folder for folder, _f, _d in raw_entries})

    entries: list[tuple[str, Optional[str], str, str, bytes]] = []
    for raw_folder, filename, data in raw_entries:
        parent, pairing = split_pairing_folder(raw_folder, pair_paths)
        parent = parent.replace("/", "\\")
        folder = f"{target_path}\\{parent}" if target_path and parent else (target_path or parent)
        entries.append((folder, pairing, filename, file_ext_of(filename), data))

    buckets = bucket_uploads(entries)
    duplicates = duplicate_groups(buckets)
    if duplicates and not confirm_duplicates:
        return MdbZipRegisterResult(
            created_files=0, target_path=target_path,
            needs_confirmation=True, duplicates=duplicates,
        )

    created, attached, skipped = store_uploads(db, buckets, user)

    db.add(AuditLog(
        user_id=user.id, action="ZIP_REGISTER", screen="MDB 편집",
        detail={"scope": "mdb", "target_path": target_path, "created": created,
                "attached": attached, "skipped": skipped[:50]},
    ))
    db.commit()

    return MdbZipRegisterResult(
        created_files=created, attached_files=attached, skipped_existing=skipped,
        target_path=target_path,
    )


@router.post("/register", response_model=MdbBulkRegisterResult)
async def register_files(
    target_path: str = Form(""),
    confirm_duplicates: bool = Form(False),
    files: list[UploadFile] = UploadFileMarker(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_document_edit),
):
    target_path = ensure_registerable_folder(db, target_path.strip("\\"))

    entries = [
        (target_path, None, upload.filename, file_ext_of(upload.filename), await upload.read())
        for upload in files
    ]
    buckets = bucket_uploads(entries)
    duplicates = duplicate_groups(buckets)
    if duplicates and not confirm_duplicates:
        return MdbBulkRegisterResult(
            created_files=0, target_path=target_path,
            needs_confirmation=True, duplicates=duplicates,
        )

    created, attached, skipped = store_uploads(db, buckets, user)

    db.add(AuditLog(
        user_id=user.id, action="REGISTER", screen="MDB 편집",
        detail={"scope": "mdb", "via": "MDB 편집(신규추가)", "target_path": target_path,
                "created": created, "attached": attached, "skipped": skipped[:50]},
    ))
    db.commit()

    return MdbBulkRegisterResult(
        created_files=created, attached_files=attached, skipped_existing=skipped,
        target_path=target_path,
    )
