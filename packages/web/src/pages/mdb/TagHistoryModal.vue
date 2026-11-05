<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  TagHistory, TagHistoryListResponse, TagHistoryMeta, TagProjectFolderResponse, TagTargetsResponse,
} from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import TypeListModal from './TypeListModal.vue'
import { api, ApiError, qs } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * Tag No 이력관리 (기존 mdb-tag-history.js).
 *
 * 설비 Tag 가 바뀌면(설비 교체·체계 변경·오기 정정) 해당 자료의 Tag 를 한꺼번에 고친다.
 * 등록 팝업에서 여러 줄을 한 번에 적고, 줄마다 바뀔 자료 수를 미리 본다.
 * 공사는 MDB 폴더 트리 최상위 폴더에서 고르고(그 폴더 아래 자료만 바뀐다), 사유는 목록에서 고른다.
 * 적용한 이력을 수정하면 예전 적용분을 되돌린 뒤 새 내용으로 다시 적용한다.
 */
const emit = defineEmits<{ close: []; changed: [] }>()
const session = useSession()
const qc = useQueryClient()
const canTag = computed(() => session.can('screen.mdb_editor.tag'))

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

const { data: history } = useQuery({
  queryKey: ['mdb-tag-history'],
  queryFn: () => api.get<TagHistoryListResponse>('/mdb-tag-history'),
})
const { data: meta } = useQuery({
  queryKey: ['mdb-tag-meta'],
  queryFn: () => api.get<TagHistoryMeta>('/mdb-tag-history/meta'),
})
const { data: folders } = useQuery({
  queryKey: ['mdb-tag-project-folders'],
  queryFn: () => api.get<TagProjectFolderResponse>('/mdb-tag-history/project-folders'),
})

function refresh() {
  void qc.invalidateQueries({ queryKey: ['mdb-tag-history'] })
  void qc.invalidateQueries({ queryKey: ['mdb-tag-meta'] })
  void qc.invalidateQueries({ queryKey: ['mdb-tag-targets'] })
  emit('changed')
}

// ── 목록 거르기 ──
const fYear = ref<number | ''>('')
const fProject = ref('')
const fq = ref('')
const rows = computed(() =>
  (history.value?.items ?? []).filter((h) =>
    (fYear.value === '' || new Date(h.createdAt).getFullYear() === fYear.value) &&
    (!fProject.value || (h.folderName ?? h.projectName) === fProject.value) &&
    (!fq.value.trim() || [h.baseTag, h.oldTag, h.newTag, h.reason, h.reasonDetail]
      .some((v) => (v ?? '').toLowerCase().includes(fq.value.trim().toLowerCase()))),
  ),
)

const TAG_STATE: Record<string, string> = { DRAFT: '등록됨', APPLIED: '적용됨', REVERTED: '되돌림' }

// ── 대상 보기 ──
const previewId = ref<number | null>(null)
const { data: targets } = useQuery({
  queryKey: computed(() => ['mdb-tag-targets', previewId.value]),
  queryFn: () => api.get<TagTargetsResponse>(`/mdb-tag-history/${previewId.value}/targets`),
  enabled: computed(() => previewId.value !== null),
})

async function act(h: TagHistory, action: 'apply' | 'revert') {
  try {
    const r = await api.post<{ applied?: number; reverted?: number }>(`/mdb-tag-history/${h.id}/${action}`)
    say('ok', action === 'apply' ? `${r.applied}건에 적용했습니다.` : `${r.reverted}건을 되돌렸습니다.`)
    refresh()
  } catch (e) { fail(e) }
}

// ── 등록 / 수정 ──
interface Row { baseTag: string; newTag: string; count: number | null }
const form = reactive({
  open: false,
  editing: null as TagHistory | null,
  folderId: null as number | null,
  reason: '',
  reasonDetail: '',
  rows: [] as Row[],
})
const managingReasons = ref(false)
const formErr = ref('')

function openCreate() {
  Object.assign(form, {
    open: true, editing: null, folderId: null, reason: '', reasonDetail: '',
    rows: [{ baseTag: '', newTag: '', count: null }],
  })
  formErr.value = ''
}
function openEdit(h: TagHistory) {
  Object.assign(form, {
    open: true, editing: h, folderId: h.folderId ?? null, reason: h.reason ?? '',
    reasonDetail: h.reasonDetail ?? '',
    rows: [{ baseTag: h.oldTag ?? h.baseTag, newTag: h.newTag ?? '', count: null }],
  })
  formErr.value = ''
  void countFor(form.rows[0]!)
}

const timers = new WeakMap<Row, ReturnType<typeof setTimeout>>()
function scheduleCount(row: Row) {
  row.count = null
  clearTimeout(timers.get(row))
  timers.set(row, setTimeout(() => void countFor(row), 350))
}
async function countFor(row: Row) {
  const tag = row.baseTag.trim()
  if (!tag) { row.count = null; return }
  try {
    const r = await api.get<TagTargetsResponse>(
      `/mdb-tag-history/tag-targets${qs({ tag, folderId: form.folderId ?? undefined })}`)
    if (row.baseTag.trim() === tag) row.count = r.items.length
  } catch { row.count = null }
}
function recountAll() { for (const r of form.rows) scheduleCount(r) }

