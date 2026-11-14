<script setup lang="ts">
import { computed, ref } from 'vue'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import type { AuditEntry, AuditListResponse, AuditMeta, AuditSort, JobCreated } from '@tdms/contracts'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import ZipStatusModal from '@/ui/ZipStatusModal.vue'
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
/** Zip 상세 현황 팝업 — 반출이력과 공용 */
const zipDetail = ref<string | null>(null)

const ts = (v: string) => v.slice(0, 19).replace('T', ' ')

/**
 * 상세(JSON)를 한 줄 글로 — 기존 화면의 formatDetail 과 같은 모양.
 * 표에 그대로 적고, 길어서 잘리면 눌러서 전체를 팝업으로 본다.
 */
function blank(v: unknown) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
}
function detailText(d: AuditEntry['detail']): string {
  if (!d) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(d)) {
    if (blank(v)) continue
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => !blank(x)).map(([ik, ix]) => `${ik} ${String(ix)}`).join(', ')
      if (inner) parts.push(`${k}(${inner})`)
    } else {
      parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    }
  }
  return parts.join(' \u00b7 ')
}

/** 반출 Zip 을 남긴 기록이면 그 파일 이름 — 기존 화면의 'Zip 파일명' 칸 */
const zipNameOf = (a: AuditEntry) =>
  (typeof a.detail?.zipName === 'string' ? a.detail.zipName : null)

const zipHref = (name: string) =>
  `/api/distributions/zip-file?zipName=${encodeURIComponent(name)}`

