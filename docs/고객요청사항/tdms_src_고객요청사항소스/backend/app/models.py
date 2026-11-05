from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(Text, nullable=False, unique=True)
    password_hash = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    role = Column(Text, nullable=False)  # ADMIN / INTERNAL
    group_id = Column(Integer, ForeignKey("groups.id"), nullable=True)
    is_active = Column(Boolean, nullable=False, server_default="true")
    # 재직/퇴직/삭제 — "삭제"도 겉보기만 삭제고 실제로는 비활성화다(D-6: 어떤 테이블에도 DELETE 없음).
    # 아이디를 잘못 만들었을 때 쓰는 삭제와, 실제 퇴사자 처리인 퇴직을 화면에서 구분해 보여주기 위한 값.
    # is_active는 그대로 로그인 가능 여부(=ACTIVE인지)를 나타내는 파생값으로 계속 같이 둔다.
    employment_status = Column(Text, nullable=False, server_default="ACTIVE")  # ACTIVE / RETIRED / DELETED
    last_login_at = Column(DateTime(timezone=True), nullable=True)  # 사용자 관리 화면 "접속일"
    # 로그인 보안 (2026-09-17, auth.py 참고)
    # 임시 비밀번호(새 계정·초기화)로 들어온 사람은 이 값이 true — 비밀번호를 바꾸기 전엔 다른 화면을 못 쓴다
    must_change_password = Column(Boolean, nullable=False, server_default="false")
    failed_login_count = Column(Integer, nullable=False, server_default="0")  # 연속으로 틀린 횟수
    locked_until = Column(DateTime(timezone=True), nullable=True)  # 이 시각까지 로그인 잠김
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    group = relationship("Group")


