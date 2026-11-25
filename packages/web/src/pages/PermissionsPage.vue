<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  GroupListResponse, GroupMenuPermissionsResponse, GroupPermissionsResponse,
  MenuListResponse, PermissionNode, UserListResponse, UserPermissionsResponse, UserRow,
} from '@tdms/contracts'
import PermissionTree from '@/ui/PermissionTree.vue'
import Tabs from '@/ui/Tabs.vue'
import NavIcon from '@/ui/NavIcon.vue'
import { api, ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'

/**
 * 접속권한 관리 — 권한을 그룹과 사람 양쪽에 매긴다.
 *
 * 1) 메뉴 및 C/R/U/D 권한:
 *    - 각 그룹별로 메뉴 접근(열람) 및 화면 내 C(등록), R(조회), U(수정), D(삭제) 권한을 부여한다.
 *    - 메뉴 권한(열람)을 켜면 C, R, U, D 도 함께 부여할 수 있다.
 *    - 메뉴 권한(열람)을 끄면 하위 C, R, U, D 권한도 모두 비활성화된다.
 *    - 여기서 설정한 C/R/U/D 권한은 화면 내 버튼의 `permission="c,r,u,d"` 속성 및 `v-permission`에 실시간 반영된다.
 *
 * 2) 상세 기능 권한 트리:
 *    - 기존 시스템 기능 권한(페이지 접속, 반입검수, 비고 작성 등) 트리 관리.
 *
 * 최종 권한 = 그룹 권한 ∪ 개인 권한.
 */

const qc = useQueryClient()

const kind = ref<'groups' | 'users'>('groups')
const KINDS = [{ key: 'groups', label: '그룹' }, { key: 'users', label: '사용자' }]

// 가운데 패널 탭: 메뉴 CRUD 권한 vs 기능 권한 트리
const centerTab = ref<'menu_crud' | 'feature_tree'>('menu_crud')
const CENTER_TABS = [
  { key: 'menu_crud', label: '메뉴 및 C·R·U·D 권한' },
  { key: 'feature_tree', label: '상세 기능 권한 트리' },
]

// 오른쪽 패널 탭
const rightTab = ref<'members' | 'menus'>('members')
const RIGHT_TABS = [
  { key: 'members', label: '그룹 사용자' },
  { key: 'menus', label: '열리는 메뉴' },
]

const pickedGroup = ref<number | string | null>(null)
const pickedUser = ref<number | null>(null)
const userFilter = ref('')
const memberFilter = ref('')

const say = (k: 'ok' | 'err', text: string) => toast.show(k, text)
const fail = (e: unknown) => toast.err(e instanceof ApiError ? e.message : '저장하지 못했습니다.')
const saving = ref(false)

// ── 바탕 자료 ──────────────────────────────────────────────────────────
const { data: tree } = useQuery({
  queryKey: ['permission-tree'],
  queryFn: () => api.get<{ tree: PermissionNode[] }>('/groups/permission-tree'),
  staleTime: Infinity,
})
const { data: groups } = useQuery({
  queryKey: ['groups'],
  queryFn: () => api.get<GroupListResponse>('/groups'),
  staleTime: 30_000,
})
const { data: users } = useQuery({
  queryKey: ['users'],
  queryFn: () => api.get<UserListResponse>('/users'),
  staleTime: 30_000,
})
const { data: menus } = useQuery({
  queryKey: ['menus'],
  queryFn: () => api.get<MenuListResponse>('/menus'),
  staleTime: 30_000,
})
const menusPath = computed(() => (menus.value?.items ?? []).find((m) => m.code === 'menus')?.path || '/menus')
const { data: counts } = useQuery({
  queryKey: ['user-permission-counts'],
  queryFn: () => api.get<{ items: { userId: number; count: number }[] }>('/users/permission-counts'),
  staleTime: 30_000,
})

const ownCount = computed(() => new Map((counts.value?.items ?? []).map((c) => [c.userId, c.count])))

// 미소속 사용자 수 (그룹이 없는 사용자)
const unassignedMemberCount = computed(() =>
  (users.value?.items ?? []).filter((u) => u.groupId === null || !u.groupId).length,
)

interface DisplayGroup {
  id: number | string
  name: string
  memberCount: number
  permissionCount: number
  isUnassigned?: boolean
}

const displayGroups = computed<DisplayGroup[]>(() => {
  const list: DisplayGroup[] = (groups.value?.items ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g.memberCount,
    permissionCount: g.permissionCount,
  }))
  list.push({
    id: 'unassigned',
    name: '미소속사용자그룹',
    memberCount: unassignedMemberCount.value,
    permissionCount: 0,
    isUnassigned: true,
  })
  return list
})

