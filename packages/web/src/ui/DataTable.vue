<script setup lang="ts" generic="T extends { id: number }">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { downloadXlsx } from '@/lib/xlsx'
import {
  compareRows,
  getCellValue,
  getNextSortDir,
  getSortLabel,
  isSortable,
  type SortDir,
} from './gridSort'

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
  /** 행 드래그 가능 여부 */
  draggableRows?: boolean
  /**
   * 쪽 넘기기 한 쪽에 담을 줄 수. 서버에서 한 번에 받아 오는 수(limit)와 맞추면
   * 쪽 번호가 서버가 준 묶음과 그대로 들어맞는다.
   */
  pageSize?: number
  /**
   * 창(窓) 방식 — 전체를 다 받지 않고 **보는 자리만** 받는다.
   *
   * 3만 건짜리 목록에서 50쪽으로 갈 때 앞의 49쪽을 받지 않으려고 쓴다.
   * 줄 수는 windowCount 가 말하고, 줄 내용은 rowAt 가 자리마다 꺼내 준다.
   * 아직 안 받은 자리는 빈 줄로 그리고, 보이는 범위를 needRange 로 알려
   * 쓰는 쪽이 그 자리만 받아 채운다.
   */
  windowed?: boolean
  /** 창 방식일 때 전체 줄 수 */
  windowCount?: number
  /** 창 방식일 때 i번째 줄 — 아직 안 받았으면 undefined */
  rowAt?: (index: number) => T | undefined
}>(), {
  rowNumber: true,
  filterRow: true,
  excel: true,
  maxHeight: 420,
  pageSize: 200,
})

const emit = defineEmits<{
  rowClick: [row: T]
  rowHover: [row: T]
  rowDragstart: [event: DragEvent, row: T]
  rowDragend: [event: DragEvent, row: T]
  toggle: [id: number]
  toggleAll: [checked: boolean]
  sort: [key: string, dir: SortDir]
  loadMore: []
  exportServer: []
  /** 창 방식 — 지금 보이는 자리. 쓰는 쪽이 이 범위를 받아 채운다. */
  needRange: [start: number, end: number]
}>()

const rowH = computed(() => props.rowHeight ?? 36)

/** autoHeight 일 때 스크롤 영역이 가질 높이 — 줄 수만큼, 한계까지만. */
const scrollStyle = computed(() =>
  props.autoHeight ? { maxHeight: `${props.maxHeight}px` } : undefined,
)
const showNo = computed(() => props.rowNumber)
const showFilter = computed(() => props.filterRow && !props.windowed)

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
  const dir = getNextSortDir(currentSortKey.value, currentSortDir.value, col.key)

  if (props.sortKey === undefined) {
    innerSortKey.value = col.key
    innerSortDir.value = dir
  }
  emit('sort', col.key, dir)
}

// ── 가상 스크롤 ─────────────────────────────────────────────────────────
const scrollEl = ref<HTMLElement | null>(null)

/** 가상 스크롤이 셀 줄 수 — 창 방식이면 아직 안 받은 자리까지 모두 센다 */
const rowCount = computed(() =>
  (props.windowed ? props.windowCount ?? 0 : visible.value.length))

/** i번째 줄 — 창 방식이면 쓰는 쪽에서 꺼내 온다(아직 안 받았으면 undefined) */
function rowOf(i: number): T | undefined {
  return props.windowed ? props.rowAt?.(i) : visible.value[i]
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => rowH.value,
    overscan: 12,
  })),
)
const items = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

/**
 * 어느 줄을 화면에 띄운다 — 쪽 번호를 눌렀을 때 그 자리로 옮기는 데 쓴다.
 * 거르기가 걸려 있으면 보이는 목록 기준으로 찾는다(안 보이는 줄로는 못 간다).
 *
 * 줄 높이가 고정이라 자리는 i × 줄높이로 바로 셈한다 — 가상 스크롤이 쓰는 셈과 같다.
 * 옮긴 뒤 scroll 사건을 직접 알린다: 프로그램으로 옮기면 가상 스크롤이 알아차리지
 * 못해 **스크롤만 내려가고 줄은 그대로**인 일이 있었다.
 */