class Group(Base):
    """사용자 그룹 — 그룹별로 권한 트리(GroupPermission)를 설정하고 사용자를 배정한다.

    D-6: 삭제 기능 없음. 이름 변경만 가능(그룹 자체를 없애는 기능은 요청받지 않았음 — 필요해지면
    projects.is_hidden처럼 숨김 컬럼을 추가하는 방식으로 확장).
    """

    __tablename__ = "groups"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False, unique=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class GroupPermission(Base):
    """그룹 하나가 권한 트리의 특정 최하위(액션) 노드에 대해 갖는 허용 여부.

    트리 구조 자체(경로·액션 목록)는 DB가 아니라 app/permission_tree.py에 코드로 고정돼 있다 —
    화면·기능이 코드로 존재하는 것과 항상 같이 가야 하는 값이라 CM이 임의로 노드를 추가·삭제할
    수 있게 하지 않는다. 여기 저장하는 건 그중 어떤 노드를 Y로 켰는지뿐이다. 상위 경로를 Y로
    켜면 하위 액션 전부가 Y로 적용되는 규칙(CM 확정)은 화면(프론트)에서 한번에 계산해 최하위
    액션 키들을 이 표에 그대로 풀어서 저장한다 — 즉 이 표엔 항상 leaf(액션) 키만 존재한다.
    """

    __tablename__ = "group_permissions"

    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("groups.id"), nullable=False)
    node_key = Column(Text, nullable=False)
    allowed = Column(Boolean, nullable=False, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("ix_group_permissions_group_id", "group_id"),
        UniqueConstraint("group_id", "node_key", name="uq_group_permissions_group_node"),
    )


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False)
    project_no = Column(Text, nullable=True)
    vendor = Column(Text, nullable=True)
    # 자료에 대해 자유롭게 적어두는 메모(화면 이름은 "Note"). MDB 관리의 자료명·정보 변경
    # 팝업에서 쓰고, 자료 상세보기에 그대로 보인다 (2026-08-28 CM 확정).
    note = Column(Text, nullable=True)
    is_hidden = Column(Boolean, nullable=False, server_default="false")  # D-6: 삭제 대신 목록에서만 숨김
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class HiddenVendor(Base):
    """업체는 마스터 테이블이 없는 자유 입력값이라 '삭제'할 행이 없다.
    드롭다운에서 안 보이게만 하는 숨김 목록(D-6: 실제 데이터는 지우지 않음)."""

    __tablename__ = "hidden_vendors"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False, unique=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True)
    doc_class = Column(Text, nullable=False)  # DRAWING / MDB_RECORD / SPEC / CALC / REPORT
    drawing_no = Column(Text, nullable=False)  # non-unique, parsing 금지
    title = Column(Text, nullable=False)
    category = Column(Text, nullable=True)
    discipline = Column(Text, nullable=True)
    doc_type = Column(Text, nullable=True)
    isbl_osbl = Column(Text, nullable=True)
    elevation = Column(Text, nullable=True)  # AG / UG / NULL (98.9% NULL)
    area = Column(Text, nullable=True)
    source_path = Column(Text, nullable=True)
    is_isometric = Column(Boolean, nullable=False, server_default="false")
    equipment_tag = Column(Text, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    current_rev = Column(Integer, nullable=False, server_default="0")
    status = Column(Text, nullable=False, server_default="ACTIVE")
    has_dwg = Column(Boolean, nullable=False, server_default="false")
    has_pdf = Column(Boolean, nullable=False, server_default="false")
    # 폴더·자료 편집(기존 수정과 무관한 CM 직접 편집) 화면의 삭제 = 보관(숨김). D-6: 실제 삭제 없음.
    is_archived = Column(Boolean, nullable=False, server_default="false")
    archive_batch_id = Column(Integer, ForeignKey("archive_batches.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    project = relationship("Project")

    __table_args__ = (
        Index("ix_documents_drawing_no", "drawing_no"),
        Index("ix_documents_discipline", "discipline"),
        Index("ix_documents_doc_type", "doc_type"),
        Index("ix_documents_is_isometric", "is_isometric"),
        Index("ix_documents_doc_class", "doc_class"),
        Index("ix_documents_is_archived", "is_archived"),
    )


class ArchiveBatch(Base):
    """폴더·자료 편집 화면의 보관함(휴지통) 1건 — 폴더 삭제(하위 전부) 또는 자료 1건 삭제.

    실제로 지우지 않고 documents.is_archived=true로만 숨기므로(D-6), 되살리기가 항상 가능하다.
    restored_at이 채워지면 되살려진 것 — 이 행 자체는 이력으로 계속 남는다(D-6, 삭제 없음).
    """

    __tablename__ = "archive_batches"

    id = Column(Integer, primary_key=True)
    kind = Column(Text, nullable=False)  # FOLDER / DOCUMENT
    label = Column(Text, nullable=False)  # 삭제 당시 폴더명 또는 자료명
    original_path = Column(Text, nullable=True)  # 삭제 당시 원래 위치(표시용)
    reason = Column(Text, nullable=True)  # 삭제 사유(선택 입력) — 보관함 화면에서 나중에도 고쳐 쓸 수 있다
    archived_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    archived_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    restored_at = Column(DateTime(timezone=True), nullable=True)


class FolderPlaceholder(Base):
    """자료가 하나도 없는 빈 폴더를 기억해두는 표시용 테이블.

    폴더는 실제로는 documents.source_path 값으로만 존재하는 가상 개념이라, 자료가 없는
    폴더는 아무 데도 남지 않는다. CM이 "폴더 추가"로 빈 폴더를 만들 때만 여기 기록해두고,
    자료가 하나라도 들어오면(문서의 source_path가 이 값과 같아지면) 더 이상 필요 없다.
    실제 자료를 담고 있지 않으므로 삭제해도 데이터 손실이 없다 — D-6 적용 대상 아님.
    """

    __tablename__ = "folder_placeholders"

    id = Column(Integer, primary_key=True)
    path = Column(Text, nullable=False, unique=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class File(Base):
    __tablename__ = "files"

    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    rev = Column(Integer, nullable=False)
    branch = Column(Text, nullable=True)  # 'a' / 'b' — 화면 표시는 "2-a"
    file_ext = Column(Text, nullable=False)  # dwg/pdf/xlsx/docx/pptx/hwp/...
    file_path = Column(Text, nullable=False)
    # 원본에서 이 파일이 들어있던 DWG/PDF 형제 폴더 이름(대소문자 원본 그대로). NULL이면 그런
    # 폴더 없이 자료 폴더에 바로 있었다는 뜻. 화면(트리·목록)에서는 이 조각을 숨기고 자료를
    # 한 건으로 보여주지만, 실제 저장 위치와 반출 폴더에는 그대로 재현한다 (2026-08-16 CM 확정).
    pairing_folder = Column(Text, nullable=True)
    original_filename = Column(Text, nullable=False)  # 업체가 보낸 실제 파일명(예: A_R5.dwg). 절대 안 바뀜.
    file_size = Column(BigInteger, nullable=False)
    sha256 = Column(Text, nullable=False)
    uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    vendor_name = Column(Text, nullable=True)  # "사내(자체 통합)" 포함
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    vendor_labeled_rev = Column(Text, nullable=True)
    rev_mismatch_warning = Column(Boolean, nullable=False, server_default="false")
    review_status = Column(Text, nullable=False)  # PENDING_REVIEW/APPROVED/REJECTED/MERGED
    review_note = Column(Text, nullable=True)
    uploaded_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    is_current = Column(Boolean, nullable=False, server_default="false")

    document = relationship("Document")

    __table_args__ = (
        Index("ix_files_document_id", "document_id"),
        Index("ix_files_document_id_is_current", "document_id", "is_current"),
    )


class Distribution(Base):
    __tablename__ = "distributions"

    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    rev_at_distribution = Column(Integer, nullable=False)
    vendor = Column(Text, nullable=False)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    purpose = Column(Text, nullable=False)  # MODIFY / REFERENCE / OTHER
    purpose_note = Column(Text, nullable=True)  # 반출 사유(선택 입력, 목적 종류와 무관)
    distributed_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    distributed_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    file_saved_path = Column(Text, nullable=False)
    returned_file_id = Column(Integer, ForeignKey("files.id"), nullable=True)
    returned_at = Column(DateTime(timezone=True), nullable=True)
    return_note = Column(Text, nullable=True)
    # 반출하기 직후 생성된 zip 파일명. 같은 반출 묶음(한 번의 반출하기)은 전부 같은 값을
    # 공유 — 반출이력 화면의 "Zip" 모드에서 이 값으로 묶어 zip 1개당 1행으로 보여준다.
    zip_filename = Column(Text, nullable=True)
    # 반출하기 팝업의 [폴더 경로 유지]를 켜둔 채 반출했는지(2026-08-28 CM 확정).
    # 수정용은 항상 true(화면에서 풀 수 없게 잠김), 참조용·기타만 false가 될 수 있다.
    # 화면에 보이는 칸은 아니고, 반출이력에서 같은 zip을 다시 받을 때 그때와 같은 모양으로
    # 내려주기 위해서만 쓴다. 예전 반출 기록은 전부 폴더 구조를 유지한 것이므로 기본값 true.
    keep_paths = Column(Boolean, nullable=False, server_default="true")

    document = relationship("Document")

    __table_args__ = (
        Index("ix_distributions_document_id", "document_id"),
        Index("ix_distributions_purpose_returned_at", "purpose", "returned_at"),
    )


class ImportIssue(Base):
    """대량 반입 zip에서 어느 문서인지 확정 못 한 파일의 임시 보관.

    document_id를 아직 모르니 정식 File 행을 못 만든다 — CM이 검수대기 화면에서
    직접 문서를 지정해 등록하거나(RESOLVED), 반려(DISCARDED)할 때까지 여기 담아둔다.
    정식 기록이 아니므로 반려해도 D-6(삭제 금지) 대상이 아니지만, 감사 추적을 위해
    행 자체는 남기고 status만 바꾼다.
    """

    __tablename__ = "import_issues"

    id = Column(Integer, primary_key=True)
    # 사유 코드(복수 가능, 쉼표 연결): FILENAME_MISMATCH / PATH_MISMATCH /
    # ORIGINAL_MISSING / PDF_MISSING / ALREADY_IMPORTED / NOT_DISTRIBUTED
    reason = Column(Text, nullable=False)
    zip_relative_path = Column(Text, nullable=False)   # 대표(첫) 파일의 zip 내 경로(표시용)
    original_filename = Column(Text, nullable=False)   # 대표(첫) 파일명
    stored_file_path = Column(Text, nullable=False)    # 대표(첫) 파일 저장 경로
    file_size = Column(BigInteger, nullable=False)
    sha256 = Column(Text, nullable=False)
    vendor_name = Column(Text, nullable=False)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    uploaded_at = Column(DateTime(timezone=True), nullable=False)
    status = Column(Text, nullable=False, server_default="PENDING")  # PENDING/RESOLVED/DISCARDED
    # 이 항목이 어느 반출 도면 것으로 추정되는지. '반출 대상 아님'이면 NULL.
    intended_document_id = Column(Integer, ForeignKey("documents.id"), nullable=True)
    # 상세 설명용 구조 데이터 {"text": 사람이 읽을 문장, "expected_path":..., ...}
    detail = Column(JSONB, nullable=True)
    # 한 항목이 여러 파일(원본+PDF)을 가질 수 있어 파일 목록을 통째로 저장.
    # [{"original_filename":..., "stored_file_path":..., "file_ext":..., "file_size":..., "sha256":...}]
    files = Column(JSONB, nullable=True)
    resolved_document_id = Column(Integer, ForeignKey("documents.id"), nullable=True)
    resolved_rev = Column(Integer, nullable=True)
    resolved_branch = Column(Text, nullable=True)
    resolve_note = Column(Text, nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)


class EquipmentType(Base):
    """MDB 자료의 설비유형 마스터 목록(Pump/Valve/Tank/...). projects와 같은 패턴 —
    자유 입력이 아니라 여기 등록된 값만 드롭다운에서 고를 수 있고, 이름 변경·숨기기만
    가능하다(D-6: 실제 삭제 없음 — 단 이 표는 D-31 예외로 완전삭제도 허용).
    mdb_files.equipment_type은 여전히 문자열 컬럼이라, 이름을 바꾸면 그 이름이 이미 쓰인
    자료들도 화면에서 자동으로 같이 바뀐다."""

    __tablename__ = "equipment_types"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False, unique=True)
    is_hidden = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MdbDocType(Base):
    """MDB 자료의 자료유형 마스터 목록(Data Sheet/Manual/Test Report/...).
    위 EquipmentType과 성격·규칙이 완전히 같은 "고를 수 있는 값 목록"이고, 화면도 같은
    모양(드롭다운 + 옆의 ✎ 목록 편집 팝업)을 쓴다 — 두 목록의 API는 routers/type_lists.py
    한 곳에서 같은 코드로 만든다 (2026-08-28 CM 확정).

    mdb_files.doc_type도 문자열 컬럼이라, 이름을 바꾸면 이미 이 유형으로 지정된 자료의
    표시도 함께 바뀐다."""

    __tablename__ = "mdb_doc_types"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False, unique=True)
    is_hidden = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MdbTagChangeReason(Base):
    """Tag No 이력관리에서 Note 문구에 넣을 "사유"를 고르는 목록 (2026-08-30 CM 확정).

    설비유형·자료유형과 성격이 같은 "고를 수 있는 값 목록"이라 서버 코드도 같은 자리
    (routers/type_lists.py)에서 같은 방식으로 만든다. 사유를 자유 입력으로 두면 같은 뜻을
    사람마다 다르게 적어 Note가 제각각이 되므로, 여기 등록된 문구 중에서 고르게 한다.

    이름을 바꿔도 **이미 자료 Note에 적혀 나간 문장은 그대로 둔다** — 그 문장은 "그때 그렇게
    기록했다"는 이력 자체라 나중에 손대면 안 된다(설비유형·자료유형과 다른 점).
    """

    __tablename__ = "mdb_tag_change_reasons"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False, unique=True)
    is_hidden = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MdbFile(Base):
    """메카니컬 데이터북(MDB) 자료를 이루는 파일 1개. 도면(documents/files)과는 별개 체계 —
    리비전 개념이 없고, 태그(설비번호)를 여러 개 매달 수 있는 사진 태그 방식이다(MdbFileTag).

    **자료 1건 = 같은 폴더 + 같은 자료명(확장자를 뗀 이름)을 가진 행들** (2026-08-17 CM 확정).
    원본(xls/dwg/…)과 PDF 사본이 이 표에서는 행 2개지만 화면에서는 자료 1건으로 보인다.
    TDB의 documents-files 관계에 해당하는 묶음이지만, MDB는 부모 표를 따로 두지 않고
    경로와 이름만으로 묶는다 — 이미 그 이름으로 파일이 저장돼 있어서 따로 기억할 값이 없고,
    묶음을 따로 저장하면 파일이 옮겨질 때마다 같이 고쳐줘야 해서 어긋날 위험만 생긴다.
    묶는 규칙은 app/mdb_group.py 한 곳에만 있다.

    category는 저장하지 않고 태그 존재 여부로 그때그때 판단한다(전용=태그 있음,
    공용=태그는 없지만 equipment_type은 있음, 확인필요=둘 다 없음) — 컬럼으로 따로 들고 있으면
    태그를 편집할 때마다 같이 갱신해줘야 해서 어긋날 위험이 있다.
    """

    __tablename__ = "mdb_files"

    id = Column(Integer, primary_key=True)
    storage_path = Column(Text, nullable=False)  # STORAGE_ROOT 기준 상대경로 (백업 사본 위치)
    source_path = Column(Text, nullable=False)  # 원본 MDB 폴더 기준 상대경로 (폴더 구조 표시용)
    # 원본에서 이 파일이 들어있던 DWG/PDF 형제 폴더 이름(2026-08-18 이전 자료는 'CAD'). NULL이면
    # 그런 폴더 없이 자료 폴더에 바로 있었다는 뜻. source_path에서는 이 조각을 빼두어야
    # 원본과 사본의 "폴더 + 자료명"이 같아져 한 자료로 묶인다. 화면에서는 숨기고 실제
    # 저장 위치(storage.mdb_file_path)와 다운로드 zip에만 재현한다. files.pairing_folder와 같다.
    pairing_folder = Column(Text, nullable=True)
    original_filename = Column(Text, nullable=False)
    file_ext = Column(Text, nullable=False)
    file_size = Column(BigInteger, nullable=False)
    sha256 = Column(Text, nullable=False)
    is_pdf = Column(Boolean, nullable=False, server_default="false")  # 사본 여부(원본/사본 표시)
    # 설비유형·자료유형은 자료 1건에 여러 개를 붙일 수 있고, 슬래시로 이어 붙인 문자열
    # 하나로 저장한다(예: "Pump/Strainer"). 다루는 규칙은 app/mdb_types.py 한 곳에만 있다.
    equipment_type = Column(Text, nullable=True)  # Pump/Valve/Tank/... (공용자료 매칭 기준)
    doc_type = Column(Text, nullable=True)  # 자료유형 — Data Sheet/Manual/... (2026-08-28 추가)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    year = Column(Integer, nullable=True)  # 공사연도 (검색 결과를 연도순으로 묶어 보여줄 때 씀)
    note = Column(Text, nullable=True)
    # MDB 편집 화면(폴더·자료 편집과 동일한 기능)의 삭제 = 보관(숨김). D-6: 실제 삭제 없음.
    is_archived = Column(Boolean, nullable=False, server_default="false")
    archive_batch_id = Column(Integer, ForeignKey("archive_batches.id"), nullable=True)
    uploaded_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    project = relationship("Project")

    __table_args__ = (
        Index("ix_mdb_files_equipment_type", "equipment_type"),
        Index("ix_mdb_files_doc_type", "doc_type"),
        Index("ix_mdb_files_project_id", "project_id"),
        Index("ix_mdb_files_is_archived", "is_archived"),
    )


class MdbFileTag(Base):
    """MdbFile 하나에 태그(설비번호) 여러 개 — 사진 여러 명 태그하는 것과 같은 다대다 관계.

    한 문서(P&ID 등)에 태그가 10개 있으면 이 표에 행이 10개 생기고, 그중 어느 태그로
    검색해도 이 문서가 '전용 자료'로 뜬다.
    """

    __tablename__ = "mdb_file_tags"

    id = Column(Integer, primary_key=True)
    mdb_file_id = Column(Integer, ForeignKey("mdb_files.id"), nullable=False)
    tag_no = Column(Text, nullable=False)

    __table_args__ = (
        Index("ix_mdb_file_tags_file_id", "mdb_file_id"),
        Index("ix_mdb_file_tags_tag_no", "tag_no"),
    )


class MdbTagHistory(Base):
    """Tag No 변경이력 1건 — "이 Tag No가 붙은 자료 전부"에 같은 처리를 한 번에 하는 기록
    (2026-08-30 CM 확정).

    설비 Tag No가 현장에서 바뀌면(P1000A → P1700A) 그 설비 자료 수십 건에 새 Tag No를 함께
    달아두고, 나중에 보는 사람이 "왜 Tag No가 두 개지?" 하고 의아해하지 않도록 왜 바뀌었는지를
    Note에 남겨야 한다. 자료를 하나씩 찾아 고치는 것은 사실상 불가능해서, 여기 한 줄을
    등록하면 대상 자료 전부에 같은 처리가 한 번에 들어간다.

    Note는 덮어쓰지 않고 **한 줄씩 쌓인다** — 한 자료에 이력이 여러 번 적용되면 그 자료의
    Note가 곧 그 설비의 변경 내력이 된다(2026-08-30 CM 확정).

    적용(apply)과 되돌리기(revert)가 정확히 짝이 되도록, 실제로 손댄 파일과 무엇을 바꿨는지를
    applied_changes에 그대로 적어둔다 — 원래부터 그 Tag No를 갖고 있던 자료의 값을 되돌리기가
    잘못 빼앗아 가는 일이 없게 하기 위함이다.

    이력 자체는 지우지 않는다(D-6) — 되돌린 것은 reverted_at이 채워져 "취소됨"으로 남는다.
    """

    __tablename__ = "mdb_tag_histories"

    id = Column(Integer, primary_key=True)
    # 대상 Tag No — 이 값이 붙은 자료를 찾아 처리한다(찾을 때 대소문자는 가리지 않는다).
    base_tag = Column(Text, nullable=False)
    # ADD(새 Tag No를 함께 달기) / REMOVE(대상 Tag No 빼기) / RENAME(대상 → 새 Tag No로 바꾸기) /
    # NOTE_ONLY(Tag No는 그대로 두고 Note 문구만 남기기)
    action = Column(Text, nullable=False)
    new_tag = Column(Text, nullable=True)
    # 적용 범위를 한 공사로 좁혔을 때만 값이 있다(비어 있으면 공사 구분 없이 전부).
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    # --- Note 문구를 이루는 조각들. 이것들을 밑줄로 이어 붙인 완성 문장이 note_line이고,
    #     자료 Note에는 그 한 줄이 붙는다. 비어 있으면 Note에 아무것도 쓰지 않는다.
    note_label = Column(Text, nullable=True)    # 구분 ("Tag No 변경"/"Tag No 추가"/"Tag No 삭제")
    note_year = Column(Text, nullable=True)     # 연도·날짜 (자유 입력)
    note_project = Column(Text, nullable=True)  # 공사명 (자유 입력)
    note_reason = Column(Text, nullable=True)   # 사유 (mdb_tag_change_reasons 목록에서 고름)
    note_memo = Column(Text, nullable=True)     # 비고 (자유 입력)
    note_line = Column(Text, nullable=True)     # 완성 문장 — 자료 Note에 실제로 들어간 한 줄
    # 앞으로 이 Tag No가 새로 붙는 자료에도 시스템이 알아서 같은 처리를 넣을지 (2026-09-01 CM 확정).
    # 이력은 등록하는 그때 있던 자료에만 들어가는데, 나중에 어떤 자료에 그 Tag No를 달면 같은
    # 처리를 또 손으로 해야 했다. 이 값이 켜져 있으면 자료를 저장하는 그 자리에서 자동으로 들어간다
    # (mdb_editor.py의 "자료명·정보 변경"이 apply_auto_rules를 부른다). 새 이력은 켜짐이 기본이고,
    # 되돌린(취소됨) 이력은 켜져 있어도 발동하지 않는다.
    auto_apply = Column(Boolean, nullable=False, server_default="true")
    # 마지막 적용에서 실제로 손댄 파일과 바꾼 내용:
    #   [{"id": 파일id, "tag_changed": true/false, "note_added": true/false}, ...]
    applied_changes = Column(JSONB, nullable=True)
    applied_doc_count = Column(Integer, nullable=False, server_default="0")
    applied_at = Column(DateTime(timezone=True), nullable=True)
    applied_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    reverted_at = Column(DateTime(timezone=True), nullable=True)
    reverted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    project = relationship("Project")

    __table_args__ = (
        Index("ix_mdb_tag_histories_base_tag", "base_tag"),
    )


class MdbFolderPlaceholder(Base):
    """MDB 편집 화면에서 자료가 하나도 없는 빈 폴더를 기억해두는 표시용 테이블.
    documents용 FolderPlaceholder와 같은 역할이지만, MDB 폴더 경로와 섞이지 않도록 따로 둔다."""

    __tablename__ = "mdb_folder_placeholders"

    id = Column(Integer, primary_key=True)
    path = Column(Text, nullable=False, unique=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    action = Column(Text, nullable=False)
    # 어느 화면(나브바 메뉴)에서 일어난 일인지. "EXPORT"/"DOWNLOAD"처럼 같은 action이 여러 화면에서
    # 재사용되므로 action 이름만으로는 화면을 알 수 없어, 기록 시점에 호출부가 직접 채워 넣는다.
    screen = Column(Text, nullable=True)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=True)
    detail = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("ix_audit_log_screen", "screen"),
    )
