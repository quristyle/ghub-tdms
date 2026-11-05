<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  ArchiveBatch, ArchiveListResponse, DocumentListItem, DocumentListResponse,
  ExistingRevLookup, FolderNode, JobCreated, JobDetail, PairFolderCandidateResponse,
  PartialItem, RegisterResult, ReplaceBulkResult, ReplaceResult, ZipRegisterCheck,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import ProjectManager from '@/ui/ProjectManager.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

/** TDB 관리 — 기존 editor.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

const canFolder = computed(() => session.can('screen.tdb_editor.folder'))
const canDocument = computed(() => session.can('screen.tdb_editor.document'))
const canZip = computed(() => session.can('screen.tdb_editor.zip_register'))
const canRetire = computed(() => session.can('screen.tdb_editor.retire'))
const canRestore = computed(() => session.can('screen.tdb_editor.restore'))
const canTrashNote = computed(() => session.can('common.note_edit.tdb_trash'))

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
function say(kind: 'ok' | 'err', text: string) { message.value = { kind, text } }
function fail(e: unknown) { say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.') }

function refreshAll() {
  void qc.invalidateQueries({ queryKey: qk.folders.all })
  void qc.invalidateQueries({ queryKey: qk.documents.all })
  void qc.invalidateQueries({ queryKey: ['archive'] })
}

// ── 트리 · 목록 ───────────────────────────────────────────────────────
const folder = ref<FolderNode | null>(null)
const keyword = ref('')
const includeIsometric = ref(false)

const sort = ref<'updatedAt' | 'drawingNo' | 'title' | 'currentRev'>('updatedAt')
const dir = ref<SortDir>('desc')
function onSort(key: string, d: SortDir) { sort.value = key as typeof sort.value; dir.value = d }

const params = computed(() => ({
  folderId: folder.value?.id,
  q: keyword.value || undefined,
  includeIsometric: includeIsometric.value,
  sort: sort.value,
  dir: dir.value,
  limit: 200,
}))

const { data, isFetching } = useQuery({
  queryKey: computed(() => qk.documents.list(params.value)),
  queryFn: () => api.get<DocumentListResponse>(`/documents${qs(params.value)}`),
  staleTime: staleTime.list,
  placeholderData: (p) => p,
})

const rows = computed(() => data.value?.items ?? [])
const picked = ref(new Set<number>())

function toggle(id: number) {
  picked.value.has(id) ? picked.value.delete(id) : picked.value.add(id)
  picked.value = new Set(picked.value)
}
function toggleAll(on: boolean) {
  for (const r of rows.value) on ? picked.value.add(r.id) : picked.value.delete(r.id)
  picked.value = new Set(picked.value)
}

const columns = computed<Column<DocumentListItem>[]>(() => [
  { key: 'drawingNo', label: '자료명', width: '168px', sortable: true },
  { key: 'title', label: '내용', sortable: true },
  { key: 'folderName', label: '폴더', width: '160px', sortable: false },
  { key: 'currentRev', label: 'Rev', width: '62px', align: 'center', sortable: true,
    render: (r) => `Rev${r.currentRev}` },
  { key: 'updatedAt', label: '최종수정', width: '104px', align: 'center', sortable: true,
    render: (r) => r.updatedAt.slice(0, 10) },
])

// ── 폴더 편집 ─────────────────────────────────────────────────────────
const folderDialog = ref<'create' | 'rename' | 'move' | null>(null)
const folderName = ref('')
const moveTargetId = ref<number | null>(null)

async function submitFolder() {
  const mode = folderDialog.value
  folderDialog.value = null
  try {
    if (mode === 'create') {
      await api.post('/editor/folders', {
        docClass: 'TDB', parentId: folder.value?.id ?? null, name: folderName.value,
      })
      say('ok', `"${folderName.value}" 폴더를 만들었습니다.`)
    } else if (mode === 'rename' && folder.value) {
      await api.patch(`/editor/folders/${folder.value.id}`, { name: folderName.value })
      say('ok', `폴더 이름을 "${folderName.value}" 로 바꿨습니다.`)
    } else if (mode === 'move' && folder.value) {
      const r = await api.post<{ affectedFolders: number }>(
        `/editor/folders/${folder.value.id}/move`, { newParentId: moveTargetId.value },
      )
      say('ok', `폴더를 옮겼습니다. 하위 ${r.affectedFolders}개가 함께 이동했습니다.`)
    }
    refreshAll()
  } catch (e) { fail(e) }
  folderName.value = ''
}

// ── 자료 편집 ─────────────────────────────────────────────────────────
const moveDocsOpen = ref(false)
const docTargetId = ref<number | null>(null)

async function submitMoveDocs() {
  moveDocsOpen.value = false
  if (docTargetId.value === null) return
  try {
    const r = await api.post<{ moved: number; skipped: { reason: string }[] }>(
      '/editor/documents/move',
      { documentIds: [...picked.value], targetFolderId: docTargetId.value },
    )
    say(r.skipped.length ? 'err' : 'ok',
      r.skipped.length
        ? `${r.moved}건 옮기고 ${r.skipped.length}건 건너뜀 — ${r.skipped[0]!.reason}`
        : `${r.moved}건을 옮겼습니다.`)
    picked.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

// ── 보관함 ────────────────────────────────────────────────────────────
const boxOpen = ref<'TRASH' | 'RETIRE' | null>(null)
const boxSel = ref(new Set<number>())

const { data: trashBox } = useQuery({
  queryKey: ['archive', 'TRASH'],
  queryFn: () => api.get<ArchiveListResponse>('/editor/trash'),
  staleTime: staleTime.worklist,
})
const { data: retireBox } = useQuery({
  queryKey: ['archive', 'RETIRE'],
  queryFn: () => api.get<ArchiveListResponse>('/editor/retired'),
  staleTime: staleTime.worklist,
})

const box = computed(() => (boxOpen.value === 'TRASH' ? trashBox.value : retireBox.value))

async function sendTo(kind: 'TRASH' | 'RETIRE', fromFolder: boolean) {
  try {
    const body = fromFolder
      ? { folderId: folder.value?.id ?? null, documentIds: [], reason: null }
      : { documentIds: [...picked.value], folderId: null, reason: null }
    const r = await api.post<{ archived: number }>(
      kind === 'TRASH' ? '/editor/trash' : '/editor/retired', body)
    say('ok', `${kind === 'TRASH' ? '삭제' : '폐기'} 보관함으로 ${r.archived}건을 보냈습니다.`)
    picked.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

async function restoreSelected() {
  const path = boxOpen.value === 'TRASH' ? '/editor/trash/restore' : '/editor/retired/restore'
  try {
    const r = await api.post<{ restored: number; blocked: { reason: string }[] }>(
      path, { batchIds: [...boxSel.value] })
    say(r.blocked.length ? 'err' : 'ok',
      r.blocked.length ? `${r.restored}건 복구, ${r.blocked.length}건 막힘 — ${r.blocked[0]!.reason}`
                       : `${r.restored}건을 복구했습니다.`)
    boxSel.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

const purgeConfirm = ref(false)
async function purgeSelected() {
  purgeConfirm.value = false
  try {
    const r = await api.post<{ purged: number; freedBytes: number }>(
      '/editor/trash/purge', { batchIds: [...boxSel.value], confirm: true })
    say('ok', `${r.purged}건을 완전 삭제했습니다. (${(r.freedBytes / 1024 ** 2).toFixed(1)} MB)`)
    boxSel.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

// ── 원본·사본 폴더 병합 ───────────────────────────────────────────────
const pairOpen = ref(false)
const { data: pairs } = useQuery({
  queryKey: ['pair-folders'],
  queryFn: () => api.get<PairFolderCandidateResponse>('/editor/pair-folders/candidates'),
  enabled: computed(() => pairOpen.value),
})

async function mergePair(p: { parentId: number; dwgFolderId: number; pdfFolderId: number }) {
  try {
    const r = await api.post<{ merged: number }>('/editor/pair-folders/merge', p)
    say('ok', `${r.merged}건을 합쳤습니다.`)
    void qc.invalidateQueries({ queryKey: ['pair-folders'] })
    refreshAll()
  } catch (e) { fail(e) }
}

// ── 파일 올리기 공통 ──────────────────────────────────────────────────
// multipart 라 api 클라이언트 대신 fetch 를 쓴다. 오류 모양은 api 와 같게 맞춘다.
async function postForm<T>(path: string, fd: FormData): Promise<{ status: number; body: T }> {
  const res = await fetch(`/api${path}`, { method: 'POST', body: fd, credentials: 'same-origin' })
  let body: unknown = null
  try { body = await res.json() } catch { /* 빈 응답 */ }
  if (!res.ok) {
    const b = body as { code?: string; message?: string } | null
    throw new ApiError(res.status, b?.code ?? 'NETWORK', b?.message ?? `요청에 실패했습니다 (${res.status})`)
  }
  return { status: res.status, body: body as T }
}

