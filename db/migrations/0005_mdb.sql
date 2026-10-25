-- 0005. MDB (설비 데이터북)
--
-- TDB 와 테이블을 공유하지 않는다. MDB 는 리비전·반출·검수가 없는 고정 기록이라
-- 같은 테이블에 묶으면 양쪽 쿼리가 모두 복잡해진다 (기존 시스템의 문제점).

CREATE TABLE mdb_files (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folder_id        bigint      NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
  blob_sha256      bytea       NOT NULL REFERENCES blobs(sha256),
  title            text        NOT NULL,
  display_name     text        NOT NULL,
  original_filename text       NOT NULL,
  file_ext         text        NOT NULL,
  equipment_type   text,                          -- 설비유형
  doc_type         text,                          -- 자료유형
  project_id       bigint      REFERENCES projects(id),
  year             smallint,
  is_shared        boolean     NOT NULL DEFAULT false,   -- 공용 / 전용
  pairing_folder   text,
  note             text,
  needs_check      boolean     NOT NULL DEFAULT false,   -- '확인필요'
  is_archived      boolean     NOT NULL DEFAULT false,
  archive_batch_id bigint      REFERENCES archive_batches(id),
  uploaded_by      bigint      REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  search_text text GENERATED ALWAYS AS
    (title || ' ' || coalesce(equipment_type,'') || ' ' || coalesce(doc_type,'')) STORED
);
CREATE INDEX ix_mdb_files_browse ON mdb_files (folder_id, updated_at DESC, id DESC)
  WHERE NOT is_archived;
CREATE INDEX ix_mdb_files_search ON mdb_files USING gin (search_text gin_trgm_ops);
CREATE INDEX ix_mdb_files_equip  ON mdb_files (equipment_type) WHERE NOT is_archived;
CREATE INDEX ix_mdb_files_type   ON mdb_files (doc_type)       WHERE NOT is_archived;
CREATE INDEX ix_mdb_files_project ON mdb_files (project_id);
CREATE INDEX ix_mdb_files_blob   ON mdb_files (blob_sha256);

-- 자료에 붙은 Tag No
CREATE TABLE mdb_file_tags (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mdb_file_id bigint NOT NULL REFERENCES mdb_files(id) ON DELETE CASCADE,
  tag_no      text   NOT NULL,
  UNIQUE (mdb_file_id, tag_no)
);
CREATE INDEX ix_mdb_file_tags_file ON mdb_file_tags (mdb_file_id);
CREATE INDEX ix_mdb_file_tags_tag  ON mdb_file_tags (tag_no);
-- Tag No 자동완성
CREATE INDEX ix_mdb_file_tags_trgm ON mdb_file_tags USING gin (tag_no gin_trgm_ops);

-- Tag 변경 이력 (적용 / 되돌리기 가능)
CREATE TABLE mdb_tag_histories (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  base_tag      text        NOT NULL,
  old_tag       text,
  new_tag       text,
  reason        text,
  reason_detail text,
  project_id    bigint      REFERENCES projects(id),
  folder_id     bigint      REFERENCES folders(id),
  state         text        NOT NULL DEFAULT 'DRAFT'
                  CHECK (state IN ('DRAFT','APPLIED','REVERTED')),
  applied_count integer     NOT NULL DEFAULT 0,
  created_by    bigint      REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  reverted_at   timestamptz
);
CREATE INDEX ix_mdb_tag_hist_base  ON mdb_tag_histories (base_tag);
CREATE INDEX ix_mdb_tag_hist_state ON mdb_tag_histories (state, created_at DESC);

-- 되돌리기를 위해 어떤 자료의 어떤 태그를 바꿨는지 남긴다
CREATE TABLE mdb_tag_history_items (
  history_id  bigint NOT NULL REFERENCES mdb_tag_histories(id) ON DELETE CASCADE,
  mdb_file_id bigint NOT NULL REFERENCES mdb_files(id) ON DELETE CASCADE,
  old_tag     text,
  new_tag     text,
  PRIMARY KEY (history_id, mdb_file_id)
);

ALTER TABLE user_favorites
  ADD CONSTRAINT fk_favorites_mdb_file
  FOREIGN KEY (mdb_file_id) REFERENCES mdb_files(id) ON DELETE CASCADE;
