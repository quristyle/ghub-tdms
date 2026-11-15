-- 0024. 공사 관리 · 업체 관리를 상단 메뉴에 올린다
--
-- 그동안 공사·업체는 반출하기 창의 [＋추가]와 TDB 관리의 팝업에서만 손댈 수 있었다.
-- 이름 변경·숨김까지 하려면 그 창을 먼저 찾아 들어가야 해서 따로 화면으로 세운다.
--
-- 권한은 새 리프를 만들지 않고 screen.users.access 를 함께 쓴다 — 메뉴 관리·접속권한
-- 관리·스탬프 관리가 이미 같은 방식이다(0015 주석 참고). 새 리프를 만들면 권한 트리의
-- 리프 수를 못박아 둔 레거시 패리티 보증이 깨진다.
--
-- id 는 serial 이라 넣지 않는다. 뒤에서 시퀀스를 현재 최대값으로 맞춰 둔다.

INSERT INTO menus (path, permission_key, label, sort_order, is_enabled, is_fixed, category, code)
VALUES
  ('/projects', 'screen.users.access', '공사 관리', 13, true, false, '운영', 'projects'),
  ('/vendors',  'screen.users.access', '업체 관리', 14, true, false, '운영', 'vendors')
ON CONFLICT (code) DO NOTHING;

SELECT setval(pg_get_serial_sequence('menus', 'id'), coalesce(max(id), 1)) FROM menus;
