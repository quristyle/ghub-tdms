<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MenuListResponse } from '@tdms/contracts'
import { api, ApiError } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { syncDynamicRoutes } from '@/router'
import NavIcon from '@/ui/NavIcon.vue'

/**
 * 메뉴 관리 — 상단/왼쪽 내비게이션에 뜨는 메뉴의 분류(폴더)·이름·경로·표시 순서·사용여부를 관리한다.
 *
 * 각 줄은 고유 화면 컴포넌트(code)와 1:1로 매핑되어 있으며, 경로는 동적 라우팅을 통해 실시간으로 반영된다.
 * 순서는 드래그앤드롭으로 손쉽게 변경할 수 있고, 카테고리와 분류(폴더)별로 그룹핑되어 관리된다.
 */

const session = useSession()
const qc = useQueryClient()

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '저장하지 못했습니다.')

const { data, isLoading } = useQuery({
  queryKey: ['menus'],
  queryFn: () => api.get<MenuListResponse>('/menus'),
  staleTime: 30_000,
})

/** 편집용 사본 */
export type Draft = {
  id: number
  code: string
  path: string
  label: string
  category: string
  isEnabled: boolean
}
const draft = ref<Draft[]>([])
const saving = ref(false)

// 뷰 모드: 'grouped' (카테고리/폴더별 보기) | 'all' (전체 순서 보기)
const viewMode = ref<'grouped' | 'all'>('grouped')

// 서버에서 받아올 때마다 사본 갱신
watch(
  data,
  (d) => {
    if (d) {
      draft.value = d.items.map((m) => ({
        id: m.id,
        code: m.code,
        path: m.path,
        label: m.label,
        category: m.category || '일반',
        isEnabled: m.isEnabled,
      }))
    }
  },
  { immediate: true },
)

const byId = computed(() => new Map((data.value?.items ?? []).map((m) => [m.id, m])))
const meta = (id: number) => byId.value.get(id)
const permissionsPath = computed(
  () => (data.value?.items ?? []).find((m) => m.code === 'permissions')?.path || '/permissions',
)

// 기존 카테고리 목록 (자동완성 및 필터용)
const existingCategories = computed(() => {
  const set = new Set<string>()
  for (const d of draft.value) {
    if (d.category.trim()) set.add(d.category.trim())
  }
  return Array.from(set)
})

// 폴더 접기/펼치기 상태
const collapsedFolders = ref<Record<string, boolean>>({})
function toggleFolder(category: string) {
  collapsedFolders.value[category] = !collapsedFolders.value[category]
}

// 카테고리별 그룹 데이터
const groupedCategories = computed(() => {
  const map = new Map<string, { category: string; items: { item: Draft; globalIndex: number }[] }>()
  draft.value.forEach((item, globalIndex) => {
    const cat = item.category.trim() || '일반'
    if (!map.has(cat)) {
      map.set(cat, { category: cat, items: [] })
    }
    map.get(cat)!.items.push({ item, globalIndex })
  })
  return Array.from(map.values())
})

const dirty = computed(() => {
  const saved = data.value?.items ?? []
  if (saved.length !== draft.value.length) return true
  return draft.value.some((d, i) => {
    const was = saved[i]
    return (
      !was ||
      d.id !== was.id ||
      d.path !== was.path ||
      d.label !== was.label ||
      d.category !== (was.category || '일반') ||
      d.isEnabled !== was.isEnabled
    )
  })
})

const duplicatePaths = computed(() => {
  const seen = new Set<string>()
  for (const d of draft.value) {
    const p = d.path.trim()
    if (p && seen.has(p)) return true
    seen.add(p)
  }
  return false
})

const invalidPath = computed(() =>
  draft.value.some((d) => !d.path.trim() || !d.path.trim().startsWith('/')) || duplicatePaths.value,
)

const invalid = computed(() =>
  draft.value.some((d) => d.label.trim() === '' || d.category.trim() === '') || invalidPath.value,
)

// ── 드래그앤드롭 (Drag and Drop) ───────────────────────────────────
const draggingIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)
const dropPosition = ref<'above' | 'below' | null>(null)