class UserFavorite(Base):
    """저장 목록 — 사용자 한 사람이 미리보기에서 저장해 둔 자료 1건 (2026-09-05 CM 지시).

    자료 자체와는 아무 상관이 없는 **개인 바로가기**다. 담아도 자료는 변하지 않고, 지워도
    자료·이력은 그대로 남는다. 그래서 이 표만은 본인이 지울 수 있다(D-6의 "삭제 기능 없음"은
    자료를 지키기 위한 원칙이라 여기엔 해당하지 않는다 — 설비유형 목록처럼 "본인이 만들고
    지우는 목록"이다). 지우는 것은 언제나 자기 것뿐이다.

    미리보기에서 그린 표시(도형·문구·형광펜·도장)를 함께 담아 두면 나중에 그 자리에서
    이어서 그릴 수 있다. 표시는 PDF를 통째로 복사해 두는 것이 아니라 **그린 내용만**
    JSON으로 뽑아 파일로 남긴다(markup_path) — 6.5GB짜리 자료를 사람마다 50벌씩 복사해 두면
    디스크가 남아나지 않기 때문이고, 그렇게 남긴 표시는 다시 열 때 그리기 상태 그대로 되살아나
    옮기고 지우고 색을 바꾸는 것까지 그대로 된다(PDF 사본이면 그냥 그림으로만 남는다).
    """

    __tablename__ = "user_favorites"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    # TDB(도면) 자료냐 MDB 자료냐 — 어느 표를 가리키는지 정한다.
    kind = Column(Text, nullable=False)  # TDB / MDB
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=True)
    mdb_file_id = Column(Integer, ForeignKey("mdb_files.id"), nullable=True)
    # 저장 이름. [저장하기]로 저장하면 자료명 그대로이고(편집 내용이 있으면 뒤에 "(Markup)"),
    # [다른 이름으로 저장]으로 저장하면 사용자가 적은 이름이다.
    # 자료명이 나중에 바뀌어도 저장할 때의 이름을 그대로 두어, 목록에서 무엇을 저장했는지
    # 알아볼 수 있게 한다(이름이 저 혼자 바뀌면 설명과 어긋난다).
    name = Column(Text, nullable=False)
    # 저장할 때의 **자료명**. 위 name과 따로 두는 것은 name이 "(Markup)"이 붙거나 사용자가
    # 직접 적은 이름일 수 있어, 그것만으로는 자료명이 바뀌었는지 알 수 없기 때문이다.
    # 목록의 `상태` 칸이 이 값과 지금 자료명을 견주어 "이름 바뀜"을 알려준다.
    source_name = Column(Text, nullable=True)
    description = Column(Text, nullable=True)  # 담으면서 적어 두는 설명글
    has_markup = Column(Boolean, nullable=False, server_default="false")
    # 그린 편집 내용을 담아 둔 파일(STORAGE_ROOT 기준 상대경로, storage/즐겨찾기/{user_id}/{id}.json —
    # 폴더 이름은 화면 문구가 바뀐 뒤에도 그대로 둔다, storage.py 참고).
    # 파일 자체를 DB에 넣지 않는다는 이 프로젝트 규칙(2절)을 그대로 따른다.
    markup_path = Column(Text, nullable=True)
    # 표시를 그릴 때 보고 있던 PDF 파일. 리비전이 올라가 PDF가 바뀌면 그 표시가 다른 자리에
    # 찍히므로, 다시 열 때 이 값이 지금 PDF와 다르면 화면에서 알려준다.
    pdf_file_id = Column(Integer, nullable=True)
    # 보관할 때 보던 쪽 — "original"이면 원본(DWG·엑셀 등) 미리보기, 비어 있으면 사본(PDF).
    # 다시 열 때 그쪽으로 연다(D-102 ⑦). 편집 내용은 어느 쪽에서 보관했든 사본에 그린 것이다.
    view_mode = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_user_favorites_user_id", "user_id"),
    )


