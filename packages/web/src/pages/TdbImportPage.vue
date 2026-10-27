<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  DuplicateDistributionResponse, ImportIssue, ImportIssueResponse,
  PendingReviewGroup, PendingReviewResponse,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Tabs from '@/ui/Tabs.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

/** TDB 반입·검수 — 기존 import.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

const tab = ref<'register' | 'review' | 'issues'>('review')
const TABS = [
  { key: 'register', label: '반입등록' },
  { key: 'review', label: '검수 대기' },
  { key: 'issues', label: '확인 필요' },
]

const canApprove = computed(() => session.can('screen.tdb_import.review.approve'))
const canReject = computed(() => session.can('screen.tdb_import.review.reject'))
const canRegister = computed(() => session.can('screen.tdb_import.register'))

// ── 검수 대기 ─────────────────────────────────────────────────────────
const keyword = ref('')
const pendingKey = computed(() => ['pending-review', keyword.value])

const { data: pending, isFetching } = useQuery({
  queryKey: pendingKey,
  queryFn: () =>
    api.get<PendingReviewResponse>(`/revisions/pending-review${qs({ q: keyword.value || undefined })}`),
  staleTime: staleTime.worklist,   // 업무 대기열은 항상 최신
})

const groups = computed(() => pending.value?.items ?? [])
const selected = ref(new Set<number>())
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

function toggle(g: PendingReviewGroup) {
  const id = g.files[0]!.id
  selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id)
  selected.value = new Set(selected.value)
}

const reviewMutation = useMutation({
  mutationFn: (v: { action: 'APPROVE' | 'REJECT'; note: string | null }) =>
    api.post<{ done: number; failed: { fileId: number; message: string }[] }>(
      '/revisions/review-bulk', { fileIds: [...selected.value], ...v },
    ),
  onSuccess: (r) => {
    selected.value = new Set()
    message.value = r.failed.length
      ? { kind: 'err', text: `${r.done}건 처리, ${r.failed.length}건 실패 — ${r.failed[0]!.message}` }
      : { kind: 'ok', text: `${r.done}건 처리했습니다.` }
    void qc.invalidateQueries({ queryKey: ['pending-review'] })
    void qc.invalidateQueries({ queryKey: ['documents'] })
  },
  onError: (e) => {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '처리하지 못했습니다.' }
  },
})

const rejectOpen = ref(false)
const rejectNote = ref('')

function approve() {
  if (!selected.value.size) return
  reviewMutation.mutate({ action: 'APPROVE', note: null })
}
function confirmReject() {
  rejectOpen.value = false
  reviewMutation.mutate({ action: 'REJECT', note: rejectNote.value || null })
  rejectNote.value = ''
}

// ── 중복반출 현황 ─────────────────────────────────────────────────────
const dupDocId = ref<number | null>(null)
const { data: dup } = useQuery({
  queryKey: computed(() => ['duplicate-distributions', dupDocId.value]),
  queryFn: () => api.get<DuplicateDistributionResponse>(`/documents/${dupDocId.value}/duplicate-distributions`),
  enabled: computed(() => dupDocId.value !== null),
})

// ── 병합본 첨부 후 승인 ───────────────────────────────────────────────
const mergeDocId = ref<number | null>(null)
const mergeFiles = ref<FileList | null>(null)

async function submitMerge() {
  if (mergeDocId.value === null || !mergeFiles.value?.length) return
  const fd = new FormData()
  for (const f of mergeFiles.value) fd.append('file', f)
  try {
    const r = await fetch(`/api/documents/${mergeDocId.value}/branch-merge`, { method: 'POST', body: fd })
    const body = await r.json()
    message.value = r.ok
      ? { kind: 'ok', text: `통합본을 ${body.revLabel} 로 승인했습니다. 분기 ${body.closedBranches}건을 닫았습니다.` }
      : { kind: 'err', text: body.message ?? '승인하지 못했습니다.' }
  } finally {
    mergeDocId.value = null
    mergeFiles.value = null
    void qc.invalidateQueries({ queryKey: ['pending-review'] })
  }
}

// ── 확인 필요 ─────────────────────────────────────────────────────────
const { data: issues } = useQuery({
  queryKey: ['import-issues'],
  queryFn: () => api.get<ImportIssueResponse>('/import-issues'),
  enabled: computed(() => tab.value === 'issues'),
  staleTime: staleTime.worklist,
})

async function issueAction(issue: ImportIssue, action: 'recheck' | 'discard') {
  try {
    const r = await api.post<{ message?: string }>(`/import-issues/${issue.id}/${action}`,
      action === 'discard' ? { note: null } : undefined)
    message.value = { kind: 'ok', text: r.message ?? '처리했습니다.' }
  } catch (e) {
    message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '처리하지 못했습니다.' }
  }
  void qc.invalidateQueries({ queryKey: ['import-issues'] })
}

// ── 반입등록 ──────────────────────────────────────────────────────────
const zipJobId = ref<number | null>(null)

async function uploadZip(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/imports/zip', { method: 'POST', body: fd })
  const body = await r.json()
  if (r.status === 202) {
    zipJobId.value = body.jobId
    message.value = { kind: 'ok', text: '압축을 푸는 중입니다. 진행률을 확인하세요.' }
  } else {
    message.value = { kind: 'err', text: body.message ?? '올리지 못했습니다.' }
  }
  input.value = ''
}

// ── 표 칸 ──────────────────────────────────────────────────────────────
// render 는 **글자값**이다 — 거르기·엑셀이 이것을 쓴다. 슬롯은 그리는 법만 바꾼다.

/**
 * 검수 대기는 자료+Rev 로 묶인 덩어리라 그 자체에는 id 가 없다.
 * 고를 때 이미 첫 파일의 id 를 열쇠로 쓰고 있으므로(toggle) 같은 것을 쓴다 —
 * 그리드의 줄 열쇠와 선택 열쇠가 어긋나면 엉뚱한 줄이 선택된 것처럼 보인다.
 */
