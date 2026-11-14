<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  DistributionListResult, DistributionRow, FilterOptions,
  ForImportResult, OutstandingResult, ZipExportListResult, ZipExportRow, ZipReturnResult,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import ZipStatusModal from '@/ui/ZipStatusModal.vue'
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

async function doReturn(manual: boolean, ids: number[] = [...picked.value]) {
  if (!ids.length) return
  try {
    const r = await api.post<{ returned: number; skipped: { reason: string }[] }>(
      '/distributions/return', { distributionIds: ids, manual, note: null })
    say(r.skipped.length ? 'err' : 'ok',
      r.skipped.length
        ? `${r.returned}건 처리, ${r.skipped.length}건 건너뜀 — ${r.skipped[0]!.reason}`
        : `${r.returned}건을 반납 처리했습니다.`)
    picked.value = new Set()
    refresh()
  } catch (e) { fail(e) }
}

/** 줄 하나만 — 기존 화면 '확인' 칸의 [수정없이 반납처리] */
const returnOne = (row: DistributionRow) => doReturn(true, [row.id])

// ── Zip별: 수정없이 반납처리 (Zip 단위) ───────────────────────────────
// 기존 distributions.js returnZip. Zip 안에 이미 반입된 자료가 섞여 있으면 서버가 그 Zip 을
// 건너뛰고 사유를 돌려준다. 체크한 여러 Zip 을 한 번에 처리할 수도 있다.
const zipPicked = ref(new Set<number>())
function toggleZip(id: number) {
  const next = new Set(zipPicked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  zipPicked.value = next
}
const pickedZipNames = computed(() =>
  zipRows.value.filter((z) => zipPicked.value.has(z.id) && !z.complete).map((z) => z.zipName))

// Zip 목록의 줄 id 는 목록 안 위치라 조건이 바뀌면 다른 Zip 을 가리킨다 — 체크를 푼다
watch(params, () => (zipPicked.value = new Set()))

const zipReturnTarget = ref<string[] | null>(null)

async function doZipReturn() {
  const names = zipReturnTarget.value
  if (!names?.length) return
  zipReturnTarget.value = null
  try {
    const r = await api.post<ZipReturnResult>('/distributions/zip-return', { zipNames: names })
    say(r.skipped.length ? 'err' : 'ok',
      r.skipped.length
        ? `${r.returned}건 처리, Zip ${r.skipped.length}개 건너뜀 — ${r.skipped[0]!.zipName}: ${r.skipped[0]!.reason}`
        : `${r.returned}건을 수정 없이 반납 처리했습니다.`)
    zipPicked.value = new Set()
    refresh()
  } catch (e) { fail(e) }
}

/** Zip 다시 받기 — 워커가 다 만든 것만 받을 수 있다 */
const zipHref = (zipName: string) => `/api/distributions/zip-file${qs({ zipName })}`

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
// 팝업은 시스템 로그와 공용이다 (ui/ZipStatusModal.vue).
const zipDetail = ref<string | null>(null)

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
  { key: 'documentLabel', label: '자료명', width: '210px',
    render: (r) => (r.title ? `${r.documentLabel} ${r.title}` : r.documentLabel) },
  { key: 'projectName', label: '공사', width: '110px', align: 'center', render: (r) => r.projectName ?? '\u00b7' },
  { key: 'vendorName', label: '업체', width: '110px', align: 'center' },
  { key: 'purpose', label: '목적', width: '88px', align: 'center',
    render: (r) => PURPOSE_LABEL[r.purpose] ?? r.purpose },
  { key: 'revAtDistribution', label: '반출Rev', width: '70px', align: 'center',
    render: (r) => String(r.revAtDistribution) },
  { key: 'distributedAt', label: '반출일시', width: '130px', align: 'center', render: (r) => day(r.distributedAt) },
  { key: 'returnedAt', label: '반입일시', width: '130px', align: 'center',
    render: (r) => (r.returnedAt ? day(r.returnedAt) : '\u00b7') },
  { key: 'state', label: '상태', width: '120px', align: 'center',
    // 엑셀에도 "수정없음"·"21일"이 함께 나가야 화면과 같은 뜻이 된다
    render: (r) => [
      DISTRIBUTION_STATE_LABEL[r.state],
      r.manualReturn ? '수정없음' : '',
      r.daysOut !== null && r.daysOut >= 14 ? `${r.daysOut}일` : '',
    ].filter(Boolean).join(' ') },
  // 기존 화면의 '확인' 칸 — 반입미완료 건만 [수정없이 반납처리] 가 뜬다
  { key: 'confirm', label: '확인', width: '150px', align: 'center',
    sortable: false, filterable: false, exportable: false, render: () => '' },
  { key: 'distributedBy', label: '반출자', width: '100px', align: 'center', render: (r) => r.distributedBy ?? '\u00b7' },
  { key: 'note', label: '비고', width: '180px', render: (r) => r.note ?? '' },
]

