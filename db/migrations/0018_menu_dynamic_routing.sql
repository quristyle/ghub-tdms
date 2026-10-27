-- 0018. 메뉴 경로 변경 및 동적 라우팅 지원
--
-- 메뉴의 path 를 자유롭게 변경할 수 있도록 고유 식별자(id, code)를 부여하고,
-- path 의 기본키 제약을 유일 인덱스로 변경한다.

ALTER TABLE menus ADD COLUMN IF NOT EXISTS id serial;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;

-- 기존 12개 메뉴에 고유 코드 부여 (화면 컴포넌트 및 아이콘 매핑용)
UPDATE menus SET code = 'tdb_list', id = 1 WHERE path = '/' AND code IS NULL;
UPDATE menus SET code = 'tdb_import', id = 2 WHERE path = '/import' AND code IS NULL;
UPDATE menus SET code = 'tdb_editor', id = 3 WHERE path = '/editor' AND code IS NULL;
UPDATE menus SET code = 'tdb_distributions', id = 4 WHERE path = '/distributions' AND code IS NULL;
UPDATE menus SET code = 'mdb_list', id = 5 WHERE path = '/mdb' AND code IS NULL;
UPDATE menus SET code = 'mdb_editor', id = 6 WHERE path = '/mdb-editor' AND code IS NULL;
UPDATE menus SET code = 'audit', id = 7 WHERE path = '/audit' AND code IS NULL;
UPDATE menus SET code = 'users', id = 8 WHERE path = '/users' AND code IS NULL;
UPDATE menus SET code = 'backup', id = 9 WHERE path = '/backup' AND code IS NULL;
UPDATE menus SET code = 'menus', id = 10 WHERE path = '/menus' AND code IS NULL;
UPDATE menus SET code = 'permissions', id = 11 WHERE path = '/permissions' AND code IS NULL;
UPDATE menus SET code = 'stamps', id = 12 WHERE path = '/stamps' AND code IS NULL;

-- 혹시 모를 누락 행 처리
UPDATE menus SET code = 'menu_' || id WHERE code IS NULL;

ALTER TABLE menus ALTER COLUMN code SET NOT NULL;
ALTER TABLE menus ALTER COLUMN id SET NOT NULL;

-- 기본키를 path 에서 id 로 전환
ALTER TABLE menus DROP CONSTRAINT IF EXISTS menus_pkey;
ALTER TABLE menus ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_menus_code ON menus (code);
CREATE UNIQUE INDEX IF NOT EXISTS ix_menus_path ON menus (path);

-- 시퀀스 값 조정
SELECT setval(pg_get_serial_sequence('menus', 'id'), coalesce(max(id), 1)) FROM menus;

COMMENT ON COLUMN menus.id IS '메뉴 고유 식별 번호 (기본키)';
COMMENT ON COLUMN menus.code IS '화면 컴포넌트 및 아이콘과 연결되는 고유 코드';
COMMENT ON COLUMN menus.path IS 'SPA 동적 라우터 경로. 메뉴 관리 화면에서 변경 가능';