/** 이력 문구 미리보기 — 기존 Note 한 줄 형식을 따른다 */
function lineFor(r: Row) {
  const f = folders.value?.items.find((x) => x.folderId === form.folderId)
  return [
    r.baseTag.trim() && r.newTag.trim() ? `Tag No 변경_${r.baseTag.trim()} → ${r.newTag.trim()}` : '',
    f?.year ? `${f.year}년` : '', f?.name ?? '', form.reason, form.reasonDetail.trim(),
  ].filter(Boolean).join('_')
}

async function submitForm() {
  formErr.value = ''
  const filled = form.rows.filter((r) => r.baseTag.trim() || r.newTag.trim())
  if (!filled.length) { formErr.value = '바꿀 Tag 를 한 줄 이상 적어 주세요.'; return }
  if (filled.some((r) => !r.baseTag.trim() || !r.newTag.trim())) {
    formErr.value = '줄마다 바꿀 Tag 와 새 Tag 를 모두 적어 주세요.'; return
  }
  try {
    if (form.editing) {
      const r = filled[0]!
      const out = await api.patch<{ reapplied: number | null }>(`/mdb-tag-history/${form.editing.id}`, {
        baseTag: r.baseTag.trim(), newTag: r.newTag.trim(), folderId: form.folderId,
        reason: form.reason || null, reasonDetail: form.reasonDetail.trim() || null,
      })
      say('ok', out.reapplied !== null
        ? `이력을 고치고 새 내용으로 다시 적용했습니다 (${out.reapplied}건).` : '이력을 고쳤습니다.')
    } else {
      for (const r of filled) {
        await api.post('/mdb-tag-history', {
          baseTag: r.baseTag.trim(), newTag: r.newTag.trim(), folderId: form.folderId,
          reason: form.reason || null, reasonDetail: form.reasonDetail.trim() || null,
        })
      }
      say('ok', `Tag 이력 ${filled.length}건을 등록했습니다. 대상을 확인한 뒤 적용하세요.`)
    }
    form.open = false
    refresh()
  } catch (e) {
    formErr.value = e instanceof ApiError ? e.message : '저장하지 못했습니다.'
  }
}
</script>

