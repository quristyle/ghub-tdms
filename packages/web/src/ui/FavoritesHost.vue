<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { FavoriteItem, FavoriteListResponse } from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import PdfViewer from '@/ui/PdfViewer.vue'
import { api, ApiError } from '@/lib/api'
import { downloadXlsx } from '@/lib/xlsx'
import {
  FAV_LIST_TITLE, FAV_SAVE_TITLE, asidePreview, bumpCount, favDefaultName, favPreviewUrl,
  favUniqueName, listOpen, saveRequest, type FavSlot,
} from '@/lib/favorites'

/**
 * 사용자 보관 — 보관 팝업 · 보관 목록 팝업 · 돋보기 미리보기 (기존 favorites.js).
 *
 * AppShell 에 한 번만 붙는다. 어느 화면에서 보관하든 같은 팝업·같은 동작이어야 하므로
 * 화면마다 따로 만들지 않는다.
 *
 * 보관하는 것은 자료의 사본이 아니라 "그 자료로 가는 바로가기 + 미리보기에서 그린 편집 내용"이다.
 * 지워도 자료·파일·이력은 그대로 남는다.
 */

const router = useRouter()
const qc = useQueryClient()

const closeSave = () => { saveRequest.value = null }
const closeList = () => { listOpen.value = false }
const closeAside = () => { asidePreview.value = null }

const fmt = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '')

// ═══════════════════════════════════════════════════════════════════════
// 보관 팝업 — 미리보기 [»] 안의 [보관하기]·[다른 이름으로 보관]이 부른다
// ═══════════════════════════════════════════════════════════════════════

const req = saveRequest
const slots = ref<FavSlot[]>([])
const used = ref(0)
const limit = ref(50)
/** 덮어쓸 자리. null = 새로 보관 */
const slotId = ref<number | null>(null)
const saveName = ref('')
const saveNote = ref('')
const saving = ref(false)
const saveErr = ref('')

const mode = computed(() => (req.value?.mode === 'saveAs' ? 'saveAs' : 'save'))
const baseName = computed(() => favDefaultName(req.value?.target?.name))
const full = computed(() => used.value >= limit.value)

/**
 * [보관하기]로 어떤 자리를 덮어쓸 때의 이름.
 *  · 같은 자료의 자리면 그 자리 이름 그대로 — [다른 이름으로 보관]으로 적어 둔 이름을 바꾸지 않는다.
 *    예전 규칙으로 저절로 붙었던 "(Markup)" 꼬리만 뗀다.
 *  · 다른 자료의 자리면 지금 자료명 — 옛 이름을 두면 이름과 실제 자료가 어긋난다.
 */
function slotFillName(slot: FavSlot | undefined): string {
  if (!slot || !slot.same) return baseName.value
  return slot.name === `${baseName.value}(Markup)` ? baseName.value : slot.name
}
function syncName() {
  if (mode.value !== 'save') return
  saveName.value = slotFillName(slots.value.find((s) => s.id === slotId.value))
}

watch(req, (o) => {
  saveErr.value = ''
  if (!o) return
  if (!o.target || (!o.target.documentId && !o.target.mdbFileId)) {
    window.alert('보관할 자료를 알 수 없습니다. 자료를 열고 다시 눌러 주세요.')
    req.value = null
    return
  }
  slots.value = [...(o.allSaved ?? [])]
  used.value = o.used ?? slots.value.length
  limit.value = o.limit ?? 50
  const saved = o.saved ?? []
  // [보관하기]는 지금 열려 있는 자리(주소의 fav 번호·방금 보관한 자리)를 먼저, 없으면 이 자료의 최근 것.
  // [다른 이름으로 보관]은 언제나 "새로 보관"에서 시작한다.
  const linked = saved.find((f) => f.id === o.linkedId) ?? saved[0] ?? null
  slotId.value = mode.value === 'save' && linked ? linked.id : null
  saveName.value = mode.value === 'saveAs'
    ? favUniqueName(baseName.value, slots.value)
    : slotFillName(slots.value.find((s) => s.id === slotId.value))
  saveNote.value = ''
})

