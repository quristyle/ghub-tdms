<script setup lang="ts" generic="T extends { id: number }">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { downloadXlsx } from '@/lib/xlsx'
import { compareRows, getCellValue, isSortable, type SortDir } from './gridSort'

/**
 * 가상 스크롤 표.
 *
 * 3만 행이어도 DOM 노드는 보이는 40행 정도만 유지한다.
 *
 * 갖춘 것
 *   · 순번 열
 *   · 컬럼 너비 끌어서 조절 (화면마다 기억한다)
 *   · 머리글 눌러 정렬
 *   · 머리글 아래 칸별 거르기
 *   · 아래쪽에 전체·불러온·보이는·선택 건수와 고른 줄 순번
 *   · 아래쪽 엑셀 내려받기 — **화면에 보이는 그대로**(지금 칸 순서·거른 결과)
 *   · 칸 슬롯 — 링크·배지·단추 같은 것을 칸 안에 넣을 수 있다
 *   · 줄 상태 색 — 미입고·확인필요처럼 한눈에 보여야 하는 줄
 *
 * ## 칸 슬롯과 render 는 역할이 다르다
 *
 * `render` 는 **그 칸의 글자값**이다 — 거르기·툴팁·엑셀이 이것을 쓴다.
 * 슬롯은 **그 글자를 어떻게 그릴지**만 바꾼다.
 * 그래서 슬롯을 쓰더라도 `render` 를 함께 주어야 거르기와 엑셀이 맞는다.
 * (슬롯만 주고 render 를 빼면 엑셀에 빈 칸이 나간다 — 받은 사람이 알 수 없다.)
 *
 *     <DataTable :columns="cols" :rows="rows">
 *       <template #cell:title="{ row }">
 *         <RouterLink :to="`/documents/${row.id}`">{{ row.title }}</RouterLink>
 *       </template>
 *     </DataTable>
 *
 * ## 정렬과 거르기의 범위가 다르다
 *
 * 목록은 서버가 한 번에 200건씩 준다(keyset 페이징). 그래서
 *   · **정렬은 서버가 한다** — 200건만 정렬하면 "가장 큰 값"이 실제로는 아닐 수 있다.
 *     `sortable` 을 켜면 머리글 클릭이 `sort` 로 올라가고, 쓰는 쪽이 서버에 다시 묻는다.
 *   · **거르기는 불러온 것 안에서 한다** — 빠른 훑기용이다.
 *     그래서 아래쪽에 전체·불러온·보이는 건수를 **모두** 적는다. 범위를 감추지 않는다.
 */

export interface Column<T> {
  key: string
  label: string
  /** 비우면 남는 자리를 나눠 갖는다 */
  width?: string
  align?: 'left' | 'center' | 'right'
  render?: (row: T) => string
  /** 이 칸으로 정렬할 수 있는가 (기본: 그렇다. 정렬을 막으려면 false 로 지정한다) */
  sortable?: boolean
  /** 이 칸을 거를 수 있는가 (기본: 그렇다) */
  filterable?: boolean
  /** 엑셀에 내보낼지 (기본: 그렇다) */
  exportable?: boolean
}

export type { SortDir }

/**
 * Boolean prop 은 넘기지 않으면 Vue 가 **false 로 바꾼다**(undefined 가 아니다).
 * 그래서 "기본은 보인다" 인 것들은 withDefaults 로 못박아야 한다 —
 * 실제로 순번 열과 거르기 줄이 통째로 안 나왔다.
 */