// 첫 진입 시 첫 번째 그룹 자동 선택
watch(
  displayGroups,
  (list) => {
    if (kind.value === 'groups' && pickedGroup.value === null && list.length > 0) {
      pickedGroup.value = list[0]?.id ?? null
    }
  },
  { immediate: true },
)

// 재직자만 — 퇴직·삭제 계정에 권한을 매길 일이 없다
const userList = computed(() => {
  const q = userFilter.value.trim().toLowerCase()
  return (users.value?.items ?? [])
    .filter((u) => u.employmentStatus === 'ACTIVE')
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q))
})

// 선택된 그룹에 속한 사용자 목록 (재직자 기준)
const groupUsers = computed(() => {
  if (kind.value !== 'groups' || pickedGroup.value === null) return []
  const all = users.value?.items ?? []
  const active = all.filter((u) => u.employmentStatus === 'ACTIVE')
  if (pickedGroup.value === 'unassigned') {
    return active.filter((u) => u.groupId === null || !u.groupId)
  }
  return active.filter((u) => u.groupId === pickedGroup.value)
})

const filteredGroupUsers = computed(() => {
  const q = memberFilter.value.trim().toLowerCase()
  if (!q) return groupUsers.value
  return groupUsers.value.filter(
    (u) => u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q),
  )
})

const isUnassignedGroup = computed(() => kind.value === 'groups' && pickedGroup.value === 'unassigned')

// ── 드래그 앤 드롭으로 소속 그룹 이동 ──────────────────────────────────
const draggedUser = ref<UserRow | null>(null)
const dragOverGroupId = ref<number | string | null>(null)

function onDragStart(event: DragEvent, user: UserRow) {
  draggedUser.value = user
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(user.id))
  }
}

function onDragEnd() {
  draggedUser.value = null
  dragOverGroupId.value = null
}

function isDropDisabled(g: DisplayGroup) {
  if (!draggedUser.value) return false
  if (g.isUnassigned) {
    return draggedUser.value.groupId === null || !draggedUser.value.groupId
  }
  return draggedUser.value.groupId === g.id
}

function onGroupDragOver(event: DragEvent, g: DisplayGroup) {
  if (!draggedUser.value) return
  if (isDropDisabled(g)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverGroupId.value = g.id
}

function onGroupDragLeave(event: DragEvent, g: DisplayGroup) {
  const currentTarget = event.currentTarget as HTMLElement | null
  const relatedTarget = event.relatedTarget as HTMLElement | null
  if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
    return
  }
  if (dragOverGroupId.value === g.id) {
    dragOverGroupId.value = null
  }
}

async function onGroupDrop(event: DragEvent, targetGroup: DisplayGroup) {
  dragOverGroupId.value = null
  const user = draggedUser.value
  draggedUser.value = null
  if (!user) return

  const targetGroupId = targetGroup.isUnassigned ? null : (targetGroup.id as number)
  const isAlreadyInGroup = targetGroup.isUnassigned
    ? (user.groupId === null || !user.groupId)
    : user.groupId === targetGroup.id

  if (isAlreadyInGroup) {
    say('ok', `${user.name} 님은 이미 '${targetGroup.name}' 소속입니다.`)
    return
  }

  try {
    await api.patch(`/users/${user.id}`, { groupId: targetGroupId })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['users'] }),
      qc.invalidateQueries({ queryKey: ['groups'] }),
      qc.invalidateQueries({ queryKey: ['user-perms'] }),
      qc.invalidateQueries({ queryKey: ['user-permission-counts'] }),
    ])
    say('ok', `${user.name} 님의 소속을 '${targetGroup.name}'(으)로 이동했습니다.`)
  } catch (e) {
    fail(e)
  }
}

// ── 고른 대상의 권한 ───────────────────────────────────────────────────
const { data: groupPerms } = useQuery({
  queryKey: computed(() => ['group-perms', pickedGroup.value]),
  queryFn: () => api.get<GroupPermissionsResponse>(`/groups/${pickedGroup.value}/permissions`),
  enabled: computed(() => kind.value === 'groups' && pickedGroup.value !== null && pickedGroup.value !== 'unassigned'),
})
const { data: userPerms } = useQuery({
  queryKey: computed(() => ['user-perms', pickedUser.value]),
  queryFn: () => api.get<UserPermissionsResponse>(`/users/${pickedUser.value}/permissions`),
  enabled: computed(() => kind.value === 'users' && pickedUser.value !== null),
})

