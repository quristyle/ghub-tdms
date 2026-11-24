-- 0027. 사용자 화면 레이아웃 및 사이드바 고정 설정
--
-- 마이페이지에서 사용자가 상단 메뉴/사이드바 사용 모드와 사이드바 고정 여부를 설정할 수 있도록 한다.
-- layout_mode: 'both' (상단+사이드바), 'top' (상단만), 'sidebar' (사이드바만)
-- sidebar_pinned: true/false

ALTER TABLE users
  ADD COLUMN layout_mode text NOT NULL DEFAULT 'both'
    CHECK (layout_mode IN ('both', 'top', 'sidebar')),
  ADD COLUMN sidebar_pinned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.layout_mode IS
  '내비게이션 레이아웃 방식: both(상단+사이드바), top(상단만), sidebar(사이드바만)';
COMMENT ON COLUMN users.sidebar_pinned IS
  '사이드바 고정(Pin) 여부';
