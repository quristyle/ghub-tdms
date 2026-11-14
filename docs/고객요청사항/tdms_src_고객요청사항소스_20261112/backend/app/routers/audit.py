from datetime import datetime
from io import BytesIO
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_db
from app.models import AuditLog, Distribution, Document, File, User
from app.permissions import has_permission
from app.rev_naming import document_display_name, rev_name, strip_rev_tail
from app.routers.imports import REASON_LABELS
from app.schemas import ActionGroup, AuditLogItem, AuditMeta
from app.utils import build_export_filename, content_disposition_header, neutralize_formulas

router = APIRouter(prefix="/audit-log", tags=["audit"])

# 로그를 남길 때부터 써온 내부 키. 화면 이름이 나브바에서 여러 번 바뀌었어도 이 키 자체는
# 안 바꾼다 — 이미 쌓인 기록의 screen 값이 전부 이 문자열 그대로라 바꾸면 옛 기록을 못 찾는다.
# 로그인 → 나브바 진입 전 화면이라 맨 앞, 마이페이지 → 나브바에 없는 화면이라 맨 뒤.
# "감사로그"(시스템 로그 화면 자체)는 여기 없다 — 그 화면에서 실제로 남는 동작은 엑셀내보내기뿐인데,
# 이건 자료·정보에 영향을 안 줘서 애초에 로그화면 드롭다운에 올릴 항목이 없다 (CM 규칙, 2026-08-11).
SCREENS = [
    "로그인", "도면 목록", "반입·검수", "폴더·자료 편집",
    "반출 이력", "MDB", "MDB 편집", "사용자 관리", "권한 관리", "마이페이지",
]

# 내부 키 → 지금 나브바에 실제로 쓰는 화면 이름 (드롭다운·표·엑셀에 전부 이 라벨로 보여준다)
# "감사로그"는 SCREENS(드롭다운)엔 없지만, 옛 기록의 screen 열 표시(엑셀내보내기 등)를 위해 남겨둔다.
SCREEN_LABELS = {
    "로그인": "로그인",
    "도면 목록": "TDB 조회",
    "반입·검수": "TDB 반입·검수",
    "폴더·자료 편집": "TDB 관리",
    "반출 이력": "TDB 반출이력",
    "MDB": "MDB 조회",
    "MDB 편집": "MDB 관리",
    "감사로그": "시스템 로그",
    "사용자 관리": "사용자 관리",
    "권한 관리": "권한 관리",
    "마이페이지": "마이페이지",
}

