<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { MdbDetail, TagSuggestResponse, TypeListKind, TypeListResponse } from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import TypeListModal from './TypeListModal.vue'
import { api, ApiError, qs } from '@/lib/api'

/**
 * 자료명·정보 변경 (기존 mdb-editor.js update-info).
 *
 * 자료명 · Tag No · 설비유형 · 자료유형 · Note 를 한 번에 저장한다. 원본과 PDF 사본이 함께
 * 있으면 서버가 양쪽 파일에 똑같이 적용한다. 공사·연도는 폴더로 정해지므로 여기서 바꾸지 않는다.
 * 설비유형·자료유형은 여러 개를 고를 수 있다 ("Pump/Strainer").
 */
const props = defineProps<{ fileId: number }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const { data: detail } = useQuery({
  queryKey: computed(() => ['mdb-detail', props.fileId]),
  queryFn: () => api.get<MdbDetail>(`/mdb/${props.fileId}`),
})
const { data: equipList } = useQuery({
  queryKey: ['type-list', 'equipment-types'],
  queryFn: () => api.get<TypeListResponse>('/equipment-types'),
})
const { data: docList } = useQuery({
  queryKey: ['type-list', 'mdb-doc-types'],
  queryFn: () => api.get<TypeListResponse>('/mdb-doc-types'),
})

const title = ref('')
const note = ref('')
const tags = ref<string[]>([])
const equip = ref<string[]>([])
const docTypes = ref<string[]>([])
const split = (v: string | null) => (v ?? '').split('/').map((s) => s.trim()).filter(Boolean)

watch(detail, (d) => {
  if (!d) return
  title.value = d.title
  note.value = d.note ?? ''
  tags.value = [...d.tags]
  equip.value = split(d.equipmentType)
  docTypes.value = split(d.docType)
}, { immediate: true })

/** 목록에 없는 현재 값도 체크된 채로 보여준다 (목록에서 지워졌어도 자료에는 남아 있다) */
function options(list: TypeListResponse | undefined, chosen: string[]) {
  const names = (list?.items ?? []).map((i) => i.name)
  const upper = new Set(names.map((n) => n.toUpperCase()))
  return [...names, ...chosen.filter((c) => !upper.has(c.toUpperCase()))]
}
const equipOptions = computed(() => options(equipList.value, equip.value))
const docOptions = computed(() => options(docList.value, docTypes.value))

function toggle(which: 'equip' | 'doc', v: string) {
  const list = which === 'equip' ? equip : docTypes
  list.value = list.value.includes(v) ? list.value.filter((x) => x !== v) : [...list.value, v]
}

// ── Tag No ──
const newTag = ref('')
const tagErr = ref('')
const { data: suggest } = useQuery({
  queryKey: computed(() => ['mdb-tag-suggest', newTag.value.trim()]),
  queryFn: () => api.get<TagSuggestResponse>(`/mdb/tags/suggest${qs({ q: newTag.value.trim() })}`),
  enabled: computed(() => newTag.value.trim().length >= 2),
})
function addTag(): boolean {
  const t = newTag.value.trim()
  tagErr.value = ''
  if (!t) return true
  // 대소문자만 다른 것은 같은 설비로 본다
  if (tags.value.some((x) => x.toUpperCase() === t.toUpperCase())) {
    tagErr.value = `이미 있는 Tag No 입니다: ${t}`
    return false
  }
  tags.value = [...tags.value, t]
  newTag.value = ''
  return true
}

const managing = ref<TypeListKind | null>(null)
const error = ref('')
const saving = ref(false)

