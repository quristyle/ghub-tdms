-- 0026. 마이페이지를 상단 메뉴에 등록한다
--
-- 마이페이지는 팝업이 아닌 일반 화면으로 전환되며 상단 메뉴를 통해서도 직접 접근할 수 있다.
-- 로그인한 모든 사용자가 접근 가능한 공통 화면이므로 permission_key 는 'common' 으로 부여한다.

INSERT INTO menus (path, permission_key, label, sort_order, is_enabled, is_fixed, category, code)
VALUES ('/mypage', 'common', '마이페이지', 15, true, false, '일반', 'mypage')
ON CONFLICT (code) DO NOTHING;

SELECT setval(pg_get_serial_sequence('menus', 'id'), coalesce(max(id), 1)) FROM menus;
