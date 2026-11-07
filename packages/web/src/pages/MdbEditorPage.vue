<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  ArchiveBatch, ArchiveListResponse, FolderNode, JobCreated, MdbListItem, MdbListResponse, MdbMeta,
  MdbRegisterResult, MdbReplaceResult,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import TypeListModal from './mdb/TypeListModal.vue'
import MdbInfoModal from './mdb/MdbInfoModal.vue'
import UnclassifiedModal from './mdb/UnclassifiedModal.vue'
import PairMergeModal from './mdb/PairMergeModal.vue'
import TagHistoryModal from './mdb/TagHistoryModal.vue'

/** MDB 관리 — 기존 mdb-editor.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

const canFolder = computed(() => session.can('screen.mdb_editor.tag'))
const canDoc = computed(() => session.can('screen.mdb_editor.document'))
const canZip = computed(() => session.can('screen.mdb_editor.zip_register'))
const canRetire = computed(() => session.can('screen.mdb_editor.retire'))
const canRestore = computed(() => session.can('screen.mdb_editor.restore'))
const canTrashNote = computed(() => session.can('common.note_edit.mdb_trash'))

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

function refreshAll() {
  void qc.invalidateQueries({ queryKey: qk.folders.all })
  void qc.invalidateQueries({ queryKey: ['mdb'] })
  void qc.invalidateQueries({ queryKey: ['mdb-archive'] })
  void qc.invalidateQueries({ queryKey: ['mdb-tag-history'] })
}

// ── 트리 · 목록 ───────────────────────────────────────────────────────
const folder = ref<FolderNode | null>(null)
const keyword = ref('')
const sort = ref<'updatedAt' | 'title' | 'equipmentType' | 'docType' | 'year'>('updatedAt')
const dir = ref<SortDir>('desc')
function onSort(key: string, d: SortDir) { sort.value = key as typeof sort.value; dir.value = d }

const params = computed(() => ({
  folderId: folder.value?.id, q: keyword.value || undefined,
  sort: sort.value, dir: dir.value, limit: 200,
}))

const { data, isFetching } = useQuery({
  queryKey: computed(() => ['mdb', params.value]),
  queryFn: () => api.get<MdbListResponse>(`/mdb${qs(params.value)}`),
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

const { data: meta } = useQuery({
  queryKey: ['mdb-meta'],
  queryFn: () => api.get<MdbMeta>('/mdb/meta'),
  staleTime: staleTime.types,
})

const columns = computed<Column<MdbListItem>[]>(() => [
  { key: 'title', label: '자료명', width: '288px', sortable: true },
  { key: 'folderName', label: '폴더', sortable: false },   // 남는 자리를 받는 칸
  { key: 'equipmentType', label: '설비유형', width: '124px', sortable: true,
    render: (r) => r.equipmentType ?? '-' },
  { key: 'docType', label: '자료유형', width: '176px', sortable: true,
    render: (r) => r.docType ?? '-' },
  { key: 'year', label: '연도', width: '64px', align: 'center', sortable: true,
    render: (r) => String(r.year ?? '-') },
  { key: 'tagCount', label: 'Tag', width: '56px', align: 'center', sortable: false, filterable: false,
    render: (r) => String(r.tagCount) },
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
      await api.post('/mdb-editor/folders', { docClass: 'MDB', parentId: folder.value?.id ?? null, name: folderName.value })
      say('ok', `"${folderName.value}" 폴더를 만들었습니다.`)
    } else if (mode === 'rename' && folder.value) {
      await api.patch(`/mdb-editor/folders/${folder.value.id}`, { name: folderName.value })
      say('ok', `폴더 이름을 바꿨습니다.`)
    } else if (mode === 'move' && folder.value) {
      const r = await api.post<{ affectedFolders: number }>(
        `/mdb-editor/folders/${folder.value.id}/move`, { newParentId: moveTargetId.value })
      say('ok', `폴더를 옮겼습니다. 하위 ${r.affectedFolders}개가 함께 이동했습니다.`)
    }
    refreshAll()
  } catch (e) { fail(e) }
  folderName.value = ''
}

// ── 자료 편집 ─────────────────────────────────────────────────────────
const moveDocsOpen = ref(false)
const docTargetId = ref<number | null>(null)
const equipOpen = ref(false)
const newEquip = ref('')

async function submitMoveDocs() {
  moveDocsOpen.value = false
  if (docTargetId.value === null) return
  try {
    const r = await api.post<{ updated: number; skipped: { reason: string }[] }>(
      '/mdb-editor/files/move', { fileIds: [...picked.value], targetFolderId: docTargetId.value })
    say(r.skipped.length ? 'err' : 'ok',
      r.skipped.length ? `${r.updated}건 이동, ${r.skipped.length}건 건너뜀 — ${r.skipped[0]!.reason}`
                       : `${r.updated}건을 옮겼습니다.`)
    picked.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

async function submitEquip() {
  equipOpen.value = false
  try {
    const r = await api.post<{ updated: number }>('/mdb-editor/files/equipment-type',
      { fileIds: [...picked.value], equipmentType: newEquip.value || null })
    say('ok', `${r.updated}건의 설비유형을 바꿨습니다.`)
    picked.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

// ── 보관함 ────────────────────────────────────────────────────────────
const boxOpen = ref<'TRASH' | 'RETIRE' | null>(null)
const boxSel = ref(new Set<number>())
const purgeConfirm = ref(false)

const { data: trashBox } = useQuery({
  queryKey: ['mdb-archive', 'TRASH'],
  queryFn: () => api.get<ArchiveListResponse>('/mdb-editor/trash'),
  staleTime: staleTime.worklist,
})
const { data: retireBox } = useQuery({
  queryKey: ['mdb-archive', 'RETIRE'],
  queryFn: () => api.get<ArchiveListResponse>('/mdb-editor/retired'),
  staleTime: staleTime.worklist,
})
const box = computed(() => (boxOpen.value === 'TRASH' ? trashBox.value : retireBox.value))

async function sendTo(kind: 'TRASH' | 'RETIRE', fromFolder: boolean) {
  try {
    const body = fromFolder
      ? { folderId: folder.value?.id ?? null, documentIds: [], reason: null }
      : { documentIds: [...picked.value], folderId: null, reason: null }
    const r = await api.post<{ archived: number }>(
      kind === 'TRASH' ? '/mdb-editor/trash' : '/mdb-editor/retired', body)
    say('ok', `${kind === 'TRASH' ? '삭제' : '폐기'} 보관함으로 ${r.archived}건을 보냈습니다.`)
    picked.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

async function restoreSelected() {
  const path = boxOpen.value === 'TRASH' ? '/mdb-editor/trash/restore' : '/mdb-editor/retired/restore'
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

async function purgeSelected() {
  purgeConfirm.value = false
  try {
    const r = await api.post<{ purged: number; freedBytes: number }>(
      '/mdb-editor/trash/purge', { batchIds: [...boxSel.value], confirm: true })
    say('ok', `${r.purged}건을 완전 삭제했습니다. (${(r.freedBytes / 1024 ** 2).toFixed(1)} MB)`)
    boxSel.value = new Set()
    refreshAll()
  } catch (e) { fail(e) }
}

// ── 보관함: 비고 · 다운로드 ─────────────────────────────────────────
const noteEditing = ref<number | null>(null)
const noteText = ref('')
function canEditNote() {
  return boxOpen.value === 'TRASH' ? canTrashNote.value : canRetire.value
}
function startNote(b: ArchiveBatch) { noteEditing.value = b.id; noteText.value = b.note ?? '' }
async function saveNote(b: ArchiveBatch) {
  const path = boxOpen.value === 'TRASH' ? 'trash' : 'retired'
  noteEditing.value = null
  try {
    await api.post(`/mdb-editor/${path}/${b.id}/note`, { note: noteText.value.trim() || null })
    void qc.invalidateQueries({ queryKey: ['mdb-archive'] })
  } catch (e) { fail(e) }
}

const trashJobId = ref<number | null>(null)
async function downloadBatch(b: ArchiveBatch) {
  try {
    const r = await api.post<JobCreated>(`/mdb-editor/trash/${b.id}/download-zip`)
    trashJobId.value = r.jobId
  } catch (e) { fail(e) }
}

// ── 팝업들 ────────────────────────────────────────────────────────────
const tagOpen = ref(false)
const typesOpen = ref(false)
const unclassifiedOpen = ref(false)
const pairOpen = ref(false)
const infoId = ref<number | null>(null)
const onePicked = computed(() => (picked.value.size === 1 ? [...picked.value][0]! : null))
const pickedRow = computed(() => rows.value.find((r) => r.id === onePicked.value) ?? null)

function onInfoSaved() {
  infoId.value = null
  say('ok', '자료 정보를 저장했습니다.')
  refreshAll()
}

// ── 신규추가 (여러 파일) ──────────────────────────────────────────────
const registerOpen = ref(false)
const registerFiles = ref<File[]>([])
const busy = ref(false)

/** 같은 이름·같은 형식이 2개 이상이면 서버가 먼저 묻는다 — 확인하면 다시 보낸다 */
function confirmDuplicates(r: MdbRegisterResult): boolean {
  const list = r.duplicates
    .map((d) => `${d.folder ? `${d.folder} / ` : ''}${d.stem} (${d.exts.join(', ').toUpperCase()})`)
    .join('\n')
  return window.confirm(
    `같은 폴더에 같은 이름·같은 형식의 파일이 2개 이상 있습니다:\n${list}\n\n` +
    '정상은 한 자료에 형식마다 1개씩입니다. 그래도 계속 등록하시겠습니까?')
}

