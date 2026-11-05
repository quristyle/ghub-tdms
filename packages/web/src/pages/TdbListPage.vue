<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type {
  ArchiveBatch, ArchiveListResponse, CreateDistributionResult, DocumentListItem,
  DocumentListResponse, FilterOptions, FolderDocumentsResponse, FolderNode, JobCreated,
  RecentChangeItem, RecentChangesResponse, RecentChangesSummary,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { DOC_STATUS_LABEL as STATUS_LABEL } from '@/lib/labels'
import { NAV_FROM_LIST, saveListNav } from '@/lib/tdbListNav'

/** TDB 조회 — 기존 index.html 의 구성을 재현한다. */

const session = useSession()
const router = useRouter()
const qc = useQueryClient()

// ── 검색 조건 (기존 화면과 같은 항목) ──────────────────────────────────
const folder = ref<FolderNode | null>(null)
const keyword = ref('')
const searchTarget = ref<'title' | 'folder'>('title')
const includeIsometric = ref(false)
/** 하위폴더 전체보기 — 기존 화면처럼 기본은 꺼짐(고른 폴더 바로 아래 자료만) */
const recursive = ref(false)
/**
 * 상태. '반출대기'(in_cart) 는 DB 상태가 아니라 이 화면의 반출대기함을 보여주는 것이라
 * 서버에 보내지 않고 화면에서 처리한다 (기존 script.js loadCartOnlyView).
 */
const status = ref<'all' | 'normal' | 'review' | 'distributed' | 'in_cart' | 'archived'>('all')
const cartView = computed(() => status.value === 'in_cart')
const hold = ref<'all' | 'both' | 'dwg_only' | 'pdf_only'>('all')
const limit = ref<number>(200)

// 입력 중에는 요청하지 않는다. IME 조합 중에도 억제한다.
const debounced = ref('')
const composing = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  if (composing.value) return
  timer = setTimeout(() => (debounced.value = v), 250)
})

// 정렬은 서버가 한다 — 불러온 200건만 정렬하면 "가장 큰 값" 이 실제와 다르다
const sort = ref<'updatedAt' | 'drawingNo' | 'title' | 'currentRev' | 'docType'>('updatedAt')
const dir = ref<SortDir>('desc')
function onSort(key: string, d: SortDir) {
  sort.value = key as typeof sort.value
  dir.value = d
}

/** 서버에 보내는 검색조건 — 상세 화면의 넘겨보기도 이 조건 그대로 쓴다 */
const filters = computed(() => ({
  folderId: folder.value?.id,
  recursive: recursive.value,
  q: debounced.value || undefined,
  searchTarget: searchTarget.value,
  includeIsometric: includeIsometric.value,
  status: status.value === 'in_cart' ? 'all' as const : status.value,
  hold: hold.value,
  sort: sort.value,
  dir: dir.value,
}))
const params = computed(() => ({ ...filters.value, limit: limit.value }))

const {
  data,
  isFetching,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
} = useInfiniteQuery({
  queryKey: computed(() => qk.documents.list(params.value)),
  queryFn: ({ pageParam }) =>
    api.get<DocumentListResponse>(`/documents${qs({ ...params.value, cursor: pageParam ?? undefined })}`),
  initialPageParam: null as string | null,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  staleTime: staleTime.list,
  enabled: computed(() => !cartView.value),
})

const serverRows = computed(() => data.value?.pages.flatMap((p) => p.items) ?? [])

// ── 반출대기함 ─────────────────────────────────────────────────────────
// 기존 화면처럼 **줄 체크와 대기함은 따로다** — 체크한 줄을 [선택 반출] 로 담고,
// [폴더 반출] 은 체크와 무관하게 폴더 전부를 담는다. 대기함은 sessionStorage 에 남아
// 상세 화면을 다녀오거나 새로고침해도 그대로다(탭을 닫으면 비워진다).
const CART_KEY = 'tdb-cart'

function loadCart(): Map<number, DocumentListItem> {
  try {
    const raw = sessionStorage.getItem(CART_KEY)
    const list = raw ? (JSON.parse(raw) as DocumentListItem[]) : []
    return new Map(list.map((r) => [r.id, r]))
  } catch {
    return new Map()
  }
}

