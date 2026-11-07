<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  DistributionListResponse, DocumentDetail, DocumentNav, RevisionListResponse, UploadResult,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Tabs from '@/ui/Tabs.vue'
import PdfViewer from '@/ui/PdfViewer.vue'
import DrawingPreview from '@/ui/DrawingPreview.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { DOC_STATUS_LABEL, PURPOSE_LABEL, REVIEW_STATUS_LABEL } from '@/lib/labels'
import { NAV_FROM_LIST, readListNav } from '@/lib/tdbListNav'

/** TDB 자료 상세 — 기존 detail.html 의 4개 탭을 재현한다. */

const route = useRoute()
const router = useRouter()
const session = useSession()
const qc = useQueryClient()
const canRegister = computed(() => session.can('screen.tdb_import.register'))

const id = computed(() => Number(route.params.id))
const tab = ref<'info' | 'preview' | 'revisions' | 'distributions'>('info')

const TABS = [
  { key: 'info', label: '자료내용' },
  { key: 'preview', label: '미리보기' },
  { key: 'revisions', label: 'Revision 이력' },
  { key: 'distributions', label: '반출 이력' },
]

const { data: doc, isLoading } = useQuery({
  queryKey: computed(() => qk.documents.detail(id.value)),
  queryFn: () => api.get<DocumentDetail>(`/documents/${id.value}`),
  staleTime: staleTime.detail,
})

// 탭별 지연 조회 — 탭을 열기 전에는 요청하지 않는다
const { data: revisions } = useQuery({
  queryKey: computed(() => [...qk.documents.detail(id.value), 'revisions']),
  queryFn: () => api.get<RevisionListResponse>(`/documents/${id.value}/revisions`),
  enabled: computed(() => tab.value === 'revisions'),
  staleTime: staleTime.detail,
})

const { data: distributions } = useQuery({
  queryKey: computed(() => [...qk.documents.detail(id.value), 'distributions']),
  queryFn: () => api.get<DistributionListResponse>(`/documents/${id.value}/distributions`),
  // 반입등록 칸의 업체 후보도 반출 이력에서 뽑는다
  enabled: computed(() => tab.value === 'distributions' || (tab.value === 'info' && canRegister.value)),
  staleTime: staleTime.detail,
})

// ── 처음·이전·다음·끝 ───────────────────────────────────────────────────
// 기존 detail.js 처럼 **방금 다녀온 목록의 순서**를 따른다. 목록이 남겨 둔 검색조건·정렬로
// 서버에 "몇 번째인가" 만 묻는다. 목록을 거치지 않고 바로 왔으면(주소 직접 입력·다른 화면의
// 링크) 순서를 알 수 없어 버튼을 모두 끈다 — 엉뚱한 순서로 넘어가는 것보다 낫다.
const fromList = computed(() => route.query.from === NAV_FROM_LIST)
const listNav = computed(() => (fromList.value ? readListNav() : null))

const { data: nav } = useQuery({
  queryKey: computed(() => [...qk.documents.detail(id.value), 'nav', listNav.value]),
  queryFn: () => api.get<DocumentNav>(`/documents/nav${qs({ ...listNav.value, id: id.value })}`),
  enabled: computed(() => listNav.value !== null),
  staleTime: staleTime.list,
})
const navPos = computed(() => (nav.value?.position ?? null))
const navOn = computed(() => navPos.value !== null && (nav.value?.total ?? 0) > 1)

function goDoc(docId: number | null | undefined) {
  if (!docId || docId === id.value) return
  void router.push({ path: `/documents/${docId}`, query: { from: NAV_FROM_LIST } })
}

/** "n / 전체" 칸 — 번호를 넣고 Enter. 범위를 넘으면 끝으로 붙인다 */
const posInput = ref('')
watch(navPos, (p) => (posInput.value = p === null ? '' : String(p)), { immediate: true })
async function jumpTo() {
  const n = Number(posInput.value)
  if (!listNav.value || !Number.isInteger(n) || n < 1) {
    posInput.value = navPos.value === null ? '' : String(navPos.value)
    return
  }
  try {
    const r = await api.get<DocumentNav>(`/documents/nav${qs({ ...listNav.value, at: n })}`)
    goDoc(r.currentId)
    if (r.currentId === id.value) posInput.value = String(navPos.value ?? '')
  } catch {
    posInput.value = navPos.value === null ? '' : String(navPos.value)
  }
}