function scrollToRow(id: number): boolean {
  const i = visible.value.findIndex((r) => r.id === id)
  if (i < 0) return false
  void scrollToIndex(i)
  return true
}

defineExpose({ scrollToRow, goToPage })

/**
 * 맨 위에 보이는 줄의 자리.
 *
 * items[0] 을 쓰면 안 된다: 미리 그려 두는 몫(overscan)만큼 실제보다 앞선 줄이라
 * 쪽 번호가 늘 한 쪽 뒤처진다. 스크롤 자리에서 바로 셈한다(줄 높이가 고정이다).
 */
const viewIndex = ref(0)
watch(items, (cur) => {
  const el = scrollEl.value
  if (el) viewIndex.value = Math.round(el.scrollTop / rowH.value)
  // 창 방식 — 지금 보이는 자리를 알려 아직 안 받은 곳을 채우게 한다
  if (props.windowed && cur.length) {
    emit('needRange', cur[0]!.index, cur[cur.length - 1]!.index)
  }
})

// 목록 조건이 바뀌었을 때만 맨 위로 (무한 스크롤 추가 적재 시에는 스크롤 위치 유지)
watch(
  () => props.rows,
  (next, prev) => {
    if (!prev?.length || !next?.length || prev[0]?.id !== next[0]?.id) {
      scrollEl.value?.scrollTo({ top: 0 })
    }
  },
)

// ── 쪽 넘기기 ──────────────────────────────────────────────────────────
// 끌어내려 이어 붙이는 방식은 그대로 두고, 여기 쪽 번호는 **자리를 옮기는 길잡이**다.
// 아직 안 불러온 쪽을 누르면 거기까지 이어서 불러온 뒤 그 자리로 옮긴다.
//
// 불러오기는 쓰는 쪽이 한다(loadMore). 그리드는 기다릴 수 없으므로 '가려는 쪽'을
// 적어 두고, 줄이 늘 때마다 다 왔는지 다시 본다 — 다 왔으면 옮기고 지운다.

/**
 * 쪽을 셀 기준 — **실제로 갈 수 있는 줄 수**다.
 *
 *   · 거르는 중   : 거른 결과 안에서만 움직인다(더 받아도 늘지 않는다)
 *   · 더 받을 수 있으면 : 서버가 말한 전체 건수 (아직 안 받은 쪽도 누를 수 있다)
 *   · 더 못 받으면 : 지금 가진 줄 수
 *
 * 마지막 갈래가 없으면, 한 번만 받아 오는 화면(TDB 관리처럼 커서 페이징을 안 쓰는 곳)이
 * 191쪽을 내걸고도 200줄 밖으로는 못 가는 거짓말이 된다.
 */
const pageBase = computed(() => {
  if (props.windowed) return rowCount.value
  if (filtering.value) return visible.value.length
  if (props.hasMore) return props.total ?? props.rows.length
  return visible.value.length
})

const pageCount = computed(() => Math.max(1, Math.ceil(pageBase.value / props.pageSize)))
const currentPage = computed(() =>
  Math.min(pageCount.value, Math.floor(viewIndex.value / props.pageSize) + 1))

/** 쪽 번호 칸 — 손으로 고쳐 넣는 동안에는 그 값을 그대로 둔다 */
const pageInput = ref('1')
watch(currentPage, (p) => { pageInput.value = String(p) })

/** 가려는 쪽 (불러오는 중이면 값이 있다) */
const jumpTo = ref<number | null>(null)

async function scrollToIndex(i: number) {
  // 줄이 막 늘어난 직후면 아직 그려지기 전이라 내용이 짧다 —
  // 그대로 옮기면 브라우저가 그 높이에 맞춰 잘라 버린다(200쪽으로 가려다 186쪽에 섰다).
  await nextTick()
  const el = scrollEl.value
  if (!el) return
  // 줄 높이가 고정이라 자리를 바로 셈한다. 옮긴 뒤 scroll 사건을 직접 알린다 —
  // 프로그램으로 옮기면 가상 스크롤이 알아차리지 못해 줄이 그대로인 일이 있었다.
  el.scrollTop = Math.max(0, i) * rowH.value
  el.dispatchEvent(new Event('scroll'))
}

