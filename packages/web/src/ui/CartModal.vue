<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
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

// ── 폴더 트리 구조 구성 ──────────────────────────────────────────────────
export interface CartFolderTreeNode extends CartFolder {
  depth: number
  children: CartFolderTreeNode[]
}

const folderTree = computed<CartFolderTreeNode[]>(() => {
  const list = folders.value
  const map = new Map<number, CartFolderTreeNode>()
  for (const f of list) {
    map.set(f.id, { ...f, depth: 0, children: [] })
  }
  const roots: CartFolderTreeNode[] = []
  for (const f of list) {
    const node = map.get(f.id)!
    if (f.parentId !== null && map.has(f.parentId)) {
      map.get(f.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  function setDepth(nodes: CartFolderTreeNode[], depth: number) {
    for (const n of nodes) {
      n.depth = depth
      if (n.children.length) setDepth(n.children, depth + 1)
    }
  }
  setDepth(roots, 0)
  return roots
})

// 펼침 상태 저장 (하위 폴더가 있는 부모 폴더 ID)
const expandedFolderIds = ref<Set<number>>(new Set())

// 폴더 데이터 변경 시 하위 폴더가 있는 부모 폴더는 기본으로 펼침 상태에 추가
watch(
  folders,
  (newFolders) => {
    const next = new Set(expandedFolderIds.value)
    for (const f of newFolders) {
      if (f.parentId !== null) {
        next.add(f.parentId)
      }
    }
    expandedFolderIds.value = next
  },
  { immediate: true },
)

function toggleExpand(folderId: number, e?: Event) {
  e?.stopPropagation()
  const next = new Set(expandedFolderIds.value)
  if (next.has(folderId)) {
    next.delete(folderId)
  } else {
    next.add(folderId)
  }
  expandedFolderIds.value = next
}

// 화면에 보일 트리 항목들 (접힘/펼침 반영)
export interface VisibleFolderItem extends CartFolderTreeNode {
  hasChildren: boolean
  isExpanded: boolean
}

const visibleFolderTree = computed<VisibleFolderItem[]>(() => {
  const res: VisibleFolderItem[] = []
  function walk(nodes: CartFolderTreeNode[]) {
    for (const n of nodes) {
      const hasChildren = n.children.length > 0
      const isExpanded = expandedFolderIds.value.has(n.id)
      res.push({
        ...n,
        hasChildren,
        isExpanded,
      })
      if (hasChildren && isExpanded) {
        walk(n.children)
      }
    }
  }
  walk(folderTree.value)
  return res
})

// 트리 순서대로 나열된 전체 폴더 목록 (모달 셀렉트 및 대상 선택용)
const allFoldersInTreeOrder = computed<CartFolderTreeNode[]>(() => {
  const res: CartFolderTreeNode[] = []
  function walk(nodes: CartFolderTreeNode[]) {
    for (const n of nodes) {
      res.push(n)
      if (n.children.length) walk(n.children)
    }
  }
  walk(folderTree.value)
  return res
})

// ── 드래그 앤 드롭 상태 및 로직 ──────────────────────────────────────────
const draggedFolder = ref<CartFolder | null>(null)
const dragOverFolderId = ref<number | 'root' | 'base-root' | null>(null)
const draggedRowDocIds = ref<number[]>([])

const isDraggingFolder = computed(() => draggedFolder.value !== null)

/** 대상 폴더가 조상 폴더(ancestor)의 후손(descendant)인지 확인 (순환 참조 방지) */
function isDescendantOf(candidateId: number, ancestorId: number): boolean {
  if (candidateId === ancestorId) return true
  let curr = folders.value.find((f) => f.id === candidateId)
  while (curr && curr.parentId !== null) {
    const parentId: number = curr.parentId
    if (parentId === ancestorId) return true
    curr = folders.value.find((f) => f.id === parentId)
  }
  return false
}

/** 폴더를 특정 대상 폴더 하위로 이동할 수 있는지 검사 */
function canDropOnFolder(targetFolder: CartFolder): boolean {
  if (draggedRowDocIds.value.length > 0) return true
  if (!draggedFolder.value) return false
  if (draggedFolder.value.id === targetFolder.id) return false
  if (draggedFolder.value.parentId === targetFolder.id) return false
  if (isDescendantOf(targetFolder.id, draggedFolder.value.id)) return false
  return true
}

function onFolderDragStart(e: DragEvent, f: CartFolder) {
  draggedFolder.value = f
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', `cart-folder:${f.id}`)
    e.dataTransfer.effectAllowed = 'move'
  }
}

function onFolderDragEnd() {
  draggedFolder.value = null
  dragOverFolderId.value = null
  draggedRowDocIds.value = []
}

function onFolderDragOver(e: DragEvent, target: CartFolder) {
  if (canDropOnFolder(target)) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dragOverFolderId.value = target.id
  }
}

function onFolderDragLeave(target: CartFolder) {
  if (dragOverFolderId.value === target.id) {
    dragOverFolderId.value = null
  }
}

async function onFolderDrop(target: CartFolder) {
  // 1. 테이블 자료를 폴더로 드롭한 경우
  if (draggedRowDocIds.value.length > 0) {
    const docIds = [...draggedRowDocIds.value]
    draggedRowDocIds.value = []
    dragOverFolderId.value = null
    try {
      const res = await api.post<{ ok: true; moved: number }>('/cart/items/move', {
        documentIds: docIds,
        targetFolderId: target.id,
      })
      toast.ok(`${res.moved}건의 자료를 [${target.name}] 폴더로 이동했습니다.`)
      clearPicked()
      await refetchFolders()
      await refetchItems()
      await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
    } catch (err) {
      toast.err(err instanceof ApiError ? err.message : '자료 이동에 실패했습니다.')
    }
    return
  }

  // 2. 폴더를 다른 폴더 하위로 드롭한 경우
  if (!draggedFolder.value || !canDropOnFolder(target)) return
  const moving = draggedFolder.value
  draggedFolder.value = null
  dragOverFolderId.value = null

  try {
    await api.patch(`/cart/folders/${moving.id}`, { parentId: target.id })
    toast.ok(`"${moving.name}" 폴더를 "${target.name}" 하위로 이동했습니다.`)
    expandedFolderIds.value = new Set(expandedFolderIds.value).add(target.id)
    await refetchFolders()
    await refetchItems()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
  } catch (err) {
    toast.err(err instanceof ApiError ? err.message : '폴더 이동에 실패했습니다.')
  }
}

// ── 최상위(루트) 드롭존 처리 ─────────────────────────────────────────────
function canDropOnRoot(): boolean {
  if (!draggedFolder.value) return false
  return draggedFolder.value.parentId !== null
}

function onRootDragOver(e: DragEvent) {
  if (canDropOnRoot()) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dragOverFolderId.value = 'root'
  }
}

