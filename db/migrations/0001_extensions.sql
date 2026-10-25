-- 0001. 확장과 스키마 기본 설정
-- ltree   : 폴더 트리 (경로형 자료)
-- pg_trgm : 자료명·도면번호 부분일치 검색 (한글에 형태소 분석기 불필요)
-- pgcrypto: 난수·해시

CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 적용 이력
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text        NOT NULL
);

COMMENT ON TABLE schema_migrations IS '마이그레이션 적용 이력. 되돌리기 스크립트는 두지 않는다 — 앞으로만 간다.';