const props = withDefaults(defineProps<{
  columns: Column<T>[]
  rows: T[]
  selectable?: boolean
  selected?: Set<number>
  rowHeight?: number
  loading?: boolean
  emptyText?: string
  /** 서버가 아는 전체 건수 (불러온 것보다 많을 수 있다) */
  total?: number | null
  /** 지금 정렬 상태 (서버 정렬 시 상위에서 제어) */
  sortKey?: string
  sortDir?: SortDir
  /** 기본 정렬 상태 (클라이언트 정렬 시 초기값) */
  defaultSortKey?: string
  defaultSortDir?: SortDir
  /** 너비·거르기를 기억할 이름. 화면마다 다르게 준다. */
  storageKey?: string
  /** 순번 열을 보일지 */
  rowNumber?: boolean
  /** 거르기 줄을 보일지 */
  filterRow?: boolean
  /** 엑셀 내려받기 단추를 보일지 */
  excel?: boolean
  /** 내려받을 파일·시트 이름. 없으면 storageKey, 그것도 없으면 '목록'. */
  excelName?: string
  /** 줄에 붙일 상태 class — base.css 의 warn/issue/off/cur 를 그대로 쓴다 */
  rowClass?: (row: T) => string
  /**
   * 내용만큼만 높이를 차지한다.
   *
   * 기본은 부모를 꽉 채운다(목록 화면). 하지만 자료 상세처럼 한 화면에 표가
   * 여럿이고 줄이 서너 개뿐인 곳에서는 그게 **빈 상자**가 된다.
   * 켜면 줄 수만큼만 자라고 maxHeight 를 넘을 때만 스크롤한다.
   */
  autoHeight?: boolean
  /** autoHeight 일 때의 한계 높이(px) */
  maxHeight?: number
  /** 무한 스크롤: 다음 페이지가 더 있는지 */
  hasMore?: boolean
  /** 무한 스크롤: 다음 페이지를 불러오는 중인지 */
  loadingMore?: boolean
  /** 서버 비동기 엑셀 내보내기 단추를 보일지 */
  serverExcel?: boolean
  /** 서버 엑셀 버튼 라벨 */
  serverExcelLabel?: string
  /** 서버 엑셀 생성 중 여부 */
  serverExporting?: boolean
}>(), {
  rowNumber: true,
  filterRow: true,
  excel: true,
  maxHeight: 420,
})

const emit = defineEmits<{
  rowClick: [row: T]
  rowHover: [row: T]
  toggle: [id: number]
  toggleAll: [checked: boolean]
  sort: [key: string, dir: SortDir]
  loadMore: []
  exportServer: []
}>()

const rowH = computed(() => props.rowHeight ?? 30)

/** autoHeight 일 때 스크롤 영역이 가질 높이 — 줄 수만큼, 한계까지만. */
const scrollStyle = computed(() =>
  props.autoHeight ? { maxHeight: `${props.maxHeight}px` } : undefined,
)
const showNo = computed(() => props.rowNumber)
const showFilter = computed(() => props.filterRow)

// ── 거르기 및 정렬 ───────────────────────────────────────────────────────
const filters = ref<Record<string, string>>({})

const innerSortKey = ref<string | null>(props.defaultSortKey ?? null)
const innerSortDir = ref<SortDir>(props.defaultSortDir ?? 'asc')

const currentSortKey = computed(() => props.sortKey ?? innerSortKey.value)
const currentSortDir = computed(() =>
  props.sortKey !== undefined ? (props.sortDir ?? 'asc') : innerSortDir.value,
)

const visible = computed(() => {
  const active = Object.entries(filters.value).filter(([, v]) => v.trim() !== '')
  let list = props.rows
  if (active.length) {
    list = list.filter((row) =>
      active.every(([key, needle]) => {
        const col = props.columns.find((c) => c.key === key)
        if (!col) return true
        return cell(row, col).toLowerCase().includes(needle.trim().toLowerCase())
      }),
    )
  }

  // 상위 제어(서버 정렬 등 props.sortKey 가 직접 넘어오는 경우)가 아니고,
  // 클라이언트 정렬 대상 키가 설정되어 있으면 내부에서 정렬을 수행한다.
  if (props.sortKey === undefined && innerSortKey.value) {
    const sortCol = props.columns.find((c) => c.key === innerSortKey.value)
    if (sortCol) {
      const dir = innerSortDir.value
      list = [...list].sort((a, b) => compareRows(a, b, sortCol, dir))
    }
  }

  return list
})

