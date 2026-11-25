-- 0029. 반출대기함 사용자별 폴더 관리 및 자료 보관
--
-- 반출대기함의 자료를 사용자별 폴더로 분류·보관하고,
-- 폴더 간 편리한 이동 및 폴더 생성·수정·삭제를 지원한다.

CREATE TABLE IF NOT EXISTS user_cart_folders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   bigint REFERENCES user_cart_folders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_user_cart_folder_name CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS ix_user_cart_folders_user ON user_cart_folders (user_id);
CREATE INDEX IF NOT EXISTS ix_user_cart_folders_parent ON user_cart_folders (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_user_cart_folders_root_name
  ON user_cart_folders (user_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ix_user_cart_folders_sub_name
  ON user_cart_folders (user_id, parent_id, name) WHERE parent_id IS NOT NULL;

COMMENT ON TABLE user_cart_folders IS
  '반출대기함의 사용자별 개인 폴더. 반출 전 자료를 사용자 의도에 맞게 분류·보관한다.';

CREATE TABLE IF NOT EXISTS user_cart_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   bigint REFERENCES user_cart_folders(id) ON DELETE SET NULL,
  document_id bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_cart_items UNIQUE (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS ix_user_cart_items_user_folder ON user_cart_items (user_id, folder_id);
CREATE INDEX IF NOT EXISTS ix_user_cart_items_doc ON user_cart_items (document_id);

COMMENT ON TABLE user_cart_items IS
  '반출대기함에 담긴 사용자별 자료. 특정 폴더(folder_id)에 속하거나 기본 폴더(null)에 속한다.';
