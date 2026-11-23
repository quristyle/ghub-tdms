<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '@/lib/session'
import { useQuery } from '@tanstack/vue-query'
import type { FavoriteCountResponse } from '@tdms/contracts'
import FavoritesHost from '@/ui/FavoritesHost.vue'
import NoticeButtons from '@/ui/NoticeButtons.vue'
import MyPageModal from '@/ui/MyPageModal.vue'
import ThemeToggle from '@/ui/ThemeToggle.vue'
import NavSidebar from '@/ui/NavSidebar.vue'
import { api } from '@/lib/api'
import { countVersion, listOpen as favListOpen } from '@/lib/favorites'

/**
 * 앱 셸 — 상단 앱 바 한 줄 + 그 아래 본문.
 *
 * 기존 TDMS 화면의 상단 바를 그대로 옮겨 온 것이다.
 *   [SK가스 로고 + TDMS 기술자료 관리 시스템] [가로 메뉴] … [TDB 수정][TDB 반출][보관][이름][로그아웃]
 *
 * 왼쪽에서 슬라이드로 나오는 트리 사이드바는 **데스크탑·모바일 모두** 쓴다. 여는 자리만
 * 다르다 — 데스크탑은 로고 옆 햄버거 단추, 모바일은 로고 자체를 누른다(좁은 화면에서는
 * 단추를 하나라도 줄이는 편이 낫다). 데스크탑의 가로 메뉴는 그대로 둔다 — 사이드바는
 * 보태는 길이지 대신하는 길이 아니다.
 * 메뉴의 목록과 순서는 서버(/auth/me)가 주는 그대로다 — 정본은 DB 의 menus 이고
 * 운영자가 [메뉴 관리] 화면에서 바꾼다.
 * 권한 없는 메뉴는 서버가 이미 빼고 내려주므로 화면이 거르지 않는다.
 */

const session = useSession()
const route = useRoute()
const router = useRouter()

/** 모바일 환경 판정 및 사이드바 열림 상태 */
const MOBILE_MAX = 900
const isMobile = ref(typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX)
const navSidebarOpen = ref(false)

// 폭이 바뀌었다고 사이드바를 닫지 않는다 — 데스크탑에서도 쓰는 기능이 되었다.
// (예전에는 데스크탑에 여는 자리가 없어 넘어갈 때 닫아 줘야 했다)
function updateMobileState() {
  isMobile.value = window.innerWidth <= MOBILE_MAX
}

onMounted(() => {
  updateMobileState()
  window.addEventListener('resize', updateMobileState)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateMobileState)
})

/**
 * 트리 사이드바 열고 닫기 — 데스크탑의 햄버거 단추와 모바일의 로고가 함께 쓴다.
 * 모바일 로고는 RouterLink 가 아니라 단추다 — 링크로 두면 라우터가 먼저 '/' 로 옮기고,
 * 화면이 바뀌면 사이드바를 닫는 감시가 방금 연 사이드바를 곧바로 닫아 버린다
 * (홈이 아닌 화면에서 로고를 눌러도 아무 일도 없는 것처럼 보이던 원인).
 */
function toggleNavSidebar() {
  navSidebarOpen.value = !navSidebarOpen.value
}

/** 지금 보는 화면 — 상세·도움말처럼 메뉴에 없는 화면은 들어온 메뉴를 켜 두지 않는다 */
function isOn(path: string) {
  if (route.path === path) return true
  // /documents/:id 는 TDB 조회에서, /mdb/:id 는 MDB 조회에서 들어온다
  if (path !== '/' && route.path.startsWith(path + '/')) return true
  if (path === '/' && route.path.startsWith('/documents/')) return true
  return false
}

// ── 상단 바 묶음 메뉴 ──────────────────────────────────────────────────
// 메뉴를 하나씩 늘어놓으면 상단 바가 길어져 무엇이 어디 있는지 찾기 어렵다.
// 일 묶음(TDB·MDB)과 운영 묶음(시스템) 셋으로 접고, 올리거나 누르면 펼친다.
//
// 가르는 기준은 **메뉴 코드**다 — 운영자가 [메뉴 관리]에서 경로나 이름을 바꿔도 따라온다.
// 코드가 없는 옛 메뉴를 위해 기본 경로도 함께 본다.
interface NavGroupDef {
  key: string
  label: string
  codes: string[]
  paths: string[]
}

