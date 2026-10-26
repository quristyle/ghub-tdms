<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  ArchiveListResponse, FolderNode, MdbListItem, MdbListResponse, MdbMeta,
  TagHistory, TagHistoryListResponse, TagTargetsResponse,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
import { api, ApiError, qs } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

/** MDB 관리 — 기존 mdb-editor.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

const canFolder = computed(() => session.can('screen.mdb_editor.tag'))
const canDoc = computed(() => session.can('screen.mdb_editor.document'))
const canZip = computed(() => session.can('screen.mdb_editor.zip_register'))
const canRetire = computed(() => session.can('screen.mdb_editor.retire'))
const canRestore = computed(() => session.can('screen.mdb_editor.restore'))

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
  { key: 'folderName', label: '폴더' },   // 남는 자리를 받는 칸
  { key: 'equipmentType', label: '설비유형', width: '124px', sortable: true,
    render: (r) => r.equipmentType ?? '-' },
  { key: 'docType', label: '자료유형', width: '176px', sortable: true,
    render: (r) => r.docType ?? '-' },
  { key: 'year', label: '연도', width: '64px', align: 'center', sortable: true,
    render: (r) => String(r.year ?? '-') },
  { key: 'tagCount', label: 'Tag', width: '56px', align: 'center', filterable: false,
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

// ── Tag 이력 ──────────────────────────────────────────────────────────
const tagOpen = ref(false)
const tagForm = ref({ baseTag: '', newTag: '', reason: '' })
const previewId = ref<number | null>(null)

const { data: history } = useQuery({
  queryKey: ['mdb-tag-history'],
  queryFn: () => api.get<TagHistoryListResponse>('/mdb-tag-history'),
  enabled: computed(() => tagOpen.value),
  staleTime: staleTime.worklist,
})

const { data: targets } = useQuery({
  queryKey: computed(() => ['mdb-tag-targets', previewId.value]),
  queryFn: () => api.get<TagTargetsResponse>(`/mdb-tag-history/${previewId.value}/targets`),
  enabled: computed(() => previewId.value !== null),
})

async function createTagHistory() {
  try {
    await api.post('/mdb-tag-history', {
      baseTag: tagForm.value.baseTag, newTag: tagForm.value.newTag,
      reason: tagForm.value.reason || null,
    })
    say('ok', 'Tag 이력을 등록했습니다. 대상을 확인한 뒤 적용하세요.')
    tagForm.value = { baseTag: '', newTag: '', reason: '' }
    void qc.invalidateQueries({ queryKey: ['mdb-tag-history'] })
  } catch (e) { fail(e) }
}

async function tagAction(h: TagHistory, action: 'apply' | 'revert') {
  try {
    const r = await api.post<{ applied?: number; reverted?: number }>(`/mdb-tag-history/${h.id}/${action}`)
    say('ok', action === 'apply' ? `${r.applied}건에 적용했습니다.` : `${r.reverted}건을 되돌렸습니다.`)
    refreshAll()
  } catch (e) { fail(e) }
}

const TAG_STATE: Record<string, string> = { DRAFT: '등록됨', APPLIED: '적용됨', REVERTED: '되돌림' }

// ── Zip 업로드 ────────────────────────────────────────────────────────
const zipJobId = ref<number | null>(null)
async function uploadZip(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/imports/zip', { method: 'POST', body: fd })
  const body = await r.json()
  if (r.status === 202) { zipJobId.value = body.jobId; say('ok', '압축을 푸는 중입니다.') }
  else say('err', body.message ?? '올리지 못했습니다.')
  input.value = ''
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
      </div>

      <div class="bar">
        <span class="group-label">자료 편집</span>
        <input v-model="keyword" type="text" placeholder="검색어" style="width:170px" />
        <span class="muted">선택 {{ picked.size }}건</span>
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="!canDoc || !picked.size"
                @click="moveDocsOpen = true; docTargetId = null">자료 이동</button>
        <button class="btn btn-sm" :disabled="!canDoc || !picked.size"
                @click="equipOpen = true; newEquip = ''">설비유형 일괄변경</button>
        <button class="btn btn-sm" :disabled="!canRetire || !picked.size" @click="sendTo('RETIRE', false)">폐기</button>
        <button class="btn btn-sm" :disabled="!canRestore || !picked.size" @click="sendTo('TRASH', false)">삭제</button>
        <label class="btn btn-sm" :class="{ disabled: !canZip }">
          Zip 폴더 업로드
          <input type="file" accept=".zip" hidden :disabled="!canZip" @change="uploadZip" />
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
              <th>사유</th><th>보낸 사람</th><th>보낸 시각</th></tr>
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
          </tr>
          <tr v-if="!box?.items.length"><td colspan="7" class="tc muted">보관된 자료가 없습니다.</td></tr>
        </tbody>
      </table>
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

    <!-- Tag 이력 -->
    <Modal v-if="tagOpen" wide title="Tag 이력" @close="tagOpen = false; previewId = null">
      <p class="muted">
        설비 Tag 가 바뀌면(설비 교체·체계 변경·오기 정정) 해당 자료의 Tag 를 한꺼번에 고칩니다.
        <strong>적용 전에 바뀔 대상을 먼저 확인</strong>하고, 적용한 뒤에도 되돌릴 수 있습니다.
      </p>
      <div class="bar" style="margin-bottom:10px">
        <input v-model="tagForm.baseTag" type="text" placeholder="바꿀 Tag" style="width:140px" />
        <span class="muted">→</span>
        <input v-model="tagForm.newTag" type="text" placeholder="새 Tag" style="width:140px" />
        <input v-model="tagForm.reason" type="text" placeholder="사유" style="width:150px" />
        <button class="btn btn-sm btn-primary"
                :disabled="!canFolder || !tagForm.baseTag || !tagForm.newTag"
                @click="createTagHistory">등록</button>
      </div>
      <table class="grid">
        <thead>
          <tr><th>바꿀 Tag</th><th>새 Tag</th><th>사유</th><th>상태</th><th>적용 건수</th>
              <th>등록자</th><th>등록일</th><th>조치</th></tr>
        </thead>
        <tbody>
          <tr v-for="h in history?.items ?? []" :key="h.id" :class="{ applied: h.state === 'APPLIED' }">
            <td>{{ h.oldTag ?? h.baseTag }}</td>
            <td>{{ h.newTag ?? '-' }}</td>
            <td>{{ h.reason ?? '-' }}</td>
            <td class="tc">{{ TAG_STATE[h.state] ?? h.state }}</td>
            <td class="tc">{{ h.appliedCount }}</td>
            <td class="tc">{{ h.createdBy ?? '-' }}</td>
            <td class="tc">{{ h.createdAt.slice(0, 10) }}</td>
            <td class="tc">
              <button class="btn btn-sm" @click="previewId = h.id">대상 보기</button>
              <button v-if="h.state === 'DRAFT'" class="btn btn-sm" :disabled="!canFolder"
                      @click="tagAction(h, 'apply')">적용</button>
              <button v-if="h.state === 'APPLIED'" class="btn btn-sm" :disabled="!canFolder"
                      @click="tagAction(h, 'revert')">되돌리기</button>
            </td>
          </tr>
          <tr v-if="!history?.items.length"><td colspan="8" class="tc muted">Tag 이력이 없습니다.</td></tr>
        </tbody>
      </table>

      <template v-if="previewId !== null">
        <h3>바뀔 대상 ({{ targets?.items.length ?? 0 }}건)</h3>
        <table class="grid">
          <thead><tr><th>자료명</th><th>폴더</th><th>지금 Tag</th></tr></thead>
          <tbody>
            <tr v-for="t in targets?.items ?? []" :key="t.mdbFileId">
              <td>{{ t.title }}</td><td class="tc">{{ t.folderName }}</td><td class="tc">{{ t.currentTag }}</td>
            </tr>
            <tr v-if="!targets?.items.length"><td colspan="3" class="tc muted">바뀔 대상이 없습니다.</td></tr>
          </tbody>
        </table>
      </template>
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
.btn.disabled { opacity: .45; cursor: not-allowed; }
.table-panel { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.grid tr.applied { background: var(--accent-soft); }
h3 { font-size: var(--fs-base); margin: 16px 0 6px; }
</style>
