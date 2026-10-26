-- 0014. 사용자 프로필 확장 + 협력업체
--
-- 두 가지를 한다.
--  1) 레거시 재현 누락분 복구 — employment_status(재직/퇴직/삭제).
--     레거시(b4c9d1e7f302)는 is_active 를 그대로 두고 표시용 3단계를 따로 뒀다.
--     "삭제"도 실제로는 비활성일 뿐이라는 D-6 원칙 때문이다. 같은 방식을 쓴다.
--  2) G.Hub 포털이 들고 있는 신원·조직·연락처를 TDMS 가 직접 관리한다.
--     반출 기록·검수자 표기에서 "누가 가져갔나"를 이름 하나로만 남기면
--     동명이인과 퇴직자 구분이 안 된다. 사번·부서·소속사가 그 자리를 메운다.

-- ── 협력업체 ────────────────────────────────────────────────────────────
-- vendors(도면 제작 업체)와 다른 개념이다. 이쪽은 **사람이 소속된 회사**다.
-- 반출 대상을 사람으로 고를 때 소속사가 보여야 하고, 업체 단위로 끊을 일도 생긴다.
CREATE TABLE partner_companies (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id    bigint,                      -- 포털의 partnerCompanyId
  company_code   text,                        -- 사업자등록번호 또는 업체코드
  name           text        NOT NULL,
  representative text,
  business_type  text,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_partner_companies_name_ci  ON partner_companies (lower(name));
CREATE UNIQUE INDEX ix_partner_companies_external ON partner_companies (external_id)
  WHERE external_id IS NOT NULL;

COMMENT ON TABLE partner_companies IS
  '사람이 소속된 협력업체. 도면 제작 업체(vendors)와 혼동하지 말 것.';

-- ── 사용자 ──────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN employee_number    text,
  ADD COLUMN email              text,
  ADD COLUMN phone              text,
  ADD COLUMN extension_number   text,
  ADD COLUMN department         text,
  ADD COLUMN position           text,
  ADD COLUMN company_code       text        NOT NULL DEFAULT 'SKGAS',
  ADD COLUMN partner_company_id bigint      REFERENCES partner_companies(id) ON DELETE SET NULL,
  ADD COLUMN photo_url          text,
  ADD COLUMN thumbnail_url      text,
  ADD COLUMN hire_date          date,
  ADD COLUMN previous_login_at  timestamptz,
  ADD COLUMN employment_status  text        NOT NULL DEFAULT 'ACTIVE'
       CHECK (employment_status IN ('ACTIVE','RETIRED','DELETED')),
  ADD COLUMN external_id        bigint,
  ADD COLUMN portal_profile     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN synced_at          timestamptz;

-- 사번·사외 계정은 비어 있을 수 있다. 값이 있는 것들끼리만 유일하면 된다.
CREATE UNIQUE INDEX ix_users_employee_number ON users (employee_number)
  WHERE employee_number IS NOT NULL AND employee_number <> '';
CREATE UNIQUE INDEX ix_users_external        ON users (external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX ix_users_department ON users (department) WHERE department IS NOT NULL;
CREATE INDEX ix_users_partner    ON users (partner_company_id) WHERE partner_company_id IS NOT NULL;

-- 목록 기본값이 "재직만"이다(레거시 2026-08-12 CM 요청). 그 조회가 가장 잦다.
CREATE INDEX ix_users_active_list ON users (login_id) WHERE employment_status = 'ACTIVE';

COMMENT ON COLUMN users.employment_status IS
  '재직(ACTIVE)/퇴직(RETIRED)/삭제(DELETED). 로그인 차단은 is_active 가 한다 — 이 값은 표시·거르기용.';
COMMENT ON COLUMN users.external_id IS
  'G.Hub 포털의 사용자 id. 다시 동기화할 때 아이디가 바뀌어도 같은 사람을 찾는 열쇠다.';
COMMENT ON COLUMN users.portal_profile IS
  '포털에서 받았지만 TDMS 가 쓰지 않는 값(알림 설정·모바일 배치·연차 등). '
  '버리지 않고 그대로 담아 둔다 — 되돌려 줄 일이 생기고, 나중에 승격할 수도 있다.';
COMMENT ON COLUMN users.position IS '직위. PostgreSQL 의 position() 함수와 이름이 같으니 항상 u.position 으로 쓴다.';

-- 기존 계정의 상태를 is_active 에 맞춰 채운다 (레거시 마이그레이션과 같은 규칙)
UPDATE users SET employment_status = 'RETIRED' WHERE NOT is_active;