const NAV_GROUPS: NavGroupDef[] = [
  {
    key: 'tdb',
    label: 'TDB',
    codes: ['tdb_list', 'tdb_import', 'tdb_editor', 'tdb_distributions'],
    paths: ['/', '/import', '/editor', '/distributions'],
  },
  {
    key: 'mdb',
    label: 'MDB',
    codes: ['mdb_list', 'mdb_editor'],
    paths: ['/mdb', '/mdb-editor'],
  },
  {
    key: 'system',
    label: '시스템',
    codes: ['audit', 'users', 'backup', 'menus', 'permissions', 'stamps', 'projects', 'vendors'],
    paths: ['/audit', '/users', '/backup', '/menus', '/permissions', '/stamps', '/projects', '/vendors'],
  },
]

const inGroup = (m: { code?: string; path: string }, g: NavGroupDef) =>
  (m.code ? g.codes.includes(m.code) : g.paths.includes(m.path))

/** 묶음별 메뉴. 권한이 없어 하나도 없는 묶음은 상단 바에 내지 않는다. */
const navGroups = computed(() =>
  NAV_GROUPS
    .map((g) => ({ ...g, items: session.menu.filter((m) => inGroup(m, g)) }))
    .filter((g) => g.items.length > 0))

/** 어느 묶음에도 없는 메뉴가 생기면 사라지지 않게 상단 바에 그대로 둔다 */
const looseMenu = computed(() =>
  session.menu.filter((m) => !NAV_GROUPS.some((g) => inGroup(m, g))))

/** 지금 펼쳐 둔 묶음 (한 번에 하나만) */
const openGroup = ref<string | null>(null)

/** 지금 보는 화면이 그 묶음 안에 있으면 묶음 자체를 켜 둔다 */
const activeGroup = computed(() =>
  navGroups.value.find((g) => g.items.some((m) => isOn(m.path)))?.key ?? null)

/**
 * 묶음 이름을 누르면 그 묶음의 첫 번째 하위 메뉴로 바로 간다.
 * 하위 메뉴 목록은 마우스를 올리면 펼쳐지므로, 누르는 것은 "첫 화면 열기"로 쓴다.
 * 이미 그 화면이면 경로가 바뀌지 않아 아래 감시가 돌지 않으니 여기서 직접 닫는다.
 */
function openFirst(g: { items: { path: string }[] }) {
  const first = g.items[0]
  openGroup.value = null
  if (first) void router.push(first.path)
}

// 화면을 옮기면 닫는다 — 눌러서 들어간 뒤 목록이 남아 있으면 가린다
watch(() => route.fullPath, () => {
  openGroup.value = null
  navSidebarOpen.value = false
})

// ── 사용자 보관 [보관 (N)] ─────────────────────────────────────────────
// 건수만 따로 받는다(목록 전체를 받지 않는다). 보관·삭제하면 countVersion 이 올라 다시 받는다.
const { data: favCount, refetch: refetchFavCount } = useQuery({
  queryKey: ['favorites', 'summary'],
  queryFn: () => api.get<FavoriteCountResponse>('/favorites/summary'),
  enabled: computed(() => session.isLoggedIn),
  staleTime: 60_000,
})
watch(countVersion, () => { void refetchFavCount() })
function openFavorites() { favListOpen.value = true }

// ── 마이페이지 ────────────────────────────────────────────────────────
const mypageOpen = ref(false)