# 동작 코드 → 한글 라벨 (엑셀 내보내기·화면 드롭다운·표 공용). EXPORT는 표·엑셀 라벨 표시용으로만
# 남겨두고, 아래 ACTION_GROUPS(로그동작 드롭다운 항목)엔 넣지 않는다 — 자료·정보에 영향을 주는
# 기능이 아니기 때문 (CM 규칙 2번, 2026-08-11).
ACTION_LABELS = {
    "LOGIN": "로그인", "LOGIN_FAIL": "로그인 실패", "LOGOUT": "로그아웃",
    "PASSWORD_CHANGE": "비밀번호 변경", "PASSWORD_CHANGE_DEFER": "비밀번호 변경 미룸",
    "REGISTER": "신규등록",
    "DISTRIBUTE": "반출",
    "DOWNLOAD": "다운로드", "UPLOAD": "업로드", "APPROVE": "승인",
    "REJECT": "반려", "MERGE_REQUIRED": "통합필요", "RETURN": "반입",
    "UPDATE_NOTE": "비고 수정", "EXPORT": "엑셀내보내기",
    "IMPORT_ISSUE_RESOLVE": "확인필요 처리", "IMPORT_ISSUE_DISCARD": "확인필요 반려",
    "IMPORT_ISSUE_RETARGET": "확인필요 재지정", "IMPORT_ISSUE_RECHECK": "확인필요 재검수",
    "IMPORT_ISSUE_REATTACH": "확인필요 재첨부", "BRANCH_MERGE_APPROVE": "분기 통합승인",
    "ADD_FOLDER": "폴더 추가", "RENAME_FOLDER": "폴더 이름변경",
    "DELETE_EMPTY_FOLDER": "빈폴더 삭제", "ARCHIVE_FOLDER": "폴더 보관",
    "RENAME_DOCUMENT": "자료 이름변경", "MOVE_DOCUMENT": "자료 이동",
    "RENAME_REV_TAIL": "파일명 Rev 꼬리 일괄 정리",
    "ARCHIVE_DOCUMENT": "자료 보관", "RESTORE_FROM_TRASH": "보관함 복원",
    "PURGE_TRASH": "보관함 완전삭제",
    "ZIP_REGISTER": "Zip 등록", "MDB_EDIT": "MDB 편집",
    "MDB_TAG_HISTORY_APPLY": "Tag No 이력 적용", "MDB_TAG_HISTORY_REVERT": "Tag No 이력 되돌리기",
    "MDB_TAG_HISTORY_UPDATE": "Tag No 이력 수정",
    "MDB_TAG_HISTORY_AUTO_APPLY": "Tag No 이력 자동적용",
    "FAVORITE_SAVE": "미리보기 보관", "FAVORITE_DELETE": "보관 목록에서 삭제",
    "USER_CREATE": "사용자 추가", "USER_UPDATE": "사용자 정보 수정",
    "USER_PASSWORD_RESET": "비밀번호 초기화",
    "GROUP_CREATE": "그룹 추가", "GROUP_RENAME": "그룹 이름변경",
    "USER_GROUP_CHANGE": "사용자 그룹 이동", "GROUP_PERMISSION_UPDATE": "그룹 권한 설정",
}

# 로그동작 드롭다운 구성 규칙 (CM 확정, 2026-08-11):
# ① TDB·MDB 자료, 사용자 정보에 영향을 주는 기능만 항목에 올린다.
# ② 엑셀내보내기는 자료·정보에 영향을 주지 않으므로 어느 그룹에도 넣지 않는다(=드롭다운에서 빠짐).
# ③ 반출·반입·등록·검수·반려·재검수 등 자료를 변경하기 위한 절차와, 폴더명/위치/자료명/Tag No/
#    유형 등 자료의 정보 자체가 바뀌는 작업을 모두 포함한다 → 아래 두 그룹으로 나눔.
# ④ 로그인·로그아웃·비밀번호·사용자 정보변경 등 계정 관련도 포함한다.
# ⑤ 반출과 별개로, 자료명에서 개별/Zip으로 내려받는 것도(자료가 외부로 나가므로) 포함한다.
# 그룹 안 순서는 가나다순이 아니라 실제 업무 흐름 순서를 따른다(예: 등록→반출→반입→검수→반려).
ACTION_GROUPS: list[tuple[str, list[str]]] = [
    ("자료 반출입·검수", [
        "REGISTER", "ZIP_REGISTER", "DISTRIBUTE", "UPLOAD", "RETURN",
        "APPROVE", "REJECT", "MERGE_REQUIRED", "BRANCH_MERGE_APPROVE",
        "IMPORT_ISSUE_RESOLVE", "IMPORT_ISSUE_RECHECK", "IMPORT_ISSUE_RETARGET",
        "IMPORT_ISSUE_REATTACH", "IMPORT_ISSUE_DISCARD",
    ]),
    ("자료·폴더 정보 변경", [
        "RENAME_DOCUMENT", "RENAME_REV_TAIL", "MOVE_DOCUMENT", "ARCHIVE_DOCUMENT", "RESTORE_FROM_TRASH",
        "PURGE_TRASH",
        "ADD_FOLDER", "RENAME_FOLDER", "ARCHIVE_FOLDER", "DELETE_EMPTY_FOLDER",
        "MDB_EDIT", "MDB_TAG_HISTORY_APPLY", "MDB_TAG_HISTORY_AUTO_APPLY",
        "MDB_TAG_HISTORY_UPDATE", "MDB_TAG_HISTORY_REVERT", "UPDATE_NOTE",
    ]),
    ("외부 반출·다운로드", [
        "DOWNLOAD",
    ]),
    ("계정", [
        "LOGIN", "LOGIN_FAIL", "LOGOUT", "PASSWORD_CHANGE", "PASSWORD_CHANGE_DEFER",
        "USER_PASSWORD_RESET", "USER_CREATE", "USER_UPDATE",
        "GROUP_CREATE", "GROUP_RENAME", "USER_GROUP_CHANGE", "GROUP_PERMISSION_UPDATE",
    ]),
]
FILTERABLE_ACTIONS = {code for _label, codes in ACTION_GROUPS for code in codes}

