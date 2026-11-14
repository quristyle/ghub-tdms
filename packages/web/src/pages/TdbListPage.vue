<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type {
  ArchiveBatch, ArchiveListResponse, CreateDistributionResult, DocumentListItem,
  DocumentListResponse, FilterOptions, FolderDocumentsResponse, FolderNode, JobCreated,
} from '@tdms/contracts'
import FolderTreePanel from '@/ui/FolderTreePanel.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { DOC_STATUS_BADGE as STATUS_BADGE, DOC_STATUS_LABEL as STATUS_LABEL } from '@/lib/labels'
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

/**
 * 수정일 — 여러 구간을 함께 고를 수 있다(비우면 전체). 목록 '최종수정' 색 단계와 같은 구간이다.
 * 기존 화면의 체크박스 드롭다운과 같은 규칙: 다 풀면 전체로 돌아간다.
 */
const RECENT_STRONG_DAYS = 30
const RECENT_SOFT_DAYS = 90
type ModifiedScope = 'D30' | 'D31_90' | 'D91'
const MODIFIED_OPTIONS: { value: ModifiedScope; label: string }[] = [
  { value: 'D30', label: `오늘~${RECENT_STRONG_DAYS}일` },
  { value: 'D31_90', label: `${RECENT_STRONG_DAYS + 1}일~${RECENT_SOFT_DAYS}일` },
  { value: 'D91', label: `${RECENT_SOFT_DAYS + 1}일 이전` },
]
const modified = ref<ModifiedScope[]>([])
const modifiedOpen = ref(false)
const modifiedLabel = computed(() =>
  (modified.value.length
    ? MODIFIED_OPTIONS.filter((o) => modified.value.includes(o.value)).map((o) => o.label).join(', ')
    : '전체'))
function toggleModified(v: ModifiedScope) {
  modified.value = modified.value.includes(v)
    ? modified.value.filter((x) => x !== v)
    : [...modified.value, v]
}
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
  modified: modified.value.length ? modified.value : undefined,
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

/** [검색] — 입력 중 기다리지 않고 바로 조회한다 (기존 화면의 검색 버튼) */
function doSearch() {
  clearTimeout(timer)
  debounced.value = keyword.value
}