const cart = ref(loadCart())
watch(cart, (m) => {
  try {
    sessionStorage.setItem(CART_KEY, JSON.stringify([...m.values()]))
  } catch {
    message.value = { kind: 'err', text: '반출대기함이 너무 커서 저장하지 못했습니다. 새로고침하면 비워집니다.' }
  }
})

function addToCart(list: DocumentListItem[]): number {
  const next = new Map(cart.value)
  let added = 0
  for (const r of list) {
    if (!next.has(r.id)) added++
    next.set(r.id, r)
  }
  cart.value = next
  return added
}

function removeFromCart(ids: Iterable<number>) {
  const next = new Map(cart.value)
  for (const id of ids) next.delete(id)
  cart.value = next
}

function clearCart() {
  cart.value = new Map()
}

// '반출대기' 상태로 고르면 대기함을 목록 자리에 보여준다. 검색어는 화면에서 거른다.
const cartViewRows = computed(() => {
  const kw = debounced.value.trim().toLowerCase()
  const all = [...cart.value.values()]
  if (!kw) return all
  return all.filter((r) =>
    searchTarget.value === 'folder'
      ? r.folderName.toLowerCase().includes(kw)
      : `${r.drawingNo} ${r.title}`.toLowerCase().includes(kw))
})

const rows = computed(() => (cartView.value ? cartViewRows.value : serverRows.value))
const total = computed(() =>
  (cartView.value ? cartViewRows.value.length : data.value?.pages[0]?.total ?? 0))

// ── 줄 체크 — [선택 반출] 로 대기함에 담을 후보 ───────────────────────
const checked = ref(new Set<number>())

function toggle(id: number) {
  const next = new Set(checked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checked.value = next
}

function toggleAll(on: boolean) {
  const next = new Set(checked.value)
  for (const r of rows.value) {
    if (on) next.add(r.id)
    else next.delete(r.id)
  }
  checked.value = next
}

function clearChecked() {
  checked.value = new Set()
}

/** [선택 반출] — 체크한 줄을 대기함에 담고 체크는 푼다 */
function addCheckedToCart() {
  if (!checked.value.size) {
    message.value = { kind: 'err', text: '반출대기함에 담을 자료를 먼저 체크하세요.' }
    return
  }
  const picked = rows.value.filter((r) => checked.value.has(r.id))
  const added = addToCart(picked)
  clearChecked()
  message.value = { kind: 'ok', text: `${added}건을 반출대기함에 담았습니다. (대기함 ${cart.value.size}건)` }
}

// [폴더 반출] — 체크와 무관하게 지금 고른 폴더(하위 폴더 포함)의 자료 전부를 담는다.
const folderAdd = ref<{ name: string; items: DocumentListItem[] } | null>(null)
const folderLoading = ref(false)

async function startFolderAdd() {
  if (!folder.value) {
    message.value = { kind: 'err', text: '먼저 좌측에서 폴더를 선택해주세요.' }
    return
  }
  if (folderLoading.value) return
  folderLoading.value = true
  try {
    const r = await api.get<FolderDocumentsResponse>(`/documents/by-folder${qs({
      folderId: folder.value.id,
      recursive: true,
      includeIsometric: includeIsometric.value,
    })}`)
    if (!r.items.length) {
      message.value = { kind: 'err', text: '이 폴더에는 자료가 없습니다.' }
      return
    }
    folderAdd.value = { name: folder.value.name, items: r.items }
  } catch (e) {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '폴더 자료를 불러오지 못했습니다.' }
  } finally {
    folderLoading.value = false
  }
}

function confirmFolderAdd() {
  if (!folderAdd.value) return
  const added = addToCart(folderAdd.value.items)
  message.value = { kind: 'ok', text: `${added}건을 반출대기함에 담았습니다. (대기함 ${cart.value.size}건)` }
  folderAdd.value = null
}

// 반출대기함 창 — 담긴 목록을 보고, 골라 빼고, 엑셀로 받고, 반출한다.
const cartOpen = ref(false)
const cartPicked = ref(new Set<number>())
const cartList = computed(() => [...cart.value.values()])