/** 다 왔으면 옮기고, 모자라면 더 불러오라고 알린다 */
function tryJump() {
  const n = jumpTo.value
  if (n === null) return
  const want = (n - 1) * props.pageSize
  // 창 방식은 어느 자리든 바로 갈 수 있다 — 그 자리 줄은 needRange 로 채워진다
  if (props.windowed) {
    jumpTo.value = null
    void scrollToIndex(want)
    return
  }
  if (visible.value.length > want) {
    jumpTo.value = null
    void scrollToIndex(want)
    return
  }
  // 거르는 중에는 더 받아도 늘지 않는다. 받을 것이 없으면 끝줄로 간다.
  if (filtering.value || !props.hasMore) {
    jumpTo.value = null
    void scrollToIndex(Math.max(0, visible.value.length - 1))
    return
  }
  if (!props.loadingMore && !props.loading) emit('loadMore')
}

function goToPage(n: number) {
  const target = Math.min(Math.max(1, Math.floor(n) || 1), pageCount.value)
  jumpTo.value = target
  tryJump()
}

function submitPage() {
  const n = Number(pageInput.value)
  if (Number.isFinite(n) && pageInput.value !== '') goToPage(n)
  else pageInput.value = String(currentPage.value)
}

/**
 * 쪽 번호 칸은 숫자만 받는다.
 *
 * type=number 를 쓰지 않는 이유: 브라우저가 붙이는 위아래 화살표가 21px 짜리 칸에
 * 들어가지 않고, 'e'·'+'·'-' 같은 글자가 그대로 들어온다. 글자 칸으로 두고 여기서 거른다.
 * 자판으로 친 것뿐 아니라 붙여넣기·드래그로 들어온 것도 같이 걸린다.
 */
function onPageInput(e: Event) {
  const el = e.target as HTMLInputElement
  const digits = el.value.replace(/\D+/g, '')
  // 글자를 걸러냈으면 칸에도 바로 되돌린다 — 안 그러면 지운 글자가 화면에 남는다
  if (el.value !== digits) el.value = digits
  pageInput.value = digits
}

/**
 * 위·아래 방향키로 쪽을 넘긴다 — 위가 숫자를 올려 다음 쪽, 아래가 내려 이전 쪽.
 * 칸에 적어 둔 값이 있으면 그것을 기준으로 올린다(아직 안 누른 숫자도 따라간다).
 */
function stepPage(delta: number) {
  if (jumpTo.value) return
  const typed = Number(pageInput.value)
  const from = Number.isFinite(typed) && pageInput.value !== '' ? typed : currentPage.value
  const next = Math.min(Math.max(1, from + delta), pageCount.value)
  if (next === currentPage.value && next === from) return
  goToPage(next)
}

// 줄이 늘거나 불러오기가 끝나면 다 왔는지 다시 본다
watch([() => props.rows.length, () => props.loadingMore], () => { tryJump() })

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

let isDragging = false

function onRowDragStart(event: DragEvent, row: T) {
  isDragging = true
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(row.id))
  }
  emit('rowDragstart', event, row)
}

function onRowDragEnd(event: DragEvent, row: T) {
  setTimeout(() => {
    isDragging = false
  }, 100)
  emit('rowDragend', event, row)
}