function pickSlot(id: number | null) {
  if (id === null && full.value) return
  slotId.value = id
  syncName()
}

const slotTargetName = (s: FavSlot) => (s.missing ? '(삭제됨)' : s.target_name || s.name || '')

async function deleteSlot(s: FavSlot) {
  const ok = window.confirm(
    `"${slotTargetName(s)}"을(를) 보관 목록에서 지웁니다.\n` +
    `${s.has_markup ? '함께 보관해 둔 편집 내용도 사라집니다.\n' : ''}자료 자체는 그대로 남습니다.\n\n지울까요?`,
  )
  if (!ok) return
  try {
    await api.delete(`/favorites/${s.id}`)
  } catch (e) {
    window.alert(e instanceof ApiError ? e.message : '지우지 못했습니다.')
    return
  }
  slots.value = slots.value.filter((x) => x.id !== s.id)
  if (slotId.value === s.id) { slotId.value = null; syncName() }
  used.value = Math.max(0, used.value - 1)
  bumpCount()
  try { req.value?.onChanged?.() } catch { /* 미리보기가 그 사이 닫혔으면 넘어간다 */ }
}

function exportSlots() {
  void downloadXlsx(FAV_SAVE_TITLE, {
    sheetName: FAV_SAVE_TITLE,
    headers: ['자료명', '설명', '구분', '편집', '보관 일시'],
    rows: slots.value.map((s) => [
      slotTargetName(s), s.description ?? '', s.kind, s.has_markup ? '있음' : '', fmt(s.updated_at),
    ]),
  })
}

function previewSlot(s: FavSlot) {
  const url = favPreviewUrl(s.kind, s.pdf_file_id)
  if (!url) { window.alert('이 자료는 미리볼 PDF 가 없습니다.'); return }
  asidePreview.value = { title: slotTargetName(s), fileUrl: url, favoriteId: s.has_markup ? s.id : null }
}