// ── 미리보기: 어느 Rev 를 볼 것인가 ───────────────────────────────────
// 기본은 현재 Rev. 예전에는 현재본에 PDF 가 없으면 아무 PDF 나 띄웠다 — DWG 만 반입·승인한
// 자료가 옛 Rev(반려본 포함) 도면을 최신인 양 보여 줬다. 그래서 옛 Rev 는 사용자가 고를 때만
// 열고, 열면 '이전 Rev 도면입니다' 띠를 붙인다.
// 고객 시스템(detail.js renderRevTable)은 Revision 이력 표의 돋보기로 그 Rev 세트
// (같은 rev 로 함께 올라온 원본+PDF)를 미리보기 창에 띄우고 이전/다음으로 넘겨 본다.
// 여기서는 미리보기 탭의 Rev 고르기 + ◀▶ 로 같은 일을 한다(이력 표 돋보기도 이리로 온다).
const isPdf = (f: FileRow) => f.fileExt.toLowerCase() === 'pdf'
const hasExt = (ext: string) => (f: FileRow) => f.fileExt.toLowerCase() === ext
const revKey = (rev: number, branch: string | null) => `${rev}|${branch ?? ''}`
const revText = (rev: number, branch: string | null) => `Rev${rev}${branch ? `-${branch}` : ''}`

interface RevSet {
  key: string
  label: string
  isCurrent: boolean
  /** 세트의 검수 상태 — 하나라도 승인이 아니면 그 상태(반려·검수대기…)를 보인다 */
  status: string
  files: FileRow[]
  pdf: FileRow | undefined
  /** 원본 도면 — 서버가 PDF 로 바꿔 보여 준다(고객 시스템 D-102 의 [원본] 보기). DWG 를 먼저 */
  drawing: FileRow | undefined
}

/** 파일을 Rev 세트로 묶는다 — 서버가 rev DESC 로 주므로 최신 Rev 가 먼저 */
const revSets = computed<RevSet[]>(() => {
  const map = new Map<string, FileRow[]>()
  for (const f of doc.value?.files ?? []) {
    const k = revKey(f.rev, f.branch)
    map.set(k, [...(map.get(k) ?? []), f])
  }
  return [...map.entries()].map(([key, files]) => {
    const f0 = files[0]!
    const notOk = files.find((f) => f.reviewStatus !== 'APPROVED')
    return {
      key,
      label: revText(f0.rev, f0.branch),
      isCurrent: files.some((f) => f.isCurrent),
      status: REVIEW_STATUS_LABEL[notOk?.reviewStatus ?? 'APPROVED'] ?? notOk?.reviewStatus ?? '승인',
      files,
      pdf: files.find(isPdf),
      drawing: files.find(hasExt('dwg')) ?? files.find(hasExt('dxf')),
    }
  })
})
const canPreviewSet = (s: RevSet | undefined) => !!s && (!!s.pdf || !!s.drawing)

/** 고른 Rev — null 이면 현재 Rev */
const previewRevKey = ref<string | null>(null)
const currentSet = computed(() => revSets.value.find((s) => s.isCurrent))
const selectedSet = computed(() =>
  (previewRevKey.value && revSets.value.find((s) => s.key === previewRevKey.value)) || currentSet.value)
