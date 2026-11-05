<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { TypeListItem, TypeListKind, TypeListResponse, TypeRenameResult } from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * 값 목록 편집 — 설비유형 · 자료유형 · Tag No 변경사유 (기존 mdb-types.js openTypeListManager).
 *
 *   추가 · 이름 변경 · 숨기기/숨김 해제 · 삭제
 *   · 이름을 바꾸면 그 값을 들고 있던 자료도 함께 바뀐다 (변경사유는 이미 적힌 기록이라 그대로)
 *   · 숨기면 드롭다운에서만 빠진다. 삭제해도 이미 지정된 자료의 값은 남는다.
 *   · 이름에는 '/' 를 쓸 수 없다 (여러 값을 잇는 구분자)
 */
const props = defineProps<{ kind?: TypeListKind }>()
const emit = defineEmits<{ close: [] }>()

const session = useSession()
const qc = useQueryClient()
const canEdit = computed(() => session.can('screen.mdb_editor.document'))

const TABS: { kind: TypeListKind; label: string }[] = [
  { kind: 'equipment-types', label: '설비유형' },
  { kind: 'mdb-doc-types', label: '자료유형' },
  { kind: 'mdb-tag-reasons', label: 'Tag No 변경사유' },
]
const kind = ref<TypeListKind>(props.kind ?? 'equipment-types')
const label = computed(() => TABS.find((t) => t.kind === kind.value)!.label)

const { data, refetch } = useQuery({
  queryKey: computed(() => ['type-list', kind.value, 'all']),
  queryFn: () => api.get<TypeListResponse>(`/${kind.value}?includeHidden=true`),
})

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const fail = (e: unknown) =>
  (message.value = { kind: 'err', text: e instanceof ApiError ? e.message : '처리하지 못했습니다.' })

function changed() {
  void refetch()
  void qc.invalidateQueries({ queryKey: ['type-list', kind.value] })
  void qc.invalidateQueries({ queryKey: ['mdb'] })
  void qc.invalidateQueries({ queryKey: ['mdb-meta'] })
  void qc.invalidateQueries({ queryKey: ['mdb-unclassified'] })
  void qc.invalidateQueries({ queryKey: ['mdb-tag-meta'] })
}

const newName = ref('')
async function add() {
  const name = newName.value.trim()
  if (!name) return
  try {
    await api.post(`/${kind.value}`, { name })
    message.value = { kind: 'ok', text: `"${name}" 을(를) 추가했습니다.` }
    newName.value = ''
    changed()
  } catch (e) { fail(e) }
}

const editingId = ref<number | null>(null)
const editName = ref('')
function startEdit(it: TypeListItem) { editingId.value = it.id; editName.value = it.name }

async function saveEdit(it: TypeListItem) {
  const name = editName.value.trim()
  editingId.value = null
  if (!name || name === it.name) return
  try {
    const r = await api.patch<TypeRenameResult>(`/${kind.value}/${it.id}`, { name })
    message.value = {
      kind: 'ok',
      text: `"${it.name}" → "${name}" 로 바꿨습니다.` +
        (r.updatedFiles ? ` 이 값을 쓰던 파일 ${r.updatedFiles}개도 함께 바뀌었습니다.` : ''),
    }
    changed()
  } catch (e) { fail(e) }
}

async function toggleHidden(it: TypeListItem) {
  try {
    await api.post(`/${kind.value}/${it.id}/${it.isHidden ? 'unhide' : 'hide'}`)
    changed()
  } catch (e) { fail(e) }
}

const deleting = ref<TypeListItem | null>(null)
async function confirmDelete() {
  const it = deleting.value
  deleting.value = null
  if (!it) return
  try {
    await api.delete(`/${kind.value}/${it.id}`)
    message.value = { kind: 'ok', text: `"${it.name}" 을(를) 목록에서 지웠습니다.` }
    changed()
  } catch (e) { fail(e) }
}
</script>