function filesOf(ev: Event): File[] {
  return [...((ev.target as HTMLInputElement).files ?? [])]
}

const busy = ref(false)

// ── 확인창 — 기존 needs_confirmation 흐름 ─────────────────────────────
// 서버가 아무것도 바꾸지 않고 "확인이 필요하다"고 돌려보내면 여기서 묻고, 승인하면 다시 보낸다.
interface Ask { title: string; lines: string[]; partial?: PartialItem[] }
const ask = ref<Ask | null>(null)
let askResolve: ((ok: boolean) => void) | null = null
function confirmAsk(a: Ask): Promise<boolean> {
  ask.value = a
  return new Promise((r) => { askResolve = r })
}
function answer(ok: boolean) {
  ask.value = null
  askResolve?.(ok)
  askResolve = null
}

// 부분 파일(원본·사본 한쪽만) 표 — 엑셀 내려받기는 DataTable 이 화면 그대로 만든다
// (기존 /editor/partial-files/export 와 같은 칸: No·자료명·DWG·XLSX·ETC·PDF)
interface PartialRow { id: number; stem: string; folder: string; dwg: string; xlsx: string; etc: string; pdf: string }
const partialRows = computed<PartialRow[]>(() => (ask.value?.partial ?? []).map((p, i) => {
  const e = p.ext.toLowerCase()
  const bucket = e === 'dwg' || e === 'dxf' ? 'dwg' : e === 'pdf' ? 'pdf' : e === 'xlsx' || e === 'xls' ? 'xlsx' : 'etc'
  return {
    id: i + 1, stem: p.stem, folder: p.folder ?? '',
    dwg: bucket === 'dwg' ? 'O' : '', xlsx: bucket === 'xlsx' ? 'O' : '',
    etc: bucket === 'etc' ? 'O' : '', pdf: bucket === 'pdf' ? 'O' : '',
  }
}))
const partialColumns = computed<Column<PartialRow>[]>(() => [
  { key: 'stem', label: '자료명' },
  ...(partialRows.value.some((r) => r.folder)
    ? [{ key: 'folder', label: '폴더', width: '180px' } as Column<PartialRow>] : []),
  { key: 'dwg', label: 'DWG', width: '58px', align: 'center' },
  { key: 'xlsx', label: 'XLSX', width: '58px', align: 'center' },
  { key: 'etc', label: 'ETC', width: '58px', align: 'center' },
  { key: 'pdf', label: 'PDF', width: '58px', align: 'center' },
])

