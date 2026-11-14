<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '@/lib/session'
import { useQuery } from '@tanstack/vue-query'
import type { FavoriteCountResponse } from '@tdms/contracts'
import FavoritesHost from '@/ui/FavoritesHost.vue'
import NoticeButtons from '@/ui/NoticeButtons.vue'
import MyPageModal from '@/ui/MyPageModal.vue'
import { api } from '@/lib/api'
import { countVersion, listOpen as favListOpen } from '@/lib/favorites'

/**
 * 앱 셸 — 상단 앱 바 한 줄 + 그 아래 본문.
 *
 * 기존 TDMS 화면의 상단 바를 그대로 옮겨 온 것이다.
 *   [SK가스 로고 + TDMS 기술자료 관리 시스템] [가로 메뉴] … [TDB 수정][TDB 반출][보관][이름][로그아웃]
 *
 * 메뉴의 목록과 순서는 서버(/auth/me)가 주는 그대로다 — 정본은 DB 의 menus 이고
 * 운영자가 [메뉴 관리] 화면에서 바꾼다.
 * 권한 없는 메뉴는 서버가 이미 빼고 내려주므로 화면이 거르지 않는다.
 */

const session = useSession()
const route = useRoute()
const router = useRouter()

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
    codes: ['audit', 'users', 'backup', 'menus', 'permissions', 'stamps'],
    paths: ['/audit', '/users', '/backup', '/menus', '/permissions', '/stamps'],
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

// 화면을 옮기면 닫는다 — 눌러서 들어간 뒤 목록이 남아 있으면 가린다
watch(() => route.fullPath, () => { openGroup.value = null })

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
        <RouterLink to="/" class="app-brand" title="TDMS 기술자료 관리 시스템">
          <img class="app-brand-logo" src="/assets/skgas-logo.png" alt="SK gas" />
          <span class="app-brand-text"><strong>TDMS</strong> 기술자료 관리 시스템</span>
        </RouterLink>

        <nav class="app-nav" aria-label="주 메뉴">
          <!-- TDB · MDB · 시스템 — 올리거나 누르면 하위 메뉴가 펼쳐진다 -->
          <div
            v-for="g in navGroups" :key="g.key" class="app-nav-group"
            @mouseenter="openGroup = g.key" @mouseleave="openGroup = null"
          >
            <button
              type="button" class="app-nav-group-btn" :class="{ active: activeGroup === g.key }"
              aria-haspopup="menu" :aria-expanded="openGroup === g.key" :title="g.label"
              @click="openGroup = openGroup === g.key ? null : g.key"
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

          <a href="#" class="mypage-link" @click.prevent="mypageOpen = true">{{ session.me?.name }}</a>
          <button type="button" class="small" @click="logout">로그아웃</button>
        </div>
      </div>
    </header>

    <RouterView />

    <FavoritesHost />
    <MyPageModal v-if="mypageOpen" @close="mypageOpen = false" />
  </div>
</template>

<style scoped>
/* 상단 바 모양은 base.css(.app-header / .app-nav / .app-user)가 전부 맡는다 —
   기존 화면과 같은 규칙을 한 곳에만 둔다. 여기서는 Vue 라우터가 붙이는
   기본 활성 클래스가 밑줄을 두 번 긋지 않게만 정리한다. */
.app-nav a.router-link-active:not(.active) { text-decoration-line: none; color: var(--text-muted); }
.mypage-link { cursor: pointer; }
</style>