# 상세(jsonb) 키 → 한글 라벨. format_detail·프론트 audit.js의 formatDetail이 같은 규칙을 쓴다.
DETAIL_KEY_LABELS = {
    "count": "건수", "kind": "구분", "scope": "대상", "columns": "구성",
    "batch": "일괄 작업", "journal": "되돌리기 기록 파일", "restored": "되돌림",
    "filters": "검색조건", "path": "경로", "old_path": "이전 경로", "new_path": "변경 경로",
    "target_path": "대상 경로", "old_title": "이전 이름", "new_title": "변경 이름",
    "old_filename": "이전 파일명", "new_filename": "변경 파일명",
    "original_filename": "원본 파일명", "batch_id": "보관함 번호",
    "document_count": "대상 자료", "file_count": "대상 파일",
    "affected_documents": "영향받은 자료", "affected_placeholders": "영향받은 빈 폴더",
    "affected_files": "영향받은 자료", "removed_placeholders": "삭제된 빈 폴더",
    "restored_documents": "복원된 자료", "restored_files": "복원된 자료",
    "archived_documents": "보관 처리된 자료", "cascade_numbering": "하위 번호 자동변경",
    "rev": "리비전", "branch": "분기", "vendor": "업체명", "vendor_name": "업체명",
    "any_mismatch_warning": "표기 리비전 불일치 경고", "via": "처리 경로",
    "created": "생성 건수", "unmatched": "미매칭 건수", "partial": "일부매칭 건수",
    "distribution_id": "반출 번호", "zip_filename": "Zip 파일명", "return_note": "반납 사유",
    "note": "비고", "file_id": "파일 번호", "file_ext": "확장자", "drawing_no": "도면번호",
    "doc_class": "자료종류", "tags": "태그", "equipment_type": "설비유형",
    "doc_type": "자료유형",  # MDB 자료유형(D-50). TDB 도면종류는 로그에 남기지 않아 겹치지 않는다
    "mdb_file_id": "MDB 파일 번호", "issue_id": "확인필요 번호", "new_issue_id": "새 확인필요 번호",
    "reason": "사유", "is_internal": "사내통합 여부", "project_id": "공사 번호",
    "status": "상태", "q": "검색어", "group": "그룹", "category": "분류", "tag": "Tag No",
    "username": "계정", "name": "이름", "role": "권한", "target_username": "대상 계정",
    "label": "이름", "selected_only": "선택항목만", "recursive": "하위폴더 포함",
    "iso": "Isometric", "holding": "원본/사본", "kind_scope": "검색대상",
    "purpose": "반출목적", "is_active": "활성여부", "password": "비밀번호",
    "employment_status": "계정 상태",
    "ip": "접속 주소", "locked": "로그인 잠김",  # 로그인·로그인 실패(auth_router.py, 2026-09-17)
    "old_name": "이전 이름", "new_name": "변경 이름",
    "old_group": "이전 그룹", "new_group": "변경 그룹",
    "table": "대상",  # 옛 기록 호환용 — 지금은 이 키 자체를 안 남긴다
    "days": "조회 기간(일)", "modified": "수정일 범위", "change_kind": "변경 종류",
    "batch_count": "보관함 항목", "freed_bytes": "확보 용량(바이트)", "labels": "대상 이름",
    "bulk": "일괄처리", "drawing_nos": "도면번호 목록",
    # Tag No 이력관리(mdb_tag_history.py)가 남기는 키들
    "history_id": "이력 번호", "base_tag": "대상 Tag No", "new_tag": "바뀐 Tag No",
    "action_label": "구분", "note_line": "Note 문구", "before": "이전 내용",
    "after": "변경 내용", "reapplied": "자료에 다시 반영",
    "tag_changed_docs": "Tag No가 바뀐 자료", "note_changed_docs": "Note가 바뀐 자료",
    "added": "신규 추가 여부", "already_exists": "이미 등록됨(건너뜀)",
    "attached": "기존 자료에 추가", "attached_files": "기존 자료에 추가",
    "auto": "자동 처리 사유", "distributed_by": "반출자", "doc_count": "대상 자료 건수",
    "duplicate_warning": "중복 반출 경고", "duplicates_skipped": "중복 건너뜀",
    "dwg_path": "DWG 경로", "pdf_path": "PDF 경로", "files": "대상 파일",
    "mdb_file_ids": "MDB 파일 번호", "merged_document_id": "병합된 자료 번호",
    "moved_exts": "이동된 확장자", "names": "대상 자료명", "new_document_id": "새 자료 번호",
    "pair_folder": "DWG·PDF 폴더", "pair_folders": "DWG·PDF 폴더 병합", "parent": "상위 폴더",
    "project": "공사", "purpose_note": "반출목적 비고", "skipped": "건너뜀",
    "split_documents": "분리된 자료 번호",
}

