<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  DistributionListResult, DistributionRow, FilterOptions,
  ForImportResult, OutstandingResult, ZipExportListResult, ZipExportRow, ZipStatusResult,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'
import { DISTRIBUTION_STATE_LABEL, PURPOSE_LABEL } from '@/lib/labels'
import { useSession } from '@/lib/session'

/** TDB 반출이력 — 기존 distributions.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

const canManualReturn = computed(() => session.can('screen.tdb_distributions.confirm.manual_return'))
const canNote = computed(() => session.can('common.note_edit.distribution'))

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

// ── 보기 모드 · 검색 조건 ─────────────────────────────────────────────
const byZip = ref(false)
const f = ref({
  dateFrom: '', dateTo: '', vendorId: '', projectId: '',
  purpose: '', state: '', distributedBy: '', q: '',
})

const params = computed(() => ({
  dateFrom: f.value.dateFrom || undefined,
  dateTo: f.value.dateTo || undefined,
  vendorId: f.value.vendorId || undefined,
  projectId: f.value.projectId || undefined,
  purpose: f.value.purpose || undefined,
  state: f.value.state || undefined,
  distributedBy: f.value.distributedBy || undefined,
  q: f.value.q || undefined,
  limit: 200,
}))

function reset() {
  f.value = { dateFrom: '', dateTo: '', vendorId: '', projectId: '', purpose: '', state: '', distributedBy: '', q: '' }
}

const { data: opts } = useQuery({
  queryKey: ['dist-filter-options'],
  queryFn: () => api.get<FilterOptions>('/distributions/filter-options'),
  staleTime: staleTime.types,
})

const { data: list, isFetching } = useQuery({
  queryKey: computed(() => ['distributions', params.value]),
  queryFn: () => api.get<DistributionListResult>(`/distributions${qs(params.value)}`),
  enabled: computed(() => !byZip.value),
  staleTime: staleTime.worklist,
  placeholderData: (p) => p,
})

const { data: zipList } = useQuery({
  queryKey: computed(() => ['dist-zips', params.value]),
  queryFn: () => api.get<ZipExportListResult>(`/distributions/zip-exports${qs(params.value)}`),
  enabled: computed(() => byZip.value),
  staleTime: staleTime.worklist,
})

const rows = computed(() => list.value?.items ?? [])
const zips = computed(() => zipList.value?.items ?? [])

// ── 선택 · 반납 처리 ──────────────────────────────────────────────────
const picked = ref(new Set<number>())
function toggle(id: number) {
  picked.value.has(id) ? picked.value.delete(id) : picked.value.add(id)
  picked.value = new Set(picked.value)
}
const openPicked = computed(() =>
  rows.value.filter((r) => picked.value.has(r.id) && r.state === 'INCOMPLETE').length)

async function doReturn(manual: boolean) {
  try {
    const r = await api.post<{ returned: number; skipped: { reason: string }[] }>(
      '/distributions/return', { distributionIds: [...picked.value], manual, note: null })
    say(r.skipped.length ? 'err' : 'ok',
      r.skipped.length
        ? `${r.returned}건 처리, ${r.skipped.length}건 건너뜀 — ${r.skipped[0]!.reason}`
        : `${r.returned}건을 반납 처리했습니다.`)
    picked.value = new Set()
    refresh()
  } catch (e) { fail(e) }
}

function refresh() {
  void qc.invalidateQueries({ queryKey: ['distributions'] })
  void qc.invalidateQueries({ queryKey: ['dist-zips'] })
  void qc.invalidateQueries({ queryKey: ['dist-outstanding'] })
}

// ── 비고 ──────────────────────────────────────────────────────────────
async function saveNote(row: DistributionRow, note: string) {
  try {
    await api.post(`/distributions/${row.id}/note`, { note: note || null })
    say('ok', '비고를 저장했습니다.')
    refresh()
  } catch (e) { fail(e) }
}

// ── 미입고 현황 ───────────────────────────────────────────────────────
const outstandingOpen = ref(false)
const { data: outstanding } = useQuery({
  queryKey: ['dist-outstanding'],
  queryFn: () => api.get<OutstandingResult>('/distributions/outstanding'),
  staleTime: staleTime.worklist,
})

// ── 반입 대상 ─────────────────────────────────────────────────────────
const forImportOpen = ref(false)
const forImportVendor = ref('')
const { data: forImport } = useQuery({
  queryKey: computed(() => ['dist-for-import', forImportVendor.value]),
  queryFn: () => api.get<ForImportResult>(
    `/distributions/for-import${qs({ vendorName: forImportVendor.value || undefined })}`),
  enabled: computed(() => forImportOpen.value),
})

// ── Zip 상세 현황 ─────────────────────────────────────────────────────
const zipDetail = ref<string | null>(null)
const { data: zipStatus } = useQuery({
  queryKey: computed(() => ['dist-zip-status', zipDetail.value]),
  queryFn: () => api.get<ZipStatusResult>(
    `/distributions/zip-status${qs({ zipName: zipDetail.value ?? '' })}`),
  enabled: computed(() => zipDetail.value !== null),
})

// ── 엑셀 내보내기 ─────────────────────────────────────────────────────
const exportJobId = ref<number | null>(null)
async function exportExcel() {
  try {
    const r = await api.post<{ jobId: number }>('/jobs/excel-export',
      { target: 'distributions', filters: params.value })
    exportJobId.value = r.jobId
    say('ok', '엑셀을 만드는 중입니다.')
  } catch (e) { fail(e) }
}

function stateClass(s: string) {
  return s === 'INCOMPLETE' ? 'warn' : s === 'ISSUE' ? 'issue' : ''
}

// ── 표 칸 ──────────────────────────────────────────────────────────────
// render 는 **글자값**이다 — 거르기·엑셀이 이것을 쓴다. 슬롯은 그리는 법만 바꾼다.
const day = (v: string) => v.slice(0, 10)

const COLUMNS: Column<DistributionRow>[] = [
  { key: 'documentLabel', label: '자료명', width: '220px',
    render: (r) => (r.title ? `${r.documentLabel} ${r.title}` : r.documentLabel) },
  { key: 'revAtDistribution', label: '반출Rev', width: '76px', align: 'center',
    render: (r) => `Rev${r.revAtDistribution}` },
  { key: 'vendorName', label: '업체', width: '130px' },
  { key: 'projectName', label: '공사', width: '120px', align: 'center', render: (r) => r.projectName ?? '' },
  { key: 'purpose', label: '목적', width: '92px', align: 'center',
    render: (r) => PURPOSE_LABEL[r.purpose] ?? r.purpose },
  { key: 'distributedBy', label: '반출자', width: '96px', align: 'center', render: (r) => r.distributedBy ?? '' },
  { key: 'distributedAt', label: '반출일시', width: '104px', align: 'center', render: (r) => day(r.distributedAt) },
  { key: 'returnedAt', label: '반입일시', width: '104px', align: 'center',
    render: (r) => (r.returnedAt ? day(r.returnedAt) : '') },
  { key: 'state', label: '상태', width: '136px',
    // 엑셀에도 "수정없음"·"21일"이 함께 나가야 화면과 같은 뜻이 된다
    render: (r) => [
      DISTRIBUTION_STATE_LABEL[r.state],
      r.manualReturn ? '수정없음' : '',
      r.daysOut !== null && r.daysOut >= 14 ? `${r.daysOut}일` : '',
    ].filter(Boolean).join(' ') },
  { key: 'note', label: '비고', width: '180px', render: (r) => r.note ?? '' },
]

const ZIP_COLUMNS: Column<ZipExportRow & { id: number }>[] = [
  { key: 'zipName', label: 'Zip', width: '240px' },
  { key: 'vendorName', label: '업체', width: '140px' },
  { key: 'projectName', label: '공사', width: '120px', align: 'center', render: (z) => z.projectName ?? '' },
  { key: 'purpose', label: '목적', width: '92px', align: 'center',
    render: (z) => PURPOSE_LABEL[z.purpose] ?? z.purpose },
  { key: 'distributedBy', label: '반출자', width: '96px', align: 'center', render: (z) => z.distributedBy ?? '' },
  { key: 'distributedAt', label: '반출일시', width: '104px', align: 'center', render: (z) => day(z.distributedAt) },
  { key: 'itemCount', label: '건수', width: '70px', align: 'right', render: (z) => String(z.itemCount) },
  { key: 'returnedCount', label: '반입', width: '70px', align: 'right', render: (z) => String(z.returnedCount) },
  { key: 'complete', label: '상태', width: '100px', align: 'center',
    render: (z) => (z.complete ? '반입완료' : '반입미완료') },
  { key: 'act', label: '조치', width: '92px', align: 'center', filterable: false, render: () => '' },
]

/**
 * Zip 목록에는 id 가 없다 — 공통 그리드는 줄을 id 로 가린다(가상 스크롤의 key).
 * Zip 이름이 그 자리의 열쇠이므로 목록 안 위치를 id 로 삼는다.
 * 목록이 통째로 다시 올 때만 바뀌므로 줄이 섞일 일이 없다.
 */
