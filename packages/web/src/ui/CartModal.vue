<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  CartFolder,
  CartFolderListResponse,
  CartItem,
  CartItemListResponse,
} from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import { api, ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'distribute', docIds: number[]): void
  (e: 'countChange', total: number): void
}>()

const session = useSession()
const currentUserId = computed(() => session.me?.id ?? null)
const qc = useQueryClient()

// ── 폴더 목록 조회 ──────────────────────────────────────────────────────
const { data: folderData, refetch: refetchFolders } = useQuery({
  queryKey: computed(() => qk.cart.folders(currentUserId.value)),
  queryFn: () => api.get<CartFolderListResponse>('/cart/folders'),
  staleTime: staleTime.worklist,
  enabled: computed(() => props.open && session.isLoggedIn),
})

const folders = computed(() => folderData.value?.items ?? [])
const totalCount = computed(() => folderData.value?.totalCount ?? 0)
const rootCount = computed(() => folderData.value?.rootCount ?? 0)

// 건수 변경을 부모에게 알린다
watch(totalCount, (cnt) => {
  emit('countChange', cnt)
})

// ── 선택된 폴더 ('all' | 'root' | folderId) ──────────────────────────────
const selectedFolderId = ref<number | 'root' | 'all'>('all')

const currentFolderName = computed(() => {
  if (selectedFolderId.value === 'all') return '전체 자료'
  if (selectedFolderId.value === 'root') return '기본 폴더 (미분류)'
  const found = folders.value.find((f) => f.id === selectedFolderId.value)
  return found?.name ?? '선택 폴더'
})

// ── 대기함 자료 목록 조회 ────────────────────────────────────────────────
const searchKeyword = ref('')
const searchInput = ref('')

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (val) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchKeyword.value = val.trim()
  }, 250)
})

const { data: itemData, refetch: refetchItems, isFetching: itemsFetching } = useQuery({
  queryKey: computed(() => [
    ...qk.cart.items(currentUserId.value, selectedFolderId.value),
    searchKeyword.value,
  ]),
  queryFn: () => {
    const params = new URLSearchParams()
    if (selectedFolderId.value !== undefined) {
      params.set('folderId', String(selectedFolderId.value))
    }
    if (searchKeyword.value) {
      params.set('q', searchKeyword.value)
    }
    const qStr = params.toString() ? `?${params.toString()}` : ''
    return api.get<CartItemListResponse>(`/cart/items${qStr}`)
  },
  staleTime: staleTime.worklist,
  enabled: computed(() => props.open && session.isLoggedIn),
})

const items = computed(() => itemData.value?.items ?? [])

// ── 체크박스 선택 ───────────────────────────────────────────────────────
const picked = ref(new Set<number>())

function togglePick(id: number) {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picked.value = next
}

function toggleAll(on: boolean) {
  picked.value = on ? new Set(items.value.map((r) => r.id)) : new Set()
}

function clearPicked() {
  picked.value = new Set()
}

// 폴더를 바꾸면 선택 초기화
watch(selectedFolderId, () => {
  clearPicked()
})

// ── 표 컬럼 정의 ────────────────────────────────────────────────────────
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '정상',
  PENDING: '검수',
  SUPERSEDED: '구버전',
  MERGE_REQUIRED: '통합요망',
  RETIRED: '폐기',
}

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'badge-ok',
  PENDING: 'badge-warning',
  SUPERSEDED: 'badge-neutral',
  MERGE_REQUIRED: 'badge-danger',
  RETIRED: 'badge-danger',
}

const COLUMNS: Column<CartItem>[] = [
  { key: 'drawingNo', label: '자료명', width: '220px' },
  { key: 'title', label: '내용' },
  { key: 'docType', label: '분류', width: '120px', render: (r: CartItem) => r.docType ?? '' },
  { key: 'folderName', label: '원본 경로', width: '160px' },
  {
    key: 'cartFolderName',
    label: '보관 폴더',
    width: '130px',
    render: (r: CartItem) => r.cartFolderName ?? '기본 폴더',
  },
  {
    key: 'updatedAt',
    label: '최종수정',
    width: '110px',
    align: 'center',
    render: (r: CartItem) => r.updatedAt.slice(0, 10),
  },
]