/** 엑셀로 나가는 값도 여기를 거친다 — 화면과 파일이 어긋나지 않는다. */
const COLUMNS: Column<AuditEntry>[] = [
  { key: 'occurredAt', label: '시각',        width: '150px', align: 'center', sortable: true, render: (a) => ts(a.occurredAt) },
  { key: 'screen',     label: '화면',        width: '130px', align: 'center', sortable: true, render: (a) => a.screen ?? '\u00b7' },
  { key: 'action',     label: '동작',        width: '150px', align: 'center', sortable: true, render: (a) => a.action ?? '\u00b7' },
  { key: 'userName',   label: '사용자',      width: '100px', align: 'center', sortable: true, render: (a) => a.userName ?? '\u00b7' },
  { key: 'target',     label: '자료명',      width: '200px', sortable: true, render: (a) => a.target ?? '\u00b7' },
  { key: 'zipName',    label: 'Zip 파일명',  width: '190px', sortable: false,
    render: (a) => zipNameOf(a) ?? '\u00b7' },
  { key: 'confirm',    label: '확인',        width: '170px', align: 'center',
    sortable: false, filterable: false, exportable: false, render: () => '' },
  { key: 'clientIp',   label: '접속 주소',   width: '120px', align: 'center', sortable: true, render: (a) => a.clientIp ?? '\u00b7' },
  // 내용을 그대로 적는다 — 칸보다 길면 눌러서 전체를 본다 (기존 .detail-cell)
  { key: 'detail',     label: '상세 내용',   sortable: false, render: (a) => detailText(a.detail) },
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
    <div class="page-head">
      <div>
        <h1 class="page-title">
          시스템 로그<span class="page-title-sub">이벤트 및 작업 이력 기록</span>
        </h1>
        <p class="page-desc">기록은 수정하거나 지울 수 없습니다.</p>
      </div>
    </div>

    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div v-for="kind in (['screen', 'action'] as const)" :key="kind" class="field">
            <label>{{ kind === 'screen' ? '로그화면' : '로그동작' }}</label>
            <div class="hideable-dropdown ms-dropdown" @mouseleave="picker = null">
              <button type="button" class="dropdown-toggle"
                      :aria-expanded="picker === kind" @click="picker = picker === kind ? null : kind">
                {{ pickLabel(kind) }}
              </button>
              <div v-if="picker === kind" class="dropdown-list" role="listbox" aria-multiselectable="true">
                <div class="dropdown-group-label">
                  <button type="button" class="link" @click="f[kind] = []">전체 해제</button>
                </div>
                <label v-for="v in (kind === 'screen' ? meta?.screens : meta?.actions) ?? []" :key="v"
                       class="dropdown-item dropdown-item-ms">
                  <input type="checkbox" :checked="f[kind].includes(v)" @change="togglePick(kind, v)" /> {{ v }}
                </label>
              </div>
            </div>
          </div>

          <div class="field">
            <label for="audit-user">사용자</label>
            <select id="audit-user" v-model="f.userId"
                    :title="meta?.canSelectOtherUser ? '사용자' : '다른 사용자를 고를 권한이 없습니다'">
              <option value="">전체</option>
              <option v-for="u in meta?.users ?? []" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </div>

          <div class="field">
            <label for="from-filter">기간</label>
            <input id="from-filter" v-model="f.dateFrom" type="date" title="시작일" />
          </div>
          <div class="field">
            <label for="to-filter">~</label>
            <input id="to-filter" v-model="f.dateTo" type="date" title="종료일" />
          </div>

          <input v-model="f.q" type="text" class="filter-search" placeholder="자료명·상세 내용 검색" />
        </div>
        <div class="filter-actions">
          <button type="button" @click="reset">조건 초기화</button>
        </div>
      </div>
    </div>

    <div class="status-bar">
      <span class="status-bar-left">
        <span class="total-count">전체 {{ (total ?? 0).toLocaleString() }}건</span>
        <span v-if="isFetching && !isFetchingNextPage" class="muted">&nbsp;· 조회 중…</span>
      </span>
      <span class="cart-status">
        <button class="cart-btn" type="button" :disabled="exporting" @click="startServerExport">
          엑셀 내보내기
        </button>
      </span>
    </div>

    <div class="table-box">
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
        empty-text="기록이 없습니다."
        @sort="onSort"
        @load-more="() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }"
        @row-click="(a) => { if (a.detail) detail = a }"
      >
        <template #cell:confirm="{ row }">
          <template v-if="zipNameOf(row)">
            <a class="small zip-btn" :href="zipHref(zipNameOf(row)!)"
               :download="zipNameOf(row)!" title="이 기록이 만든 Zip 받기" @click.stop>Zip 다운</a>
            <button class="small" title="이 Zip 에 담긴 자료와 반입 진행 상황"
                    @click.stop="zipDetail = zipNameOf(row)">상세 현황</button>
          </template>
        </template>

        <template #cell:detail="{ row }">
          <span v-if="row.detail" class="detail-cell-clickable" :title="detailText(row.detail)"
                @click.stop="detail = row">{{ detailText(row.detail) }}</span>
        </template>

      </DataTable>
    </div>

    <div v-if="exportErr" class="msg err">
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

    <!-- Zip 상세 현황 (반출이력과 공용 팝업) -->
    <ZipStatusModal v-if="zipDetail" :zip-name="zipDetail" @close="zipDetail = null" />

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
.audit { min-height: 0; }

/* 결과 표 — 스크롤은 DataTable 이 자기 안에서 맡는다. 여기서는 자리만 내준다. */
.table-box {
  flex: 1 1 auto; min-height: 240px; display: flex;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); overflow: hidden;
}
.table-box > * { flex: 1; min-width: 0; }

/* 상세 내용 칸 — 잘려 보이는 글을 누르면 팝업으로 전체를 본다 (기존 .detail-cell) */
.detail-cell-clickable { cursor: pointer; }
.detail-cell-clickable:hover { text-decoration: underline; color: var(--text); }

/* '확인' 칸의 [Zip 다운] — <a> 를 작은 버튼처럼 */
.zip-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 26px; padding: 0 10px;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text); font-size: 11.5px; white-space: nowrap;
}
.zip-btn:hover { background: var(--surface-alt); border-color: var(--text-faint); border-bottom-color: var(--text-faint); }

.kv th, .kv td { padding: 4px 8px; text-align: left; border: 1px solid var(--border); }
.kv th { background: var(--surface-alt); width: 90px; white-space: nowrap; }
.detail {
  margin: 12px 0 0; padding: 10px; background: var(--surface-alt); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 11.5px; overflow: auto; max-height: 240px;
}
.msg { flex: 0 0 auto; }
.job-head { display: flex; align-items: center; padding: 8px 12px; font-size: 11.5px; font-weight: 600; }
</style>
