<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type {
  ArchiveBatch, ArchiveListResponse, CartAddResponse, CartFolderListResponse, CartItemListResponse,
  CatalogItem, CatalogListResponse,
  CreateDistributionResult, DocumentListItem, DocumentListResponse, DocumentSort,
  FolderDocumentsResponse, FolderNode, JobCreated,
} from '@tdms/contracts'
import FolderTreePanel from '@/ui/FolderTreePanel.vue'
import FloatField from '@/ui/FloatField.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import CartModal from '@/ui/CartModal.vue'
import ProjectManager from '@/ui/ProjectManager.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { toast } from '@/lib/toast'
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
const sort = ref<DocumentSort>('updatedAt')
const dir = ref<SortDir>('desc')
function onSort(key: string, d: SortDir | null) {
  if (!d) {
    sort.value = 'updatedAt'
    dir.value = 'desc'
  } else {
    sort.value = key as DocumentSort
    dir.value = d
  }
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

/**
 * 목록은 **창(窓) 방식**으로 받는다 — 전체를 다 받지 않고 보는 자리만 받는다.
 *
 * 3만 건짜리 목록에서 50쪽으로 갈 때 앞의 49쪽을 받지 않으려는 것이다.
 * 서버에 offset 을 주면 그 쪽만 한 번에 오므로(0.3초) 먼 쪽도 바로 열린다.
 * 스크롤로 빈 자리에 닿으면 그 자리의 쪽만 받아 채운다.
 *
 * 받아 둔 쪽은 react-query 가 들고 있으므로(쪽마다 열쇠가 따로다) 왔다 갔다 해도
 * 다시 받지 않는다. 조건이나 정렬이 바뀌면 열쇠가 통째로 바뀌어 저절로 비워진다.
 */
const PAGE_SPAN = 2   // 보이는 자리 앞뒤로 이만큼 더 받아 둔다 (스크롤이 끊기지 않게)

/** 받아 둔 쪽 — 쪽 번호(0부터) → 줄 목록. 조건이 바뀌면 통째로 비운다. */
const loaded = ref(new Map<number, DocumentListItem[]>())
const loadingPages = ref(new Set<number>())
const windowTotal = ref(0)
const firstLoad = ref(true)

watch(params, () => {
  loaded.value = new Map()
  loadingPages.value = new Set()
  windowTotal.value = 0
  firstLoad.value = true
  void loadPage(0)
}, { immediate: true })

async function loadPage(page: number) {
  if (cartView.value || page < 0) return
  if (loaded.value.has(page) || loadingPages.value.has(page)) return
  if (windowTotal.value && page * limit.value >= windowTotal.value) return

  loadingPages.value = new Set(loadingPages.value).add(page)
  const snapshot = params.value
  try {
    const r = await qc.fetchQuery({
      queryKey: qk.documents.list({ ...snapshot, offset: page * limit.value }),
      queryFn: () => api.get<DocumentListResponse>(
        `/documents${qs({ ...snapshot, offset: page * limit.value })}`),
      staleTime: staleTime.list,
    })
    // 받는 사이 조건이 바뀌었으면 버린다 — 옛 조건의 줄을 섞으면 안 된다
    if (JSON.stringify(snapshot) !== JSON.stringify(params.value)) return
    if (r.total !== null && r.total !== undefined) windowTotal.value = r.total
    const next = new Map(loaded.value)
    next.set(page, r.items)
    loaded.value = next
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '목록을 불러오지 못했습니다.')
  } finally {
    const n = new Set(loadingPages.value)
    n.delete(page)
    loadingPages.value = n
    firstLoad.value = false
  }
}

/** 그리드가 보고 있는 자리 — 그 둘레의 쪽을 받아 둔다 */
function onNeedRange(start: number, end: number) {
  const from = Math.max(0, Math.floor(start / limit.value) - PAGE_SPAN)
  const to = Math.floor(end / limit.value) + PAGE_SPAN
  for (let p = from; p <= to; p++) void loadPage(p)
}

