<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type {
  ArchiveListResponse, FolderNode, JobCreated, MdbCartItem, MdbIdsByFolderResponse,
  MdbListItem, MdbListResponse, MdbMeta, TagSuggestResponse,
} from '@tdms/contracts'
import FolderTreePanel from '@/ui/FolderTreePanel.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import JobProgress from '@/ui/JobProgress.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { downloadXlsx } from '@/lib/xlsx'
import {
  defaultSearch, loadCart, loadSearch, saveCart, saveSearch, toServerFilters, type MdbSearchState,
} from '@/lib/mdbSearch'

/**
 * MDB 조회 — 기존 mdb.html 구성을 재현한다. 리비전·반출이 없는 고정 기록이다.
 *
 * 검색 조건·폴더·정렬과 다운대기함은 탭 안에서 기억한다(sessionStorage) —
 * 상세 화면에 갔다가 돌아와도 그대로이고, 상세의 [이전·다음]도 같은 조건 안에서 움직인다.
 */

const router = useRouter()
const session = useSession()

// ── 검색 조건 ──────────────────────────────────────────────────────────
const s = ref<MdbSearchState>(loadSearch())
watch(s, (v) => saveSearch(v), { deep: true })

// 입력 중에는 요청하지 않는다. IME 조합 중에도 억제한다.
const keyword = ref(s.value.keyword)
const composing = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  if (composing.value) return
  timer = setTimeout(() => (s.value.keyword = v), 250)
})

/** [검색] — 입력 중 기다리지 않고 바로 조회한다 (기존 화면의 검색 버튼) */
function doSearch() {
  clearTimeout(timer)
  s.value.keyword = keyword.value
}

function onFolder(f: FolderNode | null) {
  s.value.folder = f ? { id: f.id, name: f.name } : null
}

const { data: meta } = useQuery({
  queryKey: ['mdb-meta'],
  queryFn: () => api.get<MdbMeta>('/mdb/meta'),
  staleTime: staleTime.types,
})

function onSort(key: string, d: SortDir) {
  s.value.sort = key as MdbSearchState['sort']
  s.value.dir = d
}

const filters = computed(() => toServerFilters(s.value))

const {
  data, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage,
} = useInfiniteQuery({
  queryKey: computed(() => ['mdb', 'list', filters.value, s.value.limit]),
  queryFn: ({ pageParam }) =>
    api.get<MdbListResponse>(`/mdb${qs({ ...filters.value, limit: s.value.limit, cursor: pageParam ?? undefined })}`),
  initialPageParam: null as string | null,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  staleTime: staleTime.list,
})

const rows = computed(() => data.value?.pages.flatMap((p) => p.items) ?? [])
const total = computed(() => data.value?.pages[0]?.total ?? null)

// Tag No 자동완성
const tagHints = ref<string[]>([])
watch(() => [s.value.keyword, s.value.searchTarget] as const, async ([q, t]) => {
  if (t !== 'tag' || q.length < 2) { tagHints.value = []; return }
  tagHints.value = (await api.get<TagSuggestResponse>(`/mdb/tags/suggest${qs({ q })}`)).items.slice(0, 8)
})
function pickHint(t: string) {
  keyword.value = t
  s.value.keyword = t
  tagHints.value = []
}

function reset() {
  const d = defaultSearch()
  // 폴더·정렬·건수는 그대로 둔다 — 조건 초기화는 거르개만 지운다(기존 동작)
  s.value = { ...d, folder: s.value.folder, sort: s.value.sort, dir: s.value.dir, limit: s.value.limit }
  keyword.value = ''
}

// ── 표에서 고른 줄 ───────────────────────────────────────────────────────
const selected = ref(new Set<number>())
function toggle(id: number) {
  const n = new Set(selected.value)
  n.has(id) ? n.delete(id) : n.add(id)
  selected.value = n
}
function toggleAll(on: boolean) {
  const n = new Set(selected.value)
  for (const r of rows.value) on ? n.add(r.id) : n.delete(r.id)
  selected.value = n
}