const isOldRev = computed(() => !!selectedSet.value && !selectedSet.value.isCurrent)
const selFiles = computed(() => selectedSet.value?.files ?? [])
const previewFile = computed(() => selectedSet.value?.pdf)
const selDrawing = computed(() => selectedSet.value?.drawing)
/** Rev 고르기 칸 — 바꿀 때 사본(PDF)부터 다시 보인다 */
const selKeyModel = computed({
  get: () => selectedSet.value?.key ?? '',
  set: (k: string) => openRev(k),
})
/** ◀ 이전 Rev(더 옛것) / 다음 Rev ▶(더 새것) — 목록은 최신이 앞이다 */
const selIdx = computed(() => revSets.value.findIndex((s) => s.key === selectedSet.value?.key))
const olderSet = computed(() => (selIdx.value >= 0 ? revSets.value[selIdx.value + 1] : undefined))
const newerSet = computed(() => (selIdx.value > 0 ? revSets.value[selIdx.value - 1] : undefined))

function openRev(key: string | null) {
  previewRevKey.value = key && key !== currentSet.value?.key ? key : null
  previewSource.value = 'pdf'
}

/** Revision 이력 표의 돋보기 — 그 Rev 를 미리보기 탭에서 연다 */
function previewRevRow(row: RevRow) {
  openRev(revKey(row.rev, row.branch))
  tab.value = 'preview'
}

/** PDF 사본과 원본 도면이 둘 다 있으면 고를 수 있다. 기본은 사본(PDF) */
const previewSource = ref<'pdf' | 'drawing'>('pdf')
const showDrawing = computed(() =>
  !!selDrawing.value && (previewSource.value === 'drawing' || !previewFile.value))

watch(id, () => {
  tab.value = 'info'
  noteMsg.value = null
  previewRevKey.value = null
  previewSource.value = 'pdf'
  resetUpload()
})

// ── 반입등록 (개별 자료) ─────────────────────────────────────────────
// 반입·검수 화면이 "자료를 찾아 상세 화면에서 올린다"고 안내하는 자리다.
// 업체 이름으로 리비전·분기가 정해지므로(서버 determineRevBranch) 업체는 반드시 받는다.
const UPLOAD_ACCEPT = '.dwg,.dxf,.pdf,.xlsx,.xls,.docx,.pptx'

const uploadVendor = ref('')
const uploadFiles = ref<File[]>([])
const uploadInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadMsg = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

/** 아직 돌아오지 않은 반출의 업체 — 대개 이 중 하나가 반입한다 */
const vendorCandidates = computed(() => [
  ...new Set((distributions.value?.items ?? [])
    .filter((x) => x.state === 'OUTSTANDING')
    .map((x) => x.vendorName)),
])

function resetUpload() {
  uploadVendor.value = ''
  uploadFiles.value = []
  if (uploadInput.value) uploadInput.value.value = ''
}

function pickFiles(ev: Event) {
  uploadFiles.value = [...((ev.target as HTMLInputElement).files ?? [])]
}

async function submitUpload() {
  const vendor = uploadVendor.value.trim()
  if (!vendor || !uploadFiles.value.length || uploading.value) return
  // 필드를 파일보다 먼저 넣는다 — 서버는 파트를 순서대로 읽는다
  const fd = new FormData()
  fd.append('vendorName', vendor)
  for (const f of uploadFiles.value) fd.append('file', f)

  uploading.value = true
  uploadMsg.value = null
  try {
    const out = (await api.upload<UploadResult>(`/documents/${id.value}/revisions`, fd)).body
    uploadMsg.value = {
      kind: out.warning || out.branched ? 'err' : 'ok',
      text: `${out.created}개 파일을 ${out.revLabel} 로 반입했습니다. 검수 대기로 넘어갑니다.`
        + (out.branched ? ' (중복반출로 분기됨)' : '')
        + (out.warning ? ' — 파일명의 업체 표기 Rev 가 다릅니다. 검수 때 확인하세요.' : ''),
    }
    resetUpload()
    void qc.invalidateQueries({ queryKey: qk.documents.detail(id.value) })
    void qc.invalidateQueries({ queryKey: ['pending-review'] })
  } catch (e) {
    uploadMsg.value = {
      kind: 'err',
      text: e instanceof ApiError ? e.message : '올리지 못했습니다. 연결을 확인하세요.',
    }
  } finally {
    uploading.value = false
  }
}

