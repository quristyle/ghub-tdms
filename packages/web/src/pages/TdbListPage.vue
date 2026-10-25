<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type { DocumentListItem, DocumentListResponse, FolderNode } from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import { api, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

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

// 입력 중에는 요청하지 않는다. IME 조합 중에도 억제한다.
const debounced = ref('')
const composing = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  if (composing.value) return
  timer = setTimeout(() => (debounced.value = v), 250)
})

const params = computed(() => ({
  folderId: folder.value?.id,
  q: debounced.value || undefined,
  searchTarget: searchTarget.value,
  includeIsometric: includeIsometric.value,
  status: status.value,
  hold: hold.value,
  limit: 200,
}))

const { data, isFetching } = useQuery({
  queryKey: computed(() => qk.documents.list(params.value)),
  queryFn: () => api.get<DocumentListResponse>(`/documents${qs(params.value)}`),
  staleTime: staleTime.list,
  placeholderData: (prev) => prev,
})

const rows = computed(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)

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
}

// 행에 마우스를 올리면 상세를 미리 받아 둔다 — 클릭 시 체감 0ms
function prefetch(row: DocumentListItem) {
  void qc.prefetchQuery({
    queryKey: qk.documents.detail(row.id),
    queryFn: () => api.get(`/documents/${row.id}`),
    staleTime: staleTime.detail,
  })
}

const columns = computed<Column<DocumentListItem>[]>(() => [
  { key: 'drawingNo', label: '자료명', width: '200px' },
  { key: 'title', label: '내용', width: '' },
  { key: 'folderName', label: '폴더', width: '150px' },
  { key: 'currentRev', label: 'Rev', width: '56px', align: 'center', render: (r) => `Rev${r.currentRev}` },
  {
    key: 'hold', label: '원본/사본', width: '90px', align: 'center',
    render: (r) => [r.hasDwg ? 'DWG' : '', r.hasPdf ? 'PDF' : ''].filter(Boolean).join('/') || '-',
  },
  {
    key: 'status', label: '상태', width: '90px', align: 'center',
    render: (r) => (r.lentTo ? `${r.lentTo} 대여중` : STATUS_LABEL[r.status] ?? r.status),
  },
  {
    key: 'updatedAt', label: '최종수정', width: '120px', align: 'center',
    render: (r) => r.updatedAt.slice(0, 10),
  },
])

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '정상', PENDING: '검수', SUPERSEDED: '구본',
  MERGE_REQUIRED: '병합 필요', RETIRED: '폐기',
}
</script>

<template>
  <aside class="app-side">
    <LazyTree doc-class="TDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
  </aside>

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
        <label class="chk"><input v-model="includeIsometric" type="checkbox" /> Isometric 보기</label>
        <button class="btn btn-sm" @click="reset">조건 초기화</button>
      </div>
      <div class="search-meta muted">
        총 <strong>{{ total.toLocaleString() }}</strong>건
        <span v-if="folder"> · {{ folder.name }}</span>
        <span v-if="isFetching"> · 조회 중…</span>
      </div>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="columns" :rows="rows" selectable :selected="cart" :loading="isFetching"
        @toggle="toggle" @toggle-all="toggleAll"
        @row-hover="prefetch"
        @row-click="(r) => router.push(`/documents/${r.id}`)"
      />
    </div>

    <div v-if="cart.size" class="panel cart">
      <div class="panel-head">
        반출대기함 ({{ cart.size }})
        <span style="flex:1" />
        <button class="btn btn-sm" @click="clearCart">선택 초기화</button>
        <button class="btn btn-sm btn-primary" :disabled="!session.can('screen.tdb_list.distribute.modify')">
          이 목록으로 반출하기
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.list-main { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.search-panel { padding: 10px 12px; flex: 0 0 auto; }
.search-row { display: flex; gap: var(--gap-sm); flex-wrap: wrap; align-items: center; }
.search-meta { margin-top: 8px; font-size: var(--fs-sm); }
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.table-panel { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.cart { flex: 0 0 auto; }
</style>