/** 편집용 사본 (기능 권한 트리) — 저장을 누를 때까지 서버에 보내지 않는다 */
const draft = ref<Set<string>>(new Set())
watch([groupPerms, userPerms, kind, pickedGroup], () => {
  if (isUnassignedGroup.value) {
    draft.value = new Set()
    return
  }
  const src = kind.value === 'groups' ? groupPerms.value?.granted : userPerms.value?.granted
  draft.value = new Set(src ?? [])
}, { immediate: true })

/** 사람을 고른 경우에만 상속분이 있다 */
const inherited = computed(() =>
  kind.value === 'users' ? new Set(userPerms.value?.fromGroup ?? []) : new Set<string>(),
)
const isAdmin = computed(() => kind.value === 'users' && userPerms.value?.isAdmin === true)

const hasTarget = computed(() =>
  kind.value === 'groups' ? pickedGroup.value !== null : pickedUser.value !== null)

const saved = computed(() => {
  if (isUnassignedGroup.value) return new Set<string>()
  return new Set(kind.value === 'groups' ? groupPerms.value?.granted ?? [] : userPerms.value?.granted ?? [])
})

const treeDirty = computed(() => {
  if (!hasTarget.value || isUnassignedGroup.value) return false
  if (draft.value.size !== saved.value.size) return true
  for (const k of draft.value) if (!saved.value.has(k)) return true
  return false
})

function onToggle(keys: string[], on: boolean) {
  const next = new Set(draft.value)
  for (const k of keys) {
    if (on) next.add(k)
    else next.delete(k)
  }
  draft.value = next
}

// ── 그룹 메뉴 CRUD 권한 관리 ──────────────────────────────────────────────
export interface EditableMenuPerm {
  menuId: number
  code: string
  label: string
  category: string
  sortOrder: number
  path: string
  canView: boolean
  canCreate: boolean
  canRead: boolean
  canUpdate: boolean
  canDelete: boolean
}

// 그룹 메뉴 권한 조회 (그룹 선택 시)
const currentGroupIdForMenu = computed(() => {
  if (kind.value === 'groups') {
    return typeof pickedGroup.value === 'number' ? pickedGroup.value : null
  }
  if (kind.value === 'users' && userPerms.value?.groupId) {
    return userPerms.value.groupId
  }
  return null
})

const { data: menuPerms } = useQuery({
  queryKey: computed(() => ['group-menu-permissions', currentGroupIdForMenu.value]),
  queryFn: () => api.get<GroupMenuPermissionsResponse>(`/groups/${currentGroupIdForMenu.value}/menu-permissions`),
  enabled: computed(() => currentGroupIdForMenu.value !== null),
  staleTime: 10_000,
})

const menuDraft = ref<EditableMenuPerm[]>([])
const menuSavedMap = ref<Map<number, EditableMenuPerm>>(new Map())

watch(
  [menuPerms, currentGroupIdForMenu, kind],
  () => {
    if (isUnassignedGroup.value || (kind.value === 'users' && !userPerms.value?.groupId)) {
      menuDraft.value = (menus.value?.items ?? []).map((m) => ({
        menuId: m.id,
        code: m.code,
        label: m.label,
        category: m.category || '기타',
        sortOrder: m.sortOrder,
        path: m.path,
        canView: false,
        canCreate: false,
        canRead: false,
        canUpdate: false,
        canDelete: false,
      }))
      menuSavedMap.value = new Map()
      return
    }

    if (menuPerms.value?.items) {
      menuDraft.value = menuPerms.value.items.map((i) => ({ ...i }))
      menuSavedMap.value = new Map(menuPerms.value.items.map((i) => [i.menuId, { ...i }]))
    }
  },
  { immediate: true },
)

const menuDirty = computed(() => {
  if (kind.value !== 'groups' || !hasTarget.value || isUnassignedGroup.value) return false
  if (menuDraft.value.length === 0 && menuSavedMap.value.size === 0) return false
  for (const item of menuDraft.value) {
    const orig = menuSavedMap.value.get(item.menuId)
    if (!orig) return true
    if (
      item.canView !== orig.canView ||
      item.canCreate !== orig.canCreate ||
      item.canRead !== orig.canRead ||
      item.canUpdate !== orig.canUpdate ||
      item.canDelete !== orig.canDelete
    ) {
      return true
    }
  }
  return false
})

const dirty = computed(() => treeDirty.value || menuDirty.value)

// 카테고리별 그룹핑
const menuCategories = computed(() => {
  const cats: { name: string; items: EditableMenuPerm[] }[] = []
  const map = new Map<string, EditableMenuPerm[]>()
  for (const item of menuDraft.value) {
    const cat = item.category || '기타'
    if (!map.has(cat)) {
      const arr: EditableMenuPerm[] = []
      map.set(cat, arr)
      cats.push({ name: cat, items: arr })
    }
    map.get(cat)!.push(item)
  }
  return cats
})