function toggleCartPick(id: number) {
  const next = new Set(cartPicked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  cartPicked.value = next
}

function removePicked() {
  removeFromCart(cartPicked.value)
  cartPicked.value = new Set()
}

const CART_COLUMNS: Column<DocumentListItem>[] = [
  { key: 'drawingNo', label: '자료명', width: '200px' },
  { key: 'title', label: '내용' },
  { key: 'docType', label: '분류', width: '130px', render: (r) => r.docType ?? '' },
  { key: 'folderName', label: '경로', width: '180px' },
]

function reset() {
  keyword.value = ''
  debounced.value = ''
  searchTarget.value = 'title'
  includeIsometric.value = false
  recursive.value = false
  status.value = 'all'
  hold.value = 'all'
  limit.value = 200
}

// ── 상세로 — 넘겨보기가 이 목록의 조건·정렬을 따라가도록 남긴다 ─────────
function openDetail(row: DocumentListItem) {
  if (cartView.value) {
    // 대기함 보기는 서버 목록이 아니라 넘겨볼 순서가 없다
    void router.push(`/documents/${row.id}`)
    return
  }
  saveListNav(filters.value)
  void router.push({ path: `/documents/${row.id}`, query: { from: NAV_FROM_LIST } })
}

// ── 폐기 보관함 (보기 전용) ─────────────────────────────────────────────
// 관리 화면과 같은 목록을 보기만 한다 — 복구·비고는 TDB 관리에서 (기존 2026-08-30 CM 확정).
const retiredOpen = ref(false)
const { data: retired } = useQuery({
  queryKey: ['documents', 'retired-view'],
  queryFn: () => api.get<ArchiveListResponse>('/documents/retired'),
  staleTime: staleTime.list,
})

const RETIRED_COLUMNS: Column<ArchiveBatch>[] = [
  { key: 'label', label: '자료명', width: '200px' },
  { key: 'originalPath', label: '원래 경로', render: (b) => b.originalPath ?? '' },
  { key: 'reason', label: '폐기 사유', width: '180px', render: (b) => b.reason ?? '' },
  { key: 'archivedAt', label: '폐기일시', width: '130px', align: 'center',
    render: (b) => b.archivedAt.slice(0, 16).replace('T', ' ') },
  { key: 'archivedBy', label: '처리자', width: '96px', align: 'center', render: (b) => b.archivedBy ?? '' },
  { key: 'note', label: '비고', width: '180px', render: (b) => b.note ?? '' },
]

// ── TDB 수정 (최근수정본) ───────────────────────────────────────────────
// 기존 상단 [TDB 수정 (N)] 단추와 'TDB 최근수정 현황' 창. 건수는 누구나 같은 숫자를 본다.
// 기준일은 서버(contracts RECENT_*_DAYS)와 같다 — 값을 계약에서 가져오면 Zod 가 청크에 끌려온다.
const RECENT_STRONG_DAYS = 30
const RECENT_SOFT_DAYS = 90
const recentOpen = ref(false)
const recentKind = ref<'ALL' | 'REVISION' | 'INFO'>('ALL')
const recentModified = ref<'ALL' | 'D30' | 'D31_90' | 'D91'>('ALL')

const { data: recentSummary } = useQuery({
  queryKey: ['documents', 'recent-changes', 'summary'],
  queryFn: () => api.get<RecentChangesSummary>('/documents/recent-changes/summary'),
  staleTime: staleTime.list,
})

const { data: recent, isFetching: recentLoading } = useQuery({
  queryKey: ['documents', 'recent-changes', RECENT_SOFT_DAYS],
  queryFn: () => api.get<RecentChangesResponse>(`/documents/recent-changes${qs({ days: RECENT_SOFT_DAYS })}`),
  enabled: computed(() => recentOpen.value),
  staleTime: staleTime.list,
})

/** 두 드롭다운은 화면에서 거른다 — 엑셀은 DataTable 이 보이는 그대로 내보내므로 표와 같다 */
const recentRows = computed(() => {
  const now = Date.now()
  const strong = now - RECENT_STRONG_DAYS * 86_400_000
  const soft = now - RECENT_SOFT_DAYS * 86_400_000
  return (recent.value?.items ?? []).filter((r) => {
    if (recentKind.value !== 'ALL' && r.changeKind !== recentKind.value) return false
    const t = Date.parse(r.updatedAt)
    switch (recentModified.value) {
      case 'D30': return t >= strong
      case 'D31_90': return t >= soft && t < strong
      case 'D91': return t < soft
      default: return true
    }
  })
})

const changeText = (r: RecentChangeItem) =>
  (r.changeKind === 'REVISION' ? `Rev ${r.revFrom} → ${r.revTo}` : '일반 수정')

const RECENT_COLUMNS: Column<RecentChangeItem>[] = [
  { key: 'updatedAt', label: '수정일', width: '130px', align: 'center',
    render: (r) => r.updatedAt.slice(0, 16).replace('T', ' ') },
  { key: 'drawingNo', label: '자료명', width: '200px' },
  { key: 'category', label: '분류', width: '110px', render: (r) => r.category ?? '' },
  { key: 'path', label: '경로' },
  { key: 'currentRev', label: 'Rev', width: '56px', align: 'center', render: (r) => String(r.currentRev) },
  { key: 'projectName', label: '공사', width: '120px', render: (r) => r.projectName ?? '' },
  { key: 'vendorName', label: '업체', width: '110px', render: (r) => r.vendorName ?? '' },
  { key: 'changeKind', label: '변경 내용', width: '110px', align: 'center', render: changeText },
  { key: 'changedBy', label: '수정자', width: '90px', align: 'center', render: (r) => r.changedBy ?? '' },
]

function openRecentDetail(r: RecentChangeItem) {
  recentOpen.value = false
  void router.push(`/documents/${r.id}`)
}

// ── 전체 엑셀 다운로드 (서버 비동기 작업) ──────────────────────────────
const exportJobId = ref<number | null>(null)
const exportingServer = ref(false)

async function startServerExport() {
  if (exportingServer.value) return
  exportingServer.value = true
  try {
    const res = await api.post<JobCreated>('/jobs/excel-export', {
      target: 'tdb_documents',
      filters: {
        folderId: folder.value?.id,
        q: debounced.value || undefined,
        searchTarget: searchTarget.value,
        recursive: recursive.value,
        includeIsometric: includeIsometric.value,
        status: filters.value.status,
        hold: hold.value,
      },
      filename: `TDB_자료목록_${new Date().toISOString().slice(0, 10)}.xlsx`,
    })
    exportJobId.value = res.jobId
    message.value = {
      kind: 'ok',
      text: '전체 엑셀 생성을 서버에 요청했습니다. 아래 진행률에서 완료 후 다운로드할 수 있습니다.',
    }
  } catch (e) {
    message.value = {
      kind: 'err',
      text: e instanceof ApiError ? e.message : '엑셀 내보내기 요청에 실패했습니다.',
    }
  } finally {
    exportingServer.value = false
  }
}

// 행에 마우스를 올리면 상세를 미리 받아 둔다 — 클릭 시 체감 0ms
function prefetch(row: DocumentListItem) {
  void qc.prefetchQuery({
    queryKey: qk.documents.detail(row.id),
    queryFn: () => api.get(`/documents/${row.id}`),
    staleTime: staleTime.detail,
  })
}

// ── 반출 실행 ──────────────────────────────────────────────────────────
// 반출대기함에 담은 것을 업체에 내보낸다. Zip 만들기는 워커가 한다.
const distOpen = ref(false)
/** 수정용 반출만 권한을 본다 — 참조용·기타는 누구나 (기존 정책) */
const canModify = computed(() => session.can('screen.tdb_list.distribute.modify'))

function openDistribute() {
  if (!cart.value.size) return
  // 수정용 권한이 없으면 참조용으로 시작한다 — 수정용은 고를 수 없게 잠근다
  if (!canModify.value && dist.value.purpose === 'MODIFY') dist.value.purpose = 'REFERENCE'
  cartOpen.value = false
  distOpen.value = true
}
const distJobId = ref<number | null>(null)
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const warnings = ref<CreateDistributionResult['duplicateWarnings']>([])

const dist = ref({
  vendorId: '' as string | number,
  vendorName: '',
  projectId: '' as string | number,
  purpose: 'MODIFY' as 'MODIFY' | 'REFERENCE' | 'ETC',
  purposeNote: '',
  keepPaths: true,
})

const { data: distOpts } = useQuery({
  queryKey: ['dist-filter-options'],
  queryFn: () => api.get<FilterOptions>('/distributions/filter-options'),
  staleTime: staleTime.types,
  enabled: computed(() => distOpen.value),
})

function onVendorPick(id: string) {
  dist.value.vendorId = id
  dist.value.vendorName = distOpts.value?.vendors.find((v) => String(v.id) === id)?.name ?? ''
}

async function submitDistribution() {
  try {
    const r = await api.post<CreateDistributionResult>('/distributions', {
      documentIds: [...cart.value.keys()],
      vendorId: dist.value.vendorId ? Number(dist.value.vendorId) : null,
      vendorName: dist.value.vendorName,
      projectId: dist.value.projectId ? Number(dist.value.projectId) : null,
      purpose: dist.value.purpose,
      purposeNote: dist.value.purposeNote || null,
      keepPaths: dist.value.keepPaths,
    })
    distOpen.value = false
    distJobId.value = r.jobId
    warnings.value = r.duplicateWarnings
    message.value = {
      kind: r.duplicateWarnings.length ? 'err' : 'ok',
      text: r.duplicateWarnings.length
        ? `${r.created}건을 반출했습니다. ${r.duplicateWarnings.length}건은 이미 다른 업체가 수정 중입니다.`
        : `${r.created}건을 반출했습니다. (${r.zipName})`,
    }
    clearCart()
    void qc.invalidateQueries({ queryKey: qk.documents.all })
  } catch (e) {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '반출하지 못했습니다.' }
  }
}