const filtering = computed(() => Object.values(filters.value).some((v) => v.trim() !== ''))
function clearFilters() { filters.value = {} }

// ── 너비 (끌어서 조절, 화면마다 기억) ──────────────────────────────────
const widths = ref<Record<string, number>>({})

const storeName = computed(() => (props.storageKey ? `tdms.cols.${props.storageKey}` : null))

watch(
  storeName,
  (name) => {
    widths.value = {}
    if (!name) return
    try {
      const saved = localStorage.getItem(name)
      if (saved) widths.value = JSON.parse(saved) as Record<string, number>
    } catch { /* 저장된 값이 깨졌으면 기본값으로 간다 */ }
  },
  { immediate: true },
)

function saveWidths() {
  if (!storeName.value) return
  try { localStorage.setItem(storeName.value, JSON.stringify(widths.value)) } catch { /* 용량 초과 등 — 무시 */ }
}

/** 칸 하나의 자리 차지 방식. 너비를 정한 칸은 고정, 안 정한 칸이 남는 자리를 나눠 갖는다. */
function cellStyle(col: Column<T>) {
  const w = widths.value[col.key] ?? parsePx(col.width)
  const align = col.align ?? 'left'
  return w !== null
    ? { flex: `0 0 ${w}px`, width: `${w}px`, textAlign: align }
    : { flex: `1 1 ${FLEX_MIN}px`, minWidth: `${FLEX_MIN}px`, textAlign: align }
}

/**
 * 너비를 안 정한 칸의 최소 폭.
 *
 * 고정 폭의 합이 화면보다 넓어지면 flex 는 남은 칸을 짓눌러 버린다 —
 * 실제로 `내용` 칸이 88px 까지 줄어 글자를 가렸다.
 * 짓누르는 대신 가로로 넘치게 하고, 표가 가로로 스크롤되게 한다.
 */
const FLEX_MIN = 220

function parsePx(v?: string): number | null {
  if (!v) return null
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

const MIN_W = 48
let drag: { key: string; startX: number; startW: number } | null = null

function startResize(ev: PointerEvent, col: Column<T>) {
  const headCell = (ev.target as HTMLElement).closest('.dt-cell') as HTMLElement | null
  if (!headCell) return
  ev.preventDefault()
  ev.stopPropagation()
  drag = {
    key: col.key,
    startX: ev.clientX,
    startW: widths.value[col.key] ?? headCell.getBoundingClientRect().width,
  }
  window.addEventListener('pointermove', onResize)
  window.addEventListener('pointerup', endResize, { once: true })
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResize(ev: PointerEvent) {
  if (!drag) return
  widths.value = { ...widths.value, [drag.key]: Math.max(MIN_W, Math.round(drag.startW + ev.clientX - drag.startX)) }
}

function endResize() {
  window.removeEventListener('pointermove', onResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  drag = null
  saveWidths()
}

/** 두 번 누르면 그 칸의 너비를 되돌린다 */
function resetWidth(col: Column<T>) {
  const next = { ...widths.value }
  delete next[col.key]
  widths.value = next
  saveWidths()
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  // 떠난 뒤에 타이머가 터지면 없는 화면을 위해 요청이 한 발 나간다
  cancelHover()
})

// ── 정렬 ────────────────────────────────────────────────────────────────
function onHeaderClick(col: Column<T>) {
  if (!isSortable(col)) return
  const dir: SortDir =
    currentSortKey.value === col.key && currentSortDir.value === 'asc' ? 'desc' : 'asc'

  if (props.sortKey === undefined) {
    innerSortKey.value = col.key
    innerSortDir.value = dir
  }
  emit('sort', col.key, dir)
}

// ── 가상 스크롤 ─────────────────────────────────────────────────────────
const scrollEl = ref<HTMLElement | null>(null)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: visible.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => rowH.value,
    overscan: 12,
  })),
)
const items = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

