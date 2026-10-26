-- 0015. 상단 메뉴를 DB 로 옮긴다 (메뉴관리 화면)
--
-- 그동안 메뉴는 packages/contracts/src/permissions.ts 의 MENU 상수 9개로 고정이었다.
-- 설계문서(05-기능인벤토리 1절)도 "전 화면 고정·순서 유지"로 적어 두었다 — 레거시를
-- 그대로 옮기는 것이 목표였으므로 맞는 선택이었다. 이제 운영자가 이름·표시 순서·
-- 사용여부를 직접 바꿀 수 있어야 해서 그 셋만 DB 로 내린다.
--
-- **경로와 권한 키는 바꾸지 못하게 둔다.** 경로는 SPA 라우터에 컴파일되어 있어
-- DB 에서 새 줄을 만들어도 갈 곳이 없고, 권한 키는 권한 트리의 리프와 짝이라
-- 임의로 바꾸면 화면 접속 판정이 끊긴다. 그래서 줄을 늘리거나 지우는 API 는 두지 않고,
-- label·sort_order·is_enabled 만 고치게 한다.

CREATE TABLE menus (
  path           text        PRIMARY KEY,       -- SPA 라우터 경로. 고정값
  permission_key text        NOT NULL,          -- 권한 트리의 리프. 고정값
  label          text        NOT NULL CHECK (btrim(label) <> ''),
  sort_order     integer     NOT NULL,
  is_enabled     boolean     NOT NULL DEFAULT true,
  -- 끌 수 없는 메뉴. 메뉴관리 자신을 끄면 되돌릴 화면이 없어진다.
  is_fixed       boolean     NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint      REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX ix_menus_sort ON menus (sort_order);

COMMENT ON TABLE menus IS
  '상단 메뉴. 줄은 고정이고 label·sort_order·is_enabled 만 메뉴관리 화면에서 바뀐다.';
COMMENT ON COLUMN menus.is_fixed IS
  '끄지 못하는 메뉴. 메뉴관리 자신이 꺼지면 되살릴 화면이 없어 자물쇠를 걸어 둔다.';

-- 레거시에서 옮겨 온 9개 — 순서 그대로. MENU 상수와 같은 내용이다.
INSERT INTO menus (path, permission_key, label, sort_order, is_enabled, is_fixed) VALUES
  ('/',              'screen.tdb_list.access',          'TDB 조회',      1, true, false),
  ('/import',        'screen.tdb_import.access',        'TDB 반입·검수', 2, true, false),
  ('/editor',        'screen.tdb_editor.access',        'TDB 관리',      3, true, false),
  ('/distributions', 'screen.tdb_distributions.access', 'TDB 반출이력',  4, true, false),
  ('/mdb',           'screen.mdb_list.access',          'MDB 조회',      5, true, false),
  ('/mdb-editor',    'screen.mdb_editor.access',        'MDB 관리',      6, true, false),
  ('/audit',         'screen.audit.access',             '시스템 로그',   7, true, false),
  ('/users',         'screen.users.access',             '사용자 관리',   8, true, false),
  ('/backup',        'screen.backup.access',            '백업 관리',     9, true, false),
-- 10번째 — 이번에 생긴 화면. 권한은 사용자·권한 관리와 같은 리프를 쓴다.
-- 새 리프를 만들면 "리프 36개"로 묶어 둔 레거시 패리티 보증이 깨진다. groups.html 이
-- users.html 과 screen.users.access 를 함께 쓰던 것과 같은 방식이다.
  ('/menus',         'screen.users.access',             '메뉴 관리',    10, true, true);
