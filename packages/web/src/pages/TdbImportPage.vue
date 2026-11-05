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
import Tabs from '@/ui/Tabs.vue'
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

const tab = ref<'register' | 'review' | 'issues'>('review')
const TABS = [
  { key: 'register', label: '반입등록' },
  { key: 'review', label: '검수 대기' },
  { key: 'issues', label: '확인 필요' },
]

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

/** multipart 올리기 — api 클라이언트는 JSON 만 다루므로 fetch 를 직접 쓴다 */
async function postForm<T>(path: string, fd: FormData): Promise<T> {
  const r = await fetch(`/api${path}`, { method: 'POST', body: fd, credentials: 'same-origin' })
  let body: unknown = null
  try {
    body = await r.json()
  } catch {
    body = null
  }
  if (!r.ok) {
    const b = (body ?? {}) as { code?: string; message?: string }
    throw new ApiError(r.status, b.code ?? 'HTTP', b.message ?? `올리지 못했습니다 (${r.status})`)
  }
  return body as T
}

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
  onError: (e) => fail(e),
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
const issueRows = computed(() => issues.value?.items ?? [])
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
  enabled: computed(() => tab.value === 'register'),
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
  enabled: computed(() => tab.value === 'register'),
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
  { key: 'cmp', label: '비교', width: '64px', align: 'center', sortable: false, filterable: false,
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
  { key: 'projectName', label: '공사', width: '110px', align: 'center', render: (i) => i.projectName ?? '' },
  { key: 'vendorName', label: '업체', width: '120px', align: 'center', render: (i) => i.vendorName ?? '' },
  { key: 'displayName', label: '자료명', width: '220px' },
  { key: 'files', label: '파일', width: '150px',
    render: (i) => i.files.map((f) => f.ext.toUpperCase()).join(', ') },
  { key: 'createdAt', label: '업로드일시', width: '130px', align: 'center',
    render: (i) => i.createdAt.slice(0, 16).replace('T', ' ') },
  // 글자값에 사유상세 문장까지 담는다 — 엑셀(기존 '사유' 칸)과 거르기가 이것을 쓴다
  { key: 'reasons', label: '사유', width: '220px',
    render: (i) => `${i.reasons.map(reasonLabel).join(', ')} — ${i.detailText}` },
  { key: 'act', label: '조치', width: '420px', sortable: false, filterable: false, exportable: false, render: () => '' },
]

