-- 0013. 반출 기록이 자료보다 오래 살아남게 한다
--
-- 삭제 보관함의 [완전 삭제]는 "용량이 문제가 될 때" 쓰는 예외다(기존 D-38).
-- 그런데 반출 기록은 **누가 무엇을 받아 갔는지**를 남기는 것이라 자료가 사라져도 남아야 한다.
--
-- distributions.document_id 가 NOT NULL + FK 라 둘을 동시에 만족할 수 없었다.
-- 업체명을 vendor_name 으로 스냅샷해 두는 것과 같은 방식으로 자료명도 스냅샷하고,
-- 완전 삭제 때는 FK 만 끊는다.

ALTER TABLE distributions
  ADD COLUMN document_label text,
  ALTER COLUMN document_id DROP NOT NULL;

-- 지금 있는 기록에 자료명을 채워 둔다
UPDATE distributions x
   SET document_label = d.drawing_no
  FROM documents d
 WHERE d.id = x.document_id AND x.document_label IS NULL;

COMMENT ON COLUMN distributions.document_label IS
  '반출 당시 자료명 스냅샷. 자료가 완전 삭제돼도 "누가 무엇을 받아 갔는지" 는 남아야 한다.';
COMMENT ON COLUMN distributions.document_id IS
  '자료가 완전 삭제되면 NULL 이 된다. 그때도 document_label 로 무엇이었는지 알 수 있다.';

CREATE INDEX ix_dist_orphan ON distributions (distributed_at DESC)
  WHERE document_id IS NULL;