/** i번째 줄 — 아직 안 받았으면 undefined (그리드가 빈 줄로 그린다) */
function rowAt(i: number): DocumentListItem | undefined {
  return loaded.value.get(Math.floor(i / limit.value))?.[i % limit.value]
}

/** 받아 둔 줄 전부 — 체크·엑셀·대기함 담기가 쓴다 */
const serverRows = computed(() =>
  [...loaded.value.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, v]) => v))

const isFetching = computed(() => firstLoad.value && loadingPages.value.size > 0)

// ── 반출대기함 (사용자별 개인 폴더 및 자료 관리) ─────────────────────────
const currentUserId = computed(() => session.me?.id ?? null)

const { data: cartFoldersData } = useQuery({
  queryKey: computed(() => qk.cart.folders(currentUserId.value)),
  queryFn: () => api.get<CartFolderListResponse>('/cart/folders'),
  staleTime: staleTime.worklist,
  enabled: computed(() => session.isLoggedIn),
})

const { data: serverCartData } = useQuery({
  queryKey: computed(() => qk.cart.items(currentUserId.value, 'all')),
  queryFn: () => api.get<CartItemListResponse>('/cart/items?folderId=all'),
  staleTime: staleTime.worklist,
  enabled: computed(() => session.isLoggedIn),
})

const cartCount = computed(() => cartFoldersData.value?.totalCount ?? serverCartData.value?.total ?? 0)
const cartDocIds = computed(() => new Set((serverCartData.value?.items ?? []).map((x) => x.id)))

// '반출대기' 상태로 고르면 대기함을 목록 자리에 보여준다. 검색어는 화면에서 거른다.
const cartViewRows = computed(() => {
  const kw = debounced.value.trim().toLowerCase()
  const all = (serverCartData.value?.items ?? []) as DocumentListItem[]
  if (!kw) return all
  return all.filter((r) =>
    searchTarget.value === 'folder'
      ? r.folderName.toLowerCase().includes(kw)
      : `${r.drawingNo} ${r.title}`.toLowerCase().includes(kw))
})

const rows = computed(() => (cartView.value ? cartViewRows.value : serverRows.value))

const total = computed(() =>
  (cartView.value ? cartViewRows.value.length : windowTotal.value))

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

/** [선택 반출] — 체크한 줄을 개인 반출대기함에 담고 체크는 푼다 */
async function addCheckedToCart() {
  if (!checked.value.size) {
    toast.err('반출대기함에 담을 자료를 먼저 체크하세요.')
    return
  }
  try {
    const res = await api.post<CartAddResponse>('/cart/items', {
      documentIds: [...checked.value],
    })
    clearChecked()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
    toast.ok(`${res.added}건을 반출대기함에 담았습니다. (대기함 ${res.total}건)`)
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '대기함 담기에 실패했습니다.')
  }
}

// [폴더 반출] — 체크와 무관하게 지금 고른 폴더(하위 폴더 포함)의 자료 전부를 담는다.
const folderAdd = ref<{ name: string; items: DocumentListItem[] } | null>(null)
const folderLoading = ref(false)

async function startFolderAdd() {
  if (!folder.value) {
    toast.err('먼저 좌측에서 폴더를 선택해주세요.')
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
      toast.err('이 폴더에는 자료가 없습니다.')
      return
    }
    folderAdd.value = { name: folder.value.name, items: r.items }
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '폴더 자료를 불러오지 못했습니다.')
  } finally {
    folderLoading.value = false
  }
}

async function confirmFolderAdd() {
  if (!folderAdd.value) return
  try {
    const ids = folderAdd.value.items.map((r) => r.id)
    const res = await api.post<CartAddResponse>('/cart/items', {
      documentIds: ids,
    })
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
    toast.ok(`${res.added}건을 반출대기함에 담았습니다. (대기함 ${res.total}건)`)
    folderAdd.value = null
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '대기함 담기에 실패했습니다.')
  }
}