function onRootDragLeave() {
  if (dragOverFolderId.value === 'root') {
    dragOverFolderId.value = null
  }
}

async function onRootDrop() {
  if (!draggedFolder.value || !canDropOnRoot()) return
  const moving = draggedFolder.value
  draggedFolder.value = null
  dragOverFolderId.value = null

  try {
    await api.patch(`/cart/folders/${moving.id}`, { parentId: null })
    toast.ok(`"${moving.name}" 폴더를 최상위(루트)로 이동했습니다.`)
    await refetchFolders()
    await refetchItems()
    await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
  } catch (err) {
    toast.err(err instanceof ApiError ? err.message : '폴더 이동에 실패했습니다.')
  }
}

// ── 기본 폴더(미분류) 드롭존 처리 (자료 드래그 드롭용) ────────────────────
function onBaseRootDragOver(e: DragEvent) {
  if (draggedRowDocIds.value.length > 0) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dragOverFolderId.value = 'base-root'
  }
}

function onBaseRootDragLeave() {
  if (dragOverFolderId.value === 'base-root') {
    dragOverFolderId.value = null
  }
}

async function onBaseRootDrop() {
  if (draggedRowDocIds.value.length > 0) {
    const docIds = [...draggedRowDocIds.value]
    draggedRowDocIds.value = []
    dragOverFolderId.value = null
    try {
      const res = await api.post<{ ok: true; moved: number }>('/cart/items/move', {
        documentIds: docIds,
        targetFolderId: null,
      })
      toast.ok(`${res.moved}건의 자료를 [기본 폴더 (미분류)]로 이동했습니다.`)
      clearPicked()
      await refetchFolders()
      await refetchItems()
      await qc.invalidateQueries({ queryKey: qk.cart.all(currentUserId.value) })
    } catch (err) {
      toast.err(err instanceof ApiError ? err.message : '자료 이동에 실패했습니다.')
    }
  }
}

// ── 테이블 행 드래그 시작/종료 ──────────────────────────────────────────
function onRowDragStart(e: DragEvent, row: CartItem) {
  if (picked.value.has(row.id)) {
    draggedRowDocIds.value = [...picked.value]
  } else {
    draggedRowDocIds.value = [row.id]
  }
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', `cart-items:${draggedRowDocIds.value.join(',')}`)
    e.dataTransfer.effectAllowed = 'move'
  }
}