// ── 폴더 관리 다이얼로그 (새 폴더 / 이름 변경) ───────────────────────────
const folderModalMode = ref<'create' | 'rename' | null>(null)
const folderModalName = ref('')
const folderTargetId = ref<number | null>(null)

function openCreateFolder() {
  folderModalName.value = ''
  folderTargetId.value = null
  folderModalMode.value = 'create'
}

function openRenameFolder(f: CartFolder, e: Event) {
  e.stopPropagation()
  folderModalName.value = f.name
  folderTargetId.value = f.id
  folderModalMode.value = 'rename'
}

async function submitFolderModal() {
  const name = folderModalName.value.trim()
  if (!name) {
    toast.err('폴더 이름을 입력해주세요.')
    return
  }
  try {
    if (folderModalMode.value === 'create') {
      const res = await api.post<{ ok: true; folder: CartFolder }>('/cart/folders', {
        name,
        parentId: typeof selectedFolderId.value === 'number' ? selectedFolderId.value : null,
      })
      toast.ok(`"${name}" 폴더를 생성했습니다.`)
      folderModalMode.value = null
      await refetchFolders()
      await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
      selectedFolderId.value = res.folder.id
    } else if (folderModalMode.value === 'rename' && folderTargetId.value) {
      await api.patch(`/cart/folders/${folderTargetId.value}`, { name })
      toast.ok('폴더 이름을 변경했습니다.')
      folderModalMode.value = null
      await refetchFolders()
      await refetchItems()
      await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
    }
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '폴더 처리에 실패했습니다.')
  }
}

async function deleteFolder(f: CartFolder, e: Event) {
  e.stopPropagation()
  if (!window.confirm(`"${f.name}" 폴더를 삭제하시겠습니까?\n폴더 안의 자료는 기본 폴더로 안전하게 이동됩니다.`)) {
    return
  }
  try {
    await api.delete(`/cart/folders/${f.id}`)
    toast.ok(`"${f.name}" 폴더를 삭제했습니다.`)
    if (selectedFolderId.value === f.id) {
      selectedFolderId.value = 'all'
    }
    await refetchFolders()
    await refetchItems()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '폴더 삭제에 실패했습니다.')
  }
}

// ── 자료 이동 다이얼로그 ────────────────────────────────────────────────
const moveModalOpen = ref(false)
const moveTargetFolderId = ref<number | null>(null)

function openMoveModal() {
  if (!picked.value.size) {
    toast.err('이동할 자료를 먼저 선택해주세요.')
    return
  }
  moveTargetFolderId.value = null
  moveModalOpen.value = true
}

async function submitMove() {
  try {
    const res = await api.post<{ ok: true; moved: number }>('/cart/items/move', {
      documentIds: [...picked.value],
      targetFolderId: moveTargetFolderId.value,
    })
    const targetName =
      moveTargetFolderId.value === null
        ? '기본 폴더'
        : folders.value.find((f) => f.id === moveTargetFolderId.value)?.name ?? '해당 폴더'
    toast.ok(`${res.moved}건의 자료를 [${targetName}]로 이동했습니다.`)
    moveModalOpen.value = false
    clearPicked()
    await refetchFolders()
    await refetchItems()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '자료 이동에 실패했습니다.')
  }
}