const zipRows = computed(() => zips.value.map((z, i) => ({ ...z, id: i + 1 })))
</script>

<template>
  <main class="app-main dist">
    <div class="panel head">
      <h1>TDB 자료 다운로드 및 반출 기록 관리</h1>
      <span style="flex:1" />
      <button class="btn btn-sm" @click="outstandingOpen = true">
        미입고 현황 <span class="cnt">{{ outstanding?.summary.total ?? 0 }}</span>
      </button>
      <button class="btn btn-sm" @click="forImportOpen = true">반입 대상</button>
    </div>

    <div class="panel search">
      <div class="bar">
        <span class="toggle">
          <button class="btn btn-sm" :class="{ on: !byZip }" @click="byZip = false">자료별</button>
          <button class="btn btn-sm" :class="{ on: byZip }" @click="byZip = true">Zip별</button>
        </span>
        <input v-model="f.dateFrom" type="date" title="반출 시작일" />
        <span class="muted">~</span>
        <input v-model="f.dateTo" type="date" title="반출 종료일" />
        <select v-model="f.vendorId">
          <option value="">업체 전체</option>
          <option v-for="v in opts?.vendors ?? []" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
        <select v-model="f.projectId">
          <option value="">공사 전체</option>
          <option v-for="p in opts?.projects ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-model="f.purpose">
          <option value="">목적 전체</option>
          <option value="MODIFY">수정용</option>
          <option value="REFERENCE">참조용</option>
          <option value="ETC">기타</option>
        </select>
        <select v-model="f.state">
          <option value="">상태 전체</option>
          <option value="INCOMPLETE">반입미완료</option>
          <option value="REVIEWING">검수대기</option>
          <option value="ISSUE">확인필요</option>
          <option value="DONE">반입완료</option>
        </select>
        <select v-model="f.distributedBy" :title="opts?.canSelectOtherUser ? '반출자' : '다른 사용자를 고를 권한이 없습니다'">
          <option value="">반출자 전체</option>
          <option v-for="u in opts?.distributors ?? []" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <input v-model="f.q" type="text" placeholder="자료명" style="width:150px" />
        <button class="btn btn-sm" @click="reset">조건 초기화</button>
      </div>
      <div class="bar">
        <!-- 건수·선택수는 그리드 아래쪽이 적는다. 두 군데 적으면 서로 어긋난다. -->
        <span v-if="isFetching" class="muted">조회 중…</span>
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="!openPicked" @click="doReturn(false)">선택 반납처리</button>
        <button class="btn btn-sm" :disabled="!openPicked || !canManualReturn"
                :title="canManualReturn ? '' : '권한이 없습니다'"
                @click="doReturn(true)">수정없이 반납처리</button>
        <button class="btn btn-sm" title="조건에 맞는 전체를 워커가 만든다 — 수만 건도 받을 수 있다"
                @click="exportExcel">전체 엑셀 내보내기</button>
      </div>
      <JobProgressSlot :job-id="exportJobId" />
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel table-panel">
      <!-- 자료별 -->
      <DataTable
        v-if="!byZip"
        :columns="COLUMNS" :rows="rows" selectable :selected="picked"
        :total="list?.total ?? null" :loading="isFetching && !rows.length"
        :row-class="(r) => stateClass(r.state)"
        storage-key="dist-items" excel-name="TDB 반출이력"
        empty-text="반출 기록이 없습니다."
        @toggle="toggle"
        @toggle-all="(on) => { picked = on ? new Set(rows.map(r => r.id)) : new Set() }"
      >
        <template #cell:documentLabel="{ row }">
          <RouterLink v-if="row.documentId" :to="`/documents/${row.documentId}`" @click.stop>
            {{ row.documentLabel }}
          </RouterLink>
          <span v-else class="muted">{{ row.documentLabel }}</span>
          <span v-if="row.title" class="muted small sub-inline">{{ row.title }}</span>
        </template>

        <template #cell:state="{ row }">
          <span>{{ DISTRIBUTION_STATE_LABEL[row.state] }}</span>
          <span v-if="row.manualReturn" class="tag" title="수정 없이 반납 처리된 건">수정없음</span>
          <span v-if="row.daysOut !== null && row.daysOut >= 14" class="tag warn-tag">{{ row.daysOut }}일</span>
        </template>

        <template #cell:note="{ row }">
          <span v-if="!canNote">{{ row.note ?? '-' }}</span>
          <input
            v-else type="text" :value="row.note ?? ''" placeholder="비고" style="width:100%"
            @click.stop
            @change="saveNote(row, ($event.target as HTMLInputElement).value)"
          />
        </template>
      </DataTable>

      <!-- Zip별 -->
      <DataTable
        v-else
        :columns="ZIP_COLUMNS" :rows="zipRows" :total="zipRows.length"
        :row-class="(z) => (z.complete ? '' : 'warn')"
        storage-key="dist-zips" excel-name="TDB 반출이력 (Zip별)"
        empty-text="Zip 반출 기록이 없습니다."
        @row-click="(z) => (zipDetail = z.zipName)"
      >
        <template #cell:act="{ row }">
          <button class="btn btn-sm" @click.stop="zipDetail = row.zipName">상세 현황</button>
        </template>
      </DataTable>
    </div>

    <!-- 미입고 현황 -->
    <Modal v-if="outstandingOpen" wide title="미입고 현황" @close="outstandingOpen = false">
      <p class="muted">
        곧 바뀔 수 있는 반출 건입니다 — <strong>아직 안 돌아온 것</strong>과
        <strong>돌아왔지만 검수 전인 것</strong>을 함께 셉니다(승인되는 순간 리비전이 바뀝니다).
        오래 나가 있는 순입니다.
      </p>
      <div class="summary">
        <span>전체 <strong>{{ outstanding?.summary.total ?? 0 }}</strong></span>
        <span>미반납 <strong>{{ outstanding?.summary.notReturned ?? 0 }}</strong></span>
        <span>검수대기 <strong>{{ outstanding?.summary.reviewing ?? 0 }}</strong></span>
        <span v-if="outstanding?.summary.oldestDays !== null">
          최장 <strong>{{ outstanding?.summary.oldestDays }}</strong>일
        </span>
        <span style="flex:1" />
        <span v-for="v in outstanding?.summary.byVendor ?? []" :key="v.vendorName" class="tag">
          {{ v.vendorName }} {{ v.count }}
        </span>
      </div>
      <table class="grid">
        <thead><tr><th>자료명</th><th>업체</th><th>반출일시</th><th>나간 일수</th><th>상태</th></tr></thead>
        <tbody>
          <tr v-for="r in outstanding?.items ?? []" :key="r.id" :class="stateClass(r.state)">
            <td>{{ r.documentLabel }}</td>
            <td>{{ r.vendorName }}</td>
            <td class="tc">{{ r.distributedAt.slice(0, 10) }}</td>
            <td class="tc">{{ r.daysOut ?? '-' }}</td>
            <td class="tc">{{ DISTRIBUTION_STATE_LABEL[r.state] }}</td>
          </tr>
          <tr v-if="!outstanding?.items.length"><td colspan="5" class="tc muted">미입고 건이 없습니다.</td></tr>
        </tbody>
      </table>
    </Modal>

    <!-- 반입 대상 -->
    <Modal v-if="forImportOpen" wide title="반입 대상" @close="forImportOpen = false">
      <p class="muted">업체가 수정용으로 가져간 자료입니다. 반입미완료만 반입 대상이 됩니다.</p>
      <div class="bar">
        <select v-model="forImportVendor">
          <option value="">업체 전체</option>
          <option v-for="v in opts?.vendors ?? []" :key="v.id" :value="v.name">{{ v.name }}</option>
        </select>
      </div>
      <table class="grid">
        <thead><tr><th>자료명</th><th>반출Rev</th><th>공사</th><th>반출일시</th><th>상태</th></tr></thead>
        <tbody>
          <tr v-for="r in forImport?.items ?? []" :key="r.id" :class="stateClass(r.state)">
            <td>{{ r.documentLabel }}</td>
            <td class="tc">Rev{{ r.revAtDistribution }}</td>
            <td class="tc">{{ r.projectName ?? '-' }}</td>
            <td class="tc">{{ r.distributedAt.slice(0, 10) }}</td>
            <td class="tc">{{ DISTRIBUTION_STATE_LABEL[r.state] }}</td>
          </tr>
          <tr v-if="!forImport?.items.length"><td colspan="5" class="tc muted">해당 자료가 없습니다.</td></tr>
        </tbody>
      </table>
    </Modal>

    <!-- Zip 상세 현황 -->
    <Modal v-if="zipDetail" wide :title="`Zip 상세 현황 — ${zipDetail}`" @close="zipDetail = null">
      <p class="muted">
        {{ zipStatus?.vendorName }} · {{ zipStatus?.itemCount }}건 중
        <strong>{{ zipStatus?.returnedCount }}</strong>건 반입
      </p>
      <table class="grid">
        <thead><tr><th>자료명</th><th>반출Rev</th><th>반입일시</th><th>상태</th></tr></thead>
        <tbody>
          <tr v-for="r in zipStatus?.items ?? []" :key="r.id" :class="stateClass(r.state)">
            <td>{{ r.documentLabel }}</td>
            <td class="tc">Rev{{ r.revAtDistribution }}</td>
            <td class="tc">{{ r.returnedAt?.slice(0, 10) ?? '-' }}</td>
            <td class="tc">{{ DISTRIBUTION_STATE_LABEL[r.state] }}</td>
          </tr>
        </tbody>
      </table>
    </Modal>
  </main>