function onRowClick(row: T) {
  if (isDragging) return
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
          class="dt-cell dt-th" :class="{
            sortable: isSortable(col),
            sorted: currentSortKey === col.key,
            'sort-asc': currentSortKey === col.key && currentSortDir === 'asc',
            'sort-desc': currentSortKey === col.key && currentSortDir === 'desc',
          }"
          :style="cellStyle(col)"
          :title="isSortable(col)
            ? (currentSortKey === col.key
                ? `${col.label} — ${getSortLabel(currentSortDir)} 정렬됨 (클릭 시 ${getSortLabel(currentSortDir === 'asc' ? 'desc' : 'asc')} 정렬)`
                : `${col.label} — 클릭 시 정렬`)
            : col.label"
          :aria-sort="currentSortKey === col.key ? (currentSortDir === 'asc' ? 'ascending' : 'descending') : undefined"
          @click="onHeaderClick(col)"
        >
          <span class="dt-th-label">{{ col.label }}</span>
          <span
            v-if="isSortable(col)"
            class="dt-sort-icon"
            :class="{
              active: currentSortKey === col.key,
              asc: currentSortKey === col.key && currentSortDir === 'asc',
              desc: currentSortKey === col.key && currentSortDir === 'desc',
            }"
            aria-hidden="true"
          >
            <!-- 정렬 활성 시 오름차순(▲) / 내림차순(▼) 아이콘 표시 -->
            <svg
              v-if="currentSortKey === col.key"
              class="dt-sort-arrow"
              viewBox="0 0 10 10"
              width="9"
              height="9"
              aria-hidden="true"
            >
              <path v-if="currentSortDir === 'asc'" d="M5 2L1.8 7.5h6.4L5 2z" fill="currentColor" />
              <path v-else d="M5 8L1.8 2.5h6.4L5 8z" fill="currentColor" />
            </svg>
            <!-- 미정렬 상태에서 호버 시 정렬 가능함을 알리는 중립 아이콘 -->
            <svg
              v-else
              class="dt-sort-neutral"
              viewBox="0 0 10 12"
              width="8"
              height="10"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M5 1L2.2 4.5h5.6L5 1z M5 11L2.2 7.5h5.6L5 11z" />
            </svg>
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
        <div v-else-if="!rowCount" class="dt-empty muted">{{ emptyText ?? '자료가 없습니다.' }}</div>
        <div v-else-if="!windowed && !visible.length" class="dt-empty muted">
          거른 결과가 없습니다.
          <button class="btn btn-sm" style="margin-left:8px" @click="clearFilters">거르기 지우기</button>
        </div>

        <div
          v-else class="dt-rows" :style="{ height: `${totalSize}px` }"
          @mouseleave="cancelHover"
        >
          <template v-for="v in items" :key="rowOf(v.index)?.id ?? `_${v.index}`">
            <!-- 아직 안 받은 자리 — 창 방식에서만 생긴다. 자리는 지키고 글만 비운다. -->
            <div
              v-if="!rowOf(v.index)" class="dt-row dt-row-blank"
              :style="{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }"
            >
              <div v-if="showNo" class="dt-cell dt-no">{{ v.index + 1 }}</div>
              <div v-if="selectable" class="dt-cell dt-check" />
              <div v-for="col in columns" :key="col.key" class="dt-cell" :style="cellStyle(col)">
                <span class="dt-skeleton" />
              </div>
            </div>

            <div
              v-else
              class="dt-row"
              :class="[
                rowClass?.(rowOf(v.index)!),
                {
                  active: rowOf(v.index)!.id === activeId,
                  'is-draggable': draggableRows,
                },
              ]"
              :style="{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }"
              :draggable="draggableRows ? true : undefined"
              @click="onRowClick(rowOf(v.index)!)"
              @mouseenter="onRowEnter(rowOf(v.index)!)"
              @dragstart="draggableRows ? onRowDragStart($event, rowOf(v.index)!) : undefined"
              @dragend="draggableRows ? onRowDragEnd($event, rowOf(v.index)!) : undefined"
            >
              <div v-if="showNo" class="dt-cell dt-no">{{ v.index + 1 }}</div>

              <div v-if="selectable" class="dt-cell dt-check" @click.stop>
                <input
                  type="checkbox" :checked="selected?.has(rowOf(v.index)!.id)"
                  :aria-label="`${v.index + 1}번째 줄 선택`"
                  @change="emit('toggle', rowOf(v.index)!.id)"
                />
              </div>

              <div
                v-for="col in columns" :key="col.key" class="dt-cell"
                :class="{ 'dt-slot': !!$slots[`cell:${col.key}`] }"
                :style="cellStyle(col)"
                :title="$slots[`cell:${col.key}`] ? undefined : cell(rowOf(v.index)!, col)"
              >
                <slot
                  :name="`cell:${col.key}`"
                  :row="rowOf(v.index)!"
                  :value="cell(rowOf(v.index)!, col)"
                  :index="v.index"
                >{{ cell(rowOf(v.index)!, col) }}</slot>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 아래쪽 집계 — 세는 범위를 감추지 않는다 -->
    <div class="dt-foot">
      <!-- 모바일(좁은 폭)에서는 .dt-lbl 글자를 감추고 숫자만 남긴다 — 뜻은 title 로 -->
      <span v-if="total !== null && total !== undefined" class="dt-foot-num" :title="`전체 ${n(total)}건`">
        <span class="dt-lbl">전체 </span><strong>{{ n(total) }}</strong><span class="dt-lbl">건</span>
      </span>
      <span
        v-if="total !== null && total !== undefined && total > rows.length"
        class="muted dt-foot-num" :title="`불러옴 ${n(rows.length)}건`"
      >
        · <span class="dt-lbl">불러옴 </span>{{ n(rows.length) }}
      </span>
      <span v-else-if="total === null || total === undefined" class="dt-foot-num">
        <strong>{{ n(rows.length) }}</strong><span class="dt-lbl">건</span>
      </span>
      <span v-if="filtering" class="dt-foot-filter dt-foot-num" :title="`거른 뒤 ${n(visible.length)}건`">
        · <span class="dt-lbl">거른 뒤 </span><strong>{{ n(visible.length) }}</strong>
      </span>
      <span v-if="loadingMore" class="dt-foot-loading">
        <svg class="dt-spin" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-dasharray="28 10" />
        </svg>
        <span class="dt-lbl">더 불러오는 중…</span>
      </span>
      <button
        v-else-if="hasMore"
        class="dt-more-btn"
        title="다음 페이지 불러오기"
        aria-label="다음 페이지 불러오기"
        type="button"
        @click="checkLoadMore"
      >
        <svg class="dt-ico-m" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <span class="dt-lbl">더 불러오기</span>
      </button>
      <span style="flex:1" />

      <!-- 쪽 넘기기 — 아래줄 한가운데. 끌어내려 이어 붙이는 방식은 그대로 둔다. -->
      <span v-if="pageCount > 1" class="dt-pager">
        <button
          class="dt-page-btn dt-page-edge" type="button" title="맨 처음 쪽"
          :disabled="!!jumpTo || currentPage === 1" @click="goToPage(1)"
        >◀◀</button>
        <button
          class="dt-page-btn" type="button" title="이전 쪽"
          :disabled="!!jumpTo || currentPage === 1" @click="goToPage(currentPage - 1)"
        >◀</button>

        <input
          :value="pageInput" type="text" inputmode="numeric" class="dt-page-input"
          autocomplete="off"
          title="쪽 번호를 넣고 Enter · ↑ 다음 쪽 · ↓ 이전 쪽" :disabled="!!jumpTo"
          @input="onPageInput"
          @keydown.up.prevent="stepPage(1)"
          @keydown.down.prevent="stepPage(-1)"
          @keyup.enter="submitPage"
          @blur="pageInput = String(currentPage)"
        />
        <span class="dt-page-total">/ {{ n(pageCount) }}</span>

        <button
          class="dt-page-btn" type="button" title="다음 쪽"
          :disabled="!!jumpTo || currentPage >= pageCount" @click="goToPage(currentPage + 1)"
        >▶</button>
        <button
          class="dt-page-btn dt-page-edge" type="button" title="맨 끝 쪽"
          :disabled="!!jumpTo || currentPage >= pageCount" @click="goToPage(pageCount)"
        >▶▶</button>

        <span v-if="jumpTo" class="dt-page-note dt-lbl">{{ n(jumpTo) }}쪽 불러오는 중…</span>
      </span>

      <span style="flex:1" />
      <span v-if="activeIndex !== null" class="muted dt-lbl">{{ n(activeIndex) }}번째 줄</span>
      <span v-if="selectable && selectedCount > 0" class="dt-foot-sel" :title="`선택 ${n(selectedCount)}건`">
        <span class="dt-lbl">선택 </span><span class="dt-sel-mark" aria-hidden="true">✓</span><strong>{{ n(selectedCount) }}</strong><span class="dt-lbl">건</span>
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
        <span class="dt-lbl">엑셀</span>
      </button>

      <button
        v-if="serverExcel"
        class="dt-xls dt-xls-server" :disabled="serverExporting || (!rows.length && !total)"
        :title="serverExporting ? '서버에서 엑셀을 만드는 중입니다' : `${serverExcelLabel ?? '전체 엑셀(서버)'} — 조건에 맞는 전체 자료를 서버에서 엑셀로 생성해 내려받기`"
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
        <span class="dt-lbl">{{ serverExcelLabel ?? '전체 엑셀(서버)' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 아직 안 받은 자리 — 자리만 지키고 옅은 띠로 '곧 온다'를 알린다 */
.dt-row-blank { cursor: default; }
.dt-skeleton {
  display: block; height: 9px; width: 70%;
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  animation: dt-blank 1.1s ease-in-out infinite;
}
@keyframes dt-blank { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .dt-skeleton { animation: none; } }

/* ── 쪽 넘기기 (아래줄 한가운데) ───────────────────────────────────
   [더 불러오기] 와 [엑셀] 사이 빈 자리를 쓴다. 아래줄 높이(30px)를 넘기지 않게
   단추를 작게 두고, 글자는 기존 화면의 처음·이전·다음·끝 표기를 따른다. */
.dt-pager {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 11.5px; color: var(--text-muted); white-space: nowrap;
}
.dt-page-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 21px; padding: 0 5px;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text-muted);
  font-size: 10px; line-height: 1;
  letter-spacing: -0.2em; text-indent: -0.2em;   /* ◀◀ 를 살짝 겹쳐 폭을 줄인다 */
}
.dt-page-btn:hover:not(:disabled) {
  border-color: var(--text-faint); background: var(--surface-alt); color: var(--text);
}
.dt-page-btn:disabled { opacity: .4; cursor: var(--cursor-forbidden); }

