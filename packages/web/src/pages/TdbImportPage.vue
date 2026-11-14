<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
// 계약에서는 타입만 가져온다 — 값을 가져오면 Zod 전체가 이 화면 청크로 끌려온다(lib/labels.ts)
import type {
  DuplicateDistributionResponse, FolderNode, ImportIssue, ImportIssueResponse,
  ImportOptions, ImportTarget, ImportTargetResponse, JobDetail,
  PendingReviewGroup, PendingReviewResponse, ReattachIssueResult,
  RecheckIssueResult, RegisterNewResult, ResolveIssueResult,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import LazyTree from '@/ui/LazyTree.vue'
import PdfViewer from '@/ui/PdfViewer.vue'
import { api, ApiError, qs } from '@/lib/api'
import { IMPORT_REASON_LABEL } from '@/lib/labels'
import { staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

/** TDB 반입·검수 — 기존 import.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

/**
 * 화면 위쪽 거르개 — 기존 화면(import.html)의 필터 바 그대로다.
 * 구분·공사·업체·기간·자료명 여섯 가지이고, 공사·업체 후보는 두 목록(검수대기·확인필요)에
 * 실제 등장한 값만 쓴다(자유 입력 금지 — 기존 populateImpFilterOptions 와 같은 규칙).
 *
 * 거르기는 **화면에서** 한다. 두 목록 모두 업무 대기열이라 한 번에 다 받아 두기 때문이다.
 */
const blankFilter = () => ({ kind: '' as '' | 'REVIEW' | 'ISSUE', project: '', vendor: '', from: '', to: '', q: '' })
/** 입력 중인 값 — [검색]을 눌러야 아래 applied 로 옮겨간다 (기존 동작) */
const f = ref(blankFilter())
const applied = ref(blankFilter())

function doSearch() { applied.value = { ...f.value } }
function resetFilter() { f.value = blankFilter(); applied.value = blankFilter() }

/** 구분을 바꾸는 것만은 [검색] 없이 바로 먹는다 — 보이는 표가 달라지는 선택이라서 */
function onKindChange() { applied.value = { ...applied.value, kind: f.value.kind } }

const canApprove = computed(() => session.can('screen.tdb_import.review.approve'))
const canReject = computed(() => session.can('screen.tdb_import.review.reject'))
const canRegister = computed(() => session.can('screen.tdb_import.register'))
const canReattach = computed(() => session.can('screen.tdb_import.issue.reattach'))
const canRepath = computed(() => session.can('screen.tdb_import.issue.repath'))
const canRecheck = computed(() => session.can('screen.tdb_import.issue.recheck'))
const canDiscard = computed(() => session.can('screen.tdb_import.issue.reject'))

const message = ref<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)

function fail(e: unknown, fallback = '처리하지 못했습니다.') {
  message.value = { kind: 'err', text: e instanceof ApiError ? e.message : fallback }
}

function refreshAll() {
  void qc.invalidateQueries({ queryKey: ['pending-review'] })
  void qc.invalidateQueries({ queryKey: ['import-issues'] })
  void qc.invalidateQueries({ queryKey: ['import-targets'] })
  void qc.invalidateQueries({ queryKey: ['documents'] })
}

/** multipart 올리기 */
async function postForm<T>(path: string, fd: FormData): Promise<T> {
  return (await api.upload<T>(path, fd)).body
}

// ── 검수 대기 ─────────────────────────────────────────────────────────
const { data: pending, isFetching } = useQuery({
  queryKey: ['pending-review'],
  queryFn: () => api.get<PendingReviewResponse>('/revisions/pending-review'),
  staleTime: staleTime.worklist,   // 업무 대기열은 항상 최신
})

const groups = computed(() => pending.value?.items ?? [])
const selected = ref(new Set<number>())

/**
 * 한 줄이 거르개에 걸리는가 — 검수대기·확인필요 두 목록이 같은 규칙을 쓴다
 * (기존 impItemMatches 그대로: 공사·업체는 정확히 일치, 자료명은 부분 일치, 기간은 업로드일).
 */
function matches(it: { projectName: string | null; vendorName: string | null; name: string; uploadedAt: string }) {
  const a = applied.value
  if (a.project && (it.projectName ?? '') !== a.project) return false
  if (a.vendor && (it.vendorName ?? '') !== a.vendor) return false
  if (a.q && !it.name.toLowerCase().includes(a.q.trim().toLowerCase())) return false
  if (a.from && it.uploadedAt < `${a.from}T00:00:00`) return false
  if (a.to && it.uploadedAt > `${a.to}T23:59:59`) return false
  return true
}

function toggle(g: PendingReviewGroup) {
  const id = g.files[0]!.id
  selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id)
  selected.value = new Set(selected.value)
}

const reviewMutation = useMutation({
  mutationFn: (v: { fileIds: number[]; action: 'APPROVE' | 'REJECT'; note: string | null }) =>
    api.post<{ done: number; failed: { fileId: number; message: string }[] }>(
      '/revisions/review-bulk', v,
    ),
  onSuccess: (r) => {
    selected.value = new Set()
    message.value = r.failed.length
      ? { kind: 'err', text: `${r.done}건 처리, ${r.failed.length}건 실패 — ${r.failed[0]!.message}` }
      : { kind: 'ok', text: `${r.done}건 처리했습니다.` }
    void qc.invalidateQueries({ queryKey: ['pending-review'] })
    void qc.invalidateQueries({ queryKey: ['documents'] })
  },
  onError: (e) => fail(e),
})

/** 반려할 대상 — 줄 하나일 수도, 체크한 여럿일 수도 있다 */
const rejectIds = ref<number[] | null>(null)
const rejectNote = ref('')

function approve(ids: number[] = [...selected.value]) {
  // 중복반출 병합 대상과 아직 다 안 돌아온 건은 빼고 보낸다 (기존 화면과 같은 규칙)
  const ok = ids.filter((id) => {
    const g = pendingRows.value.find((r) => r.id === id)
    return g ? g.canApprove && !g.isBranch : false
  })
  if (!ok.length) {
    message.value = { kind: 'err', text: '선택한 항목 중 바로 승인할 수 있는 건이 없습니다 (중복반출 병합 대상이거나 아직 다 돌아오지 않은 항목은 제외됩니다).' }
    return
  }
  const skipped = ids.length - ok.length
  if (skipped) message.value = { kind: 'warn', text: `${skipped}건은 중복반출·미도착으로 제외하고 ${ok.length}건을 승인합니다.` }
  reviewMutation.mutate({ fileIds: ok, action: 'APPROVE', note: null })
}
function confirmReject() {
  const ids = rejectIds.value ?? []
  rejectIds.value = null
  if (!ids.length) return
  reviewMutation.mutate({ fileIds: ids, action: 'REJECT', note: rejectNote.value || null })
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
    const body = await postForm<{ revLabel: string; closedBranches: number }>(
      `/documents/${mergeDocId.value}/branch-merge`, fd,
    )
    message.value = { kind: 'ok', text: `통합본을 ${body.revLabel} 로 승인했습니다. 분기 ${body.closedBranches}건을 닫았습니다.` }
  } catch (e) {
    fail(e, '승인하지 못했습니다.')
  } finally {
    mergeDocId.value = null
    mergeFiles.value = null
    void qc.invalidateQueries({ queryKey: ['pending-review'] })
  }
}

