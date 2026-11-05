"""반입·검수 (개발 순서 7, 화면 5) — 가장 복잡한 부분.

- 기존 수정본 세트 업로드: 파일 세트 검증(D-19, PDF 필수), rev 자동 채번(D-14),
  업체 표기 불일치 경고, 동시 수정 분기(branch) 로직
- 신규 등록: doc_class 선택, 세트 검증
- 검수 대기 목록 → 승인/반려
"""

import shutil
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional

import openpyxl
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app import storage
from app.auth import current_user
from app.config import STORAGE_ROOT
from app.database import get_db
from app.models import AuditLog, Distribution, Document, File as FileModel, ImportIssue, Project, User
from app.permissions import has_permission, require_permission
from app.rev_naming import (
    NAME_MALFORMED, NAME_MISMATCH, NAME_MISSING, NAME_OTHER, TAIL_RULE_TEXT,
    applies_to, check_incoming_name, document_display_name, file_display_name, guess_base,
    new_name_tail_problem, rev_name, upload_base_name, upload_tail_problem,
)
from app.schemas import (
    BranchMergeResult,
    BulkMatchedItem,
    DiscardImportIssueRequest,
    DuplicateDistributionItem,
    ImportIssueBrief,
    ImportIssueFileItem,
    ImportIssueItem,
    ImportRunResult,
    PendingReviewFileItem,
    PendingReviewGroup,
    RegisterNewResult,
    ResolveImportIssueRequest,
    ReviewRequest,
    RevisionUploadResult,
)
from app.utils import (
    INTERNAL_VENDOR,
    build_export_filename,
    content_disposition_header,
    duplicate_ext_groups,
    extract_labeled_rev,
    labeled_rev_number,
    neutralize_formulas,
    pairing_folder_for_ext,
    pairing_folder_paths,
    sanitize_path_component,
    save_upload,
    strip_pairing_segment,
)

router = APIRouter(tags=["imports"])

# 권한.xlsx 기준(2026-08-12 CM 확정) 리프 권한 — role=ADMIN은 자동 통과.
require_import_register = require_permission("screen.tdb_import.register")
require_import_approve = require_permission("screen.tdb_import.review.approve")
require_import_reject = require_permission("screen.tdb_import.review.reject")
require_issue_reattach = require_permission("screen.tdb_import.issue.reattach")
require_issue_repath = require_permission("screen.tdb_import.issue.repath")
require_issue_recheck = require_permission("screen.tdb_import.issue.recheck")
require_issue_reject = require_permission("screen.tdb_import.issue.reject")


def format_rev_label(rev: int, branch: Optional[str]) -> str:
    return f"{rev}-{branch}" if branch else str(rev)


def file_ext_of(filename: str) -> str:
    return Path(filename).suffix.lstrip(".").lower()


def ensure_pdf_in_set(uploads: list[UploadFile]) -> None:
    """D-19: 파일 세트에 PDF가 없으면 등록 불가."""
    exts = {file_ext_of(u.filename) for u in uploads}
    if "pdf" not in exts:
        raise HTTPException(
            status_code=400,
            detail="파일 세트에 PDF가 없습니다. 원본과 PDF를 함께 올려야 등록됩니다 (D-19).",
        )


def ensure_matching_stems(uploads: list[UploadFile]) -> None:
    """자료 교체(폴더·자료 편집): 원본과 PDF를 함께 올릴 때 파일명(확장자 제외)이 서로 다르면
    어느 게 맞는 파일인지 알 방법이 없으므로 무조건 진행 불가로 막는다. 화면에서 경고 없이
    바로 차단해야 하는 유일한 경우 — 한쪽만 올렸을 때(단일 파일)는 비교 대상이 없어 통과."""
    # 리비전 꼬리(`_Rev00`)는 떼고 견준다 — `A.dwg`와 `A_Rev00.pdf`는 같은 자료다(rev_naming)
    stems = {upload_base_name(Path(u.filename).stem) for u in uploads}
    if len(stems) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"첨부한 파일들의 이름이 서로 다릅니다 ({', '.join(sorted(stems))}). "
                    f"원본과 PDF는 확장자만 다르고 이름은 같아야 교체할 수 있습니다.",
        )


def move_file(src: Path, dest: Path) -> bool:
    """파일을 옮긴다. 같은 드라이브면 즉시 이동이라 용량이 두 배로 늘지 않는다.

    원본이 없으면(이미 옮겨졌거나 사람이 지운 경우) 조용히 넘어간다 —
    검수 자체가 실패해서 DB가 어중간해지는 것보다 낫다.
    """
    if not src.is_file():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    shutil.move(str(src), str(dest))
    return True


def move_to_latest(doc: Document, file_row: FileModel) -> None:
    """승인본을 '최신'으로. 파일명은 {도면번호}_Rev{리비전}.{확장자}로 통일한다(rev_naming).

    원본이 DWG·PDF 폴더로 나뉘어 있던 자료면 그 폴더 안 자리를 그대로 이어받는다
    (pairing_folder는 promote_to_current이 이전 현재본에서 물려준다).
    """
    src = Path(STORAGE_ROOT) / file_row.file_path
    dest = storage.latest_file_path(
        doc.source_path, doc.drawing_no, file_row.file_ext, file_row.pairing_folder,
        rev=file_row.rev, branch=file_row.branch,
    )
    move_file(src, dest)
    file_row.file_path = storage.to_relative(dest)


def move_to_history(doc: Document, file_row: FileModel) -> None:
    """구본·반려본·분기본을 '이력'으로. 문서별/리비전별 폴더라 서로 덮어쓰지 않는다.

    파일명은 '최신'에 있을 때 바뀐 이름(예: A.dwg)이 아니라, 업체가 원래 보낸
    이름(original_filename, 예: A_R5.dwg)을 쓴다 — 이력에서는 그때 실제로
    받은 파일이 무엇인지 이름만 보고 알 수 있어야 한다.
    """
    src = Path(STORAGE_ROOT) / file_row.file_path
    dest = storage.history_file_path(
        doc.source_path, doc.drawing_no, file_row.rev, file_row.branch,
        file_row.original_filename,
    )
    move_file(src, dest)
    file_row.file_path = storage.to_relative(dest)


def promote_to_current(db: Session, doc: Document, set_files: list[FileModel], now) -> None:
    """검수대기 파일 세트를 '최신'으로 승격한다 (정식 rev 승인·병합본 승인 공용).

    기존 현재본은 이력으로 내리고, 이번 세트를 최신으로 올려 문서 상태를 갱신한다.
    """
    all_files = db.query(FileModel).filter(FileModel.document_id == doc.id).all()

    # 지금 현재본이 어느 DWG·PDF 폴더에 있었는지 기억해 두었다가 새 세트에 물려준다 —
    # 리비전이 올라가도 자료의 저장 위치 모양이 바뀌면 안 되기 때문 (2026-08-16 CM 확정).
    previous_pairs = [(f.file_ext, f.pairing_folder) for f in all_files if f.is_current]

    for f in all_files:
        if f.is_current:
            f.is_current = False
            move_to_history(doc, f)

    for f in set_files:
        f.pairing_folder = pairing_folder_for_ext(previous_pairs, f.file_ext)
        move_to_latest(doc, f)
        f.is_current = True

    doc.current_rev = set_files[0].rev
    doc.has_pdf = any(f.file_ext == "pdf" for f in set_files)
    doc.has_dwg = any(f.file_ext == "dwg" for f in set_files)
    doc.status = "ACTIVE"
    doc.updated_at = now


def merge_branch_siblings(db: Session, document_id: int) -> None:
    """이 문서의 아직 안 끝난 분기(branch) 파일들을 전부 '통합됨(MERGED)'으로 표시한다.

    이력(문서 상세의 리비전 타임라인)에는 그대로 남아, 나중에 봐도 어느 업체가
    언제 보낸 분기본이었는지 알 수 있다 — 지우지 않고 상태만 바꾼다 (D-6).
    """
    siblings = (
        db.query(FileModel)
        .filter(
            FileModel.document_id == document_id,
            FileModel.branch.isnot(None),
            FileModel.review_status.in_(("PENDING_REVIEW", "APPROVED")),
        )
        .all()
    )
    for f in siblings:
        f.review_status = "MERGED"


def as_folder_key(path: str) -> str:
    """폴더 경로를 비교용 형식으로 (구분자·대소문자 통일)."""
    return path.replace("\\", "/").strip("/").lower()


def normalize_folder(path: str, pair_paths: "set[str]") -> str:
    """zip 안 폴더 경로와 DB의 source_path를 같은 형식으로 맞춰 비교한다.

    업체가 원본/PDF를 DWG·PDF 형제 폴더로 나눠 보낸 경우 그 마지막 조각을 벗겨내 같은
    자료(원본+사본 세트)로 인식한다. 단 **DWG 폴더와 PDF 폴더가 둘 다 있는 자리에서만**
    벗겨낸다 — 한쪽만 있으면 그건 짝이 아니라 보통 폴더다(2026-08-21 CM 확정).
    pair_paths는 pairing_folder_paths()가 골라준 짝 폴더 경로 모음이다.
    """
    return strip_pairing_segment(as_folder_key(path), pair_paths)


def folder_pair_paths(paths: "Iterable[Optional[str]]") -> set[str]:
    """비교용으로 다듬은 폴더 목록에서 짝 폴더로 볼 자리를 골라낸다."""
    return pairing_folder_paths({as_folder_key(p or "") for p in paths})


def link_returned_distribution(
    db: Session, document_id: int, vendor_name: str, project_id: Optional[int], file_row: FileModel
) -> None:
    """이번 리비전이 어느 반출 건에 대한 반납인지 찾아 연결한다(returned_at/returned_file_id).

    사내(자체 통합)은 반출에 대응하는 게 아니므로 연결하지 않는다.
    같은 (문서, 업체)로 미반납 반출이 여러 건이면 가장 오래된 것과 연결한다.
    """
    if vendor_name == INTERNAL_VENDOR:
        return
    q = db.query(Distribution).filter(
        Distribution.document_id == document_id,
        Distribution.purpose == "MODIFY",
        Distribution.returned_at.is_(None),
        Distribution.vendor == vendor_name,
    )
    if project_id:
        q = q.filter(Distribution.project_id == project_id)
    dist = q.order_by(Distribution.distributed_at.asc()).first()
    if dist is None:
        return
    dist.returned_at = file_row.uploaded_at
    dist.returned_file_id = file_row.id


def duplicate_export_distributions(db: Session, document_id: int) -> list[Distribution]:
    """이 문서의 '아직 안 끝난' 수정용 반출 건들 — 반출미완료(미반납) + 검수대기(반납은 했지만
    아직 병합 전). 중복반출(분기) 여부·진행 건수·팝업 목록·병합 시 필요 파일종류 계산에 공용으로 쓴다.

    반납된 건은 그 반납 파일이 **검수대기**이거나, **승인됐지만 분기본이라 병합을 기다리는** 것만
    센다. 분기 글자 없이 승인된 반납본은 이미 현재본이 된 끝난 반출이다 — 예전에는 승인된 반납본을
    전부 세어서, 한 번이라도 반입·승인을 마친 자료는 다음 반입 때 검수대기 목록을 여는 순간
    중복반출(분기 'a', 통합필요)로 잘못 바뀌었다(2026-10-01 발견·수정).
    """
    unreturned = (
        db.query(Distribution)
        .filter(
            Distribution.document_id == document_id,
            Distribution.purpose == "MODIFY",
            Distribution.returned_at.is_(None),
        )
        .all()
    )
    returned_unresolved = (
        db.query(Distribution)
        .join(FileModel, Distribution.returned_file_id == FileModel.id)
        .filter(
            Distribution.document_id == document_id,
            Distribution.purpose == "MODIFY",
            Distribution.returned_at.isnot(None),
            or_(
                FileModel.review_status == "PENDING_REVIEW",
                and_(FileModel.review_status == "APPROVED", FileModel.branch.isnot(None)),
            ),
        )
        .all()
    )
    return unreturned + returned_unresolved