// ── 다운대기함 — 탭 안에서 기억한다 ─────────────────────────────────────
const CART_MAX = 5000
const cart = ref<MdbCartItem[]>(loadCart())
watch(cart, (v) => saveCart(v), { deep: true })
const cartIds = computed(() => new Set(cart.value.map((c) => c.id)))
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

function addToCart(items: MdbCartItem[]): number {
  const have = new Set(cartIds.value)
  const add = items.filter((i) => !have.has(i.id))
  const room = CART_MAX - cart.value.length
  const taking = add.slice(0, Math.max(0, room))
  cart.value = [...cart.value, ...taking]
  if (taking.length < add.length) {
    message.value = { kind: 'err', text: `다운대기함은 ${CART_MAX.toLocaleString()}건까지 담을 수 있습니다. ${add.length - taking.length}건은 담지 못했습니다.` }
  }
  return taking.length
}

/**
 * 목록 한 줄은 **자료 한 건**이고 다운대기함은 **파일 단위**다 —
 * 한 줄을 담으면 그 자료의 원본·사본이 각각 담긴다.
 */
const toCartItems = (r: MdbListItem): MdbCartItem[] =>
  r.files.map((f) => ({ id: f.id, title: r.title, folderName: r.folderName, fileExt: f.fileExt }))

function addSelected() {
  const picked = rows.value.filter((r) => selected.value.has(r.id)).flatMap(toCartItems)
  if (!picked.length) { message.value = { kind: 'err', text: '담을 자료를 표에서 체크하세요.' }; return }
  const n = addToCart(picked)
  selected.value = new Set()
  if (!message.value || message.value.kind === 'ok') {
    message.value = { kind: 'ok', text: `${n}건을 다운대기함에 담았습니다.${picked.length > n ? ` (${picked.length - n}건은 이미 담겨 있습니다)` : ''}` }
  }
}

/** 폴더 다운 — 고른 폴더(하위폴더 전체보기를 따른다) 안 자료를 전부 담는다 */
const folderLoading = ref(false)
async function addFolder() {
  const f = s.value.folder
  if (!f) { message.value = { kind: 'err', text: '왼쪽 트리에서 폴더를 먼저 고르세요.' }; return }
  folderLoading.value = true
  try {
    const r = await api.get<MdbIdsByFolderResponse>(
      `/mdb/ids-by-folder${qs({ folderId: f.id, recursive: s.value.recursive })}`,
    )
    if (!r.items.length) { message.value = { kind: 'err', text: `"${f.name}" 폴더에 자료가 없습니다.` }; return }
    const n = addToCart(r.items)
    message.value = {
      kind: r.truncated ? 'err' : 'ok',
      text: `"${f.name}" 폴더의 ${n}건을 다운대기함에 담았습니다.` +
        (r.truncated ? ` 폴더 자료가 ${CART_MAX.toLocaleString()}건을 넘어 앞의 ${CART_MAX.toLocaleString()}건만 담았습니다.` : ''),
    }
  } catch (e) {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '폴더 자료를 불러오지 못했습니다.' }
  } finally {
    folderLoading.value = false
  }
}

const cartOpen = ref(false)
const cartChecked = ref(new Set<number>())
const cartAllChecked = computed(() => cart.value.length > 0 && cart.value.every((c) => cartChecked.value.has(c.id)))
function cartToggle(id: number) {
  const n = new Set(cartChecked.value)
  n.has(id) ? n.delete(id) : n.add(id)
  cartChecked.value = n
}
function cartToggleAll(on: boolean) { cartChecked.value = new Set(on ? cart.value.map((c) => c.id) : []) }
function cartRemoveChecked() {
  cart.value = cart.value.filter((c) => !cartChecked.value.has(c.id))
  cartChecked.value = new Set()
}
function cartClear() { cart.value = []; cartChecked.value = new Set() }
function cartExport() {
  void downloadXlsx('MDB 다운대기함', {
    sheetName: '다운대기함',
    headers: ['No', '자료명', '경로', '형식'],
    rows: cart.value.map((c, i) => [String(i + 1), c.title, c.folderName, c.fileExt.toUpperCase()]),
  })
}