.dt-page-input {
  width: 5ch; height: 21px; padding: 0 2px; margin: 0 1px;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text);
  font-size: 11.5px; text-align: center;
}
.dt-page-total { margin-right: 2px; }
.dt-page-note { margin-left: 6px; color: var(--text-muted); }

.dt {
  --dt-head-h: 38px;   /* 거르기 줄이 머리글 바로 아래에 붙는 높이 */
  display: flex; flex-direction: column; height: 100%; width: 100%;
  flex: 1;
  /* 둘 다 0 이어야 한다. min-*: auto 면 안쪽 내용(max-content) 만큼 부풀어
     부모 밖으로 삐져나가고, 부모가 overflow:hidden 이면 그대로 잘린다 —
     표 안에서 스크롤되지 않고 글자가 사라진다. */
  min-height: 0; min-width: 0;
  font-variant-numeric: tabular-nums;
  /* 표 안 글자색을 여기서 못 박는다. 비워 두면 바깥에서 흘러든 색을 그대로 물려받는데,
     흐린 색이 들어오면 표 전체가 읽기 어려워진다(실제로 그런 적이 있다). */
  color: var(--text);
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
  border-radius: var(--radius-lg);
  background: var(--surface);
  overflow: hidden;
}
.dt.auto .dt-scroll { flex: 0 1 auto; }
.dt.auto .dt-empty { padding: 20px; }
.dt-inner { width: 100%; min-width: max-content; }