function onDragStart(event: DragEvent, globalIndex: number) {
  draggingIndex.value = globalIndex
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(globalIndex))
  }
}

function onDragOver(event: DragEvent, globalIndex: number) {
  event.preventDefault()
  if (draggingIndex.value === null || draggingIndex.value === globalIndex) {
    dragOverIndex.value = null
    dropPosition.value = null
    return
  }

  dragOverIndex.value = globalIndex
  const target = event.currentTarget as HTMLElement
  if (target) {
    const rect = target.getBoundingClientRect()
    const offset = event.clientY - rect.top
    dropPosition.value = offset < rect.height / 2 ? 'above' : 'below'
  }
}

function onDragLeave(event: DragEvent) {
  const related = event.relatedTarget as HTMLElement | null
  const current = event.currentTarget as HTMLElement | null
  if (!current || !related || !current.contains(related)) {
    // leave current row
  }
}

function onDrop(event: DragEvent, targetGlobalIndex: number) {
  event.preventDefault()
  if (draggingIndex.value === null || draggingIndex.value === targetGlobalIndex) {
    onDragEnd()
    return
  }

  const fromIndex = draggingIndex.value
  let toIndex = targetGlobalIndex
  if (dropPosition.value === 'below') {
    toIndex = fromIndex < targetGlobalIndex ? targetGlobalIndex : targetGlobalIndex + 1
  } else if (dropPosition.value === 'above') {
    toIndex = fromIndex < targetGlobalIndex ? targetGlobalIndex - 1 : targetGlobalIndex
  }

  if (toIndex < 0) toIndex = 0
  if (toIndex >= draft.value.length) toIndex = draft.value.length - 1

  const next = [...draft.value]
  const [removed] = next.splice(fromIndex, 1)
  if (!removed) {
    onDragEnd()
    return
  }
  next.splice(toIndex, 0, removed)
  draft.value = next

  onDragEnd()
}

function onDragEnd() {
  draggingIndex.value = null
  dragOverIndex.value = null
  dropPosition.value = null
}

// 보조 이동 단추 (클릭으로도 1칸 이동 가능)
function move(i: number, by: -1 | 1) {
  const j = i + by
  const next = draft.value.slice()
  const a = next[i]
  const b = next[j]
  if (!a || !b) return
  next[i] = b
  next[j] = a
  draft.value = next
}

function reset() {
  if (data.value) {
    draft.value = data.value.items.map((m) => ({
      id: m.id,
      code: m.code,
      path: m.path,
      label: m.label,
      category: m.category || '일반',
      isEnabled: m.isEnabled,
    }))
  }
  message.value = null
}

