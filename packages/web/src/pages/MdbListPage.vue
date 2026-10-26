<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import type { FolderNode, MdbListItem, MdbListResponse, MdbMeta, TagSuggestResponse } from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'

/** MDB 조회 — 기존 mdb.html 구성을 재현한다. 리비전·반출이 없는 고정 기록이다. */

const router = useRouter()

const folder = ref<FolderNode | null>(null)
const keyword = ref('')
const searchTarget = ref<'title' | 'folder' | 'tag'>('title')
const equipmentType = ref('')
const docType = ref('')
const projectId = ref('')
const year = ref('')
const shared = ref('')
const needsCheck = ref(false)

const debounced = ref('')
const composing = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  if (composing.value) return
  timer = setTimeout(() => (debounced.value = v), 250)
})

const { data: meta } = useQuery({
  queryKey: ['mdb-meta'],
  queryFn: () => api.get<MdbMeta>('/mdb/meta'),
  staleTime: staleTime.types,
})

const sort = ref<'updatedAt' | 'title' | 'equipmentType' | 'docType' | 'year'>('updatedAt')
const dir = ref<SortDir>('desc')
function onSort(key: string, d: SortDir) { sort.value = key as typeof sort.value; dir.value = d }

const params = computed(() => ({
  sort: sort.value,
  dir: dir.value,
  folderId: folder.value?.id,
  q: debounced.value || undefined,
  searchTarget: searchTarget.value,
  equipmentType: equipmentType.value || undefined,
  docType: docType.value || undefined,
  projectId: projectId.value || undefined,
  year: year.value || undefined,
  shared: shared.value === '' ? undefined : shared.value,
  needsCheck: needsCheck.value ? true : undefined,
  limit: 200,
}))

const { data, isFetching } = useQuery({
  queryKey: computed(() => ['mdb', params.value]),
  queryFn: () => api.get<MdbListResponse>(`/mdb${qs(params.value)}`),
  staleTime: staleTime.list,
  placeholderData: (p) => p,
})

const rows = computed(() => data.value?.items ?? [])

// Tag No 자동완성
const tagHints = ref<string[]>([])
watch([debounced, searchTarget], async ([q, t]) => {
  if (t !== 'tag' || q.length < 2) { tagHints.value = []; return }
  tagHints.value = (await api.get<TagSuggestResponse>(`/mdb/tags/suggest${qs({ q })}`)).items.slice(0, 8)
})

// 다운대기함 — 서버 왕복 없이 로컬 상태로
const cart = ref(new Set<number>())
function toggle(id: number) {
  cart.value.has(id) ? cart.value.delete(id) : cart.value.add(id)
  cart.value = new Set(cart.value)
}
function toggleAll(on: boolean) {
  for (const r of rows.value) on ? cart.value.add(r.id) : cart.value.delete(r.id)
  cart.value = new Set(cart.value)
}
const clearCart = () => (cart.value = new Set())

/** 다운대기함을 Zip 으로 받는다. 묶는 일은 워커가 하고 진행률은 SSE 로 본다. */
const zipJobId = ref<number | null>(null)
async function downloadCart() {
  const r = await api.post<{ jobId: number }>('/mdb/download-zip', { fileIds: [...cart.value] })
  zipJobId.value = r.jobId
  clearCart()
}