// 메뉴 열람(View) 해제 시 CRUD 자동 해제 연동
function onViewToggle(item: EditableMenuPerm) {
  if (!item.canView) {
    item.canCreate = false
    item.canRead = false
    item.canUpdate = false
    item.canDelete = false
  } else {
    item.canRead = true
  }
}

// CRUD 체크 시 자동으로 열람(View)도 켜지도록 연동
function onCrudToggle(item: EditableMenuPerm) {
  if (item.canCreate || item.canRead || item.canUpdate || item.canDelete) {
    item.canView = true
  }
}

// 행 전체 선택 여부 확인 및 토글
function isRowAllChecked(item: EditableMenuPerm) {
  return item.canView && item.canCreate && item.canRead && item.canUpdate && item.canDelete
}

function toggleRowAll(item: EditableMenuPerm) {
  if (isUnassignedGroup.value || kind.value === 'users') return
  const next = !isRowAllChecked(item)
  item.canView = next
  item.canCreate = next
  item.canRead = next
  item.canUpdate = next
  item.canDelete = next
}

// 일괄 모드 설정
function setBatchMode(mode: 'all' | 'none' | 'readonly') {
  if (isUnassignedGroup.value || kind.value === 'users') return
  for (const item of menuDraft.value) {
    if (mode === 'all') {
      item.canView = true
      item.canCreate = true
      item.canRead = true
      item.canUpdate = true
      item.canDelete = true
    } else if (mode === 'none') {
      item.canView = false
      item.canCreate = false
      item.canRead = false
      item.canUpdate = false
      item.canDelete = false
    } else if (mode === 'readonly') {
      item.canView = true
      item.canCreate = false
      item.canRead = true
      item.canUpdate = false
      item.canDelete = false
    }
  }
}

// 컬럼 전체 선택 / 해제
const isAllViewChecked = computed({
  get: () => menuDraft.value.length > 0 && menuDraft.value.every((i) => i.canView),
  set: (val: boolean) => {
    if (isUnassignedGroup.value || kind.value === 'users') return
    for (const item of menuDraft.value) {
      item.canView = val
      if (!val) {
        item.canCreate = false
        item.canRead = false
        item.canUpdate = false
        item.canDelete = false
      }
    }
  },
})

const isAllCreateChecked = computed({
  get: () => menuDraft.value.length > 0 && menuDraft.value.every((i) => i.canCreate),
  set: (val: boolean) => {
    if (isUnassignedGroup.value || kind.value === 'users') return
    for (const item of menuDraft.value) {
      item.canCreate = val
      if (val) item.canView = true
    }
  },
})

const isAllReadChecked = computed({
  get: () => menuDraft.value.length > 0 && menuDraft.value.every((i) => i.canRead),
  set: (val: boolean) => {
    if (isUnassignedGroup.value || kind.value === 'users') return
    for (const item of menuDraft.value) {
      item.canRead = val
      if (val) item.canView = true
    }
  },
})

const isAllUpdateChecked = computed({
  get: () => menuDraft.value.length > 0 && menuDraft.value.every((i) => i.canUpdate),
  set: (val: boolean) => {
    if (isUnassignedGroup.value || kind.value === 'users') return
    for (const item of menuDraft.value) {
      item.canUpdate = val
      if (val) item.canView = true
    }
  },
})

const isAllDeleteChecked = computed({
  get: () => menuDraft.value.length > 0 && menuDraft.value.every((i) => i.canDelete),
  set: (val: boolean) => {
    if (isUnassignedGroup.value || kind.value === 'users') return
    for (const item of menuDraft.value) {
      item.canDelete = val
      if (val) item.canView = true
    }
  },
})

// 오른쪽 패널: 열리는 메뉴 목록 및 현재 C/R/U/D 현황
const openMenus = computed(() => {
  const eff = new Set([...draft.value, ...inherited.value])
  const menuMap = new Map(menuDraft.value.map((m) => [m.code, m]))

  return (menus.value?.items ?? []).map((m) => {
    const crud = menuMap.get(m.code)
    const allowed = isAdmin.value || eff.has(m.permissionKey) || Boolean(crud?.canView)
    return {
      label: m.label,
      code: m.code,
      path: m.path,
      enabled: m.isEnabled,
      allowed,
      canCreate: isAdmin.value || Boolean(crud?.canCreate),
      canRead: isAdmin.value || Boolean(crud?.canRead),
      canUpdate: isAdmin.value || Boolean(crud?.canUpdate),
      canDelete: isAdmin.value || Boolean(crud?.canDelete),
    }
  })
})

