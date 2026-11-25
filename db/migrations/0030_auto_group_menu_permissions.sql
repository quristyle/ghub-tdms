-- 0030. 그룹 및 메뉴 추가 시 group_menu_permissions 자동 동기화 트리거
--
-- 새 그룹이 생성되면 모든 활성 메뉴에 대한 기본 권한 레코드를 생성하고,
-- 새 메뉴가 추가되면 모든 기존 그룹에 대해 기본 권한 레코드를 생성한다.

-- 1) 새 그룹 생성 시 메뉴 권한 자동 생성
CREATE OR REPLACE FUNCTION trg_fn_init_group_menu_permissions()
RETURNS trigger AS $$
BEGIN
  INSERT INTO group_menu_permissions (group_id, menu_id, can_view, can_create, can_read, can_update, can_delete)
  SELECT NEW.id, m.id, false, false, true, false, false
    FROM menus m
   WHERE m.is_enabled
  ON CONFLICT (group_id, menu_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_init_group_menu_permissions ON groups;
CREATE TRIGGER trg_init_group_menu_permissions
  AFTER INSERT ON groups
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_init_group_menu_permissions();

-- 2) 새 메뉴 추가 시 그룹 메뉴 권한 자동 생성
CREATE OR REPLACE FUNCTION trg_fn_sync_new_menu_permissions()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_enabled THEN
    INSERT INTO group_menu_permissions (group_id, menu_id, can_view, can_create, can_read, can_update, can_delete)
    SELECT g.id, NEW.id, false, false, true, false, false
      FROM groups g
    ON CONFLICT (group_id, menu_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_new_menu_permissions ON menus;
CREATE TRIGGER trg_sync_new_menu_permissions
  AFTER INSERT ON menus
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_sync_new_menu_permissions();

-- 혹시 기존에 누락된 그룹-메뉴 쌍이 있다면 보충
INSERT INTO group_menu_permissions (group_id, menu_id, can_view, can_create, can_read, can_update, can_delete)
SELECT g.id, m.id, false, false, true, false, false
  FROM groups g
 CROSS JOIN menus m
 WHERE m.is_enabled
ON CONFLICT (group_id, menu_id) DO NOTHING;