/** 다운대기함을 Zip 으로 받는다. 묶는 일은 워커가 하고 진행률은 SSE 로 본다. Zip 안은 언제나 폴더 경로를 유지한다. */
const zipJobId = ref<number | null>(null)
async function downloadCart() {
  if (!cart.value.length) return
  try {
    const r = await api.post<{ jobId: number }>('/mdb/download-zip', { fileIds: cart.value.map((c) => c.id) })
    zipJobId.value = r.jobId
    cartOpen.value = false
    cartClear()
  } catch (e) {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : 'Zip 을 요청하지 못했습니다.' }
  }
}

// ── 전체 엑셀 (서버 작업) — 지금 조건의 전량을 워커가 만든다 ──────────────
const exportJobId = ref<number | null>(null)
const exporting = ref(false)
async function startServerExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const r = await api.post<JobCreated>('/jobs/excel-export', {
      target: 'mdb_files',
      filters: filters.value,
      filename: `MDB_자료목록_${new Date().toISOString().slice(0, 10)}.xlsx`,
    })
    exportJobId.value = r.jobId
  } catch (e) {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '엑셀 내보내기 요청에 실패했습니다.' }
  } finally {
    exporting.value = false
  }
}

// ── 폐기 보관함 (읽기 전용) — 관리 화면 권한이 있을 때만 ────────────────
const canSeeRetired = computed(() => session.can('screen.mdb_editor.access'))
const retiredOpen = ref(false)
const { data: retired, isFetching: retiredLoading } = useQuery({
  queryKey: ['mdb-editor', 'retired', 'readonly'],
  queryFn: () => api.get<ArchiveListResponse>('/mdb-editor/retired'),
  enabled: computed(() => canSeeRetired.value),
  staleTime: staleTime.list,
})

/* 'Mechanical Data Book'(자료유형)·'Heat Exchanger'(설비유형)가 들어가는 너비로 잡았다 */
const yn = (on: boolean) => (on ? 'Y' : '\u00b7')

const columns = computed<Column<MdbListItem>[]>(() => [
  { key: 'title', label: '자료명', width: '220px', sortable: true },
  { key: 'year', label: '연도', width: '60px', align: 'center', sortable: true,
    render: (r) => String(r.year ?? '\u00b7') },
  { key: 'projectName', label: '공사', width: '150px', sortable: true,
    render: (r) => r.projectName ?? '\u00b7' },
  { key: 'folderName', label: '경로', sortable: false },   // 남는 자리를 받는 칸
  { key: 'equipmentType', label: '설비유형', width: '110px', sortable: true,
    render: (r) => r.equipmentType ?? '\u00b7' },
  { key: 'docType', label: '자료유형', width: '110px', sortable: true,
    render: (r) => r.docType ?? '\u00b7' },
  { key: 'isShared', label: '분류', width: '84px', align: 'center', sortable: false,
    render: (r) => (r.needsCheck ? '확인필요' : r.isShared ? '공용' : '전용') },
  { key: 'hasDwg', label: 'DWG', width: '58px', align: 'center', sortable: false, filterable: false,
    render: (r) => yn(r.hasDwg) },
  { key: 'hasXlsx', label: 'XLSX', width: '58px', align: 'center', sortable: false, filterable: false,
    render: (r) => yn(r.hasXlsx) },
  { key: 'hasEtc', label: 'ETC', width: '58px', align: 'center', sortable: false, filterable: false,
    render: (r) => yn(r.hasEtc) },
  { key: 'hasPdf', label: 'PDF', width: '58px', align: 'center', sortable: false, filterable: false,
    render: (r) => yn(r.hasPdf) },
  { key: 'tagCount', label: 'Tag', width: '56px', align: 'center', sortable: false, filterable: false,
    render: (r) => String(r.tagCount) },
  { key: 'updatedAt', label: '최종수정', width: '134px', align: 'center', sortable: true,
    render: (r) => r.updatedAt.slice(0, 10) },
])
</script>

