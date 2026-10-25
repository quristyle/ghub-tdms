-- 0012. 보관함 2종 — 삭제 보관함과 폐기 보관함
--
-- 기존 시스템(app/retire.py)의 구분을 그대로 가져온다. 둘은 다른 것이다.
--
--   삭제 — 오류 등으로 자료가 온전한 기능을 못 할 때 없애는 것.
--          **폴더째 묶어 한 줄**이고, 용량이 문제가 되면 [완전 삭제]까지 갈 수 있다.
--   폐기 — 과거에는 온전했지만 리비전이 진행되며 최신본에서 빠진 것.
--          (A폴더 도면 1~10번 중 10번이 더 이상 필요 없어진 경우)
--          트리에서는 사라지되 **나중에 이력을 찾을 수 있어야 하므로 계속 보관한다.**
--          그래서 폐기에는 완전 삭제가 없고 [복구]만 있다. **자료 1건 = 이력 1건**이다.
--
-- 화면에서 감추는 일은 is_archived 한 값이 모두 한다(트리·목록·검색·반출·엑셀이 이 값만 본다).
-- 목록·건수·완전삭제는 kind 로 걸러 조회하므로 폐기 건이 삭제 쪽에 섞이지 않는다.

ALTER TABLE archive_batches
  ADD COLUMN label         text,
  ADD COLUMN original_path text,
  ADD COLUMN folder_id     bigint REFERENCES folders(id),
  ADD COLUMN purged_at     timestamptz,
  ADD COLUMN purged_by     bigint REFERENCES users(id);

COMMENT ON COLUMN archive_batches.label IS '화면에 보이는 묶음 이름 (폴더명 또는 "자료 3건")';
COMMENT ON COLUMN archive_batches.original_path IS '원래 있던 자리 — 복구할 때 돌려놓을 곳';
COMMENT ON COLUMN archive_batches.purged_at IS
  '완전 삭제 시각. 삭제 보관함에만 있다 — 폐기 보관함은 완전 삭제가 없다.';

-- 폴더도 보관함에 들어간다 (폴더째 삭제)
ALTER TABLE folders ADD COLUMN archive_batch_id bigint REFERENCES archive_batches(id);
CREATE INDEX ix_folders_archived ON folders (archive_batch_id) WHERE is_archived;

-- 기존 시스템 이름(archived_*)에 맞춘다. 인덱스보다 먼저 해야 한다.
ALTER TABLE archive_batches RENAME COLUMN created_at TO archived_at;
ALTER TABLE archive_batches RENAME COLUMN created_by TO archived_by;

-- 보관함 목록 조회 (kind + doc_class 로 걸러 최신순)
DROP INDEX IF EXISTS ix_archive_batches_kind;
CREATE INDEX ix_archive_batches_list
  ON archive_batches (doc_class, kind, archived_at DESC)
  WHERE restored_at IS NULL AND purged_at IS NULL;