// ── 자료 이름 변경 ────────────────────────────────────────────────────
const pickedRows = computed(() => rows.value.filter((r) => picked.value.has(r.id)))
const renameOpen = ref(false)
const renameNo = ref('')
const renameTitle = ref('')

function openRename() {
  const d = pickedRows.value[0]
  if (!d || picked.value.size !== 1) { say('err', '자료명 변경은 자료를 1개만 선택했을 때 할 수 있습니다.'); return }
  renameNo.value = d.drawingNo
  renameTitle.value = d.title
  renameOpen.value = true
}

async function submitRename() {
  const d = pickedRows.value[0]
  if (!d) return
  try {
    await api.patch(`/editor/documents/${d.id}`, {
      drawingNo: renameNo.value.trim(), title: renameTitle.value.trim() || renameNo.value.trim(),
    })
    renameOpen.value = false
    say('ok', '자료명을 변경하였습니다.')
    refreshAll()
  } catch (e) { fail(e) }
}

// ── 자료 교체 · 일괄 교체 ─────────────────────────────────────────────
// "Rev 유지"(기본) — 리비전을 올리지 않고 현재본 내용만 바꾼다.
// "Rev 변경"        — Rev 를 하나 올려 새 리비전으로 등록한다.
const replaceOpen = ref(false)
const replaceFiles = ref<File[]>([])
const keepRev = ref(true)

function openReplace() {
  replaceFiles.value = []
  keepRev.value = true
  replaceOpen.value = true
}

async function submitReplace() {
  const files = replaceFiles.value
  if (!files.length) return
  const ids = [...picked.value]
  busy.value = true
  try {
    const flags = { confirmDuplicates: false, confirmMismatch: false, confirmPartial: false }
    for (;;) {
      const fd = new FormData()
      fd.append('keepRev', String(keepRev.value))
      for (const [k, v] of Object.entries(flags)) fd.append(k, String(v))
      if (ids.length > 1) for (const id of ids) fd.append('documentIds', String(id))
      for (const f of files) fd.append('files', f)

      if (ids.length === 1) {
        const { body } = await postForm<ReplaceResult>(`/editor/documents/${ids[0]}/replace`, fd)
        if (body.needsConfirmation) {
          const ok = await confirmAsk({
            title: '같은 형식 파일이 2개 이상입니다',
            lines: [
              `같은 형식(${body.duplicateExts.join(', ')})의 파일이 2개 이상 첨부되었습니다.`,
              '정상은 이름당 원본 1개+PDF 1개뿐입니다. 첨부한 파일을 다시 확인해 주세요.',
              '그래도 이대로 계속 교체하시겠습니까?',
            ],
          })
          if (!ok) return
          flags.confirmDuplicates = true
          continue
        }
        say('ok', body.message)
      } else {
        const { body } = await postForm<ReplaceBulkResult>('/editor/documents/replace-bulk', fd)
        if (body.needsConfirmation) {
          let ok: boolean
          if (body.duplicateExts.length) {
            ok = await confirmAsk({
              title: '같은 형식 파일이 2개 이상입니다',
              lines: [`같은 형식(${body.duplicateExts.join(', ')})의 파일이 2개 이상 첨부된 자료가 있습니다.`,
                      '그래도 이대로 계속 교체하시겠습니까?'],
            })
            flags.confirmDuplicates = true
          } else if (body.unmatchedDocs.length || body.unmatchedFiles.length) {
            ok = await confirmAsk({
              title: '자료명과 파일 이름이 맞지 않습니다',
              lines: [
                ...(body.unmatchedDocs.length
                  ? [`선택했지만 같은 이름의 첨부 파일이 없는 자료: ${body.unmatchedDocs.join(', ')}`] : []),
                ...(body.unmatchedFiles.length
                  ? [`첨부했지만 같은 이름의 선택 자료가 없는 파일: ${body.unmatchedFiles.join(', ')}`] : []),
                '이름이 일치하는 자료만 교체하고 나머지는 건너뛰시겠습니까?',
              ],
            })
            flags.confirmMismatch = true
          } else {
            ok = await confirmAsk({
              title: '원본·사본 확인',
              lines: ['다음 자료는 원본과 사본(PDF) 중 한쪽만 첨부되었습니다. 그대로 교체하시겠습니까?'],
              partial: body.partial,
            })
            flags.confirmPartial = true
          }
          if (!ok) return
          continue
        }
        say('ok', body.message)
      }
      replaceOpen.value = false
      picked.value = new Set()
      refreshAll()
      return
    }
  } catch (e) { fail(e) } finally { busy.value = false }
}