/* 너비는 가장 긴 실제 값이 들어가게 잡았다 —
   '대한엔지니어링 대여중'(상태), 'GH-BULK-050000'(자료명), '5.3 INSTRUMENT'(폴더).
   사용자가 끌어서 바꾸면 그 값이 기억된다. */
const columns = computed<Column<DocumentListItem>[]>(() => [
  { key: 'drawingNo', label: '자료명', width: '168px', sortable: true },
  { key: 'title', label: '내용', sortable: true },
  { key: 'folderName', label: '폴더', width: '160px', sortable: false },
  { key: 'currentRev', label: 'Rev', width: '62px', align: 'center', sortable: true,
    render: (r) => `Rev${r.currentRev}` },
  {
    key: 'hold', label: '원본/사본', width: '96px', align: 'center', sortable: false,
    render: (r) => [r.hasDwg ? 'DWG' : '', r.hasPdf ? 'PDF' : ''].filter(Boolean).join('/') || '-',
  },
  {
    key: 'status', label: '상태', width: '158px', sortable: false,
    render: (r) => (r.lentTo ? `${r.lentTo} 대여중` : STATUS_LABEL[r.status] ?? r.status),
  },
  {
    key: 'updatedAt', label: '최종수정', width: '104px', align: 'center', sortable: true,
    render: (r) => r.updatedAt.slice(0, 10),
  },
])