function registerMessage(r: { created: number; attached: number; skipped: string[] }) {
  const parts = [`${r.created}건 등록되었습니다.`]
  if (r.attached) parts.push(`기존 자료에 파일 ${r.attached}개를 채워 넣었습니다.`)
  if (r.skipped.length) {
    parts.push(`건너뛴 것: ${r.skipped.slice(0, 5).join(', ')}${r.skipped.length > 5 ? ` 외 ${r.skipped.length - 5}건` : ''}`)
  }
  return parts.join(' ')
}

async function postForm<T>(path: string, fd: FormData): Promise<{ status: number; body: T }> {
  return api.upload<T>(path, fd)
}

async function submitRegister() {
  if (!folder.value || !registerFiles.value.length) return
  busy.value = true
  try {
    for (let confirm = false; ;) {
      const fd = new FormData()
      fd.append('targetFolderId', String(folder.value.id))
      fd.append('confirmDuplicates', String(confirm))
      for (const f of registerFiles.value) fd.append('files', f)
      const { body } = await postForm<MdbRegisterResult>('/mdb-editor/register', fd)
      if (body.needsConfirmation) {
        if (!confirmDuplicates(body)) return
        confirm = true
        continue
      }
      registerOpen.value = false
      registerFiles.value = []
      say(body.skipped.length ? 'err' : 'ok', registerMessage(body))
      refreshAll()
      return
    }
  } catch (e) { fail(e) } finally { busy.value = false }
}