// ── 저장 및 되돌리기 ───────────────────────────────────────────────────────
async function save() {
  if (!dirty.value || !hasTarget.value || isUnassignedGroup.value) return
  saving.value = true
  try {
    const granted = [...draft.value]
    if (kind.value === 'groups') {
      const gId = pickedGroup.value as number
      const tasks: Promise<unknown>[] = []

      if (treeDirty.value) {
        tasks.push(
          api.put<GroupPermissionsResponse>(`/groups/${gId}/permissions`, { granted }).then((out) => {
            qc.setQueryData(['group-perms', gId], out)
          }),
        )
      }

      if (menuDirty.value) {
        const permissions = menuDraft.value.map((i) => ({
          menuId: i.menuId,
          canView: i.canView,
          canCreate: i.canCreate,
          canRead: i.canRead,
          canUpdate: i.canUpdate,
          canDelete: i.canDelete,
        }))
        tasks.push(
          api.put<GroupMenuPermissionsResponse>(`/groups/${gId}/menu-permissions`, { permissions }).then((out) => {
            qc.setQueryData(['group-menu-permissions', gId], out)
            menuSavedMap.value = new Map(out.items.map((i) => [i.menuId, { ...i }]))
          }),
        )
      }

      await Promise.all(tasks)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['groups'] }),
        qc.invalidateQueries({ queryKey: ['group-menu-permissions'] }),
      ])
      say('ok', '그룹 메뉴 C/R/U/D 및 기능 권한을 저장했습니다. 구성원 모두에게 바로 적용됩니다.')
    } else {
      const out = await api.put<UserPermissionsResponse>(
        `/users/${pickedUser.value}/permissions`, { granted })
      qc.setQueryData(['user-perms', pickedUser.value], out)
      await qc.invalidateQueries({ queryKey: ['user-permission-counts'] })
      say('ok', '개인 권한을 저장했습니다. 그룹 권한에 더해져 바로 적용됩니다.')
    }
  } catch (e) {
    fail(e)
  } finally {
    saving.value = false
  }
}

function reset() {
  draft.value = new Set(saved.value)
  if (menuSavedMap.value.size > 0) {
    menuDraft.value = Array.from(menuSavedMap.value.values()).map((i) => ({ ...i }))
  }
}
</script>