// 반출대기함 창 — 개인 관리폴더와 자료 목록을 관리한다.
const cartOpen = ref(false)


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
    toast.ok('전체 엑셀 생성을 서버에 요청했습니다. 아래 진행률에서 완료 후 다운로드할 수 있습니다.')
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '엑셀 내보내기 요청에 실패했습니다.')
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
const distDocIds = ref<number[]>([])
/** 수정용 반출만 권한을 본다 — 참조용·기타는 누구나 (기존 정책) */
const canModify = computed(() => session.can('screen.tdb_list.distribute.modify'))

function openDistribute(docIds?: number[]) {
  const ids = docIds && docIds.length ? docIds : (serverCartData.value?.items.map((r) => r.id) ?? [])
  if (!ids.length) {
    toast.err('반출할 자료가 없습니다.')
    return
  }
  distDocIds.value = ids
  // 열 때마다 처음 상태로 — 지난번에 고른 공사·업체가 남아 있으면 엉뚱한 곳으로 나간다
  dist.value = {
    vendorId: '', vendorName: '', projectId: '',
    // 수정용 권한이 없으면 참조용으로 시작한다 — 수정용은 고를 수 없게 잠근다
    purpose: canModify.value ? 'MODIFY' : 'REFERENCE',
    purposeNote: '', keepPaths: true, dateFrom: '', dateTo: '',
  }
  newProject.value = ''
  newVendor.value = ''
  distError.value = ''
  warnings.value = []
  cartOpen.value = false
  distOpen.value = true
}

function onDistributeFromCart(docIds: number[]) {
  openDistribute(docIds)
}

function onCartCountChange() {
  void qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
}
const distJobId = ref<number | null>(null)
const warnings = ref<CreateDistributionResult['duplicateWarnings']>([])

const dist = ref({
  vendorId: '' as string | number,
  vendorName: '',
  projectId: '' as string | number,
  purpose: 'MODIFY' as 'MODIFY' | 'REFERENCE' | 'ETC',
  purposeNote: '',
  keepPaths: true,
  /** 공사 등록기간 — 후보를 좁히는 검색 보조다. 서버로 보내지 않는다. */
  dateFrom: '',
  dateTo: '',
})

/**
 * 공사·업체 목록은 카탈로그에서 받는다 — 반출이력 거르개(filter-options)가 아니다.
 * 카탈로그에는 등록일이 함께 와서 아래 '공사 등록기간' 으로 후보를 좁힐 수 있고,
 * 숨긴 것은 빠져 있어 고르는 자리에 안 나온다.
 */
const { data: projectList } = useQuery({
  queryKey: qk.catalog.list('projects', false),
  queryFn: () => api.get<CatalogListResponse>('/projects'),
  staleTime: staleTime.types,
  enabled: computed(() => distOpen.value),
})
const { data: vendorList } = useQuery({
  queryKey: qk.catalog.list('vendors', false),
  queryFn: () => api.get<CatalogListResponse>('/vendors'),
  staleTime: staleTime.types,
  enabled: computed(() => distOpen.value),
})

/**
 * 공사 후보를 등록기간으로 좁힌다 — 공사가 많아지면 스크롤로 찾기 번거로우므로,
 * 대략 언제 등록했는지만 알아도 후보가 줄어든다 (기존 applyProjectDateFilter).
 */
const projectOptions = computed(() => (projectList.value?.items ?? []).filter((p) => {
  const made = p.createdAt.slice(0, 10)
  if (dist.value.dateFrom && made < dist.value.dateFrom) return false
  if (dist.value.dateTo && made > dist.value.dateTo) return false
  return true
}))

// 골라 둔 공사가 기간에 걸러지면 선택을 지운다 — 보이는 것과 실제 값이 어긋나지 않게
watch(projectOptions, (list) => {
  const cur = dist.value.projectId
  if (cur && !list.some((p) => String(p.id) === String(cur))) dist.value.projectId = ''
})

