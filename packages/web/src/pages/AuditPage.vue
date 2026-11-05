<script setup lang="ts">
import { computed, ref } from 'vue'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import type { AuditEntry, AuditListResponse, AuditMeta, AuditSort, JobCreated } from '@tdms/contracts'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'

/** 시스템 로그 — 기존 audit.html 구성을 재현한다. 기록은 수정·삭제할 수 없다. */

function formatYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function defaultDates() {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  return {
    dateFrom: formatYmd(yesterday),
    dateTo: formatYmd(today),
  }
}

const { dateFrom: initDateFrom, dateTo: initDateTo } = defaultDates()
const f = ref({
  dateFrom: initDateFrom,
  dateTo: initDateTo,
  /** 화면·동작은 여러 개를 고를 수 있다 (비우면 전체) */
  screen: [] as string[],
  action: [] as string[],
  userId: '',
  q: '',
})

// 화면·동작 고르기 창 — 드롭다운 안에 체크칸 목록
const picker = ref<'screen' | 'action' | null>(null)
function togglePick(kind: 'screen' | 'action', v: string) {
  const list = f.value[kind]
  f.value[kind] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}
const pickLabel = (kind: 'screen' | 'action') => {
  const list = f.value[kind]
  const name = kind === 'screen' ? '화면' : '동작'
  return !list.length ? `${name} 전체` : list.length === 1 ? list[0]! : `${name} ${list.length}개`
}

// 정렬은 서버가 한다 — 300건만 정렬하면 "가장 오래된 기록"이 실제로는 아닐 수 있다.
const sort = ref<AuditSort>('occurredAt')
const dir = ref<SortDir>('desc')
function onSort(key: string, d: SortDir) {
  sort.value = key as AuditSort
  dir.value = d
}

const params = computed(() => ({
  sort: sort.value,
  dir: dir.value,
  dateFrom: f.value.dateFrom || undefined,
  dateTo: f.value.dateTo || undefined,
  screen: f.value.screen.length ? f.value.screen : undefined,
  action: f.value.action.length ? f.value.action : undefined,
  userId: f.value.userId || undefined,
  q: f.value.q || undefined,
  limit: 300,
}))

/** 쿼리스트링 — 화면·동작은 같은 이름을 여러 번 적는다 (?screen=a&screen=b) */
function query(p: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)))
    else sp.set(k, String(v))
  }
  const out = sp.toString()
  return out ? `?${out}` : ''
}

const { data: meta } = useQuery({
  queryKey: ['audit-meta'],
  queryFn: () => api.get<AuditMeta>('/audit-log/meta'),
  staleTime: 60_000,
})

const {
  data,
  isFetching,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
} = useInfiniteQuery({
  queryKey: computed(() => ['audit', params.value]),
  queryFn: ({ pageParam }) =>
    api.get<AuditListResponse>(`/audit-log${query({ ...params.value, cursor: pageParam ?? undefined })}`),
  initialPageParam: null as string | null,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  staleTime: staleTime.list,
})

const rows = computed(() => data.value?.pages.flatMap((p) => p.items) ?? [])
const total = computed(() => data.value?.pages[0]?.total ?? null)
const detail = ref<AuditEntry | null>(null)

const ts = (v: string) => v.slice(0, 19).replace('T', ' ')

/** 엑셀로 나가는 값도 여기를 거친다 — 화면과 파일이 어긋나지 않는다. */
const COLUMNS: Column<AuditEntry>[] = [
  { key: 'occurredAt', label: '시각',      width: '160px', align: 'center', sortable: true, render: (a) => ts(a.occurredAt) },
  { key: 'userName',   label: '사용자',    width: '110px', align: 'center', sortable: true, render: (a) => a.userName ?? '' },
  { key: 'screen',     label: '화면',      width: '140px', sortable: true, render: (a) => a.screen ?? '' },
  { key: 'action',     label: '동작',      width: '160px', sortable: true, render: (a) => a.action ?? '' },
  { key: 'target',     label: '자료명',    sortable: true, render: (a) => a.target ?? '' },
  { key: 'clientIp',   label: '접속 주소', width: '130px', align: 'center', sortable: true, render: (a) => a.clientIp ?? '' },
  // 상세는 본문이 JSON 이라 한 줄로 못 보여 준다. 있는지 없는지만 적고 창으로 연다.
  { key: 'detail',     label: '상세',      width: '64px', align: 'center', sortable: false, filterable: false,
    render: (a) => (a.detail ? '있음' : '') },
]

function reset() {
  const d = defaultDates()
  f.value = {
    dateFrom: d.dateFrom,
    dateTo: d.dateTo,
    screen: [],
    action: [],
    userId: '',
    q: '',
  }
}