<template>
  <main class="app-main perms">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          접속권한 관리<span class="page-title-sub">그룹별 메뉴 접근·C/R/U/D 및 화면 기능 권한 설정</span>
        </h1>
      </div>
    </div>

    <div class="cols">
      <!-- 1단: 대상 고르기 (그룹 / 사용자) -->
      <div class="panel side">
        <div class="panel-head">누구에게</div>
        <div class="pad"><Tabs v-model="kind" :tabs="KINDS" /></div>

        <template v-if="kind === 'groups'">
          <div
            v-for="g in displayGroups" :key="g.id"
            class="pick group-drop-zone"
            :class="{
              on: pickedGroup === g.id,
              'drop-active': dragOverGroupId === g.id,
              'drop-disabled': isDropDisabled(g),
            }"
            @click="pickedGroup = g.id"
            @dragover.prevent="onGroupDragOver($event, g)"
            @dragleave="onGroupDragLeave($event, g)"
            @drop.prevent="onGroupDrop($event, g)"
          >
            <strong>{{ g.name }}</strong>
            <div class="muted sub">구성원 {{ g.memberCount }} · 권한 {{ g.permissionCount }}</div>
          </div>
          <div v-if="!displayGroups.length" class="pad muted">그룹이 없습니다.</div>
        </template>

        <template v-else>
          <div class="pad">
            <input v-model="userFilter" class="in" placeholder="이름·아이디로 거르기" />
          </div>
          <div class="scroll">
            <div
              v-for="u in userList" :key="u.id"
              class="pick" :class="{ on: pickedUser === u.id }"
              @click="pickedUser = u.id"
            >
              <strong>{{ u.name }}</strong>
              <span class="muted"> ({{ u.loginId }})</span>
              <span v-if="u.role === 'ADMIN'" class="tag">관리자</span>
              <span v-else-if="ownCount.get(u.id)" class="tag">개인 {{ ownCount.get(u.id) }}</span>
              <div class="muted sub">{{ u.groupName ?? '그룹 없음' }}</div>
            </div>
            <div v-if="!userList.length" class="pad muted">해당하는 사람이 없습니다.</div>
          </div>
        </template>
      </div>

      <!-- 2단: 어떤 권한 (메뉴 C/R/U/D 및 기능 권한 트리) -->
      <div class="panel main">
        <div class="panel-head">
          <Tabs v-model="centerTab" :tabs="CENTER_TABS" class="center-tabs" />
          <span style="flex:1" />
          <button class="btn btn-sm" permission="u" :disabled="!dirty || saving" @click="reset">되돌리기</button>
          <button
            class="btn btn-sm btn-primary" permission="u" :disabled="!dirty || saving || isAdmin || isUnassignedGroup"
            @click="save"
          >{{ saving ? '저장 중…' : '저장' }}</button>
        </div>

        <div v-if="!hasTarget" class="pad muted">왼쪽에서 그룹이나 사람을 고르세요.</div>

        <template v-else>
          <div v-if="isAdmin" class="pad msg warn">
            관리자(ADMIN)는 모든 메뉴 접근 및 C, R, U, D 권한이 항상 활성화됩니다.
          </div>
          <div v-else-if="isUnassignedGroup" class="pad muted sub">
            미소속사용자그룹은 소속 그룹이 없는 사용자들의 기본 상태(권한 0개)입니다.
            권한을 부여하려면 [사용자 관리]에서 특정 그룹에 배정하거나, 사용자를 드래그하여 원하는 그룹으로 이동하세요.
          </div>
          <div v-else-if="kind === 'users'" class="pad muted sub">
            <strong>{{ userPerms?.groupName ?? '그룹 없음' }}</strong> 에서 오는 메뉴 및 기능 권한은
            <em>그룹에서 상속</em> 으로 잠겨 있습니다.
          </div>

          <!-- 탭 A: 메뉴 및 C/R/U/D 권한 테이블 -->
          <div v-if="centerTab === 'menu_crud'" class="pad crud-wrap">
            <div class="crud-toolbar" v-if="kind === 'groups' && !isUnassignedGroup">
              <span class="toolbar-guide">
                메뉴 권한(열람)을 부여하면 화면 내 C(등록), R(조회), U(수정), D(삭제) 권한도 지정할 수 있습니다.
              </span>
              <div class="toolbar-actions">
                <button type="button" class="btn btn-xs" permission="u" @click="setBatchMode('all')">전체 허용</button>
                <button type="button" class="btn btn-xs" permission="u" @click="setBatchMode('readonly')">조회 전용</button>
                <button type="button" class="btn btn-xs" permission="u" @click="setBatchMode('none')">전체 해제</button>
              </div>
            </div>

            <div class="table-scroll">
              <table class="crud-table">
                <thead>
                  <tr>
                    <th class="th-cat">카테고리</th>
                    <th class="th-menu">메뉴</th>
                    <th class="th-check">
                      <label class="col-head-label">
                        <input
                          type="checkbox"
                          v-model="isAllViewChecked"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                        />
                        <span>메뉴 열람</span>
                      </label>
                    </th>
                    <th class="th-check">
                      <label class="col-head-label">
                        <input
                          type="checkbox"
                          v-model="isAllCreateChecked"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                        />
                        <span>C (등록)</span>
                      </label>
                    </th>
                    <th class="th-check">
                      <label class="col-head-label">
                        <input
                          type="checkbox"
                          v-model="isAllReadChecked"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                        />
                        <span>R (조회)</span>
                      </label>
                    </th>
                    <th class="th-check">
                      <label class="col-head-label">
                        <input
                          type="checkbox"
                          v-model="isAllUpdateChecked"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                        />
                        <span>U (수정)</span>
                      </label>
                    </th>
                    <th class="th-check">
                      <label class="col-head-label">
                        <input
                          type="checkbox"
                          v-model="isAllDeleteChecked"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                        />
                        <span>D (삭제)</span>
                      </label>
                    </th>
                    <th class="th-act">전체</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="cat in menuCategories" :key="cat.name">
                    <tr
                      v-for="(item, idx) in cat.items"
                      :key="item.menuId"
                      :class="{ 'row-disabled': !item.canView }"
                    >
                      <td v-if="idx === 0" :rowspan="cat.items.length" class="cat-cell">
                        <span class="cat-badge">{{ cat.name }}</span>
                      </td>
                      <td class="menu-name-cell">
                        <div class="menu-name-wrap">
                          <NavIcon :code="item.code" :path="item.path" class="menu-icon" />
                          <div>
                            <strong>{{ item.label }}</strong>
                            <span class="menu-path muted sub">{{ item.path }}</span>
                          </div>
                        </div>
                      </td>
                      <td class="td-check">
                        <input
                          type="checkbox"
                          v-model="item.canView"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                          @change="onViewToggle(item)"
                        />
                      </td>
                      <td class="td-check">
                        <input
                          type="checkbox"
                          v-model="item.canCreate"
                          :disabled="!item.canView || kind === 'users' || isUnassignedGroup || isAdmin"
                          @change="onCrudToggle(item)"
                        />
                      </td>
                      <td class="td-check">
                        <input
                          type="checkbox"
                          v-model="item.canRead"
                          :disabled="!item.canView || kind === 'users' || isUnassignedGroup || isAdmin"
                          @change="onCrudToggle(item)"
                        />
                      </td>
                      <td class="td-check">
                        <input
                          type="checkbox"
                          v-model="item.canUpdate"
                          :disabled="!item.canView || kind === 'users' || isUnassignedGroup || isAdmin"
                          @change="onCrudToggle(item)"
                        />
                      </td>
                      <td class="td-check">
                        <input
                          type="checkbox"
                          v-model="item.canDelete"
                          :disabled="!item.canView || kind === 'users' || isUnassignedGroup || isAdmin"
                          @change="onCrudToggle(item)"
                        />
                      </td>
                      <td class="td-act">
                        <button
                          type="button"
                          class="btn btn-xs btn-toggle"
                          :disabled="kind === 'users' || isUnassignedGroup || isAdmin"
                          @click="toggleRowAll(item)"
                        >
                          {{ isRowAllChecked(item) ? '해제' : '선택' }}
                        </button>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 탭 B: 기존 상세 기능 권한 트리 -->
          <div v-else class="pad tree">
            <PermissionTree
              v-if="tree"
              :tree="tree.tree" :granted="draft" :inherited="inherited" :readonly="isAdmin || isUnassignedGroup"
              @toggle="onToggle"
            />
          </div>
        </template>
      </div>

      <!-- 3단: 열리는 메뉴 & 그룹 사용자 -->
      <div class="panel side">
        <div class="panel-head">{{ rightTab === 'members' ? '그룹 사용자' : '열리는 메뉴' }}</div>
        <div class="pad"><Tabs v-model="rightTab" :tabs="RIGHT_TABS" /></div>

        <!-- 탭 1: 그룹 사용자 -->
        <template v-if="rightTab === 'members'">
          <div v-if="kind !== 'groups' || pickedGroup === null" class="pad muted">
            왼쪽에서 그룹을 고르면 소속 사용자가 보입니다.
          </div>
          <template v-else>
            <div class="pad muted sub drag-guide">
              사용자를 드래그하여 왼쪽 그룹에 떨어뜨리면 소속 그룹이 이동됩니다.
            </div>
            <div v-if="groupUsers.length > 5" class="pad">
              <input v-model="memberFilter" class="in" placeholder="이름·아이디로 검색" />
            </div>
            <div class="scroll">
              <div
                v-for="u in filteredGroupUsers" :key="u.id"
                class="user-item"
                :class="{ dragging: draggedUser?.id === u.id }"
                draggable="true"
                @dragstart="onDragStart($event, u)"
                @dragend="onDragEnd"
              >
                <div class="drag-handle" title="드래그하여 그룹으로 이동">
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <circle cx="3" cy="2" r="1.5" />
                    <circle cx="9" cy="2" r="1.5" />
                    <circle cx="3" cy="7" r="1.5" />
                    <circle cx="9" cy="7" r="1.5" />
                    <circle cx="3" cy="12" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                  </svg>
                </div>
                <div class="user-item-info">
                  <div class="user-item-name">
                    <strong>{{ u.name }}</strong>
                    <span class="muted"> ({{ u.loginId }})</span>
                    <span v-if="u.role === 'ADMIN'" class="tag">관리자</span>
                  </div>
                  <div class="muted sub">
                    {{ [u.department, u.position].filter(Boolean).join(' · ') || '부서·직급 없음' }}
                  </div>
                </div>
              </div>
              <div v-if="!groupUsers.length" class="pad muted">소속된 사용자가 없습니다.</div>
              <div v-else-if="!filteredGroupUsers.length" class="pad muted">일치하는 사용자가 없습니다.</div>
            </div>
          </template>
        </template>

        <!-- 탭 2: 열리는 메뉴 및 C/R/U/D 현황 -->
        <template v-else>
          <div v-if="!hasTarget" class="pad muted">대상을 고르면 보입니다.</div>
          <template v-else>
            <div class="pad muted sub">
              지금 켜 둔 권한으로 사용 가능한 메뉴와 C/R/U/D 버튼 권한입니다.
            </div>
            <div class="scroll">
              <div
                v-for="m in openMenus" :key="m.path"
                class="menu-row" :class="{ no: !m.allowed || !m.enabled }"
              >
                <div class="menu-row-main">
                  <span class="dot">{{ m.allowed && m.enabled ? '●' : '○' }}</span>
                  <span class="menu-label-text">{{ m.label }}</span>
                  <span v-if="!m.enabled" class="tag tag-warn">메뉴 꺼짐</span>
                </div>
                <div v-if="m.allowed && m.enabled" class="crud-badges">
                  <span class="crud-pill" :class="{ active: m.canCreate }">C</span>
                  <span class="crud-pill" :class="{ active: m.canRead }">R</span>
                  <span class="crud-pill" :class="{ active: m.canUpdate }">U</span>
                  <span class="crud-pill" :class="{ active: m.canDelete }">D</span>
                </div>
              </div>
              <div class="pad muted sub">
                메뉴가 꺼져 있으면 권한이 있어도 열리지 않습니다 —
                <RouterLink :to="menusPath">메뉴 관리</RouterLink> 에서 켭니다.
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.cols { display: grid; grid-template-columns: 240px minmax(0, 1fr) 280px; gap: var(--sp-3); align-items: start; }
@media (max-width: 1200px) { .cols { grid-template-columns: 1fr; } }
.side { max-height: 78vh; display: flex; flex-direction: column; }
.scroll { overflow-y: auto; }
.main { min-height: 480px; }
.tree { overflow: auto; max-height: 68vh; }
.in { width: 100%; }
.pick { padding: 7px 12px; cursor: pointer; border-left: 3px solid transparent; }
.pick:hover { background: var(--surface-2); }
.pick.on { background: var(--primary-soft); border-left-color: var(--primary); }
.group-drop-zone {
  transition: background-color 0.15s ease, border-color 0.15s ease, outline 0.15s ease;
}
.group-drop-zone * {
  pointer-events: none;
}
.group-drop-zone.drop-active {
  background: var(--primary-soft) !important;
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
}
.group-drop-zone.drop-disabled {
  opacity: 0.6;
}
.drag-guide {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-xs);
  line-height: 1.4;
}
.user-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  cursor: grab;
  user-select: none;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.user-item:hover {
  background: var(--surface-2);
}
.user-item:active {
  cursor: grabbing;
}
.user-item.dragging {
  opacity: 0.4;
  background: var(--surface-2);
}
.drag-handle {
  display: flex;
  align-items: center;
  color: var(--fg-muted);
  cursor: grab;
  flex: 0 0 auto;
}
.user-item-info {
  flex: 1 1 auto;
  min-width: 0;
}
.user-item-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub { font-size: var(--fs-xs); }
.tag {
  font-size: var(--fs-xs); color: var(--fg-muted); margin-left: 6px;
  border: 1px solid var(--border); border-radius: 999px; padding: 0 6px;
}
.tag-warn {
  color: var(--warn);
  border-color: var(--warn);
}
.menu-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.menu-row-main {
  display: flex;
  align-items: center;
  gap: 7px;
}
.menu-row .dot { color: var(--ok); }
.menu-row.no { color: var(--fg-muted); }
.menu-row.no .dot { color: var(--border-strong); }
.menu-label-text { font-weight: 500; font-size: var(--fs-sm); }
.crud-badges {
  display: flex;
  gap: 4px;
  margin-left: 19px;
}
.crud-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--fg-muted);
  opacity: 0.4;
}
.crud-pill.active {
  background: var(--primary-soft);
  color: var(--primary);
  opacity: 1;
  border: 1px solid var(--primary);
}
.menu-row a { text-decoration: underline; }