function onVendorPick(id: string) {
  dist.value.vendorId = id
  dist.value.vendorName = (vendorList.value?.items ?? []).find((v) => String(v.id) === id)?.name ?? ''
}

/**
 * 반출 목적이 '수정용' 일 때만 공사·업체를 고른다 — 참조용·기타는 대상이 불명확해도 된다.
 * 수정용은 업체가 받은 폴더 구조 그대로 돌려줘야 하므로 [폴더 경로 유지]를 켠 채 잠근다.
 */
watch(() => dist.value.purpose, (p) => {
  const isModify = p === 'MODIFY'
  if (isModify) {
    dist.value.keepPaths = true
    return
  }
  dist.value.projectId = ''
  dist.value.vendorId = ''
  dist.value.vendorName = ''
  dist.value.dateFrom = ''
  dist.value.dateTo = ''
})

const isModify = computed(() => dist.value.purpose === 'MODIFY')

/**
 * 수정용은 공사·업체가 있어야 내보낼 수 있다 (기존 화면과 같은 규칙).
 * 모자란 것을 단추에 적어 둔다 — 눌리지 않는 단추만 두면 왜 못 누르는지 알 수 없다.
 */
const distMissing = computed(() => {
  if (!isModify.value) return ''
  const miss = [
    !dist.value.projectId ? '공사' : '',
    !dist.value.vendorName ? '업체' : '',
  ].filter(Boolean)
  return miss.length ? `${miss.join('·')}를 먼저 고르세요` : ''
})
const distReady = computed(() => distMissing.value === '')

// ── 창 안에서 바로 공사·업체 추가 ──────────────────────────────────────
const newProject = ref('')
const newVendor = ref('')
const addingCatalog = ref(false)
const distError = ref('')
/** 공사·업체 관리 팝업 (이름 변경·숨김) — 화면(공사 관리·업체 관리)과 같은 부품이다 */
const catalogManage = ref<'projects' | 'vendors' | null>(null)

async function addCatalog(kind: 'projects' | 'vendors') {
  const name = (kind === 'projects' ? newProject.value : newVendor.value).trim()
  if (!name || addingCatalog.value) return
  addingCatalog.value = true
  distError.value = ''
  try {
    const made = await api.post<CatalogItem>(`/${kind}`, { name })
    await qc.invalidateQueries({ queryKey: qk.catalog.all })
    if (kind === 'projects') {
      // 방금 만든 공사가 기간에 걸려 안 보이면 곤란하니 기간을 지우고 고른다
      dist.value.dateFrom = ''
      dist.value.dateTo = ''
      dist.value.projectId = String(made.id)
      newProject.value = ''
    } else {
      dist.value.vendorId = String(made.id)
      dist.value.vendorName = made.name
      newVendor.value = ''
    }
  } catch (e) {
    distError.value = e instanceof ApiError ? e.message : `${kind === 'projects' ? '공사' : '업체'}를 추가하지 못했습니다.`
  } finally {
    addingCatalog.value = false
  }
}

async function submitDistribution() {
  distError.value = ''
  if (isModify.value && !dist.value.projectId) { distError.value = '공사를 선택해주세요.'; return }
  if (isModify.value && !dist.value.vendorName) { distError.value = '업체를 선택해주세요.'; return }
  try {
    const r = await api.post<CreateDistributionResult>('/distributions', {
      documentIds: distDocIds.value,
      vendorId: dist.value.vendorId ? Number(dist.value.vendorId) : null,
      vendorName: dist.value.vendorName,
      projectId: dist.value.projectId ? Number(dist.value.projectId) : null,
      purpose: dist.value.purpose,
      purposeNote: dist.value.purposeNote || null,
      // 수정용은 폴더 구조 그대로 돌려받아야 하므로 늘 켠 채로 보낸다
      keepPaths: isModify.value ? true : dist.value.keepPaths,
    })
    distOpen.value = false
    distJobId.value = r.jobId
    warnings.value = r.duplicateWarnings
    if (r.duplicateWarnings.length) {
      toast.warn(
        `${r.created}건을 반출했습니다. ${r.duplicateWarnings.length}건은 이미 다른 업체가 수정 중입니다.`,
        {
          sub: r.duplicateWarnings.map(
            (w) => `· ${w.drawingNo} — ${w.vendorName} 대여중 (${w.distributedAt.slice(0, 10)})`,
          ),
        },
      )
    } else {
      toast.ok(`${r.created}건을 반출했습니다. (${r.zipName})`)
    }
    try {
      await api.post('/cart/items/remove', { documentIds: distDocIds.value })
      await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
    } catch {
      // ignore
    }
    distDocIds.value = []
    void qc.invalidateQueries({ queryKey: qk.documents.all })
  } catch (e) {
    distError.value = e instanceof ApiError ? e.message : '반출하지 못했습니다.'
  }
}