</template>

<script lang="ts">
import { defineComponent, h } from 'vue'
import JobProgress from '@/ui/JobProgress.vue'

/** 진행률은 작업이 있을 때만 자리를 차지한다 */
const JobProgressSlot = defineComponent({
  props: { jobId: { type: Number as () => number | null, default: null } },
  setup: (p) => () => (p.jobId === null ? null : h(JobProgress, { jobId: p.jobId })),
})
export default { components: { JobProgressSlot } }
</script>

<style scoped>
.dist { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.search { padding: 10px 12px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; }
.toggle { display: flex; gap: 2px; }
.toggle .btn.on { background: var(--accent); border-color: var(--accent); color: var(--primary-fg); }
.cnt {
  display: inline-block; min-width: 17px; padding: 0 4px; margin-left: 3px;
  background: var(--accent); color: var(--primary-fg); border-radius: 9px; font-size: 10px; text-align: center;
}
/* 스크롤은 DataTable 이 자기 안에서 맡는다 — 바깥에서 또 스크롤하면
   머리글 고정이 깨진다. 여기서는 자리만 내준다. */
.table-panel { flex: 1; min-height: 0; overflow: hidden; display: flex; }
.table-panel > * { flex: 1; min-width: 0; }
/* 자료명 칸의 보조 설명 — 줄 높이를 늘리지 않게 같은 줄에 잇는다 */
.sub-inline { margin-left: 6px; }
.grid tr.issue { background: var(--danger-soft); }
.sub { font-size: 11px; }
.summary { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; font-size: var(--fs-sm); }
.tag {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--bg); border: 1px solid var(--border-strong); margin-left: 3px;
}
/* .tag.warn-tag 는 base.css 가 맡는다 */
</style>
