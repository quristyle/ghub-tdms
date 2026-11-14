<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MdbDetail, MdbMeta, MdbNavResponse, MdbSourcesResponse, MdbUpdateRequest } from '@tdms/contracts'
import Tabs from '@/ui/Tabs.vue'
import PdfViewer from '@/ui/PdfViewer.vue'
import DrawingPreview from '@/ui/DrawingPreview.vue'
import { api, ApiError, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { loadSearch, toServerFilters } from '@/lib/mdbSearch'

/**
 * MDB 자료 상세 — 자료내용 / 미리보기 두 탭 (리비전·반출이 없다).
 *
 *   · [처음·이전·다음·끝]과 "n / 전체" — MDB 조회의 검색 조건·정렬 그대로(탭 안에서 기억한 것)
 *   · ✎ — 설비유형·자료유형·Tag No·Note 를 이 자리에서 고친다 (MDB 관리의 '자료 편집' 권한)
 *   · 원본/사본 — 같은 이름의 원본(DWG 등)과 사본(PDF)이 있으면 미리보기에서 바꿔 보고, 따로 받는다
 */

const route = useRoute()
const router = useRouter()
const qc = useQueryClient()
const session = useSession()

const id = computed(() => Number(route.params.id))
const tab = ref<'info' | 'preview'>(route.query.tab === 'preview' ? 'preview' : 'info')
const TABS = [{ key: 'info', label: '자료내용' }, { key: 'preview', label: '미리보기' }]

const { data: doc, isLoading } = useQuery({
  queryKey: computed(() => ['mdb', 'detail', id.value]),
  queryFn: () => api.get<MdbDetail>(`/mdb/${id.value}`),
  staleTime: staleTime.detail,
})

// ── 원본/사본 ────────────────────────────────────────────────────────────
const { data: sources } = useQuery({
  queryKey: computed(() => ['mdb', 'sources', id.value]),
  queryFn: () => api.get<MdbSourcesResponse>(`/mdb/${id.value}/sources`),
  staleTime: staleTime.detail,
})

/** 지금 미리보기가 보여 주는 쪽. 기본은 사본(PDF), 보관 목록에서 원본으로 열었으면(pv=o) 원본 */
const source = ref<'pdf' | 'original'>(route.query.pv === 'o' ? 'original' : 'pdf')
const showOriginal = computed(() => {
  const s = sources.value
  if (!s) return false
  if (!s.pdfId) return s.originalPreviewable
  return source.value === 'original' && s.originalPreviewable
})
function onSwitch(to: string) {
  source.value = to === 'original' ? 'original' : 'pdf'
}

watch(id, () => {
  source.value = route.query.pv === 'o' ? 'original' : 'pdf'
  tab.value = route.query.tab === 'preview' ? 'preview' : 'info'
  editing.value = null
})

// ── 넘겨보기 — 목록과 같은 조건·정렬 ──────────────────────────────────────
const navFilters = toServerFilters(loadSearch())
const { data: nav } = useQuery({
  queryKey: computed(() => ['mdb', 'nav', navFilters, id.value]),
  queryFn: () => api.get<MdbNavResponse>(`/mdb/nav${qs({ ...navFilters, id: id.value })}`),
  staleTime: staleTime.list,
})
const posInput = ref('')
watch(nav, (n) => { posInput.value = n?.position ? String(n.position) : '' }, { immediate: true })

function go(target: number | null | undefined) {
  if (target && target !== id.value) void router.push(`/mdb/${target}`)
}
async function jumpTo() {
  const pos = Number(posInput.value)
  if (!Number.isInteger(pos) || pos < 1) return
  try {
    const r = await api.get<MdbNavResponse>(`/mdb/nav${qs({ ...navFilters, pos })}`)
    go(r.id)
  } catch { /* 그 자리가 없으면 그대로 둔다 */ }
}

// ── ✎ 고치기 ───────────────────────────────────────────────────────────
const canEdit = computed(() => session.can('screen.mdb_editor.document'))
type Field = 'equipmentType' | 'docType' | 'tags' | 'note'
const FIELD_LABEL: Record<Field, string> = {
  equipmentType: '설비유형', docType: '자료유형', tags: 'Tag No', note: 'Note',
}
const editing = ref<Field | null>(null)
const editValue = ref('')
const editErr = ref('')
const savingEdit = ref(false)

const { data: meta } = useQuery({
  queryKey: ['mdb-meta'],
  queryFn: () => api.get<MdbMeta>('/mdb/meta'),
  staleTime: staleTime.types,
  enabled: computed(() => canEdit.value),
})

/** 어느 항목의 ✎를 누르든 편집칸은 Note 아래 한 자리에 열린다 (기존 CM 지시) */
function startEdit(f: Field) {
  const d = doc.value
  if (!d) return
  editing.value = f
  editErr.value = ''
  editValue.value =
    f === 'tags' ? d.tags.join(', ')
      : f === 'equipmentType' ? d.equipmentType ?? ''
        : f === 'docType' ? d.docType ?? ''
          : d.note ?? ''
}

async function saveEdit() {
  const f = editing.value
  if (!f || !doc.value) return
  const v = editValue.value.trim()
  const body: MdbUpdateRequest =
    f === 'tags' ? { tags: v.split(/[,\n]/).map((t) => t.trim()).filter(Boolean) }
      : f === 'equipmentType' ? { equipmentType: v || null }
        : f === 'docType' ? { docType: v || null }
          : { note: v || null }
  savingEdit.value = true
  editErr.value = ''
  try {
    await api.patch(`/mdb-editor/files/${doc.value.id}`, body)
    editing.value = null
    await qc.invalidateQueries({ queryKey: ['mdb'] })
    if (f === 'equipmentType' || f === 'docType') void qc.invalidateQueries({ queryKey: ['mdb-meta'] })
  } catch (e) {
    editErr.value = e instanceof ApiError ? e.message : '저장하지 못했습니다.'
  } finally {
    savingEdit.value = false
  }
}

const editChoices = computed(() =>
  editing.value === 'equipmentType' ? meta.value?.equipmentTypes ?? []
    : editing.value === 'docType' ? meta.value?.docTypes ?? [] : [])

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`
}
</script>

<template>
  <main class="app-main detail">
    <div v-if="isLoading" class="panel pad muted">불러오는 중…</div>

    <template v-else-if="doc">
      <div class="page-head">
        <div>
          <h1 class="page-title">MDB 자료 상세 보기</h1>
        </div>
      </div>

      <div class="detail-toolbar">
        <div class="detail-toolbar-left">
          <button type="button" class="back-btn" @click="router.push('/mdb')">목록으로</button>
          <span class="detail-nav">
            <span class="nav-btn-pair">
              <button type="button" class="nav-step-btn" :disabled="!nav?.firstId || nav.firstId === id"
                      title="맨 처음 자료" @click="go(nav?.firstId)"><span class="nav-arrow dbl-arrow">◀◀</span> 처음</button>
              <button type="button" class="nav-step-btn" :disabled="!nav?.prevId" title="이전 자료"
                      @click="go(nav?.prevId)"><span class="nav-arrow">◀</span> 이전</button>
            </span>
            <span class="detail-nav-count">
              <input v-model="posInput" type="text" inputmode="numeric" class="nav-pos-input"
                     title="번호를 입력하고 Enter" @keydown.enter="jumpTo" />
              <span>/ {{ nav?.total ?? '·' }}</span>
            </span>
            <span class="nav-btn-pair">
              <button type="button" class="nav-step-btn" :disabled="!nav?.nextId" title="다음 자료"
                      @click="go(nav?.nextId)">다음 <span class="nav-arrow">▶</span></button>
              <button type="button" class="nav-step-btn" :disabled="!nav?.lastId || nav.lastId === id"
                      title="맨 끝 자료" @click="go(nav?.lastId)">끝 <span class="nav-arrow dbl-arrow">▶▶</span></button>
            </span>
          </span>
        </div>
        <div class="page-actions">
          <template v-if="sources && (sources.pdfId || sources.originalId)">
            <a v-if="sources.originalId" :href="`/api/mdb/files/${sources.originalId}/download`">
              원본({{ sources.originalExt }}) 다운로드
            </a>
            <a v-if="sources.pdfId" :href="`/api/mdb/files/${sources.pdfId}/download`">PDF 다운로드</a>
          </template>
          <a v-else :href="`/api/mdb/files/${doc.id}/download`">받기</a>
        </div>
      </div>

      <div class="panel body">
        <Tabs v-model="tab" :tabs="TABS" />

        <section v-if="tab === 'info'" class="pad">
          <table class="kv">
            <tbody>
              <tr><th>자료명</th><td colspan="3">{{ doc.title }}</td></tr>
              <tr>
                <th>경로</th>
                <td colspan="3">{{ doc.folderPath.map(f => f.name).join(' › ') }}</td>
              </tr>
              <tr>
                <th>설비유형</th>
                <td>
                  {{ doc.equipmentType ?? '-' }}
                  <button v-if="canEdit" class="pen" title="설비유형 고치기" @click="startEdit('equipmentType')">✎</button>
                </td>
                <th>자료유형</th>
                <td>
                  {{ doc.docType ?? '-' }}
                  <button v-if="canEdit" class="pen" title="자료유형 고치기" @click="startEdit('docType')">✎</button>
                </td>
              </tr>
              <tr>
                <th>공사</th><td>{{ doc.projectName ?? '-' }}</td>
                <th>연도</th><td>{{ doc.year ?? '-' }}</td>
              </tr>
              <tr>
                <th>분류</th><td>{{ doc.isShared ? '공용' : '전용' }}</td>
                <th>확인필요</th><td>{{ doc.needsCheck ? '예' : '아니오' }}</td>
              </tr>
              <tr>
                <th>파일</th>
                <td>
                  {{ doc.originalFilename }} ({{ size(doc.byteSize) }})
                  <span v-if="sources?.pdfId && sources?.originalId" class="muted small">
                    · 원본({{ sources.originalExt }})·사본(PDF) 있음
                  </span>
                </td>
                <th>등록</th>
                <td>{{ doc.createdAt.slice(0, 10) }} {{ doc.uploadedBy ?? '' }}</td>
              </tr>
              <tr>
                <th>Tag No</th>
                <td colspan="3">
                  <span v-for="t in doc.tags" :key="t" class="tag">{{ t }}</span>
                  <span v-if="!doc.tags.length" class="muted">-</span>
                  <button v-if="canEdit" class="pen" title="Tag No 고치기" @click="startEdit('tags')">✎</button>
                </td>
              </tr>
              <tr>
                <th>Note</th>
                <td colspan="3" class="note">
                  {{ doc.note ?? '-' }}
                  <button v-if="canEdit" class="pen" title="Note 고치기" @click="startEdit('note')">✎</button>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- 어느 ✎를 누르든 편집칸은 여기(Note 아래)에 열린다 -->
          <div v-if="editing" class="edit-area">
            <div class="edit-head">{{ FIELD_LABEL[editing] }} 고치기</div>
            <textarea v-if="editing === 'note'" v-model="editValue" rows="4" maxlength="2000" />
            <template v-else-if="editing === 'tags'">
              <input v-model="editValue" type="text" placeholder="쉼표로 나눠 적습니다 (예: P-101A, P-101B)" />
            </template>
            <template v-else>
              <input v-model="editValue" type="text" maxlength="100" list="mdb-edit-choices"
                     placeholder="고르거나 새로 적습니다. 비우면 지웁니다." />
              <datalist id="mdb-edit-choices">
                <option v-for="c in editChoices" :key="c" :value="c" />
              </datalist>
            </template>
            <div class="edit-actions">
              <span v-if="editErr" class="err">{{ editErr }}</span>
              <span style="flex:1" />
              <button class="btn btn-sm" @click="editing = null">취소</button>
              <button class="btn btn-sm btn-primary" :disabled="savingEdit" @click="saveEdit">
                {{ savingEdit ? '저장 중…' : '확인' }}
              </button>
            </div>
          </div>
        </section>

        <section v-else class="preview">
          <template v-if="sources">
            <DrawingPreview v-if="showOriginal && sources.originalId" :key="`o${sources.originalId}`"
                            base="mdb" :file-id="sources.originalId" :label="sources.originalExt ?? undefined"
                            :alt-available="!!sources.pdfId" @switch-source="onSwitch" />
            <PdfViewer v-else-if="sources.pdfId" :key="`p${sources.pdfId}`" :file-id="sources.pdfId"
                       :file-url="`/api/mdb/files/${sources.pdfId}/view`"
                       :view-mode="sources.originalId ? 'pdf' : undefined"
                       :alt-available="sources.originalPreviewable"
                       :original-label="sources.originalExt ?? undefined"
                       @switch-source="onSwitch" />
            <div v-else class="pad muted tc">
              이 형식({{ doc.fileExt.toUpperCase() }})은 미리보기를 지원하지 않습니다.
              <div style="margin-top:12px">
                <a class="btn btn-sm" :href="`/api/mdb/files/${doc.id}/download`">
                  {{ doc.fileExt.toUpperCase() }} 받기
                </a>
              </div>
            </div>
          </template>
          <div v-else class="pad muted">불러오는 중…</div>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; flex: 0 0 auto; flex-wrap: wrap; }
.head h1 { font-size: var(--fs-md); margin: 0 10px 0 0; font-weight: 600; }
.nav { display: inline-flex; align-items: center; gap: 4px; }
.pos { display: inline-flex; align-items: center; gap: 4px; margin: 0 4px; font-size: var(--fs-sm); }
.pos input { width: 52px; text-align: center; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.body > section { flex: 1; overflow: auto; min-height: 0; }
.pad { padding: 14px; }
.small { font-size: var(--fs-sm); }
.preview { display: flex; flex-direction: column; }
.kv { border: 1px solid var(--border); }
.kv th, .kv td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.kv th { background: var(--bg); width: 100px; font-weight: 600; white-space: nowrap; }
.note { white-space: pre-wrap; }
.tag {
  display: inline-block; font-size: 11px; padding: 1px 7px; margin-right: 4px;
  border: 1px solid var(--border-strong); border-radius: 9px;
}
.pen { border: 0; background: none; cursor: pointer; color: var(--text-muted); padding: 0 4px; }
.pen:hover { color: var(--primary); }
.edit-area {
  margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  display: flex; flex-direction: column; gap: 8px; max-width: 720px;
}
.edit-head { font-weight: 600; font-size: var(--fs-sm); }
.edit-area textarea, .edit-area input { width: 100%; box-sizing: border-box; }
.edit-actions { display: flex; align-items: center; gap: 6px; }
.err { color: var(--danger, #c0392b); font-size: var(--fs-sm); }
</style>