/* 기존 화면(index.html)의 열 구성 그대로:
   자료명 · 분류 · 경로 · Rev · 상태 · DWG · XLSX · ETC · PDF · 최종수정.
   너비도 그때의 colgroup 값을 따른다. 사용자가 끌어서 바꾸면 그 값이 기억된다. */
const yn = (on: boolean) => (on ? 'Y' : '\u00b7')

const columns = computed<Column<DocumentListItem>[]>(() => [
  { key: 'drawingNo', label: '자료명', width: '220px', sortable: true },
  { key: 'docType', label: '분류', width: '100px', sortable: true, render: (r) => r.docType ?? '\u00b7' },
  { key: 'folderName', label: '경로', sortable: true },
  { key: 'currentRev', label: 'Rev', width: '50px', align: 'center', sortable: true,
    render: (r) => String(r.currentRev) },
  { key: 'status', label: '상태', width: '92px', align: 'center', sortable: true,
    render: (r) => (cartDocIds.value.has(r.id) ? '반출대기' : r.lentTo ? `${r.lentTo} 대여중` : STATUS_LABEL[r.status] ?? r.status) },
  { key: 'hasDwg', label: 'DWG', width: '58px', align: 'center', sortable: true, render: (r) => yn(r.hasDwg) },
  { key: 'hasXlsx', label: 'XLSX', width: '58px', align: 'center', sortable: true, render: (r) => yn(r.hasXlsx) },
  { key: 'hasEtc', label: 'ETC', width: '58px', align: 'center', sortable: true, render: (r) => yn(r.hasEtc) },
  { key: 'hasPdf', label: 'PDF', width: '58px', align: 'center', sortable: true, render: (r) => yn(r.hasPdf) },
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
          <FloatField label="검색대상">
            <select id="kind_scope" v-model="searchTarget">
              <option value="title">자료명</option>
              <option value="folder">폴더명</option>
            </select>
          </FloatField>

          <FloatField label="상태">
            <select id="status" v-model="status">
              <option value="all">전체</option>
              <option value="normal">정상</option>
              <option value="distributed">반출</option>
              <option value="in_cart">반출대기</option>
              <option value="review">검수</option>
              <option value="archived">삭제</option>
            </select>
          </FloatField>

          <FloatField label="원본/사본">
            <select id="holding" v-model="hold">
              <option value="all">전체</option>
              <option value="both">원본/사본 있음</option>
              <option value="dwg_only">원본만 있음</option>
              <option value="pdf_only">사본만 있음</option>
            </select>
          </FloatField>

          <FloatField label="수정일">
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
          </FloatField>

          <FloatField label="조회건수">
            <select id="limit" v-model="limit" title="한 번에 불러올 건수">
              <option :value="200">200건씩</option>
              <option :value="500">500건씩</option>
              <option :value="1000">1000건씩</option>
            </select>
          </FloatField>

          <label class="check-inline field-check">
            <input v-model="includeIsometric" type="checkbox" /> Isometric 보기
          </label>

          <label class="check-inline field-check" title="고른 폴더 아래 모든 하위 폴더의 자료까지 보여줍니다">
            <input v-model="recursive" type="checkbox" /> 하위폴더 전체보기
          </label>

          <FloatField class="filter-search" label="자료명 검색">
            <input
              v-model="keyword" type="text"
              @compositionstart="composing = true"
              @compositionend="composing = false; debounced = keyword"
              @keyup.enter="doSearch"
            />
          </FloatField>
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
            <span v-if="!cartView && loadingPages.size" class="muted">&nbsp;· 불러오는 중…</span>
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
              반출대기함 ({{ cartCount }})
            </button>
            <button class="cart-btn" type="button" :disabled="exportingServer" @click="startServerExport">
              엑셀 내보내기
            </button>
          </span>
        </div>

        <div class="table-box">
          <!-- 목록은 창(窓) 방식 — 보는 자리만 받는다. 반출대기함 보기는 이미 손에 있는
               목록이라 그냥 넘긴다. -->
          <DataTable
            :columns="columns" :rows="rows" selectable :selected="checked"
            :page-size="limit"
            :windowed="!cartView" :window-count="total" :row-at="rowAt"
            :loading="!cartView && isFetching"
            :total="total" :sort-key="sort" :sort-dir="dir" storage-key="tdb-list" excel-name="TDB 자료목록"
            :empty-text="cartView ? '반출대기함이 비어 있습니다.' : undefined"
            @need-range="onNeedRange"
            @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
            @row-hover="prefetch"
            @row-click="openDetail"
          >
            <!-- 상태·보유·최종수정은 기존 화면처럼 배지·기호·색으로 그린다.
                 글자값(render)은 그대로라 거르기와 엑셀은 화면과 어긋나지 않는다. -->
            <template #cell:status="{ row }">
              <span v-if="cartDocIds.has(row.id)" class="badge badge-info">반출대기</span>
              <span v-else-if="row.lentTo" class="badge badge-warning">{{ row.lentTo }} 대여중</span>
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

    <div v-if="distJobId !== null" class="card">
      <JobProgress :job-id="distJobId" />
    </div>

    <div v-if="exportJobId !== null" class="card">
      <div class="section-head">
        <span>전체 엑셀 다운로드 (서버 작업)</span>
        <span style="flex:1" />
        <button class="small" @click="exportJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="exportJobId" @done="toast.ok('전체 엑셀 생성이 완료되었습니다. 받기를 눌러 다운로드하세요.')" />
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

    <!-- 반출대기함 (개인 폴더 관리) -->
    <CartModal
      :open="cartOpen"
      @close="cartOpen = false"
      @distribute="onDistributeFromCart"
      @count-change="onCartCountChange"
    />

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
      <div class="dist-head">
        <p class="page-desc">반출 대상 {{ distDocIds.length }}건을 업체에 내보냅니다. Zip 은 뒤에서 만듭니다.</p>
        <!-- 끄면 폴더 경로 없이 자료와 엑셀 목록이 Zip 바로 밑에 평평하게 담긴다.
             수정용은 업체가 받은 폴더 구조 그대로 돌려줘야 하므로 켠 채로 잠근다. -->
        <label class="dist-keep-paths" :class="{ 'is-locked': isModify }"
               :title="isModify ? '수정용은 폴더 구조 그대로 돌려받아야 해서 끌 수 없습니다' : ''">
          <input v-model="dist.keepPaths" type="checkbox" :disabled="isModify" /> 폴더 경로 유지
        </label>
      </div>

      <div class="modal-box-label">공사</div>
      <div class="dist-daterange-row" title="공사 등록기간으로 아래 목록을 좁힙니다">
        <input v-model="dist.dateFrom" type="date" :disabled="!isModify" title="공사 등록일(시작)" />
        <span class="dist-daterange-sep">~</span>
        <input v-model="dist.dateTo" type="date" :disabled="!isModify" title="공사 등록일(종료)" />
      </div>
      <select v-model="dist.projectId" :disabled="!isModify">
        <option value="">선택</option>
        <option v-for="p in projectOptions" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
      </select>
      <div class="inline-add">
        <input v-model="newProject" type="text" placeholder="새 공사명" maxlength="200"
               :disabled="!isModify" @keydown.enter.prevent="addCatalog('projects')" />
        <button type="button" :disabled="!isModify || !newProject.trim() || addingCatalog"
                @click="addCatalog('projects')">＋추가</button>
        <button type="button" :disabled="!isModify" title="이름 변경·숨김"
                @click="catalogManage = 'projects'">관리</button>
      </div>

      <div class="modal-box-label">업체</div>
      <select :value="String(dist.vendorId)" :disabled="!isModify"
              @change="onVendorPick(($event.target as HTMLSelectElement).value)">
        <option value="">선택</option>
        <option v-for="v in vendorList?.items ?? []" :key="v.id" :value="String(v.id)">{{ v.name }}</option>
      </select>
      <div class="inline-add">
        <input v-model="newVendor" type="text" placeholder="새 업체명" maxlength="200"
               :disabled="!isModify" @keydown.enter.prevent="addCatalog('vendors')" />
        <button type="button" :disabled="!isModify || !newVendor.trim() || addingCatalog"
                @click="addCatalog('vendors')">＋추가</button>
        <button type="button" :disabled="!isModify" title="이름 변경·숨김"
                @click="catalogManage = 'vendors'">관리</button>
      </div>

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

      <p class="page-desc" style="margin-top:10px">
        수정용으로 내보낼 때 이미 다른 업체가 수정 중이면 알려 줍니다 — 막지는 않습니다.
        두 업체가 같은 자료를 고치면 분기 리비전으로 각각 보관되고, 사람이 CAD 로 통합해야 합니다.
      </p>

      <div v-if="distMissing" class="warning-box">{{ distMissing }}.</div>
      <div v-if="distError" class="warning-box dist-error">{{ distError }}</div>
      <div v-if="warnings.length" class="warning-box">
        이미 반출 중(미반입)인 자료가 있습니다:
        {{ warnings.map((w) => w.drawingNo).join(', ') }}
      </div>

      <template #footer>
        <button @click="distOpen = false">취소</button>
        <button class="primary" :disabled="!distReady" :title="distMissing"
                @click="submitDistribution">반출 실행</button>
      </template>
    </Modal>

    <!-- 공사·업체 관리 (반출하기 창 안에서 바로) — 화면과 같은 부품을 쓴다 -->
    <Modal
      v-if="catalogManage" wide
      :title="catalogManage === 'projects' ? '공사 관리' : '업체 관리'"
      @close="catalogManage = null"
    >
      <ProjectManager :kind="catalogManage" />
    </Modal>
  </main>
</template>

<style scoped>
/* 반출하기 창 — 제목줄 오른쪽에 [폴더 경로 유지] (기존 distribute.css) */
.dist-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dist-head .page-desc { margin: 0; }
.dist-keep-paths {
  display: inline-flex; align-items: center; gap: 5px; margin: 0;
  font-size: 12px; color: var(--text-muted); white-space: nowrap; cursor: pointer;
}
.dist-keep-paths.is-locked { color: var(--text-faint); cursor: default; }

.dist-daterange-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.dist-daterange-row input[type="date"] { flex: 1; min-width: 0; margin-top: 0; }
.dist-daterange-sep { color: var(--text-faint); font-size: 12.5px; }

.inline-add button { margin-top: 4px; flex: 0 0 auto; }
.dist-error { background: var(--danger-soft); border-color: var(--danger-line); color: var(--danger); }

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

/* 창 안의 그리드 — 스크롤은 DataTable 이 맡으므로 높이만 내준다 */
.cart-grid {
  height: 60vh;
  min-height: 280px;
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.cart-grid > * { flex: 1; min-width: 0; }

.purpose-row { display: flex; gap: 40px; }
.msg .sub { font-size: 11.5px; margin-top: 3px; }
.tree-count { color: var(--text-faint); font-size: 11px; font-weight: 400; }
</style>