async function save() {
  if (!dirty.value || invalid.value) return
  saving.value = true
  try {
    const items = draft.value.map((d) => ({
      id: d.id,
      code: d.code,
      path: d.path.trim(),
      label: d.label.trim(),
      category: d.category.trim() || '일반',
      isEnabled: d.isEnabled,
    }))
    const out = await api.put<MenuListResponse>('/menus', { items })
    qc.setQueryData(['menus'], out)
    await qc.invalidateQueries({ queryKey: qk.me })
    await session.load()
    syncDynamicRoutes(session.menu)
    say('ok', '메뉴를 저장했습니다. 왼쪽 메뉴 및 라우터에 바로 반영됩니다.')
  } catch (e) {
    fail(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="app-main menus">
    <!-- 헤더 -->
    <div class="panel head">
      <div class="head-title">
        <h1>메뉴 관리</h1>
        <span class="head-sub">카테고리 분류 및 메뉴 순서·경로 설정</span>
      </div>
      <span style="flex:1" />
      <div class="view-toggle">
        <button
          class="btn btn-sm"
          :class="{ 'btn-primary': viewMode === 'grouped' }"
          @click="viewMode = 'grouped'"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="btn-svg">
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/>
          </svg>
          카테고리별 보기
        </button>
        <button
          class="btn btn-sm"
          :class="{ 'btn-primary': viewMode === 'all' }"
          @click="viewMode = 'all'"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="btn-svg">
            <path d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/>
          </svg>
          전체 순서 보기
        </button>
      </div>
    </div>

    <!-- 알림 메시지 -->
    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}
      <span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <!-- 메인 패널 -->
    <div class="panel main-panel">
      <div class="panel-head">
        <div class="head-left">
          <span class="panel-title">내비게이션 메뉴 구성</span>
          <span class="badge badge-subtle">{{ draft.length }}개 메뉴</span>
        </div>
        <span style="flex:1" />
        <div class="head-actions">
          <button class="btn btn-sm" :disabled="!dirty || saving" @click="reset">되돌리기</button>
          <button
            class="btn btn-sm btn-primary"
            :disabled="!dirty || invalid || saving"
            @click="save"
          >
            {{ saving ? '저장 중…' : '저장' }}
          </button>
        </div>
      </div>

      <div class="pad note muted">
        메뉴의 <strong>분류(폴더)</strong>, <strong>이름</strong>, <strong>경로</strong>,
        <strong>표시 순서</strong>, <strong>사용여부</strong>를 설정합니다. 행 좌측의 드래그 핸들(<span class="drag-icon-inline">⋮⋮</span>)을
        잡고 끌어 순서를 자유롭게 바꿀 수 있습니다. 어느 그룹에 보일지는
        <RouterLink :to="permissionsPath">접속권한 관리</RouterLink>에서 정합니다.
      </div>

      <div v-if="isLoading" class="pad muted">불러오는 중…</div>

      <div v-else class="flat-grid-wrap">
        <!-- 기존 카테고리 자동완성용 datalist -->
        <datalist id="category-list">
          <option v-for="cat in existingCategories" :key="cat" :value="cat" />
        </datalist>

        <!-- 모드 1: 카테고리(폴더)별 그룹 뷰 -->
        <div v-if="viewMode === 'grouped'" class="folder-groups-container">
          <div
            v-for="group in groupedCategories"
            :key="group.category"
            class="folder-group-card"
          >
            <!-- 폴더 헤더 -->
            <div
              class="folder-group-header"
              @click="toggleFolder(group.category)"
            >
              <div class="folder-header-left">
                <svg
                  class="folder-arrow"
                  :class="{ 'is-collapsed': collapsedFolders[group.category] }"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="folder-icon">
                  <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a1.99 1.99 0 0 1 .342-1.31z"/>
                </svg>
                <span class="folder-title">{{ group.category }}</span>
                <span class="folder-count">{{ group.items.length }}개</span>
              </div>
              <span class="folder-hint muted">클릭하여 {{ collapsedFolders[group.category] ? '펼치기' : '접기' }}</span>
            </div>

            <!-- 폴더 내부 그리드 테이블 -->
            <div v-show="!collapsedFolders[group.category]" class="folder-table-wrapper">
              <table class="flat-table">
                <thead>
                  <tr>
                    <th style="width: 70px; text-align: center;">순서</th>
                    <th style="width: 170px;">분류 (폴더)</th>
                    <th style="width: 200px;">메뉴 이름</th>
                    <th style="width: 220px;">접속 경로</th>
                    <th style="width: 80px; text-align: center;">사용</th>
                    <th style="width: 150px;">마지막 변경</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="{ item, globalIndex } in group.items"
                    :key="item.id"
                    class="flat-row"
                    :class="{
                      off: !item.isEnabled,
                      dragging: draggingIndex === globalIndex,
                      'drop-target-above': dragOverIndex === globalIndex && dropPosition === 'above',
                      'drop-target-below': dragOverIndex === globalIndex && dropPosition === 'below',
                    }"
                    draggable="true"
                    @dragstart="onDragStart($event, globalIndex)"
                    @dragover="onDragOver($event, globalIndex)"
                    @dragleave="onDragLeave"
                    @drop="onDrop($event, globalIndex)"
                    @dragend="onDragEnd"
                  >
                    <!-- 순서 & 드래그 핸들 -->
                    <td class="col-order">
                      <div class="order-cell">
                        <div class="drag-handle" title="끌어서 순서 변경">
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6-10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                          </svg>
                        </div>
                        <span class="order-num">{{ globalIndex + 1 }}</span>
                        <div class="order-buttons">
                          <button
                            class="micro-btn"
                            :disabled="globalIndex === 0"
                            title="위로"
                            @click.stop="move(globalIndex, -1)"
                          >▲</button>
                          <button
                            class="micro-btn"
                            :disabled="globalIndex === draft.length - 1"
                            title="아래로"
                            @click.stop="move(globalIndex, 1)"
                          >▼</button>
                        </div>
                      </div>
                    </td>

                    <!-- 카테고리(분류) -->
                    <td class="col-category">
                      <div class="input-with-icon">
                        <input
                          v-model="item.category"
                          class="flat-input"
                          list="category-list"
                          placeholder="분류명"
                          maxlength="40"
                          :class="{ bad: item.category.trim() === '' }"
                          :aria-label="`${item.label} 분류`"
                        />
                      </div>
                    </td>

                    <!-- 메뉴 이름 -->
                    <td class="col-label">
                      <div class="label-cell">
                        <NavIcon :path="item.path" :code="item.code" class="menu-icon" />
                        <input
                          v-model="item.label"
                          class="flat-input"
                          placeholder="메뉴 이름"
                          maxlength="40"
                          :class="{ bad: item.label.trim() === '' }"
                          :aria-label="`${item.label} 메뉴 이름`"
                        />
                      </div>
                    </td>

                    <!-- 경로 -->
                    <td class="col-path">
                      <input
                        v-model="item.path"
                        class="flat-input mono"
                        placeholder="/경로"
                        maxlength="80"
                        :class="{ bad: !item.path.trim() || !item.path.trim().startsWith('/') }"
                        :aria-label="`${item.label} 경로`"
                      />
                    </td>

                    <!-- 사용 토글 -->
                    <td class="col-enabled" style="text-align: center;">
                      <label
                        class="flat-toggle"
                        :class="{
                          checked: item.isEnabled,
                          disabled: meta(item.id)?.isFixed,
                        }"
                        :title="meta(item.id)?.isFixed ? '이 메뉴는 끌 수 없습니다 (자물쇠)' : ''"
                      >
                        <input
                          v-model="item.isEnabled"
                          type="checkbox"
                          class="sr-only"
                          :disabled="meta(item.id)?.isFixed"
                        />
                        <span class="toggle-track">
                          <span class="toggle-thumb" />
                        </span>
                      </label>
                    </td>

                    <!-- 마지막 변경 -->
                    <td class="col-meta muted sm">
                      <span>{{ meta(item.id)?.updatedAt?.slice(0, 10) ?? '-' }}</span>
                      <span v-if="meta(item.id)?.updatedBy" class="meta-by"> · {{ meta(item.id)?.updatedBy }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 모드 2: 전체 순서 보기 (플랫 그리드) -->
        <div v-else class="flat-table-wrapper">
          <table class="flat-table">
            <thead>
              <tr>
                <th style="width: 70px; text-align: center;">순서</th>
                <th style="width: 170px;">분류 (폴더)</th>
                <th style="width: 200px;">메뉴 이름</th>
                <th style="width: 220px;">접속 경로</th>
                <th style="width: 80px; text-align: center;">사용</th>
                <th style="width: 150px;">마지막 변경</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, globalIndex) in draft"
                :key="item.id"
                class="flat-row"
                :class="{
                  off: !item.isEnabled,
                  dragging: draggingIndex === globalIndex,
                  'drop-target-above': dragOverIndex === globalIndex && dropPosition === 'above',
                  'drop-target-below': dragOverIndex === globalIndex && dropPosition === 'below',
                }"
                draggable="true"
                @dragstart="onDragStart($event, globalIndex)"
                @dragover="onDragOver($event, globalIndex)"
                @dragleave="onDragLeave"
                @drop="onDrop($event, globalIndex)"
                @dragend="onDragEnd"
              >
                <!-- 순서 & 드래그 핸들 -->
                <td class="col-order">
                  <div class="order-cell">
                    <div class="drag-handle" title="끌어서 순서 변경">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6-10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                      </svg>
                    </div>
                    <span class="order-num">{{ globalIndex + 1 }}</span>
                    <div class="order-buttons">
                      <button
                        class="micro-btn"
                        :disabled="globalIndex === 0"
                        title="위로"
                        @click.stop="move(globalIndex, -1)"
                      >▲</button>
                      <button
                        class="micro-btn"
                        :disabled="globalIndex === draft.length - 1"
                        title="아래로"
                        @click.stop="move(globalIndex, 1)"
                      >▼</button>
                    </div>
                  </div>
                </td>

                <!-- 카테고리(분류) -->
                <td class="col-category">
                  <div class="input-with-icon">
                    <input
                      v-model="item.category"
                      class="flat-input"
                      list="category-list"
                      placeholder="분류명"
                      maxlength="40"
                      :class="{ bad: item.category.trim() === '' }"
                      :aria-label="`${item.label} 분류`"
                    />
                  </div>
                </td>

                <!-- 메뉴 이름 -->
                <td class="col-label">
                  <div class="label-cell">
                    <NavIcon :path="item.path" :code="item.code" class="menu-icon" />
                    <input
                      v-model="item.label"
                      class="flat-input"
                      placeholder="메뉴 이름"
                      maxlength="40"
                      :class="{ bad: item.label.trim() === '' }"
                      :aria-label="`${item.label} 메뉴 이름`"
                    />
                  </div>
                </td>

                <!-- 경로 -->
                <td class="col-path">
                  <input
                    v-model="item.path"
                    class="flat-input mono"
                    placeholder="/경로"
                    maxlength="80"
                    :class="{ bad: !item.path.trim() || !item.path.trim().startsWith('/') }"
                    :aria-label="`${item.label} 경로`"
                  />
                </td>

                <!-- 사용 토글 -->
                <td class="col-enabled" style="text-align: center;">
                  <label
                    class="flat-toggle"
                    :class="{
                      checked: item.isEnabled,
                      disabled: meta(item.id)?.isFixed,
                    }"
                    :title="meta(item.id)?.isFixed ? '이 메뉴는 끌 수 없습니다 (자물쇠)' : ''"
                  >
                    <input
                      v-model="item.isEnabled"
                      type="checkbox"
                      class="sr-only"
                      :disabled="meta(item.id)?.isFixed"
                    />
                    <span class="toggle-track">
                      <span class="toggle-thumb" />
                    </span>
                  </label>
                </td>

                <!-- 마지막 변경 -->
                <td class="col-meta muted sm">
                  <span>{{ meta(item.id)?.updatedAt?.slice(0, 10) ?? '-' }}</span>
                  <span v-if="meta(item.id)?.updatedBy" class="meta-by"> · {{ meta(item.id)?.updatedBy }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 하단 에러 메시지 -->
      <div v-if="draft.some((d) => d.category.trim() === '')" class="pad msg err">
        분류(폴더) 이름을 비울 수 없습니다.
      </div>
      <div v-else-if="draft.some((d) => d.label.trim() === '')" class="pad msg err">
        메뉴 이름을 비울 수 없습니다.
      </div>
      <div v-else-if="draft.some((d) => !d.path.trim() || !d.path.trim().startsWith('/'))" class="pad msg err">
        메뉴 경로는 '/'로 시작해야 합니다.
      </div>
      <div v-else-if="duplicatePaths" class="pad msg err">
        중복된 메뉴 경로가 있습니다.
      </div>
    </div>
  </main>
</template>

<style scoped>
.menus {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  flex: 0 0 auto;
}
.head-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.head h1 {
  font-size: var(--fs-md);
  margin: 0;
  font-weight: 700;
  color: var(--fg);
}
.head-sub {
  font-size: var(--fs-xs);
  color: var(--fg-subtle);
}

.view-toggle {
  display: flex;
  gap: 4px;
}
.btn-svg {
  margin-right: 4px;
  vertical-align: -2px;
}

.main-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-bottom: 12px;
}
.panel-head {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-title {
  font-weight: 600;
  font-size: var(--fs);
}
.badge-subtle {
  font-size: var(--fs-xs);
  padding: 2px 7px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--fg-muted);
}
.head-actions {
  display: flex;
  gap: 8px;
}

