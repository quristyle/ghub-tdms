<script setup lang="ts" generic="T extends { id: number }">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'

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
  /** 이 칸으로 정렬할 수 있는가 (서버가 아는 키여야 한다) */
  sortable?: boolean
  /** 이 칸을 거를 수 있는가 (기본: 그렇다) */
  filterable?: boolean
}

export type SortDir = 'asc' | 'desc'

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
  /** 지금 정렬 상태 */
  sortKey?: string
  sortDir?: SortDir
  /** 너비·거르기를 기억할 이름. 화면마다 다르게 준다. */
  storageKey?: string
  /** 순번 열을 보일지 */
  rowNumber?: boolean
  /** 거르기 줄을 보일지 */
  filterRow?: boolean
}>(), {
  rowNumber: true,
  filterRow: true,
})

const emit = defineEmits<{
  rowClick: [row: T]
  rowHover: [row: T]
  toggle: [id: number]
  toggleAll: [checked: boolean]
  sort: [key: string, dir: SortDir]
}>()

const rowH = computed(() => props.rowHeight ?? 30)
const showNo = computed(() => props.rowNumber)
const showFilter = computed(() => props.filterRow)

// ── 거르기 (불러온 것 안에서) ───────────────────────────────────────────
const filters = ref<Record<string, string>>({})

const visible = computed(() => {
  const active = Object.entries(filters.value).filter(([, v]) => v.trim() !== '')
  if (!active.length) return props.rows
  return props.rows.filter((row) =>
    active.every(([key, needle]) => {
      const col = props.columns.find((c) => c.key === key)
      if (!col) return true
      return cell(row, col).toLowerCase().includes(needle.trim().toLowerCase())
    }),
  )
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
})

// ── 정렬 ────────────────────────────────────────────────────────────────
function onHeaderClick(col: Column<T>) {
  if (!col.sortable) return
  const dir: SortDir = props.sortKey === col.key && props.sortDir === 'asc' ? 'desc' : 'asc'
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

// 목록이 바뀌면 맨 위로
watch(() => props.rows, () => scrollEl.value?.scrollTo({ top: 0 }))

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

function cell(row: T, col: Column<T>): string {
  if (col.render) return col.render(row)
  const v = (row as Record<string, unknown>)[col.key]
  return v === null || v === undefined ? '' : String(v)
}

const n = (v: number) => v.toLocaleString('ko-KR')
</script>

<template>
  <div class="dt">
    <!-- 머리글·거르기·본문이 한 스크롤 안에 있다 —
         가로로 밀면 머리글과 줄이 함께 움직이고, 세로로 내려도 머리글은 붙어 있다. -->
    <div ref="scrollEl" class="dt-scroll">
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
          class="dt-cell dt-th" :class="{ sortable: col.sortable, sorted: sortKey === col.key }"
          :style="cellStyle(col)"
          :title="col.sortable ? `${col.label} — 눌러서 정렬` : col.label"
          :aria-sort="sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined"
          @click="onHeaderClick(col)"
        >
          <span class="dt-th-label">{{ col.label }}</span>
          <span v-if="col.sortable" class="dt-sort" :class="{ on: sortKey === col.key }">
            {{ sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '▲' }}
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

        <div v-else class="dt-rows" :style="{ height: `${totalSize}px` }">
          <div
            v-for="v in items" :key="visible[v.index]!.id"
            class="dt-row" :class="{ active: visible[v.index]!.id === activeId }"
            :style="{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }"
            @click="onRowClick(visible[v.index]!)"
            @mouseenter="emit('rowHover', visible[v.index]!)"
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
              :style="cellStyle(col)" :title="cell(visible[v.index]!, col)"
            >{{ cell(visible[v.index]!, col) }}</div>
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
      <span style="flex:1" />
      <span v-if="activeIndex !== null" class="muted">{{ n(activeIndex) }}번째 줄</span>
      <span v-if="selectable && selectedCount > 0" class="dt-foot-sel">
        선택 <strong>{{ n(selectedCount) }}</strong>건
      </span>
    </div>
  </div>
</template>

<style scoped>
.dt {
  --dt-head-h: 29px;   /* 거르기 줄이 머리글 바로 아래에 붙는 높이 */
  display: flex; flex-direction: column; height: 100%;
  /* 둘 다 0 이어야 한다. min-*: auto 면 안쪽 내용(max-content) 만큼 부풀어
     부모 밖으로 삐져나가고, 부모가 overflow:hidden 이면 그대로 잘린다 —
     표 안에서 스크롤되지 않고 글자가 사라진다. */
  min-height: 0; min-width: 0;
  font-variant-numeric: tabular-nums;
}

/* ── 머리글 ─────────────────────────────────────────────────────── */
/* 한 스크롤이 가로·세로를 모두 맡는다. 머리글은 그 안에 붙어(sticky) 있으므로
   가로로 밀면 줄과 같이 움직이고, 세로로 내려도 자리를 지킨다. */
.dt-scroll { flex: 1; overflow: auto; min-height: 0; }
.dt-inner { min-width: max-content; }

.dt-head {
  display: flex; position: sticky; top: 0; z-index: 3;
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
.dt-rows { position: relative; }
.dt-row {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; align-items: center; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.dt-row:hover { background: var(--surface-2); }
.dt-row.active { background: var(--primary-soft); }

.dt-cell {
  padding: 0 9px; line-height: calc(var(--row-h) - 1px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center;
}
.dt-head .dt-cell { line-height: 28px; height: 29px; }
.dt-cell:not(.dt-th):not(.dt-no):not(.dt-check) { display: block; }

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
</style>
