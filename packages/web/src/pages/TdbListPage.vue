<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type {
  CreateDistributionResult, DocumentListItem, DocumentListResponse,
  FilterOptions, FolderNode, JobCreated,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { DOC_STATUS_LABEL as STATUS_LABEL } from '@/lib/labels'

/** TDB 조회 — 기존 index.html 의 구성을 재현한다. */

const session = useSession()
const router = useRouter()
const qc = useQueryClient()

// ── 검색 조건 (기존 화면과 같은 항목) ──────────────────────────────────
const folder = ref<FolderNode | null>(null)
const keyword = ref('')
const searchTarget = ref<'title' | 'folder'>('title')
const includeIsometric = ref(false)
const status = ref<'all' | 'normal' | 'review' | 'distributed' | 'archived'>('all')
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

const params = computed(() => ({
  folderId: folder.value?.id,
  q: debounced.value || undefined,
  searchTarget: searchTarget.value,
  includeIsometric: includeIsometric.value,
  status: status.value,
  hold: hold.value,
  sort: sort.value,
  dir: dir.value,
  limit: limit.value,
}))

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
})

const rows = computed(() => data.value?.pages.flatMap((p) => p.items) ?? [])
const total = computed(() => data.value?.pages[0]?.total ?? 0)

// ── 반출대기함 (장바구니) — 서버 왕복 없이 로컬 상태로 ──────────────────
const cart = ref(new Set<number>())
const cartRows = ref(new Map<number, DocumentListItem>())

function toggle(id: number) {
  if (cart.value.has(id)) {
    cart.value.delete(id)
    cartRows.value.delete(id)
  } else {
    cart.value.add(id)
    const row = rows.value.find((r: DocumentListItem) => r.id === id)
    if (row) cartRows.value.set(id, row)
  }
  cart.value = new Set(cart.value)
}

function toggleAll(checked: boolean) {
  for (const r of rows.value) {
    if (checked) {
      cart.value.add(r.id)
      cartRows.value.set(r.id, r)
    } else {
      cart.value.delete(r.id)
      cartRows.value.delete(r.id)
    }
  }
  cart.value = new Set(cart.value)
}

function clearCart() {
  cart.value = new Set()
  cartRows.value = new Map()
}

function reset() {
  keyword.value = ''
  debounced.value = ''
  searchTarget.value = 'title'
  includeIsometric.value = false
  status.value = 'all'
  hold.value = 'all'
  limit.value = 200
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
        includeIsometric: includeIsometric.value,
        status: status.value,
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
      documentIds: [...cart.value],
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
  { key: 'folderName', label: '폴더', width: '160px' },
  { key: 'currentRev', label: 'Rev', width: '62px', align: 'center', sortable: true,
    render: (r) => `Rev${r.currentRev}` },
  {
    key: 'hold', label: '원본/사본', width: '96px', align: 'center',
    render: (r) => [r.hasDwg ? 'DWG' : '', r.hasPdf ? 'PDF' : ''].filter(Boolean).join('/') || '-',
  },
  {
    key: 'status', label: '상태', width: '158px',
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
          <option value="review">검수</option><option value="distributed">반출</option>
          <option value="archived">삭제</option>
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
      <div class="search-meta muted">
        <span v-if="folder">{{ folder.name }}</span>
        <span v-else>전체 폴더</span>
        <span v-if="isFetching && !isFetchingNextPage"> · 조회 중…</span>
        <span v-else-if="isFetchingNextPage"> · 다음 페이지 불러오는 중…</span>
      </div>
    </div>

    <div class="split">
      <aside class="panel tree-panel">
        <LazyTree doc-class="TDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
      </aside>

      <div class="panel table-panel">
        <DataTable
          :columns="columns" :rows="rows" selectable :selected="cart" :loading="isFetching && !isFetchingNextPage && !rows.length"
          :total="total" :sort-key="sort" :sort-dir="dir" storage-key="tdb-list" excel-name="TDB 자료목록"
          :has-more="hasNextPage" :loading-more="isFetchingNextPage"
          server-excel :server-exporting="exportingServer"
          @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
          @export-server="startServerExport"
          @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
          @row-hover="prefetch"
          @row-click="(r) => router.push(`/documents/${r.id}`)"
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

    <div v-if="cart.size" class="panel cart">
      <div class="panel-head">
        반출대기함 ({{ cart.size }})
        <span style="flex:1" />
        <button class="btn btn-sm" @click="clearCart">선택 초기화</button>
        <button class="btn btn-sm btn-primary"
                :disabled="!session.can('screen.tdb_list.distribute.modify')"
                @click="distOpen = true">
          이 목록으로 반출하기
        </button>
      </div>
    </div>

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
              <label class="r"><input v-model="dist.purpose" type="radio" value="MODIFY" /> 수정용</label>
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
.search-meta { margin-top: 8px; font-size: var(--fs-sm); }
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }

/* 조회부는 맨 위에 가로로 펴 두고, 그 아래를 트리·그리드 두 칸으로 가른다.
   트리를 셸의 app-side(내비 옆 기둥)에 두면 조회부까지 옆으로 밀려 검색 줄이
   좁아진다 — 거르개가 7개라 그 줄이 제일 먼저 접힌다.
   다른 화면(MDB 조회·TDB/MDB 관리)은 app-side 를 그대로 쓰므로 공통 CSS 는 건드리지 않았다. */
.split { flex: 1; display: flex; gap: var(--gap); min-height: 0; }
.tree-panel {
  width: 268px; min-width: 268px;
  overflow: auto;
}
.table-panel { flex: 1; display: flex; min-height: 0; overflow: hidden; }

/* 좁은 화면에서는 세로로 쌓는다 — 268px 를 빼면 그리드가 읽히지 않는다 */
@media (max-width: 900px) {
  .split { flex-direction: column; }
  .tree-panel { width: auto; min-width: 0; max-height: 240px; flex: 0 0 auto; }
  .table-panel { min-height: 320px; }
}
.cart { flex: 0 0 auto; }
.msg { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; flex: 0 0 auto; }
.sub { font-size: var(--fs-sm); margin-top: 3px; }
.form th, .form td { padding: 5px 8px; text-align: left; }
.form th { width: 80px; font-weight: 600; white-space: nowrap; }
.r { margin-right: 12px; }
.small { font-size: var(--fs-sm); margin-top: 10px; }
</style>