/** 미입고 현황 창 — 오래 나가 있는 순 */
const OUTSTANDING_COLUMNS: Column<DistributionRow>[] = [
  { key: 'documentLabel', label: '자료명', width: '220px' },
  { key: 'revAtDistribution', label: '반출Rev', width: '76px', align: 'center',
    render: (r) => `Rev${r.revAtDistribution}` },
  { key: 'vendorName', label: '업체', width: '140px' },
  { key: 'projectName', label: '공사', width: '120px', render: (r) => r.projectName ?? '' },
  { key: 'distributedAt', label: '반출일시', width: '104px', align: 'center', render: (r) => day(r.distributedAt) },
  { key: 'daysOut', label: '나간 일수', width: '84px', align: 'right',
    render: (r) => (r.daysOut === null ? '' : String(r.daysOut)) },
  { key: 'state', label: '상태', width: '100px', align: 'center',
    render: (r) => DISTRIBUTION_STATE_LABEL[r.state] ?? r.state },
]

/** 반입 대상 창 */
const FOR_IMPORT_COLUMNS: Column<DistributionRow>[] = [
  { key: 'documentLabel', label: '자료명', width: '220px' },
  { key: 'revAtDistribution', label: '반출Rev', width: '76px', align: 'center',
    render: (r) => `Rev${r.revAtDistribution}` },
  { key: 'vendorName', label: '업체', width: '140px' },
  { key: 'projectName', label: '공사', width: '120px', render: (r) => r.projectName ?? '' },
  { key: 'distributedAt', label: '반출일시', width: '104px', align: 'center', render: (r) => day(r.distributedAt) },
  { key: 'state', label: '상태', width: '100px', align: 'center',
    render: (r) => DISTRIBUTION_STATE_LABEL[r.state] ?? r.state },
]

