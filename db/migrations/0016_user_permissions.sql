-- 0016. 사용자 개인 권한 + 접속권한 관리 화면
--
-- 그동안 권한은 **그룹에만** 붙었다(core/session.ts loadPermissions).
--   ADMIN        → 리프 36개 전부
--   그룹 없음     → 권한 0개
--   그 외         → 그 그룹 하나의 group_permissions
-- 그래서 "이 사람만 한 가지 더" 가 안 됐다. 그 사람을 위해 그룹을 새로 파거나,
-- 같은 그룹의 다른 사람에게까지 권한이 번지는 수밖에 없었다.
--
-- 개인 권한을 **더하기만** 하는 자리로 둔다.
--   최종 권한 = 그룹 권한 ∪ 개인 권한
-- 빼기(차단)는 두지 않는다. 한 방향이라 "왜 안 되는지" 를 한 군데만 보면 되고,
-- 실수로 접근을 끊는 일이 없다. 끊어야 하면 그룹에서 내리거나 그룹을 바꾼다.

CREATE TABLE user_permissions (
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key text   NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  granted_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, permission_key)
);

COMMENT ON TABLE user_permissions IS
  '사용자 개인에게 더해 주는 권한. 그룹 권한과 합집합이다 — 빼기는 없다.';

-- 접속권한 관리 화면. 권한 키는 사용자·권한 관리와 같은 것을 쓴다
-- (새 리프를 만들면 "리프 36개" 레거시 패리티가 깨진다 — 0015 와 같은 판단).
INSERT INTO menus (path, permission_key, label, sort_order, is_enabled, is_fixed)
VALUES ('/permissions', 'screen.users.access', '접속권한 관리', 11, true, false);