// ── 신규 자료 등록 (기존 Rev 조회 포함) ───────────────────────────────
const registerOpen = ref(false)
const registerFiles = ref<File[]>([])
const registerRev = ref(0)
const revMatch = ref<ExistingRevLookup | null>(null)

function openRegister() {
  registerFiles.value = []
  registerRev.value = 0
  revMatch.value = null
  registerOpen.value = true
}

/** 파일을 딱 1개 골랐을 때 — 같은 이름(다른 형식) 자료가 있으면 그 Rev 로 맞춘다 */
async function onRegisterFiles(ev: Event) {
  registerFiles.value = filesOf(ev)
  revMatch.value = null
  const only = registerFiles.value.length === 1 ? registerFiles.value[0]! : null
  if (!only || !folder.value) return
  const dot = only.name.lastIndexOf('.')
  const stem = dot > 0 ? only.name.slice(0, dot) : only.name
  const ext = dot > 0 ? only.name.slice(dot + 1).toLowerCase() : ''
  try {
    const r = await api.get<ExistingRevLookup>(
      `/editor/documents/existing-rev${qs({ folderId: folder.value.id, stem })}`)
    if (r.found && !r.exts.includes(ext) && r.currentRev !== null) {
      revMatch.value = r
      registerRev.value = r.currentRev
    }
  } catch { /* 조회 실패는 등록 시점에 서버가 다시 맞춘다 */ }
}

async function submitRegister() {
  if (!folder.value || !registerFiles.value.length) return
  const rev = revMatch.value?.currentRev ?? Math.max(0, Math.floor(Number(registerRev.value) || 0))
  busy.value = true
  try {
    const flags = { confirmDuplicates: false, confirmPartial: false }
    for (;;) {
      const fd = new FormData()
      fd.append('folderId', String(folder.value.id))
      fd.append('rev', String(rev))
      for (const [k, v] of Object.entries(flags)) fd.append(k, String(v))
      for (const f of registerFiles.value) fd.append('files', f)
      const { body } = await postForm<RegisterResult>('/editor/documents/register', fd)
      if (body.needsConfirmation) {
        let ok: boolean
        if (body.duplicates.length && !flags.confirmDuplicates) {
          ok = await confirmAsk({
            title: '같은 이름·같은 형식 파일이 2개 이상입니다',
            lines: [
              ...body.duplicates.map((d) => `${d.stem} (${d.exts.join(', ')} 중복)`),
              '해당 자료는 등록하지 않고 건너뛰고, 나머지만 계속 등록하시겠습니까?',
            ],
          })
          flags.confirmDuplicates = true
        } else {
          ok = await confirmAsk({
            title: '원본·사본 확인',
            lines: ['다음 자료는 원본과 사본(PDF) 중 한쪽만 있습니다. 그대로 등록하시겠습니까?'],
            partial: body.partial,
          })
          flags.confirmPartial = true
        }
        if (!ok) return
        continue
      }
      registerOpen.value = false
      say(body.alreadyExists.length ? 'err' : 'ok',
        body.alreadyExists.length
          ? `${body.message} — ${body.alreadyExists.map((a) => `${a.stem}(${a.exts.join('/')})`).join(', ')}`
          : body.message)
      refreshAll()
      return
    }
  } catch (e) { fail(e) } finally { busy.value = false }
}

// ── Zip 폴더 업로드 ───────────────────────────────────────────────────
// 반입(/imports/zip)이 아니다 — Zip 의 폴더 구조가 선택한 폴더 아래 폴더가 되고 파일은 자료가 된다.
// 확인이 필요하면 서버가 token 을 주므로, 다시 보낼 때 Zip 을 또 올리지 않는다.
const zipOpen = ref(false)
const zipFile = ref<File | null>(null)
const zipRev = ref(0)
const zipJobId = ref<number | null>(null)

function openZip() {
  zipFile.value = null
  zipRev.value = 0
  zipOpen.value = true
}