// ── 비고 작성 (Revision 이력 / 반출 이력) ─────────────────────────────
// 칸을 벗어나면(change) 저장한다. 권한이 없으면 칸을 잠근다 — 서버도 같은 권한으로 막는다.
const canRevNote = computed(() => session.can('common.note_edit.revision'))
const canDistNote = computed(() => session.can('common.note_edit.distribution'))
const noteMsg = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

async function saveNote(path: string, body: Record<string, unknown>, which: 'revisions' | 'distributions') {
  try {
    await api.post(path, body)
    noteMsg.value = { kind: 'ok', text: '비고를 저장했습니다.' }
    void qc.invalidateQueries({ queryKey: [...qk.documents.detail(id.value), which] })
  } catch (e) {
    noteMsg.value = { kind: 'err', text: e instanceof ApiError ? e.message : '비고를 저장하지 못했습니다.' }
  }
}

function saveRevNote(row: RevRow, value: string) {
  const note = value.trim() || null
  if (note === (row.note ?? null)) return
  void saveNote(`/documents/${id.value}/revisions/${row.rev}/note`, { note, branch: row.branch }, 'revisions')
}

function saveDistNote(row: DistRow, value: string) {
  const note = value.trim() || null
  if (note === (row.note ?? null)) return
  void saveNote(`/distributions/${row.id}/note`, { note }, 'distributions')
}