// ── 선택 자료 제외 (삭제) ────────────────────────────────────────────────
async function removePicked() {
  if (!picked.value.size) return
  if (!window.confirm(`선택한 ${picked.value.size}건을 반출대기함에서 제외하시겠습니까?`)) {
    return
  }
  try {
    const res = await api.post<{ ok: true; removed: number; total: number }>('/cart/items/remove', {
      documentIds: [...picked.value],
    })
    toast.ok(`${res.removed}건을 반출대기함에서 제외했습니다.`)
    clearPicked()
    await refetchFolders()
    await refetchItems()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '자료 제외에 실패했습니다.')
  }
}

// ── 폴더 비우기 / 전체 비우기 ────────────────────────────────────────────
async function clearCurrent() {
  const isAll = selectedFolderId.value === 'all'
  const isRoot = selectedFolderId.value === 'root'
  const prompt = isAll
    ? '반출대기함의 모든 자료를 비우시겠습니까?'
    : `"${currentFolderName.value}"의 자료를 모두 비우시겠습니까?`
  if (!window.confirm(prompt)) return

  try {
    const folderId = isAll ? undefined : isRoot ? null : (selectedFolderId.value as number)
    await api.post('/cart/clear', { folderId })
    toast.ok('자료를 모두 비웠습니다.')
    clearPicked()
    await refetchFolders()
    await refetchItems()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
  } catch (e) {
    toast.err(e instanceof ApiError ? e.message : '비우기에 실패했습니다.')
  }
}

// ── 반출 실행 ────────────────────────────────────────────────────────────
function handleDistribute() {
  // 체크한 것이 있으면 체크한 자료, 없으면 현재 보고 있는 폴더의 자료 전체
  let targetIds: number[] = []
  if (picked.value.size > 0) {
    targetIds = [...picked.value]
  } else if (items.value.length > 0) {
    targetIds = items.value.map((r) => r.id)
  }
  if (!targetIds.length) {
    toast.err('반출할 자료가 없습니다.')
    return
  }
  emit('distribute', targetIds)
}
</script>