def compute_branch_progress(db: Session, document_id: int) -> tuple[Optional[int], Optional[int]]:
    """분기(중복반출) 상황의 (N, k) = (총 반출 건, 지금까지 반입된 건). 분기 아니면 (None, None).

    검수 중에 새 반출이 추가되면 '아직 안 돌아온' 건수가 늘어나 N도 그만큼 즉시 늘어난다.
    """
    dists = duplicate_export_distributions(db, document_id)
    total = len(dists)
    if total == 0:
        return None, None
    arrived = sum(1 for d in dists if d.returned_at is not None)
    return total, arrived


def sync_open_branch(db: Session, document_id: int) -> None:
    """검수대기 화면을 열 때마다, 분기 글자 없이 검수대기 중인 파일이 그 사이 반출이
    추가로 나가서 뒤늦게 '진짜 중복반출' 상태가 됐는지 다시 확인해 분기 'a'로 소급 전환한다.

    분기 배정은 원래 반입(업로드) 시점에 한 번만 판단했는데(determine_rev_branch), 그
    이후에 다른 업체로 반출이 새로 나가서 중복반출이 된 경우는 놓치고 있었다 — 검수대기
    목록의 '중복반출' 표시가 그 사이 상황 변화를 못 따라가는 원인이었다. 여기서 매번
    다시 계산해 반영하면, 분기 글자가 이미 있는 경우를 전제로 짜인 나머지 로직(병합 승인,
    반입Rev 진행률 표시 등)은 그대로 재사용할 수 있다.
    """
    doc = db.get(Document, document_id)
    if doc is None:
        return
    candidate_rev = doc.current_rev + 1
    pending = (
        db.query(FileModel)
        .filter(
            FileModel.document_id == document_id,
            FileModel.rev == candidate_rev,
            FileModel.branch.is_(None),
            FileModel.review_status == "PENDING_REVIEW",
        )
        .all()
    )
    if not pending:
        return
    total, _arrived = compute_branch_progress(db, document_id)
    if total is not None and total >= 2:
        for f in pending:
            f.branch = "a"


def determine_rev_branch(
    files: list[FileModel], distributions: list[Distribution], vendor_name: str, current_rev: int
) -> tuple[int, Optional[str]]:
    """업로드 시점 rev/branch 결정 (CLAUDE.md 6.4, CM 확정 수정: 리비전 정수는 승인돼야만 오른다).

    목표 rev는 항상 '현재 승인된 rev + 1' 하나뿐이다 — 반려가 몇 번이든 정수는 그대로다.
    반려된 시도는 반려되는 순간(review_revision REJECT)에 글자(a, b, c…)가 붙어 이력에 남고,
    다음 시도는 다시 같은 정수를 향한다. 정수가 오르는 건 승인됐을 때뿐이다.

    - 사내 통합본: current_rev+1, 분기 없음 (이게 곧 그 리비전이 됨)
    - 열려있는 분기(중복반출로 이미 글자가 붙어 진행 중인 시도)가 있으면: 같은 rev에 다음 분기문자
      (반려된 건 '열려있는' 것으로 안 침 — 이미 끝난 시도이므로 다음 시도의 글자 배정에 영향 없음)
    - 서로 다른 업체로의 미반납 수정용 반출이 2건 이상이면(진짜 중복반출): 새 분기 시작(a)
    - 그 외(단순 반려 후 재시도 포함): 글자 없이 current_rev+1
    """
    candidate_rev = current_rev + 1

    if vendor_name == INTERNAL_VENDOR:
        return candidate_rev, None

    # 이 rev를 향해 아직 결론 안 난(반려·통합 전) 시도들 — 검수를 미처 안 하고 또 올린 경우까지 포함.
    open_attempts = [
        f for f in files
        if f.rev == candidate_rev and f.review_status not in ("MERGED", "REJECTED")
    ]
    if open_attempts:
        used_letters = sorted({f.branch for f in open_attempts if f.branch is not None})
        if used_letters:
            next_letter = chr(ord(used_letters[-1]) + 1)
        else:
            # 먼저 있던 시도가 그동안 글자 없이(단순 재시도 취급) 대기 중이었는데, 이번에 또
            # 다른 시도가 겹쳐 들어왔다 — 이제 둘을 구분해야 하므로 먼저 있던 걸 'a'로 소급하고
            # 이번 걸 'b'로 매긴다.
            for f in open_attempts:
                f.branch = "a"
            next_letter = "b"
        return candidate_rev, next_letter

    distinct_vendors = {
        d.vendor for d in distributions if d.purpose == "MODIFY" and d.returned_at is None
    }
    if len(distinct_vendors) >= 2:
        return candidate_rev, "a"

    return candidate_rev, None


def create_revision_set(db, doc, file_tuples, vendor_name, project_id, admin_user, now):
    """한 문서에 리비전 파일 세트를 만든다 (커밋은 호출자가). 단건·대량 반입 공용.

    file_tuples: [(filename, bytes), ...]
    반환: (rev, branch, created_count, any_warning, branched)
    """
    existing_files = db.query(FileModel).filter(FileModel.document_id == doc.id).all()
    distributions = db.query(Distribution).filter(Distribution.document_id == doc.id).all()

    rev, branch = determine_rev_branch(existing_files, distributions, vendor_name, doc.current_rev)

    any_warning = False
    created_files: list[FileModel] = []
    for filename, data in file_tuples:
        ext = file_ext_of(filename)
        # 승인 전이므로 '검수대기'에 둔다. 승인하면 '최신'으로 옮긴다.
        dest = storage.pending_file_path(doc.id, doc.drawing_no, rev, branch, filename)
        file_size, sha256_hex = save_upload(data, dest)
        relative_path = storage.to_relative(dest)

        labeled = extract_labeled_rev(filename)
        labeled_num = labeled_rev_number(labeled)
        mismatch = labeled is not None and labeled_num != rev
        if mismatch:
            any_warning = True

        file_row = FileModel(
            document_id=doc.id,
            rev=rev,
            branch=branch,
            file_ext=ext,
            file_path=relative_path,
            original_filename=filename,  # 업체가 보낸 실제 이름. 최신에 올라가도 이 값은 안 바뀜.
            file_size=file_size,
            sha256=sha256_hex,
            uploaded_by=admin_user.id,
            vendor_name=vendor_name,
            project_id=project_id,
            vendor_labeled_rev=labeled,
            rev_mismatch_warning=mismatch,
            review_status="PENDING_REVIEW",
            uploaded_at=now,
            is_current=False,
        )
        db.add(file_row)
        created_files.append(file_row)

    branched = branch is not None
    if branched:
        doc.status = "MERGE_REQUIRED"
    # 검수대기 업로드는 '현재 자료'를 아직 바꾸지 않는다(승인돼야 최신본이 됨) → updated_at을
    # 건드리지 않는다. 승인되면 promote_to_current가, 반려되면 아무것도 안 바꾼다.
    # (예전엔 여기서 updated_at=now를 찍어, 반려로 끝난 자료가 최근수정 현황 맨 위로 올라오는
    #  버그가 있었다 — 2026-10-01 수정.)

    db.add(AuditLog(
        user_id=admin_user.id, action="UPLOAD", screen="반입·검수", document_id=doc.id,
        detail={"rev": rev, "branch": branch, "vendor_name": vendor_name,
                "file_count": len(created_files), "any_mismatch_warning": any_warning},
    ))
    if branched:
        db.add(AuditLog(
            user_id=admin_user.id, action="MERGE_REQUIRED", screen="반입·검수", document_id=doc.id,
            detail={"rev": rev, "branch": branch},
        ))

    if created_files:
        db.flush()  # id 확보해야 반출 건과 연결 가능
        representative = next((f for f in created_files if f.file_ext == "pdf"), created_files[0])
        link_returned_distribution(db, doc.id, vendor_name, project_id, representative)

    return rev, branch, len(created_files), any_warning, branched


@router.post("/documents/{document_id}/revisions", response_model=RevisionUploadResult)
async def upload_revision(
    document_id: int,
    vendor_name: str = Form(...),
    project_id: Optional[int] = Form(None),
    confirm_duplicates: bool = Form(False),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_import_register),
):
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다")

    ensure_pdf_in_set(files)

    # 정상은 원본 1개+PDF 1개뿐이다. 같은 확장자가 2개 이상이면 CM 확인이 먼저 필요하다.
    dup_exts = duplicate_ext_groups([(u.filename, file_ext_of(u.filename)) for u in files])
    if dup_exts and not confirm_duplicates:
        return RevisionUploadResult(
            document_id=document_id, message="같은 형식의 파일이 2개 이상 첨부되었습니다.",
            needs_confirmation=True, duplicate_exts=dup_exts,
        )

    file_tuples = [(u.filename, await u.read()) for u in files]
    now = datetime.now(timezone.utc)

    # D-14 재확인(2026-08-18 CM 확정): 표기 불일치는 검수대기로 바로 올리지 않고 확인필요로
    # 보낸다 — REASON_LABELS 근처 주석 참고. 검수대기에는 경고 표시가 있는 항목이 안 올라간다.
    # 2026-10-01부터 꼬리 없음·형식 오류도 같은 방식으로 확인필요에 간다(rev_tail_reasons).
    candidate_rev = doc.current_rev + 1
    _name_ok, tail_reasons = rev_tail_reasons(
        [fn for fn, _ in file_tuples], doc.drawing_no, doc.source_path, candidate_rev,
    )
    if tail_reasons:
        incoming = [
            IncomingFile(folder=None, filename=fn, ext=file_ext_of(fn), data=data, zip_path=fn)
            for fn, data in file_tuples
        ]
        text = rev_tail_detail_text(
            doc.drawing_no, doc.source_path, doc.current_rev, candidate_rev,
            [Path(fn).stem for fn, _ in file_tuples], tail_reasons,
        ) if applies_to(doc.source_path) else None
        if text is None:
            # P&ID·PFD — 예전 문장 그대로
            labeled = sorted({lbl for fn, _ in file_tuples if (lbl := extract_labeled_rev(fn))})
            text = (f"'{doc.drawing_no}'의 시스템 리비전은 {candidate_rev}인데, 첨부 파일에 표기된 "
                    f"리비전은 {', '.join(labeled)}(으)로 다릅니다. 확인 후 문제없으면 [재검수]를 "
                    f"눌러 검수 대기로 등록하세요.")
        save_issue(
            db, user, now,
            intended_document_id=doc.id, vendor_name=vendor_name, project_id=project_id,
            reasons=tail_reasons, detail={"text": text}, incoming=incoming,
        )
        db.commit()
        return RevisionUploadResult(
            document_id=document_id,
            message=f"파일 이름의 리비전 표기를 확인해야 해 확인 필요 목록으로 등록되었습니다 "
                    f"({reason_text_of(tail_reasons)}).",
        )

    rev, branch, created, _any_warning, branched = create_revision_set(
        db, doc, file_tuples, vendor_name, project_id, user, now
    )
    db.commit()

    message = "업로드 완료 — 검수 대기로 등록되었습니다."
    if branched:
        message = f"동시 수정 감지: rev {format_rev_label(rev, branch)} 분기로 저장되었습니다. 통합이 필요합니다."

    return RevisionUploadResult(
        document_id=document_id,
        rev=rev,
        branch=branch,
        rev_label=format_rev_label(rev, branch),
        file_count=created,
        any_mismatch_warning=False,
        branched=branched,
        message=message,
    )


# 반출 zip 안에 동봉되는 반출목록 엑셀 파일명은 "TDB 반출목록_시각.xlsx"로 매번 다르므로
# 정확히 일치가 아니라 이 접두사로 찾는다.
MANIFEST_FILENAME_PREFIX = "TDB 반출목록"

# 확인 필요 사유 코드 → 한글 라벨
REASON_LABELS = {
    "FILENAME_MISMATCH": "자료명 불일치",
    "PATH_MISMATCH": "경로 불일치",
    "ORIGINAL_MISSING": "원본 누락",
    "PDF_MISSING": "사본 누락",
    "ALREADY_IMPORTED": "기 반입 완료",
    "NOT_DISTRIBUTED": "반출 대상 아님",
    "DUPLICATE_FILE": "같은 형식 파일 중복",
    "REV_MISMATCH": "표기 불일치",
    "REV_TAG_MISSING": "리비전 표기 없음",
    "REV_TAG_MALFORMED": "리비전 표기 형식 오류",
}


