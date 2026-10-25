-- 0003. 폴더 트리와 분류 목록
--
-- 기존 시스템은 폴더가 테이블이 아니라 documents.source_path 문자열이었다.
-- 폴더 이름 하나를 바꾸면 수천 row UPDATE + 실제 디스크 이동이 함께 일어났다.
--
-- 여기서는 폴더를 1급 테이블로 만들고, ltree path 의 라벨에 **폴더 id** 를 쓴다
-- (ltree 는 [A-Za-z0-9_] 만 허용하므로 한글 이름을 담을 수 없고,
--  id 를 쓰면 이름을 바꿔도 path 가 그대로라 하위 갱신조차 필요 없다).

CREATE TABLE folders (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id      bigint      REFERENCES folders(id) ON DELETE RESTRICT,
  doc_class      text        NOT NULL CHECK (doc_class IN ('TDB','MDB')),
  name           text        NOT NULL,
  path           ltree       NOT NULL,                       -- '1.14.57' (id 라벨)
  depth          smallint    GENERATED ALWAYS AS (nlevel(path)) STORED,
  doc_count      integer     NOT NULL DEFAULT 0,             -- 트리 배지. 트리거로 유지
  is_placeholder boolean     NOT NULL DEFAULT false,         -- 자료 없는 빈 폴더
  is_archived    boolean     NOT NULL DEFAULT false,
  sort_key       text,                                        -- 원본 폴더 정렬 유지용
  created_by     bigint      REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, name)
);
CREATE INDEX ix_folders_path   ON folders USING gist (path);
CREATE INDEX ix_folders_parent ON folders (parent_id, name);
CREATE INDEX ix_folders_class  ON folders (doc_class) WHERE NOT is_archived;

COMMENT ON COLUMN folders.path IS
  'ltree 라벨은 폴더 id. 이름 변경은 name 만 바꾸므로 path 갱신이 필요 없다.';

-- 공사
CREATE TABLE projects (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  is_hidden  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_projects_name_ci ON projects (lower(name));

-- 업체
CREATE TABLE vendors (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  is_hidden  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_vendors_name_ci ON vendors (lower(name));

-- 설비유형 / MDB 자료유형 / Tag 변경사유 — 기존 type_lists 팩토리 3벌에 대응
CREATE TABLE equipment_types (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  is_hidden  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_equipment_types_name_ci ON equipment_types (lower(name));

CREATE TABLE mdb_doc_types (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  is_hidden  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_mdb_doc_types_name_ci ON mdb_doc_types (lower(name));

CREATE TABLE mdb_tag_change_reasons (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  is_hidden  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_mdb_reasons_name_ci ON mdb_tag_change_reasons (lower(name));