<template>
  <Modal
    v-if="open"
    wide
    width="1180px"
    title="반출대기함 (개인 폴더 관리)"
    @close="emit('close')"
  >
    <div class="cart-container">
      <!-- 좌측: 개인 폴더 관리 사이드바 -->
      <aside class="cart-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">📁 {{ session.me?.name ? `${session.me.name}님의 대기함` : '개인 관리폴더' }}</span>
          <button class="small primary" type="button" title="새 폴더 만들기" @click="openCreateFolder">
            ＋ 새 폴더
          </button>
        </div>

        <nav class="folder-list">
          <!-- 전체 자료 -->
          <div
            class="folder-item"
            :class="{ active: selectedFolderId === 'all' }"
            @click="selectedFolderId = 'all'"
          >
            <span class="folder-icon">🗂️</span>
            <span class="folder-name">전체 자료</span>
            <span class="folder-badge">{{ totalCount }}</span>
          </div>

          <!-- 기본 폴더 (미분류) -->
          <div
            class="folder-item"
            :class="{ active: selectedFolderId === 'root' }"
            @click="selectedFolderId = 'root'"
          >
            <span class="folder-icon">📥</span>
            <span class="folder-name">기본 폴더 (미분류)</span>
            <span class="folder-badge">{{ rootCount }}</span>
          </div>

          <div v-if="folders.length" class="folder-divider" />

          <!-- 사용자 생성 폴더 목록 -->
          <div
            v-for="f in folders"
            :key="f.id"
            class="folder-item user-folder"
            :class="{ active: selectedFolderId === f.id }"
            @click="selectedFolderId = f.id"
          >
            <span class="folder-icon">📁</span>
            <span class="folder-name" :title="f.name">{{ f.name }}</span>
            <span class="folder-badge">{{ f.docCount }}</span>
            <div class="folder-actions">
              <button
                class="icon-btn"
                type="button"
                title="이름 변경"
                @click="openRenameFolder(f, $event)"
              >
                ✏️
              </button>
              <button
                class="icon-btn danger"
                type="button"
                title="폴더 삭제"
                @click="deleteFolder(f, $event)"
              >
                🗑️
              </button>
            </div>
          </div>
        </nav>
      </aside>

      <!-- 우측: 선택된 폴더 내 자료 목록 및 조작 -->
      <main class="cart-main">
        <div class="cart-toolbar">
          <div class="toolbar-left">
            <span class="current-folder-title">
              {{ currentFolderName }}
              <strong class="count-tag">({{ items.length }}건)</strong>
            </span>
            <input
              v-model="searchInput"
              class="cart-search-input"
              type="text"
              placeholder="자료명·내용·경로 검색…"
            />
          </div>

          <div class="toolbar-right">
            <button
              class="small"
              type="button"
              :disabled="!picked.size"
              title="선택한 자료를 다른 개인 폴더로 이동합니다"
              @click="openMoveModal"
            >
              📁 폴더 이동{{ picked.size ? ` (${picked.size})` : '' }}
            </button>
            <button
              class="small"
              type="button"
              :disabled="!picked.size"
              title="선택한 자료를 대기함에서 제외합니다"
              @click="removePicked"
            >
              제외{{ picked.size ? ` (${picked.size})` : '' }}
            </button>
            <button
              class="small"
              type="button"
              :disabled="!items.length"
              title="현재 보고 있는 폴더의 자료를 모두 비웁니다"
              @click="clearCurrent"
            >
              비우기
            </button>
            <button
              class="small primary"
              type="button"
              :disabled="!items.length && !picked.size"
              title="선택한 자료(또는 폴더 전체 자료)로 반출을 진행합니다"
              @click="handleDistribute"
            >
              반출하기{{ picked.size ? ` (${picked.size}건)` : ` (${items.length}건)` }}
            </button>
          </div>
        </div>

        <div class="cart-table-box">
          <DataTable
            :columns="COLUMNS"
            :rows="items"
            :total="items.length"
            selectable
            :selected="picked"
            storage-key="tdb-cart-user"
            excel-name="반출대기함_자료목록"
            :empty-text="
              searchKeyword
                ? '검색 결과가 없습니다.'
                : '이 폴더에 담긴 자료가 없습니다. TDB 조회 목록에서 [선택 반출] 또는 [폴더 반출] 로 담으세요.'
            "
            @toggle="togglePick"
            @toggle-all="toggleAll"
          >
            <template #cell:status="{ row }">
              <span v-if="row.lentTo" class="badge badge-warning">{{ row.lentTo }} 대여중</span>
              <span v-else class="badge" :class="STATUS_BADGE[row.status] ?? 'badge-neutral'">
                {{ STATUS_LABEL[row.status] ?? row.status }}
              </span>
            </template>
            <template #cell:cartFolderName="{ row }">
              <span class="cart-folder-tag">{{ row.cartFolderName ?? '기본 폴더' }}</span>
            </template>
          </DataTable>
        </div>
      </main>
    </div>

    <template #footer>
      <div class="modal-footer-flex">
        <span class="muted text-sm">
          💡 자료를 개인별 폴더로 분류하여 편리하게 관리하고, 원하는 폴더 단위로 반출할 수 있습니다.
        </span>
        <button type="button" @click="emit('close')">닫기</button>
      </div>
    </template>
  </Modal>

  <!-- 새 폴더 / 폴더 이름 변경 모달 -->
  <Modal
    v-if="folderModalMode"
    width="420px"
    :title="folderModalMode === 'create' ? '새 개인 폴더 만들기' : '폴더 이름 변경'"
    @close="folderModalMode = null"
  >
    <div class="folder-edit-box">
      <label class="modal-label">폴더 이름</label>
      <input
        v-model="folderModalName"
        type="text"
        placeholder="폴더 이름을 입력하세요"
        maxlength="200"
        autofocus
        @keydown.enter.prevent="submitFolderModal"
      />
    </div>
    <template #footer>
      <button type="button" @click="folderModalMode = null">취소</button>
      <button class="primary" type="button" :disabled="!folderModalName.trim()" @click="submitFolderModal">
        저장
      </button>
    </template>
  </Modal>

  <!-- 자료 폴더 이동 모달 -->
  <Modal
    v-if="moveModalOpen"
    width="460px"
    title="자료 폴더 이동"
    @close="moveModalOpen = false"
  >
    <div class="move-modal-body">
      <p class="page-desc">
        선택한 <strong>{{ picked.size }}건</strong>의 자료를 이동할 보관 폴더를 선택하세요:
      </p>
      <div class="target-folder-list">
        <label
          class="target-folder-option"
          :class="{ checked: moveTargetFolderId === null }"
        >
          <input
            v-model="moveTargetFolderId"
            type="radio"
            :value="null"
          />
          <span class="opt-icon">📥</span>
          <span class="opt-label">기본 폴더 (미분류)</span>
        </label>
        <label
          v-for="f in folders"
          :key="f.id"
          class="target-folder-option"
          :class="{ checked: moveTargetFolderId === f.id }"
        >
          <input
            v-model="moveTargetFolderId"
            type="radio"
            :value="f.id"
          />
          <span class="opt-icon">📁</span>
          <span class="opt-label">{{ f.name }}</span>
          <span class="opt-badge">({{ f.docCount }}건 보관중)</span>
        </label>
      </div>
    </div>
    <template #footer>
      <button type="button" @click="moveModalOpen = false">취소</button>
      <button class="primary" type="button" @click="submitMove">
        이동하기
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.cart-container {
  display: flex;
  height: 640px;
  max-height: 72vh;
  gap: 16px;
  overflow: hidden;
}