<template>
  <main class="app-main">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          MDB 조회<span class="page-title-sub">Mechanical Data Book(설비자료) 문서 조회 및 열람</span>
        </h1>
      </div>
      <div class="page-actions">
        <button v-if="canSeeRetired" type="button" title="폐기 보관함 (읽기 전용)" @click="retiredOpen = true">
          폐기 보관함 <span class="tree-count">({{ retired?.count ?? 0 }})</span>
        </button>
      </div>
    </div>

    <!-- 검색·필터 — 분류·설비유형·자료유형·공사·연도·하위폴더전체보기.
         검색칸 좌측에 검색대상(전체/자료명/Tag No) 드롭박스를 둔다. -->
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div class="field">
            <label for="category">분류</label>
            <select id="category" v-model="s.category">
              <option value="">전체</option>
              <option value="전용">전용</option>
              <option value="공용">공용</option>
              <option value="확인필요">확인필요</option>
            </select>
          </div>

          <div class="field">
            <label for="equipment_type">설비유형</label>
            <select id="equipment_type" v-model="s.equipmentType">
              <option value="">전체</option>
              <option v-for="e in meta?.equipmentTypes ?? []" :key="e" :value="e">{{ e }}</option>
            </select>
          </div>

          <div class="field">
            <label for="doc_type">자료유형</label>
            <select id="doc_type" v-model="s.docType">
              <option value="">전체</option>
              <option v-for="d in meta?.docTypes ?? []" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>

          <div class="field">
            <label for="project_id">공사</label>
            <select id="project_id" v-model="s.projectId">
              <option value="">전체</option>
              <option v-for="p in meta?.projects ?? []" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
            </select>
          </div>

          <div class="field">
            <label for="mdb-year">연도</label>
            <select id="mdb-year" v-model="s.year">
              <option value="">전체</option>
              <option v-for="y in meta?.years ?? []" :key="y" :value="String(y)">{{ y }}</option>
            </select>
          </div>

          <div class="field">
            <label for="holding">원본/사본</label>
            <select id="holding" v-model="s.hold">
              <option value="all">전체</option>
              <option value="both">원본/사본 있음</option>
              <option value="dwg_only">원본만 있음</option>
              <option value="pdf_only">사본만 있음</option>
            </select>
          </div>

          <div class="field">
            <label for="mdb-limit">조회건수</label>
            <select id="mdb-limit" v-model.number="s.limit" title="한 번에 불러올 건수">
              <option :value="200">200건씩</option>
              <option :value="500">500건씩</option>
              <option :value="1000">1000건씩</option>
            </select>
          </div>

          <label class="check-inline field-check">
            <input v-model="s.recursive" type="checkbox" /> 하위폴더 전체보기
          </label>

          <div class="field search-lead">
            <label for="search-target">검색대상</label>
            <select id="search-target" v-model="s.searchTarget">
              <option value="title">자료명</option>
              <option value="folder">폴더명</option>
              <option value="tag">Tag No</option>
            </select>
          </div>

          <span class="tagwrap">
            <input
              v-model="keyword" type="text" class="filter-search" placeholder="자료명 검색"
              @compositionstart="composing = true"
              @compositionend="composing = false; s.keyword = keyword"
              @keyup.enter="doSearch"
            />
            <ul v-if="tagHints.length" class="hints">
              <li v-for="t in tagHints" :key="t" @click="pickHint(t)">{{ t }}</li>
            </ul>
          </span>
          <button id="search-btn" class="primary" type="button" @click="doSearch">검색</button>
        </div>

        <div class="filter-actions">
          <button type="button" @click="reset">조건 초기화</button>
        </div>
      </div>
    </div>

    <div class="main-layout">
      <FolderTreePanel
        doc-class="MDB" :selected-id="s.folder?.id ?? null"
        storage-key="mdb-list" @select="onFolder"
      />

      <div class="main-content">
        <div class="status-bar">
          <span class="status-bar-left">
            <span class="selected-folder-name">
              <template v-if="s.folder">{{ s.folder.name }}</template>
              <template v-else>전체 폴더</template>
            </span>
            <span class="total-count">전체 {{ (total ?? 0).toLocaleString() }}건</span>
            <button
              v-if="selected.size" class="clear-selection-btn" type="button"
              title="체크해둔 자료를 모두 해제합니다" @click="selected = new Set()"
            >선택 초기화 ({{ selected.size }})</button>
            <span v-if="isFetching && !isFetchingNextPage" class="muted">&nbsp;· 조회 중…</span>
          </span>
          <span class="cart-status">
            <button
              class="cart-btn" type="button" :disabled="!s.folder || folderLoading"
              :title="s.folder ? `${s.folder.name} 폴더 자료를 전부 담습니다` : '폴더를 먼저 고르세요'"
              @click="addFolder"
            >{{ folderLoading ? '담는 중…' : '폴더 다운' }}</button>
            <button class="cart-btn" type="button" @click="addSelected">선택 다운</button>
            <button class="cart-btn" type="button" @click="cartOpen = true">다운대기함 ({{ cart.length }})</button>
            <button class="cart-btn" type="button" :disabled="exporting" @click="startServerExport">
              엑셀 내보내기
            </button>
          </span>
        </div>

        <div class="table-box">
          <DataTable
            :columns="columns" :rows="rows" selectable :selected="selected"
            :loading="isFetching && !isFetchingNextPage && !rows.length"
            :total="total" :sort-key="s.sort" :sort-dir="s.dir" storage-key="mdb-list" excel-name="MDB 자료목록"
            :has-more="hasNextPage" :loading-more="isFetchingNextPage"
            :row-class="(r) => (r.files.some((x) => cartIds.has(x.id)) ? 'cur' : '')"
            @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
            @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
            @row-click="(r) => router.push(`/mdb/${r.id}`)"
          >
            <template #cell:hasDwg="{ row }"><span :class="row.hasDwg ? 'yn-y' : 'yn-n'">{{ yn(row.hasDwg) }}</span></template>
            <template #cell:hasXlsx="{ row }"><span :class="row.hasXlsx ? 'yn-y' : 'yn-n'">{{ yn(row.hasXlsx) }}</span></template>
            <template #cell:hasEtc="{ row }"><span :class="row.hasEtc ? 'yn-y' : 'yn-n'">{{ yn(row.hasEtc) }}</span></template>
            <template #cell:hasPdf="{ row }"><span :class="row.hasPdf ? 'yn-y' : 'yn-n'">{{ yn(row.hasPdf) }}</span></template>
          </DataTable>
        </div>
      </div>
    </div>

    <div v-if="message" class="msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="small" @click="message = null">닫기</button>
    </div>

    <div v-if="exportJobId !== null" class="card">
      <div class="section-head">
        <span>전체 엑셀 다운로드 (서버 작업)</span><span style="flex:1" />
        <button class="small" @click="exportJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="exportJobId" />
    </div>

    <div v-if="zipJobId !== null" class="card">
      <div class="section-head">
        <span>다운대기함 Zip</span><span style="flex:1" />
        <button class="small" @click="zipJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="zipJobId" />
    </div>

    <!-- 다운대기함 -->
    <Modal v-if="cartOpen" title="다운대기함" wide @close="cartOpen = false">
      <div class="status-bar" style="margin-bottom:8px">
        <span><b>{{ cart.length }}건</b></span>
        <span class="cart-status" style="margin-right:0">
          <label class="check-inline" title="Zip 안에 원래 폴더 경로대로 담습니다 (항상 유지)">
            <input type="checkbox" checked disabled /> 폴더 경로 유지
          </label>
          <button class="small" :disabled="!cartChecked.size" @click="cartRemoveChecked">선택 제거</button>
          <button class="small" :disabled="!cart.length" @click="cartClear">전체 비우기</button>
          <button class="small" :disabled="!cart.length" @click="cartExport">엑셀 내보내기</button>
        </span>
      </div>
      <div class="table-scroll cart-scroll">
        <table>
          <colgroup>
            <col style="width:54px" /><col style="width:34px" /><col />
            <col style="width:260px" /><col style="width:60px" />
          </colgroup>
          <thead>
            <tr>
              <th>No</th>
              <th class="col-check">
                <input type="checkbox" :checked="cartAllChecked" @change="cartToggleAll(($event.target as HTMLInputElement).checked)" />
              </th>
              <th>자료명</th><th>경로</th><th>형식</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in cart" :key="c.id">
              <td class="col-no">{{ i + 1 }}</td>
              <td class="tc"><input type="checkbox" :checked="cartChecked.has(c.id)" @change="cartToggle(c.id)" /></td>
              <td>{{ c.title }}</td>
              <td class="muted">{{ c.folderName }}</td>
              <td class="tc">{{ c.fileExt.toUpperCase() }}</td>
            </tr>
            <tr v-if="!cart.length">
              <td colspan="5" class="empty">다운대기함이 비어 있습니다. 표에서 체크한 뒤 [선택 다운]이나 [폴더 다운]으로 담으세요.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button @click="cartOpen = false">닫기</button>
        <button class="primary" :disabled="!cart.length" @click="downloadCart">이 목록으로 다운하기</button>
      </template>
    </Modal>

    <!-- 폐기 보관함 (읽기 전용) -->
    <Modal v-if="retiredOpen" title="폐기 보관함 (읽기 전용)" wide @close="retiredOpen = false">
      <p class="page-desc" style="margin-bottom:10px">복구·비고 작성은 MDB 관리 화면에서 합니다.</p>
      <div class="table-scroll cart-scroll">
        <table>
          <colgroup>
            <col style="width:54px" /><col /><col /><col style="width:70px" />
            <col /><col /><col style="width:130px" /><col style="width:90px" />
          </colgroup>
          <thead>
            <tr><th>No</th><th>묶음</th><th>원래 자리</th><th>건수</th>
                <th>사유</th><th>비고</th><th>폐기 일시</th><th>처리자</th></tr>
          </thead>
          <tbody>
            <tr v-for="(b, i) in retired?.items ?? []" :key="b.id">
              <td class="col-no">{{ i + 1 }}</td>
              <td>{{ b.label }}</td>
              <td class="muted">{{ b.originalPath ?? '·' }}</td>
              <td class="tc">{{ b.itemCount }}</td>
              <td>{{ b.reason ?? '' }}</td>
              <td>{{ b.note ?? '' }}</td>
              <td class="tc">{{ b.archivedAt.slice(0, 16).replace('T', ' ') }}</td>
              <td class="tc">{{ b.archivedBy ?? '·' }}</td>
            </tr>
            <tr v-if="!retired?.items.length">
              <td colspan="8" class="empty">{{ retiredLoading ? '불러오는 중…' : '폐기 보관함이 비어 있습니다.' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  </main>
</template>

<style scoped>
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

@media (max-width: 900px) {
  .main-layout { flex-direction: column; }
  .main-layout :deep(.tree-panel) { flex: 0 0 auto !important; max-height: 240px; }
  .main-layout :deep(.tree-resize-handle) { display: none; }
}

/* 검색대상 드롭박스와 검색칸이 한 묶음으로 오른쪽 끝에 붙게 한다 (기존 style.css 규칙) */
.search-lead { margin-left: auto; }
.filter-search { margin-left: 0; }

.cart-scroll { max-height: 60vh; }
.tree-count { color: var(--text-faint); font-size: 11px; font-weight: 400; }

.tagwrap { position: relative; }
.hints {
  position: absolute; top: 100%; left: 0; z-index: 10; margin: 2px 0 0; padding: 0;
  list-style: none; background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius); min-width: 180px; max-height: 220px; overflow: auto;
  box-shadow: var(--shadow-sm);
}
.hints li { padding: 6px 10px; cursor: pointer; font-size: 12.5px; }
.hints li:hover { background: var(--surface-alt); }
</style>
