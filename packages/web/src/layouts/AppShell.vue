<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '@/lib/session'
import NavIcon from '@/ui/NavIcon.vue'
import TdmsLogo from '@/ui/TdmsLogo.vue'

/**
 * 앱 셸 — 왼쪽 내비게이션 + 상단바.
 *
 * 메뉴의 목록과 순서는 서버(/auth/me)가 주는 그대로다 — 정본은 DB 의 menus 이고
 * 운영자가 [메뉴 관리] 화면에서 바꾼다.
 * 권한 없는 메뉴는 서버가 이미 빼고 내려주므로 화면이 거르지 않는다.
 *
 * 묶음(도면·데이터북·운영)은 그 순서를 끊어 읽기 쉽게 한 것뿐이다 — 순서를 바꾸지 않는다.
 * 어느 묶음에도 없는 경로가 생기면 ungrouped 가 맨 뒤에 받아 준다.
 */

const session = useSession()
const route = useRoute()
const router = useRouter()

const GROUPS: { title: string; codes: string[]; paths: string[] }[] = [
  {
    title: '도면 (TDB)',
    codes: ['tdb_list', 'tdb_import', 'tdb_editor', 'tdb_distributions'],
    paths: ['/', '/import', '/editor', '/distributions'],
  },
  {
    title: '데이터북 (MDB)',
    codes: ['mdb_list', 'mdb_editor'],
    paths: ['/mdb', '/mdb-editor'],
  },
  {
    title: '운영',
    codes: ['audit', 'users', 'permissions', 'menus', 'backup', 'stamps'],
    paths: ['/audit', '/users', '/permissions', '/menus', '/backup', '/stamps'],
  },
]

const isInGroup = (m: { code?: string; path: string }, g: typeof GROUPS[number]) => {
  if (m.code && g.codes.includes(m.code)) return true
  return g.paths.includes(m.path)
}

const groups = computed(() =>
  GROUPS
    .map((g) => ({ title: g.title, items: session.menu.filter((m) => isInGroup(m, g)) }))
    .filter((g) => g.items.length > 0),
)
/** 어느 묶음에도 없는 메뉴가 생기면 사라지지 않게 맨 뒤에 둔다 */
const ungrouped = computed(() =>
  session.menu.filter((m) => !GROUPS.some((g) => isInGroup(m, g))),
)

const title = computed(() => {
  const m = session.menu.find((x) => x.path === route.path)
  return m?.label ?? (route.meta.title as string) ?? ''
})