// ── 파일 교체 ─────────────────────────────────────────────────────────
const replaceOpen = ref(false)
const replaceFile = ref<File | null>(null)
async function submitReplace() {
  if (onePicked.value === null || !replaceFile.value) return
  busy.value = true
  try {
    const fd = new FormData()
    fd.append('file', replaceFile.value)
    const { body } = await postForm<MdbReplaceResult>(`/mdb-editor/files/${onePicked.value}/replace`, fd)
    replaceOpen.value = false
    replaceFile.value = null
    say('ok', body.message)
    refreshAll()
  } catch (e) { fail(e) } finally { busy.value = false }
}

// ── Zip 폴더 업로드 ───────────────────────────────────────────────────
// 넣을 위치는 왼쪽 트리에서 지금 고른 폴더. 고르지 않으면 Zip 의 첫 단계 폴더가 최상위 폴더가 된다.
const zipJobId = ref<number | null>(null)
async function uploadZip(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const where = folder.value ? `"${folder.value.name}" 폴더 아래` : '최상위'
  if (!window.confirm(`${file.name} 을(를) ${where}에 폴더째 등록합니다.`)) return
  busy.value = true
  try {
    for (let confirm = false; ;) {
      const fd = new FormData()
      if (folder.value) fd.append('targetFolderId', String(folder.value.id))
      fd.append('confirmDuplicates', String(confirm))
      fd.append('file', file)
      const { status, body } = await postForm<MdbRegisterResult & JobCreated>('/mdb-editor/zip-register', fd)
      if (status === 202) {
        zipJobId.value = body.jobId
        say('ok', '압축을 풀어 등록하는 중입니다. 아래 진행률을 확인하세요.')
        return
      }
      if (body.needsConfirmation && confirmDuplicates(body)) { confirm = true; continue }
      say('err', '등록을 취소했습니다.')
      return
    }
  } catch (e) { fail(e) } finally { busy.value = false }
}
</script>