class BackupRun(Base):
    """백업을 한 번 만들 때마다 생기는 기록 한 줄 (2026-09-29 CM 지시, D-105).

    묶음 파일 하나가 한 줄이다(한 번에 5종을 만들면 5줄이 생기고, set_key가 같다).
    CM이 "다운이력도 잘 관리해야할듯"이라고 한 그 표다 — 변경분은 앞 회차가 있어야 완전하므로
    무엇을 언제 만들었고 받았는지가 남아 있어야 한다.

    **이 줄(이력)을 지우는 기능은 없다**(원칙 1) — 어느 회차를 만들고 받았는지가 변경분을
    이어 붙이는 근거이기 때문이다. 대신 2026-09-29 CM 지시로 **묶음 파일만 지우는** 기능이
    있다(D-107): 한 번 받아 둔 묶음이 서버 용량을 계속 차지하므로, 줄은 그대로 두고 파일만
    지워 `file_deleted_at`에 적는다. 탐색기에서 지운 것과 구분해 화면에 보여주기 위함이다.
    """

    __tablename__ = "backup_runs"

    id = Column(Integer, primary_key=True)
    # TDB / MDB / DB / CODE / EXTERNAL (app/backup.py의 KIND_*)
    kind = Column(Text, nullable=False)
    # FULL(전체) / DELTA(변경분). 변경분은 파일이 있는 TDB·MDB만 만들 수 있다.
    scope = Column(Text, nullable=False)
    # 분류별로 1부터 이어지는 회차. 변경분을 빼먹은 회차가 있는지 화면이 이 번호로 확인한다.
    seq = Column(Integer, nullable=False)
    # 변경분이 어느 회차를 기준으로 만들어졌는지
    base_run_id = Column(Integer, ForeignKey("backup_runs.id"), nullable=True)
    # 한 번에 함께 만든 묶음끼리 묶는 값(만든 시각 문자열). DB와 도면의 시점이 같은지 이것으로 본다.
    set_key = Column(Text, nullable=False)
    filename = Column(Text, nullable=False)
    # 그 묶음을 실제로 만든 폴더. 저장 위치를 외장하드로 바꿔 만든 뒤에도 예전 묶음을 찾을 수
    # 있도록 줄마다 적어 둔다(전부 .env의 기본 위치로 찾으면 못 찾는다).
    dest_dir = Column(Text, nullable=True)
    # ZIP(내려받을 수 있는 묶음 파일) / FOLDER(압축 없이 폴더째 복사 — 탐색기로 가져간다)
    delivery = Column(Text, nullable=False)
    file_size = Column(BigInteger, nullable=False, server_default="0")   # 만들어진 묶음 크기
    source_bytes = Column(BigInteger, nullable=False, server_default="0")  # 담은 원본 파일 합계
    file_count = Column(Integer, nullable=False, server_default="0")
    removed_count = Column(Integer, nullable=False, server_default="0")  # 지난 회차 뒤 없어진 파일 수
    # 그 시점 파일 목록표(STORAGE_ROOT 기준 상대경로). 다음 변경분을 계산할 때 쓴다.
    manifest_path = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # 마지막으로 내려받은 시각과 받은 횟수(여러 사람이 각각 받을 수 있다)
    downloaded_at = Column(DateTime(timezone=True), nullable=True)
    download_count = Column(Integer, nullable=False, server_default="0")
    # 묶음 파일을 화면 [파일 삭제]로 지운 시각·지운 사람 (2026-09-29 CM 지시, D-107).
    # 값이 있으면 화면 상태 칸이 "삭제됨"이고, 값이 없는데 파일도 없으면 "없음"이다
    # (탐색기에서 지웠거나 옮긴 것 — 둘을 구분해 보여 달라는 것이 CM 지시였다).
    file_deleted_at = Column(DateTime(timezone=True), nullable=True)
    file_deleted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    note = Column(Text, nullable=True)  # 화면 표의 비고 칸

    __table_args__ = (
        Index("ix_backup_runs_kind_seq", "kind", "seq"),
        Index("ix_backup_runs_set_key", "set_key"),
    )