// 목록 조건이 바뀌었을 때만 맨 위로 (무한 스크롤 추가 적재 시에는 스크롤 위치 유지)
watch(
  () => props.rows,
  (next, prev) => {
    if (!prev?.length || !next?.length || prev[0]?.id !== next[0]?.id) {
      scrollEl.value?.scrollTo({ top: 0 })
    }
  },
)

// ── 무한 스크롤 트리거 ──────────────────────────────────────────────────
function checkLoadMore() {
  if (!props.hasMore || props.loadingMore || props.loading) return
  emit('loadMore')
}

watch(items, (currentItems) => {
  if (!props.hasMore || props.loadingMore || props.loading) return
  const last = currentItems.at(-1)
  if (!last) return
  if (last.index >= visible.value.length - 15) {
    checkLoadMore()
  }
})

function onScroll(ev: Event) {
  if (!props.hasMore || props.loadingMore || props.loading) return
  const el = ev.target as HTMLElement
  if (!el) return
  const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
  if (remaining < 300) {
    checkLoadMore()
  }
}

// ── 선택 ────────────────────────────────────────────────────────────────
const allChecked = computed(
  () => visible.value.length > 0 && visible.value.every((r) => props.selected?.has(r.id)),
)
const someChecked = computed(
  () => !allChecked.value && visible.value.some((r) => props.selected?.has(r.id)),
)
const selectedCount = computed(() => props.selected?.size ?? 0)

/** 마지막으로 누른 줄 — 아래쪽에 "123번째 줄" 로 보여 준다 */
const activeId = ref<number | null>(null)
const activeIndex = computed(() => {
  if (activeId.value === null) return null
  const i = visible.value.findIndex((r) => r.id === activeId.value)
  return i < 0 ? null : i + 1
})

function onRowClick(row: T) {
  activeId.value = row.id
  emit('rowClick', row)
}

/**
 * rowHover 는 **머무른 뒤에** 쏜다.
 *
 * 듣는 쪽이 이걸로 상세를 미리 받는다(TdbListPage 의 prefetch). mouseenter 를 그대로
 * 흘려보내면 그리드를 한 번 쓸 때 지나친 행마다 요청이 한 발씩 나간다 — 200건 목록을
 * 세로로 훑으면 수십 건이 한꺼번에 뜨고, 그 대부분은 누를 생각도 없던 행이다.
 *
 * 120ms 는 "눈이 멈춘" 자리를 고르는 값이다. 올리고 → 확인하고 → 누르기까지는 그보다
 * 한참 걸리므로 미리 받는 이득은 그대로 남는다. 스쳐 간 행은 타이머가 취소된다.
 */
const HOVER_DELAY_MS = 120
let hoverTimer: ReturnType<typeof setTimeout> | undefined

function cancelHover() {
  if (hoverTimer !== undefined) {
    clearTimeout(hoverTimer)
    hoverTimer = undefined
  }
}

function onRowEnter(row: T) {
  cancelHover()
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined
    emit('rowHover', row)
  }, HOVER_DELAY_MS)
}

function cell(row: T, col: Column<T>): string {
  return getCellValue(row, col)
}

const n = (v: number) => v.toLocaleString('ko-KR')

// ── 엑셀 내려받기 ───────────────────────────────────────────────────────
// 담는 것은 **지금 보이는 것**이다 — 칸 순서도, 거른 결과도 화면과 같다.
// 서버에 더 남아 있으면(total > rows.length) 아래쪽에 그렇게 적혀 있으므로
// 사람이 "이게 전부가 아니다"를 알 수 있다. 전체가 필요하면 화면이 따로
// 서버 내보내기를 둔다(수만 건은 워커가 만든다).
const exporting = ref(false)

