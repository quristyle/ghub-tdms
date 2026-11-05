-- 0023. 확인 필요 한 건이 여러 파일·여러 사유를 갖게 한다
--
-- 기존 시스템의 확인 필요(import_issues)는 '도면 하나'(원본 + PDF) 단위였다. 사유도 여러 개가
-- 함께 붙는다(예: 경로 불일치 + 사본 누락). 0004 의 import_issues 는 파일 1개(blob_sha256)·
-- 사유 1개(reason)만 담아 Zip 반입 진단 결과를 옮길 수 없었다.
--
--   files   [{sha256, filename, ext, byteSize, folder}] — folder 는 Zip 안 폴더(재검수 때 경로를
--           다시 본다). 재첨부·개별 업로드면 null.
--   reasons 사유 코드 목록 (FILENAME_MISMATCH, PATH_MISMATCH ... — contracts/importMatch.ts)
--   detail  [사유상세] 문장과 구조 데이터 (반출 경로, 받은 이름, 빠진 확장자 ...)
--
-- 첫 파일은 지금처럼 blob_sha256 / filename / byte_size 에도 적는다(목록·옛 코드 호환).
-- 파일이 확인 필요에 머무는 동안 GC 가 수거하지 않도록 blobs.refcount 를 올려 둔다 — 항목이
-- 닫히면(등록·반려·재검수로 대체) 내린다.
--
-- 재검수에서 아직 문제가 있으면 옛 항목은 SUPERSEDED 로 닫고 새 사유로 새 항목을 만든다
-- (기존 시스템 동작. 기록은 남긴다 — D-6).

ALTER TABLE import_issues
  ADD COLUMN files        jsonb  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN reasons      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN detail       jsonb,
  ADD COLUMN vendor_name  text,
  ADD COLUMN zip_path     text,
  ADD COLUMN job_id       bigint REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN resolve_note text,
  ADD COLUMN superseded_by bigint REFERENCES import_issues(id);

ALTER TABLE import_issues DROP CONSTRAINT IF EXISTS import_issues_state_check;
ALTER TABLE import_issues ADD CONSTRAINT import_issues_state_check
  CHECK (state IN ('OPEN','RESOLVED','DISCARDED','SUPERSEDED'));

-- 지금 있는 항목(파일 1개)을 새 꼴로 채운다
UPDATE import_issues
   SET files = jsonb_build_array(jsonb_build_object(
         'sha256',   encode(blob_sha256, 'hex'),
         'filename', filename,
         'ext',      lower(coalesce(substring(filename from '\.([^.]+)$'), '')),
         'byteSize', byte_size,
         'folder',   NULL))
 WHERE blob_sha256 IS NOT NULL AND files = '[]'::jsonb;

UPDATE import_issues SET reasons = string_to_array(reason, ',') WHERE reasons = '{}';

UPDATE import_issues i SET vendor_name = v.name
  FROM vendors v WHERE v.id = i.vendor_id AND i.vendor_name IS NULL;

COMMENT ON COLUMN import_issues.files IS
  '[{sha256(hex), filename, ext, byteSize, folder}] — 원본·PDF 를 함께 담는다. folder 는 Zip 안 폴더(없으면 null).';
COMMENT ON COLUMN import_issues.reasons IS
  '사유 코드 목록. reason 은 쉼표로 이은 같은 값(옛 코드 호환).';
COMMENT ON COLUMN import_issues.suggested_document_id IS
  '대상 자료 — 반입 진단이 고른 반출 자료 또는 [경로 재선택]으로 CM 이 지정한 자료. [재검수]가 이 자료 기준으로 다시 본다.';
COMMENT ON COLUMN import_issues.document_id IS
  '[재검수]로 검수 대기에 등록된 자료 (RESOLVED 일 때)';