# 값 자체가 내부 코드라 그대로 두면 못 알아보는 것들만 별도로 한글 변환한다 (키별로 다름)
DETAIL_VALUE_LABELS = {
    "columns": {"full": "전체 목록", "cart": "대기함 목록", "list": "결과 목록", "unclassified": "미분류 관리 목록"},
    "kind_scope": {"FILE": "자료명", "FOLDER": "폴더명", "BOTH": "자료명+폴더명"},
    "role": {"ADMIN": "관리자", "VIEWER": "조회전용", "INTERNAL": "시스템"},
    "employment_status": {"ACTIVE": "재직", "RETIRED": "퇴직", "DELETED": "삭제"},
    "purpose": {"MODIFY": "수정용", "REFERENCE": "참조용", "OTHER": "기타"},
    # 확인필요 사유 코드(NOT_DISTRIBUTED 등 영문)를 반입·검수 화면 배지와 같은 한글 단어로
    # 보여준다. 문장으로 풀면 표 칸 너비에 안 맞아서 짧은 단어만 쓴다 (2026-08-13 CM 요청)
    "reason": REASON_LABELS,
    "scope": {"mdb": "MDB"},
    "table": {"audit_log": "감사로그"},
    "kind": {
        "FOLDER": "폴더", "DOCUMENT": "자료", "MDB_FOLDER": "MDB 폴더",
        "MDB_FILE": "MDB 파일", "MDB_ZIP": "MDB Zip",
    },
    # 최근수정본 팝업 필터값(documents.py). 화면의 "수정일" 드롭다운·30/90일 기준과 동일 문구
    "modified": {
        "ALL": "전체", "D30": "오늘~30일", "D31_90": "31일~90일", "D91": "91일 이전",
    },
    # 최근수정본 팝업의 "구분" 필터값(documents.py). 화면 changeKindCell과 동일 문구
    "change_kind": {"REVISION": "Revision 수정", "INFO": "일반 수정"},
}


def detail_label(key: str) -> str:
    return DETAIL_KEY_LABELS.get(key, key)


def detail_value(key: str, value) -> str:
    if value is True:
        return "예"
    labels = DETAIL_VALUE_LABELS.get(key)
    if labels and value in labels:
        return labels[value]
    if isinstance(value, list):
        return ", ".join(labels.get(v, str(v)) if labels else str(v) for v in value)
    return str(value)


def is_blank(value) -> bool:
    # value == 0 은 유효한 값이라 남겨야 한다 — Python은 False == 0 이라 "is False"로 따로 걸러야 함
    return value is None or value is False or value == "" or value == []