</script>

<template>
  <main class="app-main list-main">
    <div class="panel search-panel">
      <div class="search-row">
        <select v-model="searchTarget">
          <option value="title">자료명 검색</option>
          <option value="folder">폴더명 검색</option>
        </select>
        <input
          v-model="keyword" type="text" placeholder="검색어"
          style="flex:1;min-width:160px"
          @compositionstart="composing = true"
          @compositionend="composing = false; debounced = keyword"
        />
        <select v-model="status">
          <option value="all">전체</option><option value="normal">정상</option>
          <option value="distributed">반출</option><option value="in_cart">반출대기</option>
          <option value="review">검수</option><option value="archived">삭제</option>
        </select>
        <select v-model="hold">
          <option value="all">원본/사본 전체</option><option value="both">원본/사본 있음</option>
          <option value="dwg_only">원본만 있음</option><option value="pdf_only">사본만 있음</option>
        </select>
        <select v-model="limit" title="한 번에 불러올 건수">
          <option :value="200">200건씩</option>
          <option :value="500">500건씩</option>
          <option :value="1000">1000건씩</option>
        </select>
        <label class="chk"><input v-model="includeIsometric" type="checkbox" /> Isometric 보기</label>
        <label class="chk" title="고른 폴더 아래 모든 하위 폴더의 자료까지 보여줍니다">
          <input v-model="recursive" type="checkbox" /> 하위폴더 전체보기
        </label>
        <button
          class="btn btn-sm btn-icon"
          type="button"
          title="조건 초기화"
          aria-label="조건 초기화"
          @click="reset"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
      <div class="search-meta">
        <span class="muted">
          <span v-if="cartView">반출대기함</span>
          <span v-else-if="folder">{{ folder.name }}{{ recursive ? ' (하위폴더 포함)' : '' }}</span>
          <span v-else>전체 폴더</span>
          <span v-if="!cartView && isFetching && !isFetchingNextPage"> · 조회 중…</span>
          <span v-else-if="!cartView && isFetchingNextPage"> · 다음 페이지 불러오는 중…</span>
        </span>
        <button v-if="checked.size" class="btn btn-sm" title="체크해 둔 자료를 모두 해제합니다"
                @click="clearChecked">선택 초기화 ({{ checked.size }})</button>
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="folderLoading" title="고른 폴더(하위 폴더 포함)의 자료 전부를 반출대기함에 담습니다"
                @click="startFolderAdd">폴더 반출</button>
        <button class="btn btn-sm" title="체크한 자료를 반출대기함에 담습니다" @click="addCheckedToCart">선택 반출</button>
        <button class="btn btn-sm" @click="cartOpen = true">반출대기함 ({{ cart.size }})</button>
        <span class="sep" />
        <button class="btn btn-sm" title="최근 90일 이내 수정된 자료" @click="recentOpen = true">
          TDB 수정 <span class="cnt">{{ recentSummary?.count ?? 0 }}</span>
        </button>
        <button class="btn btn-sm" title="폐기된 자료를 봅니다 (보기 전용)" @click="retiredOpen = true">
          폐기 보관함 <span class="cnt">{{ retired?.count ?? 0 }}</span>
        </button>
      </div>
    </div>

    <div class="split">
      <aside class="panel tree-panel">
        <LazyTree doc-class="TDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
      </aside>

      <div class="panel table-panel">
        <DataTable
          :columns="columns" :rows="rows" selectable :selected="checked"
          :loading="!cartView && isFetching && !isFetchingNextPage && !rows.length"
          :total="total" :sort-key="sort" :sort-dir="dir" storage-key="tdb-list" excel-name="TDB 자료목록"
          :has-more="!cartView && hasNextPage" :loading-more="isFetchingNextPage"
          :server-excel="!cartView" :server-exporting="exportingServer"
          :empty-text="cartView ? '반출대기함이 비어 있습니다.' : undefined"
          @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
          @export-server="startServerExport"
          @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
          @row-hover="prefetch"
          @row-click="openDetail"
        />
      </div>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      <div>
        {{ message.text }}
        <div v-for="w in warnings" :key="w.documentId" class="sub">
          · {{ w.drawingNo }} — {{ w.vendorName }} 대여중 ({{ w.distributedAt.slice(0, 10) }})
        </div>
      </div>
      <span style="flex:1" />
      <button class="btn btn-sm" @click="message = null; warnings = []">닫기</button>
    </div>

    <div v-if="distJobId !== null" class="panel">
      <JobProgress :job-id="distJobId" />
    </div>

    <div v-if="exportJobId !== null" class="panel">
      <div style="display:flex;align-items:center;padding:8px 12px;font-size:var(--fs-sm);font-weight:600">
        <span>전체 엑셀 다운로드 (서버 작업)</span>
        <span style="flex:1" />
        <button class="btn btn-sm" @click="exportJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="exportJobId" @done="message = { kind: 'ok', text: '전체 엑셀 생성이 완료되었습니다. 받기를 눌러 다운로드하세요.' }" />
    </div>

    <!-- 폴더 반출 확인 -->
    <Modal v-if="folderAdd" title="폴더 반출" @close="folderAdd = null">
      <p>
        이 폴더(<strong>{{ folderAdd.name }}</strong>, 하위 폴더 포함)의 자료
        <strong>{{ folderAdd.items.length }}</strong>건을 반출대기함에 모두 추가하시겠습니까?
      </p>
      <template #footer>
        <button class="btn" @click="folderAdd = null">취소</button>
        <button class="btn btn-primary" @click="confirmFolderAdd">추가</button>
      </template>
    </Modal>

    <!-- 반출대기함 -->
    <Modal v-if="cartOpen" wide title="반출대기함" @close="cartOpen = false">
      <div class="cart-grid">
        <DataTable
          :columns="CART_COLUMNS" :rows="cartList" :total="cartList.length"
          selectable :selected="cartPicked"
          storage-key="tdb-cart" excel-name="TDB 조회_반출대기함"
          empty-text="반출대기함이 비어 있습니다. 목록에서 체크한 뒤 [선택 반출] 또는 [폴더 반출] 로 담으세요."
          @toggle="toggleCartPick"
          @toggle-all="(on) => { cartPicked = on ? new Set(cartList.map((r) => r.id)) : new Set() }"
        />
      </div>
      <template #footer>
        <button class="btn" @click="cartOpen = false">닫기</button>
        <button class="btn" :disabled="!cartPicked.size" @click="removePicked">
          삭제{{ cartPicked.size ? ` (${cartPicked.size})` : '' }}
        </button>
        <button class="btn" :disabled="!cart.size" @click="clearCart(); cartPicked = new Set()">전체 비우기</button>
        <button class="btn btn-primary" :disabled="!cart.size" @click="openDistribute">이 목록으로 반출하기</button>
      </template>
    </Modal>

    <!-- 폐기 보관함 (보기 전용) -->
    <Modal v-if="retiredOpen" wide title="폐기 보관함" @close="retiredOpen = false">
      <p class="muted small" style="margin-top:0">
        보기 전용입니다. 복구·비고 작성은 TDB 관리 화면에서 합니다.
      </p>
      <div class="cart-grid">
        <DataTable
          :columns="RETIRED_COLUMNS" :rows="retired?.items ?? []" :total="retired?.count ?? 0"
          storage-key="tdb-retired-view" excel-name="TDB 조회_폐기 보관함"
          empty-text="폐기된 자료가 없습니다."
        />
      </div>
    </Modal>

    <!-- TDB 최근수정 현황 -->
    <Modal v-if="recentOpen" wide title="TDB 최근수정 현황" @close="recentOpen = false">
      <div class="recent-bar">
        <span v-if="recent">
          최근 {{ recent.days }}일 이내 수정 <b>({{ recent.total }})</b>
          = Revision 수정 <b>({{ recent.revisionCount }})</b>
          + 일반 수정 <b>({{ recent.total - recent.revisionCount }})</b>
        </span>
        <span v-else-if="recentLoading" class="muted">불러오는 중…</span>
        <span style="flex:1" />
        <label>수정 구분
          <select v-model="recentKind">
            <option value="ALL">전체</option>
            <option value="REVISION">Revision 수정</option>
            <option value="INFO">일반 수정</option>
          </select>
        </label>
        <label>수정일
          <select v-model="recentModified">
            <option value="ALL">전체</option>
            <option value="D30">오늘~30일</option>
            <option value="D31_90">31일~90일</option>
            <option value="D91">91일 이전</option>
          </select>
        </label>
      </div>
      <div class="cart-grid">
        <DataTable
          :columns="RECENT_COLUMNS" :rows="recentRows" :total="recentRows.length"
          :loading="recentLoading && !recent"
          :row-class="(r) => (r.changeKind === 'REVISION' ? 'cur' : '')"
          storage-key="tdb-recent-changes" excel-name="최근수정본"
          empty-text="최근 수정된 자료가 없습니다."
          @row-click="openRecentDetail"
        >
          <template #cell:changeKind="{ row }">
            <span class="badge" :class="row.changeKind === 'REVISION' ? 'rev' : ''">{{ changeText(row) }}</span>
          </template>
        </DataTable>
      </div>
    </Modal>

    <!-- 반출하기 -->
    <Modal v-if="distOpen" title="반출하기" @close="distOpen = false">
      <p class="muted">반출대기함의 {{ cart.size }}건을 업체에 내보냅니다. Zip 은 뒤에서 만듭니다.</p>
      <table class="form">
        <tbody>
          <tr>
            <th>업체</th>
            <td>
              <select :value="dist.vendorId" @change="onVendorPick(($event.target as HTMLSelectElement).value)">
                <option value="">업체 선택</option>
                <option v-for="v in distOpts?.vendors ?? []" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
            </td>
          </tr>
          <tr>
            <th>공사</th>
            <td>
              <select v-model="dist.projectId">
                <option value="">공사 선택</option>
                <option v-for="p in distOpts?.projects ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </td>
          </tr>
          <tr>
            <th>목적</th>
            <td>
              <label class="r" :class="{ off: !canModify }"
                     :title="canModify ? '' : '수정용 반출 권한이 없습니다'">
                <input v-model="dist.purpose" type="radio" value="MODIFY" :disabled="!canModify" /> 수정용
              </label>
              <label class="r"><input v-model="dist.purpose" type="radio" value="REFERENCE" /> 참조용</label>
              <label class="r"><input v-model="dist.purpose" type="radio" value="ETC" /> 기타</label>
            </td>
          </tr>
          <tr>
            <th>비고</th>
            <td><input v-model="dist.purposeNote" type="text" placeholder="목적 상세" style="width:100%" /></td>
          </tr>
          <tr>
            <th>Zip 구성</th>
            <td><label class="r"><input v-model="dist.keepPaths" type="checkbox" /> 폴더 경로 유지</label></td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">
        수정용으로 내보낼 때 이미 다른 업체가 수정 중이면 경고합니다 — 막지는 않습니다.
        두 업체가 같은 자료를 고치면 분기 리비전으로 각각 보관되고, 사람이 CAD 로 통합해야 합니다.
      </p>
      <template #footer>
        <button class="btn" @click="distOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="!dist.vendorName" @click="submitDistribution">반출</button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
