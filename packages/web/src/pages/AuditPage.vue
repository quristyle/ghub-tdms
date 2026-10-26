<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { AuditEntry, AuditListResponse, AuditMeta, AuditSort } from '@tdms/contracts'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import JobProgress from '@/ui/JobProgress.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'

/** 시스템 로그 — 기존 audit.html 구성을 재현한다. 기록은 수정·삭제할 수 없다. */

const f = ref({ dateFrom: '', dateTo: '', screen: '', action: '', userId: '', q: '' })
const message = ref<string | null>(null)

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
  screen: f.value.screen || undefined,
  action: f.value.action || undefined,
  userId: f.value.userId || undefined,
  q: f.value.q || undefined,
  limit: 300,
}))

const { data: meta } = useQuery({
  queryKey: ['audit-meta'],
  queryFn: () => api.get<AuditMeta>('/audit-log/meta'),
  staleTime: 60_000,
})

const { data, isFetching } = useQuery({
  queryKey: computed(() => ['audit', params.value]),
  queryFn: () => api.get<AuditListResponse>(`/audit-log${qs(params.value)}`),
  staleTime: staleTime.worklist,
  placeholderData: (p) => p,
})

const rows = computed(() => data.value?.items ?? [])
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
  { key: 'detail',     label: '상세',      width: '64px', align: 'center', filterable: false,
    render: (a) => (a.detail ? '있음' : '') },
]

function reset() {
  f.value = { dateFrom: '', dateTo: '', screen: '', action: '', userId: '', q: '' }
}

const exportJobId = ref<number | null>(null)
async function exportExcel() {
  try {
    const r = await api.post<{ jobId: number }>('/jobs/excel-export',
      { target: 'audit_log', filters: params.value })
    exportJobId.value = r.jobId
    message.value = '조건에 맞는 전체를 엑셀로 만드는 중입니다. 다 되면 내려받기가 나타납니다.'
  } catch (e) {
    message.value = e instanceof ApiError ? e.message : '내보내지 못했습니다.'
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
        <select v-model="f.screen">
          <option value="">화면 전체</option>
          <option v-for="s in meta?.screens ?? []" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="f.action">
          <option value="">동작 전체</option>
          <option v-for="a in meta?.actions ?? []" :key="a" :value="a">{{ a }}</option>
        </select>
        <select v-model="f.userId"
                :title="meta?.canSelectOtherUser ? '사용자' : '다른 사용자를 고를 권한이 없습니다'">
          <option value="">사용자 전체</option>
          <option v-for="u in meta?.users ?? []" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <input v-model="f.q" type="text" placeholder="자료명·사용자" style="width:160px" />
        <button class="btn btn-sm" @click="reset">조건 초기화</button>
        <span style="flex:1" />
        <button class="btn btn-sm" title="조건에 맞는 전체를 워커가 만든다 — 수만 건도 받을 수 있다"
                @click="exportExcel">전체 엑셀 내보내기</button>
      </div>
      <div class="muted meta">
        <span v-if="isFetching">조회 중…</span>
        <span v-else>상세가 <strong>있음</strong>인 줄을 누르면 내용을 볼 수 있습니다.</span>
        <span v-if="!meta?.canSelectOtherUser"> · 내 기록만 보입니다</span>
      </div>
      <JobProgress v-if="exportJobId !== null" :job-id="exportJobId" />
    </div>

    <div v-if="message" class="panel msg">
      {{ message }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="COLUMNS"
        :rows="rows"
        :total="data?.total ?? null"
        :loading="isFetching && !rows.length"
        :sort-key="sort"
        :sort-dir="dir"
        storage-key="audit"
        excel-name="시스템 로그"
        empty-text="기록이 없습니다."
        @sort="onSort"
        @row-click="(a) => { if (a.detail) detail = a }"
      />
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
.meta { margin-top: 8px; font-size: var(--fs-sm); }
.msg { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--ok-soft); border-color: var(--ok); }
/* 스크롤은 DataTable 이 자기 안에서 맡는다 — 바깥에서 또 스크롤하면
   머리글 고정이 깨진다. 여기서는 자리만 내준다. */
.table-panel { flex: 1; min-height: 0; overflow: hidden; display: flex; }
.table-panel > * { flex: 1; min-width: 0; }
.kv th, .kv td { padding: 4px 8px; text-align: left; border: 1px solid var(--border); }
.kv th { background: var(--bg); width: 90px; white-space: nowrap; }
.detail {
  margin: 12px 0 0; padding: 10px; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 11px; overflow: auto; max-height: 240px;
}
</style>