def reason_text_of(reasons: list[str]) -> str:
    return ", ".join(REASON_LABELS.get(r, r) for r in reasons)


# 사유별 기본 설명 — 상세 데이터가 없는 옛 항목이라도 [사유상세]가 빈 창으로 뜨지 않게 한다.
GENERIC_REASON_TEXT = {
    "FILENAME_MISMATCH": "반출 자료명과 반입 자료명이 서로 다릅니다.",
    "PATH_MISMATCH": "반출 경로와 반입 경로가 서로 다릅니다.",
    "ORIGINAL_MISSING": "반출 때 함께 나갔던 원본이 이번 반입에 빠져 있습니다.",
    "PDF_MISSING": "반출 때 함께 나갔던 PDF(사본)가 이번 반입에 빠져 있습니다.",
    "ALREADY_IMPORTED": "이미 반입이 완료된 도면입니다.",
    "NOT_DISTRIBUTED": "반출 목록에 자료명이 일치하는 자료가 없습니다.",
    "DUPLICATE_FILE": "같은 형식(원본 또는 PDF)의 파일이 2개 이상 섞여 있어 어느 것이 맞는 파일인지 확인이 필요합니다.",
    "REV_MISMATCH": "업체가 표기한 리비전 번호가 시스템이 매길 번호와 다릅니다. 실수인지 확인이 필요합니다.",
    "REV_TAG_MISSING": "반입 파일 이름에 리비전 표기(_Rev01 등)가 없습니다. 수정한 자료인지 확인이 필요합니다.",
    "REV_TAG_MALFORMED": "반입 파일 이름의 리비전 표기 형식이 규칙(_Rev + 두 자리 숫자)과 다릅니다. 확인이 필요합니다.",
}


def name_keys(filename: str) -> list[str]:
    """반입 파일이 어느 반출 도면 것인지 찾을 때 견줄 이름들(소문자). 이름 그대로 → 정상 꼬리를
    뗀 것 → 형식이 틀린 꼬리를 뗀 것 순서다. 꼬리가 틀렸어도 일단 그 자료로 찾아 두어야
    '반출 대상 아님'이 아니라 '리비전 표기 형식 오류'로 정확히 알려줄 수 있다(2026-10-01)."""
    stem = Path(filename).stem
    keys: list[str] = []
    for candidate in (stem, upload_base_name(stem), guess_base(stem)):
        if candidate and candidate.lower() not in keys:
            keys.append(candidate.lower())
    return keys


def rev_tail_reasons(
    filenames: list[str], drawing_no: str, source_path: Optional[str], expected_rev: int,
) -> tuple[bool, list[str]]:
    """반입 파일 이름이 (그 자료 것인지, 리비전 표기 사유 목록)을 돌려준다 — 2026-10-01 CM 지시.

    반입 파일은 `도면번호_Rev{반출 Rev + 1}`이어야 정상이다(예: Rev00을 받아 가면 Rev01로 돌아와야
    한다). 업체가 받은 이름 그대로 돌려주면 수정한 것인지 받은 것인지 헷갈리기 때문이다.
      꼬리 없음        → REV_TAG_MISSING
      꼬리 형식이 틀림 → REV_TAG_MALFORMED (`_REV01`·`_R01`·`_Rev1`·`_Rev01(완료)` 등)
      번호가 다름      → REV_MISMATCH
    P&ID·PFD는 연도별 Rev 폴더로 관리하므로 예전 규칙 그대로다 — 이름이 도면번호와 같아야 하고,
    이름에 업체 표기가 있으면 그 번호만 본다.
    """
    if not applies_to(source_path):
        name_ok = all(Path(fn).stem.lower() == drawing_no.lower() for fn in filenames)
        labeled = [extract_labeled_rev(fn) for fn in filenames]
        mismatch = any(lbl is not None and labeled_rev_number(lbl) != expected_rev for lbl in labeled)
        return name_ok, (["REV_MISMATCH"] if mismatch else [])

    verdicts = [check_incoming_name(Path(fn).stem, drawing_no, expected_rev)[0] for fn in filenames]
    reasons = []
    if NAME_MISSING in verdicts:
        reasons.append("REV_TAG_MISSING")
    if NAME_MALFORMED in verdicts:
        reasons.append("REV_TAG_MALFORMED")
    if NAME_MISMATCH in verdicts:
        reasons.append("REV_MISMATCH")
    return all(v != NAME_OTHER for v in verdicts), reasons


def rev_tail_detail_text(
    drawing_no: str, source_path: Optional[str], sent_rev: int, expected_rev: int,
    stems: list[str], reasons: list[str],
) -> Optional[str]:
    """리비전 표기 사유의 상세 설명 한 문장(해당 사유가 없으면 None). P&ID·PFD는 부르는 쪽이 예전 문장을 쓴다."""
    tail_reasons = [r for r in ("REV_TAG_MISSING", "REV_TAG_MALFORMED", "REV_MISMATCH") if r in reasons]
    if not tail_reasons:
        return None
    sent = rev_name(drawing_no, sent_rev, None, source_path)
    expected = rev_name(drawing_no, expected_rev, None, source_path)
    problem = {
        "REV_TAG_MISSING": "리비전 표기가 없습니다",
        "REV_TAG_MALFORMED": f"리비전 표기 형식이 다릅니다({TAIL_RULE_TEXT})",
        "REV_MISMATCH": "리비전 번호가 다릅니다(받아 간 Rev 그대로 돌아왔을 수 있습니다)",
    }
    return (
        f"'{sent}'(으)로 반출한 자료라 반입 파일 이름은 '{expected}'이어야 하는데, 받은 파일 이름 "
        f"'{', '.join(sorted(set(stems)))}'은(는) {' / '.join(problem[r] for r in tail_reasons)}. "
        f"[비교]로 수정 내용을 확인한 뒤 문제없으면 [재검수]를 눌러 검수 대기로 등록하세요 — "
        f"승인되면 파일 이름은 시스템이 '{expected}'(으)로 맞춥니다."
    )


def fallback_detail_text(reasons: list[str], drawing_no: str) -> str:
    body = " ".join(
        GENERIC_REASON_TEXT.get(r, REASON_LABELS.get(r, r)) for r in reasons
    )
    return f"'{drawing_no}' — {body}" if body else "추가 설명이 없습니다."


def issue_display_name(db: Session, issue: ImportIssue) -> str:
    """확인 필요 목록에 보이는 자료명 — 대상 도면이 정해졌으면 그 자료명(꼬리 붙은 이름), 아니면
    받은 파일 이름 그대로(그 파일에 붙어 온 표기까지)."""
    if issue.intended_document_id:
        intended_doc = db.get(Document, issue.intended_document_id)
        if intended_doc:
            return document_display_name(intended_doc)
    detail = issue.detail or {}
    return detail.get("actual_stem") or Path(issue.original_filename).stem


def resolve_issue_drawing_no(db: Session, issue: ImportIssue) -> str:
    """확인 필요 항목의 표시용 자료명 — 대상 도면이 정해졌으면 그 도면명, 아니면 반입 파일명 추정치.
    목록(list_import_issues)의 자료명 칸과 미리보기 다운로드명이 같은 답을 보게 이 함수 하나로 모은다."""
    if issue.intended_document_id:
        intended_doc = db.get(Document, issue.intended_document_id)
        if intended_doc:
            return intended_doc.drawing_no
    detail = issue.detail or {}
    return detail.get("actual_stem") or Path(issue.original_filename).stem


def is_pdf(ext: str) -> bool:
    return ext == "pdf"


def parse_manifest_rows(data: bytes) -> list[tuple[int, Optional[str]]]:
    """반출목록.xlsx에서 (문서ID, 업체) 목록을 뽑는다.

    업체를 함께 읽는 이유: 같은 도면이 여러 업체로 동시에 나가 있을 때(중복반출),
    이 zip이 어느 업체 것인지를 업체 값으로 정확히 골라야 하기 때문.
    """
    import openpyxl

    wb = openpyxl.load_workbook(BytesIO(data), read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter, None)
    if not header:
        return []
    cols = {str(h).strip(): i for i, h in enumerate(header) if h is not None}
    id_idx = cols.get("문서ID")
    vendor_idx = cols.get("업체")
    if id_idx is None:
        return []
    out = []
    for row in rows_iter:
        if id_idx >= len(row) or row[id_idx] is None:
            continue
        try:
            doc_id = int(row[id_idx])
        except (ValueError, TypeError):
            continue
        vendor = None
        if vendor_idx is not None and vendor_idx < len(row) and row[vendor_idx] is not None:
            vendor = str(row[vendor_idx]).strip() or None
        out.append((doc_id, vendor))
    return out


@dataclass
class ExpectedDrawing:
    """반출된(=이번에 돌아와야 하는) 도면 하나. 반입 진단의 기준."""
    document_id: int
    drawing_no: str
    source_path: Optional[str]
    category: Optional[str]
    vendor: str
    project_id: Optional[int]
    rev_at_distribution: int
    current_rev: int  # 지금 승인된 rev — 표기 불일치 판정 기준(= current_rev+1이 이번 반입의 목표 rev)
    distributed_exts: set[str]
    already_returned: bool


@dataclass
class IncomingFile:
    folder: Optional[str]   # zip 내 폴더 경로 (반입자료는 None)
    filename: str
    ext: str
    data: bytes
    zip_path: str


def distributed_file_exts(db: Session, document_id: int, rev: int) -> set[str]:
    """반출 시점(rev_at_distribution)에 그 도면이 갖고 있던 파일 확장자 집합 = '반출자료'."""
    rows = (
        db.query(FileModel.file_ext)
        .filter(FileModel.document_id == document_id, FileModel.rev == rev)
        .all()
    )
    return {ext.lower() for (ext,) in rows if ext}


def build_expected_from_distributions(
    db: Session, dists: list[Distribution]
) -> list[ExpectedDrawing]:
    """반출 건 목록 → ExpectedDrawing 목록. 도면당 (있으면) 미반납 건을 우선 사용."""
    by_doc: dict[int, Distribution] = {}
    for d in sorted(dists, key=lambda x: (x.returned_at is not None, x.distributed_at)):
        # 미반납(returned_at None)을 먼저 보게 정렬 → 도면당 첫 건이 대표
        by_doc.setdefault(d.document_id, d)

    expected = []
    for doc_id, d in by_doc.items():
        doc = db.get(Document, doc_id)
        if doc is None:
            continue
        expected.append(ExpectedDrawing(
            document_id=doc_id,
            drawing_no=doc.drawing_no,
            source_path=doc.source_path,
            category=doc.category,
            vendor=d.vendor,
            project_id=d.project_id,
            rev_at_distribution=d.rev_at_distribution,
            current_rev=doc.current_rev,
            distributed_exts=distributed_file_exts(db, doc_id, d.rev_at_distribution),
            already_returned=d.returned_at is not None,
        ))
    return expected


def build_expected_from_manifest(
    db: Session, rows: list[tuple[int, Optional[str]]]
) -> list[ExpectedDrawing]:
    """반출목록 행(문서ID, 업체) → ExpectedDrawing. 업체가 있으면 그 업체의 반출 건을 고른다.

    같은 도면이 여러 업체로 동시에 나가 있어도(중복반출), 이 zip의 반출목록에 적힌
    업체로 정확히 골라 엉뚱한 업체의 반출 건에 반입되는 걸 막는다.
    """
    expected = []
    seen = set()
    for doc_id, vendor in rows:
        if doc_id in seen:
            continue
        seen.add(doc_id)
        doc = db.get(Document, doc_id)
        if doc is None:
            continue

        q = db.query(Distribution).filter(
            Distribution.document_id == doc_id, Distribution.purpose == "MODIFY"
        )
        if vendor:
            q = q.filter(Distribution.vendor == vendor)
        dists = q.order_by(
            Distribution.returned_at.isnot(None), Distribution.distributed_at
        ).all()
        if not dists and vendor:
            dists = (
                db.query(Distribution)
                .filter(Distribution.document_id == doc_id, Distribution.purpose == "MODIFY")
                .order_by(Distribution.returned_at.isnot(None), Distribution.distributed_at)
                .all()
            )
        if not dists:
            continue
        d = dists[0]
        expected.append(ExpectedDrawing(
            document_id=doc_id,
            drawing_no=doc.drawing_no,
            source_path=doc.source_path,
            category=doc.category,
            vendor=d.vendor,
            project_id=d.project_id,
            rev_at_distribution=d.rev_at_distribution,
            current_rev=doc.current_rev,
            distributed_exts=distributed_file_exts(db, doc_id, d.rev_at_distribution),
            already_returned=d.returned_at is not None,
        ))
    return expected