async function submitSave() {
  const o = req.value
  if (!o?.target) return
  const name = saveName.value.trim()
  if (!name) { saveErr.value = '보관 이름을 입력하세요.'; return }
  const overwriteId = slotId.value
  if (overwriteId === null && full.value) {
    saveErr.value = `보관은 ${limit.value}개까지 할 수 있습니다. 덮어쓸 자리를 고르거나, 표에서 쓰지 않는 것을 지워 주세요.`
    return
  }
  if (overwriteId !== null) {
    const victim = slots.value.find((s) => s.id === overwriteId)
    // 다른 자료의 자리를 덮어쓰면 그 자리가 가리키던 자료가 바뀐다 — 분명히 적는다
    const other = victim && !victim.same
      ? `\n그 자리는 지금 "${slotTargetName(victim)}" 자료를 가리키고 있습니다.` : ''
    if (!window.confirm(
      `"${victim ? slotTargetName(victim) : ''}"에 보관해 둔 내용을 지우고 새로 보관합니다.${other}\n\n계속할까요?`,
    )) return
  }
  saving.value = true
  saveErr.value = ''
  try {
    const r = await api.post<{ id: number }>('/favorites', {
      docClass: o.target.kind,
      documentId: o.target.kind === 'TDB' ? o.target.documentId : null,
      mdbFileId: o.target.kind === 'MDB' ? o.target.mdbFileId : null,
      name,
      note: saveNote.value.trim() || null,
      sourceName: o.target.name || null,
      pdfFileId: o.target.pdfFileId ?? null,
      markup: o.markup ?? [],
      originalMarkup: o.originalMarkup ?? [],
      overwriteId,
      viewMode: o.viewMode === 'original' ? 'original' : null,
    })
    req.value = null
    bumpCount()
    void qc.invalidateQueries({ queryKey: ['favorites'] })
    try { o.onSaved?.(r.id) } catch { /* 미리보기가 그 사이 닫혔으면 넘어간다 */ }
    window.alert('보관했습니다.')
  } catch (e) {
    saveErr.value = e instanceof ApiError ? e.message : '보관하지 못했습니다.'
  } finally {
    saving.value = false
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 보관 목록 팝업 — 상단 [보관 (N)] 버튼
// ═══════════════════════════════════════════════════════════════════════

const { data: list, isFetching: listLoading, refetch } = useQuery({
  queryKey: ['favorites', 'list'],
  queryFn: () => api.get<FavoriteListResponse>('/favorites'),
  enabled: computed(() => listOpen.value),
  staleTime: 0,
})
const items = computed(() => list.value?.items ?? [])
const checked = ref(new Set<number>())
const listErr = ref('')
watch(listOpen, (o) => {
  if (o) { checked.value = new Set(); listErr.value = ''; void refetch() }
})

const allChecked = computed(() => items.value.length > 0 && items.value.every((i) => checked.value.has(i.id)))
function toggleAll(on: boolean) {
  checked.value = new Set(on ? items.value.map((i) => i.id) : [])
}
function toggleOne(id: number) {
  const s = new Set(checked.value)
  s.has(id) ? s.delete(id) : s.add(id)
  checked.value = s
}

const stateLabel = (i: FavoriteItem) => (i.missing ? '삭제됨' : i.renamed ? '이름 바뀜' : '정상')

/**
 * 보관해 둔 것을 연다 — 상세 화면으로 가서 미리보기 탭을 연다.
 * 편집 내용이 있으면 주소에 fav 번호를 실어 보내고, 미리보기가 자료를 연 뒤 그대로 되살린다.
 * 원본을 보다가 보관한 것이면 원본부터 보여준다(pv=o).
 */
function openItem(i: FavoriteItem) {
  if (i.missing) return
  const query: Record<string, string> = { tab: 'preview' }
  if (i.hasMarkup) query.fav = String(i.id)
  if (i.viewMode === 'original') query.pv = 'o'
  listOpen.value = false
  if (i.kind === 'TDB' && i.documentId) void router.push({ path: `/documents/${i.documentId}`, query })
  else if (i.kind === 'MDB' && i.mdbFileId) void router.push({ path: `/mdb/${i.mdbFileId}`, query })
}

function previewItem(i: FavoriteItem) {
  const url = favPreviewUrl(i.kind, i.pdfFileId)
  if (!url) { window.alert('이 자료는 미리볼 PDF 가 없습니다.'); return }
  asidePreview.value = { title: i.currentName ?? i.name, fileUrl: url, favoriteId: i.hasMarkup ? i.id : null }
}

async function deleteChecked() {
  const ids = [...checked.value]
  if (!ids.length) { listErr.value = '지울 항목을 하나 이상 선택하세요.'; return }
  const withMarkup = items.value.filter((f) => ids.includes(f.id) && f.hasMarkup).length
  if (!window.confirm(
    `보관 목록에서 ${ids.length}건을 지웁니다.\n` +
    `${withMarkup ? `그중 ${withMarkup}건은 함께 보관해 둔 편집 내용도 사라집니다.\n` : ''}` +
    '자료 자체는 그대로 남습니다.\n\n지울까요?',
  )) return
  try {
    await api.post('/favorites/delete', { ids })
    checked.value = new Set()
    listErr.value = ''
    bumpCount()
    await refetch()
  } catch (e) {
    listErr.value = e instanceof ApiError ? e.message : '지우지 못했습니다.'
  }
}

// 설명(비고) — 다른 화면의 비고 칸처럼 ✎ → [확인]
const editingId = ref<number | null>(null)
const editText = ref('')
function startEdit(i: FavoriteItem) { editingId.value = i.id; editText.value = i.note ?? '' }
async function saveEdit(i: FavoriteItem) {
  try {
    await api.post(`/favorites/${i.id}/note`, { note: editText.value.trim() || null })
    editingId.value = null
    await refetch()
  } catch (e) {
    listErr.value = e instanceof ApiError ? e.message : '설명을 저장하지 못했습니다.'
  }
}

function exportList() {
  void downloadXlsx(FAV_LIST_TITLE, {
    sheetName: FAV_LIST_TITLE,
    headers: ['자료명', '설명', '구분', '편집', '경로', '상태', '현재 자료명', '보관 일시'],
    rows: items.value.map((i) => [
      i.name, i.note ?? '', i.kind, i.hasMarkup ? '있음' : '', i.path ?? '',
      stateLabel(i), i.currentName ?? '', fmt(i.createdAt),
    ]),
  })
}
</script>

<template>
  <div class="favwrap">
    <!-- 보관 팝업 -->
    <Modal v-if="req" :title="FAV_SAVE_TITLE" wide @close="closeSave">
      <label class="lbl" for="fav-save-name">보관 이름</label>
      <input id="fav-save-name" v-model="saveName" type="text" class="full"
             :readonly="mode !== 'saveAs'"
             :title="mode !== 'saveAs' ? '[보관하기]는 자료명 그대로 보관합니다. 이름을 바꾸려면 [다른 이름으로 보관]을 쓰세요.' : ''" />

      <label class="lbl" for="fav-save-desc">설명</label>
      <textarea id="fav-save-desc" v-model="saveNote" rows="3" class="full" />

      <div class="slot-bar">
        <span class="lbl">보관 위치</span>
        <label class="newslot" :class="{ off: full }">
          <input type="radio" name="fav-slot" :checked="slotId === null" :disabled="full" @change="pickSlot(null)" />
          새로 보관 (<b>{{ used + 1 }}</b> / {{ limit }})
        </label>
        <span style="flex:1" />
        <button class="btn btn-sm" type="button" @click="exportSlots">엑셀 내보내기</button>
      </div>
      <div class="scroll">
        <table class="grid">
          <thead>
            <tr>
              <th style="width:44px">선택</th><th style="width:40px">No</th><th>자료명</th><th>설명</th>
              <th style="width:52px">구분</th><th style="width:56px">편집</th>
              <th style="width:126px">보관 일시</th><th style="width:60px">조치</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in slots" :key="s.id" class="click" :class="{ cur: slotId === s.id, warn: s.missing }"
                @click="pickSlot(s.id)">
              <td class="tc"><input type="radio" name="fav-slot" :checked="slotId === s.id" /></td>
              <td class="tc">{{ i + 1 }}</td>
              <td :title="slotTargetName(s)">
                <button class="lens" type="button" title="미리보기" @click.stop="previewSlot(s)">🔍</button>
                {{ slotTargetName(s) }}
                <span v-if="s.same" class="tag tag-info">이 자료</span>
              </td>
              <td class="ellipsis" :title="s.description ?? ''">{{ s.description }}</td>
              <td class="tc">{{ s.kind }}</td>
              <td class="tc"><span v-if="s.has_markup" class="tag">있음</span></td>
              <td class="tc muted">{{ fmt(s.updated_at) }}</td>
              <td class="tc"><button class="btn btn-sm" type="button" @click.stop="deleteSlot(s)">삭제</button></td>
            </tr>
            <tr v-if="!slots.length"><td colspan="8" class="tc muted">보관해 둔 자료가 없습니다.</td></tr>
          </tbody>
        </table>
      </div>
      <p v-if="saveErr" class="err">{{ saveErr }}</p>
      <template #footer>
        <button class="btn" @click="closeSave">취소</button>
        <button class="btn btn-primary" :disabled="saving" @click="submitSave">{{ saving ? '보관 중…' : '보관' }}</button>
      </template>
    </Modal>

    <!-- 보관 목록 팝업 -->
    <Modal v-if="listOpen" :title="FAV_LIST_TITLE" wide @close="closeList">
      <div class="slot-bar">
        <span>보관 <b>({{ items.length }} / {{ list?.limit ?? 50 }})</b></span>
        <span v-if="listLoading" class="muted">· 불러오는 중…</span>
        <span style="flex:1" />
        <button class="btn btn-sm" type="button" @click="deleteChecked">선택 삭제</button>
        <button class="btn btn-sm" type="button" @click="exportList">엑셀 내보내기</button>
      </div>
      <div class="scroll tall">
        <table class="grid">
          <thead>
            <tr>
              <th style="width:40px">No</th>
              <th style="width:34px"><input type="checkbox" :checked="allChecked" @change="toggleAll(($event.target as HTMLInputElement).checked)" /></th>
              <th style="width:240px">자료명</th><th>설명</th>
              <th style="width:52px">구분</th><th style="width:56px">편집</th><th>경로</th>
              <th style="width:84px">상태</th><th style="width:126px">보관 일시</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, n) in items" :key="it.id" :class="{ warn: it.missing }">
              <td class="tc">{{ n + 1 }}</td>
              <td class="tc"><input type="checkbox" :checked="checked.has(it.id)" @change="toggleOne(it.id)" /></td>
              <td>
                <button class="lens" type="button" title="미리보기" :disabled="it.missing || it.pdfFileId === null"
                        @click="previewItem(it)">🔍</button>
                <span v-if="it.missing">{{ it.name }}</span>
                <a v-else href="#" @click.prevent="openItem(it)">{{ it.name }}</a>
                <div v-if="it.renamed" class="muted small">현재: {{ it.currentName }}</div>
              </td>
              <td>
                <template v-if="editingId === it.id">
                  <span class="note-edit">
                    <input v-model="editText" type="text" maxlength="2000" @keydown.enter="saveEdit(it)" />
                    <button class="btn btn-sm btn-primary" type="button" @click="saveEdit(it)">확인</button>
                    <button class="btn btn-sm" type="button" @click="editingId = null">취소</button>
                  </span>
                </template>
                <span v-else class="note-view">
                  <span class="ellipsis" :title="it.note ?? ''">{{ it.note }}</span>
                  <button class="pen" type="button" title="설명 고치기" @click="startEdit(it)">✎</button>
                </span>
              </td>
              <td class="tc">{{ it.kind }}</td>
              <td class="tc"><span v-if="it.hasMarkup" class="tag">있음</span></td>
              <td class="ellipsis" :title="it.path ?? ''">{{ it.path }}</td>
              <td class="tc">
                <span class="tag" :class="it.missing || it.renamed ? 'tag-warn' : ''">{{ stateLabel(it) }}</span>
              </td>
              <td class="tc muted">{{ fmt(it.createdAt) }}</td>
            </tr>
            <tr v-if="!items.length && !listLoading">
              <td colspan="9" class="tc muted">보관한 자료가 없습니다. 미리보기의 [»] 안 [보관하기]로 보관해 보세요.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="listErr" class="err">{{ listErr }}</p>
    </Modal>

    <!-- 돋보기 미리보기 — 보던 미리보기·팝업은 그대로 두고 한 겹 위에 띄운다 -->
    <Modal v-if="asidePreview" :title="`미리보기 — ${asidePreview.title}`" wide class="aside"
           @close="closeAside">
      <div class="aside-body">
        <PdfViewer :file-id="0" :file-url="asidePreview.fileUrl" :favorite-id="asidePreview.favoriteId" />
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.favwrap :deep(.box.wide) { width: min(1180px, 96vw); }
.lbl { display: block; font-size: var(--fs-sm); font-weight: 600; margin: 8px 0 4px; }
.full { width: 100%; box-sizing: border-box; }
.slot-bar { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
.slot-bar .lbl { margin: 0; }
.newslot { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); }
.newslot.off { opacity: .5; }
.scroll { max-height: 300px; overflow: auto; border: 1px solid var(--border); }
.scroll.tall { max-height: 60vh; }
.grid { width: 100%; table-layout: fixed; }
.grid td { vertical-align: middle; }
.click { cursor: pointer; }
.ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.ellipsis { display: table-cell; }
.lens {
  border: 0; background: none; cursor: pointer; padding: 0 2px; font-size: 12px;
}
.lens:disabled { opacity: .3; cursor: default; }
.note-view { display: flex; align-items: center; gap: 4px; min-width: 0; }
.note-view .ellipsis { flex: 1; min-width: 0; }
.note-edit { display: flex; gap: 4px; }
.note-edit input { flex: 1; min-width: 0; }
.pen { border: 0; background: none; cursor: pointer; color: var(--text-muted); padding: 0 2px; }
.pen:hover { color: var(--primary); }
.err { color: var(--danger, #c0392b); font-size: var(--fs-sm); margin: 8px 0 0; }
.aside-body { display: flex; flex-direction: column; height: 72vh; }
</style>