/* ── 중앙 패널 스타일 ── */
.center-tabs {
  margin: -4px 0;
}
.crud-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
}
.crud-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  gap: 8px;
}
.toolbar-guide {
  color: var(--fg-muted);
}
.toolbar-actions {
  display: flex;
  gap: 4px;
}
.table-scroll {
  overflow-x: auto;
  max-height: 62vh;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.crud-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-xs);
  text-align: left;
}
.crud-table th, .crud-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.crud-table thead th {
  background: var(--surface-2);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 2;
}
.th-cat { width: 70px; }
.th-menu { width: auto; min-width: 140px; }
.th-check { width: 75px; text-align: center; }
.th-act { width: 50px; text-align: center; }
.td-check { text-align: center; }
.td-act { text-align: center; }
.col-head-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  font-size: 11px;
}
.cat-cell {
  background: var(--surface);
  border-right: 1px solid var(--border);
  text-align: center;
}
.cat-badge {
  display: inline-block;
  padding: 2px 6px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--fg-muted);
}
.menu-name-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.menu-icon {
  width: 16px;
  height: 16px;
  color: var(--fg-muted);
  flex-shrink: 0;
}
.menu-path {
  margin-left: 6px;
  color: var(--fg-muted);
}
.row-disabled {
  background: var(--surface-2);
  opacity: 0.6;
}
.btn-toggle {
  padding: 2px 6px;
  font-size: 11px;
}
</style>