// ── 미리보기 (목록의 돋보기) ──────────────────────────────────────────
// 기존 화면처럼 자료명 왼쪽 돋보기를 누르면 받은 PDF 를 그 자리에서 크게 본다.
const previewFileId = ref<number | null>(null)
const previewUrl = ref<string | null>(null)

/** 이 줄이 받은 파일 중 PDF 의 id (없으면 null) */
const pdfOf = (g: PendingRow) => g.files.find((x) => x.fileExt === 'pdf')?.id ?? null

// ── 비교 (반출본 ↔ 반입본) ────────────────────────────────────────────
// 왼쪽은 지금 승인된 PDF, 오른쪽은 들어온 PDF. 확인 필요 건은 아직 files 행이 아니라서
// /import-issues/:id/preview 로 본다.
const compare = ref<{ title: string; leftFileId: number | null; rightFileId: number | null; rightUrl?: string } | null>(null)

function compareGroup(g: PendingReviewGroup) {
  const pdf = g.files.find((f) => f.fileExt === 'pdf')
  compare.value = {
    title: `${g.drawingNo} ${g.revLabel} — 반출자료·반입자료 비교`,
    leftFileId: g.currentPdfFileId,
    rightFileId: pdf?.id ?? null,
  }
}

function compareIssue(i: ImportIssue) {
  compare.value = {
    title: `${i.displayName} — 반출자료·반입자료 비교`,
    leftFileId: i.currentPdfFileId,
    rightFileId: 0,
    rightUrl: `/api/import-issues/${i.id}/preview`,
  }
}

// ── 확인 필요 ─────────────────────────────────────────────────────────
const { data: issues, isFetching: issuesFetching } = useQuery({
  queryKey: ['import-issues'],
  queryFn: () => api.get<ImportIssueResponse>('/import-issues'),
  staleTime: staleTime.worklist,
})
const allIssues = computed(() => issues.value?.items ?? [])
const issueRows = computed(() => allIssues.value.filter((i) =>
  matches({ projectName: i.projectName, vendorName: i.vendorName, name: i.displayName, uploadedAt: i.createdAt })))
const issueSelected = ref(new Set<number>())

function toggleIssue(id: number) {
  const s = new Set(issueSelected.value)
  s.has(id) ? s.delete(id) : s.add(id)
  issueSelected.value = s
}

const busy = ref(false)

async function recheck(ids: number[]) {
  if (!ids.length) return
  busy.value = true
  let ok = 0
  const notes: string[] = []
  for (const id of ids) {
    try {
      const r = await api.post<RecheckIssueResult>(`/import-issues/${id}/recheck`)
      if (r.resolved) ok++
      notes.push(r.message)
    } catch (e) {
      notes.push(e instanceof ApiError ? e.message : '재검수하지 못했습니다.')
    }
  }
  busy.value = false
  issueSelected.value = new Set()
  message.value = ids.length === 1
    ? { kind: ok ? 'ok' : 'warn', text: notes[0] ?? '' }
    : { kind: ok === ids.length ? 'ok' : 'warn', text: `${ids.length}건 중 ${ok}건을 검수 대기에 등록했습니다. 나머지는 확인 필요에 다시 올렸습니다.` }
  refreshAll()
}

// 반려 — 사유를 받고 버린다(기록은 남는다)
const discardIds = ref<number[] | null>(null)
const discardNote = ref('')

async function confirmDiscard() {
  const ids = discardIds.value ?? []
  discardIds.value = null
  busy.value = true
  let done = 0
  for (const id of ids) {
    try {
      await api.post(`/import-issues/${id}/discard`, { note: discardNote.value || null })
      done++
    } catch (e) {
      fail(e)
    }
  }
  busy.value = false
  discardNote.value = ''
  issueSelected.value = new Set()
  if (done) message.value = { kind: 'ok', text: `${done}건을 반려했습니다.` }
  void qc.invalidateQueries({ queryKey: ['import-issues'] })
}

// 사유 상세
const detailIssue = ref<ImportIssue | null>(null)

// 자료 재첨부
const reattachIssue = ref<ImportIssue | null>(null)
const reattachFiles = ref<FileList | null>(null)

async function submitReattach() {
  const it = reattachIssue.value
  if (!it || !reattachFiles.value?.length) return
  const fd = new FormData()
  for (const f of reattachFiles.value) fd.append('files', f)
  try {
    const r = await postForm<ReattachIssueResult>(`/import-issues/${it.id}/reattach`, fd)
    message.value = { kind: 'ok', text: r.message }
    reattachIssue.value = null
    reattachFiles.value = null
  } catch (e) {
    fail(e, '재첨부하지 못했습니다.')
  }
  void qc.invalidateQueries({ queryKey: ['import-issues'] })
}

// ── 반출 건 고르기 팝업 (반입 자료 = 여럿, 경로 재선택 = 하나) ─────────
type PickerMode = 'MULTI' | 'SINGLE'
const picker = ref<{
  mode: PickerMode; vendorName: string; projectId: number | null
  dateFrom?: string; dateTo?: string; sub: string; issueId?: number
} | null>(null)
const pickerView = ref<'ALL' | ImportTarget['status']>('ALL')
const pickerChecked = ref(new Set<number>())
const pickerQ = ref('')

const { data: pickerData, isFetching: pickerLoading } = useQuery({
  queryKey: computed(() => ['import-targets', 'picker', picker.value]),
  queryFn: () => api.get<ImportTargetResponse>(`/imports/targets${qs({
    vendorName: picker.value!.vendorName,
    projectId: picker.value!.projectId ?? undefined,
    dateFrom: picker.value!.dateFrom, dateTo: picker.value!.dateTo,
  })}`),
  enabled: computed(() => picker.value !== null),
})