def format_detail(detail) -> str:
    """상세(jsonb)를 사람이 읽을 수 있게 한글 라벨로 풀어준다 (화면 audit.js formatDetail과 동일 규칙)."""
    if not detail:
        return ""
    parts = []
    for key, value in detail.items():
        if is_blank(value):
            continue
        if isinstance(value, dict):
            inner = ", ".join(
                f"{detail_label(k)} {detail_value(k, v)}"
                for k, v in value.items()
                if not is_blank(v)
            )
            if inner:
                parts.append(f"{detail_label(key)}({inner})")
        else:
            parts.append(f"{detail_label(key)}: {detail_value(key, value)}")
    return " · ".join(parts)


@router.get("/meta", response_model=AuditMeta)
def get_meta(db: Session = Depends(get_db)):
    """화면·로그종류 드롭다운용 — 화면별로 실제 로그에 존재하는 action만 묶어서 내려준다
    (예: '로그인' 화면엔 LOGIN만, '반입·검수'엔 그쪽 action들만 체크박스로 뜨게).
    엑셀내보내기(EXPORT)처럼 자료·정보에 영향을 안 주는 동작은 FILTERABLE_ACTIONS에 없어
    여기서 걸러진다 — 로그 자체는 남지만 드롭다운 항목으론 안 뜬다."""
    pairs = db.query(AuditLog.screen, AuditLog.action).distinct().all()
    actions_by_screen: dict[str, set] = {s: set() for s in SCREENS}
    for screen, action in pairs:
        if screen in actions_by_screen and action in FILTERABLE_ACTIONS:
            actions_by_screen[screen].add(action)
    return AuditMeta(
        screens=SCREENS,
        actions_by_screen={s: sorted(actions) for s, actions in actions_by_screen.items()},
        action_labels=ACTION_LABELS,
        screen_labels=SCREEN_LABELS,
        action_groups=[ActionGroup(label=label, actions=codes) for label, codes in ACTION_GROUPS],
    )


def compute_extra_fields(db: Session, rows):
    """자료명 옆 미리보기용 현재 PDF file id, 그리고 Zip 파일명.

    Zip 파일명은 detail에 바로 있으면(Zip현황 등) 그걸 쓰고, 없으면 detail의
    distribution_id로 distributions 테이블을 찾아 그 반출 건의 zip_filename을 가져온다
    (반출 당시엔 아직 zip을 안 묶어서 zip_filename이 없다가, 다운로드할 때 붙는 값이라 이렇게 찾아야
    반출/반입 로그에도 나중에 생긴 zip 파일명이 표시된다).
    """
    doc_ids = {doc.id for _log, _user, doc in rows if doc}
    pdf_by_doc = {}
    if doc_ids:
        pdf_rows = (
            db.query(File.document_id, File.id)
            .filter(File.document_id.in_(doc_ids), File.is_current.is_(True), File.file_ext == "pdf")
            .all()
        )
        pdf_by_doc = dict(pdf_rows)

    dist_ids = {
        detail["distribution_id"]
        for log, _user, _doc in rows
        if (detail := log.detail) and isinstance(detail.get("distribution_id"), int)
    }
    zip_by_dist = {}
    if dist_ids:
        dist_rows = (
            db.query(Distribution.id, Distribution.zip_filename)
            .filter(Distribution.id.in_(dist_ids), Distribution.zip_filename.isnot(None))
            .all()
        )
        zip_by_dist = dict(dist_rows)

    def zip_filename_for(log: AuditLog) -> Optional[str]:
        detail = log.detail or {}
        direct = detail.get("zip_filename")
        if direct:
            return direct
        return zip_by_dist.get(detail.get("distribution_id"))

    return pdf_by_doc, zip_filename_for


def effective_user_id_filter(db: Session, actor: User, requested):
    """screen.audit.viewer.other_user 권한이 없으면, 요청 값과 무관하게 본인 기록만
    보이도록 조용히 [본인 id]로 고정한다(에러 대신 "이름만 조회 가능" — CM 확정)."""
    if has_permission(db, actor, "screen.audit.viewer.other_user"):
        return requested
    return [actor.id]