function onRowDragEnd() {
  draggedRowDocIds.value = []
}

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
const folderParentId = ref<number | null>(null)
const folderNameInputRef = ref<HTMLInputElement | null>(null)

/** 새 폴더 생성 시 선택된 상위 폴더의 전체 계층 경로 안내 문자열 */
const selectedParentPath = computed(() => {
  if (folderParentId.value === null) return '최상위 (루트 폴더)'
  const parts: string[] = []
  let curr = folders.value.find((f) => f.id === folderParentId.value)
  while (curr) {
    parts.unshift(curr.name)
    if (curr.parentId === null) break
    const pId: number = curr.parentId
    curr = folders.value.find((f) => f.id === pId)
  }
  return parts.join(' > ')
})

/** 상위 폴더 드롭다운 옵션 (글꼴 환경에 구애받지 않는 안전한 인덴트 구성) */
const parentFolderOptions = computed(() => {
  return allFoldersInTreeOrder.value.map((f) => {
    const indent = f.depth > 0 ? '\u00A0\u00A0'.repeat(f.depth) + '└─ ' : ''
    return {
      id: f.id,
      label: `${indent}📁 ${f.name}`,
    }
  })
})

function focusFolderNameInput() {
  nextTick(() => {
    folderNameInputRef.value?.focus()
    setTimeout(() => {
      folderNameInputRef.value?.focus()
      if (folderModalMode.value === 'rename') {
        folderNameInputRef.value?.select()
      }
    }, 50)
  })
}

watch(folderModalMode, (mode) => {
  if (mode) {
    focusFolderNameInput()
  }
})

function openCreateFolder(parentId?: number | null) {
  folderModalName.value = ''
  folderModalMode.value = 'create'
  if (parentId !== undefined) {
    folderParentId.value = parentId
  } else if (typeof selectedFolderId.value === 'number') {
    folderParentId.value = selectedFolderId.value
  } else {
    folderParentId.value = null
  }
  focusFolderNameInput()
}

