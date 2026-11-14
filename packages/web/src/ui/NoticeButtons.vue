<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type {
  DistributionRow, OutstandingResult, RecentChangeItem,
  RecentChangesResponse, RecentChangesSummary,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import { api, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { DISTRIBUTION_STATE_LABEL } from '@/lib/labels'

/**
 * 상단 앱 바의 알림 버튼 두 개 — [TDB 수정] · [TDB 반출].
 *
 * 기존 화면(ui.js loadNoticeButtons)과 같은 자리·같은 규칙이다.
 *   · 건수가 0이면 평범하게, 1건이라도 있으면 색이 들어간다(.is-strong)
 *   · 두 버튼 너비를 같게 맞춘다 — 건수 자릿수가 달라도 흔들리지 않게
 *   · 누르면 목록 팝업이 뜬다 (화면을 옮기지 않는다)
 *
 * 반출 건수는 TDB 반출이력 화면 권한이 있어야 받을 수 있어서, 권한이 없으면
 * 기존처럼 버튼 자체를 내지 않는다.
 */

const router = useRouter()
const session = useSession()

// ── TDB 수정 (최근수정본) ───────────────────────────────────────────────
const RECENT_STRONG_DAYS = 30
const RECENT_SOFT_DAYS = 90

const recentOpen = ref(false)
const recentKind = ref<'ALL' | 'REVISION' | 'INFO'>('ALL')
const recentModified = ref<'ALL' | 'D30' | 'D31_90' | 'D91'>('ALL')

const { data: recentSummary } = useQuery({
  queryKey: ['documents', 'recent-changes', 'summary'],
  queryFn: () => api.get<RecentChangesSummary>('/documents/recent-changes/summary'),
  enabled: computed(() => session.isLoggedIn),
  staleTime: staleTime.list,
})

const { data: recent, isFetching: recentLoading } = useQuery({
  queryKey: ['documents', 'recent-changes', RECENT_SOFT_DAYS],
  queryFn: () => api.get<RecentChangesResponse>(`/documents/recent-changes${qs({ days: RECENT_SOFT_DAYS })}`),
  enabled: computed(() => recentOpen.value),
  staleTime: staleTime.list,
})

const recentRows = computed(() => {
  const now = Date.now()
  const strong = now - RECENT_STRONG_DAYS * 86_400_000
  const soft = now - RECENT_SOFT_DAYS * 86_400_000
  return (recent.value?.items ?? []).filter((r) => {
    if (recentKind.value !== 'ALL' && r.changeKind !== recentKind.value) return false
    const t = Date.parse(r.updatedAt)
    switch (recentModified.value) {
      case 'D30': return t >= strong
      case 'D31_90': return t >= soft && t < strong
      case 'D91': return t < soft
      default: return true
    }
  })
})

const changeText = (r: RecentChangeItem) =>
  (r.changeKind === 'REVISION' ? `Rev ${r.revFrom} → ${r.revTo}` : '일반 수정')

const RECENT_COLUMNS: Column<RecentChangeItem>[] = [
  { key: 'updatedAt', label: '수정일', width: '130px', align: 'center',
    render: (r) => r.updatedAt.slice(0, 16).replace('T', ' ') },
  { key: 'drawingNo', label: '자료명', width: '200px' },
  { key: 'category', label: '분류', width: '110px', render: (r) => r.category ?? '' },
  { key: 'path', label: '경로' },
  { key: 'currentRev', label: 'Rev', width: '56px', align: 'center', render: (r) => String(r.currentRev) },
  { key: 'projectName', label: '공사', width: '120px', render: (r) => r.projectName ?? '' },
  { key: 'vendorName', label: '업체', width: '110px', render: (r) => r.vendorName ?? '' },
  { key: 'changeKind', label: '수정 구분', width: '110px', align: 'center', render: changeText },
  { key: 'changedBy', label: '수정자', width: '90px', align: 'center', render: (r) => r.changedBy ?? '' },
]

function openRecentDetail(r: RecentChangeItem) {
  recentOpen.value = false
  void router.push(`/documents/${r.id}`)
}

// ── TDB 반출 (미입고 현황) ──────────────────────────────────────────────
const canSeeDist = computed(() => session.can('screen.tdb_distributions.access'))
const outstandingOpen = ref(false)

const { data: outstanding } = useQuery({
  queryKey: ['dist-outstanding'],
  queryFn: () => api.get<OutstandingResult>('/distributions/outstanding'),
  enabled: computed(() => session.isLoggedIn && canSeeDist.value),
  staleTime: staleTime.worklist,
})

const OUTSTANDING_COLUMNS: Column<DistributionRow>[] = [
  { key: 'documentLabel', label: '자료명', width: '200px' },
  { key: 'projectName', label: '공사', width: '130px', render: (r) => r.projectName ?? '' },
  { key: 'vendorName', label: '업체', width: '120px' },
  { key: 'revAtDistribution', label: '반출Rev', width: '72px', align: 'center',
    render: (r) => String(r.revAtDistribution) },
  { key: 'distributedAt', label: '반출일시', width: '130px', align: 'center',
    render: (r) => r.distributedAt.slice(0, 16).replace('T', ' ') },
  { key: 'returnedAt', label: '반입일시', width: '130px', align: 'center',
    render: (r) => (r.returnedAt ? r.returnedAt.slice(0, 16).replace('T', ' ') : '') },
  { key: 'state', label: '상태', width: '100px', align: 'center',
    render: (r) => DISTRIBUTION_STATE_LABEL[r.state] ?? r.state },
  { key: 'distributedBy', label: '반출자', width: '100px', align: 'center',
    render: (r) => r.distributedBy ?? '' },
]
</script>

<template>
  <span class="notice-btns">
    <button
      type="button" class="notice-btn"
      :class="{ 'is-strong': (recentSummary?.count ?? 0) > 0 }"
      title="최근 90일 이내 수정된 자료"
      @click="recentOpen = true"
    >TDB 수정 ({{ recentSummary?.count ?? 0 }})</button>

    <button
      v-if="canSeeDist" type="button" class="notice-btn"
      :class="{ 'is-strong': (outstanding?.summary.total ?? 0) > 0 }"
      title="아직 안 돌아왔거나 돌아왔지만 검수 전인 반출 건"
      @click="outstandingOpen = true"
    >TDB 반출 ({{ outstanding?.summary.total ?? 0 }})</button>
  </span>

  <!-- TDB 최근수정 현황 -->
  <Modal v-if="recentOpen" wide notice title="TDB 최근수정 현황" @close="recentOpen = false">
    <div class="notice-filters">
      <div class="field">
        <label for="recent-kind">수정 구분</label>
        <select id="recent-kind" v-model="recentKind">
          <option value="ALL">전체</option>
          <option value="REVISION">Revision 수정</option>
          <option value="INFO">일반 수정</option>
        </select>
      </div>
      <div class="field">
        <label for="recent-modified">수정일</label>
        <select id="recent-modified" v-model="recentModified">
          <option value="ALL">전체</option>
          <option value="D30">오늘~30일</option>
          <option value="D31_90">31일~90일</option>
          <option value="D91">91일 이전</option>
        </select>
      </div>
      <span class="notice-summary">
        <template v-if="recent">
          최근 {{ recent.days }}일 이내 수정 <b>{{ recent.total }}건</b>
          = Revision 수정 <b>{{ recent.revisionCount }}건</b>
          + 일반 수정 <b>{{ recent.total - recent.revisionCount }}건</b>
        </template>
        <template v-else-if="recentLoading">불러오는 중…</template>
      </span>
    </div>
    <div class="notice-grid">
      <DataTable
        :columns="RECENT_COLUMNS" :rows="recentRows" :total="recentRows.length"
        :loading="recentLoading && !recent"
        :row-class="(r) => (r.changeKind === 'REVISION' ? 'cur' : '')"
        storage-key="tdb-recent-changes" excel-name="최근수정본"
        empty-text="최근 수정된 자료가 없습니다."
        @row-click="openRecentDetail"
      />
    </div>
  </Modal>

  <!-- 미입고 현황 -->
  <Modal v-if="outstandingOpen" wide notice title="TDB 반출 현황 (미입고)" @close="outstandingOpen = false">
    <div class="notice-filters">
      <span class="notice-summary">
        전체 <b>{{ outstanding?.summary.total ?? 0 }}건</b>
        = 미반납 <b>{{ outstanding?.summary.notReturned ?? 0 }}건</b>
        + 검수대기 <b>{{ outstanding?.summary.reviewing ?? 0 }}건</b>
        <template v-if="outstanding?.summary.oldestDays !== null && outstanding?.summary.oldestDays !== undefined">
          · 최장 <b>{{ outstanding.summary.oldestDays }}일</b>
        </template>
      </span>
    </div>
    <div class="notice-grid">
      <DataTable
        :columns="OUTSTANDING_COLUMNS" :rows="outstanding?.items ?? []"
        :total="outstanding?.items.length ?? 0"
        storage-key="dist-outstanding" excel-name="TDB 반출이력_미입고 현황"
        empty-text="미입고 건이 없습니다."
      />
    </div>
  </Modal>
</template>

<style scoped>
/* 팝업 안 표 위의 조건 줄 — 필터 바와 같은 모양으로 맞춘다 */
.notice-filters {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 0 0 9px;
}
.notice-filters .field > label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-dark-gray);
  margin-top: 0;
}
.notice-filters .field > select { width: var(--field-w, 128px); margin-top: 0; }

.notice-summary {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  padding-bottom: 7px;
}
.notice-summary b { color: var(--text); font-weight: 700; }

.notice-grid { height: 56vh; min-height: 280px; display: flex; }
.notice-grid > * { flex: 1; min-width: 0; }
</style>