async function save() {
  // Enter 를 안 누르고 바로 [저장] 해도 입력해 둔 Tag No 가 사라지지 않게 먼저 반영한다
  if (newTag.value.trim() && !addTag()) return
  error.value = ''
  saving.value = true
  try {
    await api.patch(`/mdb-editor/files/${props.fileId}`, {
      title: title.value.trim() || undefined,
      equipmentType: equip.value.join('/') || null,
      docType: docTypes.value.join('/') || null,
      note: note.value.trim() || null,
      tags: tags.value,
    })
    emit('saved')
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '저장하지 못했습니다.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal title="자료명·정보 변경" @close="emit('close')">
    <template v-if="detail">
      <p class="muted target">
        {{ detail.folderPath.map((f) => f.name).join(' / ') }} · {{ detail.projectName ?? '공사 없음' }}
        · {{ detail.year ?? '연도 없음' }}
      </p>

      <label class="lbl">자료명</label>
      <input v-model="title" type="text" maxlength="500" style="width:100%" />

      <label class="lbl">Tag No</label>
      <div class="chips">
        <span v-for="t in tags" :key="t" class="chip">
          {{ t }} <button class="x" title="빼기" @click="tags = tags.filter((x) => x !== t)">×</button>
        </span>
        <span v-if="!tags.length" class="muted">Tag No 없음</span>
      </div>
      <div class="row">
        <input v-model="newTag" type="text" list="mdb-tag-suggest" placeholder="Tag No 입력 후 Enter"
               maxlength="100" style="flex:1" @keydown.enter.prevent="addTag" />
        <button class="btn btn-sm" @click="addTag">추가</button>
      </div>
      <datalist id="mdb-tag-suggest">
        <option v-for="s in suggest?.items ?? []" :key="s" :value="s" />
      </datalist>
      <p v-if="tagErr" class="err">{{ tagErr }}</p>

      <label class="lbl">설비유형
        <button class="btn btn-sm edit" title="설비유형 목록 편집" @click="managing = 'equipment-types'">✎</button>
      </label>
      <div class="checks">
        <label v-for="o in equipOptions" :key="o">
          <input type="checkbox" :checked="equip.includes(o)" @change="toggle('equip', o)" /> {{ o }}
        </label>
        <span v-if="!equipOptions.length" class="muted">목록이 비었습니다 — ✎ 로 추가하세요.</span>
      </div>

      <label class="lbl">자료유형
        <button class="btn btn-sm edit" title="자료유형 목록 편집" @click="managing = 'mdb-doc-types'">✎</button>
      </label>
      <div class="checks">
        <label v-for="o in docOptions" :key="o">
          <input type="checkbox" :checked="docTypes.includes(o)" @change="toggle('doc', o)" /> {{ o }}
        </label>
        <span v-if="!docOptions.length" class="muted">목록이 비었습니다 — ✎ 로 추가하세요.</span>
      </div>

      <label class="lbl">Note</label>
      <textarea v-model="note" rows="4" maxlength="2000" style="width:100%" />

      <p v-if="error" class="err">{{ error }}</p>
    </template>
    <p v-else class="muted">불러오는 중…</p>

    <template #footer>
      <button class="btn" @click="emit('close')">취소</button>
      <button class="btn btn-primary" :disabled="!detail || saving" @click="save">저장</button>
    </template>
  </Modal>

  <TypeListModal v-if="managing" :kind="managing" @close="managing = null" />
</template>

<style scoped>
.target { font-size: var(--fs-sm); margin: 0 0 6px; }
.lbl { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-muted); margin: 12px 0 4px; }
.edit { padding: 0 6px; }
.row { display: flex; gap: 6px; margin-top: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; min-height: 24px; }
.chip {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px 1px 8px;
  background: var(--accent-soft); border-radius: 10px; font-size: var(--fs-sm);
}
.x { border: 0; background: none; cursor: pointer; color: var(--text-muted); padding: 0 3px; }
.checks { display: flex; flex-wrap: wrap; gap: 4px 14px; max-height: 120px; overflow: auto; }
.checks label { font-size: var(--fs-sm); display: inline-flex; align-items: center; gap: 4px; }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 6px 0 0; }
</style>