def save_issue(
    db: Session, admin_user, now, *,
    intended_document_id: Optional[int], vendor_name: str, project_id: Optional[int],
    reasons: list[str], detail: dict, incoming: list[IncomingFile],
) -> ImportIssue:
    """확인 필요 한 건(도면 하나 또는 반출 대상 아닌 파일 묶음)을 임시 보관한다.

    한 항목이 원본+PDF 등 여러 파일을 가질 수 있어 files(JSON)에 통째로 담는다.
    정식 File 행이 아니므로 CM이 검수 화면에서 처리(등록/재첨부/경로재선택/반려)할 때까지 대기.
    """
    first = incoming[0]
    issue = ImportIssue(
        reason=",".join(reasons),
        zip_relative_path=first.zip_path,
        original_filename=first.filename,
        stored_file_path="",
        file_size=0,
        sha256="",
        vendor_name=vendor_name,
        project_id=project_id,
        uploaded_by=admin_user.id,
        uploaded_at=now,
        status="PENDING",
        intended_document_id=intended_document_id,
        detail=detail,
    )
    db.add(issue)
    db.flush()  # id 확보

    stored = []
    for idx, inc in enumerate(incoming):
        dest = storage.quarantine_file_path(f"{issue.id}_{idx}", inc.filename)
        size, sha = save_upload(inc.data, dest)
        stored.append({
            "original_filename": inc.filename,
            "stored_file_path": storage.to_relative(dest),
            "file_ext": inc.ext,
            "file_size": size,
            "sha256": sha,
            "folder": inc.folder,  # zip 안 실제 폴더 (없으면 None) — 재검수 때 경로 재확인용
        })
    issue.files = stored
    issue.stored_file_path = stored[0]["stored_file_path"]
    issue.file_size = stored[0]["file_size"]
    issue.sha256 = stored[0]["sha256"]
    return issue


def run_import_engine(
    db: Session, admin_user, now,
    expected: list[ExpectedDrawing], incoming: list[IncomingFile],
    match_by_path: bool, default_vendor: str, default_project_id: Optional[int],
) -> tuple[list[BulkMatchedItem], list[ImportIssueBrief]]:
    """반입 파일들을 '반출된 도면 목록(expected)'과 대조해 진단한다.

    - 깨끗이 맞으면 → 검수 대기(정식 리비전) 생성
    - 자료명/경로 불일치, 원본/사본 누락, 기 반입 완료 → 확인 필요(ImportIssue)
    - 어느 반출 도면과도 안 맞으면 → 반출 대상 아님(ImportIssue)
    """
    # 업체가 보낸 zip 안에서 DWG 폴더와 PDF 폴더가 나란히 있는 자리만 짝 폴더로 본다.
    pair_paths = folder_pair_paths(i.folder for i in incoming)

    by_drawing: dict[str, list[ExpectedDrawing]] = {}
    by_folder: dict[str, list[ExpectedDrawing]] = {}
    by_folder_drawing: dict[tuple[str, str], ExpectedDrawing] = {}
    for e in expected:
        by_drawing.setdefault(e.drawing_no.lower(), []).append(e)
        if match_by_path:
            nf = normalize_folder(e.source_path or "", pair_paths)
            by_folder.setdefault(nf, []).append(e)
            by_folder_drawing[(nf, e.drawing_no.lower())] = e

    # 파일 → 반출 도면 배정 (배정 못 하면 stray)
    assigned: dict[int, dict] = {}
    stray: list[IncomingFile] = []

    for inc in incoming:
        keys = name_keys(inc.filename)
        target: Optional[ExpectedDrawing] = None
        flag: Optional[str] = None

        if match_by_path:
            nf = normalize_folder(inc.folder or "", pair_paths)
            folder_key = next((k for k in keys if (nf, k) in by_folder_drawing), None)
            name_key = next((k for k in keys if k in by_drawing), None)
            if folder_key is not None:
                target = by_folder_drawing[(nf, folder_key)]
            elif name_key is not None:
                target = by_drawing[name_key][0]
                flag = "PATH_MISMATCH"
            elif nf in by_folder and len(by_folder[nf]) == 1:
                # 폴더는 맞는데 이름이 다름 + 그 폴더에 걸린 반출 도면이 하나뿐 →
                # 그 도면으로 본다(대표 삼을 다른 후보가 없으므로 오배정 위험 없음).
                target = by_folder[nf][0]
                flag = "FILENAME_MISMATCH"
            # nf in by_folder인데 그 폴더에 도면이 2개 이상이면(예: 반출목록에 P&ID가
            # 65건 걸린 폴더) 어느 도면 것인지 시스템이 판단할 수 없으므로 여기서
            # 배정하지 않는다 — 엉뚱한 도면에 잘못 붙는 사고(2026-08-18 발견)를 막기
            # 위해 target을 None으로 남겨 stray(반출 대상 아님, 경로 재선택 대상)로 보낸다.
        else:
            # 반입자료: 폴더 정보 없음 → 이름으로만
            name_key = next((k for k in keys if k in by_drawing), None)
            if name_key is not None:
                target = by_drawing[name_key][0]

        if target is None:
            stray.append(inc)
        else:
            slot = assigned.setdefault(
                target.document_id, {"exp": target, "files": [], "flags": set()}
            )
            slot["files"].append(inc)
            if flag:
                slot["flags"].add(flag)

    matched: list[BulkMatchedItem] = []
    issues: list[ImportIssueBrief] = []

    for doc_id, slot in assigned.items():
        e: ExpectedDrawing = slot["exp"]
        incs: list[IncomingFile] = slot["files"]
        flags: set[str] = slot["flags"]
        imported_exts = {i.ext for i in incs}

        reasons: list[str] = []
        if e.already_returned:
            reasons.append("ALREADY_IMPORTED")
        if "PATH_MISMATCH" in flags:
            reasons.append("PATH_MISMATCH")
        # 리비전 꼬리를 뗀 이름이 이 자료 것인지, 꼬리가 규칙대로인지(반출 Rev + 1)
        name_ok, tail_reasons = rev_tail_reasons(
            [i.filename for i in incs], e.drawing_no, e.source_path, e.rev_at_distribution + 1,
        )
        if "FILENAME_MISMATCH" in flags or not name_ok:
            reasons.append("FILENAME_MISMATCH")

        missing = e.distributed_exts - imported_exts
        if any(is_pdf(x) for x in missing):
            reasons.append("PDF_MISSING")
        if any(not is_pdf(x) for x in missing):
            reasons.append("ORIGINAL_MISSING")

        # 정상은 원본 1개+PDF 1개뿐이다. 같은 확장자가 2개 이상 섞여 들어오면(예: PDF를
        # 실수로 두 번 넣음) 어느 게 맞는지 시스템이 판단할 수 없으므로 검수대기로 자동
        # 등록하지 않고 '확인 필요'로 보내 CM이 직접 보고 조치하게 한다.
        if duplicate_ext_groups([(i.filename, i.ext) for i in incs]):
            reasons.append("DUPLICATE_FILE")

        # D-14 재확인(2026-08-18 CM 확정): 표기 불일치는 검수대기에 빨간 줄로 올려 승인/반려로
        # 판단하게 하던 예전 방식을 버리고, 확인필요로 보내 [비교]로 직접 확인한 뒤 [재검수]로
        # 통과시키게 한다 — 검수대기에는 이제 경고 표시가 있는 항목이 올라가지 않는다.
        # 2026-10-01부터는 꼬리 없음·형식 오류도 같은 방식으로 확인필요에 간다(rev_tail_reasons).
        # 이름이 아예 다른 자료면(자료명 불일치) 꼬리를 따지는 게 뜻이 없어 그 사유만 남긴다.
        if "FILENAME_MISMATCH" not in reasons:
            reasons.extend(tail_reasons)

        if not reasons:
            doc = db.get(Document, doc_id)
            rev, branch, created, any_warning, branched = create_revision_set(
                db, doc, [(i.filename, i.data) for i in incs],
                e.vendor, e.project_id, admin_user, now,
            )
            matched.append(BulkMatchedItem(
                document_id=doc_id, drawing_no=doc.drawing_no,
                rev_label=format_rev_label(rev, branch), file_count=created,
                any_mismatch_warning=any_warning, branched=branched,
            ))
        else:
            detail = build_issue_detail(e, incs, reasons, imported_exts, missing)
            save_issue(
                db, admin_user, now,
                intended_document_id=doc_id, vendor_name=e.vendor,
                project_id=e.project_id, reasons=reasons, detail=detail, incoming=incs,
            )
            issues.append(ImportIssueBrief(
                drawing_no=e.drawing_no, reasons=reasons, reason_text=reason_text_of(reasons),
            ))

    # 어느 반출 도면과도 안 맞은 파일 → 이름(stem)별로 묶어 '반출 대상 아님'
    stray_groups: dict[str, list[IncomingFile]] = {}
    for inc in stray:
        stray_groups.setdefault(Path(inc.filename).stem, []).append(inc)
    for stem, incs in stray_groups.items():
        reasons = ["NOT_DISTRIBUTED"]
        detail = {
            "text": f"반출 목록에 '{stem}'와(과) 자료명이 일치하는 자료가 없습니다. "
                    f"수정용으로 반출된 적이 없는 파일이라 어느 도면인지 확인이 필요합니다. "
                    f"[경로 재선택]으로 도면을 지정한 뒤 [재검수]를 눌러주세요.",
            "actual_stem": stem,
            "imported_exts": sorted({i.ext for i in incs}),
        }
        save_issue(
            db, admin_user, now,
            intended_document_id=None, vendor_name=default_vendor,
            project_id=default_project_id, reasons=reasons, detail=detail, incoming=incs,
        )
        issues.append(ImportIssueBrief(
            drawing_no=stem, reasons=reasons, reason_text=reason_text_of(reasons),
        ))

    return matched, issues


