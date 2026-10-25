-- 0008. 목록 1페이지 전용 인덱스
--
-- 52,000건 실측에서 드러난 문제:
--   ix_documents_browse 는 (folder_id, updated_at DESC, id DESC) 라 folder_id 가 선두다.
--   여러 폴더를 folder_id = ANY(...) 로 거르면 정렬에 쓸 수 없어 Seq Scan + top-N 정렬이
--   되고, 1페이지가 51ms 걸렸다. (커서가 붙는 2페이지 이후는 선택도가 높아져 인덱스를 탔다.)
--
-- 해법: 정렬키만 선두로 둔 짝 인덱스를 하나 더 만든다.
--   · 넓은 범위(폴더 미지정·상위 폴더) → 아래 인덱스로 LIMIT 100 에서 조기 종료
--   · 좁은 범위(말단 폴더 하나)        → 기존 folder_id 선두 인덱스
--   플래너가 범위 선택도를 보고 고른다.

CREATE INDEX ix_documents_recent ON documents (updated_at DESC, id DESC)
  WHERE status = 'ACTIVE' AND NOT is_archived AND NOT is_isometric;

CREATE INDEX ix_documents_recent_iso ON documents (updated_at DESC, id DESC)
  WHERE status = 'ACTIVE' AND NOT is_archived;

-- MDB 도 같은 구조
CREATE INDEX ix_mdb_files_recent ON mdb_files (updated_at DESC, id DESC)
  WHERE NOT is_archived;

COMMENT ON INDEX ix_documents_recent IS
  '목록 1페이지(커서 없음) 전용. 정렬키가 선두라 LIMIT 에서 조기 종료된다.';
