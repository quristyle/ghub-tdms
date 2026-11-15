<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import type { CatalogItem } from '@tdms/contracts'
import { useCatalog } from '@/lib/catalog'

/**
 * 공사·업체 관리 — **창 안에 넣는 좁은 목록**이다.
 *
 * 모달 틀이 없는 본문만이라 쓰는 쪽이 Modal 안에 넣는다(반출하기 창의 [관리]).
 *
 *     <Modal title="공사 관리" @close="..."><ProjectManager kind="projects" @changed="reload" /></Modal>
 *
 * 화면으로 크게 보는 쪽은 CatalogPage 다 — 거기는 조회부와 공통 그리드를 쓴다.
 * 추가·이름 변경·숨김 규칙은 둘이 같은 것(lib/catalog)을 쓴다.
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

const { label, all, hiddenCount, isFetching, error, add, rename, setHidden } =
  useCatalog(toRef(props, 'kind'))

const showHidden = ref(false)
const rows = computed(() => all.value.filter((r) => showHidden.value || !r.isHidden))

const newName = ref('')
const editingId = ref<number | null>(null)
const editName = ref('')

async function onAdd() {
  const name = newName.value.trim()
  if (!name) return
  if (await add(name)) { newName.value = ''; emit('changed') }
}

function startEdit(r: CatalogItem) { editingId.value = r.id; editName.value = r.name }

async function saveEdit() {
  const id = editingId.value
  const name = editName.value.trim()
  if (id === null || !name) return
  if (await rename(id, name)) { editingId.value = null; emit('changed') }
}

async function onHide(r: CatalogItem, hidden: boolean) {
  if (await setHidden(r.id, hidden)) emit('changed')
}
</script>

<template>
  <div class="pm">
    <div class="pm-add">
      <input v-model="newName" type="text" :placeholder="`새 ${label}명`" maxlength="200"
             @keydown.enter="onAdd" />
      <button class="btn btn-sm btn-primary" :disabled="!newName.trim()" @click="onAdd">추가</button>
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
                <button v-if="!r.isHidden" class="btn btn-sm" @click="onHide(r, true)">숨김</button>
                <button v-else class="btn btn-sm" @click="onHide(r, false)">숨김 해제</button>
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