.note {
  line-height: 1.6;
  font-size: var(--fs-sm);
  padding: 10px 16px;
}
.note a {
  text-decoration: underline;
}
.drag-icon-inline {
  font-weight: bold;
  letter-spacing: -2px;
  margin: 0 2px;
}

/* ── 플랫 그리드 컨테이너 ────────────────────────────────── */
.flat-grid-wrap {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── 카테고리 폴더 카드 ──────────────────────────────────── */
.folder-groups-container {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.folder-group-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  overflow: hidden;
  transition: border-color 0.15s ease;
}
.folder-group-card:hover {
  border-color: var(--border-strong, #cbd5e1);
}

.folder-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}
.folder-group-header:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.05));
}
.folder-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.folder-arrow {
  color: var(--fg-subtle);
  transition: transform 0.2s ease;
}
.folder-arrow.is-collapsed {
  transform: rotate(-90deg);
}
.folder-icon {
  color: var(--primary);
  opacity: 0.85;
}
.folder-title {
  font-weight: 600;
  font-size: var(--fs-sm);
  color: var(--fg);
}
.folder-count {
  font-size: 11px;
  padding: 1px 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--fg-muted);
}
.folder-hint {
  font-size: var(--fs-xs);
}

.folder-table-wrapper,
.flat-table-wrapper {
  overflow-x: auto;
}

