-- 0032. 반출자료 다운로드 메뉴 추가 및 모든 그룹 권한 부여
--
-- 반출 대기함에서 비동기로 요청된 zip 압축 작업의 진행 상태를 조회하고
-- 완료된 zip 파일을 다운로드할 수 있는 '반출자료 다운로드' 메뉴를 등록한다.
-- 모든 사용자 그룹에 대해 열람 및 사용 권한을 부여한다.

-- 1) menus 테이블의 순서 조정을 위해 5번 이후 메뉴들의 sort_order를 1씩 밀어낸다
-- (ix_menus_sort 유니크 인덱스 충돌 방지를 위해 임시 음수 처리 후 +1 적용)
UPDATE menus SET sort_order = -sort_order WHERE sort_order >= 5;
UPDATE menus SET sort_order = -sort_order + 1 WHERE sort_order < 0;

-- 2) 반출자료 다운로드 메뉴 등록
INSERT INTO menus (path, permission_key, label, sort_order, is_enabled, is_fixed, category, code)
VALUES ('/export-downloads', 'screen.tdb_list.access', '반출자료 다운로드', 5, true, false, '도면 (TDB)', 'export_downloads')
ON CONFLICT (code) DO UPDATE SET
  path = EXCLUDED.path,
  permission_key = EXCLUDED.permission_key,
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  is_enabled = EXCLUDED.is_enabled,
  category = EXCLUDED.category;

SELECT setval(pg_get_serial_sequence('menus', 'id'), coalesce(max(id), 1)) FROM menus;

-- 3) 모든 그룹에 대해 '반출자료 다운로드' 메뉴의 전체 권한(열람, C, R, U, D) 부여
INSERT INTO group_menu_permissions (group_id, menu_id, can_view, can_create, can_read, can_update, can_delete)
SELECT g.id, m.id, true, true, true, true, true
  FROM groups g
 CROSS JOIN menus m
 WHERE m.code = 'export_downloads'
ON CONFLICT (group_id, menu_id) DO UPDATE SET
  can_view = true,
  can_create = true,
  can_read = true,
  can_update = true,
  can_delete = true,
  updated_at = clock_timestamp();
