"""폴더·자료 편집 (기존 수정과 무관 — CM이 업체 반출/반입 없이 직접 정리할 때 쓰는 화면).

- 폴더는 실제 테이블이 없는 가상 개념: documents.source_path 문자열로만 존재한다.
  이름 변경·위치 이동은 결국 그 문자열(접두어)을 바꾸는 일괄 작업이다.
- 빈 폴더는 folder_placeholders에 표시용으로만 남긴다 (자료가 생기면 무의미해짐).
- 삭제는 documents.is_archived=true로만 숨긴다(D-6). archive_batches가 "보관함" 한 건씩을
  묶어 되살리기를 가능하게 한다.
- 검수 절차 없이 즉시 반영된다(이 화면 자체가 CM 본인 편집이라 승인 대상이 아님).
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
from app.models import (
    ArchiveBatch,
    AuditLog,
    Distribution,
    Document,
    File,
    FolderPlaceholder,
    ImportIssue,
    User,
    UserFavorite,
)
from app.permissions import require_permission
from app.retire import TDB_RETIRE_KIND
from app.rev_naming import (
    applies_to, document_display_name, file_display_name, new_name_tail_problem, new_upload_name,
    upload_base_name, upload_tail_problem,
)
from app.routers.imports import (
    create_revision_set,
    ensure_matching_stems,
    file_ext_of,
    format_rev_label,
    promote_to_current,
)
from app.routers.mdb import ext_flags
from app.schemas import (
    BulkRegisterResult,
    BulkRegisterUnmatched,
    DocumentArchiveRequest,
    DocumentArchiveResult,
    DocumentBulkArchiveRequest,
    DocumentBulkArchiveResult,
    DocumentBulkMoveRequest,
    DocumentBulkMoveResult,
    DocumentMoveRequest,
    DocumentRenameRequest,
    EditorDocItem,
    EditorFolderItem,
    EditorTreeResponse,
    ExistingDocRevLookup,
    FolderArchiveRequest,
    FolderArchiveResult,
    FolderPlaceholderCreate,
    FolderReparentRequest,
    FolderReparentResult,
    PairFolderCandidate,
    PairFolderCandidateList,
    PairFolderMergeRequest,
    PairFolderMergeResult,
    PairFolderMergeSkipped,
    PartialFilesExportRequest,
    ReplaceBulkMismatch,
    ReplaceBulkResult,
    ReplaceResult,
    RetireRequest,
    RetireResult,
    RetireRestoreBlocked,
    RetireRestoreRequest,
    RetireRestoreResult,
    RetiredItem,
    TrashCount,
    TrashItem,
    TrashPurgeRequest,
    TrashPurgeResult,
    TrashRestoreResult,
    UpdateNoteRequest,
    ZipRegisterDuplicate,
    ZipRegisterExisting,
    ZipRegisterResult,
    ZipRegisterSkipped,
)
from app.utils import (
    INTERNAL_VENDOR,
    build_export_filename,
    classification_from_path,
    content_disposition_header,
    duplicate_ext_groups,
    filename_timestamp,
    is_pairing_name,
    neutralize_formulas,
    pairing_folder_for_ext,
    pairing_folder_paths,
    save_upload,
    sanitize_path_component,
    split_pairing_folder,
)

router = APIRouter(prefix="/editor", tags=["editor"])

# 권한.xlsx 기준(2026-08-12 CM 확정) 리프 권한 — role=ADMIN은 자동 통과.
require_folder_edit = require_permission("screen.tdb_editor.folder")
require_document_edit = require_permission("screen.tdb_editor.document")
require_zip_register = require_permission("screen.tdb_editor.zip_register")
require_restore = require_permission("screen.tdb_editor.restore")
# 폐기 보관함 — 목록 조회는 권한 없이 열리고(조회 화면에서도 이력을 봐야 한다), 복구·비고
# 작성만 이 권한으로 막는다 (2026-08-30 CM 확정).
require_retire = require_permission("screen.tdb_editor.retire")
require_trash_note_edit = require_permission("common.note_edit.tdb_trash")
# 삭제 보관함 완전삭제는 권한 트리로 넘기지 않고 관리자 전용으로 고정한다(2026-08-17 CM 확정,
# D-38 개정 — 삭제 보관함 자체가 사실상 관리자만 쓰는 기능이라 별도 그룹 토글이 무의미했다).
require_purge = require_admin

# archive_batches 표는 MDB 편집 화면과 같이 쓴다(kind로만 구분). TDB 보관함 목록에 MDB에서
# 지운 것이 섞여 보이지 않도록 조회할 때마다 이 두 종류로 한정한다.
TDB_BATCH_KINDS = ("FOLDER", "DOCUMENT")


# ---------------------------------------------------------------------------
# 경로 문자열 유틸 — 폴더가 실체가 아니라 문자열이므로, 편집은 전부 문자열 계산이다.
# ---------------------------------------------------------------------------

def folder_basename(path: str) -> str:
    parts = [p for p in path.replace("/", "\\").split("\\") if p]
    return parts[-1] if parts else path


def leading_num(name: str) -> Optional[str]:
    m = re.match(r"^\s*(\d+)", name)
    return m.group(1) if m else None


def transform_path(path: str, old_path: str, new_path: str, old_num: Optional[str], new_num: Optional[str], cascade: bool) -> str:
    """old_path 접두어를 new_path로 바꾼다. cascade면 하위 세그먼트의 선행 번호(old_num)도 new_num으로 맞춘다."""
    if path == old_path:
        return new_path
    remainder = path[len(old_path):]  # "\\5.11 ..." 형태 (선행 backslash 포함)
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
    return new_path + remainder


def matches_folder(source_path_col, path: str):
    """이 폴더 자신이거나 그 하위(자식 경로 전부)인지. documents.py apply_filters의 path 필터와
    동일한 방식 — 접두어 뒤에 구분자를 따로 붙이지 않고 와일드카드가 그대로 이어받게 한다.
    (한 번 구분자를 직접 넣었다가 PostgreSQL이 그 백슬래시를 LIKE 이스케이프 문자로 먹어버려
    틀린 적이 있다 — 반드시 이 형태를 유지할 것.)
    """
    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return or_(source_path_col == path, source_path_col.like(f"{escaped}%", escape="\\"))


def ensure_placeholder_if_emptied(db: Session, path: Optional[str], user: User) -> None:
    """자료 이동·삭제(보관함행)로 어떤 폴더의 마지막 자료가 빠져나가 그 폴더가(하위 포함) 완전히
    비게 되면, 표시용 placeholder를 자동으로 남겨 폴더 자체가 화면에서 사라지지 않게 한다
    (CM 지시: 자료가 없다고 폴더까지 안 보이면 안 됨 — 2026-08-15)."""
    if not path:
        return
    still_has_docs = (
        db.query(Document.id)
        .filter(Document.is_archived.is_(False), matches_folder(Document.source_path, path))
        .first()
    )
    if still_has_docs:
        return
    existing = db.query(FolderPlaceholder).filter_by(path=path).one_or_none()
    if existing:
        return
    db.add(FolderPlaceholder(path=path, created_by=user.id))
    db.add(AuditLog(
        user_id=user.id, action="ADD_FOLDER", screen="폴더·자료 편집",
        detail={"path": path, "auto": "자료가 빠져나가 빈 폴더가 되어 자동 생성됨"},
    ))


# ---------------------------------------------------------------------------
# 숨은 DWG·PDF 폴더 — 실제 폴더 행이 없고 files.pairing_folder 값으로만 존재한다.
# 평소 트리에서는 감춰 자료를 1건으로 보여주지만, "숨김 폴더 보기"를 켜면 트리에 나오고
# 일반 폴더와 똑같이 편집 버튼을 쓸 수 있다 (2026-08-16 CM 확정).
# ---------------------------------------------------------------------------

def source_path_eq(path: str):
    """자료 폴더 비교. 최상위(폴더 없음)는 DB에 NULL로 들어 있어 ==로는 안 걸린다."""
    return Document.source_path.is_(None) if not path else Document.source_path == path


def split_parent(path: str) -> tuple[str, str]:
    parts = [p for p in path.replace("/", "\\").split("\\") if p]
    return "\\".join(parts[:-1]), (parts[-1] if parts else "")


def pair_folder_paths(db: Session) -> set[str]:
    """지금 존재하는 숨은 DWG·PDF 폴더의 전체 경로 모음."""
    rows = (
        db.query(Document.source_path, File.pairing_folder)
        .join(File, File.document_id == Document.id)
        .filter(
            Document.is_archived.is_(False),
            File.is_current.is_(True),
            File.pairing_folder.isnot(None),
        )
        .distinct()
        .all()
    )
    return {f"{sp}\\{pf}" if sp else pf for sp, pf in rows}


def is_inside_pair_folder(path: str, pair_paths: set[str]) -> bool:
    """그 경로가 숨은 DWG·PDF 폴더 *안*에 들어 있는지(폴더 자신은 제외)."""
    return any(path.startswith(p + "\\") for p in pair_paths)


def find_pair_folder(db: Session, path: str) -> Optional[tuple[str, str]]:
    """path가 숨은 DWG·PDF 폴더를 가리키면 (자료 폴더 경로, 그 폴더 이름)을 돌려준다."""
    parent, name = split_parent(path)
    if not name:
        return None
    hit = (
        db.query(File.id)
        .join(Document, File.document_id == Document.id)
        .filter(
            Document.is_archived.is_(False),
            source_path_eq(parent),
            File.is_current.is_(True),
            File.pairing_folder == name,
        )
        .first()
    )
    return (parent, name) if hit else None


def docs_in_pair_folder(db: Session, parent: str, name: str) -> list[Document]:
    """그 DWG·PDF 폴더 안에 현재본 파일이 들어 있는 자료들."""
    return (
        db.query(Document)
        .join(File, File.document_id == Document.id)
        .filter(
            Document.is_archived.is_(False),
            source_path_eq(parent),
            File.is_current.is_(True),
            File.pairing_folder == name,
        )
        .distinct()
        .all()
    )


def split_out_pair_folder(db: Session, parent: str, name: str, user: User, now) -> int:
    """DWG·PDF 폴더를 보통 폴더로 되돌린다 — **합쳐져 있던 자료는 다시 두 건으로 나뉜다.**

    CM이 이 폴더를 직접 고치겠다고 하면(이름 변경·위치 이동·삭제) 더 이상 "원본과 사본을 한 건으로
    묶어주는 표시"로 남을 수 없다. 한쪽만 딴 데로 가면 한 자료의 원본과 사본이 서로 다른 자리에
    놓이기 때문이다. 그래서 폴더 작업을 하기 전에 먼저 짝을 푼다
    (2026-08-17 CM 확정: "한쪽 폴더가 갑자기 바뀌면 병합이 깨져야 한다").

    - 폴더 안 파일이 그 자료의 전부면 → 새 자료를 만들 것 없이 자료가 이 폴더로 내려온다.
    - 반대쪽(원본 또는 사본)이 따로 있으면 → 폴더 안 파일만 **새 자료로 떨어져 나온다.**
      **리비전 이력·반출 이력은 원래 자료에 그대로 남는다** — 이력은 자료에 붙어 있고 원래 자료의
      정체(자료ID·도면번호)가 남는 쪽에 딸려 가는 게 맞기 때문. 떨어져 나온 자료는 지금 파일
      하나만 가진 새 자료가 된다.

    파일은 원래부터 그 폴더 안에 저장돼 있어서 실제로 옮겨지는 파일은 없다(경로 계산이
    "자료폴더 + 짝폴더"에서 "자료폴더"로 바뀔 뿐 결과가 같다).
    """
    new_path = f"{parent}\\{name}" if parent else name
    split = 0
    for doc in docs_in_pair_folder(db, parent, name):
        files = db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
        inside = [f for f in files if f.pairing_folder == name]
        outside = [f for f in files if f.pairing_folder != name]
        if not inside:
            continue

        if not outside:
            # 자료 전체가 이 폴더에 있다 — 자료를 이 폴더로 내리기만 하면 된다.
            for f in inside:
                f.pairing_folder = None
            doc.source_path = new_path
            doc.updated_at = now
            continue

        # 반대쪽이 남아 있다 — 폴더 안 파일만 새 자료로 떼어낸다.
        new_doc = Document(
            doc_class=doc.doc_class, drawing_no=doc.drawing_no, title=doc.title,
            category=doc.category, discipline=doc.discipline, doc_type=doc.doc_type,
            isbl_osbl=doc.isbl_osbl, elevation=doc.elevation, area=doc.area,
            source_path=new_path, is_isometric=doc.is_isometric, equipment_tag=doc.equipment_tag,
            project_id=doc.project_id, current_rev=max(f.rev for f in inside),
            status="ACTIVE", created_at=now, updated_at=now,
        )
        db.add(new_doc)
        db.flush()
        for f in inside:
            f.document_id = new_doc.id
            f.pairing_folder = None
        new_doc.has_dwg = any(f.file_ext == "dwg" for f in inside)
        new_doc.has_pdf = any(f.file_ext == "pdf" for f in inside)
        doc.has_dwg = any(f.file_ext == "dwg" for f in outside)
        doc.has_pdf = any(f.file_ext == "pdf" for f in outside)
        doc.updated_at = now
        split += 1

        db.add(AuditLog(
            user_id=user.id, action="SPLIT_PAIR_FOLDER", screen="폴더·자료 편집", document_id=doc.id,
            detail={"pair_folder": new_path, "drawing_no": doc.drawing_no,
                    "new_document_id": new_doc.id,
                    "moved_exts": sorted(f.file_ext for f in inside),
                    "note": "DWG·PDF 폴더를 편집해 병합이 풀림 — 리비전·반출 이력은 원래 자료에 남음"},
        ))
    db.flush()
    return split


def ensure_not_pair_folder(db: Session, path: str, action: str = "자료를 새로 등록할") -> None:
    """숨은 DWG·PDF 폴더와 같은 자리를 새로 차지하지 못하게 막는다.

    그 폴더는 이미 있는 자료의 파일이 놓인 칸이라, 여기에 자료를 새로 등록하거나 같은 이름의
    보통 폴더를 만들면 **한 이름이 두 가지 뜻**이 된다 — 조회 화면은 보통 폴더로, 관리 화면은
    숨은 짝 폴더로 읽어 같은 폴더에 서로 다른 건수가 보인다. 2026-08-16에 `0.PDF` 폴더를
    `PDF`로 이름 변경하면서 실제로 이 사고가 났다(D-47).
    """
    if path and find_pair_folder(db, path):
        name = folder_basename(path)
        raise HTTPException(
            status_code=400,
            detail=(f"'{name}'은(는) 원본과 사본을 묶어 두는 숨은 폴더라 여기에 {action} 수 없습니다. "
                    f"한 단계 위 폴더를 쓰거나 다른 이름을 지정해 주세요."),
        )


CHECKED_OUT_DOC_MESSAGE = "이 자료는 현재 반출(수정용) 중이라 편집할 수 없습니다. 반입이 완료된 뒤 다시 시도하세요."
CHECKED_OUT_FOLDER_MESSAGE = "이 폴더 안에 반출(수정용) 중인 자료가 있어 편집할 수 없습니다. 반입이 완료된 뒤 다시 시도하세요."


def ensure_not_checked_out(doc: Document) -> None:
    """반출(수정용)돼 아직 반입되지 않은 자료는 이름·위치·내용을 건드리면 반출본과 어긋나므로,
    모든 편집은 반입이 완료된 뒤(status가 CHECKED_OUT을 벗어난 뒤)에만 허용한다."""
    if doc.status == "CHECKED_OUT":
        raise HTTPException(status_code=409, detail=CHECKED_OUT_DOC_MESSAGE)


def ensure_folder_not_checked_out(db: Session, path: str) -> None:
    """폴더 이름 변경·위치 이동·삭제는 그 안의 자료 전부에 영향을 주므로, 반출 중인 자료가
    하나라도 있으면 막는다. 숨은 DWG·PDF 폴더도 그 안 파일이 딸린 자료를 같이 본다."""
    checked_out = (
        db.query(Document.id)
        .filter(
            Document.is_archived.is_(False),
            Document.status == "CHECKED_OUT",
            matches_folder(Document.source_path, path),
        )
        .first()
    )
    if not checked_out:
        pair = find_pair_folder(db, path)
        if pair and any(d.status == "CHECKED_OUT" for d in docs_in_pair_folder(db, *pair)):
            checked_out = True
    if checked_out:
        raise HTTPException(status_code=409, detail=CHECKED_OUT_FOLDER_MESSAGE)


def move_current_file(old_source_path: Optional[str], new_source_path: str, drawing_no: str, file_row: File) -> None:
    """자료의 '최신' 물리 파일 위치를 새 폴더 경로에 맞게 옮긴다 (분류 재정리가 디스크에도 보이도록).

    숨은 DWG·PDF 폴더는 자료를 따라 그대로 옮겨간다(새 위치에서도 같은 모양을 유지).
    이력(구본) 파일은 문서ID 기반 폴더라 경로 변경과 무관하게 그대로 둔다.
    """
    rev, branch = file_row.rev, file_row.branch
    old_dest = storage.latest_file_path(old_source_path, drawing_no, file_row.file_ext, file_row.pairing_folder, rev=rev, branch=branch)
    new_dest = storage.latest_file_path(new_source_path, drawing_no, file_row.file_ext, file_row.pairing_folder, rev=rev, branch=branch)
    if storage.move_stored_file(old_dest, new_dest):
        file_row.file_path = storage.to_relative(new_dest)


def rename_current_file(source_path: Optional[str], old_drawing_no: str, new_drawing_no: str, file_row: File) -> None:
    """자료명(drawing_no) 변경 시 '최신' 물리 파일명도 함께 맞춘다 (폴더는 그대로, 파일명만 변경).

    이력(구본) 파일은 문서ID 기반 폴더·옛 도면번호로 그대로 남는다(과거 시점 이름이라 자연스러움).
    """
    rev, branch = file_row.rev, file_row.branch
    old_dest = storage.latest_file_path(source_path, old_drawing_no, file_row.file_ext, file_row.pairing_folder, rev=rev, branch=branch)
    new_dest = storage.latest_file_path(source_path, new_drawing_no, file_row.file_ext, file_row.pairing_folder, rev=rev, branch=branch)
    if storage.move_stored_file(old_dest, new_dest):
        file_row.file_path = storage.to_relative(new_dest)


# ---------------------------------------------------------------------------
# 원본·사본(DWG·PDF) 폴더 병합 — 초기 자료 적재 등으로 DWG 폴더와 PDF 폴더가 각각 별개의
# 보통 폴더로 등록돼 버린 경우(D-33/D-34가 생기기 전에 들어온 자료), 나중에라도 CM이
# 골라서 하나의 자료(숨은 DWG·PDF 짝 폴더)로 합칠 수 있게 한다 (2026-08-16 CM 확정).
# ---------------------------------------------------------------------------

def find_pair_folder_candidates(db: Session) -> list[tuple[str, str, str]]:
    """DWG 폴더와 PDF 폴더가 나란히 있는(둘 다 실제 자료 폴더로 존재하는) 상위 폴더 목록.
    (상위 폴더, DWG 폴더 전체경로, PDF 폴더 전체경로)로 돌려준다.

    한쪽만 있는 자리는 후보가 아니다 — 그런 폴더는 짝이 아니라 보통 폴더이기 때문
    (2026-08-21 CM 확정). 원본이 상위 폴더에 그냥 있고 PDF 폴더만 따로 있는 자리도
    마찬가지로 후보로 잡지 않는다.
    """
    rows = (
        db.query(Document.source_path)
        .filter(Document.is_archived.is_(False), Document.source_path.isnot(None))
        .distinct()
        .all()
    )
    by_parent: dict[str, dict[str, str]] = {}
    for (path,) in rows:
        parent, name = split_parent(path)
        if is_pairing_name(name):
            by_parent.setdefault(parent, {})[name.lower()] = path
    return [
        (parent, found["dwg"], found["pdf"])
        for parent, found in by_parent.items()
        if "dwg" in found and "pdf" in found
    ]


def names_in_folder(db: Session, path: str) -> Counter:
    """그 폴더에 바로 담긴 자료명별 건수."""
    return Counter(
        no for (no,) in db.query(Document.drawing_no).filter(
            Document.is_archived.is_(False), Document.source_path == path
        )
    )


def matching_drawing_nos(db: Session, dwg_path: str, pdf_path: str) -> list[str]:
    """dwg_path·pdf_path 양쪽에 이름이 겹치는 도면번호 목록 (같은 이름이 한쪽에 2건 이상이면
    어디에 붙일지 알 수 없으므로 그 이름은 뺀다 — find_existing_document과 같은 원칙).

    이름은 **대소문자까지 정확히 같아야** 짝으로 본다 (2026-08-21 CM 확정, D-47 ④).
    대소문자만 다른 것은 case_mismatch_names가 따로 세어 CM에게 알린다.
    """
    dwg, pdf = names_in_folder(db, dwg_path), names_in_folder(db, pdf_path)
    return sorted(
        no for no in (set(dwg) & set(pdf))
        if dwg[no] == 1 and pdf[no] == 1
    )


def case_mismatch_names(db: Session, dwg_path: str, pdf_path: str) -> list[tuple[str, str]]:
    """**대소문자만 달라서** 짝으로 안 잡히는 이름 쌍 [(DWG 쪽 이름, PDF 쪽 이름), ...].

    합쳐주지는 않고 목록으로만 알린다 — 어느 쪽 표기가 맞는지는 CM이 정할 문제다. CM이
    [자료명 변경]으로 한쪽 이름을 고치면 그 다음부터 정상 병합 대상이 된다.
    """
    dwg, pdf = names_in_folder(db, dwg_path), names_in_folder(db, pdf_path)
    exact = set(dwg) & set(pdf)
    pdf_by_lower: dict[str, list[str]] = {}
    for no in pdf:
        pdf_by_lower.setdefault(no.lower(), []).append(no)

    found: list[tuple[str, str]] = []
    for no in dwg:
        if no in exact:
            continue
        others = [p for p in pdf_by_lower.get(no.lower(), []) if p not in exact]
        if len(others) == 1 and dwg[no] == 1 and pdf[others[0]] == 1:
            found.append((no, others[0]))
    return sorted(found)


def move_file_to_pair_slot(
    old_source_path: Optional[str], old_pairing: Optional[str],
    new_source_path: Optional[str], new_pairing: Optional[str],
    drawing_no: str, file_row: File,
) -> None:
    """move_current_file과 달리, 폴더뿐 아니라 DWG·PDF 짝 폴더 자체도 함께 바뀌는 경우에 쓴다."""
    rev, branch = file_row.rev, file_row.branch
    old_dest = storage.latest_file_path(old_source_path, drawing_no, file_row.file_ext, old_pairing, rev=rev, branch=branch)
    new_dest = storage.latest_file_path(new_source_path, drawing_no, file_row.file_ext, new_pairing, rev=rev, branch=branch)
    file_row.pairing_folder = new_pairing
    if storage.move_stored_file(old_dest, new_dest):
        file_row.file_path = storage.to_relative(new_dest)


def merge_one_pair_folder_document(
    db: Session, parent: str, dwg_path: str, pdf_path: str, drawing_no: str, user: User, now,
) -> Optional[str]:
    """DWG 쪽 자료를 살리고 PDF 쪽 자료를 그 안에 합친다. 실패 사유가 있으면 그 문자열을,
    성공하면 None을 돌려준다.

    이력(리비전)이 없는 가장 단순한 경우(파일이 딱 1개씩, rev0)만 자동 병합 대상으로 삼는다 —
    양쪽에 리비전 이력이 있으면 어느 쪽 이력을 남길지 CM이 정할 문제라 자동으로 처리하지 않는다.
    """
    dwg_doc = db.query(Document).filter(
        Document.is_archived.is_(False), Document.source_path == dwg_path,
        Document.drawing_no == drawing_no,
    ).one_or_none()
    pdf_doc = db.query(Document).filter(
        Document.is_archived.is_(False), Document.source_path == pdf_path,
        Document.drawing_no == drawing_no,
    ).one_or_none()
    if dwg_doc is None or pdf_doc is None:
        return "자료를 찾을 수 없습니다"
    if dwg_doc.status == "CHECKED_OUT" or pdf_doc.status == "CHECKED_OUT":
        return CHECKED_OUT_DOC_MESSAGE

    dwg_files = db.query(File).filter(File.document_id == dwg_doc.id).all()
    pdf_files = db.query(File).filter(File.document_id == pdf_doc.id).all()
    if len(dwg_files) != 1 or len(pdf_files) != 1:
        return "리비전 이력이 있어 자동 병합 대상이 아닙니다"
    dwg_file, pdf_file = dwg_files[0], pdf_files[0]
    if not dwg_file.is_current or not pdf_file.is_current or dwg_file.rev != pdf_file.rev:
        return "리비전 상태가 서로 달라 병합할 수 없습니다"

    dwg_name = folder_basename(dwg_path)
    pdf_name = folder_basename(pdf_path)
    move_file_to_pair_slot(dwg_path, None, parent, dwg_name, drawing_no, dwg_file)
    move_file_to_pair_slot(pdf_path, None, parent, pdf_name, drawing_no, pdf_file)
    pdf_file.document_id = dwg_doc.id

    dwg_doc.source_path = parent or None
    dwg_doc.has_dwg = dwg_doc.has_dwg or pdf_doc.has_dwg
    dwg_doc.has_pdf = dwg_doc.has_pdf or pdf_doc.has_pdf
    dwg_doc.updated_at = now

    batch = ArchiveBatch(
        kind="DOCUMENT", label=pdf_doc.drawing_no, original_path=pdf_doc.source_path,
        archived_by=user.id, reason=f"DWG·PDF 폴더 병합으로 자료 #{dwg_doc.id}에 합쳐짐",
    )
    db.add(batch)
    db.flush()
    pdf_doc.is_archived = True
    pdf_doc.archive_batch_id = batch.id
    pdf_doc.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="MERGE_PAIR_FOLDER", screen="폴더·자료 편집", document_id=dwg_doc.id,
        detail={"parent": parent, "dwg_path": dwg_path, "pdf_path": pdf_path, "drawing_no": drawing_no,
                "merged_document_id": pdf_doc.id},
    ))
    return None


@router.get("/pair-folders/candidates", response_model=PairFolderCandidateList)
def get_pair_folder_candidates(db: Session = Depends(get_db), user: User = Depends(require_folder_edit)):
    candidates: list[PairFolderCandidate] = []
    for parent, dwg_path, pdf_path in find_pair_folder_candidates(db):
        matches = matching_drawing_nos(db, dwg_path, pdf_path)
        # 대소문자만 달라 못 합치는 것도 목록에 띄운다 — 합칠 게 0건이어도 CM이 이름을
        # 바로잡을 수 있게 보여줘야 하므로, 둘 다 0일 때만 후보에서 뺀다.
        case_pairs = case_mismatch_names(db, dwg_path, pdf_path)
        if not matches and not case_pairs:
            continue
        dwg_count = db.query(Document.id).filter(
            Document.is_archived.is_(False), Document.source_path == dwg_path,
        ).count()
        pdf_count = db.query(Document.id).filter(
            Document.is_archived.is_(False), Document.source_path == pdf_path,
        ).count()
        candidates.append(PairFolderCandidate(
            path=parent, dwg_folder=folder_basename(dwg_path), pdf_folder=folder_basename(pdf_path),
            dwg_count=dwg_count, pdf_count=pdf_count, mergeable_count=len(matches),
            case_mismatch_count=len(case_pairs),
            case_mismatch_names=[f"{a} ↔ {b}" for a, b in case_pairs[:50]],
        ))
    candidates.sort(key=lambda c: c.path.lower())
    return PairFolderCandidateList(candidates=candidates)


@router.post("/pair-folders/merge", response_model=PairFolderMergeResult)
def merge_pair_folders_bulk(
    body: PairFolderMergeRequest, db: Session = Depends(get_db), user: User = Depends(require_folder_edit),
):
    now = datetime.now(timezone.utc)
    all_candidates = {parent: (dwg_path, pdf_path) for parent, dwg_path, pdf_path in find_pair_folder_candidates(db)}
    merged = 0
    skipped: list[PairFolderMergeSkipped] = []
    for parent in dict.fromkeys(p.strip("\\") for p in body.paths):
        if parent not in all_candidates:
            continue
        dwg_path, pdf_path = all_candidates[parent]
        for drawing_no in matching_drawing_nos(db, dwg_path, pdf_path):
            reason = merge_one_pair_folder_document(db, parent, dwg_path, pdf_path, drawing_no, user, now)
            if reason:
                skipped.append(PairFolderMergeSkipped(path=parent, drawing_no=drawing_no, reason=reason))
            else:
                merged += 1
        ensure_placeholder_if_emptied(db, dwg_path, user)
        ensure_placeholder_if_emptied(db, pdf_path, user)
    db.commit()
    return PairFolderMergeResult(merged=merged, skipped=skipped)


# ---------------------------------------------------------------------------
# 트리 조회
# ---------------------------------------------------------------------------

@router.get("/tree", response_model=EditorTreeResponse)
def get_tree(show_hidden: bool = False, db: Session = Depends(get_db)):
    """폴더 트리. "숨김 폴더 보기" 체크에 따라 세는 기준이 달라진다 (2026-08-16 CM 확정).

    show_hidden=false (기본)
      자료 기준. DWG·PDF 폴더는 트리에 안 나오고, 원본과 사본이 그 안에 나뉘어 있어도
      자료는 자기 폴더에 1건으로 보인다. 괄호 숫자 = 자료 수.

    show_hidden=true
      파일이 실제로 놓인 자리 기준. DWG·PDF 폴더가 트리에 나오고 원본·사본이 각각 그 폴더
      안에 들어가 보인다. 괄호 숫자 = 파일 수 — 그래서 원본+PDF 한 쌍은 1이 아니라 2로
      세어지고, 체크를 켜고 끄면 상위 폴더 숫자가 달라진다(CM이 이 점을 알고 고른 방식).
    """
    doc_rows = (
        db.query(Document)
        .filter(Document.is_archived.is_(False))
        .order_by(Document.drawing_no)
        .all()
    )
    pdf_map = {
        doc_id: file_id
        for doc_id, file_id in db.query(File.document_id, File.id).filter(
            File.is_current.is_(True), File.file_ext == "pdf"
        )
    }

    placeholders = db.query(FolderPlaceholder).all()
    folder_counts: dict[str, int] = {}
    pair_paths: set[str] = set()

    split_counts: dict[str, int] = {}

    if show_hidden:
        file_rows = (
            db.query(File.document_id, Document.source_path, File.pairing_folder)
            .join(File, File.document_id == Document.id)
            .filter(Document.is_archived.is_(False), File.is_current.is_(True))
            .all()
        )
        by_doc: dict[int, set[tuple[str, Optional[str]]]] = {}
        for doc_id, source_path, pairing in file_rows:
            if not source_path:
                continue
            by_doc.setdefault(doc_id, set()).add((source_path, pairing))
            path = source_path
            if pairing:
                path = f"{source_path}\\{pairing}"
                pair_paths.add(path)
            folder_counts[path] = folder_counts.get(path, 0) + 1

        # DWG·PDF 폴더를 고치면 두 건으로 나뉠 자료 수(화면 경고 팝업용). 자료의 현재본 파일이
        # 서로 다른 자리에 나뉘어 있을 때만 나뉜다 — 전부 한 자리에 있으면 자료가 그 폴더로
        # 내려앉을 뿐이다. 자료마다 따로 조회하면 느려서(2.3초) 위에서 읽은 것만으로 센다.
        for places in by_doc.values():
            if len({pairing for _sp, pairing in places}) <= 1:
                continue
            for source_path, pairing in places:
                if not pairing:
                    continue
                path = f"{source_path}\\{pairing}"
                split_counts[path] = split_counts.get(path, 0) + 1

        # 현재본 파일이 하나도 없는 자료뿐인 폴더도 트리에서 사라지면 안 된다
        for d in doc_rows:
            if d.source_path:
                folder_counts.setdefault(d.source_path, 0)
        visible_placeholders = placeholders
    else:
        for d in doc_rows:
            if d.source_path:
                folder_counts[d.source_path] = folder_counts.get(d.source_path, 0) + 1
        # DWG·PDF 폴더 안에 만들어 둔 빈 폴더는, 그 DWG·PDF 폴더가 안 보이는 화면에서는
        # 같이 감춘다(안 그러면 숨은 폴더 안의 폴더만 트리에 튀어나온다)
        hidden = pair_folder_paths(db)
        visible_placeholders = [p for p in placeholders if not is_inside_pair_folder(p.path, hidden)]

    folders = [
        EditorFolderItem(
            path=path, doc_count=count, is_placeholder=False, is_pair=path in pair_paths,
            split_count=split_counts.get(path, 0),
        )
        for path, count in folder_counts.items()
    ]

    for p in visible_placeholders:
        if p.path not in folder_counts:
            folders.append(EditorFolderItem(path=p.path, doc_count=0, is_placeholder=True))

    documents = [
        EditorDocItem(
            id=d.id,
            drawing_no=d.drawing_no,
            display_name=document_display_name(d),
            title=d.title,
            source_path=d.source_path,
            current_rev=d.current_rev,
            status=d.status,
            has_dwg=d.has_dwg,
            has_pdf=d.has_pdf,
            current_pdf_file_id=pdf_map.get(d.id),
        )
        for d in doc_rows
    ]

    return EditorTreeResponse(folders=folders, documents=documents)


# ---------------------------------------------------------------------------
# 폴더 편집
# ---------------------------------------------------------------------------

@router.post("/folders/placeholder")
def create_folder_placeholder(
    body: FolderPlaceholderCreate, db: Session = Depends(get_db), user: User = Depends(require_folder_edit)
):
    path = body.path.strip("\\")
    if not path:
        raise HTTPException(status_code=400, detail="폴더 경로가 비어 있습니다")
    # 이미 숨은 짝 폴더가 있는 자리에 같은 이름의 보통 폴더를 만들면, 한 이름이 두 가지 뜻이
    # 되어 화면마다 다른 건수가 보인다 — 실제로 그렇게 사고가 났다(D-47).
    ensure_not_pair_folder(db, path, "폴더를 만들")
    parent_path = "\\".join(path.split("\\")[:-1])
    if parent_path:
        ensure_folder_not_checked_out(db, parent_path)

    already_real = (
        db.query(Document.id)
        .filter(Document.is_archived.is_(False), Document.source_path == path)
        .first()
    )
    if already_real:
        return {"ok": True, "note": "이미 자료가 있는 폴더입니다"}

    existing = db.query(FolderPlaceholder).filter_by(path=path).one_or_none()
    if existing:
        return {"ok": True}

    db.add(FolderPlaceholder(path=path, created_by=user.id))
    db.add(AuditLog(user_id=user.id, action="ADD_FOLDER", screen="폴더·자료 편집", detail={"path": path}))
    db.commit()
    return {"ok": True}


@router.post("/folders/reparent", response_model=FolderReparentResult)
def reparent_folder(
    body: FolderReparentRequest, db: Session = Depends(get_db), user: User = Depends(require_folder_edit)
):
    old_path = body.old_path.strip("\\")
    new_path = body.new_path.strip("\\")
    if not old_path or not new_path:
        raise HTTPException(status_code=400, detail="경로가 비어 있습니다")
    if old_path == new_path:
        return FolderReparentResult(affected_documents=0, affected_placeholders=0, new_path=new_path)
    # 이름을 바꾼 결과가 이미 있는 숨은 짝 폴더와 겹치면 한 이름이 두 뜻이 된다(D-47).
    # 2026-08-16에 `0.PDF`를 `PDF`로 바꾼 것이 정확히 이 경우였고, 그래서 사고가 났다.
    ensure_not_pair_folder(db, new_path, "폴더 이름을 바꿀")
    ensure_folder_not_checked_out(db, old_path)

    now = datetime.now(timezone.utc)
    # 숨은 DWG·PDF 폴더를 고치는 경우 — 먼저 짝을 풀어 보통 폴더로 만든다(합쳐져 있던 자료는
    # 두 건으로 나뉜다). 화면에서 경고 팝업으로 미리 알리고 승인받은 뒤에 여기까지 온다.
    pair = find_pair_folder(db, old_path)
    split_documents = split_out_pair_folder(db, *pair, user, now) if pair else 0

    old_num = leading_num(folder_basename(old_path))
    new_num = leading_num(folder_basename(new_path))
    cascade = body.cascade_numbering

    docs = (
        db.query(Document)
        .filter(Document.is_archived.is_(False), matches_folder(Document.source_path, old_path))
        .all()
    )
    for doc in docs:
        new_full = transform_path(doc.source_path, old_path, new_path, old_num, new_num, cascade)
        if new_full == doc.source_path:
            continue
        current_files = db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
        for f in current_files:
            move_current_file(doc.source_path, new_full, doc.drawing_no, f)
        doc.source_path = new_full
        doc.updated_at = now

    placeholders = (
        db.query(FolderPlaceholder).filter(matches_folder(FolderPlaceholder.path, old_path)).all()
    )
    moved_placeholders = 0
    for p in placeholders:
        new_full = transform_path(p.path, old_path, new_path, old_num, new_num, cascade)
        if new_full == p.path:
            continue
        conflict = db.query(FolderPlaceholder).filter(
            FolderPlaceholder.path == new_full, FolderPlaceholder.id != p.id
        ).one_or_none()
        if conflict:
            db.delete(p)
        else:
            p.path = new_full
        moved_placeholders += 1

    db.add(AuditLog(
        user_id=user.id, action="RENAME_FOLDER", screen="폴더·자료 편집",
        detail={"old_path": old_path, "new_path": new_path, "cascade_numbering": cascade,
                "affected_documents": len(docs), "affected_placeholders": moved_placeholders,
                "pair_folder": bool(pair), "split_documents": split_documents},
    ))
    db.commit()

    return FolderReparentResult(
        affected_documents=len(docs), affected_placeholders=moved_placeholders, new_path=new_path,
        split_documents=split_documents,
    )


@router.post("/folders/archive", response_model=FolderArchiveResult)
def archive_folder(
    body: FolderArchiveRequest, db: Session = Depends(get_db), user: User = Depends(require_folder_edit)
):
    path = body.path.strip("\\")
    if not path:
        raise HTTPException(status_code=400, detail="폴더 경로가 비어 있습니다")
    ensure_folder_not_checked_out(db, path)

    now = datetime.now(timezone.utc)
    # 숨은 DWG·PDF 폴더("숨김 폴더 보기"에서만 보인다)를 삭제하는 경우 — 먼저 짝을 풀어 이 폴더
    # 안 파일을 별도 자료로 떼어낸다. 그 자료만 보관함으로 가고, 반대쪽 원본·사본과 리비전·반출
    # 이력은 원래 자료에 남는다 (2026-08-17 CM 확정 — 예전엔 반대쪽까지 통째로 들어갔다).
    pair = find_pair_folder(db, path)
    split_documents = split_out_pair_folder(db, *pair, user, now) if pair else 0

    docs = (
        db.query(Document)
        .filter(Document.is_archived.is_(False), matches_folder(Document.source_path, path))
        .all()
    )

    placeholders = db.query(FolderPlaceholder).filter(matches_folder(FolderPlaceholder.path, path)).all()
    removed_placeholders = len(placeholders)
    for p in placeholders:
        db.delete(p)  # 자료가 없는 표시용 행이라 실제 삭제해도 데이터 손실 없음

    parent_path = "\\".join(path.split("\\")[:-1])

    if not docs:
        db.add(AuditLog(user_id=user.id, action="DELETE_EMPTY_FOLDER", screen="폴더·자료 편집", detail={"path": path}))
        ensure_placeholder_if_emptied(db, parent_path, user)
        db.commit()
        return FolderArchiveResult(batch_id=0, archived_documents=0, removed_placeholders=removed_placeholders)

    batch = ArchiveBatch(
        kind="FOLDER", label=folder_basename(path), original_path=path, archived_by=user.id,
        reason=body.reason,
    )
    db.add(batch)
    db.flush()

    for doc in docs:
        doc.is_archived = True
        doc.archive_batch_id = batch.id
        doc.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="ARCHIVE_FOLDER", screen="폴더·자료 편집",
        detail={"path": path, "batch_id": batch.id, "document_count": len(docs),
                "pair_folder": bool(pair), "split_documents": split_documents},
    ))
    ensure_placeholder_if_emptied(db, parent_path, user)
    db.commit()

    return FolderArchiveResult(
        batch_id=batch.id, archived_documents=len(docs), removed_placeholders=removed_placeholders,
        split_documents=split_documents,
    )


# ---------------------------------------------------------------------------
# 자료 편집
# ---------------------------------------------------------------------------

@router.post("/documents/{document_id}/rename")
def rename_document(
    document_id: int, body: DocumentRenameRequest,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    doc = db.get(Document, document_id)
    if doc is None or doc.is_archived:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    ensure_not_checked_out(doc)
    new_name = body.title.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="이름이 비어 있습니다")
    tail_problem = new_name_tail_problem(new_name, doc.source_path)
    if tail_problem:
        raise HTTPException(status_code=400, detail=tail_problem)

    old_drawing_no = doc.drawing_no
    if new_name != old_drawing_no:
        current_files = db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
        for f in current_files:
            rename_current_file(doc.source_path, old_drawing_no, new_name, f)
    doc.drawing_no = new_name
    doc.title = new_name
    doc.updated_at = datetime.now(timezone.utc)
    db.add(AuditLog(
        user_id=user.id, action="RENAME_DOCUMENT", screen="폴더·자료 편집", document_id=doc.id,
        detail={"old_title": old_drawing_no, "new_title": new_name},
    ))
    db.commit()
    return {"ok": True}


@router.post("/documents/{document_id}/move")
def move_document(
    document_id: int, body: DocumentMoveRequest,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    doc = db.get(Document, document_id)
    if doc is None or doc.is_archived:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    ensure_not_checked_out(doc)
    new_path = body.new_path.strip("\\")
    ensure_not_pair_folder(db, new_path)
    old_path = doc.source_path

    current_files = db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
    for f in current_files:
        move_current_file(old_path, new_path, doc.drawing_no, f)

    doc.source_path = new_path or None
    doc.updated_at = datetime.now(timezone.utc)
    db.add(AuditLog(
        user_id=user.id, action="MOVE_DOCUMENT", screen="폴더·자료 편집", document_id=doc.id,
        detail={"old_path": old_path, "new_path": new_path},
    ))
    ensure_placeholder_if_emptied(db, old_path, user)
    db.commit()
    return {"ok": True}


def load_selected_documents(db: Session, document_ids: list[int]) -> list[Document]:
    """다수 선택 편집(위치 이동·삭제·교체) 공용 — 선택한 자료 중 하나라도 없으면(이미 삭제
    보관함으로 갔거나 잘못된 id) 통째로 거절한다. 일부만 처리하면 어느 게 반영됐는지 CM이
    헷갈리기 때문."""
    if not document_ids:
        raise HTTPException(status_code=400, detail="선택된 자료가 없습니다")
    ids = list(dict.fromkeys(document_ids))  # 순서 유지하며 중복 제거
    docs = db.query(Document).filter(Document.id.in_(ids), Document.is_archived.is_(False)).all()
    if len(docs) != len(ids):
        raise HTTPException(status_code=404, detail="선택한 자료 중 일부를 찾을 수 없습니다")
    for doc in docs:
        ensure_not_checked_out(doc)
    return docs


@router.post("/documents/move-bulk", response_model=DocumentBulkMoveResult)
def move_documents_bulk(
    body: DocumentBulkMoveRequest, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    docs = load_selected_documents(db, body.document_ids)
    new_path = body.new_path.strip("\\")
    ensure_not_pair_folder(db, new_path)

    now = datetime.now(timezone.utc)
    old_paths: set[Optional[str]] = set()
    for doc in docs:
        old_path = doc.source_path
        old_paths.add(old_path)
        current_files = db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
        for f in current_files:
            move_current_file(old_path, new_path, doc.drawing_no, f)
        doc.source_path = new_path or None
        doc.updated_at = now
        db.add(AuditLog(
            user_id=user.id, action="MOVE_DOCUMENT", screen="폴더·자료 편집", document_id=doc.id,
            detail={"old_path": old_path, "new_path": new_path, "bulk": True, "count": len(docs)},
        ))
    for p in old_paths:
        ensure_placeholder_if_emptied(db, p, user)
    db.commit()
    return DocumentBulkMoveResult(moved_documents=len(docs))


@router.post("/documents/{document_id}/archive", response_model=DocumentArchiveResult)
def archive_document(
    document_id: int, body: DocumentArchiveRequest = DocumentArchiveRequest(),
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    doc = db.get(Document, document_id)
    if doc is None or doc.is_archived:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    ensure_not_checked_out(doc)

    batch = ArchiveBatch(
        kind="DOCUMENT", label=doc.drawing_no, original_path=doc.source_path, archived_by=user.id,
        reason=body.reason,
    )
    db.add(batch)
    db.flush()

    doc.is_archived = True
    doc.archive_batch_id = batch.id
    doc.updated_at = datetime.now(timezone.utc)

    db.add(AuditLog(
        user_id=user.id, action="ARCHIVE_DOCUMENT", screen="폴더·자료 편집", document_id=doc.id,
        detail={"batch_id": batch.id, "drawing_no": doc.drawing_no},
    ))
    ensure_placeholder_if_emptied(db, batch.original_path, user)
    db.commit()
    return DocumentArchiveResult(batch_id=batch.id)


@router.post("/documents/archive-bulk", response_model=DocumentBulkArchiveResult)
def archive_documents_bulk(
    body: DocumentBulkArchiveRequest, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    docs = load_selected_documents(db, body.document_ids)
    representative = sorted(docs, key=lambda d: d.drawing_no)[0]
    label = representative.drawing_no if len(docs) == 1 else f"{representative.drawing_no} 외"

    batch = ArchiveBatch(
        kind="DOCUMENT", label=label,
        original_path=docs[0].source_path if len(docs) == 1 else None,
        archived_by=user.id, reason=body.reason,
    )
    db.add(batch)
    db.flush()

    now = datetime.now(timezone.utc)
    old_paths: set[Optional[str]] = set()
    for doc in docs:
        old_paths.add(doc.source_path)
        doc.is_archived = True
        doc.archive_batch_id = batch.id
        doc.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="ARCHIVE_DOCUMENT", screen="폴더·자료 편집",
        detail={"batch_id": batch.id, "document_count": len(docs), "bulk": True,
                "drawing_nos": [d.drawing_no for d in docs]},
    ))
    for p in old_paths:
        ensure_placeholder_if_emptied(db, p, user)
    db.commit()
    return DocumentBulkArchiveResult(batch_id=batch.id, archived_documents=len(docs))


def replace_in_place(db: Session, doc: Document, file_tuples: list[tuple[str, bytes]], user: User, now) -> bool:
    """"Rev 유지" 자료 교체 — 새 리비전을 만들지 않고 지금 현재본 파일을 그대로 덮어쓴다.

    이미 갖고 있는 확장자는 같은 자리(file_path)에 내용만 새로 쓴다(리비전·이력 변화 없음).
    아직 없는 확장자는 지금 rev 그대로 새 파일 행을 추가한다(예: PDF가 없던 자료에 PDF를 얹는 경우).
    """
    current_files = {
        f.file_ext: f
        for f in db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
    }
    pairs = [(ext, f.pairing_folder) for ext, f in current_files.items()]
    any_warning = False
    for filename, data in file_tuples:
        ext = file_ext_of(filename)
        existing = current_files.get(ext)
        if existing is not None:
            dest = Path(STORAGE_ROOT) / existing.file_path
            file_size, sha256_hex = save_upload(data, dest)
            existing.file_size = file_size
            existing.sha256 = sha256_hex
            existing.original_filename = filename
            existing.uploaded_by = user.id
            existing.uploaded_at = now
        else:
            pairing = pairing_folder_for_ext(pairs, ext)
            dest = storage.latest_file_path(doc.source_path, doc.drawing_no, ext, pairing, rev=doc.current_rev)
            file_size, sha256_hex = save_upload(data, dest)
            db.add(File(
                document_id=doc.id, rev=doc.current_rev, branch=None, file_ext=ext,
                file_path=storage.to_relative(dest), pairing_folder=pairing,
                original_filename=filename, file_size=file_size, sha256=sha256_hex,
                uploaded_by=user.id, vendor_name=None, project_id=None, vendor_labeled_rev=None,
                rev_mismatch_warning=False, review_status="APPROVED", uploaded_at=now, is_current=True,
            ))
            pairs.append((ext, pairing))
            if ext == "dwg":
                doc.has_dwg = True
            if ext == "pdf":
                doc.has_pdf = True
    doc.updated_at = now
    return any_warning


@router.post("/documents/{document_id}/replace", response_model=ReplaceResult)
async def replace_document(
    document_id: int,
    files: list[UploadFile] = UploadFileMarker(...),
    keep_rev: bool = Form(True),
    confirm_duplicates: bool = Form(False),
    db: Session = Depends(get_db),
    user: User = Depends(require_document_edit),
):
    """자료 교체 — CM 본인이 직접 하는 편집이라 검수 대기를 거치지 않고 즉시 승인·현재본으로 반영한다.

    keep_rev(기본값 true, "Rev 유지")면 리비전을 올리지 않고 지금 현재본을 그대로 덮어쓴다.
    false("Rev 변경")면 기존 방식대로 rev를 하나 올려 새 리비전으로 등록한다.
    """
    doc = db.get(Document, document_id)
    if doc is None or doc.is_archived:
        raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
    ensure_not_checked_out(doc)

    # 원본+PDF 둘 다 필수는 아니다(한쪽만 교체 가능) — 다만 둘 다 올렸는데 파일명이 서로
    # 다르면 어느 게 맞는지 판단할 방법이 없으므로 그 경우만 막는다. 한쪽만 첨부했을 때의
    # 경고(하나만 교체됨)는 프론트에서 확인창으로 먼저 물어보고 이 API를 호출한다.
    ensure_matching_stems(files)

    # 파일 이름에 리비전 꼬리를 붙였다면 정확한 형식에 이번 작업의 Rev여야 한다 — "Rev 유지"면
    # 지금 Rev, "Rev 변경"이면 하나 오른 Rev(2026-10-01 — 형식 규칙을 반입 말고 다른 곳에도).
    target_rev = doc.current_rev if keep_rev else doc.current_rev + 1
    tail_problems = [
        problem for u in files
        if (problem := upload_tail_problem(Path(u.filename).stem, doc.drawing_no, doc.source_path, target_rev))
    ]
    if tail_problems:
        raise HTTPException(status_code=400, detail="\n".join(tail_problems))

    # 정상은 원본 1개+PDF 1개뿐이다. 같은 확장자가 2개 이상 섞여 있으면(예: PDF를 실수로
    # 두 번 첨부) 어느 게 맞는 파일인지 CM이 직접 봐야 하므로, 한 번은 등록 없이 그대로
    # 돌려보내 확인창을 띄운다.
    dup_exts = duplicate_ext_groups([(u.filename, file_ext_of(u.filename)) for u in files])
    if dup_exts and not confirm_duplicates:
        return ReplaceResult(
            document_id=doc.id, message="같은 형식의 파일이 2개 이상 첨부되었습니다.",
            needs_confirmation=True, duplicate_exts=dup_exts,
        )

    file_tuples = [(u.filename, await u.read()) for u in files]
    now = datetime.now(timezone.utc)

    if keep_rev:
        any_warning = replace_in_place(db, doc, file_tuples, user, now)
        rev, branch, created = doc.current_rev, None, len(file_tuples)
        db.add(AuditLog(
            user_id=user.id, action="REPLACE_IN_PLACE", screen="폴더·자료 편집", document_id=doc.id,
            detail={"rev": rev, "via": "폴더·자료 편집(자료 교체, Rev 유지)"},
        ))
        message = f"자료를 교체했습니다 (Rev {format_rev_label(rev, branch)} 유지)."
    else:
        rev, branch, created, any_warning, _branched = create_revision_set(
            db, doc, file_tuples, INTERNAL_VENDOR, None, user, now,
        )
        set_files = (
            db.query(File)
            .filter(
                File.document_id == doc.id, File.rev == rev, File.branch.is_(None),
                File.review_status == "PENDING_REVIEW",
            )
            .all()
        )
        for f in set_files:
            f.review_status = "APPROVED"
        promote_to_current(db, doc, set_files, now)
        db.add(AuditLog(
            user_id=user.id, action="APPROVE", screen="폴더·자료 편집", document_id=doc.id,
            detail={"rev": rev, "via": "폴더·자료 편집(자료 교체)", "any_mismatch_warning": any_warning},
        ))
        message = f"자료를 교체했습니다 (rev {format_rev_label(rev, branch)})."

    if any_warning:
        message += " 파일명의 표기 리비전이 시스템 rev와 달라 경고가 표시됩니다."

    db.commit()
    return ReplaceResult(document_id=doc.id, rev=rev, file_count=created, message=message)


@router.post("/documents/replace-bulk", response_model=ReplaceBulkResult)
async def replace_documents_bulk(
    document_ids: list[int] = Form(...),
    keep_rev: bool = Form(True),
    confirm_duplicates: bool = Form(False),
    confirm_mismatch: bool = Form(False),
    confirm_partial: bool = Form(False),
    files: list[UploadFile] = UploadFileMarker(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_document_edit),
):
    """다수 자료 일괄 교체. 첨부한 파일들을 파일명(확장자 제외)으로 묶어, 그 이름과 같은
    도면번호를 가진 선택 자료에 매칭한다(원본+PDF는 같은 이름으로 자동 매칭). 이름이 안
    맞는 파일이 있거나, 선택했는데 짝을 못 찾은 자료가 있으면 한 번 확인을 받는다
    (2026-08-16 CM 확정 — 자료명·파일명이 다르면 CM이 직접 승인해야 진행).
    """
    docs = load_selected_documents(db, document_ids)

    # 내려받은 파일(`도면번호_Rev00.dwg`)을 그대로 올려도 짝이 지어지게 정상 꼬리를 떼고 묶는다
    groups: dict[str, list[UploadFile]] = {}
    for f in files:
        groups.setdefault(upload_base_name(Path(f.filename).stem), []).append(f)

    dup_exts_all: list[str] = []
    for ups in groups.values():
        for ext in duplicate_ext_groups([(u.filename, file_ext_of(u.filename)) for u in ups]):
            if ext not in dup_exts_all:
                dup_exts_all.append(ext)
    if dup_exts_all and not confirm_duplicates:
        return ReplaceBulkResult(
            message="같은 형식의 파일이 2개 이상 첨부된 자료가 있습니다.",
            needs_confirmation=True, duplicate_exts=dup_exts_all,
        )

    doc_by_name = {d.drawing_no: d for d in docs}
    matched_stems = set(groups) & set(doc_by_name)
    unmatched_files = sorted(set(groups) - matched_stems)
    unmatched_docs = sorted(document_display_name(doc_by_name[n]) for n in set(doc_by_name) - matched_stems)

    # 꼬리를 붙였다면 정확한 형식에 이번 작업의 Rev여야 한다(자료 교체 1건과 같은 규칙)
    tail_problems = []
    for stem in sorted(matched_stems):
        doc = doc_by_name[stem]
        target_rev = doc.current_rev if keep_rev else doc.current_rev + 1
        for u in groups[stem]:
            problem = upload_tail_problem(Path(u.filename).stem, doc.drawing_no, doc.source_path, target_rev)
            if problem:
                tail_problems.append(problem)
    if tail_problems:
        raise HTTPException(status_code=400, detail="\n".join(tail_problems))
    if (unmatched_files or unmatched_docs) and not confirm_mismatch:
        return ReplaceBulkResult(
            message="첨부한 파일 이름과 선택한 자료명이 서로 맞지 않는 항목이 있습니다.",
            needs_confirmation=True,
            mismatch=ReplaceBulkMismatch(unmatched_docs=unmatched_docs, unmatched_files=unmatched_files),
        )

    partial = [
        ZipRegisterSkipped(stem=stem, ext=next(iter({file_ext_of(u.filename) for u in groups[stem]})))
        for stem in matched_stems
        if len({file_ext_of(u.filename) for u in groups[stem]}) == 1
    ]
    if partial and not confirm_partial:
        return ReplaceBulkResult(
            message="원본과 사본(PDF) 중 한쪽만 있는 자료가 있습니다.",
            needs_confirmation=True, partial=partial,
        )

    now = datetime.now(timezone.utc)
    replaced = 0
    any_warning = False
    for stem in matched_stems:
        doc = doc_by_name[stem]
        file_tuples = [(u.filename, await u.read()) for u in groups[stem]]
        if keep_rev:
            warned = replace_in_place(db, doc, file_tuples, user, now)
            rev, branch = doc.current_rev, None
            action, via = "REPLACE_IN_PLACE", "폴더·자료 편집(일괄 자료 교체, Rev 유지)"
        else:
            rev, branch, _created, warned, _branched = create_revision_set(
                db, doc, file_tuples, INTERNAL_VENDOR, None, user, now,
            )
            set_files = (
                db.query(File)
                .filter(File.document_id == doc.id, File.rev == rev, File.branch.is_(None),
                        File.review_status == "PENDING_REVIEW")
                .all()
            )
            for f in set_files:
                f.review_status = "APPROVED"
            promote_to_current(db, doc, set_files, now)
            action, via = "APPROVE", "폴더·자료 편집(일괄 자료 교체)"
        any_warning = any_warning or warned
        replaced += 1
        db.add(AuditLog(
            user_id=user.id, action=action, screen="폴더·자료 편집", document_id=doc.id,
            detail={"rev": rev, "via": via, "any_mismatch_warning": warned},
        ))
    db.commit()

    message = f"자료 {replaced}건을 교체했습니다."
    if not keep_rev:
        message += " (각 자료의 Rev가 1씩 올랐습니다)"
    if any_warning:
        message += " 파일명의 표기 리비전이 시스템 rev와 달라 경고가 표시됩니다."

    return ReplaceBulkResult(replaced_documents=replaced, message=message, any_mismatch_warning=any_warning)


# ---------------------------------------------------------------------------
# 보관함 (휴지통)
# ---------------------------------------------------------------------------

def trash_target_label(batch: ArchiveBatch, drawing_nos: list[str]) -> str:
    """보관함 목록 "대상" 칸에 보여줄 이름.

    자료가 여러 건 묶인 배치(폴더 삭제, 또는 과거 일괄 정리 스크립트로 생긴 다건 배치 등)는
    폴더명·배치 라벨보다 실제 자료명이 알아보기 쉬워서, 가나다순 첫 자료명 하나 + " 외"로
    보여준다(예: "TT01-02-1003 외"). 자료가 0~1건이면 그대로 label을 쓰되, 자료 1건을 지운
    배치는 지금 자료명(꼬리 붙은 이름 — rev_naming)으로 보여준다. label은 지운 순간의 도면번호라
    꼬리가 없다.
    """
    if len(drawing_nos) > 1:
        return f"{sorted(drawing_nos)[0]} 외"
    if batch.kind == "DOCUMENT" and drawing_nos:
        return drawing_nos[0]
    return batch.label


def trash_docs_by_batch(db: Session) -> dict[int, list[tuple[int, str]]]:
    """보관함에 남아있는(되살리지 않은) 배치별 자료 목록 [(문서ID, 화면 자료명), ...].

    예전에는 배치 하나마다 자료를 따로 조회했는데, 보관함이 1,000건을 넘어가자 그만큼 쿼리가
    나가서 목록 하나 여는 데 7초씩 걸렸다(=버튼이 안 눌리는 것처럼 보였다). 한 번에 다 읽어와
    파이썬에서 배치별로 나눈다 — 결과는 예전과 완전히 같고 쿼리만 1회다.
    """
    rows = (
        db.query(Document)
        .join(ArchiveBatch, ArchiveBatch.id == Document.archive_batch_id)
        .filter(ArchiveBatch.restored_at.is_(None), ArchiveBatch.kind.in_(TDB_BATCH_KINDS))
        .all()
    )
    grouped: dict[int, list[tuple[int, str]]] = {}
    for doc in rows:
        grouped.setdefault(doc.archive_batch_id, []).append((doc.id, document_display_name(doc)))
    return grouped


@router.get("/trash", response_model=list[TrashItem])
def list_trash(db: Session = Depends(get_db)):
    batches = (
        db.query(ArchiveBatch)
        .filter(ArchiveBatch.restored_at.is_(None), ArchiveBatch.kind.in_(TDB_BATCH_KINDS))
        .order_by(ArchiveBatch.archived_at.desc())
        .all()
    )
    docs_by_batch = trash_docs_by_batch(db)
    result = []
    for b in batches:
        docs = docs_by_batch.get(b.id, [])
        result.append(TrashItem(
            batch_id=b.id, kind=b.kind, label=b.label,
            target_label=trash_target_label(b, [drawing_no for _id, drawing_no in docs]),
            original_path=b.original_path, doc_count=len(docs), archived_at=b.archived_at,
            reason=b.reason, sample_document_id=docs[0][0] if docs else None,
        ))
    return result


@router.get("/trash/count", response_model=TrashCount)
def count_trash(db: Session = Depends(get_db)):
    """화면 위 [삭제 보관함] 버튼 옆 괄호 숫자 전용.

    목록 전체를 받아서 길이만 세면(예전 방식) 버튼 하나 그리자고 보관함 전체를 매번 읽게 된다.
    폴더를 고칠 때마다 이 값이 갱신되므로 가볍게 세기만 한다.
    """
    count = (
        db.query(func.count(ArchiveBatch.id))
        .filter(ArchiveBatch.restored_at.is_(None), ArchiveBatch.kind.in_(TDB_BATCH_KINDS))
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
    """보관함 "비고" 칸 — 삭제 사유를 나중에도 자유롭게 고쳐 쓸 수 있다(Revision 이력 비고와 같은 성격).

    조회는 누구나, 작성(수정)은 권한(공통 > 비고 작성 > TDB 삭제 보관함 비고 작성)이 있어야
    한다(2026-08-17 CM 확정)."""
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="삭제 보관함 항목을 찾을 수 없습니다")
    batch.reason = body.note
    db.commit()
    return {"status": "ok"}


@router.get("/trash/export")
def export_trash(db: Session = Depends(get_db), user: User = Depends(current_user)):
    """삭제 보관함 목록을 화면과 같은 내용으로 xlsx로 내려준다."""
    items = list_trash(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "삭제보관함"
    ws.append(["종류", "대상", "기존 경로", "자료 수", "삭제 시각", "비고"])
    for it in items:
        ws.append([
            "폴더" if it.kind == "FOLDER" else "자료",
            it.target_label, it.original_path, it.doc_count,
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
    filename = build_export_filename("TDB 관리", "삭제 보관함")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="폴더·자료 편집", detail={"kind": "삭제 보관함", "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.post("/trash/{batch_id}/restore", response_model=TrashRestoreResult)
def restore_trash(batch_id: int, db: Session = Depends(get_db), user: User = Depends(require_restore)):
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.restored_at is not None or batch.kind not in TDB_BATCH_KINDS:
        raise HTTPException(status_code=404, detail="삭제 보관함 항목을 찾을 수 없습니다")

    docs = db.query(Document).filter(Document.archive_batch_id == batch.id).all()
    now = datetime.now(timezone.utc)
    for doc in docs:
        doc.is_archived = False
        doc.updated_at = now
    batch.restored_at = now

    db.add(AuditLog(
        user_id=user.id, action="RESTORE_FROM_TRASH", screen="폴더·자료 편집",
        detail={"batch_id": batch.id, "kind": batch.kind, "label": batch.label, "document_count": len(docs)},
    ))
    db.commit()
    return TrashRestoreResult(restored_documents=len(docs))


def paths_used_by_other_documents(db: Session, doc_ids: list[int]) -> set[str]:
    """지금 지우려는 자료들 **말고** 다른 자료가 쓰고 있는 파일 경로 모음(소문자로).

    한 물리 파일을 두 자료가 가리키는 일이 실제로 있었다 — Windows가 파일명 대소문자를
    구분하지 않아 `A.pdf`와 `a.pdf`가 같은 파일인데 시스템은 다른 파일로 보고 각각 등록한
    경우다(5.1.5 C Area 7건). 그런 파일을 완전 삭제하면 **멀쩡한 다른 자료의 파일까지
    사라진다.** 그래서 지우기 전에 다른 주인이 있는지 확인한다 (2026-08-21 CM 확정).
    반출 사본 폴더에 이미 있던 "아직 쓰는 사람이 있으면 안 지운다"와 같은 장치다.
    """
    rows = (
        db.query(File.file_path)
        .filter(File.file_path.isnot(None), ~File.document_id.in_(doc_ids))
        .distinct()
    )
    return {p.lower() for (p,) in rows if p}


def purge_one_batch(db: Session, batch: ArchiveBatch) -> tuple[int, int, int]:
    """보관함 배치 1건을 디스크·DB에서 실제로 지운다. (자료 수, 파일 수, 확보 바이트) 반환.

    이 프로젝트는 원래 어떤 표에서도 행을 지우지 않지만(구본도 상태만 바꿔 보관),
    삭제 보관함에 쌓인 파일이 디스크를 계속 차지하는 문제 때문에 보관함에 한해
    실제 삭제를 허용하기로 했다(2026-08-17 CM 확정). 되살리기가 불가능해지므로
    화면에서 두 번 확인을 받은 뒤에만 여기까지 온다.

    지우는 순서는 "남을 표가 사라진 자료를 가리키지 않게" 정리 → 실제 행 삭제 순이다.
    시스템 로그(audit_log)와 반입 확인필요 항목은 그 자체가 기록이라 지우지 않고,
    없어진 자료를 가리키던 칸만 비운다.
    """
    docs = db.query(Document).filter(Document.archive_batch_id == batch.id).all()
    doc_ids = [d.id for d in docs]
    if not doc_ids:
        return 0, 0, 0

    files = db.query(File).filter(File.document_id.in_(doc_ids)).all()
    freed = 0
    still_used = paths_used_by_other_documents(db, doc_ids)
    for f in files:
        # 다른(지우지 않는) 자료가 아직 그 파일을 가리키고 있으면 디스크에서 지우지 않는다.
        # DB 행만 없애고 파일은 남긴 주인 자료의 것으로 그대로 둔다.
        if (f.file_path or "").lower() in still_used:
            continue
        freed += storage.delete_stored_file(f.file_path)

    # 반출 사본 폴더는 (업체, 날짜, 도면번호)가 같으면 여러 반출 기록이 한 폴더를 같이 쓸 수
    # 있다. 지금 지우는 자료 것만 남김없이 없어졌을 때만 폴더를 지운다.
    dist_dirs = {
        p for (p,) in db.query(Distribution.file_saved_path).filter(Distribution.document_id.in_(doc_ids))
    }

    file_ids = [f.id for f in files]
    if file_ids:
        db.query(Distribution).filter(Distribution.returned_file_id.in_(file_ids)).update(
            {Distribution.returned_file_id: None}, synchronize_session=False
        )
    db.query(AuditLog).filter(AuditLog.document_id.in_(doc_ids)).update(
        {AuditLog.document_id: None}, synchronize_session=False
    )
    db.query(ImportIssue).filter(ImportIssue.intended_document_id.in_(doc_ids)).update(
        {ImportIssue.intended_document_id: None}, synchronize_session=False
    )
    db.query(ImportIssue).filter(ImportIssue.resolved_document_id.in_(doc_ids)).update(
        {ImportIssue.resolved_document_id: None}, synchronize_session=False
    )
    # 누군가 보관 목록에 담아 둔 자료면, 그 보관 줄은 남기고 가리키던 칸만 비운다 — 목록에서
    # "삭제됨"으로 보이고 본인이 지울 수 있다. 안 비우면 외래키에 걸려 완전 삭제 자체가 실패한다.
    db.query(UserFavorite).filter(UserFavorite.document_id.in_(doc_ids)).update(
        {UserFavorite.document_id: None}, synchronize_session=False
    )
    db.query(Distribution).filter(Distribution.document_id.in_(doc_ids)).delete(synchronize_session=False)
    db.query(File).filter(File.document_id.in_(doc_ids)).delete(synchronize_session=False)
    db.query(Document).filter(Document.id.in_(doc_ids)).delete(synchronize_session=False)
    db.flush()

    for rel_dir in dist_dirs:
        still_used = (
            db.query(Distribution.id).filter(Distribution.file_saved_path == rel_dir).first() is not None
        )
        if not still_used:
            freed += storage.delete_stored_dir(rel_dir)

    return len(doc_ids), len(files), freed


@router.post("/trash/purge", response_model=TrashPurgeResult)
def purge_trash(
    body: TrashPurgeRequest, db: Session = Depends(get_db), user: User = Depends(require_purge)
):
    """삭제 보관함에서 고른 항목을 완전히 삭제한다 — 되살릴 수 없다 (2026-08-17 CM 확정).

    되살리기(restore)와 짝이 되는 동작이라 주소도 그 옆에 둔다. 여러 건을 한 번에 받는 이유는
    보관함이 이미 1,000건 넘게 쌓여 있어서 한 건씩 지워서는 용량 정리가 안 되기 때문이다.
    """
    if not body.batch_ids:
        raise HTTPException(status_code=400, detail="완전 삭제할 항목을 선택해 주세요")

    batches = (
        db.query(ArchiveBatch)
        .filter(
            ArchiveBatch.id.in_(body.batch_ids),
            ArchiveBatch.restored_at.is_(None),
            ArchiveBatch.kind.in_(TDB_BATCH_KINDS),
        )
        .all()
    )

    purged_documents = deleted_files = freed_bytes = 0
    purged_labels: list[str] = []
    for batch in batches:
        docs, files, freed = purge_one_batch(db, batch)
        purged_documents += docs
        deleted_files += files
        freed_bytes += freed
        purged_labels.append(batch.label)
        db.delete(batch)  # 보관함 항목 자체도 없앤다 — 아래 시스템 로그에 무엇을 지웠는지 남긴다

    db.add(AuditLog(
        user_id=user.id, action="PURGE_TRASH", screen="폴더·자료 편집",
        detail={
            "batch_count": len(batches), "document_count": purged_documents,
            "file_count": deleted_files, "freed_bytes": freed_bytes,
            "labels": purged_labels[:50],
        },
    ))
    db.commit()

    return TrashPurgeResult(
        purged_batches=len(batches), purged_documents=purged_documents,
        deleted_files=deleted_files, freed_bytes=freed_bytes,
        skipped_batches=len(set(body.batch_ids)) - len(batches),
    )


def build_trash_manifest_bytes(db: Session, batch: ArchiveBatch, docs: list[Document]) -> bytes:
    """삭제 보관함 배치 다운로드 zip에 함께 담는 목록 엑셀 — 반출 zip의 반출목록 엑셀과 같은 성격.

    무엇이 이 zip에 들어있는지 파일만 봐서는 알기 어려우므로(도면번호 중복이 흔해 폴더 구조만
    으로는 헷갈릴 수 있다) 자료명·경로·문서ID를 가나다순으로 정리해 함께 담는다.
    """
    deleted_by = db.get(User, batch.archived_by)
    deleted_by_name = deleted_by.name if deleted_by else None
    deleted_at = batch.archived_at.strftime("%Y-%m-%d %H:%M") if batch.archived_at else None

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "삭제보관함목록"
    ws.append([
        "No", "자료명", "기존 경로", "Rev.",
        "DWG", "XLSX", "ETC", "PDF", "삭제담당", "삭제시간", "문서ID", "비고",
    ])
    for no, doc in enumerate(sorted(docs, key=lambda d: d.drawing_no), start=1):
        exts = {
            (ext or "").lower()
            for (ext,) in db.query(File.file_ext).filter(
                File.document_id == doc.id, File.is_current.is_(True)
            )
        }
        ws.append([
            no, document_display_name(doc), doc.source_path, format_rev_label(doc.current_rev, None),
            "Y" if "dwg" in exts else "",
            "Y" if exts & {"xlsx", "xls"} else "",
            "Y" if exts - {"dwg", "xlsx", "xls", "pdf"} else "",
            "Y" if "pdf" in exts else "",
            deleted_by_name, deleted_at, doc.id, batch.reason,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 26, 55, 9, 7, 7, 7, 7, 12, 17, 9, 30], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width
    out = BytesIO()
    neutralize_formulas(wb)
    wb.save(out)
    return out.getvalue()


@router.get("/trash/{batch_id}/download")
def download_trash_batch(batch_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.kind not in TDB_BATCH_KINDS:
        raise HTTPException(status_code=404, detail="삭제 보관함 항목을 찾을 수 없습니다")
    docs = db.query(Document).filter(Document.archive_batch_id == batch.id).all()
    if not docs:
        raise HTTPException(status_code=404, detail="다운로드할 자료가 없습니다")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for doc in docs:
            files = db.query(File).filter(File.document_id == doc.id, File.is_current.is_(True)).all()
            source_path = (doc.source_path or "").strip("\\/").replace("\\", "/")
            for f in files:
                path = Path(STORAGE_ROOT) / f.file_path
                if not path.is_file():
                    continue
                name = f"{sanitize_path_component(file_display_name(doc, f))}.{f.file_ext}"
                arcname = f"{source_path}/{name}" if source_path else name
                zf.write(path, arcname)
        # 반출 zip과 같은 방식으로 목록 엑셀을 동봉한다
        zf.writestr(f"TDB 삭제 보관함 목록_{filename_timestamp()}.xlsx", build_trash_manifest_bytes(db, batch, docs))
    buf.seek(0)

    db.add(AuditLog(
        user_id=user.id, action="DOWNLOAD", screen="폴더·자료 편집", detail={"kind": "삭제 보관함", "batch_id": batch.id},
    ))
    db.commit()

    filename = f"TDB 삭제 보관함_{sanitize_path_component(batch.label)}_{filename_timestamp()}.zip"
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---------------------------------------------------------------------------
# 폐기 보관함 (2026-08-30 CM 확정) — 삭제와 다르다. app/retire.py의 설명 참고.
#   삭제: 오류 등으로 없어야 할 자료 → 삭제 보관함(완전 삭제까지 갈 수 있다)
#   폐기: 그때는 맞았지만 리비전이 진행되며 최신본에서 빠진 자료 → 트리에서만 사라지고
#         이력으로 계속 남는다(완전 삭제 없음, [복구]만 있다).
# 표 한 줄 = 자료 1건이라, 여러 건을 한 번에 폐기해도 자료마다 이력을 따로 남긴다.
# ---------------------------------------------------------------------------

def current_files_of(db: Session, document_id: int) -> list[File]:
    return db.query(File).filter(File.document_id == document_id, File.is_current.is_(True)).all()


def move_files_between_latest_and_retired(
    db: Session, doc: Document, new_source_path: Optional[str], *, to_retired: bool
) -> None:
    """자료의 현재본 물리 파일을 '최신' ↔ '폐기' 폴더 사이에서 옮긴다.

    폐기 자료를 최신 폴더에 그대로 두면, 같은 폴더에 같은 이름 자료가 새로 등록될 때 폐기본
    파일이 조용히 덮어써져 이력이 사라진다(예전에 실제로 있었던 사고 유형 — D-34 ③).
    구본(이력 폴더)은 문서·리비전별 폴더라 겹치지 않으므로 그대로 둔다.

    옮겨오는 자리는 계산하지 않고 **지금 파일이 실제로 있는 자리(file_path)**에서 가져온다 —
    복구할 때 CM이 다른 폴더를 골랐으면 폐기 당시 경로와 새 경로가 다르기 때문이다.

    한 물리 파일을 다른 자료도 가리키고 있으면(대소문자만 다른 이름으로 등록된 옛 자료 —
    D-47 ⑥) 옮기지 않는다. 옮기면 멀쩡한 다른 자료의 파일이 사라지기 때문이다.
    """
    files = current_files_of(db, doc.id)
    if not files:
        return
    shared = paths_used_by_other_documents(db, [doc.id])
    build_dest = storage.retired_file_path if to_retired else storage.latest_file_path
    for f in files:
        if (f.file_path or "").lower() in shared:
            continue
        old_dest = Path(STORAGE_ROOT) / f.file_path
        new_dest = build_dest(new_source_path, doc.drawing_no, f.file_ext, f.pairing_folder, rev=f.rev, branch=f.branch)
        if storage.move_stored_file(old_dest, new_dest):
            f.file_path = storage.to_relative(new_dest)
            if not to_retired:
                # 되살리고 나면 폐기 폴더에 빈 껍데기만 남으므로 그때그때 정리한다
                # ("폐기" 폴더 자체는 저장소 뼈대라 비어도 남는다 — storage.prune_empty_dirs).
                storage.prune_empty_dirs(old_dest.parent)


@router.post("/documents/retire-bulk", response_model=RetireResult)
def retire_documents_bulk(
    body: RetireRequest, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """자료 삭제 팝업의 [폐기 보관함으로 이동]. 삭제와 같은 팝업에서 하는 일이라 권한도 같다."""
    docs = load_selected_documents(db, body.document_ids)
    now = datetime.now(timezone.utc)
    old_paths: set[Optional[str]] = set()

    for doc in docs:
        batch = ArchiveBatch(
            kind=TDB_RETIRE_KIND, label=doc.drawing_no, original_path=doc.source_path,
            archived_by=user.id, reason=body.reason,
        )
        db.add(batch)
        db.flush()
        move_files_between_latest_and_retired(db, doc, doc.source_path, to_retired=True)
        old_paths.add(doc.source_path)
        doc.is_archived = True
        doc.archive_batch_id = batch.id
        doc.updated_at = now

    db.add(AuditLog(
        user_id=user.id, action="RETIRE_DOCUMENT", screen="폴더·자료 편집",
        detail={"document_count": len(docs), "drawing_nos": [d.drawing_no for d in docs],
                "reason": body.reason},
    ))
    for path in old_paths:
        ensure_placeholder_if_emptied(db, path, user)
    db.commit()
    return RetireResult(retired_documents=len(docs))


def retired_rows(db: Session) -> list[tuple[ArchiveBatch, Document]]:
    """폐기 보관함에 남아있는(복구하지 않은) 이력 + 그 자료. 최근 폐기한 순."""
    return (
        db.query(ArchiveBatch, Document)
        .join(Document, Document.archive_batch_id == ArchiveBatch.id)
        .filter(ArchiveBatch.kind == TDB_RETIRE_KIND, ArchiveBatch.restored_at.is_(None))
        .order_by(ArchiveBatch.archived_at.desc())
        .all()
    )


def current_pdf_ids(db: Session, document_ids: list[int]) -> dict[int, int]:
    """자료별 현재 리비전 PDF 파일 id — 표의 돋보기(미리보기)용.

    행마다 따로 조회하면 목록이 그만큼 느려지므로 한 번에 읽는다(D-38 ㉡의 교훈)."""
    if not document_ids:
        return {}
    rows = (
        db.query(File.document_id, File.id)
        .filter(File.document_id.in_(document_ids), File.is_current.is_(True), File.file_ext == "pdf")
        .all()
    )
    return {doc_id: file_id for doc_id, file_id in rows}


def retired_path_label(batch: ArchiveBatch, doc: Document) -> str:
    """폐기 보관함 "경로" 칸 — 목록 화면과 같이 분류(대분류) 다음부터만 보여준다.
    바로 왼쪽에 분류 칸이 따로 있어서, 전체 경로를 그대로 쓰면 같은 글이 두 번 나온다."""
    rest = batch.original_path or ""
    if doc.category and rest.startswith(doc.category):
        rest = rest[len(doc.category):].lstrip("\\")
    return rest.replace("\\", " / ")


@router.get("/retired", response_model=list[RetiredItem])
def list_retired(db: Session = Depends(get_db)):
    """폐기 보관함 목록. 조회 화면(TDB 조회)도 같은 목록을 보므로 권한을 걸지 않는다 —
    일반 사용자도 폐기 이력을 볼 수 있어야 한다는 것이 이 기능의 목적이다(고치는 것만 막는다)."""
    rows = retired_rows(db)
    pdf_ids = current_pdf_ids(db, [doc.id for _batch, doc in rows])
    return [
        RetiredItem(
            batch_id=batch.id, document_id=doc.id, drawing_no=doc.drawing_no,
            display_name=document_display_name(doc),
            category=doc.category, path=retired_path_label(batch, doc), rev=doc.current_rev,
            pdf_file_id=pdf_ids.get(doc.id), retired_at=batch.archived_at, reason=batch.reason,
        )
        for batch, doc in rows
    ]


@router.get("/retired/count", response_model=TrashCount)
def count_retired(db: Session = Depends(get_db)):
    """화면 위 [폐기 보관함] 버튼 옆 괄호 숫자 전용 (삭제 보관함과 같은 방식)."""
    count = (
        db.query(func.count(ArchiveBatch.id))
        .filter(ArchiveBatch.kind == TDB_RETIRE_KIND, ArchiveBatch.restored_at.is_(None))
        .scalar()
    )
    return TrashCount(count=count or 0)


@router.post("/retired/{batch_id}/note")
def update_retired_note(
    batch_id: int, body: UpdateNoteRequest,
    db: Session = Depends(get_db), user: User = Depends(require_retire),
):
    """폐기 보관함 "비고" 칸 — 보는 것은 누구나, 고치는 것은 폐기 보관함 권한이 있어야 한다."""
    batch = db.get(ArchiveBatch, batch_id)
    if batch is None or batch.kind != TDB_RETIRE_KIND:
        raise HTTPException(status_code=404, detail="폐기 보관함 항목을 찾을 수 없습니다")
    batch.reason = body.note
    db.commit()
    return {"status": "ok"}


@router.get("/retired/export")
def export_retired(
    screen: str = "TDB 관리", db: Session = Depends(get_db), user: User = Depends(current_user),
):
    """폐기 보관함 목록을 화면 표와 같은 칸으로 xlsx로 내려준다.

    screen은 이 팝업을 연 화면 이름(TDB 관리 / TDB 조회)이다 — 파일명이 "화면이름_팝업제목_
    날짜"라 어느 화면에서 받았는지가 파일명에 남아야 한다(엑셀 내보내기 공통 규칙).
    """
    items = list_retired(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "폐기보관함"
    ws.append(["자료명", "분류", "경로", "Rev", "폐기 시간", "비고"])
    for it in items:
        ws.append([
            it.display_name, it.category, it.path, it.rev,
            it.retired_at.strftime("%Y-%m-%d %H:%M") if it.retired_at else None,
            it.reason,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([26, 14, 50, 7, 17, 30], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename(screen, "TDB 폐기 보관함")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen=screen,
        detail={"kind": "폐기 보관함", "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


def folder_exists(db: Session, path: Optional[str]) -> bool:
    """그 폴더가 지금도 트리에 있는지. 폴더는 실체가 없으므로(자료의 source_path 문자열과
    빈 폴더 표시로만 존재) 둘 다 확인한다. 최상위(경로 없음)는 항상 있다."""
    if not path:
        return True
    has_doc = (
        db.query(Document.id)
        .filter(Document.is_archived.is_(False), matches_folder(Document.source_path, path))
        .first()
    )
    if has_doc:
        return True
    return (
        db.query(FolderPlaceholder.id)
        .filter(matches_folder(FolderPlaceholder.path, path))
        .first()
    ) is not None


def name_taken_in_folder(db: Session, path: Optional[str], drawing_no: str) -> bool:
    """복구하려는 자리에 같은 이름 자료가 이미 있는지. 있으면 물리 파일 자리까지 겹치므로
    (최신/{경로}/{도면번호}.{확장자}) 그대로 되살리면 남의 파일을 덮어쓴다."""
    return (
        db.query(Document.id)
        .filter(
            Document.is_archived.is_(False),
            source_path_eq(path or ""),
            Document.drawing_no == drawing_no,
        )
        .first()
    ) is not None


@router.post("/retired/restore", response_model=RetireRestoreResult)
def restore_retired(
    body: RetireRestoreRequest, db: Session = Depends(get_db), user: User = Depends(require_retire),
):
    """폐기 자료를 원래 자리로 되돌린다.

    원래 폴더가 없어졌거나 그 자리에 같은 이름 자료가 이미 있으면 **아무것도 복구하지 않고**
    그 목록을 돌려준다 — 화면이 CM에게 새 위치를 물어본 뒤(new_paths) 다시 부른다.
    일부만 되살리면 무엇이 반영됐는지 헷갈리므로 전부 되거나 전부 안 되거나로 한다.
    """
    if not body.batch_ids:
        raise HTTPException(status_code=400, detail="복구할 항목을 선택하세요")

    wanted = set(body.batch_ids)
    rows = [(batch, doc) for batch, doc in retired_rows(db) if batch.id in wanted]
    if not rows:
        raise HTTPException(status_code=404, detail="폐기 보관함 항목을 찾을 수 없습니다")

    blocked: list[RetireRestoreBlocked] = []
    targets: list[tuple[ArchiveBatch, Document, Optional[str]]] = []
    for batch, doc in rows:
        chosen = body.new_paths.get(batch.id)
        new_path = chosen if chosen is not None else batch.original_path
        if chosen:
            ensure_not_pair_folder(db, chosen, "자료를 되돌릴")
        if not folder_exists(db, new_path):
            reason = "NO_FOLDER"
        elif name_taken_in_folder(db, new_path, doc.drawing_no):
            reason = "NAME_TAKEN"
        else:
            targets.append((batch, doc, new_path))
            continue
        blocked.append(RetireRestoreBlocked(
            batch_id=batch.id, label=doc.drawing_no, original_path=batch.original_path, reason=reason,
        ))

    if blocked:
        return RetireRestoreResult(restored=0, blocked=blocked)

    now = datetime.now(timezone.utc)
    moved: dict[str, str] = {}
    for batch, doc, new_path in targets:
        if new_path != batch.original_path:
            moved[doc.drawing_no] = new_path or ""
        # 파일 자리를 새 위치로 계산해야 하므로 source_path를 먼저 바꾼다.
        doc.source_path = new_path or None
        move_files_between_latest_and_retired(db, doc, doc.source_path, to_retired=False)
        doc.is_archived = False
        doc.updated_at = now
        batch.restored_at = now

    db.add(AuditLog(
        user_id=user.id, action="RESTORE_FROM_RETIRED", screen="폴더·자료 편집",
        detail={"document_count": len(targets),
                "drawing_nos": [doc.drawing_no for _b, doc, _p in targets],
                "moved_paths": moved},
    ))
    db.commit()
    return RetireRestoreResult(restored=len(targets), blocked=[])


# ---------------------------------------------------------------------------
# Zip으로 폴더째 넣기 (신규 등록을 대체 — 업체 무관, 이미 PC에 있는 폴더·자료를 그대로 적재)
# ---------------------------------------------------------------------------

def _has_escape_segment(folder_in_zip: str) -> bool:
    """압축파일 안 폴더 이름 중 "상위 폴더로 빠져나가는"(..) 조각이 있는지 확인한다."""
    return any(part == ".." for part in folder_in_zip.split("/"))


def _sanitize_folder_segments(folder_in_zip: str) -> str:
    """".." · "."(빈 조각 포함) 같은 조각은 실제 폴더 이동에 쓰지 않고 버린다 — 사용자가
    확인 후 계속 진행하더라도 실제 저장 위치가 지정한 폴더 밖으로 나가지 않게 하기 위함."""
    parts = [p for p in folder_in_zip.split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


def find_existing_document(db: Session, source_path: Optional[str], drawing_no: str) -> Optional[Document]:
    """같은 폴더에 같은 이름으로 이미 등록된 자료를 찾는다 (없으면 None).

    같은 이름이 2건 이상이면 어느 쪽에 붙여야 할지 시스템이 정할 수 없으므로 None을 돌려
    호출한 쪽이 "새로 만들 수 없음"으로 처리하게 한다 — 잘못된 자료에 파일이 붙는 것보다
    등록을 멈추고 CM이 정리하는 게 낫다.

    이름은 **대소문자까지 정확히** 비교한다 (2026-08-21 CM 확정, D-47 ④).
    """
    rows = (
        db.query(Document)
        .filter(
            Document.is_archived.is_(False),
            Document.drawing_no == drawing_no,
            Document.source_path == source_path if source_path else Document.source_path.is_(None),
        )
        .all()
    )
    return rows[0] if len(rows) == 1 else None


def registration_name(stem: str, source_path: Optional[str]) -> str:
    """신규추가·Zip 등록에서 파일 이름으로 정하는 자료명 — 정상 꼬리(`_Rev00`)는 뗀다.

    꼬리는 시스템이 리비전 번호로 붙이는 것이라 자료명에 들어가면 안 된다(rev_naming).
    P&ID·PFD 폴더는 예전처럼 파일 이름 그대로다.
    """
    return upload_base_name(stem) if applies_to(source_path) else stem


def registration_name_problems(
    db: Session, source_path: Optional[str], name: str, filenames: list[str], rev: int,
) -> list[str]:
    """신규추가·Zip 등록에서 자료 하나(같은 이름으로 묶인 파일들)의 파일 이름 꼬리 검사(2026-10-01).

    꼬리 없이 올리면 괜찮다. 꼬리를 붙였다면 정확한 형식이어야 하고, 번호는 같은 자리에 같은 이름
    자료가 이미 있으면 그 자료의 지금 Rev(그 자료에 붙으므로), 없으면 이번에 등록할 Rev여야 한다.
    """
    existing = find_existing_document(db, source_path, name)
    target_rev = existing.current_rev if existing else rev
    problems = []
    for filename in filenames:
        _name, problem = new_upload_name(Path(filename).stem, source_path, target_rev)
        if problem:
            problems.append(problem)
    return problems


def current_ext_pairs(db: Session, document_id: int) -> list[tuple[str, Optional[str]]]:
    """그 자료의 현재본 파일들을 (확장자, DWG/PDF 폴더 이름) 목록으로."""
    return [
        (f.file_ext, f.pairing_folder)
        for f in db.query(File).filter(File.document_id == document_id, File.is_current.is_(True))
    ]


def attach_files_to_document(
    db: Session, doc: Document, items: list[tuple[str, str, bytes]], user: User, now,
) -> tuple[int, list[str]]:
    """이미 있는 자료에 아직 없는 형식의 파일만 붙인다.

    이미 갖고 있는 형식은 덮어쓰지 않고 거절한다(어느 게 맞는 파일인지 시스템이 판단할 수
    없고, 조용히 덮어쓰면 먼저 등록된 자료가 남의 파일을 가리키게 된다 — 2026-08-16 CM 확정).
    자료 내용을 바꾸려면 [자료 교체]를 쓴다.

    반환값: (붙인 파일 수, 이미 있어서 거절한 확장자 목록)
    """
    pairs = current_ext_pairs(db, doc.id)
    owned = {ext for ext, _folder in pairs}
    attached = 0
    rejected: list[str] = []

    for filename, ext, data in items:
        if ext in owned:
            if ext not in rejected:
                rejected.append(ext)
            continue
        pairing = pairing_folder_for_ext(pairs, ext)
        dest = storage.latest_file_path(doc.source_path, doc.drawing_no, ext, pairing, rev=doc.current_rev)
        file_size, sha256_hex = save_upload(data, dest)
        db.add(File(
            document_id=doc.id, rev=doc.current_rev, branch=None, file_ext=ext,
            file_path=storage.to_relative(dest), pairing_folder=pairing,
            original_filename=filename, file_size=file_size, sha256=sha256_hex,
            uploaded_by=user.id, vendor_name=None, project_id=None, vendor_labeled_rev=None,
            rev_mismatch_warning=False, review_status="APPROVED", uploaded_at=now, is_current=True,
        ))
        pairs.append((ext, pairing))
        owned.add(ext)
        attached += 1
        if ext == "dwg":
            doc.has_dwg = True
        if ext == "pdf":
            doc.has_pdf = True

    if attached:
        doc.updated_at = now
    return attached, rejected


@router.post("/zip-register", response_model=ZipRegisterResult)
async def zip_register(
    target_path: str = Form(""),
    confirm_partial: bool = Form(False),
    confirm_unsafe_paths: bool = Form(False),
    confirm_duplicates: bool = Form(False),
    rev: int = Form(0),
    zip_file: UploadFile = UploadFileMarker(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_zip_register),
):
    """원본과 PDF가 세트로 있는 게 정상이지만, 한쪽만 있어도 등록 자체를 막지는 않는다.
    다만 실수로 반쪽만 넣는 걸 막기 위해, 한쪽만 있는 자료가 있으면 한 번은
    확인 없이 그대로 돌려보내(needs_confirmation=True, 아무것도 등록 안 함) 프론트에서
    확인창을 띄우게 하고, 사용자가 승인(confirm_partial=True)하면 그때 실제로 등록한다.

    압축파일 안에 "상위 폴더로 빠져나가려는" 이름(..)이 있으면 같은 방식으로 한 번
    확인창을 띄운다(confirm_unsafe_paths=True로 승인해야 진행). 승인해도 그 조각은
    실제로는 무시하고 나머지 폴더 이름만 써서 등록 위치가 지정한 폴더 밖으로 나가지
    않게 한다 — 확인창은 "이상한 이름이 있다"는 걸 알리는 용도이지, 실제로 상위 폴더에
    쓰는 걸 허용하는 게 아니다.

    DWG·PDF 폴더는 **묻지 않고 규칙대로 자동 판정**한다 (2026-08-21 CM 확정).
      - 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 **둘 다** 있으면 → 둘을 짝 폴더로 보고
        같은 이름 파일을 자료 1건(원본+사본)으로 묶는다. 자료는 그 윗 폴더에 놓이고,
        폴더 이름은 버리지 않고 파일마다 기억해 두었다가 실제 저장 위치와 반출 폴더에서
        되살린다. 짝이 안 맞아 혼자 남는 파일도 그 숨은 폴더 안에 그대로 둔다.
      - **한쪽만** 있으면 → 그냥 보통 폴더다. 압축파일 구조 그대로 등록하고 합치지 않는다.
    깊이가 다르면(예: "상위/중간/DWG"와 "상위/PDF") 같은 자리가 아니므로 짝이 아니다.

    이름은 **대소문자까지 정확히 같아야** 한 자료로 묶인다 — `A.dwg`와 `a.pdf`는 별개 자료다
    (2026-08-21 CM 확정, D-47 ④). 안 묶인 것을 CM이 보고 이름을 바로잡을 수 있어야 하고,
    내려받은 파일명이 화면에 보이던 이름과 대소문자까지 같아야 하기 때문이다.

    이름당 원본 1개+PDF 1개가 정상이다. 같은 확장자가 2개 이상이면(비정상) partial과 같은
    방식으로 한 번 확인창을 띄우고(confirm_duplicates=True로 승인), 승인해도 어느 게 맞는
    파일인지는 시스템이 판단할 수 없으므로 그 자료는 등록하지 않고 건너뛴다 — CM이 Zip을
    정리해 다시 올리거나 신규추가로 개별 등록해야 한다.

    등록하려는 자리에 같은 이름의 자료가 이미 있으면 새로 만들지 않는다 — 아직 없는 형식만
    그 자료에 붙이고, 이미 갖고 있는 형식은 덮어쓰지 않고 거절한다(already_exists로 보고).

    rev: 이 Zip에서 새로 만들어지는 모든 자료에 일괄 적용할 Rev 번호. 안 주면 0(2026-08-18
    CM 확정, D-45와 같은 방식). 이미 있는 자료에 형식만 추가로 붙이는 경우는 이 값을 쓰지
    않고 항상 그 자료의 현재 Rev를 그대로 따른다(원본·사본이 다른 Rev를 가리키면 안 되므로).
    """
    target_path = target_path.strip("\\")
    ensure_not_pair_folder(db, target_path)

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
        raw_entries.append(("/".join(raw.split("/")[:-1]), raw.split("/")[-1], zf.read(info)))

    # DWG 폴더와 PDF 폴더가 나란히 있는 자리만 짝 폴더로 본다(한쪽만 있으면 보통 폴더).
    pair_paths = pairing_folder_paths({folder for folder, _f, _d in raw_entries})
    pair_folders = sorted({p.split("/")[-1] for p in pair_paths}, key=str.lower)

    entries: list[tuple[str, Optional[str], str, str, bytes]] = []  # (상위폴더, 짝폴더, 파일명, 확장자, 내용)
    for folder, filename, data in raw_entries:
        parent, pairing = split_pairing_folder(folder, pair_paths)
        entries.append((parent, pairing, filename, file_ext_of(filename), data))

    def doc_path_of(folder_in_zip: str) -> Optional[str]:
        """압축파일 안 폴더 → 그 자료가 놓일 경로(source_path)."""
        folder_bs = _sanitize_folder_segments(folder_in_zip).replace("/", "\\")
        return f"{target_path}\\{folder_bs}" if target_path and folder_bs else (target_path or folder_bs or None)

    # 이름은 **대소문자까지 정확히 같아야** 한 자료로 묶는다 — `A.dwg`와 `a.pdf`는 별개 자료다
    # (2026-08-21 CM 확정, D-47 ④). 안 묶인 것을 CM이 보고 이름을 바로잡을 수 있어야 하고,
    # 내려받은 파일명이 화면에 보이던 이름과 대소문자까지 같아야 하기 때문이다.
    # 리비전 꼬리(`_Rev00`)는 떼고 묶는다 — 꼬리는 자료명이 아니다(registration_name).
    groups: dict[tuple[str, str], list[tuple[str, str, Optional[str], bytes]]] = {}
    for parent, pairing, filename, ext, data in entries:
        name = registration_name(Path(filename).stem, doc_path_of(parent))
        groups.setdefault((parent, name), []).append((filename, ext, pairing, data))

    unsafe_folders = sorted({folder for (folder, _stem) in groups if _has_escape_segment(folder)})
    if unsafe_folders and not confirm_unsafe_paths:
        return ZipRegisterResult(
            created_documents=0, skipped=[], target_path=target_path,
            needs_confirmation=True, unsafe_paths=unsafe_folders,
        )

    duplicates: list[ZipRegisterDuplicate] = []
    for (folder_in_zip, stem), items in groups.items():
        dup_exts = duplicate_ext_groups([(f, e) for f, e, _p, _d in items])
        if dup_exts:
            duplicates.append(ZipRegisterDuplicate(stem=stem, folder=folder_in_zip, exts=dup_exts))
    if duplicates and not confirm_duplicates:
        return ZipRegisterResult(
            created_documents=0, skipped=[], target_path=target_path,
            needs_confirmation=True, duplicates=duplicates,
        )
    duplicate_keys = {(d.folder, d.stem) for d in duplicates}
    groups = {k: v for k, v in groups.items() if k not in duplicate_keys}

    partial: list[ZipRegisterSkipped] = []
    for (folder_in_zip, stem), items in groups.items():
        exts = {ext for _f, ext, _p, _d in items}
        if len(exts) == 1:
            partial.append(ZipRegisterSkipped(stem=stem, ext=next(iter(exts)), folder=folder_in_zip))

    if partial and not confirm_partial:
        return ZipRegisterResult(
            created_documents=0, skipped=partial, target_path=target_path, needs_confirmation=True,
            duplicates=duplicates,
        )

    tail_problems = [
        problem
        for (folder_in_zip, stem), items in groups.items()
        for problem in registration_name_problems(
            db, doc_path_of(folder_in_zip), stem, [f for f, _e, _p, _d in items], rev,
        )
    ]
    if tail_problems:
        raise HTTPException(status_code=400, detail="\n".join(tail_problems))

    now = datetime.now(timezone.utc)
    created = 0
    attached = 0
    already: list[ZipRegisterExisting] = []

    for (folder_in_zip, stem), items in groups.items():
        doc_source_path = doc_path_of(folder_in_zip)

        # 같은 자리에 같은 이름의 자료가 이미 있으면 새로 만들지 않고 없는 형식만 붙인다.
        existing = find_existing_document(db, doc_source_path, stem)
        if existing:
            n, rejected = attach_files_to_document(db, existing, [(f, e, d) for f, e, _p, d in items], user, now)
            attached += n
            if rejected:
                already.append(ZipRegisterExisting(stem=stem, exts=rejected))
            continue

        exts = {ext for _f, ext, _p, _d in items}
        doc = Document(
            doc_class="DRAWING", drawing_no=stem, title=stem,
            source_path=doc_source_path, current_rev=rev, status="ACTIVE",
            has_dwg="dwg" in exts, has_pdf="pdf" in exts, is_archived=False,
            **classification_from_path(doc_source_path),
        )
        db.add(doc)
        db.flush()

        for filename, ext, pairing, data in items:
            dest = storage.latest_file_path(doc_source_path, stem, ext, pairing, rev=rev)
            file_size, sha256_hex = save_upload(data, dest)
            db.add(File(
                document_id=doc.id, rev=rev, branch=None, file_ext=ext,
                file_path=storage.to_relative(dest), pairing_folder=pairing,
                original_filename=filename, file_size=file_size, sha256=sha256_hex,
                uploaded_by=user.id, vendor_name=None, project_id=None, vendor_labeled_rev=None,
                rev_mismatch_warning=False, review_status="APPROVED",
                uploaded_at=now, is_current=True,
            ))
        created += 1

    db.add(AuditLog(
        user_id=user.id, action="ZIP_REGISTER", screen="폴더·자료 편집",
        detail={"target_path": target_path, "created": created, "partial": len(partial),
                "duplicates_skipped": len(duplicates), "attached_files": attached,
                "already_exists": len(already),
                "pair_folders": pair_folders or None},
    ))
    db.commit()

    return ZipRegisterResult(
        created_documents=created, skipped=[], target_path=target_path, duplicates=duplicates,
        attached_files=attached, already_exists=already, pair_folders=pair_folders,
    )


@router.post("/partial-files/export")
def export_partial_files(
    body: PartialFilesExportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """원본/PDF 한쪽만 있는 자료 확인 팝업(신규추가·Zip 등록)의 표를 그대로 xlsx로 내려준다.
    등록 전 확인 단계라 DB에 저장된 게 없으므로, 화면에 그려진 목록을 그대로 요청받아 내려준다."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "확인"
    ws.append(["No", "자료명", "DWG", "XLSX", "ETC", "PDF"])
    for i, item in enumerate(body.items, start=1):
        dwg, xlsx, etc, pdf = ext_flags([item.ext])
        ws.append([i, item.stem, dwg, xlsx, etc, pdf])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 40, 8, 8, 8, 8], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 관리", body.title)

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="폴더·자료 편집",
        detail={"kind": body.title, "count": len(body.items)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


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
    filename = build_export_filename("TDB 관리", "DWG·PDF 폴더 병합")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="폴더·자료 편집",
        detail={"kind": "DWG·PDF 폴더 병합", "count": len(candidates)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---------------------------------------------------------------------------
# 신규추가 (zip 없이 파일 여러 개를 그대로 올려 등록 — 자료 편집 화면 전용)
# ---------------------------------------------------------------------------

@router.get("/documents/existing-rev", response_model=ExistingDocRevLookup)
def lookup_existing_rev(
    path: str = "", stem: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(require_document_edit),
):
    """신규추가 팝업의 Rev 매칭용 — 등록하려는 폴더에 같은 이름(다른 형식)의 자료가
    이미 있으면 그 자료의 현재 Rev를 알려준다. [신규추가]에서 파일을 딱 1개 골랐을 때만
    프론트가 이 API로 확인해서 "이 파일도 그 Rev로 자동 등록됩니다"를 미리 보여준다.

    실제로 그 Rev를 강제하는 곳은 `attach_files_to_document`이고(항상 doc.current_rev를
    씀, 이 API는 그걸 미리 보여주는 조회 전용) — 여기서 없다고 나와도 등록 시점에 같은
    이름이 이미 있으면 여전히 새로 만들지 않고 기존 자료에 붙는다.
    """
    stem = stem.strip()
    if not stem:
        return ExistingDocRevLookup(found=False)
    folder = path.strip("\\") or None
    doc = find_existing_document(db, folder, registration_name(stem, folder))
    if doc is None:
        return ExistingDocRevLookup(found=False)
    exts = sorted({ext for ext, _folder in current_ext_pairs(db, doc.id)})
    return ExistingDocRevLookup(
        found=True, document_id=doc.id, current_rev=doc.current_rev, exts=exts,
    )


@router.post("/documents/register", response_model=BulkRegisterResult)
async def register_documents(
    target_path: str = Form(""),
    files: list[UploadFile] = UploadFileMarker(...),
    confirm_duplicates: bool = Form(False),
    rev: int = Form(0),
    db: Session = Depends(get_db),
    user: User = Depends(require_document_edit),
):
    """파일명(확장자 제외)이 같은 것끼리 묶어 자료 1건씩 등록한다.

    Zip 넣기와 달리 PDF가 없어도 등록을 막지 않는다 — 원본만 있거나 PDF만 있는 파일도
    올릴 수 있고, 그런 경우는 프론트에서 미리 경고 후 확인을 받고 여기로 넘어온다.

    등록하려는 폴더에 같은 이름의 자료가 이미 있으면 새로 만들지 않고, 아직 없는 형식만
    그 자료에 붙인다. 그 자료가 DWG·PDF 폴더를 쓰던 자료면 새 파일도 각각 그 폴더에 들어간다
    (2026-08-16 CM 확정). 이미 갖고 있는 형식은 덮어쓰지 않고 거절한다 — 내용을 바꾸려면
    [자료 교체]를 쓴다.

    rev: 새로 만드는 자료(같은 이름의 기존 자료가 없는 경우)에 적용할 Rev 번호. 안 주면
    0(2026-08-18 CM 확정). 이미 있는 자료에 형식만 추가로 붙이는 경우는 이 값을 쓰지 않고
    항상 그 자료의 현재 Rev를 그대로 따른다 — 원본·사본이 서로 다른 Rev를 가리키면 안 되므로
    무조건 기존 Rev로 맞춘다(프론트가 미리 [경고]로 확인시키고, 여기서도 다시 한번 무시한다).
    """
    target_path = target_path.strip("\\")
    ensure_not_pair_folder(db, target_path)

    # 리비전 꼬리(`_Rev00`)는 떼고 묶는다 — 꼬리는 자료명이 아니다(registration_name).
    groups: dict[str, list[tuple[str, str, bytes]]] = {}
    for upload in files:
        stem = registration_name(Path(upload.filename).stem, target_path or None)
        ext = file_ext_of(upload.filename)
        data = await upload.read()
        groups.setdefault(stem, []).append((upload.filename, ext, data))

    # 정상은 이름당 원본 1개+PDF 1개뿐 — 같은 확장자가 2개 이상이면 CM 확인이 먼저 필요하다.
    duplicates: list[ZipRegisterDuplicate] = []
    for stem, items in groups.items():
        dup_exts = duplicate_ext_groups([(f, e) for f, e, _d in items])
        if dup_exts:
            duplicates.append(ZipRegisterDuplicate(stem=stem, folder=target_path, exts=dup_exts))
    if duplicates and not confirm_duplicates:
        return BulkRegisterResult(
            created_documents=0, unmatched=[], target_path=target_path,
            needs_confirmation=True, duplicates=duplicates,
        )
    # 승인해도 어느 게 맞는 파일인지는 시스템이 판단할 수 없으므로, 그 자료는 등록하지 않고
    # 건너뛴다 — CM이 첨부를 다시 정리해 등록해야 한다.
    duplicate_stems = {d.stem for d in duplicates}
    groups = {stem: items for stem, items in groups.items() if stem not in duplicate_stems}

    tail_problems = [
        problem
        for stem, items in groups.items()
        for problem in registration_name_problems(db, target_path or None, stem, [f for f, _e, _d in items], rev)
    ]
    if tail_problems:
        raise HTTPException(status_code=400, detail="\n".join(tail_problems))

    now = datetime.now(timezone.utc)
    created = 0
    attached = 0
    unmatched: list[BulkRegisterUnmatched] = []
    already: list[ZipRegisterExisting] = []

    for stem, items in groups.items():
        # 같은 폴더에 같은 이름의 자료가 이미 있으면 새로 만들지 않고 없는 형식만 붙인다.
        existing = find_existing_document(db, target_path or None, stem)
        if existing:
            n, rejected = attach_files_to_document(db, existing, items, user, now)
            attached += n
            if rejected:
                already.append(ZipRegisterExisting(stem=stem, exts=rejected))
            continue

        exts = {ext for _f, ext, _d in items}

        doc = Document(
            doc_class="DRAWING", drawing_no=stem, title=stem,
            source_path=target_path or None, current_rev=rev, status="ACTIVE",
            has_dwg="dwg" in exts, has_pdf="pdf" in exts, is_archived=False,
            **classification_from_path(target_path or None),
        )
        db.add(doc)
        db.flush()

        for filename, ext, data in items:
            dest = storage.latest_file_path(target_path or None, stem, ext, rev=rev)
            file_size, sha256_hex = save_upload(data, dest)
            db.add(File(
                document_id=doc.id, rev=rev, branch=None, file_ext=ext,
                file_path=storage.to_relative(dest), pairing_folder=None,
                original_filename=filename,
                file_size=file_size, sha256=sha256_hex, uploaded_by=user.id,
                vendor_name=None, project_id=None, vendor_labeled_rev=None,
                rev_mismatch_warning=False, review_status="APPROVED",
                uploaded_at=now, is_current=True,
            ))
        created += 1

        if len(exts) == 1:
            unmatched.append(BulkRegisterUnmatched(stem=stem, only_ext=next(iter(exts))))

    db.add(AuditLog(
        user_id=user.id, action="REGISTER", screen="폴더·자료 편집",
        detail={"via": "폴더·자료 편집(신규추가)", "target_path": target_path,
                "created": created, "unmatched": len(unmatched), "duplicates_skipped": len(duplicates),
                "attached_files": attached, "already_exists": len(already)},
    ))
    db.commit()

    return BulkRegisterResult(
        created_documents=created, unmatched=unmatched, target_path=target_path, duplicates=duplicates,
        attached_files=attached, already_exists=already,
    )