<template>
  <Modal wide title="Tag No 이력관리" @close="emit('close')">
    <p class="muted hint">
      설비 Tag 가 바뀌면(설비 교체·체계 변경·오기 정정) 해당 자료의 Tag 를 한꺼번에 고칩니다.
      <strong>적용 전에 바뀔 대상을 먼저 확인</strong>하고, 적용한 뒤에도 되돌릴 수 있습니다.
    </p>
    <div v-if="message" class="msg" :class="message.kind">{{ message.text }}</div>

    <div class="bar">
      <select v-model="fYear">
        <option value="">연도 전체</option>
        <option v-for="y in meta?.years ?? []" :key="y" :value="y">{{ y }}</option>
      </select>
      <select v-model="fProject">
        <option value="">공사 전체</option>
        <option v-for="p in meta?.projects ?? []" :key="p" :value="p">{{ p }}</option>
      </select>
      <input v-model="fq" type="text" placeholder="Tag / 사유 검색" style="width:170px" />
      <span style="flex:1" />
      <button class="btn btn-sm btn-primary" :disabled="!canTag" @click="openCreate">이력 등록</button>
    </div>

    <div class="scroll">
      <table class="grid">
        <thead>
          <tr><th>바꿀 Tag</th><th>새 Tag</th><th>공사(범위)</th><th>사유</th><th>비고</th><th>상태</th>
              <th>적용</th><th>등록자</th><th>등록일</th><th style="width:210px">조치</th></tr>
        </thead>
        <tbody>
          <tr v-for="h in rows" :key="h.id" :class="{ applied: h.state === 'APPLIED' }">
            <td>{{ h.oldTag ?? h.baseTag }}</td>
            <td>{{ h.newTag ?? '-' }}</td>
            <td class="muted">{{ h.folderName ?? h.projectName ?? '전체' }}</td>
            <td>{{ h.reason ?? '-' }}</td>
            <td class="muted">{{ h.reasonDetail ?? '' }}</td>
            <td class="tc">{{ TAG_STATE[h.state] ?? h.state }}</td>
            <td class="tc">{{ h.appliedCount }}</td>
            <td class="tc">{{ h.createdBy ?? '-' }}</td>
            <td class="tc">{{ h.createdAt.slice(0, 10) }}</td>
            <td class="tc">
              <button class="btn btn-sm" @click="previewId = h.id">대상</button>
              <button class="btn btn-sm" :disabled="!canTag" @click="openEdit(h)">수정</button>
              <button v-if="h.state !== 'APPLIED'" class="btn btn-sm" :disabled="!canTag" @click="act(h, 'apply')">
                {{ h.state === 'REVERTED' ? '다시 적용' : '적용' }}</button>
              <button v-else class="btn btn-sm" :disabled="!canTag" @click="act(h, 'revert')">되돌리기</button>
            </td>
          </tr>
          <tr v-if="!rows.length"><td colspan="10" class="tc muted">Tag 이력이 없습니다.</td></tr>
        </tbody>
      </table>
    </div>

    <template v-if="previewId !== null">
      <h3>바뀔 대상 ({{ targets?.items.length ?? 0 }}건)
        <button class="btn btn-sm" @click="previewId = null">닫기</button></h3>
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

    <template #footer>
      <button class="btn" @click="emit('close')">닫기</button>
    </template>
  </Modal>

  <!-- 등록 / 수정 -->
  <Modal v-if="form.open" wide :title="form.editing ? 'Tag 이력 수정' : 'Tag 이력 등록'" @close="form.open = false">
    <p v-if="form.editing?.state === 'APPLIED'" class="muted hint">
      이미 적용된 이력입니다. Tag·공사를 바꾸면 예전 적용분을 되돌린 뒤 새 내용으로 다시 적용합니다.
    </p>
    <div class="form-grid">
      <label>공사(범위)</label>
      <select v-model="form.folderId" @change="recountAll">
        <option :value="null">(고르지 않음 — 전체 자료)</option>
        <option v-for="f in folders?.items ?? []" :key="f.folderId" :value="f.folderId">{{ f.name }}</option>
      </select>
      <label>사유</label>
      <div class="inline">
        <select v-model="form.reason" style="flex:1">
          <option value="">(고르지 않음)</option>
          <option v-if="form.reason && !(meta?.reasons ?? []).includes(form.reason)" :value="form.reason">
            {{ form.reason }} (목록에 없음)</option>
          <option v-for="r in meta?.reasons ?? []" :key="r" :value="r">{{ r }}</option>
        </select>
        <button class="btn btn-sm" title="사유 목록 편집" @click="managingReasons = true">✎</button>
      </div>
      <label>비고</label>
      <input v-model="form.reasonDetail" type="text" maxlength="2000" placeholder="예: Pump 유종 변경으로 인해" />
    </div>

    <table class="grid rows">
      <thead><tr><th>바꿀 Tag</th><th style="width:24px"></th><th>새 Tag</th><th style="width:110px">대상 자료</th>
                 <th>이력 문구 미리보기</th><th style="width:44px"></th></tr></thead>
      <tbody>
        <tr v-for="(r, i) in form.rows" :key="i">
          <td><input v-model="r.baseTag" type="text" placeholder="예: P1000A" maxlength="100"
                     style="width:100%" @input="scheduleCount(r)" /></td>
          <td class="tc muted">→</td>
          <td><input v-model="r.newTag" type="text" placeholder="새 Tag No" maxlength="100" style="width:100%" /></td>
          <td class="tc">{{ r.baseTag.trim() ? (r.count === null ? '…' : `${r.count}건`) : '-' }}</td>
          <td class="muted small">{{ lineFor(r) }}</td>
          <td class="tc">
            <button v-if="!form.editing && form.rows.length > 1" class="btn btn-sm"
                    @click="form.rows.splice(i, 1)">×</button>
          </td>
        </tr>
      </tbody>
    </table>
    <button v-if="!form.editing" class="btn btn-sm" style="margin-top:6px"
            @click="form.rows.push({ baseTag: '', newTag: '', count: null })">+ 줄 추가</button>
    <p v-if="formErr" class="err">{{ formErr }}</p>

    <template #footer>
      <button class="btn" @click="form.open = false">취소</button>
      <button class="btn btn-primary" :disabled="!canTag" @click="submitForm">{{ form.editing ? '수정' : '등록' }}</button>
    </template>
  </Modal>

  <TypeListModal v-if="managingReasons" kind="mdb-tag-reasons" @close="managingReasons = false" />
</template>

<style scoped>
.hint { font-size: var(--fs-sm); margin: 0 0 8px; }
.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.scroll { max-height: 45vh; overflow: auto; }
.grid tr.applied { background: var(--accent-soft); }
h3 { font-size: var(--fs-base); margin: 16px 0 6px; display: flex; gap: 8px; align-items: center; }
.form-grid { display: grid; grid-template-columns: 90px 1fr; gap: 8px 10px; align-items: center; margin-bottom: 12px; }
.form-grid label { font-size: var(--fs-sm); color: var(--text-muted); }
.inline { display: flex; gap: 6px; }
.rows td { vertical-align: middle; }
.small { font-size: var(--fs-sm); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 6px 0 0; }
.msg { padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; font-size: var(--fs-sm); background: var(--accent-soft); }
.msg.err { color: var(--danger); background: var(--surface-3); }
</style>