/* 기존 화면의 thead th 와 같다 — 흰 바탕, 아래만 진한 선, 가운데 맞춤 */
.dt-head {
  display: flex; position: sticky; top: 0; z-index: 3;
  width: 100%; min-width: max-content;
  background: var(--surface);
  border-bottom: 1px solid var(--border-strong);
  font-weight: 600; font-size: 11.5px; color: var(--text-muted);
  letter-spacing: 0.02em;
}
.dt-head .dt-cell { position: relative; justify-content: center; }
.dt-th { position: relative; user-select: none; justify-content: center; }
.dt-th.sortable { cursor: pointer; }
.dt-th.sortable:hover { color: var(--text); }
/* 정렬 중인 열은 진하게·강조색 */
.dt-th.sorted { color: var(--accent); font-weight: 700; }
.dt-th-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 정렬 표시 아이콘 */
.dt-sort-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 4px;
  flex-shrink: 0;
  line-height: 1;
}

.dt-sort-arrow {
  display: block;
  color: var(--accent);
}

.dt-sort-neutral {
  display: block;
  opacity: 0;
  color: var(--text-muted);
  transition: opacity 0.15s ease;
}

.dt-th.sortable:hover .dt-sort-neutral {
  opacity: 0.45;
}


/* 컬럼 사이 구분선 — 머리글에서만, 머리글 높이의 80% 정도로 */
.dt-head .dt-cell:not(:last-child)::after {
  content: ""; position: absolute; right: 0; top: 10%; bottom: 10%;
  width: 1px; background: var(--border-strong);
  pointer-events: none;
}

