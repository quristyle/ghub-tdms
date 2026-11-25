-- 0031. 접속권한 관리 데이터 동기화 (관리자 전체 리프 보유 및 마이페이지 수정 권한)
INSERT INTO ghub_tdms.group_permissions (group_id, permission_key)
VALUES 
  (1, 'screen.users.access'),
  (1, 'screen.backup.delete_file')
ON CONFLICT (group_id, permission_key) DO NOTHING;

UPDATE ghub_tdms.group_menu_permissions
SET can_update = true, updated_at = clock_timestamp()
WHERE group_id IN (1, 2) AND menu_id = 15;