function reset() {
  keyword.value = ''; debounced.value = ''; searchTarget.value = 'title'
  equipmentType.value = ''; docType.value = ''; projectId.value = ''
  year.value = ''; shared.value = ''; needsCheck.value = false
}

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`
}

/* 'Mechanical Data Book'(자료유형)·'Heat Exchanger'(설비유형)가 들어가는 너비로 잡았다 */
const columns = computed<Column<MdbListItem>[]>(() => [
  { key: 'title', label: '자료명', width: '288px', sortable: true },
  { key: 'folderName', label: '폴더' },   // 남는 자리를 받는 칸
  { key: 'equipmentType', label: '설비유형', width: '124px', sortable: true,
    render: (r) => r.equipmentType ?? '-' },
  { key: 'docType', label: '자료유형', width: '176px', sortable: true,
    render: (r) => r.docType ?? '-' },
  { key: 'year', label: '연도', width: '64px', align: 'center', sortable: true,
    render: (r) => String(r.year ?? '-') },
  { key: 'isShared', label: '공용/전용', width: '84px', align: 'center',
    render: (r) => (r.isShared ? '공용' : '전용') },
  { key: 'tagCount', label: 'Tag', width: '56px', align: 'center', filterable: false,
    render: (r) => String(r.tagCount) },
  { key: 'byteSize', label: '크기', width: '84px', align: 'right', filterable: false,
    render: (r) => size(r.byteSize) },
  { key: 'updatedAt', label: '최종수정', width: '104px', align: 'center', sortable: true,
    render: (r) => r.updatedAt.slice(0, 10) },
])
</script>

<template>
  <aside class="app-side">
    <LazyTree doc-class="MDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
  </aside>

  <main class="app-main mdb">
    <div class="panel search">
      <div class="bar">
        <select v-model="searchTarget">
          <option value="title">자료명 검색</option>
          <option value="folder">폴더명 검색</option>
          <option value="tag">Tag No 검색</option>
        </select>
        <span class="tagwrap">
          <input
            v-model="keyword" type="text" placeholder="검색어" style="width:180px"
            @compositionstart="composing = true"
            @compositionend="composing = false; debounced = keyword"
          />
          <ul v-if="tagHints.length" class="hints">
            <li v-for="t in tagHints" :key="t" @click="keyword = t; debounced = t; tagHints = []">{{ t }}</li>
          </ul>
        </span>
        <select v-model="equipmentType">
          <option value="">설비유형 전체</option>
          <option v-for="e in meta?.equipmentTypes ?? []" :key="e" :value="e">{{ e }}</option>
        </select>
        <select v-model="docType">
          <option value="">자료유형 전체</option>
          <option v-for="d in meta?.docTypes ?? []" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model="projectId">
          <option value="">공사 전체</option>
          <option v-for="p in meta?.projects ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-model="year">
          <option value="">연도 전체</option>
          <option v-for="y in meta?.years ?? []" :key="y" :value="y">{{ y }}</option>
        </select>
        <select v-model="shared">
          <option value="">공용·전용 전체</option>
          <option value="true">공용</option>
          <option value="false">전용</option>
        </select>
        <label class="chk"><input v-model="needsCheck" type="checkbox" /> 확인필요</label>
        <button class="btn btn-sm" @click="reset">조건 초기화</button>
      </div>
      <div class="muted meta">
        <span v-if="folder">{{ folder.name }}</span>
        <span v-else>전체 폴더</span>
        <span v-if="isFetching"> · 조회 중…</span>
      </div>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="columns" :rows="rows" selectable :selected="cart" :loading="isFetching"
        :total="data?.total ?? null" :sort-key="sort" :sort-dir="dir" storage-key="mdb-list" excel-name="MDB 자료목록"
        @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
        @row-click="(r) => router.push(`/mdb/${r.id}`)"
      />
    </div>

    <div v-if="zipJobId !== null" class="panel">
      <JobProgress :job-id="zipJobId" />
    </div>

    <div v-if="cart.size" class="panel cart">
      <div class="panel-head">
        다운대기함 ({{ cart.size }})
        <span style="flex:1" />
        <button class="btn btn-sm" @click="clearCart">선택 초기화</button>
        <button class="btn btn-sm btn-primary" @click="downloadCart">이 목록으로 다운하기</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.mdb { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.search { padding: 10px 12px; flex: 0 0 auto; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; }
.meta { margin-top: 8px; font-size: var(--fs-sm); }
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.table-panel { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.cart { flex: 0 0 auto; }
.tagwrap { position: relative; }
.hints {
  position: absolute; top: 100%; left: 0; z-index: 10; margin: 2px 0 0; padding: 0;
  list-style: none; background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); min-width: 180px; max-height: 220px; overflow: auto;
}
.hints li { padding: 5px 10px; cursor: pointer; font-size: var(--fs-sm); }
.hints li:hover { background: var(--accent-soft); }
</style>