function openRenameFolder(f: CartFolder, e: Event) {
  e.stopPropagation()
  folderModalName.value = f.name
  folderTargetId.value = f.id
  folderModalMode.value = 'rename'
  focusFolderNameInput()
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
        parentId: folderParentId.value,
      })
      toast.ok(`"${name}" 폴더를 생성했습니다.`)
      folderModalMode.value = null
      if (folderParentId.value) {
        expandedFolderIds.value = new Set(expandedFolderIds.value).add(folderParentId.value)
      }
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
  if (!window.confirm(`"${f.name}" 폴더를 삭제하시겠습니까?\n하위 폴더와 폴더 안의 자료는 기본 폴더로 안전하게 이동됩니다.`)) {
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
      <!-- 좌측: 개인 폴더 관리 사이드바 (트리 뷰 & 드래그앤드롭) -->
      <aside class="cart-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">📁 {{ session.me?.name ? `${session.me.name}님의 대기함` : '개인 관리폴더' }}</span>
          <button class="small primary" type="button" title="새 최상위 폴더 만들기" @click="openCreateFolder(null)">
            ＋ 새 폴더
          </button>
        </div>

        <nav class="folder-list">
          <!-- 전체 자료 -->
          <div
            class="folder-item fixed-folder"
            :class="{ active: selectedFolderId === 'all' }"
            @click="selectedFolderId = 'all'"
          >
            <span class="folder-icon">🗂️</span>
            <span class="folder-name">전체 자료</span>
            <span class="folder-badge">{{ totalCount }}</span>
          </div>

          <!-- 기본 폴더 (미분류) -->
          <div
            class="folder-item fixed-folder"
            :class="{
              active: selectedFolderId === 'root',
              'drop-active': dragOverFolderId === 'base-root',
            }"
            @click="selectedFolderId = 'root'"
            @dragover.prevent="onBaseRootDragOver($event)"
            @dragleave="onBaseRootDragLeave"
            @drop.prevent="onBaseRootDrop"
          >
            <span class="folder-icon">📥</span>
            <span class="folder-name">기본 폴더 (미분류)</span>
            <span class="folder-badge">{{ rootCount }}</span>
          </div>

          <div class="folder-divider" />

          <!-- 트리 영역 머리글 및 최상위 이동 드롭존 -->
          <div
            class="tree-section-header"
            :class="{
              'drop-zone-active': dragOverFolderId === 'root',
              'drop-available': isDraggingFolder && draggedFolder?.parentId !== null,
            }"
            @dragover.prevent="onRootDragOver($event)"
            @dragleave="onRootDragLeave"
            @drop.prevent="onRootDrop"
          >
            <span class="tree-section-title">
              {{ isDraggingFolder && draggedFolder?.parentId !== null ? '📥 최상위(루트)로 이동하려면 여기에 놓기' : '내 폴더 트리' }}
            </span>
            <span v-if="!isDraggingFolder" class="tree-guide-hint">끌어서 하위 폴더 이동</span>
          </div>

          <!-- 폴더가 없을 때 안내 -->
          <div v-if="!folders.length" class="empty-folder-guide">
            <span>개인 폴더가 없습니다.</span>
            <button class="small link-btn" type="button" @click="openCreateFolder(null)">
              + 첫 폴더 만들기
            </button>
          </div>

          <!-- 사용자 생성 폴더 트리 목록 -->
          <div
            v-for="f in visibleFolderTree"
            :key="f.id"
            class="folder-item user-folder"
            :class="{
              active: selectedFolderId === f.id,
              'is-dragging': draggedFolder?.id === f.id,
              'drop-active': dragOverFolderId === f.id,
              'drop-not-allowed': draggedFolder && !canDropOnFolder(f),
            }"
            :style="{ paddingLeft: `${8 + f.depth * 14}px` }"
            draggable="true"
            @dragstart="onFolderDragStart($event, f)"
            @dragend="onFolderDragEnd"
            @dragover.prevent="onFolderDragOver($event, f)"
            @dragleave="onFolderDragLeave(f)"
            @drop.prevent="onFolderDrop(f)"
            @click="selectedFolderId = f.id"
          >
            <!-- 하위 폴더 접기/펼치기 화살표 토글 -->
            <button
              v-if="f.hasChildren"
              class="tree-toggle-btn"
              type="button"
              :title="f.isExpanded ? '접기' : '펼치기'"
              @click="toggleExpand(f.id, $event)"
            >
              {{ f.isExpanded ? '▾' : '▸' }}
            </button>
            <span v-else class="tree-toggle-spacer" />

            <!-- 드래그 핸들 그립 -->
            <span class="drag-handle-grip" title="끌어서 다른 폴더의 하위 또는 최상위로 이동">⋮⋮</span>

            <!-- 폴더 아이콘 -->
            <span class="folder-icon">
              {{ dragOverFolderId === f.id ? '📂' : (f.hasChildren && f.isExpanded ? '📂' : '📁') }}
            </span>

            <!-- 폴더 이름 -->
            <span class="folder-name" :title="f.name">{{ f.name }}</span>

            <!-- 보관 자료 수 -->
            <span class="folder-badge" :title="`${f.docCount}건 보관`">{{ f.docCount }}</span>

            <!-- 호버 액션 단추들 -->
            <div class="folder-actions" @click.stop>
              <button
                class="icon-btn"
                type="button"
                title="하위 폴더 만들기"
                @click="openCreateFolder(f.id)"
              >
                ＋
              </button>
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
            :draggable-rows="true"
            storage-key="tdb-cart-user"
            excel-name="반출대기함_자료목록"
            :empty-text="
              searchKeyword
                ? '검색 결과가 없습니다.'
                : '이 폴더에 담긴 자료가 없습니다. TDB 조회 목록에서 [선택 반출] 또는 [폴더 반출] 로 담으세요.'
            "
            @toggle="togglePick"
            @toggle-all="toggleAll"
            @row-dragstart="onRowDragStart"
            @row-dragend="onRowDragEnd"
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
          💡 폴더를 드래그 앤 드롭하여 하위 폴더나 최상위로 편리하게 이동할 수 있습니다.
        </span>
        <button type="button" @click="emit('close')">닫기</button>
      </div>
    </template>
  </Modal>

  <!-- 새 폴더 / 폴더 이름 변경 모달 -->
  <Modal
    v-if="folderModalMode"
    width="460px"
    :title="folderModalMode === 'create' ? '새 개인 폴더 만들기' : '폴더 이름 변경'"
    @close="folderModalMode = null"
  >
    <div class="folder-edit-box">
      <div v-if="folderModalMode === 'create'" class="form-group">
        <div class="parent-label-row">
          <label class="modal-label" for="folder-parent-select">상위 폴더 위치</label>
          <span class="parent-path-badge" :title="`현재 생성 위치: ${selectedParentPath}`">
            <span class="path-badge-icon">{{ folderParentId === null ? '🏠' : '📁' }}</span>
            <span class="path-badge-text">{{ selectedParentPath }}</span>
          </span>
        </div>
        <select
          id="folder-parent-select"
          v-model="folderParentId"
          class="folder-parent-select"
        >
          <option :value="null">📁 [최상위] 최상위 (루트 폴더)</option>
          <option
            v-for="opt in parentFolderOptions"
            :key="opt.id"
            :value="opt.id"
          >
            {{ opt.label }}
          </option>
        </select>
        <span class="parent-helper-text">
          💡 선택한 폴더의 하위 계층에 새 폴더가 생성됩니다.
        </span>
      </div>

      <div class="form-group">
        <label class="modal-label" for="folder-modal-name-input">폴더 이름</label>
        <input
          id="folder-modal-name-input"
          ref="folderNameInputRef"
          v-model="folderModalName"
          type="text"
          class="folder-modal-input"
          placeholder="폴더 이름을 입력하세요"
          maxlength="200"
          autofocus
          @keydown.enter.prevent="submitFolderModal"
        />
      </div>
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
          v-for="f in allFoldersInTreeOrder"
          :key="f.id"
          class="target-folder-option"
          :class="{ checked: moveTargetFolderId === f.id }"
          :style="{ paddingLeft: `${12 + f.depth * 16}px` }"
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
  width: 270px;
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
  gap: 2px;
}

