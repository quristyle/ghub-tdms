<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useSession } from '@/lib/session'
import NavIcon from './NavIcon.vue'
import type { FavoriteCountResponse } from '@tdms/contracts'

export interface NavItem {
  id?: number
  code?: string
  path: string
  label: string
  category?: string
  permission?: string
}

export interface NavGroup {
  key: string
  label: string
  codes: string[]
  paths: string[]
  items: NavItem[]
}

const props = defineProps<{
  open: boolean
  navGroups: NavGroup[]
  looseMenu: NavItem[]
  favCount?: FavoriteCountResponse | null
}>()

const emit = defineEmits<{
  close: []
  openFavorites: []
  openMypage: []
  logout: []
}>()

const route = useRoute()
const session = useSession()

/** 현재 경로 활성화 여부 */
function isOn(path: string) {
  if (route.path === path) return true
  if (path !== '/' && route.path.startsWith(path + '/')) return true
  if (path === '/' && route.path.startsWith('/documents/')) return true
  return false
}

/** 트리 묶음 접힘/펼침 상태 */
const expandedGroups = ref<Set<string>>(new Set())

function initAllExpanded() {
  const next = new Set<string>()
  for (const g of props.navGroups) {
    next.add(g.key)
  }
  if (props.looseMenu.length > 0) {
    next.add('loose')
  }
  expandedGroups.value = next
}

// 사이드바가 열릴 때 초기 상태가 비어 있으면 모두 펼쳐둔다
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    if (expandedGroups.value.size === 0) {
      initAllExpanded()
    }
    // 배경 스크롤 방지
    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden'
    }
  } else {
    if (typeof document !== 'undefined') {
      document.body.style.overflow = ''
    }
  }
}, { immediate: true })

function toggleGroup(key: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedGroups.value = next
}

const allExpanded = computed(() => {
  const totalGroups = props.navGroups.length + (props.looseMenu.length > 0 ? 1 : 0)
  return totalGroups > 0 && expandedGroups.value.size >= totalGroups
})

function toggleAll() {
  if (allExpanded.value) {
    expandedGroups.value = new Set()
  } else {
    initAllExpanded()
  }
}

function handleMenuClick() {
  emit('close')
}

// Esc 키를 누르면 닫기
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (typeof document !== 'undefined') {
    document.body.style.overflow = ''
  }
})
</script>

