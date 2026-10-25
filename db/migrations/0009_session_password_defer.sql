-- 0009. 비밀번호 변경 '미루기' 를 세션에 보관
--
-- 기존 시스템은 미루기를 서버 세션에 담았다 — 새로고침해도 유지되고,
-- 다시 로그인하면 변경 화면이 다시 열린다. 클라이언트 메모리에만 두면
-- 새로고침마다 변경 화면이 다시 떠서 동작이 달라진다.

ALTER TABLE sessions ADD COLUMN password_deferred boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sessions.password_deferred IS
  '이 세션에서 비밀번호 변경을 미뤘는가. 세션이 끝나면(재로그인) 다시 묻는다.';