<template>
  <aside class="app-side">
    <LazyTree doc-class="MDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
  </aside>

  <main class="app-main editor">
    <div class="panel bar-panel">
      <div class="bar">
        <strong>MDB 폴더 및 디렉토리 구조 관리</strong>
        <span style="flex:1" />
        <button class="btn btn-sm" @click="unclassifiedOpen = true">미분류 정리</button>
        <button class="btn btn-sm" @click="typesOpen = true">목록 관리</button>
        <button class="btn btn-sm" @click="tagOpen = true">Tag 이력</button>
        <button class="btn btn-sm" @click="boxOpen = 'RETIRE'">
          폐기 보관함 <span class="cnt">{{ retireBox?.count ?? 0 }}</span>
        </button>
        <button class="btn btn-sm" @click="boxOpen = 'TRASH'">
          삭제 보관함 <span class="cnt">{{ trashBox?.count ?? 0 }}</span>
        </button>
      </div>

      <div class="bar">
        <span class="group-label">폴더 편집</span>
        <button class="btn btn-sm" :disabled="!canFolder" @click="folderDialog = 'create'; folderName = ''">새 폴더</button>
        <button class="btn btn-sm" :disabled="!canFolder || !folder"
                @click="folderDialog = 'rename'; folderName = folder?.name ?? ''">이름 변경</button>
        <button class="btn btn-sm" :disabled="!canFolder || !folder"
                @click="folderDialog = 'move'; moveTargetId = null">위치 이동</button>
        <button class="btn btn-sm" :disabled="!canRestore || !folder" @click="sendTo('TRASH', true)">폴더 삭제</button>
        <button class="btn btn-sm" :disabled="!canFolder" @click="pairOpen = true">원본·사본 폴더 병합</button>
      </div>

      <div class="bar">
        <span class="group-label">자료 편집</span>
        <input v-model="keyword" type="text" placeholder="검색어" style="width:170px" />
        <span class="muted">선택 {{ picked.size }}건</span>
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="!canDoc || !folder"
                :title="folder ? '' : '왼쪽에서 등록할 폴더를 고르세요'"
                @click="registerOpen = true; registerFiles = []">신규추가</button>
        <button class="btn btn-sm" :disabled="!canDoc || onePicked === null"
                @click="infoId = onePicked">정보 수정</button>
        <button class="btn btn-sm" :disabled="!canDoc || onePicked === null"
                @click="replaceOpen = true; replaceFile = null">파일 교체</button>
        <button class="btn btn-sm" :disabled="!canDoc || !picked.size"
                @click="moveDocsOpen = true; docTargetId = null">자료 이동</button>
        <button class="btn btn-sm" :disabled="!canDoc || !picked.size"
                @click="equipOpen = true; newEquip = ''">설비유형 일괄변경</button>
        <button class="btn btn-sm" :disabled="!canRetire || !picked.size" @click="sendTo('RETIRE', false)">폐기</button>
        <button class="btn btn-sm" :disabled="!canRestore || !picked.size" @click="sendTo('TRASH', false)">삭제</button>
        <label class="btn btn-sm" :class="{ disabled: !canZip || busy }">
          Zip 폴더 업로드
          <input type="file" accept=".zip" hidden :disabled="!canZip || busy" @change="uploadZip" />
        </label>
      </div>

      <JobProgress v-if="zipJobId !== null" :job-id="zipJobId" @done="refreshAll" />
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="columns" :rows="rows" selectable :selected="picked" :loading="isFetching"
        :total="data?.total ?? null" :sort-key="sort" :sort-dir="dir" storage-key="mdb-editor" excel-name="MDB 관리"
        @toggle="toggle" @toggle-all="toggleAll" @sort="onSort" />
    </div>

    <!-- 폴더 편집 -->
    <Modal v-if="folderDialog"
           :title="folderDialog === 'create' ? '새 폴더' : folderDialog === 'rename' ? '폴더 이름 변경' : '폴더 위치 이동'"
           @close="folderDialog = null">
      <template v-if="folderDialog !== 'move'">
        <input v-model="folderName" type="text" placeholder="폴더 이름" style="width:100%" />
      </template>
      <template v-else>
        <p class="muted">"{{ folder?.name }}" 을(를) 옮길 자리를 고릅니다.</p>
        <LazyTree doc-class="MDB" :selected-id="moveTargetId" @select="(f) => (moveTargetId = f?.id ?? null)" />
      </template>
      <template #footer>
        <button class="btn" @click="folderDialog = null">취소</button>
        <button class="btn btn-primary" :disabled="folderDialog !== 'move' && !folderName.trim()"
                @click="submitFolder">확인</button>
      </template>
    </Modal>

    <!-- 자료 이동 -->
    <Modal v-if="moveDocsOpen" title="자료 이동" @close="moveDocsOpen = false">
      <p class="muted">선택한 {{ picked.size }}건을 옮길 폴더를 고릅니다. 같은 자료명이 있으면 그 건만 건너뜁니다.</p>
      <LazyTree doc-class="MDB" :selected-id="docTargetId" @select="(f) => (docTargetId = f?.id ?? null)" />
      <template #footer>
        <button class="btn" @click="moveDocsOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="docTargetId === null" @click="submitMoveDocs">옮기기</button>
      </template>
    </Modal>

    <!-- 설비유형 일괄변경 -->
    <Modal v-if="equipOpen" title="설비유형 일괄변경" @close="equipOpen = false">
      <p class="muted">선택한 {{ picked.size }}건의 설비유형을 한꺼번에 바꿉니다.</p>
      <select v-model="newEquip" style="width:100%">
        <option value="">(비움)</option>
        <option v-for="e in meta?.equipmentTypes ?? []" :key="e" :value="e">{{ e }}</option>
      </select>
      <template #footer>
        <button class="btn" @click="equipOpen = false">취소</button>
        <button class="btn btn-primary" @click="submitEquip">바꾸기</button>
      </template>
    </Modal>

    <!-- 보관함 -->
    <Modal v-if="boxOpen" wide :title="boxOpen === 'TRASH' ? '삭제 보관함' : '폐기 보관함'"
           @close="boxOpen = null; boxSel = new Set()">
      <p class="muted">
        <template v-if="boxOpen === 'TRASH'">
          오류 등으로 없앤 자료입니다. 복구할 수 있고 <strong>완전 삭제</strong>까지 갈 수 있습니다.
        </template>
        <template v-else>
          최신본에서 빠진 자료입니다. 이력을 찾을 수 있어야 하므로 <strong>복구만</strong> 있습니다.
        </template>
      </p>
      <table class="grid">
        <thead>
          <tr><th style="width:34px"></th><th>이름</th><th>원래 자리</th><th>건수</th>
              <th>사유</th><th>보낸 사람</th><th>보낸 시각</th><th>비고</th>
              <th v-if="boxOpen === 'TRASH'">받기</th></tr>
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
              <template v-if="noteEditing === b.id">
                <input v-model="noteText" type="text" maxlength="2000" style="width:100%"
                       @keydown.enter="saveNote(b)" @keydown.esc.stop="noteEditing = null" />
                <button class="btn btn-sm" @click="saveNote(b)">저장</button>
              </template>
              <template v-else>
                <span>{{ b.note ?? '' }}</span>
                <button v-if="canEditNote()" class="btn btn-sm" title="비고 작성" @click="startNote(b)">✎</button>
              </template>
            </td>
            <td v-if="boxOpen === 'TRASH'" class="tc">
              <button class="btn btn-sm" :disabled="!canRestore" @click="downloadBatch(b)">Zip</button>
            </td>
          </tr>
          <tr v-if="!box?.items.length"><td :colspan="boxOpen === 'TRASH' ? 9 : 8" class="tc muted">보관된 자료가 없습니다.</td></tr>
        </tbody>
      </table>
      <JobProgress v-if="boxOpen === 'TRASH' && trashJobId !== null" :job-id="trashJobId" />
      <template #footer>
        <button v-if="boxOpen === 'TRASH'" class="btn" :disabled="!boxSel.size || !canRestore"
                @click="purgeConfirm = true">완전 삭제</button>
        <span style="flex:1" />
        <button class="btn" @click="boxOpen = null; boxSel = new Set()">닫기</button>
        <button class="btn btn-primary" :disabled="!boxSel.size" @click="restoreSelected">복구</button>
      </template>
    </Modal>

    <Modal v-if="purgeConfirm" title="완전 삭제 — 되돌릴 수 없습니다" @close="purgeConfirm = false">
      <p>선택한 {{ boxSel.size }}묶음의 자료와 파일을 <strong>완전히</strong> 지웁니다.</p>
      <template #footer>
        <button class="btn" @click="purgeConfirm = false">취소</button>
        <button class="btn btn-primary" @click="purgeSelected">완전 삭제</button>
      </template>
    </Modal>

    <!-- 신규추가 -->
    <Modal v-if="registerOpen" title="신규추가" @close="registerOpen = false">
      <p class="muted">추가 위치: <strong>{{ folder?.name }}</strong></p>
      <p class="muted small">
        이름이 같고 확장자만 다른 파일(A.xlsx + A.pdf)은 자료 1건으로 들어갑니다. 같은 자리에 같은 자료명이
        이미 있으면 없는 형식만 채워 넣고, 이미 있는 형식은 건너뜁니다.
      </p>
      <input type="file" multiple
             @change="registerFiles = [...(($event.target as HTMLInputElement).files ?? [])]" />
      <p v-if="registerFiles.length" class="muted small">{{ registerFiles.length }}개 선택됨</p>
      <template #footer>
        <button class="btn" @click="registerOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="!registerFiles.length || busy" @click="submitRegister">등록</button>
      </template>
    </Modal>

    <!-- 파일 교체 -->
    <Modal v-if="replaceOpen" title="자료 교체" @close="replaceOpen = false">
      <p>교체 대상: <strong>{{ pickedRow?.title ?? '' }}</strong>
        <span class="muted">({{ pickedRow?.fileExt?.toUpperCase() }})</span></p>
      <p class="muted small">
        내용(파일)만 바뀌고 이름·Tag No·설비유형 등 다른 정보는 그대로입니다. 올린 파일과
        <strong>형식이 같은 쪽</strong>이 바뀌고(엑셀을 올리면 엑셀만), 이 자료에 없는 형식이면 새로 붙습니다.
      </p>
      <input type="file" @change="replaceFile = ($event.target as HTMLInputElement).files?.[0] ?? null" />
      <template #footer>
        <button class="btn" @click="replaceOpen = false">취소</button>
        <button class="btn btn-primary" :disabled="!replaceFile || busy" @click="submitReplace">교체</button>
      </template>
    </Modal>

    <MdbInfoModal v-if="infoId !== null" :file-id="infoId" @close="infoId = null" @saved="onInfoSaved" />
    <TypeListModal v-if="typesOpen" @close="typesOpen = false; refreshAll()" />
    <UnclassifiedModal v-if="unclassifiedOpen" @close="unclassifiedOpen = false" @changed="refreshAll" />
    <PairMergeModal v-if="pairOpen" @close="pairOpen = false" @merged="refreshAll" />
    <TagHistoryModal v-if="tagOpen" @close="tagOpen = false" @changed="refreshAll" />
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
.btn.disabled { opacity: .45; cursor: not-allowed; }
.table-panel {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
}
.table-panel > * {
  flex: 1; min-width: 0;
}
.small { font-size: var(--fs-sm); }
.note-cell { min-width: 140px; }
.note-cell > * { vertical-align: middle; }
.note-cell .btn { margin-left: 4px; padding: 0 6px; }
</style>