type PickerRow = ImportTarget & { id: number }
const pickerRows = computed<PickerRow[]>(() => {
  const q = pickerQ.value.trim().toLowerCase()
  return (pickerData.value?.items ?? [])
    .filter((t) => pickerView.value === 'ALL' || t.status === pickerView.value)
    .filter((t) => !q || t.displayName.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
    .map((t) => ({ ...t, id: t.distributionId }))
})

const PICKER_STATUS: Record<ImportTarget['status'], { text: string; cls: string }> = {
  INCOMPLETE: { text: '반입미완료', cls: 'tag-warn' },
  REVIEWING: { text: '검수대기', cls: 'tag-info' },
  DONE: { text: '반입완료', cls: 'tag-ok' },
}

function pickerToggle(id: number) {
  const row = pickerRows.value.find((r) => r.id === id)
  if (!row || row.status !== 'INCOMPLETE') return   // 반입미완료만 고를 수 있다
  const s = picker.value?.mode === 'SINGLE' ? new Set<number>() : new Set(pickerChecked.value)
  s.has(id) && picker.value?.mode !== 'SINGLE' ? s.delete(id) : s.add(id)
  pickerChecked.value = s
}

function pickerToggleAll(on: boolean) {
  if (picker.value?.mode === 'SINGLE') return
  pickerChecked.value = on
    ? new Set(pickerRows.value.filter((r) => r.status === 'INCOMPLETE').map((r) => r.id))
    : new Set()
}

function openPicker(p: NonNullable<typeof picker.value>, initial: number[] = []) {
  pickerView.value = 'ALL'
  pickerQ.value = ''
  pickerChecked.value = new Set(initial)
  picker.value = p
}

async function confirmPicker() {
  const p = picker.value
  if (!p) return
  const chosen = (pickerData.value?.items ?? []).filter((t) => pickerChecked.value.has(t.distributionId))
  if (p.mode === 'MULTI') {
    sel.value.distributions = chosen.map((t) => ({ id: t.distributionId, name: t.displayName }))
    sel.value.zipName = ''
    picker.value = null
    return
  }
  // 경로 재선택 — 대상만 바꿔 두고, 등록은 [재검수]에서
  if (!chosen[0] || p.issueId === undefined) {
    message.value = { kind: 'err', text: '도면을 하나 선택해주세요.' }
    return
  }
  try {
    const r = await api.post<ResolveIssueResult>(`/import-issues/${p.issueId}/resolve`, { documentId: chosen[0].documentId })
    message.value = { kind: 'ok', text: r.message }
    picker.value = null
  } catch (e) {
    fail(e)
  }
  void qc.invalidateQueries({ queryKey: ['import-issues'] })
}

function openRepath(i: ImportIssue) {
  if (!i.vendorName) {
    message.value = { kind: 'err', text: '업체가 정해지지 않은 항목입니다. 반려 후 다시 반입해 주세요.' }
    return
  }
  openPicker({
    mode: 'SINGLE', vendorName: i.vendorName, projectId: i.projectId, issueId: i.id,
    sub: `${i.projectName ?? '공사 없음'} · ${i.vendorName} — 이 자료가 실제로 어느 도면인지 하나만 선택하세요`,
  })
}

// ── 반입등록 ──────────────────────────────────────────────────────────

// 반입 Zip
const zipFile = ref<File | null>(null)
const zipJobId = ref<number | null>(null)
const zipBusy = ref(false)

async function uploadZip() {
  if (!zipFile.value) {
    message.value = { kind: 'err', text: '반입 Zip 파일을 선택해주세요.' }
    return
  }
  const fd = new FormData()
  fd.append('file', zipFile.value)
  zipBusy.value = true
  try {
    const r = await postForm<{ jobId: number }>('/imports/zip', fd)
    zipJobId.value = r.jobId
    message.value = { kind: 'ok', text: '올렸습니다. 압축을 풀어 반출 목록과 대조하는 중입니다.' }
  } catch (e) {
    fail(e, '올리지 못했습니다.')
  } finally {
    zipBusy.value = false
  }
}

function onJobDone(j: JobDetail) {
  const text = j.progressNote ?? '반입을 마쳤습니다.'
  message.value = { kind: /확인이 필요|받지 않은/.test(text) ? 'warn' : 'ok', text }
  refreshAll()
}
function onJobFailed(j: JobDetail) {
  message.value = { kind: 'err', text: j.error ?? '반입하지 못했습니다.' }
}

// 반입 자료 (Zip 없이 — 반출 건을 고르고 파일을 올린다)
const sel = ref({
  projectKey: '', vendorName: '', dateFrom: '', dateTo: '',
  zipName: '',
  distributions: [] as { id: number; name: string }[],
})
const selFiles = ref<FileList | null>(null)
const selJobId = ref<number | null>(null)
const selInput = ref<HTMLInputElement | null>(null)

const { data: outstanding } = useQuery({
  queryKey: ['import-targets', 'outstanding'],
  queryFn: () => api.get<ImportTargetResponse>('/imports/targets'),
  staleTime: staleTime.worklist,
})

/** '공사 없음' 도 하나의 묶음으로 고를 수 있다 */
const projectKey = (id: number | null) => (id === null ? '__none__' : String(id))

const vendorChoices = computed(() => {
  const m = new Map<string, number>()
  for (const t of outstanding.value?.items ?? []) {
    if (sel.value.projectKey && projectKey(t.projectId) !== sel.value.projectKey) continue
    m.set(t.vendorName, (m.get(t.vendorName) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'))
})

const projectChoices = computed(() => {
  const m = new Map<string, { name: string; count: number }>()
  for (const t of outstanding.value?.items ?? []) {
    if (sel.value.vendorName && t.vendorName !== sel.value.vendorName) continue
    const k = projectKey(t.projectId)
    const cur = m.get(k) ?? { name: t.projectName ?? '공사 없음', count: 0 }
    cur.count++
    m.set(k, cur)
  }
  return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'ko'))
})

const zipChoices = computed(() => {
  const m = new Map<string, number>()
  for (const t of outstanding.value?.items ?? []) {
    if (!t.zipName || (sel.value.vendorName && t.vendorName !== sel.value.vendorName)) continue
    if (sel.value.projectKey && projectKey(t.projectId) !== sel.value.projectKey) continue
    m.set(t.zipName, (m.get(t.zipName) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
})

function resetSelTargets() {
  sel.value.distributions = []
  sel.value.zipName = ''
}

function searchTargets() {
  if (!sel.value.vendorName) {
    message.value = { kind: 'err', text: '먼저 업체를 선택해주세요.' }
    return
  }
  const pk = sel.value.projectKey
  const project = pk && pk !== '__none__' ? Number(pk) : null
  const projectName = pk ? (projectChoices.value.find(([k]) => k === pk)?.[1].name ?? '') : '전체 공사'
  const period = sel.value.dateFrom || sel.value.dateTo
    ? ` · 기간 ${sel.value.dateFrom || '처음'}~${sel.value.dateTo || '지금'}` : ''
  openPicker({
    mode: 'MULTI', vendorName: sel.value.vendorName, projectId: project,
    dateFrom: sel.value.dateFrom || undefined, dateTo: sel.value.dateTo || undefined,
    sub: `${projectName} · ${sel.value.vendorName}${period} — 반입할 도면을 체크하세요 (반입미완료만 선택 가능)`,
  }, sel.value.distributions.map((d) => d.id))
}

async function uploadSelection() {
  if (!sel.value.distributions.length && !sel.value.zipName) {
    message.value = { kind: 'err', text: '자료검색으로 반입할 도면을 먼저 선택하거나 반출 Zip 묶음을 골라 주세요.' }
    return
  }
  if (!selFiles.value?.length) {
    message.value = { kind: 'err', text: '업로드할 파일을 선택해주세요.' }
    return
  }
  const fd = new FormData()
  if (sel.value.zipName) fd.append('zipName', sel.value.zipName)
  else fd.append('distributionIds', sel.value.distributions.map((d) => d.id).join(','))
  for (const f of selFiles.value) fd.append('files', f)
  try {
    const r = await postForm<{ jobId: number }>('/imports/by-selection', fd)
    selJobId.value = r.jobId
    message.value = { kind: 'ok', text: '올렸습니다. 선택한 도면과 파일 이름을 대조하는 중입니다.' }
    resetSelTargets()
    selFiles.value = null
    if (selInput.value) selInput.value.value = ''
  } catch (e) {
    fail(e, '올리지 못했습니다.')
  }
}

// 신규 자료 등록
const { data: options } = useQuery({
  queryKey: ['import-options'],
  queryFn: () => api.get<ImportOptions>('/imports/options'),
  staleTime: 5 * 60_000,
})

const blankNew = () => ({
  folder: null as FolderNode | null,
  drawingNo: '', title: '', category: '', discipline: '', docType: '',
  isblOsbl: '', elevation: '', area: '', vendorName: '', projectId: '' as string,
})
const nf = ref(blankNew())
const nfFiles = ref<FileList | null>(null)
const nfInput = ref<HTMLInputElement | null>(null)
const folderPickOpen = ref(false)
const nfBusy = ref(false)

async function registerNew() {
  if (!nf.value.folder) {
    message.value = { kind: 'err', text: '등록할 폴더를 골라 주세요.' }
    return
  }
  if (!nf.value.drawingNo.trim()) {
    message.value = { kind: 'err', text: '자료명(도면번호)을 적어 주세요.' }
    return
  }
  if (!nfFiles.value?.length) {
    message.value = { kind: 'err', text: '원본과 PDF 를 함께 올려 주세요.' }
    return
  }
  const fd = new FormData()
  const { folder, ...rest } = nf.value
  fd.append('folderId', String(folder.id))
  for (const [k, v] of Object.entries(rest)) if (v) fd.append(k, String(v))
  for (const f of nfFiles.value) fd.append('files', f)
  nfBusy.value = true
  try {
    const r = await postForm<RegisterNewResult>('/imports/register-new', fd)
    message.value = { kind: 'ok', text: `'${r.drawingNo}' 을(를) ${r.revLabel} 로 등록했습니다 (파일 ${r.fileCount}개).` }
    nf.value = { ...blankNew(), folder }
    nfFiles.value = null
    if (nfInput.value) nfInput.value.value = ''
    void qc.invalidateQueries({ queryKey: ['documents'] })
    void qc.invalidateQueries({ queryKey: ['folders'] })
  } catch (e) {
    fail(e, '등록하지 못했습니다.')
  } finally {
    nfBusy.value = false
  }
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
  groups.value
    .filter((g) => matches({
      projectName: g.projectName, vendorName: g.vendorName,
      name: `${g.drawingNo} ${g.title}`, uploadedAt: g.uploadedAt,
    }))
    .map((g) => ({ ...g, id: g.files[0]!.id })),
)

/** 공사·업체 후보 — 두 목록에 실제 등장한 값만 (기존 populateImpFilterOptions) */
const projectOptions = computed(() => [...new Set([
  ...groups.value.map((g) => g.projectName),
  ...allIssues.value.map((i) => i.projectName),
].filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'ko')))

const vendorOptions = computed(() => [...new Set([
  ...groups.value.map((g) => g.vendorName),
  ...allIssues.value.map((i) => i.vendorName),
].filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'ko')))

/**
 * 구분에 따라 어느 표를 보이는가 (기존 applyImpSectionVisibility).
 * '전체' 일 때는 확인 필요가 0건이면 감춘다 — 구분을 직접 고른 때는 0건이어도
 * "없습니다" 안내를 보여준다.
 */
const showReview = computed(() => applied.value.kind !== 'ISSUE')
const showIssues = computed(() =>
  applied.value.kind === 'ISSUE' || (applied.value.kind === '' && issueRows.value.length > 0))

const extsLabel = (list: string[]) =>
  (list.length ? list.map((e) => e.toUpperCase()).join(', ') : '\u00b7')

/** 중복반출이면 반입Rev 에 진행 상황을 함께 적는다 — "1-a(2/3)" (기존 화면과 같은 표기) */
function revText(g: PendingRow): string {
  return g.isBranch && g.branchExpected !== null
    ? `${g.revLabel}(${g.branchArrived ?? 0}/${g.branchExpected})`
    : g.revLabel
}

const PENDING_COLUMNS: Column<PendingRow>[] = [
  { key: 'projectName', label: '공사', width: '100px', align: 'center', render: (g) => g.projectName ?? '\u00b7' },
  { key: 'vendorName', label: '업체', width: '90px', align: 'center', render: (g) => g.vendorName ?? '\u00b7' },
  { key: 'drawingNo', label: '반입·검수대기 자료명', width: '200px',
    render: (g) => (g.title ? `${g.drawingNo} ${g.title}` : g.drawingNo) },
  { key: 'category', label: '분류', width: '100px', render: (g) => g.category ?? g.folderName },
  { key: 'folderPath', label: '경로', render: (g) => g.folderPath ?? '\u00b7' },
  { key: 'distributedRev', label: '반출Rev', width: '84px', align: 'center',
    render: (g) => String(g.distributedRev ?? 0) },
  { key: 'revLabel', label: '반입Rev', width: '104px', align: 'center', render: revText },
  { key: 'distributedExts', label: '반출자료', width: '88px', align: 'center',
    render: (g) => extsLabel(g.distributedExts) },
  { key: 'importedExts', label: '반입자료', width: '88px', align: 'center',
    render: (g) => extsLabel(g.files.map((x) => x.fileExt)) },
  { key: 'isBranch', label: '중복반출', width: '84px', align: 'center', filterable: false,
    render: (g) => (g.isBranch ? 'Y' : '\u00b7') },
  { key: 'uploadedAt', label: '업로드 일시', width: '130px', align: 'center',
    render: (g) => g.uploadedAt.slice(0, 16).replace('T', ' ') },
  { key: 'act', label: '조치', width: '210px', align: 'center', sortable: false, filterable: false,
    exportable: false, render: () => '' },
]

const reasonLabel = (c: string) => IMPORT_REASON_LABEL[c] ?? c
/** 기 반입 완료는 정상 쪽, 표기 문제는 주의, 나머지는 위험 — 기존 화면 색 그대로 */
function reasonClass(c: string): string {
  if (c === 'ALREADY_IMPORTED') return 'tag-ok'
  if (['NOT_DISTRIBUTED', 'REV_MISMATCH', 'REV_TAG_MISSING', 'REV_TAG_MALFORMED'].includes(c)) return 'tag-warn'
  return 'tag-danger'
}

const ISSUE_COLUMNS: Column<ImportIssue>[] = [
  { key: 'projectName', label: '공사', width: '110px', align: 'center', render: (i) => i.projectName ?? '\u00b7' },
  { key: 'vendorName', label: '업체', width: '110px', align: 'center', render: (i) => i.vendorName ?? '\u00b7' },
  { key: 'displayName', label: '자료명', width: '220px' },
  { key: 'createdAt', label: '업로드 일시', width: '130px', align: 'center',
    render: (i) => i.createdAt.slice(0, 16).replace('T', ' ') },
  // 글자값에 사유상세 문장까지 담는다 — 엑셀(기존 '사유' 칸)과 거르기가 이것을 쓴다
  { key: 'reasons', label: '사유', width: '220px',
    render: (i) => `${i.reasons.map(reasonLabel).join(', ')} \u2014 ${i.detailText}` },
  { key: 'files', label: '받은 파일', width: '150px',
    render: (i) => i.files.map((x) => x.ext.toUpperCase()).join(', ') },
  { key: 'act', label: '비고', width: '420px', sortable: false, filterable: false, exportable: false, render: () => '' },
]

const PICKER_COLUMNS: Column<PickerRow>[] = [
  { key: 'displayName', label: '자료명', width: '180px' },
  { key: 'title', label: '내용', width: '140px' },
  { key: 'folderPath', label: '경로' },
  { key: 'revAtDistribution', label: '반출Rev', width: '70px', align: 'center',
    render: (t) => `Rev${String(t.revAtDistribution).padStart(2, '0')}` },
  { key: 'hasDwg', label: 'DWG', width: '56px', align: 'center', filterable: false,
    render: (t) => (t.hasDwg ? 'Y' : '\u00b7') },
  { key: 'hasXlsx', label: 'XLSX', width: '56px', align: 'center', filterable: false,
    render: (t) => (t.hasXlsx ? 'Y' : '\u00b7') },
  { key: 'hasEtc', label: 'ETC', width: '56px', align: 'center', filterable: false,
    render: (t) => (t.hasEtc ? 'Y' : '\u00b7') },
  { key: 'hasPdf', label: 'PDF', width: '56px', align: 'center', filterable: false,
    render: (t) => (t.hasPdf ? 'Y' : '\u00b7') },
  { key: 'distributedAt', label: '반출일', width: '96px', align: 'center', render: (t) => t.distributedAt.slice(0, 10) },
  { key: 'status', label: '상태', width: '96px', align: 'center', render: (t) => PICKER_STATUS[t.status].text },
]

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`
}
</script>

<template>
  <main class="app-main import">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          TDB 반입·검수<span class="page-title-sub">TDB 신규 자료 등록 및 검토·승인</span>
        </h1>
      </div>
    </div>

    <!-- 검색 -->
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div class="field">
            <label for="imp-kind">구분</label>
            <select id="imp-kind" v-model="f.kind" @change="onKindChange">
              <option value="">전체</option>
              <option value="REVIEW">검수 대기</option>
              <option value="ISSUE">확인 필요</option>
            </select>
          </div>
          <div class="field">
            <label for="imp-project">공사</label>
            <select id="imp-project" v-model="f.project">
              <option value="">전체</option>
              <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="field">
            <label for="imp-vendor">업체</label>
            <select id="imp-vendor" v-model="f.vendor">
              <option value="">전체</option>
              <option v-for="v in vendorOptions" :key="v" :value="v">{{ v }}</option>
            </select>
          </div>
          <div class="field">
            <label for="imp-from">기간</label>
            <input id="imp-from" v-model="f.from" type="date" />
          </div>
          <div class="field">
            <label for="imp-to">~</label>
            <input id="imp-to" v-model="f.to" type="date" />
          </div>
          <input
            v-model="f.q" type="text" class="filter-search" placeholder="자료명 검색"
            @keyup.enter="doSearch"
          />
          <button id="imp-search-btn" class="primary" type="button" @click="doSearch">검색</button>
        </div>
        <div class="filter-actions">
          <button type="button" @click="resetFilter">조건 초기화</button>
        </div>
      </div>
    </div>

    <div v-if="message" class="msg" :class="message.kind">
      {{ message.text }}
      <span style="flex:1" />
      <button class="small" @click="message = null">닫기</button>
    </div>

    <!-- 검수 대기 -->
    <section v-if="showReview" class="imp-section">
      <div class="status-bar">
        <span class="status-bar-left">
          <b>검수 대기 ({{ pendingRows.length }})</b>
          <span v-if="isFetching && !pendingRows.length" class="muted">&nbsp;· 조회 중…</span>
        </span>
        <span class="cart-status">
          <button
            class="cart-btn" type="button"
            :disabled="!selected.size || !canApprove || reviewMutation.isPending.value"
            @click="approve()"
          >선택 승인</button>
          <button
            class="cart-btn" type="button"
            :disabled="!selected.size || !canReject || reviewMutation.isPending.value"
            @click="rejectIds = [...selected]"
          >선택 반려</button>
        </span>
      </div>

      <div class="table-box">
        <DataTable
          :columns="PENDING_COLUMNS" :rows="pendingRows" selectable :selected="selected"
          :total="pendingRows.length" :loading="isFetching && !pendingRows.length"
          storage-key="import-pending" excel-name="TDB 검수대기"
          empty-text="검수 대기 중인 항목이 없습니다."
          @toggle="(id) => toggle(pendingRows.find(g => g.id === id)!)"
          @toggle-all="(on) => { selected = on ? new Set(pendingRows.map(g => g.id)) : new Set() }"
        >
          <!-- 자료명 앞 돋보기 — 받은 PDF 를 그 자리에서 크게 본다 (기존 화면과 같은 자리) -->
          <template #cell:drawingNo="{ row }">
            <button
              class="preview-icon-btn" type="button" title="받은 PDF 미리보기"
              :class="{ 'is-empty': !pdfOf(row) }" :disabled="!pdfOf(row)"
              @click.stop="previewFileId = pdfOf(row)"
            >🔍</button>
            <span>{{ row.drawingNo }}</span>
            <span v-if="row.title" class="muted small sub-inline">{{ row.title }}</span>
          </template>

          <template #cell:revLabel="{ row }">
            <b>{{ revText(row) }}</b>
            <span v-if="row.hasWarning" class="badge badge-warning"
                  title="업체가 적은 Rev 표기와 다릅니다">Rev 불일치</span>
          </template>

          <!-- 중복반출 — 있으면 눌러서 현황을 본다 (기존 화면의 [Y] 단추) -->
          <template #cell:isBranch="{ row }">
            <button v-if="row.isBranch" class="small" @click.stop="dupDocId = row.documentId">Y</button>
            <span v-else class="yn-n">·</span>
          </template>

          <template #cell:act="{ row }">
            <button class="small" :disabled="!row.files.some((x) => x.fileExt === 'pdf')"
                    @click.stop="compareGroup(row)">비교</button>
            <button v-if="row.isBranch" class="small primary" :disabled="!canApprove || !row.canApprove"
                    :title="row.canApprove
                      ? '중복반출 건은 통합본을 첨부해 승인합니다'
                      : '반출된 것이 모두 돌아와야 승인할 수 있습니다'"
                    @click.stop="mergeDocId = row.documentId">승인</button>
            <button v-else class="small primary"
                    :disabled="!canApprove || !row.canApprove || reviewMutation.isPending.value"
                    @click.stop="approve([row.id])">승인</button>
            <button class="small" :disabled="!canReject || reviewMutation.isPending.value"
                    @click.stop="rejectIds = [row.id]">반려</button>
          </template>
        </DataTable>
      </div>
    </section>

    <!-- 확인 필요 -->
    <section v-if="showIssues" class="imp-section">
      <div class="status-bar">
        <span class="status-bar-left">
          <b>확인 필요 ({{ issueRows.length }})</b>
          <span class="muted">&nbsp;· 반입 중 자료를 확정하지 못했거나 문제가 있는 항목입니다. 파일은 보관돼 있습니다.</span>
        </span>
        <span class="cart-status">
          <button class="cart-btn" type="button" :disabled="!issueSelected.size || !canRecheck || busy"
                  @click="recheck([...issueSelected])">선택 재검수</button>
          <button class="cart-btn" type="button" :disabled="!issueSelected.size || !canDiscard || busy"
                  @click="discardIds = [...issueSelected]">선택 반려</button>
        </span>
      </div>

      <div class="table-box">
        <DataTable
          :columns="ISSUE_COLUMNS" :rows="issueRows" :total="issueRows.length"
          selectable :selected="issueSelected" :loading="issuesFetching && !issueRows.length"
          :row-class="(i) => (i.reasons.includes('ALREADY_IMPORTED') ? '' : 'warn')"
          storage-key="import-issues-v2" excel-name="TDB 확인필요"
          empty-text="확인이 필요한 항목이 없습니다."
          @toggle="toggleIssue"
          @toggle-all="(on) => { issueSelected = on ? new Set(issueRows.map((i) => i.id)) : new Set() }"
        >
          <template #cell:displayName="{ row }">
            <button
              class="preview-icon-btn" type="button" title="받은 PDF 미리보기"
              :class="{ 'is-empty': !row.hasPdf }" :disabled="!row.hasPdf"
              @click.stop="previewUrl = `/api/import-issues/${row.id}/preview`"
            >🔍</button>
            <span :title="row.folderPath ?? ''">{{ row.displayName }}</span>
          </template>

          <template #cell:reasons="{ row }">
            <span v-for="c in row.reasons" :key="c" class="badge" :class="reasonClass(c)">{{ reasonLabel(c) }}</span>
          </template>

          <template #cell:files="{ row }">
            <span v-for="(x, n) in row.files" :key="n" class="chip"
                  :title="`${x.folder ? x.folder + '/' : ''}${x.filename}`">
              {{ x.ext.toUpperCase() || '?' }}{{ x.byteSize !== null ? ' ' + size(x.byteSize) : '' }}
            </span>
          </template>

          <template #cell:act="{ row }">
            <button class="small" @click.stop="detailIssue = row">사유상세</button>
            <button class="small" :disabled="!row.hasPdf || row.suggestedDocumentId === null"
                    title="대상 도면이 정해져 있고 받은 파일에 PDF 가 있을 때 비교할 수 있습니다"
                    @click.stop="compareIssue(row)">비교</button>
            <button class="small" :disabled="!canReattach" @click.stop="reattachIssue = row">자료 재첨부</button>
            <button class="small" :disabled="!canRepath" @click.stop="openRepath(row)">경로 재선택</button>
            <button class="small primary" :disabled="!canRecheck || busy"
                    @click.stop="recheck([row.id])">재검수</button>
            <button class="small" :disabled="!canDiscard || busy"
                    @click.stop="discardIds = [row.id]">반려</button>
          </template>
        </DataTable>
      </div>
    </section>

    <!-- 반입 등록: 반입 Zip | 반입 자료 -->
    <section class="import-form">
      <div class="bulk-top-grid">
        <!-- 반입 Zip -->
        <div class="bulk-block card" :class="{ 'perm-disabled': !canRegister }">
          <div class="bulk-block-head">
            <span class="bulk-block-title">반입등록 (Zip 파일)</span>
            <span class="bulk-block-desc">Zip(반출목록 xlxs+폴더) 첨부</span>
          </div>
          <div class="bulk-block-body">
            <div class="file-row">
              <input type="file" accept=".zip" :disabled="!canRegister"
                     @change="(e) => (zipFile = (e.target as HTMLInputElement).files?.[0] ?? null)" />
              <button class="primary" type="button" :disabled="!canRegister || !zipFile || zipBusy"
                      @click="uploadZip">업로드</button>
            </div>
            <p class="page-desc">
              반출할 때 받은 Zip 을 그대로 올리면 반출목록의 문서ID·업체로 반출 건을 찾아 대조합니다.
              맞는 것은 <strong>검수 대기</strong>로, 이름·경로가 다르거나 원본/PDF 가 빠진 것은
              <strong>확인 필요</strong>로 넘어갑니다.
            </p>
            <JobProgress :job-id="zipJobId" @done="onJobDone" @failed="onJobFailed" />
          </div>
        </div>

        <!-- 반입 자료 -->
        <div class="bulk-block card" :class="{ 'perm-disabled': !canRegister }">
          <div class="bulk-block-head">
            <span class="bulk-block-title">반입등록 (개별 자료)</span>
            <span class="bulk-block-desc">자료 선택 후, 자료(원본+사본) 첨부</span>
          </div>
          <div class="bulk-block-body">
            <div class="sel-row">
              <div class="field">
                <label for="sel-project">공사</label>
                <select id="sel-project" v-model="sel.projectKey" @change="resetSelTargets">
                  <option value="">공사 선택</option>
                  <option v-for="[k, p] in projectChoices" :key="k" :value="k">
                    {{ p.name }} ({{ p.count }}건)
                  </option>
                </select>
              </div>
              <div class="field">
                <label for="sel-vendor">업체</label>
                <select id="sel-vendor" v-model="sel.vendorName" @change="resetSelTargets">
                  <option value="">업체 선택</option>
                  <option v-for="[v, n] in vendorChoices" :key="v" :value="v">{{ v }} ({{ n }}건)</option>
                </select>
              </div>
              <div class="field field-date">
                <label for="sel-date-from">기간</label>
                <input id="sel-date-from" v-model="sel.dateFrom" type="date" />
              </div>
              <div class="field field-date">
                <label for="sel-date-to">~</label>
                <input id="sel-date-to" v-model="sel.dateTo" type="date" />
              </div>
              <div class="field">
                <label for="sel-zip">반출 Zip 묶음</label>
                <select id="sel-zip" v-model="sel.zipName" @change="sel.distributions = []">
                  <option value="">(자료검색으로 고름)</option>
                  <option v-for="[z, n] in zipChoices" :key="z" :value="z">{{ z }} ({{ n }}건)</option>
                </select>
              </div>
              <button class="primary" type="button" :disabled="!canRegister" @click="searchTargets">자료검색</button>
              <span class="sel-count">
                <template v-if="sel.zipName">Zip 묶음 '{{ sel.zipName }}'</template>
                <template v-else>선택된 도면: {{ sel.distributions.length }}건</template>
              </span>
            </div>
            <div class="file-row">
              <input ref="selInput" type="file" multiple :disabled="!canRegister"
                     @change="(e) => (selFiles = (e.target as HTMLInputElement).files)" />
              <button class="primary" type="button" :disabled="!canRegister" @click="uploadSelection">업로드</button>
            </div>
            <p v-if="sel.distributions.length && !sel.zipName" class="page-desc ellipsis">
              {{ sel.distributions.slice(0, 5).map((d) => d.name).join(', ')
              }}{{ sel.distributions.length > 5 ? ' …' : '' }}
            </p>
            <JobProgress :job-id="selJobId" @done="onJobDone" @failed="onJobFailed" />
          </div>
        </div>
      </div>

      <!-- 신규 자료 등록 — 공유폴더에 없던 자료를 CM 이 직접 만든다 -->
      <div class="bulk-block card" :class="{ 'perm-disabled': !canRegister }">
        <div class="bulk-block-head">
          <span class="bulk-block-title">신규 자료 등록</span>
          <span class="bulk-block-desc">검수 없이 Rev00 으로 바로 등록 · 원본+사본 함께 첨부</span>
        </div>
        <div class="bulk-block-body">
          <div class="form-grid">
            <div class="field">
              <label>폴더 *</label>
              <span class="range">
                <input type="text" readonly :value="nf.folder?.name ?? ''" placeholder="폴더를 고르세요" />
                <button class="small" type="button" @click="folderPickOpen = true">고르기</button>
              </span>
            </div>
            <div class="field"><label>자료명(도면번호) *</label><input v-model="nf.drawingNo" type="text" maxlength="200" /></div>
            <div class="field"><label>내용</label><input v-model="nf.title" type="text" maxlength="500" placeholder="비우면 자료명" /></div>
            <div class="field"><label>대분류</label><input v-model="nf.category" type="text" maxlength="100" /></div>
            <div class="field"><label>공종</label><input v-model="nf.discipline" type="text" maxlength="100" /></div>
            <div class="field"><label>도면종류</label><input v-model="nf.docType" type="text" maxlength="100" /></div>
            <div class="field"><label>ISBL/OSBL</label><input v-model="nf.isblOsbl" type="text" maxlength="50" /></div>
            <div class="field"><label>지상/지하</label><input v-model="nf.elevation" type="text" maxlength="50" /></div>
            <div class="field"><label>구역</label><input v-model="nf.area" type="text" maxlength="100" /></div>
            <div class="field">
              <label>업체</label>
              <select v-model="nf.vendorName">
                <option value="">(없음)</option>
                <option v-for="v in options?.vendors ?? []" :key="v.id" :value="v.name">{{ v.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>공사</label>
              <select v-model="nf.projectId">
                <option value="">(없음)</option>
                <option v-for="p in options?.projects ?? []" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
              </select>
            </div>
          </div>
          <div class="file-row">
            <input ref="nfInput" type="file" multiple accept=".pdf,.dwg,.dxf,.xlsx,.xls,.docx,.pptx"
                   :disabled="!canRegister" @change="(e) => (nfFiles = (e.target as HTMLInputElement).files)" />
            <button class="primary" type="button" :disabled="!canRegister || nfBusy" @click="registerNew">등록</button>
          </div>
          <p class="page-desc">
            자료명에는 리비전 표기를 적지 않습니다 — 시스템이 붙입니다.
          </p>
        </div>
      </div>
    </section>

    <!-- 반려 사유 -->
    <Modal v-if="rejectIds" :title="`검수 반려 (${rejectIds.length}건)`" @close="rejectIds = null">
      <p class="page-desc">반려 사유를 적어 주세요. 업체에 전달할 내용입니다.</p>
      <textarea v-model="rejectNote" rows="4" placeholder="예: 치수 누락, 도면번호 불일치" />
      <template #footer>
        <button @click="rejectIds = null">취소</button>
        <button class="primary" @click="confirmReject">반려</button>
      </template>
    </Modal>

    <!-- 받은 PDF 미리보기 (목록의 돋보기) -->
    <Modal
      v-if="previewFileId !== null || previewUrl !== null"
      class="preview-modal" wide title="미리보기"
      @close="previewFileId = null; previewUrl = null"
    >
      <div class="preview-box">
        <PdfViewer v-if="previewUrl" :file-id="0" :file-url="previewUrl" />
        <PdfViewer v-else-if="previewFileId" :file-id="previewFileId" />
      </div>
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

    <!-- 사유 상세 -->
    <Modal v-if="detailIssue" title="사유 상세" @close="detailIssue = null">
      <p>
        <span v-for="c in detailIssue.reasons" :key="c" class="badge" :class="reasonClass(c)">{{ reasonLabel(c) }}</span>
      </p>
      <p class="detail-text">{{ detailIssue.detailText || '추가 설명이 없습니다.' }}</p>
      <table class="grid">
        <thead><tr><th>받은 파일</th><th>Zip 안 폴더</th><th>크기</th></tr></thead>
        <tbody>
          <tr v-for="(f, n) in detailIssue.files" :key="n">
            <td>{{ f.filename }}</td>
            <td class="muted">{{ f.folder ?? '-' }}</td>
            <td class="tr">{{ f.byteSize !== null ? size(f.byteSize) : '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="detailIssue.suggestedDrawingNo" class="muted small">
        대상 도면: {{ detailIssue.suggestedDrawingNo }} {{ detailIssue.folderPath ? `(${detailIssue.folderPath})` : '' }}
      </p>
    </Modal>

    <!-- 자료 재첨부 -->
    <Modal v-if="reattachIssue" title="자료 재첨부" @close="reattachIssue = null">
      <p class="muted">
        대상: {{ reattachIssue.displayName }} — 원본과 PDF 를 함께 올려주세요.
        첨부한 뒤 [재검수]를 눌러야 다시 검수됩니다.
      </p>
      <input type="file" multiple accept=".pdf,.dwg,.dxf,.xlsx,.xls,.docx,.pptx"
             @change="(e) => (reattachFiles = (e.target as HTMLInputElement).files)" />
      <template #footer>
        <button class="btn" @click="reattachIssue = null">취소</button>
        <button class="btn btn-primary" :disabled="!reattachFiles?.length" @click="submitReattach">첨부</button>
      </template>
    </Modal>

    <!-- 확인 필요 반려 -->
    <Modal v-if="discardIds" :title="`확인 필요 반려 (${discardIds.length}건)`" @close="discardIds = null">
      <p class="muted">반려하면 목록에서 빠집니다. 기록은 남습니다. 사유는 선택입니다.</p>
      <textarea v-model="discardNote" rows="3" style="width:100%" />
      <template #footer>
        <button class="btn" @click="discardIds = null">취소</button>
        <button class="btn btn-primary" @click="confirmDiscard">반려</button>
      </template>
    </Modal>

    <!-- 반출 건 고르기 (반입 자료 / 경로 재선택) -->
    <Modal v-if="picker" class="picker-modal" wide
           :title="picker.mode === 'SINGLE' ? '경로 재선택' : '업체별 반출·반입자료 현황'" @close="picker = null">
      <p class="muted">{{ picker.sub }}</p>
      <div class="bar">
        <button v-for="v in (['ALL', 'REVIEWING', 'DONE', 'INCOMPLETE'] as const)" :key="v"
                class="btn btn-sm" :class="{ 'btn-primary': pickerView === v }" @click="pickerView = v">
          {{ v === 'ALL' ? '전체' : PICKER_STATUS[v].text }}
        </button>
        <input v-model="pickerQ" type="text" placeholder="자료명·내용" style="width:180px" />
        <span style="flex:1" />
        <span v-if="picker.mode === 'MULTI'" class="muted small">선택 {{ pickerChecked.size }}건</span>
      </div>
      <div class="picker-grid">
        <DataTable
          :columns="PICKER_COLUMNS" :rows="pickerRows" :total="pickerRows.length"
          selectable :selected="pickerChecked" :loading="pickerLoading"
          :row-class="(t) => (t.status === 'INCOMPLETE' ? '' : 'off')"
          storage-key="import-picker" excel-name="반출·반입자료 현황"
          empty-text="해당 자료가 없습니다."
          @toggle="pickerToggle" @toggle-all="pickerToggleAll"
        >
          <template #cell:status="{ row }">
            <span class="badge" :class="PICKER_STATUS[row.status].cls">{{ PICKER_STATUS[row.status].text }}</span>
          </template>
        </DataTable>
      </div>
      <template #footer>
        <button class="btn" @click="picker = null">취소</button>
        <button class="btn btn-primary" :disabled="!pickerChecked.size" @click="confirmPicker">
          {{ picker.mode === 'SINGLE' ? '이 도면으로 지정' : '선택' }}
        </button>
      </template>
    </Modal>

    <!-- 신규 등록 폴더 고르기 -->
    <Modal v-if="folderPickOpen" title="폴더 고르기" @close="folderPickOpen = false">
      <div class="tree-box">
        <LazyTree doc-class="TDB" :selected-id="nf.folder?.id ?? null"
                  @select="(f) => { nf.folder = f; if (f) folderPickOpen = false }" />
      </div>
    </Modal>

    <!-- 비교 -->
    <Modal v-if="compare" class="compare-modal" wide :title="compare.title" @close="compare = null">
      <div class="compare">
        <div class="side">
          <div class="side-head">반출자료 (지금 승인된 PDF)</div>
          <PdfViewer v-if="compare.leftFileId" :file-id="compare.leftFileId" />
          <div v-else class="nopdf">이전 승인 리비전에 PDF가 없습니다 (신규이거나 PDF 미보유).</div>
        </div>
        <div class="side">
          <div class="side-head">반입자료</div>
          <PdfViewer v-if="compare.rightUrl" :file-id="0" :file-url="compare.rightUrl" />
          <PdfViewer v-else-if="compare.rightFileId" :file-id="compare.rightFileId" />
          <div v-else class="nopdf">반입 파일에 PDF 가 없습니다.</div>
        </div>
      </div>
    </Modal>
  </main>
</template>

<style scoped>
/* 일부만 확인 필요로 간 결과 — 성공도 실패도 아니다 */
.msg.warn { background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn); }

/* 검수 대기 · 확인 필요 — 상태줄 + 표 한 덩어리 (기존 화면의 section) */
.imp-section { display: flex; flex-direction: column; gap: 9px; flex: 0 0 auto; }
.table-box {
  min-height: 300px; max-height: 68vh; display: flex;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); overflow: hidden;
}
.table-box > * { flex: 1; min-width: 0; }

/* 자료명 칸의 보조 설명 — 줄 높이를 늘리지 않게 같은 줄에 잇는다 */
.sub-inline { margin-left: 6px; }

/* 조치 칸의 단추 — 너비가 제각각이면 줄이 지저분해 보이므로 가운데로 모은다
   (기존 import.css .action-btns). 칸이 좁으면 잘리지 않고 다음 줄로 넘어간다. */
:deep(.dt-cell.dt-slot) { flex-wrap: wrap; justify-content: center; gap: 5px; }

.chip {
  display: inline-block; font-size: 11px; padding: 1px 6px; margin-right: 3px;
  border: 1px solid var(--border-strong); border-radius: 9px;
}
.badge { margin-right: 3px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- 반입 등록 (기존 import.css) ---------- */
.import-form { margin-top: 4px; flex: 0 0 auto; }

.bulk-top-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  align-items: stretch;
}
@media (max-width: 1100px) { .bulk-top-grid { grid-template-columns: 1fr; } }

.bulk-block { display: flex; flex-direction: column; overflow: hidden; }
.bulk-top-grid + .bulk-block { margin-top: 18px; }

/* 제목 줄: 아래 입력 영역과 배경색·구분선으로 분리한다 */
.bulk-block-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-alt);
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
}
.bulk-block-title { font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; }
.bulk-block-desc { font-size: 11px; font-weight: 600; color: var(--text-muted); }

.bulk-block-body { padding: 16px; flex: 1; display: flex; flex-direction: column; }
.bulk-block-body .page-desc { margin-top: 10px; }

/* 공사·업체 드롭다운 옆에 [자료검색] + 선택 건수를 같은 줄에 */
.sel-row {
  display: flex; flex-wrap: wrap; align-items: flex-end;
  gap: 8px 10px; margin-bottom: 28px;
}
.sel-row .field { flex: 1 1 0; min-width: 0; }
.sel-row .field select { width: 100%; }
.sel-row .field.field-date { flex: 0 0 auto; }
.sel-row .field.field-date input[type="date"] { width: 132px; }
.sel-row .field label { font-size: 11px; font-weight: 700; color: var(--text-dark-gray); letter-spacing: 0.02em; }
.sel-row .sel-count, .sel-row > button { flex: none; }

/* 건수가 0~999건까지 늘어나도 글자 위치가 고정되게 최대 자리수 너비를 미리 잡는다 */
.sel-count {
  display: inline-block; min-width: 118px; height: 32px; line-height: 32px;
  font-size: 12.5px; font-weight: 600; color: var(--accent-hover); white-space: nowrap;
}

/* 파일 선택 + [업로드] 를 한 줄에. margin-top:auto 로 두 칸의 줄 높이를 맞춘다. */
.bulk-block-body > .file-row {
  display: flex; align-items: flex-end; gap: 10px; margin-top: auto;
}
.file-row input[type="file"] { flex: 1; min-width: 0; }
.file-row > button.primary { flex-shrink: 0; min-width: 80px; }

/* 신규 자료 등록 입력 묶음 */
.form-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px 14px; margin-bottom: 16px;
}
.form-grid .field > input[type=text], .form-grid .field > select { width: 100%; max-width: none; }
.form-grid .field > label { font-size: 11px; font-weight: 700; color: var(--text-dark-gray); letter-spacing: 0.02em; }
.range { display: flex; gap: 4px; align-items: center; }
.range input { min-width: 0; flex: 1; }

/* ---------- 팝업 ---------- */
.detail-text { white-space: pre-wrap; line-height: 1.6; }
.tree-box { height: 420px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }

.picker-modal :deep(.box.wide) { width: 1180px; max-width: 92vw; }
.picker-grid { height: 440px; display: flex; flex-direction: column; }
.picker-grid > :deep(.dt) { flex: 1; min-height: 0; }

.preview-modal :deep(.box.wide) { width: 96vw; max-width: 1600px; height: 94vh; }
.preview-modal :deep(.box-body) { flex: 1; display: flex; min-height: 0; }
.preview-box {
  flex: 1; min-height: 0; display: flex;
  border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; background: var(--surface-sunken);
}
.preview-box > * { flex: 1; min-width: 0; }

.compare-modal :deep(.box.wide) { width: 96vw; height: 92vh; }
.compare-modal :deep(.box-body) { flex: 1; display: flex; min-height: 0; }
.compare { display: flex; gap: 8px; flex: 1; min-height: 0; }
.side {
  flex: 1; display: flex; flex-direction: column; min-width: 0;
  border: 1px solid var(--border); border-radius: var(--radius);
}
.side-head {
  padding: 6px 10px; font-size: 11.5px;
  border-bottom: 1px solid var(--border); background: var(--surface-alt);
}
.nopdf { padding: 40px 16px; color: var(--text-faint); text-align: center; }
</style>