async function exportExcel() {
  if (exporting.value || !visible.value.length) return
  exporting.value = true
  try {
    const name = props.excelName ?? props.storageKey ?? '목록'
    const exportColumns = props.columns.filter((column) => column.exportable !== false)
    await downloadXlsx(name, {
      sheetName: name,
      headers: [...(showNo.value ? ['No'] : []), ...exportColumns.map((c) => c.label)],
      rows: visible.value.map((row, i) => [
        ...(showNo.value ? [String(i + 1)] : []),
        ...exportColumns.map((c) => cell(row, c)),
      ]),
    })
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="dt" :class="{ auto: autoHeight }" :style="{ '--row-h': `${rowH}px` }">
    <!-- 머리글·거르기·본문이 한 스크롤 안에 있다 —
         가로로 밀면 머리글과 줄이 함께 움직이고, 세로로 내려도 머리글은 붙어 있다. -->
    <div ref="scrollEl" class="dt-scroll" :style="scrollStyle" @scroll.passive="onScroll">
      <div class="dt-inner">
      <!-- 머리글 -->
      <div class="dt-head" role="row">
        <div v-if="showNo" class="dt-cell dt-no" title="순번">No</div>

        <div v-if="selectable" class="dt-cell dt-check">
          <input
            type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked"
            :aria-label="allChecked ? '전체 선택 해제' : '보이는 줄 전체 선택'"
            @change="emit('toggleAll', ($event.target as HTMLInputElement).checked)"
          />
        </div>

        <div
          v-for="col in columns" :key="col.key"
          class="dt-cell dt-th" :class="{ sortable: isSortable(col), sorted: currentSortKey === col.key }"
          :style="cellStyle(col)"
          :title="isSortable(col) ? `${col.label} — 눌러서 정렬` : col.label"
          :aria-sort="currentSortKey === col.key ? (currentSortDir === 'asc' ? 'ascending' : 'descending') : undefined"
          @click="onHeaderClick(col)"
        >
          <span class="dt-th-label">{{ col.label }}</span>
          <span v-if="isSortable(col)" class="dt-sort" :class="{ on: currentSortKey === col.key }">
            {{ currentSortKey === col.key ? (currentSortDir === 'asc' ? '▲' : '▼') : '▲' }}
          </span>
          <span
            class="dt-grip" title="끌어서 너비 조절 · 두 번 눌러 되돌리기"
            @pointerdown="startResize($event, col)"
            @dblclick.stop="resetWidth(col)"
            @click.stop
          />
        </div>
      </div>

      <!-- 거르기 줄 -->
      <div v-if="showFilter" class="dt-filter" role="row">
        <div v-if="showNo" class="dt-cell dt-no">
          <button
            v-if="filtering" class="dt-clear" title="거르기 지우기"
            aria-label="거르기 지우기" @click="clearFilters"
          >✕</button>
        </div>
        <div v-if="selectable" class="dt-cell dt-check" />
        <div v-for="col in columns" :key="col.key" class="dt-cell" :style="cellStyle(col)">
          <input
            v-if="col.filterable !== false"
            v-model="filters[col.key]"
            type="text" class="dt-finput" :placeholder="col.label"
            :aria-label="`${col.label} 거르기`"
          />
        </div>
      </div>

      <!-- 본문 -->
        <div v-if="loading" class="dt-empty muted">불러오는 중…</div>
        <div v-else-if="!rows.length" class="dt-empty muted">{{ emptyText ?? '자료가 없습니다.' }}</div>
        <div v-else-if="!visible.length" class="dt-empty muted">
          거른 결과가 없습니다.
          <button class="btn btn-sm" style="margin-left:8px" @click="clearFilters">거르기 지우기</button>
        </div>

        <div
          v-else class="dt-rows" :style="{ height: `${totalSize}px` }"
          @mouseleave="cancelHover"
        >
          <div
            v-for="v in items" :key="visible[v.index]!.id"
            class="dt-row"
            :class="[rowClass?.(visible[v.index]!), { active: visible[v.index]!.id === activeId }]"
            :style="{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }"
            @click="onRowClick(visible[v.index]!)"
            @mouseenter="onRowEnter(visible[v.index]!)"
          >
            <div v-if="showNo" class="dt-cell dt-no">{{ v.index + 1 }}</div>

            <div v-if="selectable" class="dt-cell dt-check" @click.stop>
              <input
                type="checkbox" :checked="selected?.has(visible[v.index]!.id)"
                :aria-label="`${v.index + 1}번째 줄 선택`"
                @change="emit('toggle', visible[v.index]!.id)"
              />
            </div>

            <div
              v-for="col in columns" :key="col.key" class="dt-cell"
              :class="{ 'dt-slot': !!$slots[`cell:${col.key}`] }"
              :style="cellStyle(col)"
              :title="$slots[`cell:${col.key}`] ? undefined : cell(visible[v.index]!, col)"
            >
              <slot
                :name="`cell:${col.key}`"
                :row="visible[v.index]!"
                :value="cell(visible[v.index]!, col)"
                :index="v.index"
              >{{ cell(visible[v.index]!, col) }}</slot>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 아래쪽 집계 — 세는 범위를 감추지 않는다 -->
    <div class="dt-foot">
      <span v-if="total !== null && total !== undefined">
        전체 <strong>{{ n(total) }}</strong>건
      </span>
      <span v-if="total !== null && total !== undefined && total > rows.length" class="muted">
        · 불러옴 {{ n(rows.length) }}
      </span>
      <span v-else-if="total === null || total === undefined">
        <strong>{{ n(rows.length) }}</strong>건
      </span>
      <span v-if="filtering" class="dt-foot-filter">
        · 거른 뒤 <strong>{{ n(visible.length) }}</strong>
      </span>
      <span v-if="loadingMore" class="dt-foot-loading">
        <svg class="dt-spin" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-dasharray="28 10" />
        </svg>
        더 불러오는 중…
      </span>
      <button
        v-else-if="hasMore"
        class="dt-more-btn"
        title="다음 페이지 불러오기"
        type="button"
        @click="checkLoadMore"
      >
        더 불러오기
      </button>
      <span style="flex:1" />
      <span v-if="activeIndex !== null" class="muted">{{ n(activeIndex) }}번째 줄</span>
      <span v-if="selectable && selectedCount > 0" class="dt-foot-sel">
        선택 <strong>{{ n(selectedCount) }}</strong>건
      </span>

      <button
        v-if="excel"
        class="dt-xls" :disabled="exporting || !visible.length"
        :title="exporting ? '엑셀을 만드는 중입니다' : `보이는 ${n(visible.length)}건을 엑셀로 내려받기`"
        :aria-label="`보이는 ${n(visible.length)}건을 엑셀로 내려받기`"
        @click="exportExcel"
      >
        <svg v-if="!exporting" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M9 1.6H4.4a1.2 1.2 0 0 0-1.2 1.2v10.4a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.4z"
                fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M9 1.6V5.4h3.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M5.9 8.4l3.4 4.1M9.3 8.4l-3.4 4.1"
                stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <svg v-else class="dt-spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"
                  stroke-linecap="round" stroke-dasharray="28 10" />
        </svg>
        <span>엑셀</span>
      </button>

      <button
        v-if="serverExcel"
        class="dt-xls dt-xls-server" :disabled="serverExporting || (!rows.length && !total)"
        :title="serverExporting ? '서버에서 엑셀을 만드는 중입니다' : '조건에 맞는 전체 자료를 서버에서 엑셀로 생성해 내려받기'"
        aria-label="전체 엑셀 내려받기(서버)"
        type="button"
        @click="emit('exportServer')"
      >
        <svg v-if="!serverExporting" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M9 1.6H4.4a1.2 1.2 0 0 0-1.2 1.2v10.4a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.4z"
                fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M9 1.6V5.4h3.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M8 8v5M5.5 10.5L8 13l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else class="dt-spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"
                  stroke-linecap="round" stroke-dasharray="28 10" />
        </svg>
        <span>{{ serverExcelLabel ?? '전체 엑셀(서버)' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.dt {
  --dt-head-h: 29px;   /* 거르기 줄이 머리글 바로 아래에 붙는 높이 */
  display: flex; flex-direction: column; height: 100%; width: 100%;
  flex: 1;
  /* 둘 다 0 이어야 한다. min-*: auto 면 안쪽 내용(max-content) 만큼 부풀어
     부모 밖으로 삐져나가고, 부모가 overflow:hidden 이면 그대로 잘린다 —
     표 안에서 스크롤되지 않고 글자가 사라진다. */
  min-height: 0; min-width: 0;
  font-variant-numeric: tabular-nums;
}

/* ── 머리글 ─────────────────────────────────────────────────────── */
/* 한 스크롤이 가로·세로를 모두 맡는다. 머리글은 그 안에 붙어(sticky) 있으므로
   가로로 밀면 줄과 같이 움직이고, 세로로 내려도 자리를 지킨다. */
.dt-scroll { flex: 1; overflow: auto; min-height: 0; width: 100%; }

/* 내용만큼만 — 줄이 서너 개뿐인 표가 빈 상자가 되지 않게.
   테두리를 둘러 주변 글과 구분한다(목록 화면에서는 패널이 그 일을 한다). */
.dt.auto {
  height: auto;
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
}
.dt.auto .dt-scroll { flex: 0 1 auto; }
.dt.auto .dt-empty { padding: 20px; }
.dt-inner { width: 100%; min-width: max-content; }

.dt-head {
  display: flex; position: sticky; top: 0; z-index: 3;
  width: 100%; min-width: max-content;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-weight: 600; font-size: var(--fs-sm); color: var(--fg-muted);
}
.dt-th { position: relative; user-select: none; }
.dt-th.sortable { cursor: pointer; }
.dt-th.sortable:hover { color: var(--fg); background: var(--surface-3); }
.dt-th.sorted { color: var(--primary); }
.dt-th-label { overflow: hidden; text-overflow: ellipsis; }

.dt-sort { margin-left: 4px; font-size: 8px; opacity: 0; transition: opacity .1s ease; }
.dt-th.sortable:hover .dt-sort { opacity: .45; }
.dt-sort.on { opacity: 1; }

/* 너비 손잡이 — 칸 경계에 걸친다 */
.dt-grip {
  position: absolute; top: 0; right: -3px; bottom: 0;
  width: 7px; cursor: col-resize; z-index: 3;
}
.dt-grip::after {
  content: ''; position: absolute; top: 5px; bottom: 5px; left: 3px;
  width: 1px; background: transparent; transition: background-color .1s ease;
}
.dt-grip:hover::after { background: var(--primary); }

/* ── 거르기 줄 ──────────────────────────────────────────────────── */
.dt-filter {
  display: flex; position: sticky; top: var(--dt-head-h); z-index: 2;
  width: 100%; min-width: max-content;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.dt-filter .dt-cell { padding: 3px 4px; overflow: visible; }
.dt-finput {
  width: 100%; height: 22px; padding: 0 6px;
  font-size: var(--fs-xs);
  border: 1px solid transparent; border-radius: var(--r-sm);
  background: var(--surface-2); color: var(--fg);
}
.dt-finput:hover { border-color: var(--border-strong); }
.dt-finput:focus {
  background: var(--surface);
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.dt-finput::placeholder { color: var(--fg-subtle); font-weight: 400; }

.dt-clear {
  width: 18px; height: 18px; padding: 0; line-height: 1;
  border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--fg-muted); font-size: 10px;
}
.dt-clear:hover { background: var(--surface-3); color: var(--danger); }

/* ── 본문 ───────────────────────────────────────────────────────── */
.dt-rows { position: relative; width: 100%; min-width: max-content; }
.dt-row {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; align-items: center; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.dt-row:hover { background: var(--surface-2); }

/* 상태 색 — 표 전체에서 뜻이 같아야 한다(base.css 의 .grid 와 같은 이름).
   고른 줄(active)이 늘 이긴다. 안 그러면 뭘 눌렀는지 보이지 않는다. */
.dt-row.warn  { background: var(--warn-soft); }
.dt-row.issue { background: var(--danger-soft); }
.dt-row.off   { color: var(--fg-subtle); }
.dt-row.cur   { background: var(--primary-soft); font-weight: 600; }
.dt-row.warn:hover  { background: var(--warn-soft); filter: brightness(.98); }
.dt-row.issue:hover { background: var(--danger-soft); filter: brightness(.98); }
.dt-row.active, .dt-row.active:hover { background: var(--primary-soft); filter: none; }

.dt-cell {
  padding: 0 9px; line-height: calc(var(--row-h, 30px) - 1px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center;
}
.dt-head .dt-cell { line-height: 28px; height: 29px; }
.dt-row .dt-cell { height: 100%; }
.dt-cell:not(.dt-th):not(.dt-no):not(.dt-check) { display: block; }

/* 슬롯 칸 — 안에 단추·배지가 들어가므로 가운데 맞춤을 되살린다.
   한 줄 높이를 넘기지 않게 넘치는 것은 잘라 둔다(줄 높이가 흔들리면 가상 스크롤이 어긋난다). */
.dt-cell.dt-slot { display: flex; align-items: center; gap: 4px; overflow: hidden; }
.dt-cell.dt-slot :deep(.btn) { flex: 0 0 auto; }
.dt-cell.dt-slot :deep(input[type=text]) { height: 22px; font-size: var(--fs-sm); min-width: 0; }
.dt-cell.dt-slot :deep(a) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-cell.dt-slot :deep(a:hover) { color: var(--primary); text-decoration: underline; }

.dt-no {
  flex: 0 0 48px; width: 48px;
  justify-content: center; text-align: center;
  color: var(--fg-subtle); font-size: var(--fs-sm);
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.dt-row:hover .dt-no { color: var(--fg-muted); }
.dt-row.active .dt-no { color: var(--primary); background: var(--primary-soft); }
.dt-filter .dt-no { background: var(--surface); }

.dt-check {
  flex: 0 0 36px; width: 36px;
  justify-content: center; text-align: center;
}

.dt-empty { padding: 36px; text-align: center; color: var(--fg-muted); }

/* ── 아래쪽 집계 ────────────────────────────────────────────────── */
.dt-foot {
  display: flex; align-items: center; gap: 4px;
  flex: 0 0 auto; height: 29px; padding: 0 var(--sp-3);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  font-size: var(--fs-sm); color: var(--fg-muted);
}
.dt-foot strong { color: var(--fg); font-weight: 600; }
.dt-foot-filter { color: var(--warn); }
.dt-foot-filter strong { color: var(--warn); }
.dt-foot-sel { color: var(--primary); margin-left: 10px; }
.dt-foot-sel strong { color: var(--primary); }

/* 엑셀 내려받기 — 집계 줄 오른쪽 끝. 자주 쓰지만 주인공은 아니라 조용하게 둔다. */
.dt-xls {
  display: inline-flex; align-items: center; gap: 5px;
  height: 21px; padding: 0 8px; margin-left: 10px;
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  background: var(--surface); color: var(--fg-muted);
  font-size: var(--fs-xs); font-weight: 500;
  transition: color .12s ease, border-color .12s ease, background-color .12s ease;
}
.dt-xls:hover:not(:disabled) { color: var(--ok); border-color: var(--ok-line); background: var(--ok-soft); }
.dt-xls:disabled { opacity: .4; cursor: not-allowed; }
.dt-xls-server { margin-left: 6px; }
.dt-xls-server:hover:not(:disabled) { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.dt-foot-loading {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: 8px; font-size: var(--fs-xs); color: var(--primary);
}
.dt-more-btn {
  display: inline-flex; align-items: center;
  height: 20px; padding: 0 6px; margin-left: 8px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface); color: var(--fg-muted);
  font-size: var(--fs-xs); cursor: pointer;
  transition: all .12s ease;
}
.dt-more-btn:hover {
  color: var(--primary); border-color: var(--primary); background: var(--primary-soft);
}
.dt-spin { animation: dt-spin 1s linear infinite; }
@keyframes dt-spin { to { transform: rotate(360deg); } }
</style>