def build_issue_detail(
    e: ExpectedDrawing, incs: list[IncomingFile], reasons: list[str],
    imported_exts: set[str], missing: set[str],
) -> dict:
    """확인 필요 항목의 상세 설명 문장 + 구조 데이터를 만든다."""
    parts: list[str] = []
    pair_paths = folder_pair_paths(i.folder for i in incs)
    actual_paths = sorted({normalize_folder(i.folder or "", pair_paths) for i in incs if i.folder is not None})
    actual_stems = sorted({Path(i.filename).stem for i in incs})

    if "ALREADY_IMPORTED" in reasons:
        parts.append(f"'{e.drawing_no}'은(는) 이미 반입이 완료된 도면입니다.")
    if "PATH_MISMATCH" in reasons:
        parts.append(
            f"'{e.drawing_no}'의 반출 경로는 '{e.source_path or '(경로 없음)'}'인데, "
            f"반입 경로는 '{', '.join(actual_paths) or '(경로 없음)'}'(으)로 "
            f"경로가 일치하지 않습니다."
        )
    sent_name = rev_name(e.drawing_no, e.rev_at_distribution, None, e.source_path)
    if "FILENAME_MISMATCH" in reasons:
        parts.append(
            f"'{e.source_path or '(경로 없음)'}' 경로의 반출 자료명은 '{sent_name}'인데, "
            f"반입 자료명은 '{', '.join(actual_stems)}'(으)로 자료명이 일치하지 않습니다."
        )
    if "ORIGINAL_MISSING" in reasons:
        miss = sorted(x for x in missing if not is_pdf(x))
        parts.append(
            f"'{e.drawing_no}'은(는) 반출 때 원본({', '.join(miss)})이 함께 나갔는데, "
            f"이번 반입에는 원본이 빠져 있습니다."
        )
    if "PDF_MISSING" in reasons:
        parts.append(
            f"'{e.drawing_no}'은(는) 반출 때 PDF(사본)가 함께 나갔는데, "
            f"이번 반입에는 PDF가 빠져 있습니다."
        )
    if "DUPLICATE_FILE" in reasons:
        dup = ", ".join(duplicate_ext_groups([(i.filename, i.ext) for i in incs]))
        parts.append(f"같은 형식({dup})의 파일이 2개 이상 섞여 있습니다.")
    tail_text = rev_tail_detail_text(
        e.drawing_no, e.source_path, e.rev_at_distribution, e.rev_at_distribution + 1,
        actual_stems, reasons,
    ) if applies_to(e.source_path) else None
    if tail_text:
        parts.append(tail_text)
    elif "REV_MISMATCH" in reasons:
        # P&ID·PFD — 예전 문장 그대로
        labeled = sorted({
            extract_labeled_rev(i.filename) for i in incs if extract_labeled_rev(i.filename)
        })
        parts.append(
            f"'{e.drawing_no}'의 시스템 리비전은 {e.current_rev + 1}인데, 첨부 파일에 표기된 "
            f"리비전은 {', '.join(labeled)}(으)로 다릅니다. 확인 후 문제없으면 [재검수]를 눌러 "
            f"검수 대기로 등록하세요."
        )

    return {
        "text": " ".join(parts),
        "expected_drawing_no": e.drawing_no,
        "expected_path": e.source_path,
        "actual_paths": actual_paths,
        "actual_stems": actual_stems,
        "distributed_exts": sorted(e.distributed_exts),
        "imported_exts": sorted(imported_exts),
        "missing_exts": sorted(missing),
    }


def detect_wrapper_prefix(manifest_names: set[str]) -> str:
    """반출 zip을 풀었다가 그 폴더째로 다시 압축하면(윈도우 '압축(zip) 폴더로 보내기')
    zip 안에 폴더가 통째로 한 겹 더 씌워진다 (예: "TDB 반출_.../6. LIST/...").

    정상 반출 zip은 반출목록 엑셀이 항상 zip 최상위(루트)에 있으므로,
    반입된 zip에서 반출목록 엑셀이 루트가 아니라 폴더 안에 들어있다면
    그 폴더가 통째로 덧씌워진 겹껍질이라는 뜻 — 경로 비교 전에 벗겨낸다.
    """
    if not manifest_names:
        return ""
    manifest_dir = str(PurePosixPath(sorted(manifest_names)[0].replace("\\", "/")).parent)
    return "" if manifest_dir == "." else manifest_dir


def read_zip_incoming(zf: zipfile.ZipFile, manifest_names: set[str]) -> list[IncomingFile]:
    """zip에서 도면 파일들을 읽는다 (반출목록.xlsx는 제외).

    윈도우에서 압축을 풀었다가 그 폴더째로 재압축해 생기는 겹껍질 폴더는
    detect_wrapper_prefix로 감지해 벗겨낸 뒤 경로를 계산한다.
    """
    wrapper = detect_wrapper_prefix(manifest_names)
    wrapper_prefix = f"{wrapper}/" if wrapper else ""

    incoming = []
    for info in zf.infolist():
        if info.is_dir() or info.filename in manifest_names:
            continue
        raw_path = info.filename.replace("\\", "/")
        rel_path = raw_path[len(wrapper_prefix):] if wrapper_prefix and raw_path.startswith(wrapper_prefix) else raw_path
        p = PurePosixPath(rel_path)
        folder = "" if str(p.parent) == "." else str(p.parent)
        incoming.append(IncomingFile(
            folder=folder, filename=p.name, ext=file_ext_of(p.name),
            data=zf.read(info), zip_path=raw_path,
        ))
    return incoming


def run_message(matched, issues) -> str:
    msg = f"{len(matched)}건이 검수 대기에 등록되었습니다."
    if issues:
        msg += f" {len(issues)}건은 확인이 필요해 아래 '확인 필요' 목록에 표시됩니다."
    if not matched and not issues:
        msg = "처리할 파일이 없습니다."
    return msg


@router.post("/documents/revisions/bulk", response_model=ImportRunResult)
async def bulk_upload_revisions(
    zip_file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_import_register),
):
    """반출 때 받은 zip(반출목록.xlsx + 폴더 구조 + 도면)을 그대로 반입한다.

    zip 안 반출목록.xlsx의 문서ID로 '이 zip이 어느 도면들에 대한 것인지'를 알아내고,
    그 도면들의 반출 건 정보(공사·업체·반출Rev·반출자료)를 기준으로 반입 파일을 대조·진단한다.
    공사·업체는 반출목록에 적혀 있으므로 화면에서 따로 고르지 않아도 된다.
    """
    admin_user = user
    now = datetime.now(timezone.utc)

    zip_bytes = await zip_file.read()
    try:
        zf = zipfile.ZipFile(BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="올바른 zip 파일이 아닙니다")

    manifest_names = {
        info.filename for info in zf.infolist()
        if not info.is_dir()
        and Path(info.filename).name.startswith(MANIFEST_FILENAME_PREFIX)
        and Path(info.filename).name.endswith(".xlsx")
    }
    if not manifest_names:
        raise HTTPException(
            status_code=400,
            detail="zip 안에 TDB 반출목록 엑셀이 없습니다. 반출할 때 받은 zip을 그대로 올려주세요.",
        )
    manifest_rows = parse_manifest_rows(zf.read(sorted(manifest_names)[0]))
    if not manifest_rows:
        raise HTTPException(status_code=400, detail="반출목록.xlsx에서 도면 정보를 읽지 못했습니다.")

    # 이 zip이 다루는 도면들의 수정용 반출 건(반출목록의 업체 기준)으로 기대 목록을 만든다
    expected = build_expected_from_manifest(db, manifest_rows)

    default_vendor = expected[0].vendor if expected else "미상"
    default_project_id = expected[0].project_id if expected else None

    incoming = read_zip_incoming(zf, manifest_names)
    matched, issues = run_import_engine(
        db, admin_user, now, expected, incoming,
        match_by_path=True, default_vendor=default_vendor,
        default_project_id=default_project_id,
    )
    db.commit()

    return ImportRunResult(matched=matched, issues=issues, message=run_message(matched, issues))


@router.post("/documents/revisions/by-selection", response_model=ImportRunResult)
async def upload_revisions_by_selection(
    distribution_ids: str = Form(...),  # 쉼표구분 (자료검색에서 체크한 반출 건)
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_import_register),
):
    """zip 없이, 자료검색에서 체크한 반출 도면들에 파일(원본+PDF)을 올려 반입한다.

    폴더 정보가 없으므로 업로드 파일명(도면번호)으로 체크한 도면에 배정한다.
    """
    admin_user = user
    now = datetime.now(timezone.utc)

    dist_ids = [int(x) for x in distribution_ids.split(",") if x.strip()]
    if not dist_ids:
        raise HTTPException(status_code=400, detail="대상 도면을 먼저 선택해주세요.")

    dists = db.query(Distribution).filter(Distribution.id.in_(dist_ids)).all()
    if not dists:
        raise HTTPException(status_code=404, detail="선택한 반출 건을 찾을 수 없습니다.")
    expected = build_expected_from_distributions(db, dists)

    default_vendor = expected[0].vendor if expected else "미상"
    default_project_id = expected[0].project_id if expected else None

    incoming = [
        IncomingFile(folder=None, filename=u.filename, ext=file_ext_of(u.filename),
                     data=await u.read(), zip_path=u.filename)
        for u in files
    ]
    matched, issues = run_import_engine(
        db, admin_user, now, expected, incoming,
        match_by_path=False, default_vendor=default_vendor,
        default_project_id=default_project_id,
    )
    db.commit()

    return ImportRunResult(matched=matched, issues=issues, message=run_message(matched, issues))


@router.post("/documents/register-new", response_model=RegisterNewResult)
async def register_new(
    doc_class: str = Form(...),
    drawing_no: str = Form(...),
    title: Optional[str] = Form(None),
    category: Optional[str] = Form(None),
    discipline: Optional[str] = Form(None),
    doc_type: Optional[str] = Form(None),
    isbl_osbl: Optional[str] = Form(None),
    elevation: Optional[str] = Form(None),
    area: Optional[str] = Form(None),
    vendor_name: Optional[str] = Form(None),
    project_id: Optional[int] = Form(None),
    confirm_duplicates: bool = Form(False),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_import_register),
):
    admin_user = user

    ensure_pdf_in_set(files)

    # 정상은 원본 1개+PDF 1개뿐이다. 같은 확장자가 2개 이상이면 CM 확인이 먼저 필요하다.
    dup_exts = duplicate_ext_groups([(u.filename, file_ext_of(u.filename)) for u in files])
    if dup_exts and not confirm_duplicates:
        return RegisterNewResult(
            drawing_no=drawing_no, needs_confirmation=True, duplicate_exts=dup_exts,
        )

    is_isometric = bool(doc_type and "isometric" in doc_type.lower())

    # 신규 등록은 원본 공유폴더에 없던 것이라 경로가 없다.
    # 입력한 분류(대분류\공종\도면종류)로 폴더 경로를 만들어 '최신' 안에서 제자리를 찾게 한다.
    source_path = "\\".join(p for p in [category, discipline, doc_type] if p) or None
    tail_problem = new_name_tail_problem(drawing_no, source_path)
    if tail_problem:
        raise HTTPException(status_code=400, detail=tail_problem)

    doc = Document(
        doc_class=doc_class,
        drawing_no=drawing_no,
        title=title or drawing_no,
        category=category,
        discipline=discipline,
        doc_type=doc_type,
        isbl_osbl=isbl_osbl,
        elevation=elevation,
        area=area,
        source_path=source_path,
        is_isometric=is_isometric,
        project_id=project_id,
        current_rev=0,
        status="ACTIVE",
        has_dwg=False,
        has_pdf=False,
    )
    db.add(doc)
    db.flush()

    now = datetime.now(timezone.utc)
    created = 0
    has_dwg = False
    has_pdf = False

    for upload in files:
        data = await upload.read()
        ext = file_ext_of(upload.filename)
        # 신규 등록은 CM이 직접 올리는 것이라 바로 승인 상태 → '최신'에 저장
        dest = storage.latest_file_path(doc.source_path, drawing_no, ext, rev=0)
        file_size, sha256_hex = save_upload(data, dest)
        relative_path = storage.to_relative(dest)

        if ext == "dwg":
            has_dwg = True
        if ext == "pdf":
            has_pdf = True

        db.add(FileModel(
            document_id=doc.id,
            rev=0,
            branch=None,
            file_ext=ext,
            file_path=relative_path,
            original_filename=upload.filename,
            file_size=file_size,
            sha256=sha256_hex,
            uploaded_by=admin_user.id,
            vendor_name=vendor_name,
            project_id=project_id,
            vendor_labeled_rev=None,
            rev_mismatch_warning=False,
            review_status="APPROVED",
            uploaded_at=now,
            is_current=True,
        ))
        created += 1

    doc.has_dwg = has_dwg
    doc.has_pdf = has_pdf

    db.add(AuditLog(
        user_id=admin_user.id,
        action="REGISTER", screen="반입·검수",
        document_id=doc.id,
        detail={"drawing_no": drawing_no, "doc_class": doc_class, "file_count": created},
    ))
    db.commit()

    return RegisterNewResult(
        document_id=doc.id, drawing_no=drawing_no, rev=0, file_count=created
    )