def apply_log_filters(query, action, screen, user_id, q, date_from, date_to):
    if action:
        query = query.filter(AuditLog.action.in_(action))
    if screen:
        query = query.filter(AuditLog.screen.in_(screen))
    if user_id:
        query = query.filter(AuditLog.user_id.in_(user_id))
    if q:
        like = f"%{q}%"
        query = query.filter(or_(
            Document.drawing_no.ilike(f"%{strip_rev_tail(q)}%"),
            Document.title.ilike(like),
            cast(AuditLog.detail, String).ilike(like),
        ))
    if date_from:
        query = query.filter(AuditLog.created_at >= date_from)
    if date_to:
        query = query.filter(AuditLog.created_at <= date_to)
    return query


@router.get("", response_model=list[AuditLogItem])
def list_audit_log(
    action: Optional[list[str]] = Query(None),
    screen: Optional[list[str]] = Query(None),
    user_id: Optional[list[int]] = Query(None),
    q: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
    actor: User = Depends(current_user),
):
    user_id = effective_user_id_filter(db, actor, user_id)
    query = db.query(AuditLog, User, Document).outerjoin(
        User, AuditLog.user_id == User.id
    ).outerjoin(Document, AuditLog.document_id == Document.id)
    query = apply_log_filters(query, action, screen, user_id, q, date_from, date_to)

    rows = query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit).all()
    pdf_by_doc, zip_filename_for = compute_extra_fields(db, rows)

    return [
        AuditLogItem(
            id=log.id,
            action=log.action,
            screen=log.screen,
            user_name=user.name if user else None,
            document_id=log.document_id,
            drawing_no=doc.drawing_no if doc else None,
            display_name=log_display_name(doc, log.detail) if doc else None,
            current_pdf_file_id=pdf_by_doc.get(doc.id) if doc else None,
            zip_filename=zip_filename_for(log),
            detail=log.detail,
            created_at=log.created_at,
        )
        for log, user, doc in rows
    ]



def log_display_name(doc: Document, detail: Optional[dict]) -> str:
    """로그 한 줄의 자료명. 그 줄에 리비전이 적혀 있으면(다운로드·업로드·승인 등) 그때의 Rev로,
    없으면 지금 Rev로 꼬리를 붙인다(rev_naming) — 로그는 과거 기록이라 그 시점 이름이 맞다."""
    rev = (detail or {}).get("rev") if isinstance(detail, dict) else None
    if isinstance(rev, int):
        branch = detail.get("branch") if isinstance(detail.get("branch"), str) else None
        return rev_name(doc.drawing_no, rev, branch, doc.source_path)
    return document_display_name(doc)


@router.get("/export")
def export_audit_log(
    action: Optional[list[str]] = Query(None),
    screen: Optional[list[str]] = Query(None),
    user_id: Optional[list[int]] = Query(None),
    q: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    limit: int = Query(2000, ge=1, le=10000),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """화면의 현재 조회 조건 그대로 감사로그를 xlsx로 내려준다."""
    user_id = effective_user_id_filter(db, user, user_id)
    query = db.query(AuditLog, User, Document).outerjoin(
        User, AuditLog.user_id == User.id
    ).outerjoin(Document, AuditLog.document_id == Document.id)
    query = apply_log_filters(query, action, screen, user_id, q, date_from, date_to)
    rows = query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit).all()
    _pdf_by_doc, zip_filename_for = compute_extra_fields(db, rows)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "감사로그"
    ws.append(["No", "시각", "화면", "동작", "사용자", "자료명", "Zip 파일명", "상세 내용"])
    for i, (log, u, doc) in enumerate(rows, start=1):
        ws.append([
            i,
            log.created_at.strftime("%Y-%m-%d %H:%M:%S") if log.created_at else None,
            SCREEN_LABELS.get(log.screen, log.screen),
            ACTION_LABELS.get(log.action, log.action),
            u.name if u else None,
            log_display_name(doc, log.detail) if doc else None,
            zip_filename_for(log),
            format_detail(log.detail),
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([6, 20, 14, 12, 12, 26, 24, 80], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("시스템 로그")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen="감사로그", document_id=None,
        detail={"count": len(rows)},
    ))
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )
