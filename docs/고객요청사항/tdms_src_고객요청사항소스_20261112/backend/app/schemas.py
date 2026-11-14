from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class DocumentListItem(BaseModel):
    id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    doc_class: str
    category: Optional[str] = None
    source_path: Optional[str] = None  # 화면에서 "분류 다음부터의 경로"를 만드는 데 씀
    is_isometric: bool
    current_rev: int
    status: str
    has_dwg: bool
    has_xlsx: bool  # xlsx, xls
    has_etc: bool  # dwg/엑셀 계열/pdf가 아닌 원본 (doc, ppt, hwp 등)
    has_pdf: bool
    current_pdf_file_id: Optional[int] = None  # 목록 화면 미리보기 아이콘용 (현재 리비전 PDF만)
    updated_at: datetime
    # 처음 등록된 뒤로 실제로 한 번이라도 손댄 적이 있는지(updated_at > created_at).
    # 초기 일괄적재분·신규등록 직후는 updated_at에 '등록한 날짜'가 들어있을 뿐 수정된 게 아니라서,
    # 목록의 "최종수정" 날짜에 최근 표시(색)를 칠할지 판단할 때 이 값으로 먼저 걸러낸다.
    is_modified: bool = False

    class Config:
        from_attributes = True


class DocumentListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[DocumentListItem]


class FolderItem(BaseModel):
    path: str
    doc_count: int


class RecentChangeItem(BaseModel):
    """"최근수정본" 팝업 한 줄 — 최근 N일 안에 실제로 수정된 자료 1건."""

    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    category: Optional[str] = None
    path: str  # 화면의 "경로" 열과 동일(분류 다음부터)
    updated_at: datetime
    rev_label: str  # 지금 이 자료의 Rev (목록 화면의 Rev 열과 같은 값)
    change_kind: str  # REVISION(리비전이 올라 내용이 바뀜) / INFO(제목·분류 등 정보만 수정)
    rev_from: Optional[int] = None  # REVISION일 때만
    rev_to: Optional[int] = None
    vendor_name: Optional[str] = None
    project_name: Optional[str] = None
    # 시스템 로그에서 찾은 마지막 수정자 이름. 폴더 이름 바꾸기처럼 여러 자료가 한꺼번에
    # 움직인 작업은 자료별 기록이 남지 않아 비어 있을 수 있다.
    changed_by: Optional[str] = None
    current_pdf_file_id: Optional[int] = None  # 자료명 옆 돋보기(미리보기)가 열 PDF


class RecentChangesResponse(BaseModel):
    days: int
    total: int
    revision_count: int  # total 중 리비전이 오른 건수 ("50건 중 리비전 22건" 표시용)
    items: list[RecentChangeItem]


class RecentChangesSummary(BaseModel):
    """상단 [TDB 최근수정] 버튼용 — 건수만. 0보다 크면 버튼에 색이 들어간다."""

    count: int  # 최근 90일 수정 건수


class DocumentNavItem(BaseModel):
    """미리보기·상세보기의 이전/다음 넘겨보기 전용 — 표를 그리는 데 필요한 나머지 필드(상태·Rev·
    보유여부 등)는 빼고 넘겨보기에 꼭 필요한 값만 담아, 검색결과가 몇천 건이어도 가볍게 오간다."""
    id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    path: str  # 화면의 "경로" 열과 동일(분류 다음부터)
    current_pdf_file_id: Optional[int] = None


class FileHistoryItem(BaseModel):
    id: int
    rev: int
    branch: Optional[str] = None
    file_ext: str
    original_filename: str
    file_size: int
    vendor_name: Optional[str] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    vendor_labeled_rev: Optional[str] = None
    rev_mismatch_warning: bool
    review_status: str
    review_note: Optional[str] = None
    uploaded_at: datetime
    is_current: bool

    class Config:
        from_attributes = True


class RevisionSetItem(BaseModel):
    """Revision 이력 한 줄 = 같은 rev로 함께 올라온 파일 세트(원본 + PDF) 하나 (app/revision_sets.py)."""
    id: int  # 세트의 대표 파일 id — 비고 저장·미리보기가 이 id로 세트를 찾는다
    rev: int
    branch: Optional[str] = None
    name: str  # 확장자를 뗀 자료명
    exts: list[str]
    pdf_file_id: Optional[int] = None
    has_original: bool
    vendor_name: Optional[str] = None
    project_name: Optional[str] = None
    rev_mismatch_warning: bool
    review_status: str
    review_note: Optional[str] = None
    uploaded_at: datetime
    is_current: bool


class DistributionHistoryItem(BaseModel):
    id: int
    rev_at_distribution: int
    vendor: str
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    purpose: str
    purpose_note: Optional[str] = None
    distributed_at: datetime
    returned_at: Optional[datetime] = None
    return_note: Optional[str] = None
    display_name: Optional[str] = None  # 그때 나간 파일 이름(반출 당시 Rev 꼬리) — rev_naming

    class Config:
        from_attributes = True


class ProjectItem(BaseModel):
    id: int
    name: str
    project_no: Optional[str] = None
    vendor: Optional[str] = None
    note: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectCreate(BaseModel):
    name: str
    project_no: Optional[str] = None
    vendor: Optional[str] = None
    note: Optional[str] = None


class ProjectRename(BaseModel):
    name: str


class DistributeRequest(BaseModel):
    document_ids: list[int]
    vendor: str
    project_id: Optional[int] = None
    purpose: str  # MODIFY / REFERENCE / OTHER
    purpose_note: Optional[str] = None  # 반출 사유(선택 입력, 목적 종류와 무관)
    # 반출 zip에 원래 폴더 경로를 그대로 담을지(기본) — 끄면 zip 바로 밑에 평평하게 담는다.
    # 수정용(MODIFY)은 서버에서도 무조건 true로 고정한다(2026-08-28 CM 확정).
    keep_paths: bool = True


class DistributeResultItem(BaseModel):
    document_id: int
    distribution_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    duplicate_warning: bool


class DistributeResponse(BaseModel):
    results: list[DistributeResultItem]


class OutstandingItem(BaseModel):
    distribution_id: int
    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    title: str
    category: Optional[str] = None
    path: Optional[str] = None
    vendor: str
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    rev_at_distribution: int
    distributed_at: datetime
    distributed_by_name: Optional[str] = None  # 반출자(반출을 실행한 사용자)
    current_pdf_file_id: Optional[int] = None  # 자료명 옆 돋보기(미리보기)가 열 PDF
    status: str  # NOT_RETURNED(미반납) / REVIEWING(검수대기) — 둘 다 "도면이 곧 바뀔 수 있음"

    class Config:
        from_attributes = True


class OutstandingSummary(BaseModel):
    """상단 [TDB 반출] 버튼용 — 도면이 곧 바뀔 수 있는 건수(미반납 + 검수대기).
    0보다 크면 버튼에 색이 들어간다([TDB 최근수정] 버튼과 같은 규칙·같은 색)."""

    count: int


class ReturnRequest(BaseModel):
    return_note: Optional[str] = None


class UpdateNoteRequest(BaseModel):
    note: Optional[str] = None


class DistributedForImportItem(BaseModel):
    """자료검색 팝업: 한 공사·업체가 반출한 도면 한 건 + 반입 진행 상태."""
    distribution_id: int
    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    category: Optional[str] = None
    source_path: Optional[str] = None
    rev_at_distribution: int
    has_dwg: bool
    has_xlsx: bool
    has_etc: bool
    has_pdf: bool
    status: str  # INCOMPLETE(반입미완료) / REVIEWING(검수대기) / DONE(반입완료)


class DistributionListItem(BaseModel):
    id: int
    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    area: Optional[str] = None
    source_path: Optional[str] = None  # 미리보기 팝업 제목에 경로 표시용(동명 도면 구분)
    current_pdf_file_id: Optional[int] = None  # 자료명 옆 돋보기 미리보기용 (현재 리비전 PDF만)
    vendor: str
    project_name: Optional[str] = None
    purpose: str
    purpose_note: Optional[str] = None
    rev_at_distribution: int
    distributed_at: datetime
    distributed_by: Optional[int] = None  # 반출 실행 당시 로그인 사용자 id (본인 반출건 확인용)
    distributed_by_name: Optional[str] = None  # 반출 실행 당시 로그인 사용자 이름
    returned_at: Optional[datetime] = None
    return_note: Optional[str] = None
    status: Optional[str] = None  # INCOMPLETE/ISSUE/REVIEWING/DONE, 참조용 미반입은 None

    class Config:
        from_attributes = True


class DistributionZipListItem(BaseModel):
    """반출이력 화면 "Zip" 모드: 반출하기 한 번에 생성된 zip 파일 1개 = 1행."""
    zip_filename: str
    vendor: str
    project_name: Optional[str] = None
    purpose: str
    purpose_note: Optional[str] = None
    distributed_at: datetime
    distributed_by: Optional[int] = None  # 반출 실행 당시 로그인 사용자 id (본인 반출건 확인용)
    distributed_by_name: Optional[str] = None  # 반출 실행 당시 로그인 사용자 이름
    status: str  # SHIPPED(반출) / INCOMPLETE(반입미완료)

    class Config:
        from_attributes = True


class ZipMaterialItem(BaseModel):
    """Zip 현황 팝업: 한 Zip에 들어있던 자료 한 건 + 지금 상태."""
    distribution_id: int
    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    rev_at_distribution: int
    purpose: str
    status: Optional[str] = None  # INCOMPLETE/ISSUE/REVIEWING/DONE, 반입대상 아님은 None
    distributed_at: datetime
    returned_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class DistributionFilterOptions(BaseModel):
    """반출이력 검색 드롭다운에 실제로 내보낼 선택지들.

    조건을 하나 고르면 나머지 드롭다운은 "그 조건에 해당하는 기록에 실제로 쓰인 값"만
    남는다. 그래서 칸마다 목록을 따로 담아 내려준다 (각 칸은 자기 조건만 뺀 나머지
    조건으로 계산된 것이다 — 지금 고른 값이 자기 목록에서 사라지지 않게).
    """
    projects: list[str] = []
    vendors: list[str] = []
    purposes: list[str] = []
    statuses: list[str] = []
    distributed_by: list[int] = []


class ZipReturnRequest(BaseModel):
    zip_filename: str


class RevisionUploadResult(BaseModel):
    document_id: Optional[int] = None
    rev: Optional[int] = None
    branch: Optional[str] = None
    rev_label: Optional[str] = None
    file_count: Optional[int] = None
    any_mismatch_warning: Optional[bool] = None
    branched: Optional[bool] = None
    message: Optional[str] = None
    needs_confirmation: bool = False
    duplicate_exts: list[str] = []


class RegisterNewResult(BaseModel):
    document_id: Optional[int] = None
    drawing_no: Optional[str] = None
    rev: Optional[int] = None
    file_count: Optional[int] = None
    needs_confirmation: bool = False
    duplicate_exts: list[str] = []


class BulkMatchedItem(BaseModel):
    document_id: int
    drawing_no: str
    rev_label: str
    file_count: int
    any_mismatch_warning: bool
    branched: bool


class ImportIssueBrief(BaseModel):
    """업로드 직후 결과 요약에 쓰는 확인필요 한 건."""
    drawing_no: Optional[str] = None   # 추정 자료명 (반출 대상 아님이면 None)
    reasons: list[str]                 # 사유 코드 목록
    reason_text: str                   # 한글 사유 (쉼표 연결)


class ImportRunResult(BaseModel):
    """반입(zip / 반입자료) 업로드 실행 결과."""
    matched: list[BulkMatchedItem]     # 검수 대기로 등록된 것
    issues: list[ImportIssueBrief]     # 확인 필요로 간 것
    message: str


class ImportIssueFileItem(BaseModel):
    original_filename: str
    file_ext: str
    file_size: int


class ImportIssueItem(BaseModel):
    id: int
    intended_document_id: Optional[int] = None
    drawing_no: Optional[str] = None   # 자료명 (추정 도면 또는 파일명 stem)
    display_name: Optional[str] = None  # 화면 자료명(도면번호_Rev00 또는 받은 파일 이름) — rev_naming
    category: Optional[str] = None
    source_path: Optional[str] = None
    vendor_name: str
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    uploaded_at: datetime
    reasons: list[str]                 # 사유 코드 목록 (복수 가능)
    reason_text: str                   # 한글 사유 (쉼표 연결)
    detail_text: str                   # 상세 설명 문장
    files: list[ImportIssueFileItem]


class ResolveImportIssueRequest(BaseModel):
    document_id: int


class DiscardImportIssueRequest(BaseModel):
    note: Optional[str] = None


class PendingReviewFileItem(BaseModel):
    id: int
    file_ext: str
    original_filename: str
    file_size: int
    vendor_labeled_rev: Optional[str] = None
    rev_mismatch_warning: bool


class PendingReviewGroup(BaseModel):
    representative_file_id: int
    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    title: str
    area: Optional[str] = None
    category: Optional[str] = None       # 분류
    source_path: Optional[str] = None    # 경로
    rev: int
    branch: Optional[str] = None
    rev_label: str                       # 반입 Rev
    distributed_rev: Optional[int] = None  # 반출 Rev (연결된 반출 건 기준)
    distributed_exts: list[str] = []     # 반출자료 (dwg/pdf/…)
    imported_exts: list[str] = []        # 반입자료
    vendor_name: Optional[str] = None
    project_name: Optional[str] = None
    uploaded_at: datetime
    any_mismatch_warning: bool
    has_pdf: bool
    files: list[PendingReviewFileItem]
    branch_expected: Optional[int] = None  # N (분모) — 분기(branch)일 때만 값 있음
    branch_arrived: Optional[int] = None  # k (분자)
    can_approve: bool = True  # N/N 안 채워졌으면 False


class ReviewRequest(BaseModel):
    action: str  # APPROVE / REJECT
    note: Optional[str] = None


class DuplicateDistributionItem(BaseModel):
    """중복반출 팝업 한 행: 이 도면이 나간 반출 건 하나."""
    project_name: Optional[str] = None
    vendor: str
    distributed_at: datetime
    status: str  # PENDING_REVIEW(검수대기) / OUTSTANDING(반출미완료)


class BranchMergeResult(BaseModel):
    document_id: int
    drawing_no: str
    rev: int
    rev_label: str
    file_count: int
    message: str


class AuditLogItem(BaseModel):
    id: int
    action: str
    screen: Optional[str] = None
    user_name: Optional[str] = None
    document_id: Optional[int] = None
    drawing_no: Optional[str] = None
    display_name: Optional[str] = None  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    current_pdf_file_id: Optional[int] = None  # 자료명 옆 돋보기 미리보기용 (현재 리비전 PDF만)
    zip_filename: Optional[str] = None  # 반출·반입 로그의 Zip 파일명 (있으면 Zip 다운·상세 현황 버튼)
    detail: Optional[dict] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ActionGroup(BaseModel):
    """로그동작 드롭다운 그룹 한 묶음 (예: '자료 반출입·검수' -> [REGISTER, DISTRIBUTE, ...])."""
    label: str
    actions: list[str]


class AuditMeta(BaseModel):
    """감사로그 화면의 필터 드롭다운용 — 화면 목록, 화면별로 실제 존재하는 로그종류만 묶어서 준다."""
    screens: list[str]
    actions_by_screen: dict[str, list[str]]  # 화면명 -> [action 코드, ...] (없으면 빈 배열)
    action_labels: dict[str, str]  # action 코드 -> 한글 라벨
    screen_labels: dict[str, str]  # 내부 화면 키 -> 지금 나브바 이름
    action_groups: list[ActionGroup]  # 로그동작 드롭다운에 이 순서·묶음대로 보여준다 (엑셀내보내기 등은 빠짐)


class EditorFolderItem(BaseModel):
    path: str
    doc_count: int  # "숨김 폴더 보기"를 켜면 자료 수가 아니라 파일 수다 (editor.get_tree 설명 참고)
    is_placeholder: bool = False  # 자료가 하나도 없어 표시용으로만 존재하는 빈 폴더
    is_pair: bool = False  # 평소 트리에 안 보이는 DWG·PDF 폴더 ("숨김 폴더 보기"를 켰을 때만 나온다)
    # 이 DWG·PDF 폴더를 고치면(이름변경·이동·삭제) 두 건으로 나뉘게 되는 자료 수 — 화면이
    # 실행 전 경고 팝업에 그대로 보여준다 (2026-08-17 CM 확정).
    split_count: int = 0


class EditorDocItem(BaseModel):
    """폴더·자료 편집 화면 트리에 쓰는 자료 1건 — 목록 화면보다 가벼운 필드만 담는다."""
    id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    title: str
    source_path: Optional[str] = None
    current_rev: int
    status: str
    has_dwg: bool
    has_pdf: bool
    current_pdf_file_id: Optional[int] = None

    class Config:
        from_attributes = True


class EditorTreeResponse(BaseModel):
    folders: list[EditorFolderItem]
    documents: list[EditorDocItem]


class FolderPlaceholderCreate(BaseModel):
    path: str


class FolderReparentRequest(BaseModel):
    """폴더 이름 변경·위치 이동 공용 — 결국 경로 접두어를 old_path에서 new_path로 바꾸는 동일 작업."""
    old_path: str
    new_path: str
    cascade_numbering: bool = False  # 하위 폴더 번호도 함께 바꾸기(5→7이면 5.1→7.1)


class FolderReparentResult(BaseModel):
    affected_documents: int
    affected_placeholders: int
    new_path: str
    # DWG·PDF 폴더를 고쳐서 원본·사본이 다시 두 건으로 나뉜 자료 수 (2026-08-17)
    split_documents: int = 0


class FolderArchiveRequest(BaseModel):
    path: str
    reason: Optional[str] = None


class FolderArchiveResult(BaseModel):
    batch_id: int
    archived_documents: int
    removed_placeholders: int
    split_documents: int = 0


class PairFolderCandidate(BaseModel):
    """DWG·PDF 폴더가 나란히 있지만 아직 자료가 하나로 합쳐지지 않은 상위 폴더 1건."""
    path: str
    dwg_folder: str
    pdf_folder: str
    dwg_count: int
    pdf_count: int
    mergeable_count: int  # 이름이 (대소문자까지) 정확히 겹쳐 실제로 합칠 수 있는 자료 수
    # 대소문자만 달라서 못 합치는 것 — 합쳐주지 않고 알리기만 한다. CM이 [자료명 변경]으로
    # 한쪽 이름을 바로잡으면 그때부터 합칠 수 있다 (2026-08-21 CM 확정, D-47 ④)
    case_mismatch_count: int = 0
    case_mismatch_names: list[str] = []


class PairFolderCandidateList(BaseModel):
    candidates: list[PairFolderCandidate]


class PairFolderMergeRequest(BaseModel):
    paths: list[str]


class PairFolderMergeSkipped(BaseModel):
    path: str
    drawing_no: str
    reason: str


class PairFolderMergeResult(BaseModel):
    merged: int
    skipped: list[PairFolderMergeSkipped]


class DocumentRenameRequest(BaseModel):
    title: str


class DocumentMoveRequest(BaseModel):
    new_path: str


class DocumentArchiveRequest(BaseModel):
    reason: Optional[str] = None


class DocumentArchiveResult(BaseModel):
    batch_id: int


class TrashItem(BaseModel):
    batch_id: int
    kind: str  # FOLDER / DOCUMENT
    label: str
    # 목록 "대상" 칸에 실제로 보여줄 이름. 폴더·단일 자료는 label과 같고, 자료가 여러 건인
    # 폴더 삭제는 가나다순 대표 자료명 1건 + " 외"로 대체한다(폴더명보다 알아보기 쉬움).
    target_label: str
    original_path: Optional[str] = None
    doc_count: int
    archived_at: datetime
    reason: Optional[str] = None
    # 되살리기 화면에서 바로 다운로드할 수 있게, 대표 자료 1건의 원본/PDF 파일ID (자료 1건 삭제일 때만 유용)
    sample_document_id: Optional[int] = None


class TrashCount(BaseModel):
    """화면 위 [삭제 보관함] 버튼의 괄호 숫자 — 목록 전체를 안 읽고 건수만 받기 위한 응답."""
    count: int


class TrashPurgeRequest(BaseModel):
    """삭제 보관함 완전삭제 — 표에서 체크한 여러 건을 한 번에 지운다(용량 확보용)."""
    batch_ids: list[int]


class TrashPurgeResult(BaseModel):
    """완전삭제 결과. freed_bytes는 실제로 지운 물리 파일 크기 합(용량 확보량 안내용)."""
    purged_batches: int
    purged_documents: int
    deleted_files: int
    freed_bytes: int
    # 이미 되살렸거나 없어진 배치 등 건너뛴 건수(요청한 batch_ids 중)
    skipped_batches: int = 0


class TrashRestoreResult(BaseModel):
    restored_documents: int


class ZipRegisterSkipped(BaseModel):
    stem: str
    ext: str  # 유일하게 있는 형식 (원본과 PDF 중 한쪽만 있어서 건너뛴 경우)
    folder: str = ""


class PartialFilesExportRequest(BaseModel):
    """원본/PDF 한쪽만 있는 자료 확인 팝업(TDB 관리 신규추가·Zip 등록)의 표를 그대로 xlsx로 내려받기 위한 요청."""
    title: str
    items: list[ZipRegisterSkipped]


class ZipRegisterDuplicate(BaseModel):
    stem: str
    folder: str
    exts: list[str]


class ZipRegisterExisting(BaseModel):
    """이미 같은 폴더에 같은 이름으로 있는 자료 — 등록하지 않고 건너뛴 것."""
    stem: str
    exts: list[str]  # 이미 갖고 있어서 못 올린 형식


class ZipRegisterResult(BaseModel):
    created_documents: int
    skipped: list[ZipRegisterSkipped]
    target_path: str
    needs_confirmation: bool = False
    unsafe_paths: list[str] = []
    duplicates: list[ZipRegisterDuplicate] = []
    # 이 Zip에서 짝 폴더로 인식해 합친 폴더 이름들(DWG·PDF가 나란히 있던 자리). 묻지 않고
    # 자동 판정하므로 결과 안내용이다 (2026-08-21 CM 확정 — 예전에는 이걸로 확인창을 띄웠다)
    pair_folders: list[str] = []
    attached_files: int = 0  # 새 자료를 만들지 않고 기존 자료에 붙인 파일 수
    already_exists: list[ZipRegisterExisting] = []


class ExistingDocRevLookup(BaseModel):
    """신규추가 팝업의 Rev 매칭용 — 같은 폴더·같은 이름으로 이미 등록된 자료가 있는지."""
    found: bool
    document_id: Optional[int] = None
    current_rev: Optional[int] = None
    exts: list[str] = []  # 그 자료가 이미 갖고 있는 형식


class BulkRegisterUnmatched(BaseModel):
    stem: str
    only_ext: str


class BulkRegisterResult(BaseModel):
    created_documents: int
    unmatched: list[BulkRegisterUnmatched]
    target_path: str
    needs_confirmation: bool = False
    duplicates: list[ZipRegisterDuplicate] = []
    attached_files: int = 0
    already_exists: list[ZipRegisterExisting] = []


class ReplaceResult(BaseModel):
    document_id: int
    rev: Optional[int] = None
    file_count: Optional[int] = None
    message: str
    needs_confirmation: bool = False
    duplicate_exts: list[str] = []


class DocumentBulkMoveRequest(BaseModel):
    document_ids: list[int]
    new_path: str


class DocumentBulkMoveResult(BaseModel):
    moved_documents: int


class DocumentBulkArchiveRequest(BaseModel):
    document_ids: list[int]
    reason: Optional[str] = None


class DocumentBulkArchiveResult(BaseModel):
    batch_id: int
    archived_documents: int


class ReplaceBulkMismatch(BaseModel):
    # 선택했지만 첨부 파일 중 이름이 같은 것을 찾지 못한 자료명
    unmatched_docs: list[str] = []
    # 첨부했지만 선택한 자료 중 이름이 같은 것이 없는 파일(자료명)
    unmatched_files: list[str] = []


class ReplaceBulkResult(BaseModel):
    replaced_documents: int = 0
    message: str
    needs_confirmation: bool = False
    duplicate_exts: list[str] = []
    mismatch: Optional[ReplaceBulkMismatch] = None
    partial: list[ZipRegisterSkipped] = []
    any_mismatch_warning: bool = False


# ---------------------------------------------------------------------------
# MDB 편집 (폴더·자료 편집과 같은 기능을 mdb_files 대상으로) — 위 Editor* 스키마와 형태는
# 비슷하지만, mdb_files는 리비전 개념이 없고 source_path에 파일명까지 포함돼 있어
# 필드 이름을 documents용과 헷갈리지 않게 Mdb 접두어로 따로 둔다.
# ---------------------------------------------------------------------------

class MdbEditorFolderItem(BaseModel):
    path: str
    # 숨김 폴더 보기를 끄면 자료 수(원본+사본은 1건), 켜면 파일 수 — TDB 관리와 같은 규칙.
    file_count: int
    is_placeholder: bool = False
    is_pair: bool = False  # 평소엔 숨기는 DWG·PDF 폴더 (화면에서 폴더 아이콘을 회색으로 구분)
    # 이 DWG·PDF 폴더를 고치면 두 건으로 나뉘게 되는 자료 수 — 실행 전 경고 팝업용 (2026-08-17)
    split_count: int = 0


class MdbEditorFileItem(BaseModel):
    id: int
    name: str  # 자료명 (확장자 없음)
    source_path: str  # 폴더\자료명 (확장자 없음)
    exts: list[str]
    has_pdf: bool
    pdf_file_id: Optional[int] = None


class MdbEditorTreeResponse(BaseModel):
    folders: list[MdbEditorFolderItem]
    files: list[MdbEditorFileItem]


class MdbFolderPlaceholderCreate(BaseModel):
    path: str


class MdbFolderReparentRequest(BaseModel):
    old_path: str
    new_path: str
    cascade_numbering: bool = False


class MdbFolderReparentResult(BaseModel):
    affected_files: int
    affected_placeholders: int
    new_path: str
    # DWG·PDF 폴더를 고쳐서 원본·사본이 다시 두 건으로 나뉜 자료 수 (2026-08-17)
    split_documents: int = 0


class MdbFolderArchiveRequest(BaseModel):
    path: str
    reason: Optional[str] = None


class MdbFolderArchiveResult(BaseModel):
    batch_id: int
    archived_files: int
    removed_placeholders: int
    split_documents: int = 0


class MdbFileMoveRequest(BaseModel):
    new_folder: str  # 새 폴더 경로 (파일명 제외)


class MdbFileArchiveRequest(BaseModel):
    reason: Optional[str] = None


class MdbFileArchiveResult(BaseModel):
    batch_id: int


# 자료를 여러 건 체크했을 때(복수선택) 쓰는 일괄 처리용 — 자료명·정보 변경은 위치·이름·Tag No가
# 자료마다 달라 일괄로 못 바꾸고 설비유형만 일괄 지정할 수 있다(2026-08-17 CM 확정).
class MdbFileBulkMoveRequest(BaseModel):
    file_ids: list[int]
    new_folder: str


class MdbFileBulkMoveResult(BaseModel):
    moved_files: int


class MdbFileBulkArchiveRequest(BaseModel):
    file_ids: list[int]
    reason: Optional[str] = None


class MdbFileBulkArchiveResult(BaseModel):
    batch_id: int
    archived_files: int


class MdbFileBulkEquipmentTypeUpdate(BaseModel):
    """자료를 여러 건 선택했을 때의 "자료명·정보 변경" — 설비유형·자료유형만 일괄 지정한다
    (자료명·Tag No·Note는 자료마다 달라 한 번에 못 바꾼다)."""
    file_ids: list[int]
    equipment_type: Optional[str] = None
    doc_type: Optional[str] = None


class MdbFileBulkUpdateResult(BaseModel):
    updated_files: int


class MdbReplaceResult(BaseModel):
    file_id: int
    message: str


class MdbTrashItem(BaseModel):
    batch_id: int
    kind: str  # MDB_FOLDER / MDB_FILE
    label: str
    target_label: str
    original_path: Optional[str] = None
    file_count: int
    archived_at: datetime
    reason: Optional[str] = None
    sample_file_id: Optional[int] = None


class MdbTrashRestoreResult(BaseModel):
    restored_files: int


# ---------------------------------------------------------------------------
# 폐기 보관함 (2026-08-30 CM 확정) — 삭제 보관함과 달리 자료 1건마다 한 줄이다(app/retire.py).
# TDB·MDB가 거의 같은 모양이고, 다른 것은 MDB에 Rev가 없다는 것뿐이다.
# ---------------------------------------------------------------------------

class RetireRequest(BaseModel):
    """자료 삭제 팝업의 [폐기 보관함으로 이동] — 선택한 자료를 한 번에 폐기한다."""
    document_ids: list[int]
    reason: Optional[str] = None


class RetireResult(BaseModel):
    retired_documents: int


class MdbRetireRequest(BaseModel):
    """MDB 자료 삭제 팝업의 [폐기 보관함으로 이동]. 자료 id(대표 id)를 받는다."""
    file_ids: list[int]
    reason: Optional[str] = None


class MdbRetireResult(BaseModel):
    retired_files: int


class RetiredItem(BaseModel):
    """폐기 보관함 표 한 줄 = 자료 1건. 분류·경로·Rev는 폐기 당시 값이다
    (폐기 중에는 자료를 편집할 수 없어 지금 값이 곧 그때 값이다)."""
    batch_id: int
    document_id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    category: Optional[str] = None
    path: Optional[str] = None
    rev: int = 0
    pdf_file_id: Optional[int] = None  # 표의 돋보기(미리보기)용 — 현재 리비전 PDF
    retired_at: datetime
    reason: Optional[str] = None


class MdbRetiredItem(BaseModel):
    """MDB 폐기 보관함 표 한 줄 = 자료 1건. MDB는 리비전이 없어 Rev 칸이 없다."""
    batch_id: int
    file_id: int  # 자료 대표 id (상세보기 주소에 쓰는 값)
    name: str
    category: Optional[str] = None  # 전용 / 공용 / 확인필요
    path: Optional[str] = None
    pdf_file_id: Optional[int] = None
    retired_at: datetime
    reason: Optional[str] = None


class RetireRestoreRequest(BaseModel):
    """폐기 자료 복구. new_paths는 원래 폴더가 없어져 CM이 다시 골라준 위치
    {폐기이력 id: 새 폴더 경로} — 비어 있으면 폐기 당시 경로로 되돌린다."""
    batch_ids: list[int]
    new_paths: dict[int, str] = {}


class RetireRestoreBlocked(BaseModel):
    """복구할 수 없어 위치를 다시 골라야 하는 항목. reason은 NO_FOLDER(폴더가 없어짐) /
    NAME_TAKEN(같은 이름 자료가 이미 그 폴더에 있음)."""
    batch_id: int
    label: str
    original_path: Optional[str] = None
    reason: str


class RetireRestoreResult(BaseModel):
    """blocked가 하나라도 있으면 **아무것도 복구하지 않는다** — 일부만 되살아나면 무엇이
    반영됐는지 헷갈리기 때문(load_selected_documents와 같은 방침)."""
    restored: int = 0
    blocked: list[RetireRestoreBlocked] = []


class MdbTrashPurgeResult(BaseModel):
    """MDB 삭제 보관함 완전삭제 결과 — TDB(TrashPurgeResult)와 같은 구성.
    purged_files는 자료 수, deleted_files는 실제로 지운 파일 수다(원본+사본이면 자료 1건에 파일 2개)."""
    purged_batches: int
    purged_files: int
    deleted_files: int
    freed_bytes: int
    skipped_batches: int = 0


class MdbPairFolderMergeSkipped(BaseModel):
    """DWG·PDF 폴더 병합에서 자동으로 합치지 못하고 건너뛴 자료 1건과 그 사유."""
    path: str
    name: str
    reason: str


class MdbPairFolderMergeResult(BaseModel):
    merged: int
    skipped: list[MdbPairFolderMergeSkipped]


class MdbDuplicateGroup(BaseModel):
    stem: str
    folder: str
    exts: list[str]


class MdbRegisterResultBase(BaseModel):
    """자료 등록 결과 — 자료 단위로 센다 (2026-08-17 CM 확정).

    같은 폴더에 같은 자료명이 이미 있으면 새 자료를 만들지 않고, 아직 없는 형식만 그 자료에
    붙인다(attached_files). 이미 있는 형식은 덮어쓰지 않고 건너뛴다(skipped_existing) —
    같은 zip을 두 번 올려도 자료가 두 벌 생기거나 파일이 조용히 덮어써지지 않게 하기 위함.
    """
    created_files: int          # 새로 만든 자료 수
    attached_files: int = 0     # 기존 자료에 채워 넣은 파일 수 (예: 원본만 있던 자료에 PDF 추가)
    skipped_existing: list[str] = []  # 이미 그 형식이 있어 건너뛴 자료명
    target_path: str
    needs_confirmation: bool = False
    duplicates: list[MdbDuplicateGroup] = []


class MdbZipRegisterResult(MdbRegisterResultBase):
    pass


class MdbBulkRegisterResult(MdbRegisterResultBase):
    pass


class DocumentDetail(BaseModel):
    id: int
    drawing_no: str
    display_name: str  # 화면 자료명(도면번호_Rev00) — app/rev_naming.py
    title: str
    doc_class: str
    category: Optional[str] = None
    discipline: Optional[str] = None
    doc_type: Optional[str] = None
    isbl_osbl: Optional[str] = None
    elevation: Optional[str] = None
    area: Optional[str] = None
    source_path: Optional[str] = None
    is_isometric: bool
    equipment_tag: Optional[str] = None
    project_id: Optional[int] = None
    current_rev: int
    status: str
    has_dwg: bool
    has_xlsx: bool  # xlsx, xls
    has_etc: bool  # dwg/엑셀 계열/pdf가 아닌 원본 (doc, ppt, hwp 등)
    has_pdf: bool
    created_at: datetime
    updated_at: datetime
    current_pdf_file_id: Optional[int] = None
    current_original_file_id: Optional[int] = None  # 현재 리비전의 원본(dwg/xlsx/etc 중 하나) 파일
    revisions: list[FileHistoryItem]
    revision_sets: list[RevisionSetItem]  # 화면 Revision 이력 표는 이것을 쓴다(세트마다 한 줄)
    distributions: list[DistributionHistoryItem]


class MdbDocFile(BaseModel):
    """자료 1건을 이루는 파일 하나(원본 또는 PDF 사본). 상세보기의 파일별 다운로드 버튼과
    미리보기가 이 id를 쓴다."""
    id: int
    original_filename: str
    file_ext: str
    file_size: int
    is_pdf: bool
    pairing_folder: Optional[str] = None  # 원본에서 DWG·PDF 폴더에 있었으면 그 이름(화면 표시는 안 함)


class MdbFileItem(BaseModel):
    """MDB 자료 1건 — 원본과 PDF 사본이 있으면 둘을 합쳐 한 건으로 내려준다 (2026-08-17 CM 확정).

    id는 이 자료의 대표 파일 id다(가장 먼저 등록된 파일). 상세보기 주소·다운대기함·편집 API가
    전부 이 값 하나로 자료를 가리키고, 서버가 그때그때 같은 자료의 나머지 파일까지 찾아 처리한다.
    """
    id: int
    name: str  # 자료명 — 확장자를 뗀 이름
    source_path: str  # 폴더\자료명 (확장자 없음)
    folder: str
    files: list[MdbDocFile]
    exts: list[str]  # 이 자료가 가진 파일 형식들 (예: ["pdf", "xlsx"])
    has_original: bool
    has_pdf: bool
    pdf_file_id: Optional[int] = None  # 미리보기·PDF 열람에 쓸 파일 id
    file_size: int  # 자료에 딸린 파일 크기 합
    # 설비유형·자료유형은 여러 개면 슬래시로 이어진 문자열이다("Pump/Strainer" — app/mdb_types.py)
    equipment_type: Optional[str] = None
    doc_type: Optional[str] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    year: Optional[int] = None
    note: Optional[str] = None
    tags: list[str]
    category: str  # 전용 / 공용 / 확인필요 (태그·설비유형 유무로 계산됨)
    uploaded_at: datetime
    updated_at: datetime


class MdbNoteLine(BaseModel):
    """자료 Note 한 줄을 조각으로 나눈 것 — 상세보기가 표로 보여주는 데 쓴다 (2026-09-01 CM 확정).

    Note 한 줄은 조각을 밑줄로 이어 붙인 문장이라 그대로 두면 무엇이 어떻게 바뀌었는지 눈에
    안 들어온다. 그 줄을 남긴 Tag No 이력을 찾아 등록할 때 적은 값을 그대로 담아 보낸다
    (나누는 규칙은 app/mdb_note.py 한 곳에 있다).

    이력에서 온 줄이 아니면 조각을 알 수 없으므로 from_history=false로 두고 text만 채운다 —
    화면은 그런 줄을 칸을 합쳐 원문 그대로 보여준다.
    """
    text: str  # Note 원문 한 줄
    from_history: bool
    history_id: Optional[int] = None
    label: Optional[str] = None       # 구분 (Tag No 변경/추가/삭제)
    base_tag: Optional[str] = None
    new_tag: Optional[str] = None
    tag_change: Optional[str] = None  # "P1000A → P1700A" (새 Tag No가 없으면 대상 Tag No만)
    year: Optional[str] = None
    project: Optional[str] = None
    reason: Optional[str] = None
    memo: Optional[str] = None


class MdbFileDetail(MdbFileItem):
    """자료 상세보기 응답 — 목록과 같은 값에 Note를 조각낸 것(note_items)만 더한다.

    목록(1,200건)에는 필요 없는 값이라 상세보기에서만 채운다.
    """
    note_items: list[MdbNoteLine] = []


class MdbTagAutoApplied(BaseModel):
    """자료를 저장할 때 자동으로 함께 들어간 Tag No 이력 1건 (2026-09-01 CM 확정).

    "묻지 않고 넣되 무엇이 들어갔는지는 알려준다"가 CM이 고른 방식이라(화면에 알림창으로
    보여준다) 무엇을 넣었는지 그대로 담아 보낸다.
    """
    history_id: int
    base_tag: str
    action: str                  # ADD / REMOVE / RENAME / NOTE_ONLY
    action_label: str            # 화면에 그대로 쓰는 문구 ("Tag No 추가" 등)
    new_tag: Optional[str] = None
    note_line: Optional[str] = None  # Note에 더한 한 줄 (없으면 Note는 안 건드림)
    tag_added: bool = False      # 이 자료에 Tag No가 실제로 들어갔는지
    note_added: bool = False     # 이 자료 Note에 한 줄이 실제로 더해졌는지


class MdbFileInfoUpdateResult(MdbFileDetail):
    """"자료명·정보 변경" 저장 결과 — 저장된 자료 내용에 자동으로 함께 적용된 이력만 더한다.

    화면은 이 값이 있으면 저장 직후 "아래 Tag No 이력이 함께 적용됐습니다"라고 알려준다.
    """
    auto_applied: list[MdbTagAutoApplied] = []


class MdbSearchResponse(BaseModel):
    tag: str
    tag: str
    equipment_type: Optional[str] = None
    direct: list[MdbFileItem]
    common: list[MdbFileItem]


class MdbListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[MdbFileItem]


class MdbNavItem(BaseModel):
    """미리보기의 이전/다음 넘겨보기 전용(documents의 DocumentNavItem과 같은 목적) — 표를
    그리는 데 필요한 나머지 필드는 빼고 넘겨보기에 꼭 필요한 값만 담아 가볍게 오간다."""
    id: int
    name: str
    source_path: str
    has_pdf: bool
    pdf_file_id: Optional[int] = None


class MdbFileInfoUpdate(BaseModel):
    """MDB 관리 화면 "자료명·정보 변경" — 파일명(비어있으면 안 바꿈)·Tag No·설비유형·자료유형·
    Note를 한 번에 저장.

    설비유형·자료유형은 화면에서 체크한 것들을 슬래시로 이어 붙인 문자열로 온다
    ("Pump/Strainer"). 서버는 app/mdb_types.py 규칙으로 한 번 정리해서 저장한다."""
    filename: Optional[str] = None
    equipment_type: Optional[str] = None
    doc_type: Optional[str] = None
    note: Optional[str] = None
    tags: list[str] = []


class EquipmentTypeItem(BaseModel):
    id: int
    name: str
    is_hidden: bool
    created_at: datetime

    class Config:
        from_attributes = True


class EquipmentTypeCreate(BaseModel):
    name: str


class EquipmentTypeRename(BaseModel):
    name: str


class MdbMeta(BaseModel):
    equipment_types: list[str]
    doc_types: list[str]
    projects: list[ProjectItem]
    years: list[int]


class MdbFolderItem(BaseModel):
    """MDB는 폴더 실체가 없다 — mdb_files.source_path(원본 폴더 경로) 그대로 보여주는
    조회 전용 트리라 documents처럼 이름 변경/이동 대상이 아니다."""
    path: str
    file_count: int  # 이 폴더의 자료 수 (원본+사본은 1건으로 셈)


class MdbTreeFileItem(BaseModel):
    """트리에서 폴더 하위에 자료 이름까지 펼쳐 보여주기 위한 가벼운 항목."""
    id: int
    name: str  # 자료명 (확장자 없음)
    folder: str  # source_path에서 파일명을 뗀 폴더 부분
    exts: list[str]
    has_pdf: bool
    pdf_file_id: Optional[int] = None


