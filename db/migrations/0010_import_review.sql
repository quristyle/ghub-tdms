-- 0010. 반입·검수에 필요한 상태 보강
--
-- 기존 시스템의 review_status 는 PENDING_REVIEW / APPROVED / REJECTED / MERGED 네 가지다.
-- 0004 에서 ISSUE 를 넣고 MERGED 를 빠뜨렸다 — 분기본을 통합했을 때 쓰는 상태다.

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_review_status_check;
ALTER TABLE files ADD CONSTRAINT files_review_status_check
  CHECK (review_status IN ('PENDING','APPROVED','REJECTED','ISSUE','MERGED'));

COMMENT ON COLUMN files.review_status IS
  'PENDING 검수대기 / APPROVED 승인 / REJECTED 반려 / ISSUE 확인필요 / MERGED 분기본이 통합되어 끝남.
   어떤 상태든 행은 지워지지 않는다 — 이력에 남아 어느 업체가 언제 보낸 것인지 알 수 있어야 한다(D-6).';

-- 업체가 파일명에 적어 온 리비전 표기(예: "_Rev03")와 시스템이 매긴 rev 가 다를 때의 경고.
-- 0004 에 이미 rev_mismatch_warning 이 있다. 여기서는 조회를 위한 인덱스만 추가한다.
CREATE INDEX ix_files_review_pending ON files (document_id, rev, branch)
  WHERE review_status = 'PENDING';

-- 반입 확인 필요: 업체가 보낸 파일을 어느 자료에 붙일지 정하지 못한 건.
-- 파일 자체는 blob 에 들어가 있고, 경로를 정하면 그때 files 행이 된다.
ALTER TABLE import_issues
  ADD COLUMN original_filename text,
  ADD COLUMN byte_size bigint,
  ADD COLUMN suggested_document_id bigint REFERENCES documents(id);

COMMENT ON COLUMN import_issues.suggested_document_id IS
  '파일명으로 짐작한 대상 자료. 사람이 확인해 바꿀 수 있다.';

-- 반출 1건이 어느 반입 파일로 닫혔는지 (반려 시 되돌리기 위해 필요)
CREATE INDEX ix_dist_returned_file ON distributions (returned_file_id)
  WHERE returned_file_id IS NOT NULL;