<template>
  <Modal title="목록 관리" @close="emit('close')">
    <div class="tabs">
      <button v-for="t in TABS" :key="t.kind" class="btn btn-sm" :class="{ 'btn-primary': kind === t.kind }"
              @click="kind = t.kind; editingId = null; message = null">{{ t.label }}</button>
    </div>
    <p class="muted hint">
      <template v-if="kind === 'mdb-tag-reasons'">
        Tag 이력 등록에서 고르는 사유입니다. 이름을 바꿔도 이미 등록된 이력의 문구는 그대로 둡니다.
      </template>
      <template v-else>
        이름을 바꾸면 이 {{ label }}으로 지정된 자료도 함께 바뀝니다. 숨기면 드롭다운에서만 빠지고,
        지워도 이미 지정된 자료의 값은 남습니다. 이름에 '/' 는 쓸 수 없습니다.
      </template>
    </p>

    <div v-if="message" class="msg" :class="message.kind">{{ message.text }}</div>

    <div class="add">
      <input v-model="newName" type="text" :placeholder="`새 ${label}`" maxlength="100"
             :disabled="!canEdit" @keydown.enter="add" />
      <button class="btn btn-sm btn-primary" :disabled="!canEdit || !newName.trim()" @click="add">추가</button>
    </div>

    <table class="grid">
      <thead><tr><th>이름</th><th style="width:190px">조치</th></tr></thead>
      <tbody>
        <tr v-for="it in data?.items ?? []" :key="it.id" :class="{ hidden: it.isHidden }">
          <td>
            <input v-if="editingId === it.id" v-model="editName" type="text" maxlength="100" style="width:100%"
                   @keydown.enter="saveEdit(it)" @keydown.esc.stop="editingId = null" />
            <template v-else>{{ it.name }} <span v-if="it.isHidden" class="muted">(숨김)</span></template>
          </td>
          <td class="tc">
            <template v-if="editingId === it.id">
              <button class="btn btn-sm btn-primary" @click="saveEdit(it)">저장</button>
              <button class="btn btn-sm" @click="editingId = null">취소</button>
            </template>
            <template v-else>
              <button class="btn btn-sm" :disabled="!canEdit" @click="startEdit(it)">이름 변경</button>
              <button class="btn btn-sm" :disabled="!canEdit" @click="toggleHidden(it)">
                {{ it.isHidden ? '숨김 해제' : '숨기기' }}</button>
              <button class="btn btn-sm" :disabled="!canEdit" @click="deleting = it">삭제</button>
            </template>
          </td>
        </tr>
        <tr v-if="!data?.items.length"><td colspan="2" class="tc muted">등록된 {{ label }}이 없습니다.</td></tr>
      </tbody>
    </table>

    <template #footer>
      <button class="btn" @click="emit('close')">닫기</button>
    </template>
  </Modal>

  <Modal v-if="deleting" :title="`${label} 삭제`" @close="deleting = null">
    <p>"{{ deleting.name }}" 을(를) 목록에서 지웁니다.</p>
    <p class="muted">이미 이 값으로 지정된 자료는 그대로 남고, 새로 고를 후보에서만 빠집니다.
      잠시 감추려면 [숨기기]를 쓰세요.</p>
    <template #footer>
      <button class="btn" @click="deleting = null">취소</button>
      <button class="btn btn-primary" @click="confirmDelete">삭제</button>
    </template>
  </Modal>
</template>

<style scoped>
.tabs { display: flex; gap: 6px; margin-bottom: 8px; }
.hint { font-size: var(--fs-sm); margin: 0 0 10px; }
.add { display: flex; gap: 6px; margin-bottom: 10px; }
.add input { flex: 1; }
tr.hidden td { opacity: .55; }
.msg { padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; font-size: var(--fs-sm); }
.msg.ok { background: var(--accent-soft); }
.msg.err { color: var(--danger); background: var(--surface-3); }
</style>
