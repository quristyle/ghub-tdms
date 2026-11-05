-- 0020. 원본(DWG·DXF) 미리보기 결과
--
-- 고객 시스템(D-102)은 원본을 PDF 로 바꿔 storage/미리보기변환/<sha256>_v<버전>.pdf 로 두고
-- 지금의 PDF 뷰어로 보여 줬다. 여기서는 워커(convert_preview)가 바꾼 PDF 를 blob 으로 넣고
-- 원본 내용 → PDF 를 이 표에 적는다. 같은 내용의 원본은 자료가 달라도 한 번만 바꾼다.

CREATE TABLE preview_renditions (
  source_sha256     bytea       NOT NULL REFERENCES blobs(sha256),
  converter_version smallint    NOT NULL,   -- 변환 방식을 고치면 올린다 — 옛 결과를 쓰지 않는다
  state             text        NOT NULL CHECK (state IN ('pending','done','failed')),
  pdf_sha256        bytea       REFERENCES blobs(sha256),
  error             text,                   -- 사용자에게 그대로 보여 줄 한 줄
  job_id            bigint      REFERENCES jobs(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_sha256, converter_version),
  CHECK (state <> 'done' OR pdf_sha256 IS NOT NULL)
);

COMMENT ON TABLE preview_renditions IS
  '원본(DWG·DXF) → 미리보기 PDF. failed 는 하루 동안 다시 시도하지 않는다(몇 분씩 걸려 실패하는 파일이 큐를 막지 않게).';