/* ── 좌측 사이드바 (개인 폴더 목록) ── */
.cart-sidebar {
  width: 250px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-alt);
}

.sidebar-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.folder-divider {
  height: 1px;
  background: var(--border);
  margin: 6px 4px;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  color: var(--text);
  transition: background 0.15s, color 0.15s;
}

.folder-item:hover {
  background: var(--surface-sunken);
}

.folder-item.active {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--accent);
}

.folder-icon {
  font-size: 14px;
  line-height: 1;
}

.folder-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--border);
  color: var(--text-muted);
}

.folder-item.active .folder-badge {
  background: var(--primary);
  color: var(--primary-fg);
}

.folder-actions {
  display: none;
  gap: 2px;
  margin-left: 2px;
}

.user-folder:hover .folder-actions,
.user-folder.active .folder-actions {
  display: flex;
}

.icon-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  font-size: 11px;
  border-radius: 3px;
  opacity: 0.7;
}

.icon-btn:hover {
  opacity: 1;
  background: var(--surface);
}

.icon-btn.danger:hover {
  background: var(--danger-soft, #fee);
}

/* ── 우측 메인 영역 (자료 목록) ── */
.cart-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cart-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 2px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.current-folder-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}

.count-tag {
  color: var(--text-muted);
  font-weight: 600;
  margin-left: 4px;
}

.cart-search-input {
  max-width: 240px;
  font-size: 12px;
  padding: 4px 8px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cart-table-box {
  flex: 1;
  min-height: 0;
  display: flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
  background: var(--surface);
}

.cart-table-box > * {
  flex: 1;
  min-width: 0;
}

.cart-folder-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-alt, #f1f3f4);
  font-size: 11px;
  color: var(--text-muted);
}

/* ── 모달 내부 폼 ── */
.folder-edit-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}

.modal-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.modal-footer-flex {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.move-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.target-folder-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  padding: 8px;
  background: var(--surface-alt, #fafafa);
}

.target-folder-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
  transition: all 0.15s;
}

.target-folder-option:hover {
  border-color: var(--border-strong);
  background: var(--surface-sunken);
}

.target-folder-option.checked {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
}

.opt-icon {
  font-size: 14px;
}

.opt-label {
  flex: 1;
}

.opt-badge {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