async function submitZip() {
  const file = zipFile.value
  if (!folder.value || !file) return
  const flags = { confirmUnsafePaths: false, confirmDuplicates: false, confirmPartial: false }
  let token: string | null = null
  busy.value = true
  try {
    for (;;) {
      const fd = new FormData()
      fd.append('folderId', String(folder.value.id))
      fd.append('rev', String(Math.max(0, Math.floor(Number(zipRev.value) || 0))))
      for (const [k, v] of Object.entries(flags)) fd.append(k, String(v))
      if (token) fd.append('token', token)
      else fd.append('file', file)
      const { status, body } = await postForm<ZipRegisterCheck | JobCreated>('/editor/zip-register', fd)
      if (status === 202) {
        zipJobId.value = (body as JobCreated).jobId
        zipOpen.value = false
        say('ok', `"${file.name}" 압축을 풀어 등록하는 중입니다.`)
        return
      }
      const c = body as ZipRegisterCheck
      token = c.token
      let ok: boolean
      if (c.unsafePaths.length && !flags.confirmUnsafePaths) {
        ok = await confirmAsk({
          title: '상위 폴더로 빠져나가려는 이름이 있습니다',
          lines: [
            ...c.unsafePaths,
            '그 부분은 무시하고(선택한 폴더 밖으로는 절대 나가지 않음) 나머지 폴더 이름만 써서 계속 등록하시겠습니까?',
          ],
        })
        flags.confirmUnsafePaths = true
      } else if (c.duplicates.length && !flags.confirmDuplicates) {
        ok = await confirmAsk({
          title: '같은 이름·같은 형식 파일이 2개 이상입니다',
          lines: [
            ...c.duplicates.map((d) => `${d.folder ? `${d.folder} / ` : ''}${d.stem} (${d.exts.join(', ')} 중복)`),
            '이 자료들은 등록하지 않고 건너뛰고, 나머지만 계속 등록하시겠습니까?',
          ],
        })
        flags.confirmDuplicates = true
      } else {
        ok = await confirmAsk({
          title: '원본·사본 확인',
          lines: ['다음 자료는 원본과 사본(PDF) 중 한쪽만 있습니다. 그대로 등록하시겠습니까?',
                  ...(c.pairFolders.length ? [`DWG·PDF 폴더를 합쳤습니다: ${c.pairFolders.join(', ')}`] : [])],
          partial: c.partial,
        })
        flags.confirmPartial = true
      }
      if (!ok) return
    }
  } catch (e) { fail(e) } finally { busy.value = false }
}

function onZipDone(j: JobDetail) {
  say('ok', `Zip 등록을 마쳤습니다. ${j.progressNote ?? ''}`)
  refreshAll()
}

// ── 보관함 비고 · 묶음 다운로드 ───────────────────────────────────────
const noteTarget = ref<ArchiveBatch | null>(null)
const noteText = ref('')
const boxJobId = ref<number | null>(null)

const canBoxNote = computed(() => (boxOpen.value === 'TRASH' ? canTrashNote.value : canRetire.value))

function editNote(b: ArchiveBatch) {
  noteTarget.value = b
  noteText.value = b.note ?? ''
}

async function saveNote() {
  const b = noteTarget.value
  if (!b) return
  const path = boxOpen.value === 'TRASH' ? `/editor/trash/${b.id}/note` : `/editor/retired/${b.id}/note`
  try {
    await api.post(path, { note: noteText.value.trim() || null })
    noteTarget.value = null
    void qc.invalidateQueries({ queryKey: ['archive'] })
  } catch (e) { fail(e) }
}

async function downloadBatch(b: ArchiveBatch) {
  try {
    const r = await api.post<JobCreated>(`/editor/trash/${b.id}/download`)
    boxJobId.value = r.jobId
  } catch (e) { fail(e) }
}

function closeBox() {
  boxOpen.value = null
  boxSel.value = new Set()
  boxJobId.value = null
}

// ── 공사 · 업체 관리 ──────────────────────────────────────────────────
const catalogOpen = ref<'projects' | 'vendors' | null>(null)
</script>