type PendingRow = PendingReviewGroup & { id: number }
const pendingRows = computed<PendingRow[]>(() =>
  groups.value.map((g) => ({ ...g, id: g.files[0]!.id })),
)

const PENDING_COLUMNS: Column<PendingRow>[] = [
  { key: 'drawingNo', label: '반입자료', width: '220px',
    render: (g) => (g.title ? `${g.drawingNo} ${g.title}` : g.drawingNo) },
  { key: 'folderName', label: '분류', width: '140px' },
  { key: 'revLabel', label: '반입Rev', width: '86px', align: 'center' },
  { key: 'distributedRev', label: '반출Rev', width: '86px', align: 'center',
    render: (g) => (g.distributedRev !== null ? `Rev${g.distributedRev}` : '') },
  { key: 'vendorName', label: '업체', width: '130px', render: (g) => g.vendorName ?? '' },
  { key: 'projectName', label: '공사', width: '120px', align: 'center', render: (g) => g.projectName ?? '' },
  { key: 'files', label: '파일', width: '170px',
    render: (g) => g.files.map((f) => `${f.fileExt.toUpperCase()} ${size(f.byteSize)}`).join(', ') },
  { key: 'uploadedAt', label: '업로드 일시', width: '130px', align: 'center',
    render: (g) => g.uploadedAt.slice(0, 16).replace('T', ' ') },
  // 엑셀에도 "중복반출"·"Rev 불일치"가 나가야 화면과 같은 뜻이 된다
  { key: 'state', label: '상태', width: '190px', filterable: false,
    render: (g) => [g.isBranch ? '중복반출' : '', g.hasWarning ? 'Rev 불일치' : ''].filter(Boolean).join(' ') },
]