.list-main { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.search-panel { padding: 10px 12px; flex: 0 0 auto; }
.search-row { display: flex; gap: var(--gap-sm); flex-wrap: wrap; align-items: center; }
.search-meta {
  margin-top: 8px; font-size: var(--fs-sm);
  display: flex; align-items: center; gap: var(--gap-sm); flex-wrap: wrap;
}
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
.cnt {
  display: inline-block; min-width: 17px; padding: 0 4px; margin-left: 3px;
  background: var(--accent); color: var(--primary-fg); border-radius: 9px; font-size: 10px; text-align: center;
}
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }

/* 조회부는 맨 위에 가로로 펴 두고, 그 아래를 트리·그리드 두 칸으로 가른다.
   트리를 셸의 app-side(내비 옆 기둥)에 두면 조회부까지 옆으로 밀려 검색 줄이
   좁아진다 — 거르개가 7개라 그 줄이 제일 먼저 접힌다.
   다른 화면(MDB 조회·TDB/MDB 관리)은 app-side 를 그대로 쓰므로 공통 CSS 는 건드리지 않았다. */
.split { flex: 1; display: flex; gap: var(--gap); min-height: 0; }
.tree-panel {
  width: 268px; min-width: 268px; flex: 0 0 268px;
  overflow: auto;
}
.table-panel {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
}
.table-panel > * {
  flex: 1; min-width: 0;
}

/* 좁은 화면에서는 세로로 쌓는다 — 268px 를 빼면 그리드가 읽히지 않는다 */
@media (max-width: 900px) {
  .split { flex-direction: column; }
  .tree-panel { width: auto; min-width: 0; max-height: 240px; flex: 0 0 auto; }
  .table-panel { min-height: 320px; }
}
/* 창 안의 그리드 — 스크롤은 DataTable 이 맡으므로 높이만 내준다 */
.cart-grid { height: 60vh; min-height: 280px; display: flex; }
.cart-grid > * { flex: 1; min-width: 0; }
.recent-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; font-size: var(--fs-sm); }
.recent-bar label { display: flex; align-items: center; gap: 4px; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border-strong); }
.badge.rev { background: var(--warn-bg, #fff4d6); }
.off { opacity: .55; }
.msg { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; flex: 0 0 auto; }
.sub { font-size: var(--fs-sm); margin-top: 3px; }
.form th, .form td { padding: 5px 8px; text-align: left; }
.form th { width: 80px; font-weight: 600; white-space: nowrap; }
.r { margin-right: 12px; }
.small { font-size: var(--fs-sm); margin-top: 10px; }
</style>