<template>
  <Teleport to="body">
    <!-- 배경 딤 처리 (클릭 시 닫기) -->
    <div
      class="nav-sidebar-backdrop"
      :class="{ 'is-open': open }"
      aria-hidden="true"
      @click="emit('close')"
    />

    <!-- 왼쪽에서 슬라이드로 나타나는 사이드바 서랍 -->
    <aside
      class="nav-sidebar-drawer"
      :class="{ 'is-open': open }"
      role="dialog"
      aria-modal="true"
      aria-label="모바일 주 메뉴"
      :aria-hidden="!open"
    >
      <!-- 상단 머리글: 로고 + 닫기 버튼 -->
      <div class="drawer-header">
        <div class="drawer-brand">
          <img class="drawer-brand-logo" src="/assets/skgas-logo.png" alt="SK gas" />
          <span class="drawer-brand-text"><strong>TDMS</strong> 기술자료 관리</span>
        </div>
        <button
          type="button"
          class="drawer-close-btn"
          title="메뉴 닫기"
          aria-label="메뉴 닫기"
          @click="emit('close')"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" />
            <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <!-- 사용자 정보 카드 -->
      <div v-if="session.isLoggedIn" class="drawer-user-card">
        <div class="user-row">
          <div class="user-avatar" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div class="user-meta">
            <div class="user-name-line">
              <strong class="user-name">{{ session.me?.name }}</strong>
              <span class="user-badge" :class="session.isAdmin ? 'admin' : 'viewer'">
                {{ session.isAdmin ? '관리자' : '조회자' }}
              </span>
            </div>
            <div v-if="session.me?.groupName" class="user-sub">
              {{ session.me?.groupName }}
            </div>
          </div>
        </div>

        <div class="user-actions">
          <RouterLink
            to="/mypage"
            class="user-action-btn"
            :class="{ active: isOn('/mypage') }"
            @click="emit('close')"
          >
            내 정보
          </RouterLink>
          <button
            type="button"
            class="user-action-btn"
            @click="emit('openFavorites'); emit('close')"
          >
            보관함 ({{ favCount?.count ?? 0 }})
          </button>
          <button
            type="button"
            class="user-action-btn logout-btn"
            @click="emit('logout')"
          >
            로그아웃
          </button>
        </div>
      </div>

      <!-- 트리 형태의 메뉴 영역 -->
      <div class="drawer-tree-section">
        <div class="tree-head">
          <span class="tree-head-title">메뉴 탐색</span>
          <button
            type="button"
            class="tree-head-toggle-btn"
            :title="allExpanded ? '모두 접기' : '모두 펼치기'"
            @click="toggleAll"
          >
            {{ allExpanded ? '모두 접기' : '모두 펼치기' }}
          </button>
        </div>

        <nav class="tree-body" aria-label="사이드바 메뉴 트리">
          <!-- 묶음 그룹별 (TDB, MDB, 시스템) -->
          <div v-for="g in navGroups" :key="g.key" class="tree-group-box">
            <!-- 묶음 부모 노드 (depth 0) -->
            <div
              class="tree-node tree-group-node"
              :class="{
                'has-active-child': g.items.some((m) => isOn(m.path)),
                'is-expanded': expandedGroups.has(g.key)
              }"
              role="button"
              :aria-expanded="expandedGroups.has(g.key)"
              tabindex="0"
              @click="toggleGroup(g.key)"
              @keydown.enter.prevent="toggleGroup(g.key)"
              @keydown.space.prevent="toggleGroup(g.key)"
            >
              <span class="tree-toggle" aria-hidden="true">
                {{ expandedGroups.has(g.key) ? '▾' : '▸' }}
              </span>
              <span class="tree-icon" aria-hidden="true">📁</span>
              <span class="tree-label"><strong>{{ g.label }}</strong></span>
              <span class="tree-count">({{ g.items.length }})</span>
            </div>

            <!-- 하위 메뉴 자식 노드들 (depth 1) -->
            <div v-show="expandedGroups.has(g.key)" class="tree-children-list">
              <RouterLink
                v-for="m in g.items"
                :key="m.path"
                :to="m.path"
                class="tree-node tree-leaf-node"
                :class="{ active: isOn(m.path) }"
                :title="m.label"
                @click="handleMenuClick"
              >
                <span class="tree-branch-line" aria-hidden="true" />
                <span class="tree-menu-icon" aria-hidden="true">
                  <NavIcon :path="m.path" :code="m.code" />
                </span>
                <span class="tree-label">{{ m.label }}</span>
                <span v-if="isOn(m.path)" class="tree-active-bullet" aria-hidden="true">●</span>
              </RouterLink>
            </div>
          </div>

          <!-- 어느 묶음에도 없는 추가 메뉴 (looseMenu) -->
          <div v-if="looseMenu.length > 0" class="tree-group-box">
            <div
              class="tree-node tree-group-node"
              :class="{
                'has-active-child': looseMenu.some((m) => isOn(m.path)),
                'is-expanded': expandedGroups.has('loose')
              }"
              role="button"
              :aria-expanded="expandedGroups.has('loose')"
              tabindex="0"
              @click="toggleGroup('loose')"
              @keydown.enter.prevent="toggleGroup('loose')"
              @keydown.space.prevent="toggleGroup('loose')"
            >
              <span class="tree-toggle" aria-hidden="true">
                {{ expandedGroups.has('loose') ? '▾' : '▸' }}
              </span>
              <span class="tree-icon" aria-hidden="true">📁</span>
              <span class="tree-label"><strong>기타</strong></span>
              <span class="tree-count">({{ looseMenu.length }})</span>
            </div>

            <div v-show="expandedGroups.has('loose')" class="tree-children-list">
              <RouterLink
                v-for="m in looseMenu"
                :key="m.path"
                :to="m.path"
                class="tree-node tree-leaf-node"
                :class="{ active: isOn(m.path) }"
                :title="m.label"
                @click="handleMenuClick"
              >
                <span class="tree-branch-line" aria-hidden="true" />
                <span class="tree-menu-icon" aria-hidden="true">
                  <NavIcon :path="m.path" :code="m.code" />
                </span>
                <span class="tree-label">{{ m.label }}</span>
                <span v-if="isOn(m.path)" class="tree-active-bullet" aria-hidden="true">●</span>
              </RouterLink>
            </div>
          </div>
        </nav>
      </div>

      <!-- 하단 정보: 도움말 바로가기 -->
      <div class="drawer-footer">
        <RouterLink to="/help" class="drawer-help-link" @click="handleMenuClick">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="8" r="6" />
            <path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" />
            <circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none" />
          </svg>
          <span>도움말</span>
        </RouterLink>
        <span class="drawer-system-tag">TDMS 기술자료 관리 시스템</span>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
/* ── 배경 딤 (Backdrop) ────────────────────────────────────────── */
.nav-sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  z-index: 999;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease;
}
.nav-sidebar-backdrop.is-open {
  opacity: 1;
  pointer-events: auto;
}

/* ── 사이드바 서랍 (Drawer) ─────────────────────────────────────── */
.nav-sidebar-drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 290px;
  max-width: 82vw;
  background: var(--surface);
  border-right: 1px solid var(--border-strong);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.16);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  transform: translateX(-100%);
  /* 닫혀 있을 때는 그림자도 비치지 않고 Tab 으로도 들어가지 않게 숨긴다(밀려 나간 뒤에) */
  visibility: hidden;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s linear 0.25s;
  overflow: hidden;
}
.nav-sidebar-drawer.is-open {
  transform: translateX(0);
  visibility: visible;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s;
}