const titleMenuOpen = ref(false)
const copyStatus = ref('')
function toggleTitleMenu() {
  titleMenuOpen.value = !titleMenuOpen.value
  copyStatus.value = ''
}
async function copyCurrentPath() {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`
  try {
    await navigator.clipboard.writeText(path)
    copyStatus.value = 'URL을 복사했습니다'
  } catch {
    copyStatus.value = 'URL 복사에 실패했습니다'
  }
  titleMenuOpen.value = false
}

// ── 내비 접기 / 모바일 사이드바 ─────────────────────────────────────────
// 데스크톱: 폴더 트리를 쓰는 화면에서는 왼쪽이 두 겹이 된다. 접으면 본문이 넓어진다 (레일 모드).
// 모바일(휴대전화): 사이드바가 완전히 접히고 오버레이로 완전히 펼쳐지는 형태.
const rail = ref(false)
const mobileOpen = ref(false)
const isMobile = ref(false)

function checkMobile() {
  if (typeof window !== 'undefined') {
    isMobile.value = window.innerWidth <= 768
  }
}

function handleResize() {
  checkMobile()
  if (!isMobile.value && mobileOpen.value) {
    mobileOpen.value = false
  }
}

onMounted(() => {
  checkMobile()
  const saved = localStorage.getItem('tdms.rail')
  // 고른 적이 없으면 좁은 화면에서 접어 둔다. 고른 뒤에는 그 선택이 이긴다 —
  // 폭으로 못박으면 펼치려 해도 펼쳐지지 않는다.
  rail.value = saved !== null ? saved === '1' : window.innerWidth < 1360
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  document.body.style.overflow = ''
  window.removeEventListener('resize', handleResize)
})

watch(mobileOpen, (open) => {
  if (isMobile.value) {
    document.body.style.overflow = open ? 'hidden' : ''
  }
})

watch(() => route.fullPath, () => {
  closeMobileNav()
})

function toggleNav() {
  if (isMobile.value) {
    mobileOpen.value = !mobileOpen.value
  } else {
    rail.value = !rail.value
    localStorage.setItem('tdms.rail', rail.value ? '1' : '0')
  }
}

function closeMobileNav() {
  if (isMobile.value) {
    mobileOpen.value = false
  }
}

const isNavCollapsed = computed(() => {
  return isMobile.value ? !mobileOpen.value : rail.value
})

// ── 밝게 / 어둡게 ─────────────────────────────────────────────────────
const dark = ref(false)
function applyTheme() { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' }
onMounted(() => {
  const saved = localStorage.getItem('tdms.theme')
  dark.value = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme()
})
function toggleTheme() {
  dark.value = !dark.value
  localStorage.setItem('tdms.theme', dark.value ? 'dark' : 'light')
  applyTheme()
}

const initials = computed(() => (session.me?.name ?? '').slice(0, 1))

const userOpen = ref(false)
async function logout() {
  userOpen.value = false
  await session.logout()
  void router.push('/login')
}
</script>

<template>
  <div class="app-shell" :class="{ rail, 'mobile-open': mobileOpen }" @click="copyStatus = ''; titleMenuOpen = false">
    <!-- 모바일 내비 배경 딤 (터치 시 닫기) -->
    <Transition name="fade">
      <div
        v-if="mobileOpen"
        class="nav-backdrop"
        aria-hidden="true"
        @click.stop="closeMobileNav"
      />
    </Transition>

    <!-- 왼쪽 내비게이션 -->
    <nav class="nav" aria-label="주 메뉴">
      <div class="nav-brand-bar">
        <RouterLink to="/" class="nav-brand" title="TDMS 기술자료 관리 시스템" @click="closeMobileNav">
          <TdmsLogo :size="28" />
          <span class="nav-brand-text">
            <strong>TDMS</strong>
            <span class="nav-brand-sub">기술자료 관리</span>
          </span>
        </RouterLink>
        <button
          class="btn btn-sm btn-ghost btn-icon mobile-close-btn"
          aria-label="메뉴 닫기"
          title="메뉴 닫기"
          @click="closeMobileNav"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor"
                  stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="nav-scroll">
        <template v-for="g in groups" :key="g.title">
          <div class="nav-group">{{ g.title }}</div>
          <RouterLink
            v-for="m in g.items" :key="m.path" :to="m.path"
            class="nav-item" :class="{ on: route.path === m.path }" :title="m.label"
            @click="closeMobileNav"
          >
            <NavIcon :path="m.path" :code="m.code" />
            <span class="nav-text">{{ m.label }}</span>
          </RouterLink>
        </template>

        <template v-if="ungrouped.length">
          <div class="nav-group">기타</div>
          <RouterLink
            v-for="m in ungrouped" :key="m.path" :to="m.path"
            class="nav-item" :class="{ on: route.path === m.path }" :title="m.label"
            @click="closeMobileNav"
          >
            <NavIcon :path="m.path" :code="m.code" />
            <span class="nav-text">{{ m.label }}</span>
          </RouterLink>
        </template>
      </div>

      <RouterLink
        to="/help"
        class="nav-item nav-foot"
        :class="{ on: route.path === '/help' }"
        title="도움말"
        @click="closeMobileNav"
      >
        <NavIcon path="/help" />
        <span class="nav-text">도움말</span>
      </RouterLink>
    </nav>

    <!-- 상단바 + 본문 -->
    <div class="app-pane">
      <header class="topbar">
        <button
          class="btn btn-sm btn-ghost btn-icon"
          :title="isNavCollapsed ? '메뉴 펼치기' : '메뉴 접기'"
          :aria-label="isNavCollapsed ? '메뉴 펼치기' : '메뉴 접기'"
          @click="toggleNav"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor"
                  stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>

        <div class="topbar-title-wrap" @click.stop>
          <h1 class="topbar-title">
            <button
              class="topbar-title-trigger"
              aria-haspopup="menu"
              :aria-expanded="titleMenuOpen"
              @click="toggleTitleMenu"
            >{{ title }}</button>
          </h1>
          <div v-if="titleMenuOpen" class="title-menu" role="menu">
            <button class="title-menu-item" role="menuitem" @click="copyCurrentPath">
              현재 URL 복사
            </button>
          </div>
          <span v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</span>
        </div>
        <span style="flex:1" />

        <button
          class="btn btn-sm btn-ghost btn-icon"
          :title="dark ? '밝게 보기' : '어둡게 보기'"
          :aria-label="dark ? '밝게 보기' : '어둡게 보기'"
          @click="toggleTheme"
        >
          <svg v-if="dark" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"
                  stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.5 9.8A6 6 0 0 1 6.2 2.5a6 6 0 1 0 7.3 7.3z" fill="none"
                  stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </button>

        <div class="user" @mouseleave="userOpen = false">
          <button class="user-chip" :aria-expanded="userOpen" @click="userOpen = !userOpen">
            <span class="avatar">{{ initials }}</span>
            <span class="user-name">{{ session.me?.name }}</span>
            <span v-if="session.isAdmin" class="tag tag-primary">관리자</span>
          </button>
          <div v-if="userOpen" class="user-menu">
            <div class="user-head">
              <div class="user-id">{{ session.me?.loginId }}</div>
              <div class="muted small">{{ session.me?.groupName ?? '그룹 없음' }}</div>
            </div>
            <RouterLink to="/help" class="user-link" @click="userOpen = false">도움말</RouterLink>
            <button class="user-link" @click="logout">로그아웃</button>
          </div>
        </div>
      </header>

      <div class="app-body">
        <RouterView />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 왼쪽 내비게이션 ───────────────────────────────────────────── */
.nav {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow: hidden;
}

.nav-brand-bar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.nav-brand {
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 14px;
  flex: 1;
  min-width: 0;
}
.mobile-close-btn {
  display: none;
  margin-right: 8px;
}
.nav-brand-text {
  display: flex; flex-direction: column; justify-content: center;
  line-height: 1.15; white-space: nowrap;
}
.nav-brand-text strong {
  font-size: var(--fs-md); font-weight: 700; letter-spacing: .04em;
}
.nav-brand-sub { font-size: var(--fs-xs); color: var(--fg-muted); }

.nav-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: var(--sp-2) 8px; }

.nav-group {
  padding: 12px 8px 5px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--fg-subtle);
  white-space: nowrap;
}
.nav-scroll > .nav-group:first-child { padding-top: 4px; }

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 9px;
  margin-bottom: 1px;
  border-radius: var(--r);
  color: var(--fg-muted);
  white-space: nowrap;
  transition: background-color .12s ease, color .12s ease;
}
.nav-item:hover { background: var(--surface-2); color: var(--fg); }
.nav-item.on { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.nav-item :deep(svg) { flex: 0 0 auto; }

.nav-foot {
  margin: 0 8px var(--sp-2);
  border-top: 1px solid var(--border);
  border-radius: 0;
  height: auto;
  padding: 10px 9px;
  flex: 0 0 auto;
}

/* 접었을 때 — 아이콘만 */
.app-shell.rail .nav-text,
.app-shell.rail .nav-brand-text { display: none; }
.app-shell.rail .nav-group { padding: 10px 0 4px; text-align: center; font-size: 0; }
.app-shell.rail .nav-group::after {
  content: ''; display: block; width: 16px; height: 1px; margin: 0 auto; background: var(--border);
}
.app-shell.rail .nav-item { justify-content: center; padding: 0; }
.app-shell.rail .nav-brand { justify-content: center; padding: 0; }

/* ── 상단바 ───────────────────────────────────────────────────── */
.topbar {
  height: var(--topbar-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.topbar-title-wrap { position: relative; min-width: 0; }
.topbar-title {
  font-size: var(--fs-md);
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.topbar-title-trigger {
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: inherit;
  overflow: hidden;
  text-overflow: inherit;
  cursor: pointer;
}
.topbar-title-trigger:hover { color: var(--primary); }
.title-menu {
  position: absolute; top: calc(100% + 8px); left: 0; z-index: 50;
  min-width: 160px; padding: 5px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); box-shadow: var(--shadow);
}
.title-menu-item {
  display: block; width: 100%; padding: 7px 9px; border: 0;
  background: transparent; color: var(--fg); border-radius: var(--r);
  font-size: var(--fs); text-align: left; white-space: nowrap;
}
.title-menu-item:hover { background: var(--surface-2); }
.copy-status {
  position: absolute; left: 0; top: calc(100% + 8px); z-index: 50;
  padding: 6px 9px; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r); box-shadow: var(--shadow); font-size: var(--fs-sm);
  white-space: nowrap;
}

/* ── 사용자 ───────────────────────────────────────────────────── */
.user { position: relative; }
.user-chip {
  display: flex; align-items: center; gap: 8px;
  height: var(--control-h); padding: 0 9px 0 5px;
  background: transparent; border: 1px solid transparent; border-radius: var(--r);
  color: var(--fg);
}
.user-chip:hover { background: var(--surface-2); }
.avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; flex: 0 0 auto;
  background: var(--surface-3); color: var(--fg);
  border-radius: var(--r-pill); font-size: var(--fs-sm); font-weight: 600;
}
.user-name { font-size: var(--fs); }

.user-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 50;
  min-width: 190px; padding: 5px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); box-shadow: var(--shadow);
}
.user-head { padding: 7px 9px 9px; border-bottom: 1px solid var(--border); margin-bottom: 5px; }
.user-id { font-weight: 600; font-family: var(--font-mono); font-size: var(--fs-sm); }
.user-link {
  display: block; width: 100%; text-align: left;
  padding: 7px 9px; border: 0; background: transparent;
  color: var(--fg); border-radius: var(--r); font-size: var(--fs);
}
.user-link:hover { background: var(--surface-2); }

@media (max-width: 720px) { .user-name { display: none; } }

/* ── 모바일 백드롭 ────────────────────────────────────────────── */
.nav-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 990;
  backdrop-filter: blur(1px);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity .2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── 모바일 사이드바 (휴대전화 화면 768px 이하) ─────────────────── */
@media (max-width: 768px) {
  .mobile-close-btn {
    display: inline-flex;
  }

  /* 휴대전화 환경에서는 사이드바가 완전히 접혀져 화면 밖으로 나가 숨겨진다 */
  .nav {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--sidebar-w);
    max-width: calc(100vw - 48px);
    z-index: 1000;
    box-shadow: none;
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform .22s cubic-bezier(0.4, 0, 0.2, 1), visibility .22s cubic-bezier(0.4, 0, 0.2, 1), box-shadow .22s ease;
  }

  /* 메뉴 토글 시 완전히 펼쳐진다 */
  .app-shell.mobile-open .nav {
    transform: translateX(0);
    visibility: visible;
    box-shadow: var(--shadow-lg);
  }

  /* 모바일에서는 rail 상태와 관계없이 펼쳐졌을 때 텍스트가 모두 보이는 온전한 사이드바여야 한다 */
  .app-shell.rail .nav-text {
    display: inline !important;
  }
  .app-shell.rail .nav-brand-text {
    display: flex !important;
  }
  .app-shell.rail .nav-brand-text strong,
  .app-shell.rail .nav-brand-text span {
    display: block !important;
  }
  .app-shell.rail .nav-group {
    padding: 12px 8px 5px !important;
    text-align: left !important;
    font-size: var(--fs-xs) !important;
  }
  .app-shell.rail .nav-group::after {
    display: none !important;
  }
  .app-shell.rail .nav-item {
    justify-content: flex-start !important;
    padding: 0 9px !important;
  }
  .app-shell.rail .nav-brand {
    justify-content: flex-start !important;
    padding: 0 14px !important;
  }
}

@media (min-width: 769px) {
  .nav-backdrop {
    display: none !important;
  }
}
</style>