// ── 전체 엑셀 (서버 작업) — 지금 조건의 전량. 화면에는 300건씩만 불러온다. ──
const exportJobId = ref<number | null>(null)
const exporting = ref(false)
const exportErr = ref('')
async function startServerExport() {
  if (exporting.value) return
  exporting.value = true
  exportErr.value = ''
  try {
    const { limit: _limit, ...filters } = params.value
    const r = await api.post<JobCreated>('/jobs/excel-export', {
      target: 'audit_log',
      filters,
      filename: `시스템 로그_${new Date().toISOString().slice(0, 10)}.xlsx`,
    })
    exportJobId.value = r.jobId
  } catch (e) {
    exportErr.value = e instanceof ApiError ? e.message : '엑셀 내보내기 요청에 실패했습니다.'
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <main class="app-main audit">
    <div class="panel head">
      <h1>이벤트 및 작업 이력 기록</h1>
      <span class="muted sub">기록은 수정하거나 지울 수 없습니다.</span>
    </div>

    <div class="panel search">
      <div class="bar">
        <input v-model="f.dateFrom" type="date" title="시작일" />
        <span class="muted">~</span>
        <input v-model="f.dateTo" type="date" title="종료일" />
        <span v-for="kind in (['screen', 'action'] as const)" :key="kind" class="multi" @mouseleave="picker = null">
          <button type="button" class="btn btn-sm multi-btn" :class="{ on: f[kind].length }"
                  :aria-expanded="picker === kind" @click="picker = picker === kind ? null : kind">
            {{ pickLabel(kind) }} ▾
          </button>
          <div v-if="picker === kind" class="multi-pop" role="listbox" aria-multiselectable="true">
            <div class="multi-tools">
              <button type="button" class="btn btn-sm btn-ghost" @click="f[kind] = []">전체</button>
            </div>
            <label v-for="v in (kind === 'screen' ? meta?.screens : meta?.actions) ?? []" :key="v" class="multi-item">
              <input type="checkbox" :checked="f[kind].includes(v)" @change="togglePick(kind, v)" /> {{ v }}
            </label>
          </div>
        </span>
        <select v-model="f.userId"
                :title="meta?.canSelectOtherUser ? '사용자' : '다른 사용자를 고를 권한이 없습니다'">
          <option value="">사용자 전체</option>
          <option v-for="u in meta?.users ?? []" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <input v-model="f.q" type="text" placeholder="자료명·사용자" style="width:160px" />
        <button class="btn btn-sm" @click="reset">조건 초기화</button>
      </div>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="COLUMNS"
        :rows="rows"
        :total="total"
        :loading="isFetching && !isFetchingNextPage && !rows.length"
        :has-more="hasNextPage"
        :loading-more="isFetchingNextPage"
        :sort-key="sort"
        :sort-dir="dir"
        storage-key="audit"
        excel-name="시스템 로그"
        server-excel
        :server-exporting="exporting"
        @export-server="startServerExport"
        empty-text="기록이 없습니다."
        @sort="onSort"
        @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
        @row-click="(a) => { if (a.detail) detail = a }"
      >
        <template #cell:detail="{ row }">
          <span
            v-if="row.detail"
            class="detail-icon-wrap"
            title="상세 보기"
            role="button"
            tabindex="0"
            aria-label="상세 보기"
            @click.stop="detail = row"
            @keydown.enter.space.prevent="detail = row"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9.5 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-8.5L9.5 1.5z" />
              <path d="M9.5 1.5v3.5h3.5" />
              <path d="M5.5 7.5h5" />
              <path d="M5.5 10.5h5" />
            </svg>
          </span>
        </template>
      </DataTable>
    </div>

    <div v-if="exportErr" class="panel msg err">
      {{ exportErr }}<span style="flex:1" />
      <button class="btn btn-sm" @click="exportErr = ''">닫기</button>
    </div>

    <div v-if="exportJobId !== null" class="panel">
      <div class="job-head">
        <span>전체 엑셀 다운로드 (서버 작업)</span><span style="flex:1" />
        <button class="btn btn-sm" @click="exportJobId = null">닫기</button>
      </div>
      <JobProgress :job-id="exportJobId" />
    </div>

    <Modal v-if="detail" title="상세 내용" @close="detail = null">
      <table class="kv">
        <tbody>
          <tr><th>시각</th><td>{{ detail.occurredAt.replace('T', ' ').slice(0, 19) }}</td></tr>
          <tr><th>사용자</th><td>{{ detail.userName ?? '-' }}</td></tr>
          <tr><th>화면</th><td>{{ detail.screen ?? '-' }}</td></tr>
          <tr><th>동작</th><td>{{ detail.action ?? '-' }}</td></tr>
          <tr><th>자료명</th><td>{{ detail.target ?? '-' }}</td></tr>
          <tr><th>접속 주소</th><td>{{ detail.clientIp ?? '-' }}</td></tr>
        </tbody>
      </table>
      <pre class="detail">{{ JSON.stringify(detail.detail, null, 2) }}</pre>
    </Modal>
  </main>
</template>

<style scoped>
.audit { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.sub { font-size: var(--fs-sm); }
.search { padding: 10px 12px; flex: 0 0 auto; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; }
/* 스크롤은 DataTable 이 자기 안에서 맡는다 — 바깥에서 또 스크롤하면
   머리글 고정이 깨진다. 여기서는 자리만 내준다. */
.table-panel { flex: 1; min-height: 0; overflow: hidden; display: flex; }
.table-panel > * { flex: 1; min-width: 0; }
.detail-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--primary);
  cursor: pointer;
  transition: background-color var(--dur-fast, 120ms), color var(--dur-fast, 120ms);
}
.detail-icon-wrap:hover {
  background-color: var(--primary-soft);
}
.kv th, .kv td { padding: 4px 8px; text-align: left; border: 1px solid var(--border); }
.kv th { background: var(--bg); width: 90px; white-space: nowrap; }
.detail {
  margin: 12px 0 0; padding: 10px; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 11px; overflow: auto; max-height: 240px;
}
.multi { position: relative; }
.multi-btn.on { border-color: var(--primary); color: var(--primary); }
.multi-pop {
  position: absolute; top: 100%; left: 0; z-index: 20; margin-top: 2px;
  min-width: 200px; max-height: 300px; overflow: auto; padding: 4px 0;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
}
.multi-tools { padding: 2px 6px 4px; border-bottom: 1px solid var(--border); }
.multi-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: var(--fs-sm); white-space: nowrap; cursor: pointer; }
.multi-item:hover { background: var(--accent-soft); }
.msg { display: flex; align-items: center; gap: 8px; padding: 9px 12px; flex: 0 0 auto; }
.job-head { display: flex; align-items: center; padding: 8px 12px; font-size: var(--fs-sm); font-weight: 600; }
</style>