/* ── 머리글 (헤더) ─────────────────────────────────────────────── */
.drawer-header {
  height: var(--header-h, 56px);
  flex: 0 0 auto;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.drawer-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.drawer-brand-logo {
  height: 24px;
  width: auto;
}
.drawer-brand-text {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-dark-gray);
  white-space: nowrap;
}
.drawer-brand-text strong {
  font-size: 14px;
  font-weight: 800;
  color: var(--text);
  margin-right: 2px;
}

.drawer-close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-alt);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.drawer-close-btn:hover {
  background: var(--surface-sunken);
  color: var(--text);
}

/* ── 사용자 정보 카드 ─────────────────────────────────────────── */
.drawer-user-card {
  padding: 12px 14px;
  background: var(--surface-alt);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.user-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.user-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--surface-sunken);
  border: 1px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dark-gray);
  flex-shrink: 0;
}
.user-meta {
  flex: 1;
  min-width: 0;
}
.user-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.user-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-badge {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--r-pill, 999px);
  border: 1px solid var(--border);
}
.user-badge.admin {
  background: var(--ok-soft, #eef3ef);
  color: var(--ok, #3f6b52);
  border-color: var(--ok-line, #c9dace);
}
.user-badge.viewer {
  background: var(--surface-sunken);
  color: var(--text-muted);
}
.user-sub {
  font-size: 11.5px;
  color: var(--text-muted);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-actions {
  display: flex;
  gap: 6px;
}
.user-action-btn {
  flex: 1;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  box-sizing: border-box;
  font-size: 11.5px;
  font-weight: 600;
  padding: 0 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-dark-gray);
  cursor: pointer;
  white-space: nowrap;
  text-align: center;
  transition: all 0.15s ease;
}
.user-action-btn:hover {
  background: var(--surface-sunken);
  color: var(--text);
}
.user-action-btn.active {
  background: var(--surface-sunken);
  color: var(--primary, #0070c0);
  border-color: var(--primary, #0070c0);
  font-weight: 700;
}
.user-action-btn.logout-btn {
  color: var(--text-muted);
}
.user-action-btn.logout-btn:hover {
  color: var(--danger, #97453e);
}

/* ── 트리 메뉴 본문 ───────────────────────────────────────────── */
.drawer-tree-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  background: var(--surface-alt);
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.tree-head-title {
  font-weight: 700;
  color: var(--text-dark-gray);
}
.tree-head-toggle-btn {
  background: transparent;
  border: none;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.tree-head-toggle-btn:hover {
  color: var(--text);
  background: var(--surface-sunken);
}

.tree-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tree-group-box {
  display: flex;
  flex-direction: column;
}

/* 트리 부모 노드 (묶음) */
.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 8px;
  border-radius: var(--radius);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  text-decoration: none;
  transition: background 0.12s ease;
}
.tree-node:hover {
  background: var(--surface-sunken);
}

.tree-group-node {
  font-weight: 700;
  color: var(--text-dark-gray);
}
.tree-group-node.has-active-child {
  color: var(--text);
}

.tree-toggle {
  width: 16px;
  flex: 0 0 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}
.tree-icon {
  font-size: 14px;
  flex: 0 0 auto;
}
.tree-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.tree-count {
  font-size: 11px;
  color: var(--text-faint);
  font-weight: 400;
  margin-right: 4px;
}

/* 트리 하위 리프 노드 (개별 메뉴 링크) */
.tree-children-list {
  display: flex;
  flex-direction: column;
  margin-left: 12px;
  padding-left: 6px;
  border-left: 1px dashed var(--border-strong);
  gap: 2px;
}

.tree-leaf-node {
  position: relative;
  padding-left: 10px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-dark-gray);
  height: 34px;
}
.tree-leaf-node:hover {
  color: var(--text);
  background: var(--surface-sunken);
}
.tree-leaf-node.active {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 700;
}

.tree-branch-line {
  display: none;
}
.tree-menu-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.tree-leaf-node.active .tree-menu-icon {
  color: var(--text);
}
.tree-active-bullet {
  font-size: 8px;
  color: var(--accent);
  margin-left: auto;
  margin-right: 6px;
}

/* ── 하단 영역 (Footer) ────────────────────────────────────────── */
.drawer-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--surface-alt);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-muted);
}

.drawer-help-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dark-gray);
  text-decoration: none;
  font-weight: 600;
}
.drawer-help-link:hover {
  color: var(--text);
  text-decoration: underline;
}
.drawer-system-tag {
  font-size: 10.5px;
  color: var(--text-faint);
}
</style>