/* 너비 손잡이 — 칸 경계에 걸친다 */
.dt-grip {
  position: absolute; top: 0; right: -3px; bottom: 0;
  width: 7px; cursor: col-resize; z-index: 3;
}
.dt-grip::after {
  content: ''; position: absolute; top: 5px; bottom: 5px; left: 3px;
  width: 2px; background: transparent; transition: background-color .1s ease;
}
.dt-grip:hover::after { background: var(--text-faint); }

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
  font-size: 11px;
  border: 1px solid transparent; border-radius: var(--radius-sm);
  background: var(--surface-sunken); color: var(--text);
}
.dt-finput:hover { border-color: var(--border-strong); }
.dt-finput:focus {
  background: var(--surface);
  border-color: var(--text);
}
.dt-finput::placeholder { color: var(--fg-subtle); font-weight: 400; }

.dt-clear {
  width: 18px; height: 18px; padding: 0; line-height: 1;
  border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--fg-muted); font-size: 10px;
}
.dt-clear:hover { background: var(--surface-sunken); color: var(--danger); }

/* ── 본문 ───────────────────────────────────────────────────────── */
.dt-rows { position: relative; width: 100%; min-width: max-content; }
.dt-row {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; align-items: center; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.dt-row:hover { background: var(--surface-alt); }

/* 상태 색 — 표 전체에서 뜻이 같아야 한다(base.css 의 .grid 와 같은 이름).
   고른 줄(active)이 늘 이긴다. 안 그러면 뭘 눌렀는지 보이지 않는다. */
.dt-row.warn  { background: var(--warn-soft); }
.dt-row.issue { background: var(--danger-soft); }
.dt-row.off   { color: var(--text-faint); }
.dt-row.cur   { background: var(--accent-soft); }
.dt-row.warn:hover  { background: var(--warn-soft-hover); }
.dt-row.issue:hover { background: var(--danger-soft-hover); }
.dt-row.active, .dt-row.active:hover { background: var(--accent-soft); filter: none; }

.dt-cell {
  padding: 0 12px; line-height: calc(var(--row-h, 36px) - 1px);
  font-size: 12.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center;
}
.dt-head .dt-cell { line-height: 37px; height: 38px; font-size: 11.5px; }
.dt-row .dt-cell { height: 100%; }
.dt-cell:not(.dt-th):not(.dt-no):not(.dt-check) { display: block; }

/* 슬롯 칸 — 안에 단추·배지가 들어가므로 가운데 맞춤을 되살린다.
   한 줄 높이를 넘기지 않게 넘치는 것은 잘라 둔다(줄 높이가 흔들리면 가상 스크롤이 어긋난다). */
.dt-cell.dt-slot { display: flex; align-items: center; gap: 4px; overflow: hidden; }
.dt-cell.dt-slot :deep(.btn) { flex: 0 0 auto; }
.dt-cell.dt-slot :deep(input[type=text]) { height: 22px; font-size: var(--fs-sm); min-width: 0; }
.dt-cell.dt-slot :deep(a) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-cell.dt-slot :deep(a:hover) { color: var(--text); text-decoration: underline; border-bottom-color: transparent; }

/* No 열 — 기존 화면(.col-no)은 가운데 맞춤만 다르고 글자색은 다른 칸과 같다.
   여기서 흐린 색을 주면 밝은 테마에서 흰 바탕 대비가 4.5:1 까지 내려가 숫자가 잘 안 읽힌다. */
.dt-no {
  flex: 0 0 54px; width: 54px;
  justify-content: center; text-align: center;
  font-size: 12px;
}
/* 머리글은 기존 화면의 thead th 가 그렇듯 흐린 색이 맞다 */
.dt-head .dt-no { color: var(--text-muted); }

.dt-check {
  flex: 0 0 36px; width: 36px;
  justify-content: center; text-align: center;
}

.dt-empty { padding: 44px; text-align: center; color: var(--text-faint); font-size: 12.5px; }

/* ── 아래쪽 집계 ────────────────────────────────────────────────── */
.dt-foot {
  display: flex; align-items: center; gap: 4px;
  flex: 0 0 auto; height: 30px; padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-alt);
  font-size: 12px; color: var(--text-muted);
}
.dt-foot strong { color: var(--text); font-weight: 700; }
.dt-foot-filter { color: var(--warn); }
.dt-foot-filter strong { color: var(--warn); }
.dt-foot-sel { color: var(--text); margin-left: 10px; }
.dt-foot-sel strong { color: var(--text); }