/* ── 플랫 테이블 스타일 ────────────────────────────────── */
.flat-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-sm);
}

.flat-table th {
  padding: 8px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  color: var(--fg-subtle);
  font-size: var(--fs-xs);
  font-weight: 600;
  text-align: left;
  user-select: none;
}

.flat-row {
  transition: background-color 0.1s ease;
  position: relative;
}
.flat-row td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-light, rgba(0, 0, 0, 0.05));
  vertical-align: middle;
}
.flat-row:last-child td {
  border-bottom: none;
}
.flat-row:hover {
  background: var(--surface-2);
}

/* 드래그 상태 */
.flat-row.dragging {
  opacity: 0.35;
  background: var(--primary-soft) !important;
}
.flat-row.drop-target-above td {
  border-top: 2px solid var(--primary) !important;
}
.flat-row.drop-target-below td {
  border-bottom: 2px solid var(--primary) !important;
}

/* 사용 중지 메뉴 흐리게 */
.flat-row.off td:not(.col-order):not(.col-enabled) {
  opacity: 0.55;
}

/* 순서 및 드래그 셀 */
.order-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 24px;
  color: var(--fg-subtle);
  cursor: grab;
  border-radius: 3px;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.drag-handle:hover {
  color: var(--primary);
  background: var(--surface-2);
}
.drag-handle:active {
  cursor: grabbing;
}
.order-num {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  width: 18px;
  text-align: center;
  color: var(--fg-muted);
}
.order-buttons {
  display: flex;
  flex-direction: column;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.flat-row:hover .order-buttons {
  opacity: 1;
}
.micro-btn {
  background: none;
  border: none;
  padding: 0;
  line-height: 1;
  font-size: 8px;
  color: var(--fg-subtle);
  cursor: pointer;
}
.micro-btn:hover:not(:disabled) {
  color: var(--primary);
}
.micro-btn:disabled {
  opacity: 0.25;
  cursor: default;
}

/* ── 플랫 입력 인풋 (핵심 스타일) ────────────────────────── */
.flat-input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: var(--fs-sm);
  outline: none;
  transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.flat-input:hover {
  background: var(--surface-2);
  border-color: var(--border);
}
.flat-input:focus {
  background: var(--surface);
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.flat-input.bad {
  border-color: var(--danger, #dc2626) !important;
  background: var(--danger-soft, rgba(220, 38, 38, 0.08)) !important;
}

.label-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.menu-icon {
  flex: 0 0 auto;
  color: var(--fg-muted);
}

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

/* ── 플랫 토글 스위치 ────────────────────────────────────── */
.flat-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
  vertical-align: middle;
}
.flat-toggle.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.toggle-track {
  width: 34px;
  height: 18px;
  background: var(--border-strong, #cbd5e1);
  border-radius: 9px;
  position: relative;
  transition: background-color 0.2s ease;
  display: block;
}
.flat-toggle.checked .toggle-track {
  background: var(--primary);
}
.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.flat-toggle.checked .toggle-thumb {
  transform: translateX(16px);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.sm {
  font-size: var(--fs-xs);
}
.meta-by {
  color: var(--fg-subtle);
}
</style>