@router.get("/revisions/pending-review", response_model=list[PendingReviewGroup])
def pending_review(db: Session = Depends(get_db)):
    doc_ids_with_pending = {
        row[0] for row in db.query(FileModel.document_id)
        .filter(FileModel.review_status == "PENDING_REVIEW")
        .distinct()
    }
    for document_id in doc_ids_with_pending:
        sync_open_branch(db, document_id)
    db.commit()

    rows = (
        db.query(FileModel)
        .filter(FileModel.review_status == "PENDING_REVIEW")
        .order_by(FileModel.document_id, FileModel.rev, FileModel.branch, FileModel.id)
        .all()
    )

    groups: dict[tuple, list[FileModel]] = {}
    for f in rows:
        groups.setdefault((f.document_id, f.rev, f.branch), []).append(f)

    result = []
    for (document_id, rev, branch), files in groups.items():
        doc = db.get(Document, document_id)
        project_name = None
        if files[0].project_id:
            project = db.get(Project, files[0].project_id)
            project_name = project.name if project else None

        branch_expected = branch_arrived = None
        can_approve = True
        if branch is not None:
            branch_expected, branch_arrived = compute_branch_progress(db, document_id)
            can_approve = branch_expected is None or branch_arrived >= branch_expected

        # 연결된 반출 건 → 반출Rev / 반출자료
        file_ids = [f.id for f in files]
        linked_dist = (
            db.query(Distribution)
            .filter(Distribution.returned_file_id.in_(file_ids))
            .first()
        )
        distributed_rev = linked_dist.rev_at_distribution if linked_dist else None
        distributed_exts = (
            sorted(distributed_file_exts(db, document_id, distributed_rev))
            if distributed_rev is not None else []
        )
        imported_exts = sorted({f.file_ext for f in files})

        result.append(PendingReviewGroup(
            representative_file_id=files[0].id,
            document_id=document_id,
            drawing_no=doc.drawing_no,
            # 검수할 세트의 이름 — 그 세트의 리비전으로 꼬리를 붙인다(승인되면 이 이름이 된다)
            display_name=file_display_name(doc, files[0]),
            title=doc.title,
            area=doc.area,
            category=doc.category,
            source_path=doc.source_path,
            rev=rev,
            branch=branch,
            rev_label=format_rev_label(rev, branch),
            distributed_rev=distributed_rev,
            distributed_exts=distributed_exts,
            imported_exts=imported_exts,
            vendor_name=files[0].vendor_name,
            project_name=project_name,
            uploaded_at=files[0].uploaded_at,
            any_mismatch_warning=any(f.rev_mismatch_warning for f in files),
            has_pdf=any(f.file_ext == "pdf" for f in files),
            files=[
                PendingReviewFileItem(
                    id=f.id,
                    file_ext=f.file_ext,
                    original_filename=f.original_filename,
                    file_size=f.file_size,
                    vendor_labeled_rev=f.vendor_labeled_rev,
                    rev_mismatch_warning=f.rev_mismatch_warning,
                )
                for f in files
            ],
            branch_expected=branch_expected,
            branch_arrived=branch_arrived,
            can_approve=can_approve,
        ))

    return result


