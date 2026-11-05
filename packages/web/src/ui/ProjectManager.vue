<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { CatalogItem, CatalogListResponse } from '@tdms/contracts'
import { api, ApiError } from '@/lib/api'
import { qk } from '@/lib/queryKeys'

/**
 * 공사·업체 관리 — 기존 script.js 의 공사 관리 창(반출하기 ＋추가에서 열던 것)과
 * vendors.py 의 숨김·이름 변경을 한 부품으로.
 *
 * 모달 틀이 없는 본문만이다 — 쓰는 쪽이 Modal 안에 넣는다(반출하기 창, TDB 관리 등).
 *
 *     <Modal title="공사 관리" @close="..."><ProjectManager kind="projects" @changed="reload" /></Modal>
 *
 * 삭제는 없고 숨김만 있다(D-6) — 숨기면 드롭다운 후보에서만 빠지고 과거 기록은 그대로다.
 * `pick` 을 받으면 줄마다 [선택] 단추가 나온다 (드롭다운 옆에서 열어 고르는 용도).
 */
const props = withDefaults(defineProps<{
  kind?: 'projects' | 'vendors'
  /** 줄마다 [선택] 단추를 보일지 */
  pickable?: boolean
}>(), { kind: 'projects', pickable: false })

const emit = defineEmits<{
  /** 추가·이름 변경·숨김이 일어났다 — 쓰는 쪽 드롭다운을 다시 불러오라는 뜻 */
  changed: []
  pick: [item: CatalogItem]
}>()

const qc = useQueryClient()
const label = computed(() => (props.kind === 'projects' ? '공사' : '업체'))
const base = computed(() => `/${props.kind}`)

const showHidden = ref(false)
const { data, isFetching } = useQuery({
  queryKey: computed(() => qk.catalog.list(props.kind, true)),
  queryFn: () => api.get<CatalogListResponse>(`${base.value}?includeHidden=true`),
})
const rows = computed(() => (data.value?.items ?? []).filter((r) => showHidden.value || !r.isHidden))
const hiddenCount = computed(() => (data.value?.items ?? []).filter((r) => r.isHidden).length)

const error = ref('')
const newName = ref('')
const editingId = ref<number | null>(null)
const editName = ref('')

async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try {
    await fn()
    await qc.invalidateQueries({ queryKey: qk.catalog.all })
    emit('changed')
    return true
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '처리하지 못했습니다.'
    return false
  }
}

async function add() {
  const name = newName.value.trim()
  if (!name) return
  if (await run(() => api.post(base.value, { name }))) newName.value = ''
}

function startEdit(r: CatalogItem) { editingId.value = r.id; editName.value = r.name }

async function saveEdit() {
  const id = editingId.value
  const name = editName.value.trim()
  if (id === null || !name) return
  if (await run(() => api.patch(`${base.value}/${id}`, { name }))) editingId.value = null
}

function setHidden(r: CatalogItem, hidden: boolean) {
  void run(() => api.post(`${base.value}/${r.id}/${hidden ? 'hide' : 'unhide'}`))
}
</script>

<template>
  <div class="pm">
    <div class="pm-add">
      <input v-model="newName" type="text" :placeholder="`새 ${label}명`" maxlength="200"
             @keydown.enter="add" />
      <button class="btn btn-sm btn-primary" :disabled="!newName.trim()" @click="add">추가</button>
      <span style="flex:1" />
      <label class="chk">
        <input v-model="showHidden" type="checkbox" /> 숨긴 {{ label }}도 보기 ({{ hiddenCount }})
      </label>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <p class="muted">
      {{ label }}는 지우지 않고 <strong>숨김</strong>만 합니다 — 숨기면 고르는 목록에서만 빠지고 지난 기록은 그대로입니다.
      <template v-if="kind === 'vendors'">업체명을 바꾸면 지난 반출·반입 기록의 업체명도 함께 바뀝니다.</template>
    </p>
    <div class="pm-list">
      <table class="grid">
        <thead>
          <tr><th>{{ label }}명</th><th style="width:90px">상태</th><th style="width:210px">조치</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ off: r.isHidden }">
            <td>
              <input v-if="editingId === r.id" v-model="editName" type="text" maxlength="200" style="width:100%"
                     @keydown.enter="saveEdit" @keydown.esc.stop="editingId = null" />
              <template v-else>{{ r.name }}</template>
            </td>
            <td class="tc">{{ r.isHidden ? '숨김' : '사용' }}</td>
            <td class="tc acts">
              <template v-if="editingId === r.id">
                <button class="btn btn-sm btn-primary" :disabled="!editName.trim()" @click="saveEdit">저장</button>
                <button class="btn btn-sm" @click="editingId = null">취소</button>
              </template>
              <template v-else>
                <button v-if="pickable && !r.isHidden" class="btn btn-sm" @click="emit('pick', r)">선택</button>
                <button class="btn btn-sm" @click="startEdit(r)">이름 변경</button>
                <button v-if="!r.isHidden" class="btn btn-sm" @click="setHidden(r, true)">숨김</button>
                <button v-else class="btn btn-sm" @click="setHidden(r, false)">숨김 해제</button>
              </template>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="3" class="tc muted">{{ isFetching ? '불러오는 중…' : `등록된 ${label}가 없습니다.` }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.pm { display: flex; flex-direction: column; gap: 8px; }
.pm-add { display: flex; gap: var(--gap-sm, 6px); align-items: center; }
.pm-add input[type='text'] { width: 240px; }
.pm-list { max-height: 420px; overflow: auto; }
.acts { white-space: nowrap; }
.acts .btn + .btn { margin-left: 4px; }
.chk { display: flex; align-items: center; gap: 4px; white-space: nowrap; font-size: var(--fs-sm); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 0; }
</style>