const ISSUE_COLUMNS: Column<ImportIssue>[] = [
  { key: 'filename', label: '파일', width: '240px' },
  { key: 'byteSize', label: '크기', width: '90px', align: 'right',
    render: (i) => (i.byteSize !== null ? size(i.byteSize) : '') },
  { key: 'reason', label: '사유', width: '240px',
    render: (i) => (i.reasonDetail ? `${i.reason} — ${i.reasonDetail}` : i.reason) },
  { key: 'suggestedDrawingNo', label: '짐작한 자료', width: '160px', align: 'center',
    render: (i) => i.suggestedDrawingNo ?? '' },
  { key: 'vendorName', label: '업체', width: '130px', align: 'center', render: (i) => i.vendorName ?? '' },
  { key: 'createdAt', label: '등록일시', width: '110px', align: 'center', render: (i) => i.createdAt.slice(0, 10) },
  { key: 'act', label: '조치', width: '140px', align: 'center', sortable: false, filterable: false, render: () => '' },
]

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`
}
</script>

<template>
  <main class="app-main import">
    <div class="panel head">
      <h1>TDB 신규 자료 등록 및 검토·승인</h1>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}
      <span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel body">
      <Tabs v-model="tab" :tabs="TABS" />

      <!-- 반입등록 -->
      <section v-if="tab === 'register'" class="pad">
        <h2>반입등록 (Zip 파일)</h2>
        <p class="muted">
          업체가 보낸 Zip 을 그대로 올리면 압축을 풀어 자료별로 나눕니다.
          이름이 맞지 않는 것은 <strong>확인 필요</strong>로 넘어갑니다.
        </p>
        <input type="file" accept=".zip" :disabled="!canRegister" @change="uploadZip" />
        <JobProgress :job-id="zipJobId" @done="() => qc.invalidateQueries({ queryKey: ['import-issues'] })" />

        <h2>반입등록 (개별 자료)</h2>
        <p class="muted">
          자료를 먼저 찾은 뒤 그 자료의 상세 화면에서 올립니다.
          업체·공사를 지정하면 리비전과 분기가 자동으로 정해집니다.
        </p>
        <RouterLink to="/" class="btn btn-sm">자료 검색으로</RouterLink>
      </section>

      <!-- 검수 대기 -->
      <section v-else-if="tab === 'review'" class="pad grid-tab">
        <div class="bar">
          <input v-model="keyword" type="text" placeholder="반입·검수대기 자료명" style="width:220px" />
          <!-- 선택 건수는 그리드 아래쪽이 적는다. 두 군데 적으면 서로 어긋난다. -->
          <span style="flex:1" />
          <button class="btn btn-sm" :disabled="!selected.size || !canApprove || reviewMutation.isPending.value"
                  @click="approve">선택 승인</button>
          <button class="btn btn-sm" :disabled="!selected.size || !canReject || reviewMutation.isPending.value"
                  @click="rejectOpen = true">선택 반려</button>
        </div>

        <DataTable
          :columns="PENDING_COLUMNS" :rows="pendingRows" selectable :selected="selected"
          :total="pendingRows.length" :loading="isFetching && !pendingRows.length"
          :row-class="(g) => (g.hasWarning || g.isBranch ? 'warn' : '')"
          storage-key="import-pending" excel-name="TDB 검수대기"
          empty-text="검수 대기 중인 자료가 없습니다."
          @toggle="(id) => toggle(pendingRows.find(g => g.id === id)!)"
          @toggle-all="(on) => { selected = on ? new Set(pendingRows.map(g => g.id)) : new Set() }"
        >
          <template #cell:drawingNo="{ row }">
            <span>{{ row.drawingNo }}</span>
            <span v-if="row.title" class="muted small sub-inline">{{ row.title }}</span>
          </template>

          <template #cell:files="{ row }">
            <span v-for="f in row.files" :key="f.id" class="chip" :title="f.originalFilename">
              {{ f.fileExt.toUpperCase() }} {{ size(f.byteSize) }}
            </span>
          </template>

          <template #cell:state="{ row }">
            <span v-if="row.isBranch" class="tag">중복반출</span>
            <span v-if="row.hasWarning" class="tag warn-tag"
                  title="업체가 적은 Rev 표기와 다릅니다">Rev 불일치</span>
            <button v-if="row.isBranch" class="btn btn-sm" @click.stop="dupDocId = row.documentId">현황</button>
            <button v-if="row.isBranch && canApprove" class="btn btn-sm"
                    @click.stop="mergeDocId = row.documentId">병합본</button>
          </template>
        </DataTable>
      </section>

      <!-- 확인 필요 -->
      <section v-else class="pad grid-tab">
        <p class="muted">
          어느 자료에 붙일지 정하지 못한 반입 파일입니다. 파일은 저장돼 있으니 사라지지 않습니다.
        </p>
        <DataTable
          :columns="ISSUE_COLUMNS" :rows="issues?.items ?? []" :total="issues?.items.length ?? 0"
          :row-class="() => 'warn'"
          storage-key="import-issues" excel-name="TDB 확인필요"
          empty-text="확인이 필요한 자료가 없습니다."
        >
          <template #cell:reason="{ row }">
            <span>{{ row.reason }}</span>
            <span v-if="row.reasonDetail" class="muted small sub-inline">{{ row.reasonDetail }}</span>
          </template>

          <template #cell:act="{ row }">
            <button class="btn btn-sm" :disabled="!session.can('screen.tdb_import.issue.recheck')"
                    @click.stop="issueAction(row, 'recheck')">재검수</button>
            <button class="btn btn-sm" :disabled="!session.can('screen.tdb_import.issue.reject')"
                    @click.stop="issueAction(row, 'discard')">반려</button>
          </template>
        </DataTable>
      </section>
    </div>

    <!-- 반려 사유 -->
    <Modal v-if="rejectOpen" title="선택 반려" @close="rejectOpen = false">
      <p class="muted">반려 사유를 적어 주세요. 업체에 전달할 내용입니다.</p>
      <textarea v-model="rejectNote" rows="4" style="width:100%" placeholder="예: 치수 누락, 도면번호 불일치" />
      <template #footer>
        <button class="btn" @click="rejectOpen = false">취소</button>
        <button class="btn btn-primary" @click="confirmReject">반려</button>
      </template>
    </Modal>

    <!-- 중복반출 현황 -->
    <Modal v-if="dupDocId !== null" title="중복반출 현황" @close="dupDocId = null">
      <p class="muted">
        {{ dup?.drawingNo }} — 서로 다른 업체 <strong>{{ dup?.vendorCount ?? 0 }}</strong>곳이 수정 중입니다.
        전부 반입된 뒤에야 분기본을 승인할 수 있습니다.
      </p>
      <table class="grid">
        <thead><tr><th>업체</th><th>공사</th><th>반출Rev</th><th>반출일시</th><th>반입</th><th>분기</th></tr></thead>
        <tbody>
          <tr v-for="d in dup?.items ?? []" :key="d.distributionId" :class="{ warn: !d.arrived }">
            <td>{{ d.vendorName }}</td>
            <td class="tc">{{ d.projectName ?? '-' }}</td>
            <td class="tc">Rev{{ d.revAtDistribution }}</td>
            <td class="tc">{{ d.distributedAt.slice(0, 10) }}</td>
            <td class="tc">{{ d.arrived ? '완료' : '미반입' }}</td>
            <td class="tc">{{ d.branch ?? '-' }}</td>
          </tr>
        </tbody>
      </table>
    </Modal>

    <!-- 병합본 첨부 -->
    <Modal v-if="mergeDocId !== null" title="병합본 첨부 후 승인" @close="mergeDocId = null">
      <p class="muted">
        <strong>시스템은 도면을 합쳐 주지 않습니다.</strong>
        CAD 에서 직접 통합한 파일을 올리면 분기 없는 정식 Rev 로 승인하고,
        열려 있던 분기본은 "통합됨" 으로 닫습니다.
      </p>
      <input type="file" multiple @change="(e) => (mergeFiles = (e.target as HTMLInputElement).files)" />
      <template #footer>
        <button class="btn" @click="mergeDocId = null">취소</button>
        <button class="btn btn-primary" :disabled="!mergeFiles?.length" @click="submitMerge">승인</button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
.import { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.body > section { flex: 1; overflow: auto; min-height: 0; }
.pad { padding: 14px; }

/* 그리드를 쓰는 두 절은 스크롤을 그리드에 맡긴다 — 바깥이 한 번 더 스크롤되면
   머리글 고정이 깨진다. 여기서는 자리만 내준다. */
.body > section.grid-tab {
  display: flex; flex-direction: column; gap: var(--sp-2);
  min-height: 0; flex: 1; overflow: hidden;
}
.grid-tab > :deep(.dt) { flex: 1; min-height: 0; }
/* 반입자료·사유 칸의 보조 설명 — 줄 높이를 늘리지 않게 같은 줄에 잇는다 */
.sub-inline { margin-left: 6px; }
h2 { font-size: var(--fs-base); margin: 18px 0 6px; }
h2:first-child { margin-top: 0; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; margin-bottom: 10px; }
.sub { font-size: 11px; }
.chip {
  display: inline-block; font-size: 11px; padding: 1px 6px; margin-right: 3px;
  border: 1px solid var(--border-strong); border-radius: 9px;
}
.tag {
  display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 8px;
  background: var(--accent); color: var(--primary-fg); margin-right: 3px;
}
.tag.warn-tag { background: var(--warn); }
</style>