<template>
  <aside class="app-side">
    <LazyTree doc-class="TDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
  </aside>

  <main class="app-main editor">
    <div class="panel bar-panel">
      <div class="bar">
        <strong>TDB 폴더 및 디렉토리 구조 관리</strong>
        <span style="flex:1" />
        <button class="btn btn-sm" @click="catalogOpen = 'projects'">공사 관리</button>
        <button class="btn btn-sm" @click="catalogOpen = 'vendors'">업체 관리</button>
        <button class="btn btn-sm" @click="boxOpen = 'RETIRE'">
          폐기 보관함 <span class="cnt">{{ retireBox?.count ?? 0 }}</span>
        </button>
        <button class="btn btn-sm" @click="boxOpen = 'TRASH'">
          삭제 보관함 <span class="cnt">{{ trashBox?.count ?? 0 }}</span>
        </button>
      </div>

      <div class="bar">
        <span class="group-label">폴더 편집</span>
        <button class="btn btn-sm" :disabled="!canFolder" @click="folderDialog = 'create'; folderName = ''">
          새 폴더
        </button>
        <button class="btn btn-sm" :disabled="!canFolder || !folder"
                @click="folderDialog = 'rename'; folderName = folder?.name ?? ''">이름 변경</button>
        <button class="btn btn-sm" :disabled="!canFolder || !folder"
                @click="folderDialog = 'move'; moveTargetId = null">위치 이동</button>
        <button class="btn btn-sm" :disabled="!canRestore || !folder" @click="sendTo('TRASH', true)">
          폴더 삭제
        </button>
        <button class="btn btn-sm" :disabled="!canFolder" @click="pairOpen = true">원본·사본 폴더 병합</button>
      </div>

      <div class="bar">
        <span class="group-label">자료 편집</span>
        <input v-model="keyword" type="text" placeholder="검색어" style="width:180px" />
        <label class="chk"><input v-model="includeIsometric" type="checkbox" /> Isometric 보기</label>
        <span class="muted">선택 {{ picked.size }}건</span>
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="!canDocument || picked.size !== 1" @click="openRename">
          이름 변경
        </button>
        <button class="btn btn-sm" :disabled="!canDocument || !picked.size" @click="openReplace">
          {{ picked.size > 1 ? '일괄 교체' : '자료 교체' }}
        </button>
        <button class="btn btn-sm" :disabled="!canDocument || !folder" @click="openRegister">신규 등록</button>
        <button class="btn btn-sm" :disabled="!canDocument || !picked.size"
                @click="moveDocsOpen = true; docTargetId = null">자료 이동</button>
        <button class="btn btn-sm" :disabled="!canRetire || !picked.size" @click="sendTo('RETIRE', false)">
          폐기
        </button>
        <button class="btn btn-sm" :disabled="!canRestore || !picked.size" @click="sendTo('TRASH', false)">
          삭제
        </button>
        <button class="btn btn-sm" :disabled="!canZip || !folder" @click="openZip">Zip 폴더 업로드</button>
      </div>

      <JobProgress :job-id="zipJobId" @done="onZipDone" />
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}
      <span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="columns" :rows="rows" selectable :selected="picked" :loading="isFetching"
        :total="data?.total ?? null" :sort-key="sort" :sort-dir="dir" storage-key="tdb-editor" excel-name="TDB 관리"
        @toggle="toggle" @toggle-all="toggleAll" @sort="onSort"
      />
    </div>

    <!-- 폴더 편집 -->
    <Modal v-if="folderDialog" :title="folderDialog === 'create' ? '새 폴더' : folderDialog === 'rename' ? '폴더 이름 변경' : '폴더 위치 이동'"
           @close="folderDialog = null">
      <template v-if="folderDialog !== 'move'">
        <p class="muted">{{ folderDialog === 'create' ? `"${folder?.name ?? '최상위'}" 아래에 만듭니다.` : '' }}</p>
        <input v-model="folderName" type="text" placeholder="폴더 이름" style="width:100%" />
      </template>
      <template v-else>
        <p class="muted">
          "{{ folder?.name }}" 을(를) 옮길 자리를 고릅니다. 하위 폴더가 함께 따라갑니다.
          자기 하위로는 옮길 수 없습니다.
        </p>
        <LazyTree doc-class="TDB" :selected-id="moveTargetId"
                  @select="(f) => (moveTargetId = f?.id ?? null)" />
      </template>
      <template #footer>
        <button class="btn" @click="folderDialog = null">취소</button>
        <button class="btn btn-primary"
                :disabled="folderDialog !== 'move' && !folderName.trim()"
                @click="submitFolder">확인</button>
      </template>
    </Modal>

    <!-- 자료 이동 -->
    <Modal v-if="moveDocsOpen" title="자료 이동" @close="moveDocsOpen = false">
      <p class="muted">
        선택한 {{ picked.size }}건을 옮길 폴더를 고릅니다.
        옮길 자리에 같은 자료명이 있으면 그 건만 건너뜁니다.
      </p>
      <LazyTree doc-class="TDB" :selected-id="docTargetId" @select="(f) => (docTargetId = f?.id ?? null)" />
      <template #footer>
        <button class="btn" @click="moveDocsOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="docTargetId === null" @click="submitMoveDocs">옮기기</button>
      </template>
    </Modal>

    <!-- 보관함 -->
    <Modal v-if="boxOpen" wide
           :title="boxOpen === 'TRASH' ? '삭제 보관함' : '폐기 보관함'"
           @close="closeBox">
      <p class="muted">
        <template v-if="boxOpen === 'TRASH'">
          오류 등으로 없앤 자료입니다. 폴더째 묶여 한 줄입니다.
          복구할 수 있고, 용량이 문제가 되면 <strong>완전 삭제</strong>까지 갈 수 있습니다.
        </template>
        <template v-else>
          리비전이 진행되며 최신본에서 빠진 자료입니다. 자료 1건이 한 줄입니다.
          나중에 이력을 찾을 수 있어야 하므로 <strong>완전 삭제가 없고 복구만</strong> 있습니다.
        </template>
      </p>
      <table class="grid">
        <thead>
          <tr>
            <th style="width:34px"></th>
            <th>이름</th><th>원래 자리</th><th>건수</th><th>사유</th><th>보낸 사람</th><th>보낸 시각</th><th>비고</th>
            <th v-if="boxOpen === 'TRASH'" style="width:84px">파일</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in box?.items ?? []" :key="b.id">
            <td class="tc">
              <input type="checkbox" :checked="boxSel.has(b.id)"
                     @change="boxSel.has(b.id) ? boxSel.delete(b.id) : boxSel.add(b.id); boxSel = new Set(boxSel)" />
            </td>
            <td>{{ b.label }}</td>
            <td class="muted">{{ b.originalPath ?? '-' }}</td>
            <td class="tc">{{ b.itemCount }}</td>
            <td>{{ b.reason ?? '-' }}</td>
            <td class="tc">{{ b.archivedBy ?? '-' }}</td>
            <td class="tc">{{ b.archivedAt.slice(0, 16).replace('T', ' ') }}</td>
            <td class="note-cell">
              <span>{{ b.note ?? '-' }}</span>
              <button v-if="canBoxNote" class="btn btn-sm" title="비고 편집" @click="editNote(b)">편집</button>
            </td>
            <td v-if="boxOpen === 'TRASH'" class="tc">
              <button class="btn btn-sm" title="묶음 전체를 Zip 으로 내려받기" @click="downloadBatch(b)">다운로드</button>
            </td>
          </tr>
          <tr v-if="!box?.items.length">
            <td :colspan="boxOpen === 'TRASH' ? 9 : 8" class="tc muted">보관된 자료가 없습니다.</td>
          </tr>
        </tbody>
      </table>
      <JobProgress :job-id="boxJobId" />
      <template #footer>
        <button v-if="boxOpen === 'TRASH'" class="btn"
                :disabled="!boxSel.size || !canRestore" @click="purgeConfirm = true">완전 삭제</button>
        <span style="flex:1" />
        <button class="btn" @click="closeBox">닫기</button>
        <button class="btn btn-primary" :disabled="!boxSel.size" @click="restoreSelected">복구</button>
      </template>
    </Modal>

    <Modal v-if="purgeConfirm" title="완전 삭제 — 되돌릴 수 없습니다" @close="purgeConfirm = false">
      <p>
        선택한 {{ boxSel.size }}묶음의 자료와 파일을 <strong>완전히</strong> 지웁니다.
        복구할 수 없습니다.
      </p>
      <p class="muted">반출 기록은 남습니다 — 누가 받아 갔는지는 자료가 사라져도 알아야 하기 때문입니다.</p>
      <template #footer>
        <button class="btn" @click="purgeConfirm = false">취소</button>
        <button class="btn btn-primary" @click="purgeSelected">완전 삭제</button>
      </template>
    </Modal>

    <!-- 원본·사본 폴더 병합 -->
    <Modal v-if="pairOpen" wide title="원본·사본 폴더 병합" @close="pairOpen = false">
      <p class="muted">
        원본 공유폴더에서 DWG 와 PDF 가 각각 다른 폴더로 갈려 있던 자리입니다.
        합치면 화면에서 한 건으로 보이고, 빈 폴더는 표시용으로만 남습니다.
      </p>
      <table class="grid">
        <thead><tr><th>상위 폴더</th><th>양쪽에 있는 자료</th><th>DWG</th><th>PDF</th><th>조치</th></tr></thead>
        <tbody>
          <tr v-for="p in pairs?.items ?? []" :key="p.parentId">
            <td>{{ p.parentName }}</td>
            <td class="tc">{{ p.matchedCount }}</td>
            <td class="tc">{{ p.dwgOnly }}</td>
            <td class="tc">{{ p.pdfOnly }}</td>
            <td class="tc"><button class="btn btn-sm" @click="mergePair(p)">병합</button></td>
          </tr>
          <tr v-if="!pairs?.items.length"><td colspan="5" class="tc muted">병합할 폴더가 없습니다.</td></tr>
        </tbody>
      </table>
    </Modal>

    <!-- 자료 이름 변경 -->
    <Modal v-if="renameOpen" title="자료명 변경" @close="renameOpen = false">
      <p class="muted">변경 대상: <strong>{{ pickedRows[0]?.drawingNo }}</strong></p>
      <p class="muted">자료명 끝에 리비전 표기(_Rev00)는 적지 않습니다 — 시스템이 붙입니다.</p>
      <div class="form">
        <label>자료명 <input v-model="renameNo" type="text" maxlength="255" @keydown.enter="submitRename" /></label>
        <label>내용 <input v-model="renameTitle" type="text" maxlength="500" @keydown.enter="submitRename" /></label>
      </div>
      <template #footer>
        <button class="btn" @click="renameOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="!renameNo.trim()" @click="submitRename">확인</button>
      </template>
    </Modal>

    <!-- 자료 교체 · 일괄 교체 -->
    <Modal v-if="replaceOpen" :title="picked.size > 1 ? `일괄 자료 교체 (${picked.size}건)` : '자료 교체'"
           @close="replaceOpen = false">
      <p v-if="picked.size === 1" class="muted">
        교체 대상: <strong>{{ pickedRows[0]?.drawingNo }}</strong> (Rev{{ String(pickedRows[0]?.currentRev ?? 0).padStart(2, '0') }})
        — 원본과 PDF 중 한쪽만 올려도 됩니다. 둘 다 올릴 때는 이름이 같아야 합니다.
      </p>
      <p v-else class="muted">
        첨부한 파일을 이름(확장자 제외)으로 묶어 같은 자료명을 가진 선택 자료에 맞춥니다.
        내려받은 이름(<code>자료명_Rev00.dwg</code>) 그대로 올려도 됩니다.
      </p>
      <div class="form">
        <label class="radio"><input v-model="keepRev" type="radio" :value="true" /> Rev 유지 — 지금 현재본을 그대로 덮어씁니다</label>
        <label class="radio"><input v-model="keepRev" type="radio" :value="false" /> Rev 변경 — Rev 를 하나 올려 새 리비전으로 등록합니다</label>
        <input type="file" multiple accept=".dwg,.dxf,.pdf,.xlsx,.xls,.docx,.pptx"
               @change="(ev) => (replaceFiles = filesOf(ev))" />
        <span class="muted">{{ replaceFiles.length }}개 파일</span>
      </div>
      <template #footer>
        <button class="btn" @click="replaceOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="busy || !replaceFiles.length" @click="submitReplace">
          {{ busy ? '올리는 중…' : '교체' }}
        </button>
      </template>
    </Modal>

    <!-- 신규 자료 등록 -->
    <Modal v-if="registerOpen" title="신규 자료 등록" @close="registerOpen = false">
      <p class="muted">
        "<strong>{{ folder?.name }}</strong>" 폴더에 등록합니다. 파일 이름(확장자 제외)이 같은 것끼리 자료 1건이 됩니다.
        같은 이름의 자료가 이미 있으면 새로 만들지 않고 없는 형식만 붙입니다.
      </p>
      <div class="form">
        <input type="file" multiple accept=".dwg,.dxf,.pdf,.xlsx,.xls,.docx,.pptx" @change="onRegisterFiles" />
        <label>Rev
          <input v-model.number="registerRev" type="number" min="0" style="width:80px" :readonly="!!revMatch" />
        </label>
        <p v-if="revMatch" class="note">
          Rev 매칭: 이 폴더에 같은 이름의 자료(이미 있는 형식: {{ revMatch.exts.join('/').toUpperCase() }})가
          Rev {{ revMatch.currentRev }}로 등록되어 있어, 이 파일도 Rev {{ revMatch.currentRev }}로 등록됩니다.
        </p>
      </div>
      <template #footer>
        <button class="btn" @click="registerOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="busy || !registerFiles.length" @click="submitRegister">
          {{ busy ? '올리는 중…' : '등록' }}
        </button>
      </template>
    </Modal>

    <!-- Zip 폴더 업로드 -->
    <Modal v-if="zipOpen" title="Zip 폴더 업로드" @close="zipOpen = false">
      <p class="muted">
        Zip 안의 폴더 구조가 "<strong>{{ folder?.name }}</strong>" 아래 폴더가 되고, 파일은 자료가 됩니다.
        같은 폴더의 같은 이름 DWG·PDF 는 자료 1건으로 묶입니다.
        한 폴더 밑에 DWG 폴더와 PDF 폴더가 나란히 있으면 윗 폴더로 합칩니다.
      </p>
      <div class="form">
        <input type="file" accept=".zip" @change="(ev) => (zipFile = filesOf(ev)[0] ?? null)" />
        <label>새로 만드는 자료의 Rev
          <input v-model.number="zipRev" type="number" min="0" style="width:80px" />
        </label>
        <span class="muted">이미 있는 자료에 형식만 붙는 경우는 그 자료의 지금 Rev 를 따릅니다.</span>
      </div>
      <template #footer>
        <button class="btn" @click="zipOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="busy || !zipFile" @click="submitZip">
          {{ busy ? '올리는 중…' : '올리기' }}
        </button>
      </template>
    </Modal>

    <!-- 확인창 -->
    <Modal v-if="ask" :wide="!!ask.partial?.length" :title="ask.title" @close="answer(false)">
      <p v-for="(l, i) in ask.lines" :key="i" class="ask-line">{{ l }}</p>
      <div v-if="ask.partial?.length" class="partial">
        <DataTable :columns="partialColumns" :rows="partialRows" auto-height :filter-row="false"
                   storage-key="tdb-editor-partial" excel-name="원본·사본 확인" />
      </div>
      <template #footer>
        <button class="btn" @click="answer(false)">취소</button>
        <button class="btn btn-primary" @click="answer(true)">계속 진행</button>
      </template>
    </Modal>

    <!-- 보관함 비고 -->
    <Modal v-if="noteTarget" title="비고 편집" @close="noteTarget = null">
      <p class="muted">{{ noteTarget.label }}</p>
      <textarea v-model="noteText" rows="4" maxlength="2000" style="width:100%" />
      <template #footer>
        <button class="btn" @click="noteTarget = null">취소</button>
        <button class="btn btn-primary" @click="saveNote">저장</button>
      </template>
    </Modal>

    <!-- 공사 · 업체 관리 -->
    <Modal v-if="catalogOpen" wide :title="catalogOpen === 'projects' ? '공사 관리' : '업체 관리'"
           @close="catalogOpen = null">
      <ProjectManager :key="catalogOpen" :kind="catalogOpen" />
    </Modal>
  </main>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.bar-panel { padding: 10px 12px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; }
.group-label {
  font-size: var(--fs-sm); color: var(--text-muted); min-width: 62px;
  border-right: 1px solid var(--border); padding-right: 8px;
}
.cnt {
  display: inline-block; min-width: 17px; padding: 0 4px; margin-left: 3px;
  background: var(--accent); color: var(--primary-fg); border-radius: 9px; font-size: 10px; text-align: center;
}
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.btn.disabled { opacity: .45; cursor: not-allowed; }
.form { display: flex; flex-direction: column; gap: 8px; }
.form label { display: flex; align-items: center; gap: 8px; }
.form label input[type='text'] { flex: 1; }
.note { font-size: var(--fs-sm); color: var(--accent); margin: 0; }
.ask-line { margin: 0 0 6px; white-space: pre-wrap; word-break: break-all; }
.partial { margin-top: 8px; }
.note-cell { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
.table-panel {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
}
.table-panel > * {
  flex: 1; min-width: 0;
}
</style>