class MdbTreeResponse(BaseModel):
    folders: list[MdbFolderItem]
    files: list[MdbTreeFileItem]


class UserItem(BaseModel):
    id: int
    username: str
    name: str
    role: str
    group_id: Optional[int] = None
    group_name: Optional[str] = None
    is_active: bool
    employment_status: str
    last_login_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True



class UserCreate(BaseModel):
    username: str
    name: str
    role: str


class UserUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    employment_status: Optional[str] = None
    password: Optional[str] = None


class UserGroupUpdate(BaseModel):
    group_id: Optional[int] = None  # null이면 그룹 없음(미배정)으로 이동


class GroupItem(BaseModel):
    id: int
    name: str
    member_count: int
    created_at: datetime

    class Config:
        from_attributes = True


class GroupCreate(BaseModel):
    name: str


class GroupUpdate(BaseModel):
    name: str


class GroupMemberItem(BaseModel):
    id: int
    username: str
    name: str
    role: str
    employment_status: str

    class Config:
        from_attributes = True


class PermissionNode(BaseModel):
    key: str
    label: str
    children: list["PermissionNode"] = []


class GroupPermissionsUpdate(BaseModel):
    allowed_keys: list[str]


# ---------------------------------------------------------------------------
# MDB 관리 "Tag No 이력관리" — Tag No 변경이력 (2026-08-30 CM 확정)
# ---------------------------------------------------------------------------

class MdbTagHistoryTarget(BaseModel):
    """이력을 적용하면 실제로 바뀔 자료 1건 — 등록 화면에서 "무엇이 바뀌는지" 미리 보여준다."""
    id: int
    name: str
    source_path: str
    project_name: Optional[str] = None
    tags: list[str] = []


class MdbTagHistoryTargetList(BaseModel):
    doc_count: int
    file_count: int
    items: list[MdbTagHistoryTarget]


class MdbTagHistoryCreate(BaseModel):
    """이력 등록(= 그 자리에서 바로 적용). action에 따라 new_tag가 필요하다.

    action: ADD(새 Tag No 함께 달기) / REMOVE(대상 Tag No 빼기) /
            RENAME(대상 → 새 Tag No로 바꾸기) / NOTE_ONLY(Tag No는 그대로, Note만)
    write_note가 false면 Note에는 아무것도 쓰지 않고 Tag No만 손댄다.
    """
    base_tag: str
    action: str
    new_tag: Optional[str] = None
    project_id: Optional[int] = None
    note_label: Optional[str] = None
    note_year: Optional[str] = None
    note_project: Optional[str] = None
    note_reason: Optional[str] = None
    note_memo: Optional[str] = None
    write_note: bool = True
    # 앞으로 이 Tag No가 새로 붙는 자료에도 시스템이 알아서 같은 처리를 넣을지 (2026-09-01 CM 확정).
    # 새 이력 등록 팝업의 체크박스가 기본으로 켜져 있다.
    auto_apply: bool = True


class MdbTagHistoryItem(BaseModel):
    """이력 목록 표 1줄."""
    id: int
    base_tag: str
    action: str
    action_label: str  # 화면·엑셀에 그대로 쓰는 한글 문구
    new_tag: Optional[str] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None  # 적용 범위를 좁힌 공사(전체면 비어 있음)
    # Note 문구를 이루는 조각들 — [수정] 팝업이 등록할 때 적은 값을 그대로 채워 넣는 데 쓴다
    note_label: Optional[str] = None
    note_year: Optional[str] = None
    note_project: Optional[str] = None
    note_reason: Optional[str] = None
    note_memo: Optional[str] = None
    note_line: Optional[str] = None
    write_note: bool = True  # Note 문구를 남긴 이력인지 (note_line이 있으면 참)
    auto_apply: bool = False  # 앞으로 이 Tag No가 붙는 자료에 자동으로 적용할지
    applied_doc_count: int
    applied_at: Optional[datetime] = None
    applied_by_name: Optional[str] = None
    reverted_at: Optional[datetime] = None
    reverted_by_name: Optional[str] = None
    status: str  # 적용됨 / 취소됨
    created_at: datetime
    created_by_name: Optional[str] = None


class MdbProjectFolder(BaseModel):
    """이력 등록 팝업의 공사명 드롭다운에 넣을 값 — MDB 폴더트리 최상위 폴더 (2026-09-01 CM 지시).

    공사 표(projects)를 쓰지 않는다. 그 표에는 MDB에 폴더가 없는 도면 쪽 공사도 섞여 있고,
    반대로 숨김 처리된 공사는 빠져 실제 폴더와 어긋나기 때문이다(실제로 MDB 폴더가 있는
    "2017. 06. - LBO T1302 1기 용도 변경 공사"가 숨김이라 고를 수 없었다).

    folder 는 폴더 이름 그대로("2016. 02. - Yu4A 배합 개선 공사") — 드롭다운에 이대로 보인다.
    year   는 그 폴더명 앞의 연도. 고르면 Note 문구의 연도가 "2016년"으로 자동으로 채워진다.
    Note에 적히는 공사명(앞 날짜를 뗀 "Yu4A 배합 개선 공사")은 화면이 만든다 — 그 규칙은
    이미 화면에만 있고(shortProjectLabel), 서버에도 두면 두 곳이 어긋날 자리만 늘어난다.
    """
    folder: str
    year: Optional[int] = None


class MdbTagHistoryMeta(BaseModel):
    """이력 목록 검색줄의 연도·공사명 드롭다운에 넣을 값 (2026-08-31 CM 지시).

    설비유형·자료유형처럼 미리 정해둔 목록이 있는 값이 아니라 등록할 때 직접 적는 칸이므로,
    **실제 이력에 적혀 있는 값만** 모아서 보여준다(쓰인 적 없는 값은 골라도 0건이라 소용없다).
    """
    years: list[str] = []
    note_projects: list[str] = []


class MdbTagHistoryApplyResult(BaseModel):
    """적용·다시 적용·되돌리기 공통 결과 — 자료 몇 건에 무엇이 들어갔는지 알려준다."""
    id: int
    doc_count: int
    tag_changed_docs: int
    note_changed_docs: int