.folder-divider {
  height: 1px;
  background: var(--border);
  margin: 6px 4px;
}

/* ── 트리 섹션 헤더 및 루트 드롭존 ── */
.tree-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  border-radius: 4px;
  transition: all 0.15s ease;
}

.tree-section-header.drop-available {
  background: var(--surface-sunken);
  border: 1px dashed var(--border-strong);
  color: var(--accent);
}

.tree-section-header.drop-zone-active {
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-weight: 700;
}

.tree-guide-hint {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.8;
}

.empty-folder-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 12px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.link-btn {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  padding: 2px 4px;
}

/* ── 폴더 항목 스타일 ── */
.folder-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  color: var(--text);
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
  position: relative;
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

.folder-item.is-dragging {
  opacity: 0.4;
  border: 1px dashed var(--text-muted);
}

.folder-item.drop-active {
  background: var(--accent-soft) !important;
  border: 1px solid var(--accent) !important;
  color: var(--accent) !important;
  font-weight: 700;
}

.folder-item.drop-not-allowed {
  cursor: not-allowed;
}

/* 트리 토글 단추 */
.tree-toggle-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-muted);
  padding: 0;
  border-radius: 3px;
  flex-shrink: 0;
}

.tree-toggle-btn:hover {
  background: var(--surface-alt);
  color: var(--text);
}

.tree-toggle-spacer {
  width: 16px;
  flex-shrink: 0;
}

/* 드래그 핸들 그립 */
.drag-handle-grip {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.35;
  cursor: grab;
  padding: 0 1px;
  flex-shrink: 0;
}

.folder-item:hover .drag-handle-grip {
  opacity: 0.8;
}

.folder-item:active .drag-handle-grip {
  cursor: grabbing;
}

.folder-icon {
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
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
  flex-shrink: 0;
}

.folder-item.active .folder-badge {
  background: var(--primary);
  color: var(--primary-fg);
}

.folder-actions {
  display: none;
  gap: 2px;
  margin-left: 2px;
  flex-shrink: 0;
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
  gap: 14px;
  padding: 8px 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.parent-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.parent-path-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  background: var(--surface-alt, #f1f3f4);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-muted);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-badge-icon {
  font-size: 11px;
  flex-shrink: 0;
}

.path-badge-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: var(--accent, #1a73e8);
}

.folder-parent-select {
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box;
  height: 36px;
  padding: 0 32px 0 10px;
  font-size: 13px;
  border: 1px solid var(--border-strong, #ccc);
  border-radius: var(--radius, 4px);
  background-color: var(--surface);
  color: var(--text);
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.folder-parent-select:focus {
  border-color: var(--accent, #1a73e8);
  box-shadow: 0 0 0 2px var(--accent-soft, rgba(26, 115, 232, 0.2));
}

.parent-helper-text {
  font-size: 11.5px;
  color: var(--text-faint, #888);
  margin-top: 1px;
}

.folder-modal-input {
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box;
  height: 36px;
  padding: 0 10px;
  font-size: 13px;
  border: 1px solid var(--border-strong, #ccc);
  border-radius: var(--radius, 4px);
  background: var(--surface);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.folder-modal-input:focus {
  border-color: var(--accent, #1a73e8);
  box-shadow: 0 0 0 2px var(--accent-soft, rgba(26, 115, 232, 0.2));
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
