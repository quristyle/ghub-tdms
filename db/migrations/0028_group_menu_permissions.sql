-- 0028. 사용자 그룹별 메뉴 권한 (열람 및 C/R/U/D 권한 관리)
--
-- 메뉴별로 각 사용자 그룹이 열람(접근) 및 C, R, U, D 권한을 가질 수 있도록 관리한다.
-- 여기서 지정한 CRUD 권한은 각 화면의 버튼 권한(permission="c,r,u,d")으로 적용된다.

CREATE TABLE IF NOT EXISTS group_menu_permissions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  menu_id     integer NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  can_view    boolean NOT NULL DEFAULT true,   -- 메뉴 열람(접근)
  can_create  boolean NOT NULL DEFAULT false,  -- 등록 (C)
  can_read    boolean NOT NULL DEFAULT true,   -- 조회 (R)
  can_update  boolean NOT NULL DEFAULT false,  -- 수정 (U)
  can_delete  boolean NOT NULL DEFAULT false,  -- 삭제 (D)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_group_menu_permissions UNIQUE (group_id, menu_id)
);

CREATE INDEX IF NOT EXISTS ix_group_menu_permissions_group ON group_menu_permissions (group_id);
CREATE INDEX IF NOT EXISTS ix_group_menu_permissions_menu ON group_menu_permissions (menu_id);

COMMENT ON TABLE group_menu_permissions IS
  '사용자 그룹별 메뉴 권한. 메뉴 열람(view)과 C, R, U, D 버튼 권한을 지정한다.';

-- 그룹 메뉴권한 관리 화면을 상단/사이드바 메뉴에 추가
INSERT INTO menus (path, permission_key, label, sort_order, is_enabled, is_fixed, category, code)
VALUES ('/group-permissions', 'screen.users.access', '그룹 메뉴권한 관리', 16, true, false, '운영', 'group_permissions')
ON CONFLICT (code) DO NOTHING;

SELECT setval(pg_get_serial_sequence('menus', 'id'), coalesce(max(id), 1)) FROM menus;

-- 기존 그룹들에 대해 기본 메뉴 권한 초기화
-- 1) 설비기술팀(전체 기능 사용): 모든 메뉴 열람 및 CRUD 허용
INSERT INTO group_menu_permissions (group_id, menu_id, can_view, can_create, can_read, can_update, can_delete)
SELECT g.id, m.id, true, true, true, true, true
  FROM groups g
 CROSS JOIN menus m
 WHERE g.id = 1
ON CONFLICT (group_id, menu_id) DO NOTHING;

-- 2) 조회전용(TDB·MDB 조회만): 조회용 메뉴만 열람/R 허용, C/U/D 불허
INSERT INTO group_menu_permissions (group_id, menu_id, can_view, can_create, can_read, can_update, can_delete)
SELECT g.id, m.id,
       CASE WHEN m.code IN ('tdb_list', 'mdb_list', 'mypage') THEN true ELSE false END,
       false,
       CASE WHEN m.code IN ('tdb_list', 'mdb_list', 'mypage') THEN true ELSE false END,
       false,
       false
  FROM groups g
 CROSS JOIN menus m
 WHERE g.id = 2
ON CONFLICT (group_id, menu_id) DO NOTHING;
