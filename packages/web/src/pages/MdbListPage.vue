<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type {
  ArchiveListResponse, FolderNode, JobCreated, MdbCartItem, MdbIdsByFolderResponse,
  MdbListItem, MdbListResponse, MdbMeta, TagSuggestResponse,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
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

const toCartItem = (r: MdbListItem): MdbCartItem =>
  ({ id: r.id, title: r.title, folderName: r.folderName, fileExt: r.fileExt })

function addSelected() {
  const picked = rows.value.filter((r) => selected.value.has(r.id)).map(toCartItem)
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

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`
}

/* 'Mechanical Data Book'(자료유형)·'Heat Exchanger'(설비유형)가 들어가는 너비로 잡았다 */
const columns = computed<Column<MdbListItem>[]>(() => [
  { key: 'title', label: '자료명', width: '288px', sortable: true },
  { key: 'folderName', label: '폴더', sortable: false },   // 남는 자리를 받는 칸
  { key: 'equipmentType', label: '설비유형', width: '124px', sortable: true,
    render: (r) => r.equipmentType ?? '-' },
  { key: 'docType', label: '자료유형', width: '176px', sortable: true,
    render: (r) => r.docType ?? '-' },
  { key: 'year', label: '연도', width: '64px', align: 'center', sortable: true,
    render: (r) => String(r.year ?? '-') },
  { key: 'isShared', label: '분류', width: '84px', align: 'center', sortable: false,
    render: (r) => (r.needsCheck ? '확인필요' : r.isShared ? '공용' : '전용') },
  { key: 'fileExt', label: '형식', width: '56px', align: 'center', sortable: false,
    render: (r) => r.fileExt.toUpperCase() },
  { key: 'tagCount', label: 'Tag', width: '56px', align: 'center', sortable: false, filterable: false,
    render: (r) => String(r.tagCount) },
  { key: 'byteSize', label: '크기', width: '84px', align: 'right', sortable: false, filterable: false,
    render: (r) => size(r.byteSize) },
  { key: 'updatedAt', label: '최종수정', width: '104px', align: 'center', sortable: true,
    render: (r) => r.updatedAt.slice(0, 10) },
])
</script>

<template>
  <aside class="app-side">
    <LazyTree doc-class="MDB" :selected-id="s.folder?.id ?? null" @select="onFolder" />
  </aside>

  <main class="app-main mdb">
    <div class="panel search">
      <div class="bar">
        <select v-model="s.category" title="분류">
          <option value="">분류 전체</option>
          <option value="전용">전용</option>
          <option value="공용">공용</option>
          <option value="확인필요">확인필요</option>
        </select>
        <select v-model="s.equipmentType">
          <option value="">설비유형 전체</option>
          <option v-for="e in meta?.equipmentTypes ?? []" :key="e" :value="e">{{ e }}</option>
        </select>
        <select v-model="s.docType">
          <option value="">자료유형 전체</option>
          <option v-for="d in meta?.docTypes ?? []" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model="s.projectId">
          <option value="">공사 전체</option>
          <option v-for="p in meta?.projects ?? []" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
        </select>
        <select v-model="s.year">
          <option value="">연도 전체</option>
          <option v-for="y in meta?.years ?? []" :key="y" :value="String(y)">{{ y }}</option>
        </select>
        <label class="chk"><input v-model="s.recursive" type="checkbox" /> 하위폴더 전체보기</label>
        <select v-model="s.searchTarget">
          <option value="title">자료명 검색</option>
          <option value="folder">폴더명 검색</option>
          <option value="tag">Tag No 검색</option>
        </select>
        <span class="tagwrap">
          <input
            v-model="keyword" type="text" placeholder="검색어" style="width:180px"
            @compositionstart="composing = true"
            @compositionend="composing = false; s.keyword = keyword"
          />
          <ul v-if="tagHints.length" class="hints">
            <li v-for="t in tagHints" :key="t" @click="pickHint(t)">{{ t }}</li>
          </ul>
        </span>
        <select v-model.number="s.limit" title="한 번에 불러올 건수">
          <option :value="200">200건씩</option>
          <option :value="500">500건씩</option>
          <option :value="1000">1000건씩</option>
        </select>
        <button class="btn btn-sm" @click="reset">조건 초기화</button>
        <span style="flex:1" />
        <button v-if="canSeeRetired" class="btn btn-sm" title="폐기 보관함 (읽기 전용)" @click="retiredOpen = true">
          폐기 보관함 <span class="cnt">{{ retired?.count ?? 0 }}</span>
        </button>
      </div>
      <div class="muted meta">
        <span v-if="s.folder">{{ s.folder.name }}</span>
        <span v-else>전체 폴더</span>
        <span v-if="isFetching && !isFetchingNextPage"> · 조회 중…</span>
        <span v-else-if="isFetchingNextPage"> · 다음 페이지 불러오는 중…</span>
      </div>
    </div>

    <div class="panel actions">
      <span class="muted small">체크 {{ selected.size }}건</span>
      <button v-if="selected.size" class="btn btn-sm btn-ghost" @click="selected = new Set()">선택 초기화</button>
      <span style="flex:1" />
      <button class="btn btn-sm" :disabled="!s.folder || folderLoading"
              :title="s.folder ? `${s.folder.name} 폴더 자료를 전부 담습니다` : '폴더를 먼저 고르세요'"
              @click="addFolder">{{ folderLoading ? '담는 중…' : '폴더 다운' }}</button>
      <button class="btn btn-sm" @click="addSelected">선택 다운</button>
      <button class="btn btn-sm btn-primary" @click="cartOpen = true">다운대기함 ({{ cart.length }})</button>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="columns" :rows="rows" selectable :selected="selected"
        :loading="isFetching && !isFetchingNextPage && !rows.length"
        :total="total" :sort-key="s.sort" :sort-dir="s.dir" storage-key="mdb-list" excel-name="MDB 자료목록"
        :has-more="hasNextPage" :loading-more="isFetchingNextPage"
        server-excel :server-exporting="exporting"
        :row-class="(r) => (cartIds.has(r.id) ? 'cur' : '')"
        @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
        @export-server="startServerExport"
        @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
        @row-click="(r) => router.push(`/mdb/${r.id}`)"
      />
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div v-if="exportJobId !== null" class="panel">
      <div class="job-head">
        <span>전체 엑셀 다운로드 (서버 작업)</span><span style="flex:1" />
        <button class="btn btn-sm" @click="exportJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="exportJobId" />
    </div>

    <div v-if="zipJobId !== null" class="panel">
      <div class="job-head">
        <span>다운대기함 Zip</span><span style="flex:1" />
        <button class="btn btn-sm" @click="zipJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="zipJobId" />
    </div>

    <!-- 다운대기함 -->
    <Modal v-if="cartOpen" title="다운대기함" wide @close="cartOpen = false">
      <div class="cart-bar">
        <span>{{ cart.length }}건</span>
        <span style="flex:1" />
        <label class="chk" title="Zip 안에 원래 폴더 경로대로 담습니다 (항상 유지)">
          <input type="checkbox" checked disabled /> 폴더 경로 유지
        </label>
        <button class="btn btn-sm" :disabled="!cartChecked.size" @click="cartRemoveChecked">선택 제거</button>
        <button class="btn btn-sm" :disabled="!cart.length" @click="cartClear">전체 비우기</button>
        <button class="btn btn-sm" :disabled="!cart.length" @click="cartExport">엑셀 내보내기</button>
      </div>
      <div class="cart-scroll">
        <table class="grid">
          <thead>
            <tr>
              <th style="width:48px">No</th>
              <th style="width:34px">
                <input type="checkbox" :checked="cartAllChecked" @change="cartToggleAll(($event.target as HTMLInputElement).checked)" />
              </th>
              <th>자료명</th><th style="width:260px">경로</th><th style="width:60px">형식</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in cart" :key="c.id">
              <td class="tc">{{ i + 1 }}</td>
              <td class="tc"><input type="checkbox" :checked="cartChecked.has(c.id)" @change="cartToggle(c.id)" /></td>
              <td>{{ c.title }}</td>
              <td class="muted">{{ c.folderName }}</td>
              <td class="tc">{{ c.fileExt.toUpperCase() }}</td>
            </tr>
            <tr v-if="!cart.length"><td colspan="5" class="tc muted">다운대기함이 비어 있습니다. 표에서 체크한 뒤 [선택 다운]이나 [폴더 다운]으로 담으세요.</td></tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button class="btn" @click="cartOpen = false">닫기</button>
        <button class="btn btn-primary" :disabled="!cart.length" @click="downloadCart">이 목록으로 다운하기</button>
      </template>
    </Modal>

    <!-- 폐기 보관함 (읽기 전용) -->
    <Modal v-if="retiredOpen" title="폐기 보관함 (읽기 전용)" wide @close="retiredOpen = false">
      <p class="muted small">복구·비고 작성은 MDB 관리 화면에서 합니다.</p>
      <div class="cart-scroll">
        <table class="grid">
          <thead>
            <tr><th style="width:48px">No</th><th>묶음</th><th>원래 자리</th><th style="width:70px">건수</th>
                <th>사유</th><th>비고</th><th style="width:130px">폐기 일시</th><th style="width:90px">처리자</th></tr>
          </thead>
          <tbody>
            <tr v-for="(b, i) in retired?.items ?? []" :key="b.id">
              <td class="tc">{{ i + 1 }}</td>
              <td>{{ b.label }}</td>
              <td class="muted">{{ b.originalPath ?? '-' }}</td>
              <td class="tc">{{ b.itemCount }}</td>
              <td>{{ b.reason ?? '' }}</td>
              <td>{{ b.note ?? '' }}</td>
              <td class="tc">{{ b.archivedAt.slice(0, 16).replace('T', ' ') }}</td>
              <td class="tc">{{ b.archivedBy ?? '-' }}</td>
            </tr>
            <tr v-if="!retired?.items.length">
              <td colspan="8" class="tc muted">{{ retiredLoading ? '불러오는 중…' : '폐기 보관함이 비어 있습니다.' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  </main>
</template>

<style scoped>
.mdb { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.search { padding: 10px 12px; flex: 0 0 auto; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; }
.meta { margin-top: 8px; font-size: var(--fs-sm); }
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.actions { display: flex; gap: var(--gap-sm); align-items: center; padding: 6px 12px; flex: 0 0 auto; }
.small { font-size: var(--fs-sm); }
.table-panel {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
}
.table-panel > * {
  flex: 1; min-width: 0;
}
.msg { display: flex; align-items: center; gap: 8px; padding: 9px 12px; flex: 0 0 auto; }
.job-head { display: flex; align-items: center; padding: 8px 12px; font-size: var(--fs-sm); font-weight: 600; }
.cart-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cart-scroll { max-height: 60vh; overflow: auto; border: 1px solid var(--border); }
.tagwrap { position: relative; }
.hints {
  position: absolute; top: 100%; left: 0; z-index: 10; margin: 2px 0 0; padding: 0;
  list-style: none; background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); min-width: 180px; max-height: 220px; overflow: auto;
}
.hints li { padding: 5px 10px; cursor: pointer; font-size: var(--fs-sm); }
.hints li:hover { background: var(--accent-soft); }
</style>