const PICKER_COLUMNS: Column<PickerRow>[] = [
  { key: 'displayName', label: '자료명', width: '200px' },
  { key: 'title', label: '내용', width: '160px' },
  { key: 'folderPath', label: '경로', width: '220px' },
  { key: 'revAtDistribution', label: '반출Rev', width: '70px', align: 'center',
    render: (t) => `Rev${String(t.revAtDistribution).padStart(2, '0')}` },
  { key: 'exts', label: '보유', width: '120px', align: 'center',
    render: (t) => [t.hasDwg ? 'DWG' : '', t.hasXlsx ? 'XLSX' : '', t.hasEtc ? '기타' : '', t.hasPdf ? 'PDF' : '']
      .filter(Boolean).join(' ') },
  { key: 'distributedAt', label: '반출일', width: '96px', align: 'center', render: (t) => t.distributedAt.slice(0, 10) },
  { key: 'status', label: '상태', width: '96px', align: 'center', render: (t) => PICKER_STATUS[t.status].text },
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
        <h2>반입 Zip</h2>
        <p class="muted">
          반출할 때 받은 Zip(반출목록 엑셀 + 폴더 구조)을 그대로 올리면, 반출목록의 문서ID·업체로
          반출 건을 찾아 폴더·자료명을 대조합니다. 맞는 것은 <strong>검수 대기</strong>로,
          이름·경로가 다르거나 원본/PDF 가 빠진 것은 <strong>확인 필요</strong>로 넘어갑니다.
        </p>
        <div class="bar">
          <input type="file" accept=".zip" :disabled="!canRegister"
                 @change="(e) => (zipFile = (e.target as HTMLInputElement).files?.[0] ?? null)" />
          <button class="btn btn-sm btn-primary" :disabled="!canRegister || !zipFile || zipBusy" @click="uploadZip">
            반입
          </button>
        </div>
        <JobProgress :job-id="zipJobId" @done="onJobDone" @failed="onJobFailed" />

        <h2>반입 자료 (Zip 없이)</h2>
        <p class="muted">
          업체·공사를 고르고 [자료검색]으로 반입할 도면을 체크한 뒤(또는 반출 Zip 묶음을 고른 뒤)
          원본과 PDF 를 올립니다. 폴더 정보가 없으므로 파일 이름(도면번호)으로 배정합니다.
          Zip 을 올려도 풀어서 이름으로 배정합니다.
        </p>
        <div class="form-grid">
          <label>공사
            <select v-model="sel.projectKey" @change="resetSelTargets">
              <option value="">공사 선택</option>
              <option v-for="[k, p] in projectChoices" :key="k" :value="k">
                {{ p.name }} (반입 미완료 {{ p.count }}건)
              </option>
            </select>
          </label>
          <label>업체
            <select v-model="sel.vendorName" @change="resetSelTargets">
              <option value="">업체 선택</option>
              <option v-for="[v, n] in vendorChoices" :key="v" :value="v">{{ v }} (반입 미완료 {{ n }}건)</option>
            </select>
          </label>
          <label>반출일
            <span class="range">
              <input v-model="sel.dateFrom" type="date" /> ~ <input v-model="sel.dateTo" type="date" />
            </span>
          </label>
          <label>반출 Zip 묶음
            <select v-model="sel.zipName" @change="sel.distributions = []">
              <option value="">(자료검색으로 고름)</option>
              <option v-for="[z, n] in zipChoices" :key="z" :value="z">{{ z }} ({{ n }}건)</option>
            </select>
          </label>
        </div>
        <div class="bar">
          <button class="btn btn-sm" :disabled="!canRegister" @click="searchTargets">자료검색</button>
          <span class="muted small">
            <template v-if="sel.zipName">Zip 묶음 '{{ sel.zipName }}' 의 반출 건 전체</template>
            <template v-else>선택된 도면: {{ sel.distributions.length }}건</template>
          </span>
          <span v-if="sel.distributions.length && !sel.zipName" class="muted small ellipsis">
            {{ sel.distributions.slice(0, 5).map((d) => d.name).join(', ') }}{{ sel.distributions.length > 5 ? ' …' : '' }}
          </span>
        </div>
        <div class="bar">
          <input ref="selInput" type="file" multiple :disabled="!canRegister"
                 @change="(e) => (selFiles = (e.target as HTMLInputElement).files)" />
          <button class="btn btn-sm btn-primary" :disabled="!canRegister" @click="uploadSelection">반입</button>
        </div>
        <JobProgress :job-id="selJobId" @done="onJobDone" @failed="onJobFailed" />

        <h2>신규 자료 등록</h2>
        <p class="muted">
          공유폴더에 없던 자료를 새로 만듭니다. CM 이 직접 올리는 것이라 검수 없이 Rev00 으로 바로 등록됩니다.
          원본과 PDF 를 함께 올려야 하고(D-19), 자료명에는 리비전 표기를 적지 않습니다 — 시스템이 붙입니다.
        </p>
        <div class="form-grid">
          <label>폴더 *
            <span class="range">
              <input type="text" readonly :value="nf.folder?.name ?? ''" placeholder="폴더를 고르세요" />
              <button class="btn btn-sm" @click="folderPickOpen = true">고르기</button>
            </span>
          </label>
          <label>자료명(도면번호) * <input v-model="nf.drawingNo" type="text" maxlength="200" /></label>
          <label>내용 <input v-model="nf.title" type="text" maxlength="500" placeholder="비우면 자료명" /></label>
          <label>대분류 <input v-model="nf.category" type="text" maxlength="100" /></label>
          <label>공종 <input v-model="nf.discipline" type="text" maxlength="100" /></label>
          <label>도면종류 <input v-model="nf.docType" type="text" maxlength="100" /></label>
          <label>ISBL/OSBL <input v-model="nf.isblOsbl" type="text" maxlength="50" /></label>
          <label>지상/지하 <input v-model="nf.elevation" type="text" maxlength="50" /></label>
          <label>구역 <input v-model="nf.area" type="text" maxlength="100" /></label>
          <label>업체
            <select v-model="nf.vendorName">
              <option value="">(없음)</option>
              <option v-for="v in options?.vendors ?? []" :key="v.id" :value="v.name">{{ v.name }}</option>
            </select>
          </label>
          <label>공사
            <select v-model="nf.projectId">
              <option value="">(없음)</option>
              <option v-for="p in options?.projects ?? []" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
            </select>
          </label>
        </div>
        <div class="bar">
          <input ref="nfInput" type="file" multiple accept=".pdf,.dwg,.dxf,.xlsx,.xls,.docx,.pptx"
                 :disabled="!canRegister" @change="(e) => (nfFiles = (e.target as HTMLInputElement).files)" />
          <button class="btn btn-sm btn-primary" :disabled="!canRegister || nfBusy" @click="registerNew">등록</button>
        </div>
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

          <template #cell:cmp="{ row }">
            <!-- PDF 가 없어 비교할 것이 없어도 단추는 남기고 눌리지 않게만 한다 -->
            <button class="btn btn-sm" :disabled="!row.files.some((f) => f.fileExt === 'pdf')"
                    @click.stop="compareGroup(row)">비교</button>
          </template>
        </DataTable>
      </section>

      <!-- 확인 필요 -->
      <section v-else class="pad grid-tab">
        <div class="bar">
          <span class="muted">
            반입 중 자료를 확정하지 못했거나 문제가 있는 항목입니다. 파일은 보관돼 있으니 사라지지 않습니다.
          </span>
          <span style="flex:1" />
          <button class="btn btn-sm" :disabled="!issueSelected.size || !canRecheck || busy"
                  @click="recheck([...issueSelected])">선택 재검수</button>
          <button class="btn btn-sm" :disabled="!issueSelected.size || !canDiscard || busy"
                  @click="discardIds = [...issueSelected]">선택 반려</button>
        </div>
        <DataTable
          :columns="ISSUE_COLUMNS" :rows="issueRows" :total="issueRows.length"
          selectable :selected="issueSelected" :loading="issuesFetching && !issueRows.length"
          :row-class="(i) => (i.reasons.includes('ALREADY_IMPORTED') ? '' : 'warn')"
          storage-key="import-issues-v2" excel-name="TDB 확인필요"
          empty-text="확인이 필요한 자료가 없습니다."
          @toggle="toggleIssue"
          @toggle-all="(on) => { issueSelected = on ? new Set(issueRows.map((i) => i.id)) : new Set() }"
        >
          <template #cell:displayName="{ row }">
            <span :title="row.folderPath ?? ''">{{ row.displayName }}</span>
          </template>

          <template #cell:files="{ row }">
            <span v-for="(f, n) in row.files" :key="n" class="chip"
                  :title="`${f.folder ? f.folder + '/' : ''}${f.filename}`">
              {{ f.ext.toUpperCase() || '?' }}{{ f.byteSize !== null ? ' ' + size(f.byteSize) : '' }}
            </span>
          </template>

          <template #cell:reasons="{ row }">
            <span v-for="c in row.reasons" :key="c" class="badge" :class="reasonClass(c)">{{ reasonLabel(c) }}</span>
          </template>

          <template #cell:act="{ row }">
            <button class="btn btn-sm" @click.stop="detailIssue = row">사유상세</button>
            <button class="btn btn-sm" :disabled="!row.hasPdf || row.suggestedDocumentId === null"
                    title="대상 도면이 정해져 있고 받은 파일에 PDF 가 있을 때 비교할 수 있습니다"
                    @click.stop="compareIssue(row)">비교</button>
            <button class="btn btn-sm" :disabled="!canReattach"
                    @click.stop="reattachIssue = row">자료 재첨부</button>
            <button class="btn btn-sm" :disabled="!canRepath" @click.stop="openRepath(row)">경로 재선택</button>
            <button class="btn btn-sm btn-primary" :disabled="!canRecheck || busy"
                    @click.stop="recheck([row.id])">재검수</button>
            <button class="btn btn-sm" :disabled="!canDiscard || busy"
                    @click.stop="discardIds = [row.id]">반려</button>
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
        <button v-for="v in (['ALL', 'INCOMPLETE', 'REVIEWING', 'DONE'] as const)" :key="v"
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
.import { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
/* 일부만 확인 필요로 간 결과 — 성공도 실패도 아니다 */
.msg.warn { background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn); }
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
.bar { display: flex; gap: var(--gap-sm); align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.sub { font-size: 11px; }
.ellipsis { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip {
  display: inline-block; font-size: 11px; padding: 1px 6px; margin-right: 3px;
  border: 1px solid var(--border-strong); border-radius: 9px;
}
.tag {
  display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 8px;
  background: var(--accent); color: var(--primary-fg); margin-right: 3px;
}
.tag.warn-tag { background: var(--warn); }
.badge { margin-right: 3px; }

.form-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px 14px; margin-bottom: 10px; max-width: 980px;
}
.form-grid label { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-sm); color: var(--fg-muted); }
.form-grid input[type=text], .form-grid select { width: 100%; }
.range { display: flex; gap: 4px; align-items: center; }
.range input { min-width: 0; flex: 1; }

.detail-text { white-space: pre-wrap; line-height: 1.6; }
.tree-box { height: 420px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r); }

.picker-modal :deep(.box.wide) { width: 1100px; }
.picker-grid { height: 440px; display: flex; flex-direction: column; }
.picker-grid > :deep(.dt) { flex: 1; min-height: 0; }

.compare-modal :deep(.box.wide) { width: 96vw; height: 92vh; }
.compare-modal :deep(.box-body) { flex: 1; display: flex; min-height: 0; }
.compare { display: flex; gap: var(--sp-2); flex: 1; min-height: 0; }
.side { flex: 1; display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border); border-radius: var(--r); }
.side-head { padding: 6px 10px; font-size: var(--fs-sm); border-bottom: 1px solid var(--border); background: var(--surface-2); }
.nopdf { padding: 40px 16px; color: var(--fg-muted); text-align: center; }
</style>
