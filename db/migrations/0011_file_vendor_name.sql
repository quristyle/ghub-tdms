-- 0011. 반입 당시 업체 이름을 파일에 보존
--
-- files 에 vendor_id 만 두면 업체명이 바뀌거나 목록에서 숨겨졌을 때 "누가 보낸 것인지"를
-- 잃는다. 기존 시스템도 files.vendor_name 을 따로 들고 있었다 — 그때의 기록이기 때문이다.
-- (distributions.vendor_name 과 같은 이유)

ALTER TABLE files ADD COLUMN vendor_name text;

COMMENT ON COLUMN files.vendor_name IS
  '반입 당시 업체 이름. 업체명이 바뀌어도 이 기록은 그대로 남는다.';
