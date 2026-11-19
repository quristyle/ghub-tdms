-- 0025. TOTP 2차 인증 (Microsoft Authenticator 등 RFC 6238 인증 앱)
--
-- 비밀번호만으로는 아이디를 아는 사람이 계정을 가져갈 수 있었다(공개 사이트).
-- 로그인 = 비밀번호 + 인증 앱의 6자리 코드. 등록하지 않은 계정은 첫 로그인 때
-- QR 을 찍어 등록해야 들어간다.
--
-- 비밀번호 확인과 코드 확인 사이는 세션이 아니라 login_challenges 에 둔다 —
-- 세션은 두 단계를 다 통과해야만 생긴다(반쯤 로그인된 세션이 없다).

ALTER TABLE users
  ADD COLUMN totp_secret     text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint;

COMMENT ON COLUMN users.totp_secret IS
  'TOTP 비밀키(base32) 를 AES-256-GCM 으로 암호화한 값 "v1.<iv>.<tag>.<ct>". 키는 TOTP_ENC_KEY, 없으면 SESSION_SECRET 에서 유도.';
COMMENT ON COLUMN users.totp_enabled_at IS '인증 앱 등록을 마친 시각. null 이면 다음 로그인 때 등록부터 한다.';
COMMENT ON COLUMN users.totp_last_step IS '마지막으로 받아들인 30초 칸 번호 — 같은 코드를 두 번 쓰지 못하게 한다.';

CREATE TABLE login_challenges (
  id             text        PRIMARY KEY,   -- 토큰의 sha256(hex). 토큰 자체는 저장하지 않는다
  user_id        bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose        text        NOT NULL CHECK (purpose IN ('verify', 'enroll')),
  pending_secret text,                      -- enroll 일 때 등록 대기 중인 비밀키(암호화)
  attempts       smallint    NOT NULL DEFAULT 0,
  expires_at     timestamptz NOT NULL,
  client_ip      inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_challenges_user    ON login_challenges (user_id);
CREATE INDEX ix_login_challenges_expires ON login_challenges (expires_at);

COMMENT ON TABLE login_challenges IS
  '비밀번호는 맞고 2차 인증 코드를 기다리는 중인 로그인. 몇 분 뒤 사라지고, 코드를 5번 틀려도 사라진다.';
