-- 0021. 현재본은 '파일 1개'가 아니라 '세트'다
--
-- 0004 의 ix_files_current 가 (document_id) 에 UNIQUE 였다. 그런데 승인은 같은 Rev 의
-- DWG·PDF 를 함께 현재본으로 올린다(imports/queries.ts promoteToCurrent). 파일이 둘인
-- 세트를 승인하는 순간 unique 위반으로 승인 자체가 실패한다 — 지금까지는 한 파일짜리
-- 세트만 승인되어 드러나지 않았다. 고객 시스템도 현재본은 원본+사본 한 벌이었다.
--
-- 같은 확장자가 둘 올라오는 것은 반입 단계에서 '확인 필요'로 걸러지므로, 확장자 단위로 묶는다.

DROP INDEX IF EXISTS ix_files_current;
CREATE UNIQUE INDEX ix_files_current ON files (document_id, file_ext) WHERE is_current;
