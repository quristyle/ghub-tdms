-- 0019. 메뉴 카테고리 및 분류(폴더) 지원
--
-- 메뉴를 카테고리/폴더 단위로 묶어서 관리할 수 있도록 menus 테이블에 category 컬럼을 추가한다.

ALTER TABLE menus ADD COLUMN IF NOT EXISTS category text;

-- 기존 메뉴에 고유 카테고리(분류) 설정
UPDATE menus SET category = '도면 (TDB)' WHERE code IN ('tdb_list', 'tdb_import', 'tdb_editor', 'tdb_distributions') AND category IS NULL;
UPDATE menus SET category = '데이터북 (MDB)' WHERE code IN ('mdb_list', 'mdb_editor') AND category IS NULL;
UPDATE menus SET category = '운영' WHERE code IN ('audit', 'users', 'backup', 'menus', 'permissions', 'stamps') AND category IS NULL;

-- 혹시 모를 누락 행 처리
UPDATE menus SET category = '일반' WHERE category IS NULL;

ALTER TABLE menus ALTER COLUMN category SET NOT NULL;
ALTER TABLE menus ALTER COLUMN category SET DEFAULT '일반';

COMMENT ON COLUMN menus.category IS '메뉴 소속 카테고리 및 폴더 분류명';