const STATUS_LABEL = DOC_STATUS_LABEL
const DIST_STATE: Record<string, string> = {
  RETURNED: '반입완료', OUTSTANDING: '반입미완료',
  ISSUE: '확인필요', PENDING_REVIEW: '검수대기',
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

// ── 표 칸 ──────────────────────────────────────────────────────────────
// render 는 **글자값**이다 — 거르기·엑셀이 이것을 쓴다. 슬롯은 그리는 법만 바꾼다.
// 여기 표들은 줄이 몇 개뿐이라 autoHeight 로 둔다(빈 상자가 되지 않게).

type FileRow = DocumentDetail['files'][number]
const FILE_COLUMNS: Column<FileRow>[] = [
  { key: 'fileExt', label: '구분', width: '72px', align: 'center',
    render: (f) => f.fileExt.toUpperCase() },
  { key: 'displayName', label: '자료명' },
  { key: 'rev', label: 'Rev', width: '86px', align: 'center',
    render: (f) => `Rev${f.rev}${f.branch ? `-${f.branch}` : ''}` },
  { key: 'byteSize', label: '크기', width: '90px', align: 'right', render: (f) => size(f.byteSize) },
  { key: 'reviewStatus', label: '검수상태', width: '90px', align: 'center',
    render: (f) => (f.reviewStatus === 'APPROVED' ? '승인' : f.reviewStatus) },
  { key: 'uploadedAt', label: '업로드일시', width: '110px', align: 'center',
    render: (f) => f.uploadedAt.slice(0, 10) },
  { key: 'act', label: '조치', width: '80px', align: 'center', sortable: false, filterable: false, render: () => '' },
]

/**
 * Revision 이력에는 id 가 없다 — 열쇠는 label(Rev03-A 같은 것)이다.
 * 그리드는 줄을 숫자 id 로 가리므로 목록 안 위치를 쓴다.
 * 목록이 통째로 다시 올 때만 바뀌어 줄이 섞일 일이 없다.
 */
type RevRow = RevisionListResponse['items'][number] & { id: number }

/**
 * [승인만 보기] — 기본 켜짐(기존 detail.js). 끄면 반려·검수대기 리비전까지 전부 보인다.
 * 리비전 하나의 파일이 모두 승인돼 있어야 승인된 리비전이다.
 */
const approvedOnly = ref(true)
const isApproved = (r: RevisionListResponse['items'][number]) =>
  r.files.every((f) => f.reviewStatus === 'APPROVED')
const revRows = computed<RevRow[]>(() =>
  (revisions.value?.items ?? [])
    .filter((r) => !approvedOnly.value || isApproved(r))
    .map((r, i) => ({ ...r, id: i + 1 })),
)
const revAll = computed(() => revisions.value?.items.length ?? 0)

const REV_COLUMNS: Column<RevRow>[] = [
  // 고객 시스템의 줄마다 돋보기 — 그 Rev 의 도면을 미리보기 탭에서 연다
  { key: 'view', label: '보기', width: '56px', align: 'center', sortable: false, filterable: false,
    render: () => '' },
  // 엑셀에도 "최신본"이 나가야 화면과 같은 뜻이 된다
  { key: 'label', label: 'Rev', width: '110px', align: 'center',
    render: (r) => (r.isCurrent ? `${r.label} 최신본` : r.label) },
  { key: 'createdAt', label: '등록일시', width: '130px', align: 'center',
    render: (r) => r.createdAt.slice(0, 16).replace('T', ' ') },
  { key: 'createdBy', label: '등록자', width: '100px', align: 'center', render: (r) => r.createdBy ?? '' },
  { key: 'reason', label: '사유', render: (r) => r.reason ?? '' },
  { key: 'files', label: '보유 파일', width: '130px',
    render: (r) => r.files.map((f) => f.fileExt.toUpperCase()).join(', ') },
  { key: 'note', label: '비고', width: '180px', render: (r) => r.note ?? '' },
]

type DistRow = DistributionListResponse['items'][number]
const DIST_COLUMNS: Column<DistRow>[] = [
  { key: 'revAtDistribution', label: '반출Rev', width: '86px', align: 'center',
    render: (x) => `Rev${x.revAtDistribution}` },
  { key: 'vendorName', label: '업체', width: '140px' },
  { key: 'projectName', label: '공사', width: '120px', render: (x) => x.projectName ?? '' },
  { key: 'purpose', label: '목적', width: '92px', align: 'center',
    render: (x) => PURPOSE_LABEL[x.purpose] ?? x.purpose },
  { key: 'distributedBy', label: '반출자', width: '100px', align: 'center', render: (x) => x.distributedBy ?? '' },
  { key: 'distributedAt', label: '반출일시', width: '104px', align: 'center',
    render: (x) => x.distributedAt.slice(0, 10) },
  { key: 'returnedAt', label: '반입일시', width: '104px', align: 'center',
    render: (x) => (x.returnedAt ? x.returnedAt.slice(0, 10) : '') },
  { key: 'state', label: '상태', width: '100px', align: 'center',
    render: (x) => DIST_STATE[x.state] ?? x.state },
  { key: 'note', label: '비고', width: '170px', render: (x) => x.note ?? '' },
]
</script>

<template>
  <main class="app-main detail">
    <div v-if="isLoading" class="panel pad muted">불러오는 중…</div>

    <template v-else-if="doc">
      <div class="panel head">
        <h1>TDB 자료 상세 보기</h1>
        <span style="flex:1" />
        <span class="nav" :title="navOn ? '' : '목록에서 들어왔을 때만 넘겨볼 수 있습니다'">
          <button class="btn btn-sm" title="맨 처음 자료" :disabled="!navOn || navPos === 1"
                  @click="goDoc(nav?.firstId)">◀◀ 처음</button>
          <button class="btn btn-sm" title="이전 자료" :disabled="!navOn || !nav?.prevId"
                  @click="goDoc(nav?.prevId)">◀ 이전</button>
          <span v-if="navOn" class="nav-count">
            <input v-model="posInput" type="text" inputmode="numeric" class="nav-pos"
                   title="번호를 입력하고 Enter" @keydown.enter="jumpTo"
                   @blur="posInput = navPos === null ? '' : String(navPos)" />
            / {{ nav?.total }}
          </span>
          <button class="btn btn-sm" title="다음 자료" :disabled="!navOn || !nav?.nextId"
                  @click="goDoc(nav?.nextId)">다음 ▶</button>
          <button class="btn btn-sm" title="맨 끝 자료" :disabled="!navOn || navPos === nav?.total"
                  @click="goDoc(nav?.lastId)">끝 ▶▶</button>
        </span>
        <button class="btn btn-sm" @click="router.push('/')">목록으로</button>
      </div>

      <div class="panel body">
        <Tabs v-model="tab" :tabs="TABS" />

        <!-- 자료내용 -->
        <section v-if="tab === 'info'" class="pad">
          <table class="kv">
            <tbody>
              <tr><th>자료명</th><td>{{ doc.drawingNo }}</td><th>현재 Rev</th><td>Rev{{ doc.currentRev }}</td></tr>
              <tr><th>내용</th><td colspan="3">{{ doc.title }}</td></tr>
              <tr>
                <th>경로</th>
                <td colspan="3">{{ doc.folderPath.map(f => f.name).join(' › ') }}</td>
              </tr>
              <tr><th>분류</th><td>{{ doc.docType ?? '-' }}</td><th>공종</th><td>{{ doc.discipline ?? '-' }}</td></tr>
              <tr><th>ISBL/OSBL</th><td>{{ doc.isblOsbl ?? '-' }}</td><th>구역</th><td>{{ doc.area ?? '-' }}</td></tr>
              <tr><th>설비 Tag</th><td>{{ doc.equipmentTag ?? '-' }}</td><th>공사</th><td>{{ doc.projectName ?? '-' }}</td></tr>
              <tr>
                <th>상태</th>
                <td>{{ STATUS_LABEL[doc.status] ?? doc.status }}</td>
                <th>대여</th>
                <td>{{ doc.lentTo ? `${doc.lentTo} (${doc.lentAt?.slice(0,10)})` : '-' }}</td>
              </tr>
              <tr><th>비고</th><td colspan="3">{{ doc.note ?? '-' }}</td></tr>
            </tbody>
          </table>

          <h2>보유 자료</h2>
          <DataTable
            :columns="FILE_COLUMNS" :rows="doc.files" :total="doc.files.length"
            auto-height :max-height="320"
            :row-class="(f) => (f.isCurrent ? 'cur' : '')"
            storage-key="detail-files" :excel-name="`${doc.drawingNo} 보유자료`"
            empty-text="보유 자료가 없습니다."
          >
            <template #cell:act="{ row }">
              <a class="btn btn-sm" :href="`/api/files/${row.id}/download`" @click.stop>받기</a>
            </template>
          </DataTable>

          <template v-if="canRegister">
            <h2>반입등록 (개별 자료)</h2>
            <p class="muted small">
              업체가 수정해 보낸 DWG·PDF 등을 이 자료의 새 Rev 로 올립니다. 올린 파일은 검수 대기로 넘어갑니다.
            </p>
            <div class="upload">
              <input v-model="uploadVendor" type="text" list="upload-vendors" placeholder="반입 업체 (필수)"
                     style="width:200px" :disabled="uploading" />
              <datalist id="upload-vendors">
                <option v-for="v in vendorCandidates" :key="v" :value="v" />
              </datalist>
              <input ref="uploadInput" type="file" multiple :accept="UPLOAD_ACCEPT"
                     :disabled="uploading" @change="pickFiles" />
              <button class="btn btn-sm" :disabled="!uploadVendor.trim() || !uploadFiles.length || uploading"
                      @click="submitUpload">{{ uploading ? '올리는 중…' : '반입등록' }}</button>
            </div>
            <div v-if="uploadMsg" class="upload-msg" :class="uploadMsg.kind">{{ uploadMsg.text }}</div>
          </template>
        </section>

        <!-- 미리보기 -->
        <section v-else-if="tab === 'preview'" class="preview">
          <!-- Rev 고르기(이전 Rev 도면도 여기서) + 원본 도면이 있으면 사본(PDF)·원본 고르기 -->
          <div v-if="revSets.length" class="source-bar">
            <button class="btn btn-sm" title="이전 Rev(더 옛것)" :disabled="!olderSet"
                    @click="olderSet && openRev(olderSet.key)">◀ 이전 Rev</button>
            <select v-model="selKeyModel" class="rev-select" title="볼 Rev 고르기">
              <option v-if="!currentSet" value="" disabled>현재 Rev 파일 없음</option>
              <option v-for="s in revSets" :key="s.key" :value="s.key" :disabled="!canPreviewSet(s)">
                {{ s.label }} ({{ s.status }}){{ s.isCurrent ? ' 최신본' : '' }}{{ canPreviewSet(s) ? '' : ' — 볼 도면 없음' }}
              </option>
            </select>
            <button class="btn btn-sm" title="다음 Rev(더 새것)" :disabled="!newerSet"
                    @click="newerSet && openRev(newerSet.key)">다음 Rev ▶</button>
            <template v-if="selDrawing && previewFile">
              <span class="sep" />
              <button class="btn btn-sm" :class="{ 'btn-primary': !showDrawing }"
                      @click="previewSource = 'pdf'">PDF 사본</button>
              <button class="btn btn-sm" :class="{ 'btn-primary': showDrawing }"
                      @click="previewSource = 'drawing'">{{ selDrawing.fileExt.toUpperCase() }} 원본</button>
            </template>
          </div>
          <div v-if="isOldRev && selectedSet" class="old-pdf-bar">
            <b>이전 Rev 도면입니다</b> — {{ selectedSet.label }} ({{ selectedSet.status }}).
            현재 Rev{{ doc.currentRev }} 과 다를 수 있습니다.
            <button class="btn btn-sm" @click="openRev(null)">최신본 보기</button>
          </div>
          <DrawingPreview v-if="showDrawing && selDrawing" :key="selDrawing.id"
                          :file-id="selDrawing.id" :document-id="doc.id"
                          :label="`Rev${selDrawing.rev} ${selDrawing.fileExt.toUpperCase()}`" />
          <PdfViewer v-else-if="previewFile" :key="previewFile.id" :file-id="previewFile.id" :document-id="doc.id" />
          <div v-else class="pad muted tc">
            <template v-if="isOldRev">{{ selectedSet?.label }} 에는 볼 수 있는 도면(PDF·DWG)이 없습니다.</template>
            <template v-else>현재 Rev{{ doc.currentRev }} 에는 PDF 가 없습니다 — 원본을 받아 CAD 에서 여세요.</template>
            <div v-if="selFiles.length" style="margin-top:12px">
              <a v-for="f in selFiles" :key="f.id" class="btn btn-sm btn-primary"
                 :href="`/api/files/${f.id}/download`" style="margin:0 4px">
                {{ revText(f.rev, f.branch) }} {{ f.fileExt.toUpperCase() }} 받기
              </a>
            </div>
            <div v-if="canRegister && !isOldRev" style="margin-top:8px">
              미리보기가 필요하면 '자료내용' 탭 반입등록에서 DWG 또는 PDF 를 올리세요.
            </div>
            <div v-if="revSets.some((s) => !s.isCurrent && canPreviewSet(s))" style="margin-top:8px">
              이전 Rev 도면은 위의 Rev 고르기나 'Revision 이력' 탭의 돋보기로 볼 수 있습니다.
            </div>
          </div>
        </section>

        <!-- Revision 이력 -->
        <section v-else-if="tab === 'revisions'" class="pad grid-tab">
          <div class="tab-bar">
            <label class="chk">
              <input v-model="approvedOnly" type="checkbox" /> 승인만 보기
            </label>
            <span v-if="approvedOnly && revAll > revRows.length" class="muted small">
              (전체 {{ revAll }}건 중 승인 {{ revRows.length }}건)
            </span>
            <span style="flex:1" />
            <span v-if="noteMsg" class="note-msg" :class="noteMsg.kind">{{ noteMsg.text }}</span>
          </div>
          <DataTable
            :columns="REV_COLUMNS" :rows="revRows" :total="revRows.length"
            :row-class="(r) => (r.isCurrent ? 'cur' : '')"
            storage-key="detail-revisions" :excel-name="`${doc.drawingNo} Revision 이력`"
            :empty-text="approvedOnly && revAll ? '승인된 Revision 이 없습니다. [승인만 보기] 를 끄면 전부 보입니다.' : 'Revision 이력이 없습니다.'"
          >
            <template #cell:label="{ row }">
              <span>{{ row.label }}</span>
              <span v-if="row.isCurrent" class="tag">최신본</span>
            </template>

            <template #cell:view="{ row }">
              <button class="btn btn-sm icon" :disabled="!canPreviewSet(revSets.find((s) => s.key === revKey(row.rev, row.branch)))"
                      :title="canPreviewSet(revSets.find((s) => s.key === revKey(row.rev, row.branch))) ? `${row.label} 미리보기` : '볼 도면(PDF·DWG) 없음'"
                      @click.stop="previewRevRow(row)">🔍</button>
            </template>

            <template #cell:note="{ row }">
              <input type="text" :value="row.note ?? ''" :placeholder="canRevNote ? '비고' : ''"
                     :disabled="!canRevNote" :title="canRevNote ? '' : '비고 작성 권한이 없습니다'"
                     style="width:100%" @click.stop
                     @change="saveRevNote(row, ($event.target as HTMLInputElement).value)" />
            </template>
          </DataTable>
        </section>

        <!-- 반출 이력 -->
        <section v-else class="pad grid-tab">
          <div v-if="noteMsg" class="tab-bar">
            <span style="flex:1" />
            <span class="note-msg" :class="noteMsg.kind">{{ noteMsg.text }}</span>
          </div>
          <DataTable
            :columns="DIST_COLUMNS" :rows="distributions?.items ?? []"
            :total="distributions?.items.length ?? 0"
            :row-class="(x) => (x.state === 'OUTSTANDING' || x.state === 'ISSUE' ? 'warn' : '')"
            storage-key="detail-distributions" :excel-name="`${doc.drawingNo} 반출이력`"
            empty-text="반출 이력이 없습니다."
          >
            <template #cell:note="{ row }">
              <input type="text" :value="row.note ?? ''" :placeholder="canDistNote ? '비고' : ''"
                     :disabled="!canDistNote" :title="canDistNote ? '' : '비고 작성 권한이 없습니다'"
                     style="width:100%" @click.stop
                     @change="saveDistNote(row, ($event.target as HTMLInputElement).value)" />
            </template>
          </DataTable>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.body > section { flex: 1; overflow: auto; min-height: 0; }
.pad { padding: 14px; }

/* 그리드 하나만 있는 절은 스크롤을 그리드에 맡긴다 — 바깥이 한 번 더 스크롤되면
   머리글 고정이 깨진다. '자료내용' 절은 위에 kv 표가 있어 그대로 둔다
   (거기 그리드는 auto-height 라 줄 수만큼만 차지한다). */
.body > section.grid-tab {
  display: flex; flex-direction: column;
  min-height: 0; flex: 1; overflow: hidden;
}
.grid-tab > :deep(.dt) { flex: 1; min-height: 0; }
.preview { display: flex; flex-direction: column; }
.source-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.source-bar .sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 6px; }
.rev-select { padding: 2px 4px; }
.icon { padding: 0 6px; line-height: 1.4; }
.old-pdf-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  background: var(--warn-bg, #fff4d6); border-bottom: 1px solid var(--border);
}
h2 { font-size: var(--fs-base); margin: 20px 0 8px; }

.kv { border: 1px solid var(--border); }
.kv th, .kv td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.kv th { background: var(--bg); width: 110px; font-weight: 600; white-space: nowrap; }

.upload { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.upload-msg { margin-top: 8px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); }
.upload-msg.err { color: var(--danger, #c0392b); }

.nav { display: flex; align-items: center; gap: 4px; margin-right: 8px; }
.nav-count { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); margin: 0 4px; }
.nav-pos { width: 56px; text-align: right; padding: 2px 4px; }
.tab-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.small { font-size: var(--fs-sm); }
.note-msg { font-size: var(--fs-sm); }
.note-msg.err { color: var(--danger, #c0392b); }

.tag {
  font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 4px;
  background: var(--accent); color: var(--primary-fg);
}
</style>