@router.get("/revisions/pending-review/export")
def export_pending_review(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """검수 대기 목록을 화면과 같은 내용으로 xlsx로 내려준다."""
    groups = pending_review(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "검수대기"
    ws.append([
        "No", "공사", "업체", "자료명", "분류", "경로", "반출Rev", "반입Rev",
        "반출자료", "반입자료", "중복반출", "업로드일시",
    ])
    for i, g in enumerate(groups, start=1):
        dup = f"{g.branch_arrived}/{g.branch_expected}" if g.branch_expected is not None else ""
        ws.append([
            i, g.project_name, g.vendor_name, g.drawing_no, g.category, g.source_path,
            g.distributed_rev, g.rev_label,
            ", ".join(g.distributed_exts), ", ".join(g.imported_exts), dup,
            g.uploaded_at.strftime("%Y-%m-%d %H:%M") if g.uploaded_at else None,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 16, 12, 26, 16, 50, 9, 9, 14, 14, 9, 17], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 반입·검수", "검수 대기")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반입·검수", document_id=None,
        detail={"kind": "검수대기", "count": len(groups)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.post("/revisions/{file_id}/review")
def review_revision(
    file_id: int, body: ReviewRequest, db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    admin_user = user

    target = db.get(FileModel, file_id)
    if target is None:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    # 두 사람이 같은 순간에 같은 자료를 승인·반려해도 한 번만 처리되도록, 그 자료를 잠그고
    # (먼저 누른 사람의 처리가 끝날 때까지 기다린 뒤) 상태를 다시 읽는다 (2026-09-17 시큐어코딩).
    # 잠금 순서는 언제나 "자료 먼저"로 둔다 — 파일부터 잠그면 같은 세트(원본+PDF)를 서로 하나씩
    # 쥐고 기다리는 교착이 생길 수 있다.
    db.query(Document).filter(Document.id == target.document_id).with_for_update().one()
    db.refresh(target)
    if target.review_status != "PENDING_REVIEW":
        raise HTTPException(status_code=400, detail="이미 검수 처리된 건입니다")

    action = body.action.upper()
    if action not in ("APPROVE", "REJECT"):
        raise HTTPException(status_code=400, detail="action은 APPROVE 또는 REJECT여야 합니다")
    required_leaf = (
        "screen.tdb_import.review.approve" if action == "APPROVE" else "screen.tdb_import.review.reject"
    )
    if not has_permission(db, user, required_leaf):
        raise HTTPException(status_code=403, detail="이 기능을 사용할 권한이 없습니다")

    doc = db.get(Document, target.document_id)
    set_files = (
        db.query(FileModel)
        .filter(
            FileModel.document_id == target.document_id,
            FileModel.rev == target.rev,
            FileModel.branch.is_(target.branch) if target.branch is None
            else FileModel.branch == target.branch,
            FileModel.review_status == "PENDING_REVIEW",
        )
        .all()
    )

    now = datetime.now(timezone.utc)

    if action == "REJECT":
        # 반려된 파일이 어느 반출 건의 반납이었으면, 그 반출 건은 다시 '미반납'으로 되돌린다
        # (반려됐으니 실제로는 아직 정상 반납된 게 아님 — 중복반출 N/N 카운트도 이걸로 자동 보정됨).
        file_ids = [f.id for f in set_files]
        reopened = db.query(Distribution).filter(Distribution.returned_file_id.in_(file_ids)).all()
        for d in reopened:
            d.returned_at = None
            d.returned_file_id = None

        # 리비전 정수는 승인된 것만 올라간다(CM 확정) — 반려는 정수를 소모하지 않고, 같은
        # 정수 밑에 글자(a, b, c…)로만 이력에 남는다. 아직 글자가 없던(=단순 재시도였던)
        # 시도만 여기서 글자를 매긴다. 이미 중복반출로 글자가 붙어 있던 시도는 그대로 쓴다.
        reject_letter = target.branch
        if reject_letter is None:
            prior_rejected_letters = {
                b for (b,) in db.query(FileModel.branch)
                    .filter(
                        FileModel.document_id == target.document_id,
                        FileModel.rev == target.rev,
                        FileModel.branch.isnot(None),
                        FileModel.review_status == "REJECTED",
                    )
                    .distinct()
            }
            reject_letter = chr(ord("a") + len(prior_rejected_letters))

        # 반려본도 기록으로 남긴다 (삭제하지 않음 — D-6). 검수대기 → 이력으로 이동.
        for f in set_files:
            f.review_status = "REJECTED"
            f.review_note = body.note
            f.branch = reject_letter
            move_to_history(doc, f)
        # 반려는 '현재 자료'를 바꾸지 않는다(최신본은 그대로) → updated_at을 건드리지 않는다.
        # 이걸 건드리면 수정 없이 끝난 자료가 최근수정 현황에 오늘 날짜로 뜬다 (2026-10-01 수정).
        db.add(AuditLog(
            user_id=admin_user.id, action="REJECT", screen="반입·검수", document_id=doc.id,
            detail={"rev": target.rev, "branch": reject_letter, "note": body.note},
        ))
        db.commit()
        return {"status": "rejected", "rev_label": format_rev_label(target.rev, reject_letter)}

    # APPROVE
    is_internal = any(f.vendor_name == INTERNAL_VENDOR for f in set_files)
    is_branch = target.branch is not None

    if is_branch:
        # 중복반출(분기)이면 반출된 도면이 전부 반입되기 전엔 승인할 수 없다.
        branch_expected, branch_arrived = compute_branch_progress(db, target.document_id)
        if branch_expected is not None and branch_arrived < branch_expected:
            raise HTTPException(
                status_code=400,
                detail=f"아직 반출된 도면이 모두 반입되지 않았습니다 ({branch_arrived}/{branch_expected}). "
                       f"전부 반입된 후에 승인할 수 있습니다.",
            )

    for f in set_files:
        f.review_status = "APPROVED"
        f.review_note = body.note

    if is_branch:
        # 분기본은 승인해도 아직 현재본이 아니다(통합 전). 검수대기 → 이력으로만 옮긴다.
        for f in set_files:
            move_to_history(doc, f)
        doc.status = "MERGE_REQUIRED"
    else:
        # 정식 rev 또는 통합본 → 현재본으로 전환
        promote_to_current(db, doc, set_files, now)
        if is_internal:
            merge_branch_siblings(db, doc.id)

    doc.updated_at = now
    db.add(AuditLog(
        user_id=admin_user.id, action="APPROVE", screen="반입·검수", document_id=doc.id,
        detail={"rev": target.rev, "branch": target.branch, "is_internal": is_internal},
    ))
    db.commit()

    return {
        "status": "approved",
        "rev_label": format_rev_label(target.rev, target.branch),
        "document_status": doc.status,
    }


@router.get(
    "/documents/{document_id}/duplicate-distributions",
    response_model=list[DuplicateDistributionItem],
)
def duplicate_distributions(document_id: int, db: Session = Depends(get_db)):
    """중복반출(분기) 팝업: 이 도면이 동시에 나가 있는 반출 건들 — 어느 공사·업체로,
    언제 나갔는지와 지금 상태(검수대기/반출미완료)."""
    dists = duplicate_export_distributions(db, document_id)
    result = []
    for d in sorted(dists, key=lambda x: x.distributed_at):
        project_name = None
        if d.project_id:
            project = db.get(Project, d.project_id)
            project_name = project.name if project else None
        status = "PENDING_REVIEW" if d.returned_at is not None else "OUTSTANDING"
        result.append(DuplicateDistributionItem(
            project_name=project_name, vendor=d.vendor,
            distributed_at=d.distributed_at, status=status,
        ))
    return result


@router.get("/documents/{document_id}/duplicate-distributions/export")
def export_duplicate_distributions(
    document_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """중복반출 현황 팝업을 화면과 같은 내용으로 xlsx로 내려준다."""
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다")
    rows = duplicate_distributions(document_id, db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "중복반출현황"
    ws.append(["No", "공사", "업체", "반출일시", "상태"])
    for i, r in enumerate(rows, start=1):
        status_label = "검수대기" if r.status == "PENDING_REVIEW" else "반출미완료"
        ws.append([
            i, r.project_name, r.vendor,
            r.distributed_at.strftime("%Y-%m-%d %H:%M") if r.distributed_at else None,
            status_label,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 16, 12, 17, 11], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 반입·검수", "중복반출 현황", suffix=sanitize_path_component(doc.drawing_no))

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반입·검수", document_id=document_id,
        detail={"kind": "중복반출현황", "count": len(rows)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.post("/documents/{document_id}/branch-merge", response_model=BranchMergeResult)
async def branch_merge(
    document_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """중복반출(분기) 승인: 반출된 도면이 전부 반입된 뒤, CM이 캐디안에서 직접 병합한
    최종본(원본+사본 등)을 첨부해 그 자리에서 승인까지 끝낸다.

    경로는 검수대기 단계에서 이미 확인이 끝났으므로 여기서 다시 보지 않는다.
    파일명은 전부 이 도면의 도면번호와 같아야 하고(반출 자료명 기준), 반출 때 있던
    파일 종류(dwg/pdf/xlsx 등)를 빠짐없이 채워야 한다. (권한.xlsx에 없는 기능이라
    로그인만 하면 누구나 쓸 수 있다 — 2026-08-12 CM 확정)
    """
    admin_user = user
    now = datetime.now(timezone.utc)

    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다")

    branch_expected, branch_arrived = compute_branch_progress(db, document_id)
    if branch_expected is None or branch_arrived < branch_expected:
        raise HTTPException(
            status_code=400,
            detail="아직 반출된 도면이 모두 반입되지 않아 병합본을 승인할 수 없습니다.",
        )

    # 병합본은 사내 통합본이라 다음 정수 Rev가 된다(determine_rev_branch). 꼬리 없이 올려도 되고,
    # 붙였다면 정확히 그 Rev여야 한다(2026-10-01 — 형식 규칙을 반입 말고 다른 곳에도).
    target_rev = doc.current_rev + 1
    mismatched = sorted({
        u.filename for u in files
        if not rev_tail_reasons([u.filename], doc.drawing_no, doc.source_path, target_rev)[0]
    })
    if mismatched:
        raise HTTPException(
            status_code=400,
            detail=f"파일명이 반출 자료명('{document_display_name(doc)}')과 일치하지 않습니다: "
                   f"{', '.join(mismatched)}",
        )
    tail_problems = [
        problem for u in files
        if (problem := upload_tail_problem(Path(u.filename).stem, doc.drawing_no, doc.source_path, target_rev))
    ]
    if tail_problems:
        raise HTTPException(status_code=400, detail="\n".join(tail_problems))

    dists = duplicate_export_distributions(db, document_id)
    required_exts: set[str] = set()
    for d in dists:
        required_exts |= distributed_file_exts(db, document_id, d.rev_at_distribution)
    uploaded_exts = {file_ext_of(u.filename) for u in files}
    missing = required_exts - uploaded_exts
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"반출 때 있었던 파일 종류가 빠졌습니다: {', '.join(sorted(missing))}",
        )

    file_tuples = [(u.filename, await u.read()) for u in files]
    rev, _branch, created, _any_warning, _branched = create_revision_set(
        db, doc, file_tuples, INTERNAL_VENDOR, None, admin_user, now,
    )

    set_files = (
        db.query(FileModel)
        .filter(
            FileModel.document_id == doc.id,
            FileModel.rev == rev,
            FileModel.branch.is_(None),
            FileModel.review_status == "PENDING_REVIEW",
        )
        .all()
    )
    for f in set_files:
        f.review_status = "APPROVED"

    promote_to_current(db, doc, set_files, now)
    merge_branch_siblings(db, doc.id)

    db.add(AuditLog(
        user_id=admin_user.id, action="BRANCH_MERGE_APPROVE", screen="반입·검수", document_id=doc.id,
        detail={"rev": rev, "file_count": created},
    ))
    db.commit()

    return BranchMergeResult(
        document_id=doc.id, drawing_no=doc.drawing_no, rev=rev,
        rev_label=format_rev_label(rev, None), file_count=created,
        message=f"병합본을 rev {rev}(으)로 승인했습니다. 중복반출 건이 모두 정리됐습니다.",
    )


def issue_stored_files(issue: ImportIssue) -> list[dict]:
    """이 확인필요 항목의 저장된 파일 목록. 신형은 files(JSON), 구형은 단일 컬럼."""
    if issue.files:
        return issue.files
    return [{
        "original_filename": issue.original_filename,
        "stored_file_path": issue.stored_file_path,
        "file_ext": file_ext_of(issue.original_filename),
        "file_size": issue.file_size,
        "sha256": issue.sha256,
        "folder": None,
    }]


def issue_file_tuples(issue: ImportIssue) -> list[tuple[str, bytes]]:
    tuples = []
    for f in issue_stored_files(issue):
        data = (Path(STORAGE_ROOT) / f["stored_file_path"]).read_bytes()
        tuples.append((f["original_filename"], data))
    return tuples


def intended_reimported_after(db: Session, issue: ImportIssue) -> bool:
    """이 확인필요 항목의 추정 도면이, 그 사이 정상적으로 (다시) 반입되었는지.

    True면 화면에서 '기 반입 완료'로 바꿔 보여준다 (놔둬도 자동 보정된다는 CM의 요구).
    """
    if issue.intended_document_id is None:
        return False
    return (
        db.query(FileModel)
        .filter(
            FileModel.document_id == issue.intended_document_id,
            FileModel.review_status.in_(("PENDING_REVIEW", "APPROVED", "MERGED")),
            FileModel.uploaded_at >= issue.uploaded_at,
        )
        .first()
        is not None
    )


@router.get("/import-issues", response_model=list[ImportIssueItem])
def list_import_issues(db: Session = Depends(get_db)):
    """반입 중 도면을 확정 못 했거나 문제가 있는 항목 (확인 필요 목록)."""
    rows = (
        db.query(ImportIssue)
        .filter(ImportIssue.status == "PENDING")
        .order_by(ImportIssue.uploaded_at)
        .all()
    )
    result = []
    for issue in rows:
        project_name = None
        if issue.project_id:
            project = db.get(Project, issue.project_id)
            project_name = project.name if project else None

        intended_doc = (
            db.get(Document, issue.intended_document_id)
            if issue.intended_document_id else None
        )
        detail = issue.detail or {}
        drawing_no = resolve_issue_drawing_no(db, issue)

        reasons = issue.reason.split(",") if issue.reason else []
        detail_text = detail.get("text") or fallback_detail_text(reasons, drawing_no)
        # 그 사이 정상 반입됐으면 '기 반입 완료'로 덮어 보여준다
        if intended_reimported_after(db, issue):
            reasons = ["ALREADY_IMPORTED"]
            detail_text = (
                f"'{drawing_no}'은(는) 이후 정상적으로 반입되었습니다. "
                f"이 항목은 반려(버림) 처리하셔도 됩니다."
            )

        files = [
            ImportIssueFileItem(
                original_filename=f["original_filename"],
                file_ext=f["file_ext"],
                file_size=f["file_size"],
            )
            for f in issue_stored_files(issue)
        ]

        result.append(ImportIssueItem(
            id=issue.id,
            intended_document_id=issue.intended_document_id,
            drawing_no=drawing_no,
            display_name=issue_display_name(db, issue),
            category=intended_doc.category if intended_doc else None,
            source_path=intended_doc.source_path if intended_doc else None,
            vendor_name=issue.vendor_name,
            project_id=issue.project_id,
            project_name=project_name,
            uploaded_at=issue.uploaded_at,
            reasons=reasons,
            reason_text=reason_text_of(reasons),
            detail_text=detail_text,
            files=files,
        ))
    return result


@router.get("/import-issues/{issue_id}/preview")
def preview_import_issue_pdf(issue_id: int, db: Session = Depends(get_db)):
    """확인 필요 항목이 반입 당시 갖고 있던 PDF를 미리보기로 보여준다(승인 전 파일이라 File 테이블에
    없어 /files/{id}/view를 못 쓰므로 따로 둔다). 표의 돋보기 버튼용."""
    issue = db.get(ImportIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")
    pdf = next((f for f in issue_stored_files(issue) if f["file_ext"] == "pdf"), None)
    if pdf is None:
        raise HTTPException(status_code=404, detail="PDF가 없습니다")
    path = Path(STORAGE_ROOT) / pdf["stored_file_path"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="파일이 저장소에 없습니다")
    filename = f"{sanitize_path_component(issue_display_name(db, issue))}.pdf"
    return FileResponse(
        path, media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition_header("inline", filename),
            "Cache-Control": "no-store",
        },
    )


@router.get("/import-issues/{issue_id}/preview/{markup_filename}")
def preview_import_issue_pdf_with_markup_name(
    issue_id: int, markup_filename: str, db: Session = Depends(get_db)
):
    """미리보기와 내용은 같고, 주소 맨 뒤에 파일명만 덧붙인 것.
    마크업(그리기) 후 [저장]할 때의 파일명을 위한 것 — 자세한 설명은 files.py의 같은 이름 함수 참고."""
    return preview_import_issue_pdf(issue_id, db)


@router.get("/import-issues/export")
def export_import_issues(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """확인 필요 목록을 화면과 같은 내용으로 xlsx로 내려준다."""
    items = list_import_issues(db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "확인필요"
    ws.append(["No", "공사", "업체", "자료명", "업로드일시", "사유"])
    for i, it in enumerate(items, start=1):
        ws.append([
            i, it.project_name, it.vendor_name, it.display_name,
            it.uploaded_at.strftime("%Y-%m-%d %H:%M") if it.uploaded_at else None,
            it.detail_text,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 16, 12, 26, 17, 80], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("TDB 반입·검수", "확인 필요")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="반입·검수", document_id=None,
        detail={"kind": "확인필요", "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


@router.post("/import-issues/{issue_id}/resolve")
def resolve_import_issue(
    issue_id: int, body: ResolveImportIssueRequest, db: Session = Depends(get_db),
    user: User = Depends(require_issue_repath),
):
    """경로 재선택: 이 자료가 실제로 어느 도면인지를 CM이 직접 지정한다.

    여기서는 대상 도면만 바꿔둘 뿐, 아직 검수 대기로 올리지 않는다.
    실제 등록은 CM이 [재검수]를 눌렀을 때 (recheck에서) 이뤄진다 —
    자료 재첨부와 경로 재선택을 둘 다 하고 나서 한 번에 다시 검사할 수 있어야 하기 때문.

    CM이 도면을 골랐다고 해서 그게 곧 정답인 건 아니므로(CM 확정), 자료명·경로가
    실제로 그 도면과 맞는지는 재검수에서 그대로 다시 확인한다 — 여기서는 검사를
    건너뛸 대상을 표시해두지 않는다.
    """
    admin_user = user

    issue = db.get(ImportIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="확인 필요 항목을 찾을 수 없습니다")
    if issue.status != "PENDING":
        raise HTTPException(status_code=400, detail="이미 처리된 항목입니다")

    doc = db.get(Document, body.document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="지정한 문서를 찾을 수 없습니다")

    issue.intended_document_id = doc.id
    detail = dict(issue.detail or {})
    detail["text"] = (
        f"대상 도면을 '{doc.drawing_no}'({doc.source_path or '경로 없음'})(으)로 "
        f"다시 지정했습니다. [재검수]를 누르면 이 도면 기준으로 자료명·경로·"
        f"원본/사본 보유 여부를 다시 확인합니다."
    )
    issue.detail = detail

    db.add(AuditLog(
        user_id=admin_user.id, action="IMPORT_ISSUE_RETARGET", screen="반입·검수", document_id=doc.id,
        detail={"issue_id": issue.id, "original_filename": issue.original_filename,
                "reason": issue.reason},
    ))
    db.commit()

    return {
        "status": "retargeted", "document_id": doc.id, "drawing_no": doc.drawing_no,
        "message": f"대상 도면을 '{doc.drawing_no}'(으)로 지정했습니다. "
                   f"[재검수]를 눌러 다시 검사해주세요.",
    }


def resolve_document_by_exact_name(
    db: Session, stems: set[str],
    vendor_name: Optional[str] = None, project_id: Optional[int] = None,
) -> Optional[Document]:
    """[경로 재선택]을 안 거쳐도, 파일명이 지금 나가 있는 도면 이름과 정확히 하나로만
    일치하면 그 도면으로 본다(2026-08-18 CM 확정).

    이름만으로 시스템 전체를 뒤지면, 같은 도면이 업체 여러 곳에 동시에 나가 있을 때
    (D-14 중복반출)나 도면번호가 우연히 겹칠 때(원칙 3) 엉뚱한 업체·자료에 잘못 붙을
    위험이 있다. 그래서 이 확인필요 항목이 애초에 어느 업체·공사 반입분인지
    (issue.vendor_name/project_id — 최초 반입 시점에 이미 정확히 기록돼 있고, [자료
    재첨부]를 해도 이 값은 그대로 유지된다)를 같이 걸어서, "그 업체·그 공사로 나가서
    아직 안 돌아온, 이름이 정확히 같은 도면"만 찾는다. 이렇게 좁혀도 후보가 2건
    이상이면 자동으로 고르지 않고 그대로 확인 필요로 둔다.
    """
    if len(stems) != 1:
        return None
    stem = next(iter(stems))
    q = (
        db.query(Document)
        .join(Distribution, Distribution.document_id == Document.id)
        .filter(
            Distribution.purpose == "MODIFY",
            Distribution.returned_at.is_(None),
            func.lower(Document.drawing_no) == stem,
        )
    )
    if vendor_name:
        q = q.filter(Distribution.vendor == vendor_name)
    if project_id is not None:
        q = q.filter(Distribution.project_id == project_id)
    candidates = q.distinct().all()
    return candidates[0] if len(candidates) == 1 else None


def diagnose_issue(
    db: Session, issue: ImportIssue,
) -> tuple[list[str], set[str], set[str], Optional[Distribution]]:
    """확인필요 항목을 지금 상태(재첨부한 파일 / 다시 고른 도면) 그대로 재검사한다 (재검수용).

    CM이 [경로 재선택]으로 도면을 직접 골랐어도, 그 선택이 맞다는 보장은 없으므로
    자료명·경로가 실제로 그 도면과 맞는지는 여기서 매번 다시 확인한다 (CM 확정 사항).
    반환: (사유코드 목록, 반입된 확장자, 빠진 확장자, 그 도면의 반출 건). 사유가 비어 있으면
    등록해도 좋다는 뜻.

    주의: REV_MISMATCH(표기 불일치)는 여기서 다시 검사하지 않는다. 이 사유는 파일이
    잘못된 게 아니라 "업체 표기가 시스템과 다르지만 문제없다"를 CM이 직접 눈으로 보고
    판단하는 절차이므로, [재검수]를 누르는 행위 자체가 그 판단이다 — 재첨부 없이 눌러도
    통과된다(2026-08-18 CM 확정, 검수대기의 빨간 줄+승인 방식을 이 확인필요 흐름으로 대체).
    리비전 표기 없음·형식 오류(2026-10-01)도 같은 성격이라 다시 검사하지 않는다 — 승인되면
    파일 이름은 시스템이 규칙대로 맞추므로, CM이 [비교]로 내용을 확인했으면 그것으로 충분하다.
    """
    stored = issue_stored_files(issue)
    imported_exts = {f["file_ext"] for f in stored}

    doc = (
        db.get(Document, issue.intended_document_id)
        if issue.intended_document_id else None
    )
    if doc is None:
        # 이름 그대로 먼저, 안 되면 리비전 꼬리를 뗀 이름으로 찾는다(name_keys의 마지막이 가장 많이 뗀 것)
        for pick in (0, -1):
            stems = {name_keys(f["original_filename"])[pick] for f in stored}
            doc = resolve_document_by_exact_name(db, stems, issue.vendor_name, issue.project_id)
            if doc is not None:
                issue.intended_document_id = doc.id
                break
    if doc is None:
        return ["NOT_DISTRIBUTED"], imported_exts, set(), None

    reasons: list[str] = []

    dist = (
        db.query(Distribution)
        .filter(Distribution.document_id == doc.id, Distribution.purpose == "MODIFY")
        .order_by(Distribution.returned_at.isnot(None), Distribution.distributed_at)
        .first()
    )

    expected_rev = (dist.rev_at_distribution if dist else doc.current_rev) + 1
    name_ok, _tail_reasons = rev_tail_reasons(
        [f["original_filename"] for f in stored], doc.drawing_no, doc.source_path, expected_rev,
    )
    if not name_ok:
        reasons.append("FILENAME_MISMATCH")

    # 폴더 정보가 있는 파일(zip으로 들어온 것)만 경로를 확인한다.
    # 자료 재첨부로 새로 올린 파일은 폴더 구조가 없으므로 경로 확인 대상이 아니다.
    pair_paths = folder_pair_paths(f.get("folder") for f in stored)
    folders = {normalize_folder(f["folder"], pair_paths) for f in stored if f.get("folder") is not None}
    if folders and normalize_folder(doc.source_path or "", pair_paths) not in folders:
        reasons.append("PATH_MISMATCH")

    if dist is not None and dist.returned_at is not None:
        reasons.append("ALREADY_IMPORTED")

    distributed_exts = (
        distributed_file_exts(db, doc.id, dist.rev_at_distribution) if dist else set()
    )
    missing = distributed_exts - imported_exts
    if any(is_pdf(x) for x in missing):
        reasons.append("PDF_MISSING")
    if any(not is_pdf(x) for x in missing):
        reasons.append("ORIGINAL_MISSING")

    return reasons, imported_exts, missing, dist


@router.post("/import-issues/{issue_id}/recheck")
def recheck_import_issue(issue_id: int, db: Session = Depends(get_db), user: User = Depends(require_issue_recheck)):
    """재검수: 재첨부한 파일 / 다시 고른 도면으로 처음부터 다시 검사한다.

    - 문제가 없으면 → 정식 리비전으로 만들어 검수 대기에 올리고 이 항목은 종료
    - 아직 문제가 있으면 → 이 항목은 닫고, 새 사유로 '확인 필요' 항목을 새로 만든다
      (CM이 요청한 동작: 기존 확인 필요는 사라지고 새 확인 필요가 생긴다)
    """
    admin_user = user
    now = datetime.now(timezone.utc)

    issue = db.get(ImportIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="확인 필요 항목을 찾을 수 없습니다")
    if issue.status != "PENDING":
        raise HTTPException(status_code=400, detail="이미 처리된 항목입니다")

    reasons, imported_exts, missing, dist = diagnose_issue(db, issue)

    if not reasons:
        doc = db.get(Document, issue.intended_document_id)
        rev, branch, _c, _warn, _branched = create_revision_set(
            db, doc, issue_file_tuples(issue), issue.vendor_name, issue.project_id,
            admin_user, now,
        )
        issue.status = "RESOLVED"
        issue.resolved_document_id = doc.id
        issue.resolved_rev = rev
        issue.resolved_branch = branch
        issue.resolved_at = now
        db.add(AuditLog(
            user_id=admin_user.id, action="IMPORT_ISSUE_RESOLVE", screen="반입·검수", document_id=doc.id,
            detail={"issue_id": issue.id, "rev": rev, "branch": branch, "via": "recheck"},
        ))
        db.commit()
        return {
            "status": "resolved", "document_id": doc.id, "drawing_no": doc.drawing_no,
            "rev_label": format_rev_label(rev, branch),
            "message": f"재검수 통과 — '{doc.drawing_no}' rev {format_rev_label(rev, branch)}"
                       f"(으)로 검수 대기에 등록했습니다.",
        }

    # 아직 문제가 있다 → 옛 항목을 닫고 새 항목을 만든다.
    # folder를 그대로 이어받아야, 다음 번 재검수에서도 경로를 계속 확인할 수 있다.
    incoming = [
        IncomingFile(
            folder=f.get("folder"), filename=f["original_filename"], ext=f["file_ext"],
            data=(Path(STORAGE_ROOT) / f["stored_file_path"]).read_bytes(),
            zip_path=issue.zip_relative_path,
        )
        for f in issue_stored_files(issue)
    ]

    doc = (
        db.get(Document, issue.intended_document_id)
        if issue.intended_document_id else None
    )
    if doc is None:
        detail = {
            "text": f"반출 목록에 '{Path(issue.original_filename).stem}'와(과) 자료명이 "
                    f"일치하는 자료가 없습니다. [경로 재선택]으로 도면을 지정한 뒤 "
                    f"[재검수]를 눌러주세요.",
            "actual_stem": Path(issue.original_filename).stem,
            "imported_exts": sorted(imported_exts),
        }
    else:
        # 반출됐던 자료 = 이번에 들어온 것 + 빠진 것
        detail = build_issue_detail(
            ExpectedDrawing(
                document_id=doc.id, drawing_no=doc.drawing_no, source_path=doc.source_path,
                category=doc.category, vendor=issue.vendor_name, project_id=issue.project_id,
                rev_at_distribution=dist.rev_at_distribution if dist else doc.current_rev,
                current_rev=doc.current_rev, distributed_exts=imported_exts | missing,
                already_returned="ALREADY_IMPORTED" in reasons,
            ),
            incoming, reasons, imported_exts, missing,
        )

    issue.status = "SUPERSEDED"   # 재검수로 대체됨. 기록은 남긴다 (D-6)
    issue.resolved_at = now

    new_issue = save_issue(
        db, admin_user, now,
        intended_document_id=issue.intended_document_id,
        vendor_name=issue.vendor_name, project_id=issue.project_id,
        reasons=reasons, detail=detail, incoming=incoming,
    )
    db.add(AuditLog(
        user_id=admin_user.id, action="IMPORT_ISSUE_RECHECK", screen="반입·검수",
        document_id=issue.intended_document_id,
        detail={"issue_id": issue.id, "new_issue_id": new_issue.id,
                "reason": ",".join(reasons)},
    ))
    db.commit()

    return {
        "status": "reissued",
        "message": f"재검수했지만 아직 문제가 있습니다 ({reason_text_of(reasons)}). "
                   f"'확인 필요' 목록에 새 항목으로 다시 올렸습니다.",
    }


@router.post("/import-issues/{issue_id}/reattach")
async def reattach_import_issue(
    issue_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_issue_reattach),
):
    """자료 재첨부: 확인 필요 항목의 파일을 새로 올린 것으로 교체한다.

    여기서는 파일만 갈아끼운다. 다시 검사해서 검수 대기로 올리는 일은 CM이
    [재검수]를 눌렀을 때 (recheck에서) 한다 — 재첨부와 경로 재선택을 둘 다 하고 나서
    한 번에 다시 검사할 수 있어야 하기 때문.
    """
    admin_user = user

    issue = db.get(ImportIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="확인 필요 항목을 찾을 수 없습니다")
    if issue.status != "PENDING":
        raise HTTPException(status_code=400, detail="이미 처리된 항목입니다")

    # 이전 임시 파일들은 새 것으로 교체 (경로만 갱신, 옛 파일은 디스크에 남아도 무방)
    stored = []
    for idx, upload in enumerate(files):
        data = await upload.read()
        dest = storage.quarantine_file_path(f"{issue.id}_{idx}", upload.filename)
        size, sha = save_upload(data, dest)
        stored.append({
            "original_filename": upload.filename,
            "stored_file_path": storage.to_relative(dest),
            "file_ext": file_ext_of(upload.filename),
            "file_size": size,
            "sha256": sha,
        })

    issue.files = stored
    issue.original_filename = stored[0]["original_filename"]
    issue.stored_file_path = stored[0]["stored_file_path"]
    issue.file_size = stored[0]["file_size"]
    issue.sha256 = stored[0]["sha256"]

    db.add(AuditLog(
        user_id=admin_user.id, action="IMPORT_ISSUE_REATTACH", screen="반입·검수",
        document_id=issue.intended_document_id,
        detail={"issue_id": issue.id, "file_count": len(stored)},
    ))
    db.commit()

    names = ", ".join(f["original_filename"] for f in stored)
    return {
        "status": "reattached",
        "file_count": len(stored),
        "message": f"파일을 다시 첨부했습니다 ({names}). [재검수]를 눌러 다시 검사해주세요.",
    }


@router.post("/import-issues/{issue_id}/discard")
def discard_import_issue(
    issue_id: int, body: DiscardImportIssueRequest, db: Session = Depends(get_db),
    user: User = Depends(require_issue_reject),
):
    """확인필요 항목을 버린다. 정식 기록을 만든 적이 없으니 D-6(삭제 금지) 대상이 아니다
    (다만 감사 추적을 위해 행 자체는 남기고 status만 바꾼다)."""
    admin_user = user

    issue = db.get(ImportIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="확인필요 항목을 찾을 수 없습니다")
    if issue.status != "PENDING":
        raise HTTPException(status_code=400, detail="이미 처리된 항목입니다")

    issue.status = "DISCARDED"
    issue.resolve_note = body.note
    issue.resolved_at = datetime.now(timezone.utc)

    db.add(AuditLog(
        user_id=admin_user.id, action="IMPORT_ISSUE_DISCARD", screen="반입·검수", document_id=None,
        detail={"issue_id": issue.id, "original_filename": issue.original_filename,
                "reason": issue.reason, "note": body.note},
    ))
    db.commit()

    return {"status": "discarded"}