async function logout() {
  await session.logout()
  void router.push('/login')
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header-inner">
        <!-- 햄버거 + 로고는 한 묶음이다 — app-header-inner 의 큰 gap(36px)이 둘 사이까지
             벌리지 않도록 따로 감싼다 -->
        <div class="app-brand-box">
        <!-- 데스크탑의 햄버거. 모바일에서는 로고 자체가 이 일을 하므로 내지 않는다 -->
        <button
          v-if="!isMobile"
          type="button"
          class="app-menu-btn"
          title="메뉴 열기"
          aria-label="메뉴 열기"
          aria-haspopup="dialog"
          :aria-expanded="navSidebarOpen"
          @click="toggleNavSidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <!-- 상단 로고: 모바일에서는 단추(트리 메뉴 사이드바 열고 닫기), 그 밖에는 첫 화면 링크 -->
        <button
          v-if="isMobile"
          type="button"
          class="app-brand is-mobile"
          title="메뉴 열기"
          aria-label="메뉴 열기"
          aria-haspopup="dialog"
          :aria-expanded="navSidebarOpen"
          @click="toggleNavSidebar"
        >
          <!-- 모바일에서는 시스템명을 빼고 로고만 둔다 — 좁은 화면에서 머리글이 너비를 넘치지 않게 -->
          <img class="app-brand-logo" src="/assets/skgas-logo.png" alt="SK gas" />
          <span class="app-brand-mobile-indicator" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </span>
        </button>
        <RouterLink v-else to="/" class="app-brand" title="TDMS 기술자료 관리 시스템">
          <img class="app-brand-logo" src="/assets/skgas-logo.png" alt="SK gas" />
          <span class="app-brand-text"><strong>TDMS</strong> 기술자료 관리 시스템</span>
        </RouterLink>
        </div>

        <nav class="app-nav" aria-label="주 메뉴">
          <!-- TDB · MDB · 시스템 — 올리면 하위 메뉴가 펼쳐지고, 누르면 첫 번째 하위 메뉴가 열린다 -->
          <div
            v-for="g in navGroups" :key="g.key" class="app-nav-group"
            @mouseenter="openGroup = g.key" @mouseleave="openGroup = null"
          >
            <button
              type="button" class="app-nav-group-btn" :class="{ active: activeGroup === g.key }"
              aria-haspopup="menu" :aria-expanded="openGroup === g.key" :title="g.label"
              @click="openFirst(g)"
              @keydown.escape="openGroup = null"
            >
              {{ g.label }}
              <svg class="app-nav-caret" width="9" height="9" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>

            <div v-if="openGroup === g.key" class="app-nav-menu" role="menu">
              <RouterLink
                v-for="m in g.items" :key="m.path" :to="m.path" role="menuitem"
                class="app-nav-menu-item" :class="{ on: isOn(m.path) }" :title="m.label"
                @click="openGroup = null"
              >{{ m.label }}</RouterLink>
            </div>
          </div>

          <RouterLink
            v-for="m in looseMenu" :key="m.path" :to="m.path"
            :class="{ active: isOn(m.path) }" :title="m.label"
          >{{ m.label }}</RouterLink>
        </nav>

        <div class="app-user">
          <NoticeButtons />

          <span class="fav-btn-box">
            <button
              type="button" class="notice-btn fav-open-btn"
              title="미리보기에서 보관해 둔 자료 (사용자 보관 목록)"
              @click="openFavorites"
            >보관 ({{ favCount?.count ?? 0 }})</button>
          </span>

          <ThemeToggle />

          <a href="#" class="mypage-link" @click.prevent="mypageOpen = true">{{ session.me?.name }}</a>
          <button
            type="button"
            class="small logout-icon-btn"
            title="로그아웃"
            aria-label="로그아웃"
            @click="logout"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 17l5-5-5-5M15 12H3" />
              <path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <RouterView />

    <FavoritesHost />
    <MyPageModal v-if="mypageOpen" @close="mypageOpen = false" />

    <!-- 모바일 트리 사이드바 메뉴 (왼쪽에서 슬라이드) -->
    <NavSidebar
      :open="navSidebarOpen"
      :nav-groups="navGroups"
      :loose-menu="looseMenu"
      :fav-count="favCount"
      @close="navSidebarOpen = false"
      @open-favorites="openFavorites"
      @open-mypage="mypageOpen = true"
      @logout="logout"
    />
  </div>
</template>

<style scoped>
/* 상단 바 모양은 base.css(.app-header / .app-nav / .app-user)가 전부 맡는다 —
   기존 화면과 같은 규칙을 한 곳에만 둔다. 여기서는 Vue 라우터가 붙이는
   기본 활성 클래스가 밑줄을 두 번 긋지 않게만 정리한다. */
.app-nav a.router-link-active:not(.active) { text-decoration-line: none; color: var(--text-muted); }
.mypage-link { cursor: pointer; }
.logout-icon-btn { width: 30px; height: 30px; padding: 0; color: var(--text-muted); }
.logout-icon-btn:hover { color: var(--danger, #97453e); }

/* 햄버거 + 로고 묶음 */
.app-brand-box { display: flex; align-items: center; gap: 12px; min-width: 0; }

/* 데스크탑 햄버거 — 모바일 로고에 붙는 햄버거 표시와 같은 모양으로 맞춘다 */
.app-menu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  flex-shrink: 0;
  border-radius: var(--radius);
  background: var(--surface-alt);
  border: 1px solid var(--border);
  color: var(--text-dark-gray);
  cursor: pointer;
  transition: all 0.15s ease;
}
.app-menu-btn:hover,
.app-menu-btn[aria-expanded='true'] {
  background: var(--surface-sunken);
  color: var(--text);
}
.app-menu-btn svg {
  display: block;
  flex-shrink: 0;
}

/* 모바일 로고 클릭 표시 */
.app-brand.is-mobile {
  /* 단추 기본 모양을 지우고 링크일 때와 똑같이 보이게 한다 */
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
  height: auto;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.app-brand.is-mobile:hover {
  opacity: 0.85;
}
.app-brand-mobile-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--radius);
  background: var(--surface-alt);
  border: 1px solid var(--border);
  color: var(--text-dark-gray);
  margin-left: 6px;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.app-brand-mobile-indicator:hover {
  background: var(--surface-sunken);
  color: var(--text);
}
.app-brand-mobile-indicator svg {
  display: block;
  flex-shrink: 0;
}
</style>