/** Zip 상세 현황 창 */
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
  { key: 'act', label: '조치', width: '268px', align: 'center', sortable: false, filterable: false,
    exportable: false, render: () => '' },
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
    <div class="page-head">
      <div>
        <h1 class="page-title">
          TDB 반출이력<span class="page-title-sub">TDB 자료 다운로드 및 반출 기록 관리</span>
        </h1>
      </div>
      <div class="page-actions">
        <button type="button" @click="outstandingOpen = true">
          미입고 현황 <span class="tree-count">({{ outstanding?.summary.total ?? 0 }})</span>
        </button>
        <button type="button" @click="forImportOpen = true">반입 대상</button>
      </div>
    </div>

    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div class="field">
            <label for="export-kind">반출형태</label>
            <select id="export-kind" :value="byZip ? 'ZIP' : 'FILE'"
                    @change="byZip = ($event.target as HTMLSelectElement).value === 'ZIP'">
              <option value="FILE">자료</option>
              <option value="ZIP">Zip</option>
            </select>
          </div>
          <div class="field">
            <label for="project">공사</label>
            <select id="project" v-model="f.projectId">
              <option value="">전체</option>
              <option v-for="p in opts?.projects ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
          <div class="field">
            <label for="vendor">업체</label>
            <select id="vendor" v-model="f.vendorId">
              <option value="">전체</option>
              <option v-for="v in opts?.vendors ?? []" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </div>
          <div class="field">
            <label for="from">기간</label>
            <input id="from" v-model="f.dateFrom" type="date" title="반출 시작일" />
          </div>
          <div class="field">
            <label for="to">~</label>
            <input id="to" v-model="f.dateTo" type="date" title="반출 종료일" />
          </div>
          <div class="field">
            <label for="purpose">반출목적</label>
            <select id="purpose" v-model="f.purpose">
              <option value="">전체</option>
              <option value="MODIFY">수정용</option>
              <option value="REFERENCE">참조용</option>
              <option value="ETC">기타</option>
            </select>
          </div>
          <div class="field">
            <label for="status">반출상태</label>
            <select id="status" v-model="f.state">
              <option value="">전체</option>
              <option value="REVIEWING">검수대기</option>
              <option value="ISSUE">확인필요</option>
              <option value="DONE">반입완료</option>
              <option value="INCOMPLETE">반입미완료</option>
            </select>
          </div>
          <div class="field">
            <label for="dist-by">반출자</label>
            <select id="dist-by" v-model="f.distributedBy"
                    :title="opts?.canSelectOtherUser ? '반출자' : '다른 사용자를 고를 권한이 없습니다'">
              <option value="">전체</option>
              <option v-for="u in opts?.distributors ?? []" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </div>
          <input v-model="f.q" type="text" class="filter-search" placeholder="자료명 검색" />
        </div>
        <div class="filter-actions">
          <button type="button" @click="reset">조건 초기화</button>
        </div>
      </div>
    </div>

    <div class="status-bar">
      <span class="status-bar-left">
        <span class="total-count">전체 {{ (list?.total ?? 0).toLocaleString() }}건</span>
        <span v-if="isFetching" class="muted">&nbsp;· 조회 중…</span>
      </span>
      <span class="cart-status">
        <template v-if="!byZip">
          <button class="cart-btn" type="button" :disabled="!openPicked" @click="doReturn(false)">선택 반납처리</button>
          <button class="cart-btn" type="button" :disabled="!openPicked || !canManualReturn"
                  :title="canManualReturn ? '' : '권한이 없습니다'"
                  @click="doReturn(true)">수정없이 반납처리</button>
        </template>
        <button v-else class="cart-btn" type="button" :disabled="!pickedZipNames.length || !canManualReturn"
                :title="canManualReturn ? '체크한 Zip 의 수정용 자료를 모두 수정 없이 반납 처리합니다' : '권한이 없습니다'"
                @click="zipReturnTarget = pickedZipNames">
          Zip 수정없이 반납{{ pickedZipNames.length ? ` (${pickedZipNames.length})` : '' }}
        </button>
        <button class="cart-btn" type="button"
                title="조건에 맞는 전체를 워커가 만든다 — 수만 건도 받을 수 있다"
                @click="exportExcel">엑셀 내보내기</button>
      </span>
    </div>

    <JobProgressSlot :job-id="exportJobId" />

    <div v-if="message" class="msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="small" @click="message = null">닫기</button>
    </div>

    <div class="table-box">
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

        <template #cell:confirm="{ row }">
          <button
            v-if="row.state === 'INCOMPLETE'" class="small"
            :disabled="!canManualReturn" :title="canManualReturn ? '' : '권한이 없습니다'"
            @click.stop="returnOne(row)"
          >수정없이 반납처리</button>
        </template>

        <template #cell:note="{ row }">
          <span v-if="!canNote">{{ row.note ?? '\u00b7' }}</span>
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
        selectable :selected="zipPicked"
        :row-class="(z) => (z.complete ? '' : 'warn')"
        storage-key="dist-zips" excel-name="TDB 반출이력 (Zip별)"
        empty-text="Zip 반출 기록이 없습니다."
        @row-click="(z) => (zipDetail = z.zipName)"
        @toggle="toggleZip"
        @toggle-all="(on) => { zipPicked = on ? new Set(zipRows.map((z) => z.id)) : new Set() }"
      >
        <template #cell:act="{ row }">
          <button class="btn btn-sm" @click.stop="zipDetail = row.zipName">상세 현황</button>
          <a v-if="row.hasFile" class="btn btn-sm" :href="zipHref(row.zipName)" @click.stop>Zip 다운</a>
          <button v-else class="btn btn-sm" disabled
                  title="Zip 파일이 아직 만들어지지 않았습니다 (만드는 중이거나 실패)">Zip 다운</button>
          <button class="btn btn-sm" :disabled="row.complete || !canManualReturn"
                  :title="!canManualReturn ? '권한이 없습니다' : row.complete ? '모두 반입되었습니다' : '이 Zip 의 수정용 자료를 모두 수정 없이 반납 처리합니다'"
                  @click.stop="zipReturnTarget = [row.zipName]">수정없이 반납</button>
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
      <div class="modal-grid">
        <DataTable
          :columns="OUTSTANDING_COLUMNS" :rows="outstanding?.items ?? []"
          :total="outstanding?.items.length ?? 0"
          :row-class="(r) => stateClass(r.state)"
          storage-key="dist-outstanding" excel-name="TDB 반출이력_미입고 현황"
          empty-text="미입고 건이 없습니다."
        />
      </div>
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
      <div class="modal-grid">
        <DataTable
          :columns="FOR_IMPORT_COLUMNS" :rows="forImport?.items ?? []"
          :total="forImport?.items.length ?? 0"
          :row-class="(r) => stateClass(r.state)"
          storage-key="dist-for-import" excel-name="TDB 반출이력_반입 대상"
          empty-text="해당 자료가 없습니다."
        />
      </div>
    </Modal>

    <!-- Zip 상세 현황 (시스템 로그와 공용 팝업) -->
    <ZipStatusModal v-if="zipDetail" :zip-name="zipDetail" @close="zipDetail = null" />

    <!-- Zip 수정없이 반납처리 확인 -->
    <Modal v-if="zipReturnTarget" title="수정없이 반납처리" @close="zipReturnTarget = null">
      <p>
        <template v-if="zipReturnTarget.length === 1">이 Zip(<strong>{{ zipReturnTarget[0] }}</strong>)</template>
        <template v-else>체크한 Zip {{ zipReturnTarget.length }}개</template>
        에 담긴 수정용 자료를 모두 '수정 없이 반입 처리' 하시겠습니까?
      </p>
      <p class="muted">업체가 수정 없이 그대로 돌려준 경우에만 쓰세요. 이미 반입된 자료가 섞인 Zip 은 건너뜁니다.</p>
      <template #footer>
        <button class="btn" @click="zipReturnTarget = null">취소</button>
        <button class="btn btn-primary" @click="doZipReturn">반납 처리</button>
      </template>
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
.dist { min-height: 0; }

/* 결과 표 — 스크롤은 DataTable 이 자기 안에서 맡는다. 여기서는 자리만 내준다. */
.table-box {
  flex: 1 1 auto; min-height: 240px; display: flex;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); overflow: hidden;
}
.table-box > * { flex: 1; min-width: 0; }

/* 자료명 칸의 보조 설명 — 줄 높이를 늘리지 않게 같은 줄에 잇는다 */
.sub-inline { margin-left: 6px; }

/* 창 안의 그리드 — 스크롤은 DataTable 이 맡으므로 높이만 내준다 */
.modal-grid { height: 55vh; min-height: 260px; display: flex; }
.modal-grid > * { flex: 1; min-width: 0; }
.sub { font-size: 11px; }
.summary { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; font-size: 12px; }
.tree-count { color: var(--text-faint); font-size: 11px; font-weight: 400; }
.tag { margin-left: 3px; }
</style>
