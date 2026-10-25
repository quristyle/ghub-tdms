<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  ArchiveListResponse, DocumentListItem, DocumentListResponse,
  FolderNode, PairFolderCandidateResponse,
} from '@tdms/contracts'
import LazyTree from '@/ui/LazyTree.vue'
import DataTable, { type Column, type SortDir } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import JobProgress from '@/ui/JobProgress.vue'
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
  { key: 'folderName', label: '폴더', width: '160px' },
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

// ── Zip 폴더 업로드 ───────────────────────────────────────────────────
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
    <LazyTree doc-class="TDB" :selected-id="folder?.id ?? null" @select="(f) => (folder = f)" />
  </aside>

  <main class="app-main editor">
    <div class="panel bar-panel">
      <div class="bar">
        <strong>TDB 폴더 및 디렉토리 구조 관리</strong>
        <span style="flex:1" />
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
        <button class="btn btn-sm" :disabled="!canDocument || !picked.size"
                @click="moveDocsOpen = true; docTargetId = null">자료 이동</button>
        <button class="btn btn-sm" :disabled="!canRetire || !picked.size" @click="sendTo('RETIRE', false)">
          폐기
        </button>
        <button class="btn btn-sm" :disabled="!canRestore || !picked.size" @click="sendTo('TRASH', false)">
          삭제
        </button>
        <label class="btn btn-sm" :class="{ disabled: !canZip }">
          Zip 폴더 업로드
          <input type="file" accept=".zip" hidden :disabled="!canZip" @change="uploadZip" />
        </label>
      </div>

      <JobProgress :job-id="zipJobId" @done="refreshAll" />
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}
      <span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel table-panel">
      <DataTable
        :columns="columns" :rows="rows" selectable :selected="picked" :loading="isFetching"
        :total="data?.total ?? null" :sort-key="sort" :sort-dir="dir" storage-key="tdb-editor"
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
           @close="boxOpen = null; boxSel = new Set()">
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
            <td>{{ b.note ?? '-' }}</td>
          </tr>
          <tr v-if="!box?.items.length"><td colspan="8" class="tc muted">보관된 자료가 없습니다.</td></tr>
        </tbody>
      </table>
      <template #footer>
        <button v-if="boxOpen === 'TRASH'" class="btn"
                :disabled="!boxSel.size || !canRestore" @click="purgeConfirm = true">완전 삭제</button>
        <span style="flex:1" />
        <button class="btn" @click="boxOpen = null; boxSel = new Set()">닫기</button>
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
.table-panel { flex: 1; display: flex; min-height: 0; overflow: hidden; }
</style>