/* 엑셀 내려받기 — 집계 줄 오른쪽 끝. 자주 쓰지만 주인공은 아니라 조용하게 둔다. */
.dt-xls {
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 8px; margin-left: 10px;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text-muted);
  font-size: 11px; font-weight: 500;
  transition: color .12s ease, border-color .12s ease, background-color .12s ease;
}
.dt-xls:hover:not(:disabled) { color: var(--text); border-color: var(--text-faint); background: var(--surface-alt); }
.dt-xls:disabled { opacity: .4; cursor: var(--cursor-forbidden); }
.dt-xls-server { margin-left: 6px; }
.dt-xls-server:hover:not(:disabled) { color: var(--text); border-color: var(--text-faint); background: var(--surface-alt); }
.dt-foot-loading {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: 8px; font-size: 11px; color: var(--text-muted);
}
.dt-more-btn {
  display: inline-flex; align-items: center;
  height: 22px; padding: 0 8px; margin-left: 8px;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text-muted);
  font-size: 11px; cursor: pointer;
  transition: all .12s ease;
}
.dt-more-btn:hover {
  color: var(--text); border-color: var(--text-faint); background: var(--surface-alt);
}
.dt-spin { animation: dt-spin 1s linear infinite; }
.dt-foot-num { white-space: nowrap; }
.dt-ico-m, .dt-sel-mark { display: none; }

/* ── 모바일: 아랫줄을 한 줄에 — 글자 이름은 감추고 숫자·아이콘만 ──────
   좁은 폭에서 [전체 N건 · 불러옴 N] [쪽 넘기기] [엑셀] 이 두 줄로 접혀
   30px 줄 밖으로 삐져나가던 것을 막는다. 뜻은 각 요소의 title 에 남아 있다. */
@media (max-width: 700px) {
  .dt-foot { gap: 3px; padding: 0 8px; white-space: nowrap; overflow: hidden; }
  .dt-foot > * { flex-shrink: 0; }
  .dt-lbl { display: none; }
  .dt-ico-m { display: inline; }
  .dt-sel-mark { display: inline; margin-right: 1px; }
  .dt-foot-sel { margin-left: 4px; }
  .dt-more-btn { padding: 0 5px; margin-left: 4px; }
  .dt-foot-loading { margin-left: 4px; }
  .dt-pager { gap: 2px; }
  .dt-page-btn { min-width: 20px; padding: 0 4px; }
  .dt-page-input { width: 4ch; }
  .dt-xls { padding: 0 5px; margin-left: 4px; gap: 0; }
  .dt-xls-server { margin-left: 3px; }
}
@media (max-width: 360px) {
  /* 아주 좁으면 맨 처음·맨 끝 쪽 단추는 뺀다 — 쪽 번호 칸에 바로 넣을 수 있다 */
  .dt-page-btn.dt-page-edge { display: none; }
}
@keyframes dt-spin { to { transform: rotate(360deg); } }

/* ── 드래그 가능 행 ────────────────────────────────────────────── */
.dt-row.is-draggable {
  user-select: none;
}
.dt-row.is-draggable .dt-cell {
  cursor: grab;
}
.dt-row.is-draggable:active .dt-cell {
  cursor: grabbing;
}
.dt-row.is-draggable button,
.dt-row.is-draggable a,
.dt-row.is-draggable input {
  cursor: pointer;
}
.dt-row.dragging {
  opacity: 0.45;
  background: var(--surface-alt);
}
</style>
