-- 0004. 저장소(blob)와 TDB(도면)
--
-- 기존 시스템은 DB 경로가 곧 디스크 경로였고 파일명이 리비전을 들고 있었다
-- (최신/{원본경로}/{도면번호}_Rev00.pdf). 승인 1건마다 디스크 rename 이 돌았다.
--
-- 여기서는 내용(sha256)으로 주소를 삼고, 사람이 읽는 이름은 다운로드 시점에 만든다.
-- '최신' 폴더는 야간 하드링크 미러로 재구성한다.

CREATE TABLE blobs (
  sha256    bytea       PRIMARY KEY,        -- 32바이트. text(64자)보다 인덱스가 절반
  byte_size bigint      NOT NULL,
  refcount  integer     NOT NULL DEFAULT 0,
  stored_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_blobs_orphan ON blobs (stored_at) WHERE refcount = 0;

COMMENT ON TABLE blobs IS
  '디스크 경로는 /srv/tdms/blobs/{hex[0:2]}/{hex[2:4]}/{hex}. refcount 0 은 야간 GC 가 수거한다(즉시 삭제하지 않는다).';

-- 보관함 묶음 (삭제 보관함 / 폐기 보관함 한 건씩을 묶어 되살릴 수 있게 한다)
CREATE TABLE archive_batches (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text        NOT NULL CHECK (kind IN ('TRASH','RETIRE')),
  doc_class  text        NOT NULL CHECK (doc_class IN ('TDB','MDB')),
  reason     text,
  note       text,
  item_count integer     NOT NULL DEFAULT 0,
  created_by bigint      REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  restored_by bigint     REFERENCES users(id)
);
CREATE INDEX ix_archive_batches_kind ON archive_batches (doc_class, kind, created_at DESC);

CREATE TABLE documents (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_class      text        NOT NULL DEFAULT 'TDB' CHECK (doc_class = 'TDB'),
  folder_id      bigint      NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
  drawing_no     text        NOT NULL,
  title          text        NOT NULL,
  category       text,
  discipline     text,                        -- 공종
  doc_type       text,                        -- 도면종류 (P&ID, PFD, Isometric ...)
  isbl_osbl      text,
  elevation      text,                        -- 지상/지하
  area           text,                        -- 구역
  equipment_tag  text,                        -- Ocean-H 연동 여지 확보용
  project_id     bigint      REFERENCES projects(id),
  is_isometric   boolean     NOT NULL DEFAULT false,
  current_rev    integer     NOT NULL DEFAULT 0,
  status         text        NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','PENDING','SUPERSEDED','MERGE_REQUIRED','RETIRED')),
  has_dwg        boolean     NOT NULL DEFAULT false,
  has_pdf        boolean     NOT NULL DEFAULT false,
  has_xlsx       boolean     NOT NULL DEFAULT false,
  has_etc        boolean     NOT NULL DEFAULT false,
  pairing_folder text,                        -- 원본/사본이 DWG·PDF 폴더로 갈려 있던 경우
  note           text,
  is_archived      boolean   NOT NULL DEFAULT false,
  archive_batch_id bigint    REFERENCES archive_batches(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- 검색 전용 생성 컬럼 — trgm GIN 이 타는 대상
  search_text text GENERATED ALWAYS AS
    (drawing_no || ' ' || title || ' ' || coalesce(equipment_tag, '')) STORED
);

-- 가장 흔한 탐색 경로 전용 (전체의 63%인 Isometric 제외)
CREATE INDEX ix_documents_browse ON documents (folder_id, updated_at DESC, id DESC)
  WHERE status = 'ACTIVE' AND NOT is_archived AND NOT is_isometric;
-- Isometric 탭
CREATE INDEX ix_documents_browse_iso ON documents (folder_id, updated_at DESC, id DESC)
  WHERE status = 'ACTIVE' AND NOT is_archived AND is_isometric;
-- 부분일치 검색
CREATE INDEX ix_documents_search ON documents USING gin (search_text gin_trgm_ops);
-- 단건 조회·중복 검사
CREATE INDEX ix_documents_drawing_no ON documents (drawing_no);
CREATE INDEX ix_documents_folder     ON documents (folder_id);
CREATE INDEX ix_documents_archived   ON documents (archive_batch_id) WHERE is_archived;
CREATE INDEX ix_documents_status     ON documents (status) WHERE status <> 'ACTIVE';

COMMENT ON COLUMN documents.status IS
  'MERGE_REQUIRED = A·B 업체 분기 Rev 가 있어 사람이 CAD 로 통합해야 하는 상태. 시스템은 자동 병합하지 않는다.';

-- 리비전 묶음 (한 번의 승인으로 함께 올라간 파일들)
CREATE TABLE revision_sets (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rev         integer     NOT NULL,
  branch      text,                        -- 분기 리비전 'a','b'
  reason      text,
  note        text,
  created_by  bigint      REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, rev, branch)
);

CREATE TABLE files (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id          bigint      NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  revision_set_id      bigint      REFERENCES revision_sets(id),
  blob_sha256          bytea       NOT NULL REFERENCES blobs(sha256),
  rev                  integer     NOT NULL,
  branch               text,
  file_ext             text        NOT NULL,
  display_name         text        NOT NULL,   -- 사람이 보는 이름. 규칙이 바뀌어도 파일은 그대로
  original_filename    text        NOT NULL,
  review_status        text        NOT NULL DEFAULT 'APPROVED'
                         CHECK (review_status IN ('PENDING','APPROVED','REJECTED','ISSUE')),
  review_note          text,
  is_current           boolean     NOT NULL DEFAULT false,
  vendor_id            bigint      REFERENCES vendors(id),
  project_id           bigint      REFERENCES projects(id),
  vendor_labeled_rev   text,
  rev_mismatch_warning boolean     NOT NULL DEFAULT false,
  note                 text,
  uploaded_by          bigint      REFERENCES users(id),
  uploaded_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_files_current  ON files (document_id) WHERE is_current;
CREATE INDEX ix_files_document        ON files (document_id, rev DESC);
CREATE INDEX ix_files_blob            ON files (blob_sha256);
CREATE INDEX ix_files_pending         ON files (uploaded_at DESC) WHERE review_status = 'PENDING';

-- 반출
CREATE TABLE distributions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id         bigint      NOT NULL REFERENCES documents(id),
  rev_at_distribution integer     NOT NULL,
  vendor_id           bigint      REFERENCES vendors(id),
  vendor_name         text        NOT NULL,     -- 당시 이름 보존 (업체명이 바뀌어도 기록은 그대로)
  project_id          bigint      REFERENCES projects(id),
  purpose             text        NOT NULL CHECK (purpose IN ('MODIFY','REFERENCE','ETC')),
  purpose_note        text,
  zip_name            text,                     -- Zip 단위 반출 묶음 이름
  keep_paths          boolean     NOT NULL DEFAULT true,
  blob_sha256         bytea       REFERENCES blobs(sha256),   -- 반출한 사본
  distributed_by      bigint      REFERENCES users(id),
  distributed_at      timestamptz NOT NULL DEFAULT now(),
  returned_file_id    bigint      REFERENCES files(id),
  returned_at         timestamptz,
  return_note         text,
  manual_return       boolean     NOT NULL DEFAULT false,     -- '수정없이 반납처리'
  note                text
);
CREATE INDEX ix_dist_document    ON distributions (document_id, distributed_at DESC);
CREATE INDEX ix_dist_outstanding ON distributions (distributed_at) WHERE returned_at IS NULL;
CREATE INDEX ix_dist_zip         ON distributions (zip_name) WHERE zip_name IS NOT NULL;
CREATE INDEX ix_dist_vendor      ON distributions (vendor_id, distributed_at DESC);

COMMENT ON INDEX ix_dist_outstanding IS '미입고 현황 화면 전용. 배포일 오래된 순 정렬까지 인덱스로 끝난다.';

-- 반입 확인 필요 (경로 불명, 자료 누락 등)
CREATE TABLE import_issues (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  bigint      REFERENCES documents(id),
  blob_sha256  bytea       REFERENCES blobs(sha256),
  filename     text        NOT NULL,
  reason       text        NOT NULL,
  reason_detail text,
  state        text        NOT NULL DEFAULT 'OPEN'
                 CHECK (state IN ('OPEN','RESOLVED','DISCARDED')),
  vendor_id    bigint      REFERENCES vendors(id),
  project_id   bigint      REFERENCES projects(id),
  created_by   bigint      REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  bigint      REFERENCES users(id)
);
CREATE INDEX ix_import_issues_open ON import_issues (created_at DESC) WHERE state = 'OPEN';

-- 사용자 마크업 보관 (기존: 즐겨찾기/ 폴더의 JSON 파일 → DB 로 이동)
CREATE TABLE user_favorites (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_class    text        NOT NULL CHECK (doc_class IN ('TDB','MDB')),
  document_id  bigint      REFERENCES documents(id) ON DELETE CASCADE,
  mdb_file_id  bigint,
  name         text        NOT NULL,
  note         text,
  markup       jsonb       NOT NULL,       -- dms-favorite.js 가 수집한 편집 내용
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_favorites_user ON user_favorites (user_id, updated_at DESC);

COMMENT ON COLUMN user_favorites.markup IS
  'PDF 뷰어(dms-favorite.js)의 window.dmsMarkup.collect() 결과. 파일이 아니라 DB 에 두어 검색·공유·권한이 따라오게 했다.';