function reset() {
  keyword.value = ''
  debounced.value = ''
  searchTarget.value = 'title'
  includeIsometric.value = false
  recursive.value = false
  status.value = 'all'
  hold.value = 'all'
  modified.value = []
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

/* 기존 화면(index.html)의 열 구성 그대로:
   자료명 · 분류 · 경로 · Rev · 상태 · DWG · XLSX · ETC · PDF · 최종수정.
   너비도 그때의 colgroup 값을 따른다. 사용자가 끌어서 바꾸면 그 값이 기억된다. */
const yn = (on: boolean) => (on ? 'Y' : '\u00b7')

const columns = computed<Column<DocumentListItem>[]>(() => [
  { key: 'drawingNo', label: '자료명', width: '220px', sortable: true },
  { key: 'docType', label: '분류', width: '100px', sortable: true, render: (r) => r.docType ?? '\u00b7' },
  { key: 'folderName', label: '경로', sortable: false },
  { key: 'currentRev', label: 'Rev', width: '50px', align: 'center', sortable: true,
    render: (r) => String(r.currentRev) },
  { key: 'status', label: '상태', width: '92px', align: 'center', sortable: false,
    render: (r) => (r.lentTo ? `${r.lentTo} 대여중` : STATUS_LABEL[r.status] ?? r.status) },
  { key: 'hasDwg', label: 'DWG', width: '58px', align: 'center', sortable: false, render: (r) => yn(r.hasDwg) },
  { key: 'hasXlsx', label: 'XLSX', width: '58px', align: 'center', sortable: false, render: (r) => yn(r.hasXlsx) },
  { key: 'hasEtc', label: 'ETC', width: '58px', align: 'center', sortable: false, render: (r) => yn(r.hasEtc) },
  { key: 'hasPdf', label: 'PDF', width: '58px', align: 'center', sortable: false, render: (r) => yn(r.hasPdf) },
  { key: 'updatedAt', label: '최종수정', width: '134px', align: 'center', sortable: true,
    render: (r) => r.updatedAt.slice(0, 10) },
])

/**
 * '최종수정' 날짜 색 — 최근일수록 눈에 띄게 두 단계. 수정일 거르개의 구간과 정확히 같다.
 * 등록만 되고 손댄 적 없는 자료는(그 날짜가 '등록한 날'이라) 색을 칠하지 않는다.
 */
function recentClass(r: DocumentListItem): string {
  if (!r.isModified) return ''
  const days = (Date.now() - Date.parse(r.updatedAt)) / 86_400_000
  if (days <= RECENT_STRONG_DAYS) return 'recent-strong'
  if (days <= RECENT_SOFT_DAYS) return 'recent-soft'
  return ''
}

</script>

<template>
  <main class="app-main">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          TDB 조회<span class="page-title-sub">Technical Data Book(도면·기술자료) 문서 조회 및 열람</span>
        </h1>
      </div>
      <div class="page-actions">
        <button type="button" @click="retiredOpen = true">
          폐기 보관함 <span class="tree-count">({{ retired?.count ?? 0 }})</span>
        </button>
      </div>
    </div>

    <!-- 폴더 계층은 좌측 트리가 담당하고, 여기는 검색 + 성격 조건. 한 줄에 배치. -->
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div class="field">
            <label for="kind_scope">검색대상</label>
            <select id="kind_scope" v-model="searchTarget">
              <option value="title">자료명</option>
              <option value="folder">폴더명</option>
            </select>
          </div>

          <div class="field">
            <label for="status">상태</label>
            <select id="status" v-model="status">
              <option value="all">전체</option>
              <option value="normal">정상</option>
              <option value="distributed">반출</option>
              <option value="in_cart">반출대기</option>
              <option value="review">검수</option>
              <option value="archived">삭제</option>
            </select>
          </div>

          <div class="field">
            <label for="holding">원본/사본</label>
            <select id="holding" v-model="hold">
              <option value="all">전체</option>
              <option value="both">원본/사본 있음</option>
              <option value="dwg_only">원본만 있음</option>
              <option value="pdf_only">사본만 있음</option>
            </select>
          </div>

          <div class="field">
            <label for="modified-toggle">수정일</label>
            <div class="hideable-dropdown ms-dropdown" @mouseleave="modifiedOpen = false">
              <button id="modified-toggle" type="button" class="dropdown-toggle"
                      :aria-expanded="modifiedOpen" @click="modifiedOpen = !modifiedOpen">
                <span class="dropdown-item-label">{{ modifiedLabel }}</span>
              </button>
              <div v-if="modifiedOpen" class="dropdown-list" role="listbox" aria-multiselectable="true">
                <label class="dropdown-item dropdown-item-ms">
                  <input type="checkbox" :checked="!modified.length" @change="modified = []" /> 전체
                </label>
                <label v-for="o in MODIFIED_OPTIONS" :key="o.value" class="dropdown-item dropdown-item-ms">
                  <input type="checkbox" :checked="modified.includes(o.value)"
                         @change="toggleModified(o.value)" /> {{ o.label }}
                </label>
              </div>
            </div>
          </div>

          <div class="field">
            <label for="limit">조회건수</label>
            <select id="limit" v-model="limit" title="한 번에 불러올 건수">
              <option :value="200">200건씩</option>
              <option :value="500">500건씩</option>
              <option :value="1000">1000건씩</option>
            </select>
          </div>

          <label class="check-inline field-check">
            <input v-model="includeIsometric" type="checkbox" /> Isometric 보기
          </label>

          <label class="check-inline field-check" title="고른 폴더 아래 모든 하위 폴더의 자료까지 보여줍니다">
            <input v-model="recursive" type="checkbox" /> 하위폴더 전체보기
          </label>

          <input
            v-model="keyword" type="text" class="filter-search" placeholder="자료명 검색"
            @compositionstart="composing = true"
            @compositionend="composing = false; debounced = keyword"
            @keyup.enter="doSearch"
          />
          <button id="search-btn" class="primary" type="button" @click="doSearch">검색</button>
        </div>

        <div class="filter-actions">
          <button type="button" @click="reset">조건 초기화</button>
        </div>
      </div>
    </div>

    <div class="main-layout">
      <FolderTreePanel
        doc-class="TDB" :selected-id="folder?.id ?? null"
        storage-key="tdb-list" @select="(f) => (folder = f)"
      />

      <div class="main-content">
        <div class="status-bar">
          <span class="status-bar-left">
            <span class="selected-folder-name">
              <template v-if="cartView">반출대기함</template>
              <template v-else-if="folder">{{ folder.name }}{{ recursive ? ' (하위폴더 포함)' : '' }}</template>
              <template v-else>전체 폴더</template>
            </span>
            <span class="total-count">전체 {{ total.toLocaleString() }}건</span>
            <button
              v-if="checked.size" class="clear-selection-btn" type="button"
              title="체크해둔 자료를 모두 해제합니다" @click="clearChecked"
            >선택 초기화 ({{ checked.size }})</button>
            <span v-if="!cartView && isFetching && !isFetchingNextPage" class="muted">&nbsp;· 조회 중…</span>
          </span>
          <span class="cart-status">
            <button
              class="cart-btn" type="button" :disabled="folderLoading"
              title="고른 폴더(하위 폴더 포함)의 자료 전부를 반출대기함에 담습니다"
              @click="startFolderAdd"
            >폴더 반출</button>
            <button class="cart-btn" type="button" title="체크한 자료를 반출대기함에 담습니다"
                    @click="addCheckedToCart">선택 반출</button>
            <button class="cart-btn" type="button" @click="cartOpen = true">
              반출대기함 ({{ cart.size }})
            </button>
            <button class="cart-btn" type="button" :disabled="exportingServer" @click="startServerExport">
              엑셀 내보내기
            </button>
          </span>
        </div>

        <div class="table-box">
          <DataTable
            :columns="columns" :rows="rows" selectable :selected="checked"
            :loading="!cartView && isFetching && !isFetchingNextPage && !rows.length"
            :total="total" :sort-key="sort" :sort-dir="dir" storage-key="tdb-list" excel-name="TDB 자료목록"
            :has-more="!cartView && hasNextPage" :loading-more="isFetchingNextPage"
            :empty-text="cartView ? '반출대기함이 비어 있습니다.' : undefined"
            @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
            @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
            @row-hover="prefetch"
            @row-click="openDetail"
          >
            <!-- 상태·보유·최종수정은 기존 화면처럼 배지·기호·색으로 그린다.
                 글자값(render)은 그대로라 거르기와 엑셀은 화면과 어긋나지 않는다. -->
            <template #cell:status="{ row }">
              <span v-if="row.lentTo" class="badge badge-warning">{{ row.lentTo }} 대여중</span>
              <span v-else class="badge" :class="STATUS_BADGE[row.status] ?? 'badge-neutral'">
                {{ STATUS_LABEL[row.status] ?? row.status }}
              </span>
            </template>
            <template #cell:hasDwg="{ row }"><span :class="row.hasDwg ? 'yn-y' : 'yn-n'">{{ yn(row.hasDwg) }}</span></template>
            <template #cell:hasXlsx="{ row }"><span :class="row.hasXlsx ? 'yn-y' : 'yn-n'">{{ yn(row.hasXlsx) }}</span></template>
            <template #cell:hasEtc="{ row }"><span :class="row.hasEtc ? 'yn-y' : 'yn-n'">{{ yn(row.hasEtc) }}</span></template>
            <template #cell:hasPdf="{ row }"><span :class="row.hasPdf ? 'yn-y' : 'yn-n'">{{ yn(row.hasPdf) }}</span></template>
            <template #cell:updatedAt="{ row }">
              <span :class="recentClass(row)">{{ row.updatedAt.slice(0, 10) }}</span>
            </template>
          </DataTable>
        </div>
      </div>
    </div>

    <div v-if="message" class="msg" :class="message.kind">
      <div>
        {{ message.text }}
        <div v-for="w in warnings" :key="w.documentId" class="sub">
          · {{ w.drawingNo }} — {{ w.vendorName }} 대여중 ({{ w.distributedAt.slice(0, 10) }})
        </div>
      </div>
      <span style="flex:1" />
      <button class="small" @click="message = null; warnings = []">닫기</button>
    </div>

    <div v-if="distJobId !== null" class="card">
      <JobProgress :job-id="distJobId" />
    </div>

    <div v-if="exportJobId !== null" class="card">
      <div class="section-head">
        <span>전체 엑셀 다운로드 (서버 작업)</span>
        <span style="flex:1" />
        <button class="small" @click="exportJobId = null">닫기</button>
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
        <button @click="folderAdd = null">취소</button>
        <button class="primary" @click="confirmFolderAdd">추가</button>
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
        <button @click="cartOpen = false">닫기</button>
        <button :disabled="!cartPicked.size" @click="removePicked">
          삭제{{ cartPicked.size ? ` (${cartPicked.size})` : '' }}
        </button>
        <button :disabled="!cart.size" @click="clearCart(); cartPicked = new Set()">전체 비우기</button>
        <button class="primary" :disabled="!cart.size" @click="openDistribute">이 목록으로 반출하기</button>
      </template>
    </Modal>

    <!-- 폐기 보관함 (보기 전용) -->
    <Modal v-if="retiredOpen" wide title="폐기 보관함" @close="retiredOpen = false">
      <p class="page-desc" style="margin-bottom:10px">
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

    <!-- 반출하기 -->
    <Modal v-if="distOpen" title="반출하기" @close="distOpen = false">
      <p class="page-desc">반출대기함의 {{ cart.size }}건을 업체에 내보냅니다. Zip 은 뒤에서 만듭니다.</p>

      <div class="modal-box-label">업체</div>
      <select :value="dist.vendorId" @change="onVendorPick(($event.target as HTMLSelectElement).value)">
        <option value="">업체 선택</option>
        <option v-for="v in distOpts?.vendors ?? []" :key="v.id" :value="v.id">{{ v.name }}</option>
      </select>

      <div class="modal-box-label">공사</div>
      <select v-model="dist.projectId">
        <option value="">공사 선택</option>
        <option v-for="p in distOpts?.projects ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>

      <div class="modal-box-label">반출 목적</div>
      <fieldset class="purpose-row">
        <label :class="{ 'perm-disabled': !canModify }"
               :title="canModify ? '' : '수정용 반출 권한이 없습니다'">
          <input v-model="dist.purpose" type="radio" value="MODIFY" :disabled="!canModify" /> 수정용
        </label>
        <label><input v-model="dist.purpose" type="radio" value="REFERENCE" /> 참조용</label>
        <label><input v-model="dist.purpose" type="radio" value="ETC" /> 기타</label>
      </fieldset>
      <textarea v-model="dist.purposeNote" placeholder="필요 시 사유를 입력해주세요" />

      <div class="modal-box-label">Zip 구성</div>
      <label class="check-inline"><input v-model="dist.keepPaths" type="checkbox" /> 폴더 경로 유지</label>

      <div class="warning-box">
        수정용으로 내보낼 때 이미 다른 업체가 수정 중이면 경고합니다 — 막지는 않습니다.
        두 업체가 같은 자료를 고치면 분기 리비전으로 각각 보관되고, 사람이 CAD 로 통합해야 합니다.
      </div>

      <template #footer>
        <button @click="distOpen = false">취소</button>
        <button class="primary" :disabled="!dist.vendorName" @click="submitDistribution">반출 실행</button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
/* 결과 표 — 폴더트리가 더 길어서 남는 높이가 생기면 그만큼 늘어난다 (기존 tree.css 규칙) */
.table-box {
  flex: 1 1 auto;
  min-height: 240px;
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table-box > * { flex: 1; min-width: 0; }

/* 좁은 화면에서는 세로로 쌓는다 — 트리 폭을 빼면 그리드가 읽히지 않는다 */
@media (max-width: 900px) {
  .main-layout { flex-direction: column; }
  .main-layout :deep(.tree-panel) { flex: 0 0 auto !important; max-height: 240px; }
  .main-layout :deep(.tree-resize-handle) { display: none; }
}

/* 창 안의 그리드 — 스크롤은 DataTable 이 맡으므로 높이만 내준다 */
.cart-grid { height: 60vh; min-height: 280px; display: flex; }
.cart-grid > * { flex: 1; min-width: 0; }

.purpose-row { display: flex; gap: 40px; }
.msg .sub { font-size: 11.5px; margin-top: 3px; }
.tree-count { color: var(--text-faint); font-size: 11px; font-weight: 400; }
</style>
