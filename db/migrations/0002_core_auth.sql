-- 0002. 조직·인증
-- 기존 시스템의 users/groups/group_permissions 를 승계하되,
-- 서명 쿠키 세션(S-03)을 DB 세션 테이블로 교체한다.

CREATE TABLE groups (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text        NOT NULL UNIQUE,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id             text        NOT NULL UNIQUE,
  name                 text        NOT NULL,
  password_hash        text        NOT NULL,   -- PBKDF2-HMAC-SHA256 600,000회
  role                 text        NOT NULL DEFAULT 'VIEWER'
                         CHECK (role IN ('ADMIN','VIEWER')),
  group_id             bigint      REFERENCES groups(id) ON DELETE SET NULL,
  is_active            boolean     NOT NULL DEFAULT true,
  -- 최초 비밀번호(ghub+아이디) 변경 유도. 미루기 가능 — 기존 정책 유지
  must_change_password boolean     NOT NULL DEFAULT true,
  password_changed_at  timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_users_group ON users (group_id);

-- 그룹별 권한. 저장은 항상 leaf 키로 푼다 (상위 cascade 는 화면 로직)
CREATE TABLE group_permissions (
  group_id       bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  permission_key text   NOT NULL,
  PRIMARY KEY (group_id, permission_key)
);
CREATE INDEX ix_group_permissions_group ON group_permissions (group_id);

COMMENT ON TABLE group_permissions IS
  '권한 리프 36개 중 허용된 것만 행으로 존재한다. 트리 구조 자체는 코드에 고정(permission-tree.ts).';

-- 세션: 서버측 보관이라 즉시 강제 로그아웃이 가능하다
CREATE TABLE sessions (
  id           text        PRIMARY KEY,              -- 256bit 랜덤 base64url
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  client_ip    inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessions_user    ON sessions (user_id);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

COMMENT ON COLUMN sessions.last_seen_at IS
  '매 요청 UPDATE 하면 쓰기 증폭이 크다. 60초에 한 번만 갱신할 것.';

-- 로그인 실패 추적: 5회 연속 실패 시 15분 잠금 (기존 정책 유지)
CREATE TABLE login_attempts (
  login_id     text        PRIMARY KEY,
  fail_count   smallint    NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_fail_at timestamptz,
  last_fail_ip inet
);
