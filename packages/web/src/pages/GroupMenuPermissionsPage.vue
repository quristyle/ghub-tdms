<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { GroupListResponse, GroupMenuPermissionsResponse, GroupMenuPermissionSaveItem } from '@tdms/contracts'
import { api, ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'
import NavIcon from '@/ui/NavIcon.vue'

/**
 * 그룹 메뉴권한 관리 — 사용자 그룹별 메뉴 열람 및 C/R/U/D 버튼 권한 관리 화면.
 *
 * 각 사용자 그룹별로 메뉴의 열람(View) 여부와 화면 내 등록(C), 조회(R), 수정(U), 삭제(D) 권한을 지정한다.
 * 여기서 설정한 권한은 이후 모든 화면의 버튼에 퍼미션 속성(c, r, u, d)으로 적용된다.
 */

const qc = useQueryClient()

const say = (kind: 'ok' | 'err', text: string) => toast.show(kind, text)
const fail = (e: unknown) => toast.err(e instanceof ApiError ? e.message : '저장하지 못했습니다.')
const saving = ref(false)

// ── 그룹 목록 조회 ───────────────────────────────────────────────────────
const { data: groups, isLoading: isGroupsLoading } = useQuery({
  queryKey: ['groups'],
  queryFn: () => api.get<GroupListResponse>('/groups'),
  staleTime: 30_000,
})

const pickedGroupId = ref<number | null>(null)

// 첫 로드 시 첫 번째 그룹 자동 선택
watch(
  groups,
  (g) => {
    if (g?.items?.length && pickedGroupId.value === null) {
      pickedGroupId.value = g.items[0]?.id ?? null
    }
  },
  { immediate: true },
)

const currentGroup = computed(() =>
  groups.value?.items.find((g) => g.id === pickedGroupId.value) ?? null,
)

// ── 선택된 그룹의 메뉴 권한 조회 ───────────────────────────────────────────
const { data: menuPerms, isLoading: isPermsLoading, refetch } = useQuery({
  queryKey: ['group-menu-permissions', pickedGroupId],
  queryFn: () => api.get<GroupMenuPermissionsResponse>(`/groups/${pickedGroupId.value}/menu-permissions`),
  enabled: computed(() => pickedGroupId.value !== null),
  staleTime: 10_000,
})

export interface EditableMenuPerm {
  menuId: number
  code: string
  label: string
  category: string
  sortOrder: number
  path: string
  canView: boolean
  canCreate: boolean
  canRead: boolean
  canUpdate: boolean
  canDelete: boolean
}

const draft = ref<EditableMenuPerm[]>([])

watch(
  menuPerms,
  (res) => {
    if (res?.items) {
      draft.value = res.items.map((item) => ({ ...item }))
    }
  },
  { immediate: true },
)

// 카테고리별 그룹핑
const categories = computed(() => {
  const cats: { name: string; items: EditableMenuPerm[] }[] = []
  const map = new Map<string, EditableMenuPerm[]>()
  for (const item of draft.value) {
    const cat = item.category || '기타'
    if (!map.has(cat)) {
      const arr: EditableMenuPerm[] = []
      map.set(cat, arr)
      cats.push({ name: cat, items: arr })
    }
    map.get(cat)!.push(item)
  }
  return cats
})

// ── 컬럼 전체 선택 / 해제 계산 ────────────────────────────────────────────
const isAllViewChecked = computed({
  get: () => draft.value.length > 0 && draft.value.every((i) => i.canView),
  set: (val: boolean) => {
    for (const item of draft.value) {
      item.canView = val
      if (!val) {
        item.canCreate = false
        item.canRead = false
        item.canUpdate = false
        item.canDelete = false
      }
    }
  },
})

const isAllCreateChecked = computed({
  get: () => draft.value.length > 0 && draft.value.every((i) => i.canCreate),
  set: (val: boolean) => {
    for (const item of draft.value) {
      item.canCreate = val
      if (val) item.canView = true
    }
  },
})

const isAllReadChecked = computed({
  get: () => draft.value.length > 0 && draft.value.every((i) => i.canRead),
  set: (val: boolean) => {
    for (const item of draft.value) {
      item.canRead = val
      if (val) item.canView = true
    }
  },
})

const isAllUpdateChecked = computed({
  get: () => draft.value.length > 0 && draft.value.every((i) => i.canUpdate),
  set: (val: boolean) => {
    for (const item of draft.value) {
      item.canUpdate = val
      if (val) item.canView = true
    }
  },
})

const isAllDeleteChecked = computed({
  get: () => draft.value.length > 0 && draft.value.every((i) => i.canDelete),
  set: (val: boolean) => {
    for (const item of draft.value) {
      item.canDelete = val
      if (val) item.canView = true
    }
  },
})

// 행(Row) 전체 선택 여부 확인 및 토글
function isRowAllChecked(item: EditableMenuPerm) {
  return item.canView && item.canCreate && item.canRead && item.canUpdate && item.canDelete
}

function toggleRowAll(item: EditableMenuPerm) {
  const next = !isRowAllChecked(item)
  item.canView = next
  item.canCreate = next
  item.canRead = next
  item.canUpdate = next
  item.canDelete = next
}

// 메뉴 열람(View) 해제 시 CRUD 자동 해제 연동
function onViewToggle(item: EditableMenuPerm) {
  if (!item.canView) {
    item.canCreate = false
    item.canRead = false
    item.canUpdate = false
    item.canDelete = false
  } else {
    item.canRead = true
  }
}

// CRUD 체크 시 자동으로 열람(View)도 켜지도록 연동
function onCrudToggle(item: EditableMenuPerm) {
  if (item.canCreate || item.canRead || item.canUpdate || item.canDelete) {
    item.canView = true
  }
}

// ── 빠른 일괄 변경 액션 ───────────────────────────────────────────────────
function setBatchMode(mode: 'all' | 'none' | 'readonly') {
  for (const item of draft.value) {
    if (mode === 'all') {
      item.canView = true
      item.canCreate = true
      item.canRead = true
      item.canUpdate = true
      item.canDelete = true
    } else if (mode === 'none') {
      item.canView = false
      item.canCreate = false
      item.canRead = false
      item.canUpdate = false
      item.canDelete = false
    } else if (mode === 'readonly') {
      item.canView = true
      item.canCreate = false
      item.canRead = true
      item.canUpdate = false
      item.canDelete = false
    }
  }
}

// ── 저장 처리 ────────────────────────────────────────────────────────────
async function onSave() {
  if (!pickedGroupId.value) return
  saving.value = true
  try {
    const payload: { permissions: GroupMenuPermissionSaveItem[] } = {
      permissions: draft.value.map((i) => ({
        menuId: i.menuId,
        canView: i.canView,
        canCreate: i.canCreate,
        canRead: i.canRead,
        canUpdate: i.canUpdate,
        canDelete: i.canDelete,
      })),
    }
    await api.put(`/groups/${pickedGroupId.value}/menu-permissions`, payload)
    await qc.invalidateQueries({ queryKey: ['group-menu-permissions', pickedGroupId.value] })
    say('ok', `${currentGroup.value?.name ?? '그룹'}의 메뉴 권한이 성공적으로 저장되었습니다.`)
  } catch (e) {
    fail(e)
  } finally {
    saving.value = false
  }
}

function onReset() {
  refetch()
}
</script>

<template>
  <div class="page-container">
    <!-- 상단 헤더 -->
    <header class="page-header">
      <div class="title-wrap">
        <h1 class="page-title">그룹 메뉴권한 관리</h1>
        <p class="page-desc">
          사용자 그룹별 상단/사이드바 메뉴 열람 여부와 각 화면의 등록(C), 조회(R), 수정(U), 삭제(D) 권한을 통합 관리합니다.
        </p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn btn-secondary" :disabled="saving || isPermsLoading" @click="onReset">
          새로고침
        </button>
        <button type="button" class="btn btn-primary" :disabled="saving || isPermsLoading || !pickedGroupId" @click="onSave">
          {{ saving ? '저장 중…' : '권한 저장' }}
        </button>
      </div>
    </header>

    <!-- 메인 레이아웃: 좌측 그룹 목록 / 우측 메뉴 권한 매트릭스 -->
    <div class="layout-body">
      <!-- 좌측 패널: 그룹 선택 -->
      <aside class="group-panel">
        <div class="panel-header">
          <span class="panel-title">사용자 그룹</span>
          <span class="badge">{{ groups?.items.length ?? 0 }}개</span>
        </div>
        <div class="group-list">
          <div
            v-for="g in groups?.items"
            :key="g.id"
            class="group-card"
            :class="{ active: pickedGroupId === g.id }"
            @click="pickedGroupId = g.id"
          >
            <div class="group-card-top">
              <span class="group-name">{{ g.name }}</span>
              <span class="member-count">{{ g.memberCount }}명</span>
            </div>
            <div class="group-desc">{{ g.description || '설명 없음' }}</div>
          </div>
          <div v-if="!groups?.items.length && !isGroupsLoading" class="empty-hint">
            등록된 그룹이 없습니다.
          </div>
        </div>
      </aside>

      <!-- 우측 패널: 메뉴별 CRUD 권한 그리드 -->
      <main class="perm-panel">
        <div class="perm-panel-header">
          <div class="group-info">
            <span class="group-badge">선택 그룹</span>
            <strong class="selected-name">{{ currentGroup?.name ?? '그룹을 선택하세요' }}</strong>
            <span v-if="currentGroup?.description" class="selected-desc">({{ currentGroup.description }})</span>
          </div>

          <div class="batch-buttons">
            <span class="batch-label">일괄 설정:</span>
            <button type="button" class="btn-chip" @click="setBatchMode('all')">전체 허용</button>
            <button type="button" class="btn-chip" @click="setBatchMode('readonly')">조회(R)만 허용</button>
            <button type="button" class="btn-chip" @click="setBatchMode('none')">전체 차단</button>
          </div>
        </div>

        <div class="perm-notice">
          <span class="notice-icon">💡</span>
          <span class="notice-text">
            <strong>열람</strong> 권한이 켜져야 메뉴가 노출되며, <strong>C·R·U·D</strong> 권한은 각 화면 내부 버튼의
            <code>permission="c,r,u,d"</code> 및 <code>v-permission</code> 속성에 실시간 반영됩니다.
          </span>
        </div>

        <div class="table-container">
          <table class="perm-table">
            <thead>
              <tr>
                <th class="col-category">분류</th>
                <th class="col-menu">메뉴명 (화면코드)</th>
                <th class="col-path">경로</th>
                <th class="col-check">
                  <label class="th-label">
                    <input type="checkbox" v-model="isAllViewChecked" />
                    <span>열람(접근)</span>
                  </label>
                </th>
                <th class="col-check">
                  <label class="th-label">
                    <input type="checkbox" v-model="isAllCreateChecked" />
                    <span>등록(C)</span>
                  </label>
                </th>
                <th class="col-check">
                  <label class="th-label">
                    <input type="checkbox" v-model="isAllReadChecked" />
                    <span>조회(R)</span>
                  </label>
                </th>
                <th class="col-check">
                  <label class="th-label">
                    <input type="checkbox" v-model="isAllUpdateChecked" />
                    <span>수정(U)</span>
                  </label>
                </th>
                <th class="col-check">
                  <label class="th-label">
                    <input type="checkbox" v-model="isAllDeleteChecked" />
                    <span>삭제(D)</span>
                  </label>
                </th>
                <th class="col-action">행 전체</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="cat in categories" :key="cat.name">
                <tr class="category-header-row">
                  <td colspan="9" class="category-cell">
                    📁 {{ cat.name }} <span class="cat-count">({{ cat.items.length }}개 메뉴)</span>
                  </td>
                </tr>
                <tr
                  v-for="item in cat.items"
                  :key="item.menuId"
                  class="menu-data-row"
                  :class="{ disabled: !item.canView }"
                >
                  <td class="cell-category">{{ item.category }}</td>
                  <td class="cell-menu">
                    <div class="menu-name-wrap">
                      <NavIcon :path="item.path" :code="item.code" class="menu-icon" />
                      <span class="menu-label">{{ item.label }}</span>
                      <code class="menu-code">{{ item.code }}</code>
                    </div>
                  </td>
                  <td class="cell-path">
                    <span class="path-text">{{ item.path }}</span>
                  </td>
                  <!-- 열람 체크박스 -->
                  <td class="cell-check">
                    <label class="checkbox-box">
                      <input
                        type="checkbox"
                        v-model="item.canView"
                        @change="onViewToggle(item)"
                      />
                    </label>
                  </td>
                  <!-- C: 등록 체크박스 -->
                  <td class="cell-check">
                    <label class="checkbox-box" :class="{ muted: !item.canView }">
                      <input
                        type="checkbox"
                        v-model="item.canCreate"
                        @change="onCrudToggle(item)"
                      />
                    </label>
                  </td>
                  <!-- R: 조회 체크박스 -->
                  <td class="cell-check">
                    <label class="checkbox-box" :class="{ muted: !item.canView }">
                      <input
                        type="checkbox"
                        v-model="item.canRead"
                        @change="onCrudToggle(item)"
                      />
                    </label>
                  </td>
                  <!-- U: 수정 체크박스 -->
                  <td class="cell-check">
                    <label class="checkbox-box" :class="{ muted: !item.canView }">
                      <input
                        type="checkbox"
                        v-model="item.canUpdate"
                        @change="onCrudToggle(item)"
                      />
                    </label>
                  </td>
                  <!-- D: 삭제 체크박스 -->
                  <td class="cell-check">
                    <label class="checkbox-box" :class="{ muted: !item.canView }">
                      <input
                        type="checkbox"
                        v-model="item.canDelete"
                        @change="onCrudToggle(item)"
                      />
                    </label>
                  </td>
                  <!-- 행 전체 토글 단추 -->
                  <td class="cell-action">
                    <button
                      type="button"
                      class="btn-row-toggle"
                      :class="{ 'btn-all-on': isRowAllChecked(item) }"
                      @click="toggleRowAll(item)"
                    >
                      {{ isRowAllChecked(item) ? '전체해제' : '전체선택' }}
                    </button>
                  </td>
                </tr>
              </template>

              <tr v-if="!draft.length && !isPermsLoading">
                <td colspan="9" class="cell-empty">메뉴 목록이 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.page-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 1.25rem 1.5rem;
  box-sizing: border-box;
  gap: 1rem;
  background-color: var(--bg-app, #f8fafc);
  overflow: hidden;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.title-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.page-title {
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--text-heading, #0f172a);
  margin: 0;
}

.page-desc {
  font-size: 0.85rem;
  color: var(--text-muted, #64748b);
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.45rem 1rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--bg-card, #ffffff);
  border-color: var(--border, #cbd5e1);
  color: var(--text, #334155);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-hover, #f1f5f9);
}

.btn-primary {
  background: var(--brand, #0284c7);
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--brand-hover, #0369a1);
}

.message-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  border-radius: 6px;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.message-banner.ok {
  background-color: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #065f46;
}

.message-banner.err {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

.btn-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  color: inherit;
}

/* 본문 2열 레이아웃 */
.layout-body {
  display: flex;
  gap: 1.25rem;
  flex: 1;
  min-height: 0;
}

/* 좌측 그룹 패널 */
.group-panel {
  width: 280px;
  flex-shrink: 0;
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border, #e2e8f0);
  background: var(--bg-subtle, #f8fafc);
}

.panel-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text-heading, #1e293b);
}

.badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.45rem;
  border-radius: 9999px;
  background: var(--bg-app, #e2e8f0);
  color: var(--text-muted, #475569);
  font-weight: 600;
}

.group-list {
  display: flex;
  flex-direction: column;
  padding: 0.5rem;
  gap: 0.35rem;
  overflow-y: auto;
  flex: 1;
}

.group-card {
  padding: 0.65rem 0.85rem;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
  background: var(--bg-card, #ffffff);
}

.group-card:hover {
  background: var(--bg-hover, #f1f5f9);
}

.group-card.active {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.group-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.group-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-heading, #0f172a);
}

.group-card.active .group-name {
  color: var(--brand, #0284c7);
}

.member-count {
  font-size: 0.75rem;
  color: var(--text-muted, #64748b);
}

.group-desc {
  font-size: 0.78rem;
  color: var(--text-muted, #64748b);
  margin-top: 0.25rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-hint {
  padding: 1.5rem;
  text-align: center;
  color: var(--text-muted, #94a3b8);
  font-size: 0.85rem;
}

/* 우측 권한 매트릭스 패널 */
.perm-panel {
  flex: 1;
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.perm-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border, #e2e8f0);
  background: var(--bg-subtle, #f8fafc);
  flex-wrap: wrap;
  gap: 0.5rem;
}

.group-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.group-badge {
  font-size: 0.72rem;
  font-weight: 700;
  background: var(--brand, #0284c7);
  color: #fff;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}

.selected-name {
  font-size: 0.95rem;
  color: var(--text-heading, #0f172a);
}

.selected-desc {
  font-size: 0.82rem;
  color: var(--text-muted, #64748b);
}

.batch-buttons {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.batch-label {
  font-size: 0.78rem;
  color: var(--text-muted, #64748b);
  margin-right: 0.2rem;
}

.btn-chip {
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border, #cbd5e1);
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text, #334155);
  font-weight: 500;
}

.btn-chip:hover {
  background: var(--bg-hover, #f1f5f9);
  border-color: #94a3b8;
}

.perm-notice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  background: #f0fdf4;
  border-bottom: 1px solid #dcfce7;
  font-size: 0.8rem;
  color: #166534;
}

.notice-icon {
  font-size: 0.9rem;
}

.notice-text code {
  background: rgba(0, 0, 0, 0.06);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-size: 0.75rem;
}

/* 권한 테이블 */
.table-container {
  flex: 1;
  overflow: auto;
}

.perm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.84rem;
  text-align: left;
}

.perm-table thead th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle, #f8fafc);
  z-index: 10;
  border-bottom: 2px solid var(--border, #cbd5e1);
  padding: 0.65rem 0.75rem;
  font-weight: 600;
  color: var(--text-heading, #1e293b);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.th-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  cursor: pointer;
}

.col-category {
  width: 110px;
}

.col-menu {
  width: 220px;
}

.col-path {
  width: 140px;
}

.col-check {
  width: 90px;
  text-align: center;
}

.col-action {
  width: 85px;
  text-align: center;
}

.category-header-row td {
  background: var(--bg-app, #f1f5f9);
  padding: 0.45rem 0.85rem;
  font-weight: 700;
  color: var(--text-heading, #334155);
  font-size: 0.8rem;
  border-top: 1px solid var(--border, #e2e8f0);
  border-bottom: 1px solid var(--border, #e2e8f0);
}

.cat-count {
  font-weight: normal;
  color: var(--text-muted, #64748b);
  font-size: 0.75rem;
  margin-left: 0.25rem;
}

.menu-data-row {
  border-bottom: 1px solid var(--border, #f1f5f9);
  transition: background 0.1s ease;
}

.menu-data-row:hover {
  background: var(--bg-hover, #f8fafc);
}

.menu-data-row.disabled {
  background: #fafafa;
  opacity: 0.75;
}

.menu-data-row td {
  padding: 0.55rem 0.75rem;
  vertical-align: middle;
}

.cell-category {
  color: var(--text-muted, #64748b);
  font-size: 0.8rem;
}

.menu-name-wrap {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.menu-icon {
  flex-shrink: 0;
  color: var(--brand, #0284c7);
}

.menu-label {
  font-weight: 600;
  color: var(--text-heading, #0f172a);
}

.menu-code {
  font-size: 0.72rem;
  background: var(--bg-app, #e2e8f0);
  color: var(--text-muted, #475569);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}

.path-text {
  font-family: monospace;
  font-size: 0.78rem;
  color: var(--text-muted, #64748b);
}

.cell-check {
  text-align: center;
}

.checkbox-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.checkbox-box input[type='checkbox'] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--brand, #0284c7);
}

.checkbox-box.muted input[type='checkbox'] {
  opacity: 0.4;
}

.cell-action {
  text-align: center;
}

.btn-row-toggle {
  padding: 0.2rem 0.5rem;
  font-size: 0.72rem;
  border: 1px solid var(--border, #cbd5e1);
  background: #ffffff;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-muted, #475569);
}

.btn-row-toggle:hover {
  background: var(--bg-hover, #f1f5f9);
}

.btn-row-toggle.btn-all-on {
  background: #eff6ff;
  border-color: #93c5fd;
  color: var(--brand, #0284c7);
  font-weight: 600;
}

.cell-empty {
  text-align: center;
  padding: 2.5rem;
  color: var(--text-muted, #94a3b8);
}
</style>
