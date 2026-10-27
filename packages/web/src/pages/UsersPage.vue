<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  EmploymentStatus, GroupListResponse, GroupRow, PartnerCompanyListResponse, PartnerCompanyRow, UserListResponse, UserRow,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError } from '@/lib/api'

/** 사용자 관리 — 왼쪽 그룹/소속 탭 목록과 오른쪽 사용자 목록으로 그룹별·소속별 사용자를 확인하고 드래그 앤 드롭으로 소속/그룹을 변경한다. */

const qc = useQueryClient()

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

// ── 데이터 조회 ────────────────────────────────────────────────────────
const keyword = ref('')
const { data: users } = useQuery({
  queryKey: ['users'],
  queryFn: () => api.get<UserListResponse>('/users'),
  staleTime: 30_000,
})
const { data: groups } = useQuery({
  queryKey: ['groups'],
  queryFn: () => api.get<GroupListResponse>('/groups'),
  staleTime: 30_000,
})

const { data: partners } = useQuery({
  queryKey: ['partner-companies'],
  queryFn: () => api.get<PartnerCompanyListResponse>('/partner-companies'),
  staleTime: 60_000,
})

// ── 왼쪽 탭 (그룹 / 소속) ──────────────────────────────────────────────
type LeftTab = 'group' | 'company'
const leftTab = ref<LeftTab>('group')
const dragOverTab = ref<LeftTab | null>(null)

function onTabDragOver(tab: LeftTab) {
  if (!draggedUser.value) return
  dragOverTab.value = tab
  if (leftTab.value !== tab) {
    leftTab.value = tab
  }
}

// ── 그룹 선택 및 필터 ──────────────────────────────────────────────────
const selectedGroup = ref<number | 'ALL' | 'UNASSIGNED'>('ALL')
const groupSearch = ref('')

const filteredGroups = computed(() => {
  const list = groups.value?.items ?? []
  const q = groupSearch.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((g) => g.name.toLowerCase().includes(q) || g.description?.toLowerCase().includes(q))
})

const currentGroupName = computed(() => {
  if (selectedGroup.value === 'ALL') return '전체'
  if (selectedGroup.value === 'UNASSIGNED') return '미소속'
  return groups.value?.items.find((g) => g.id === selectedGroup.value)?.name ?? '선택 그룹'
})

const unassignedCount = computed(() =>
  (users.value?.items ?? []).filter((u) => u.groupId === null || !u.groupId).length,
)

const memberCountMap = computed(() => {
  const map = new Map<number, number>()
  for (const u of users.value?.items ?? []) {
    if (u.groupId) {
      map.set(u.groupId, (map.get(u.groupId) ?? 0) + 1)
    }
  }
  return map
})

// ── 소속 선택 및 필터 ──────────────────────────────────────────────────
const selectedCompany = ref<number | string | 'ALL'>('ALL')
const companySearch = ref('')

const filteredCompanies = computed(() => {
  const list = partners.value?.items ?? []
  const q = companySearch.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    p.companyCode?.toLowerCase().includes(q) ||
    p.representative?.toLowerCase().includes(q),
  )
})

const partnerMemberCountMap = computed(() => {
  const map = new Map<number, number>()
  for (const u of users.value?.items ?? []) {
    if (u.partnerCompanyId) {
      map.set(u.partnerCompanyId, (map.get(u.partnerCompanyId) ?? 0) + 1)
    }
  }
  return map
})

const skgasMemberCount = computed(() =>
  (users.value?.items ?? []).filter((u) => u.partnerCompanyId === null || !u.partnerCompanyId).length,
)

const currentCompanyName = computed(() => {
  if (selectedCompany.value === 'ALL') return '전체'
  if (selectedCompany.value === 'SKGAS') return 'SK가스'
  const p = partners.value?.items.find((x) => x.id === selectedCompany.value)
  if (p) return p.name
  return String(selectedCompany.value)
})

// ── 상태 및 부서 필터 ──────────────────────────────────────────────────
interface StatusOption { key: EmploymentStatus; label: string; cls: string }
const STATUS: StatusOption[] = [
  { key: 'ACTIVE',  label: '재직', cls: '' },
  { key: 'RETIRED', label: '퇴직', cls: 'warn-tag' },
  { key: 'DELETED', label: '삭제', cls: 'tag-danger' },
]
const statusLabel = (k: EmploymentStatus) => STATUS.find((x) => x.key === k)?.label ?? k

// 처음 열었을 때는 재직만 보인다 — 퇴직·삭제까지 섞이면 목록이 쓸모없어진다
// (기존 시스템 2026-08-12 CM 요청과 같은 기본값).
const shown = ref(new Set<EmploymentStatus>(['ACTIVE']))
function toggleStatus(k: EmploymentStatus) {
  const next = new Set(shown.value)
  next.has(k) ? next.delete(k) : next.add(k)
  shown.value = next
}
const dept = ref('')
const departments = computed(() =>
  [...new Set((users.value?.items ?? []).map((u) => u.department).filter(Boolean))].sort() as string[],
)

// ── 사용자 목록 필터링 ──────────────────────────────────────────────────
const rows = computed(() =>
  (users.value?.items ?? []).filter((u) => {
    // 1. 좌측 탭에 따른 필터링 (그룹 탭 vs 소속 탭)
    if (leftTab.value === 'group') {
      if (selectedGroup.value !== 'ALL') {
        if (selectedGroup.value === 'UNASSIGNED') {
          if (u.groupId !== null && u.groupId !== undefined && u.groupId !== 0) return false
        } else {
          if (u.groupId !== selectedGroup.value) return false
        }
      }
    } else {
      if (selectedCompany.value !== 'ALL') {
        if (selectedCompany.value === 'SKGAS') {
          if (u.partnerCompanyId !== null && u.partnerCompanyId !== undefined) return false
        } else if (typeof selectedCompany.value === 'number') {
          if (u.partnerCompanyId !== selectedCompany.value) return false
        } else {
          if (u.partnerCompanyId !== null || u.companyCode !== selectedCompany.value) return false
        }
      }
    }

    // 2. 재직 상태, 부서, 키워드 필터링
    if (shown.value.size && !shown.value.has(u.employmentStatus)) return false
    if (dept.value && u.department !== dept.value) return false
    const k = keyword.value.trim().toLowerCase()
    if (!k) return true
    return [u.loginId, u.name, u.employeeNumber, u.email, u.phone, u.extensionNumber,
            u.department, u.position, u.partnerCompanyName, u.companyCode]
      .some((v) => v?.toLowerCase().includes(k))
  }),
)

// 상단 필터 배지
const activeFilterBadge = computed(() => {
  if (leftTab.value === 'group' && selectedGroup.value !== 'ALL') {
    return { type: 'group' as const, label: '그룹', name: currentGroupName.value }
  }
  if (leftTab.value === 'company' && selectedCompany.value !== 'ALL') {
    return { type: 'company' as const, label: '소속', name: currentCompanyName.value }
  }
  return null
})

function clearActiveFilter() {
  if (leftTab.value === 'group') {
    selectedGroup.value = 'ALL'
  } else {
    selectedCompany.value = 'ALL'
  }
}

// ── 드래그 앤 드롭으로 그룹 / 소속 변경 ─────────────────────────────────
const draggedUser = ref<UserRow | null>(null)
const dragOverTarget = ref<{ type: 'group' | 'company'; id: number | string } | null>(null)

function onRowDragStart(event: DragEvent, user: UserRow) {
  draggedUser.value = user
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(user.id))
  }
}

function onRowDragEnd() {
  draggedUser.value = null
  dragOverTarget.value = null
  dragOverTab.value = null
}

function isDragOver(type: 'group' | 'company', id: number | string) {
  return dragOverTarget.value?.type === type && dragOverTarget.value?.id === id
}

function isDropDisabledForGroup(groupId: number | 'UNASSIGNED') {
  if (!draggedUser.value) return false
  if (groupId === 'UNASSIGNED') {
    return draggedUser.value.groupId === null || !draggedUser.value.groupId
  }
  return draggedUser.value.groupId === groupId
}

function onGroupDragOver(event: DragEvent, g: GroupRow | { id: 'UNASSIGNED'; name: string }) {
  if (!draggedUser.value) return
  if (isDropDisabledForGroup(g.id)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverTarget.value = { type: 'group', id: g.id }
}

function isDropDisabledForCompany(target: number | 'SKGAS') {
  if (!draggedUser.value) return false
  if (target === 'SKGAS') {
    return !draggedUser.value.partnerCompanyId && (draggedUser.value.companyCode === 'SKGAS' || !draggedUser.value.companyCode)
  }
  return draggedUser.value.partnerCompanyId === target
}

function onCompanyDragOver(event: DragEvent, target: PartnerCompanyRow | { id: 'SKGAS'; name: string }) {
  if (!draggedUser.value) return
  if (isDropDisabledForCompany(target.id)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverTarget.value = { type: 'company', id: target.id }
}

function onDragLeave(event: DragEvent, type: 'group' | 'company', targetId: number | string) {
  const currentTarget = event.currentTarget as HTMLElement | null
  const relatedTarget = event.relatedTarget as HTMLElement | null
  if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
    return
  }
  if (dragOverTarget.value?.type === type && dragOverTarget.value?.id === targetId) {
    dragOverTarget.value = null
  }
}

async function onGroupDrop(g: GroupRow | { id: 'UNASSIGNED'; name: string }) {
  dragOverTarget.value = null
  const user = draggedUser.value
  draggedUser.value = null
  if (!user) return

  const targetGroupId = g.id === 'UNASSIGNED' ? null : g.id
  const isAlready = g.id === 'UNASSIGNED'
    ? (user.groupId === null || !user.groupId)
    : user.groupId === g.id

  if (isAlready) {
    say('ok', `${user.name} 님은 이미 '${g.name}' 그룹입니다.`)
    return
  }

  try {
    await api.patch(`/users/${user.id}`, { groupId: targetGroupId })
    say('ok', `"${user.name}" 님의 그룹을 "${g.name}"(으)로 이동했습니다.`)
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['groups'] })
  } catch (e) {
    fail(e)
  }
}

async function onCompanyDrop(c: PartnerCompanyRow | { id: 'SKGAS'; name: string }) {
  dragOverTarget.value = null
  const user = draggedUser.value
  draggedUser.value = null
  if (!user) return

  const isTargetSkgas = c.id === 'SKGAS'
  const isAlready = isTargetSkgas
    ? (!user.partnerCompanyId && (user.companyCode === 'SKGAS' || !user.companyCode))
    : user.partnerCompanyId === c.id

  if (isAlready) {
    say('ok', `${user.name} 님은 이미 '${c.name}' 소속입니다.`)
    return
  }

  try {
    const payload = isTargetSkgas
      ? { partnerCompanyId: null, companyCode: 'SKGAS' }
      : { partnerCompanyId: c.id as number, companyCode: (c as PartnerCompanyRow).companyCode || 'COOPERATIVE' }

    await api.patch(`/users/${user.id}`, payload)
    say('ok', `"${user.name}" 님의 소속을 "${c.name}"(으)로 이동했습니다.`)
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['partner-companies'] })
  } catch (e) {
    fail(e)
  }
}

// ── 사용자 추가 / 수정 ────────────────────────────────────────────────
const userDialog = ref<'create' | 'edit' | null>(null)
type Form = {
  id: number; loginId: string; name: string
  role: 'ADMIN' | 'VIEWER'; groupId: string | number
  employmentStatus: EmploymentStatus
  employeeNumber: string; email: string; phone: string; extensionNumber: string
  department: string; position: string; companyCode: string
  partnerCompanyId: string | number; hireDate: string
}
const EMPTY: Form = {
  id: 0, loginId: '', name: '', role: 'VIEWER', groupId: '', employmentStatus: 'ACTIVE',
  employeeNumber: '', email: '', phone: '', extensionNumber: '',
  department: '', position: '', companyCode: 'SKGAS', partnerCompanyId: '', hireDate: '',
}
const form = ref<Form>({ ...EMPTY })

function openCreate() {
  form.value = {
    ...EMPTY,
    groupId: leftTab.value === 'group' && typeof selectedGroup.value === 'number' ? selectedGroup.value : '',
    partnerCompanyId: leftTab.value === 'company' && typeof selectedCompany.value === 'number' ? selectedCompany.value : '',
    companyCode: leftTab.value === 'company' && typeof selectedCompany.value === 'number' ? 'COOPERATIVE' : 'SKGAS',
  }
  userDialog.value = 'create'
}
function openEdit(u: UserRow) {
  form.value = {
    id: u.id, loginId: u.loginId, name: u.name, role: u.role, groupId: u.groupId ?? '',
    employmentStatus: u.employmentStatus,
    employeeNumber: u.employeeNumber ?? '', email: u.email ?? '', phone: u.phone ?? '',
    extensionNumber: u.extensionNumber ?? '', department: u.department ?? '',
    position: u.position ?? '', companyCode: u.companyCode,
    partnerCompanyId: u.partnerCompanyId ?? '', hireDate: u.hireDate ?? '',
  }
  userDialog.value = 'edit'
}

// ── 표 칸 ──────────────────────────────────────────────────────────────
// render 는 **글자값**이다 — 거르기·엑셀이 이것을 쓴다. 슬롯은 그리는 법만 바꾼다.
const COLUMNS: Column<UserRow>[] = [
  { key: 'drag', label: '', width: '32px', align: 'center', sortable: false, filterable: false, exportable: false },
  { key: 'loginId', label: '아이디', width: '130px' },
  { key: 'name', label: '이름', width: '96px' },
  { key: 'employeeNumber', label: '사번', width: '88px', align: 'center', render: (u) => u.employeeNumber ?? '' },
  { key: 'department', label: '부서', width: '120px', render: (u) => u.department ?? '' },
  { key: 'position', label: '직위', width: '92px', align: 'center', render: (u) => u.position ?? '' },
  { key: 'company', label: '소속사', width: '130px',
    render: (u) => u.partnerCompanyName ?? u.companyCode },
  { key: 'extensionNumber', label: '내선', width: '126px', align: 'center', render: (u) => u.extensionNumber ?? '' },
  { key: 'phone', label: '휴대전화', width: '126px', align: 'center', render: (u) => u.phone ?? '' },
  { key: 'email', label: '이메일', width: '180px', render: (u) => u.email ?? '' },
  { key: 'role', label: '권한', width: '74px', align: 'center',
    render: (u) => (u.role === 'ADMIN' ? '관리자' : '일반') },
  { key: 'groupName', label: '그룹', width: '110px', align: 'center', render: (u) => u.groupName ?? '' },
  { key: 'employmentStatus', label: '상태', width: '110px',
    // 엑셀에도 "초기비번"이 함께 나가야 화면과 같은 뜻이 된다
    render: (u) => [statusLabel(u.employmentStatus), u.mustChangePassword ? '초기비번' : '']
      .filter(Boolean).join(' ') },
  { key: 'hireDate', label: '입사일', width: '100px', align: 'center', render: (u) => u.hireDate ?? '' },
  { key: 'lastLoginAt', label: '접속일', width: '100px', align: 'center',
    render: (u) => u.lastLoginAt?.slice(0, 10) ?? '' },
  { key: 'act', label: '조치', width: '152px', align: 'center', sortable: false, filterable: false, render: () => '' },
]

/** 빈 칸은 null 로 보낸다 — ''를 저장하면 "값이 있는데 비어 있는" 칸이 생긴다. */
const n = (v: string) => (v.trim() === '' ? null : v.trim())

async function submitUser() {
  const mode = userDialog.value
  const f = form.value
  userDialog.value = null
  try {
    const profile = {
      employeeNumber: n(f.employeeNumber), email: n(f.email), phone: n(f.phone),
      extensionNumber: n(f.extensionNumber), department: n(f.department),
      position: n(f.position), companyCode: f.companyCode.trim() || 'SKGAS',
      partnerCompanyId: f.partnerCompanyId === '' ? null : Number(f.partnerCompanyId),
      hireDate: n(f.hireDate),
    }
    const groupId = f.groupId === '' ? null : Number(f.groupId)
    if (mode === 'create') {
      await api.post('/users', { loginId: f.loginId, name: f.name, role: f.role, groupId, ...profile })
      say('ok', `"${f.loginId}" 계정을 만들었습니다. 초기 비밀번호는 ghub${f.loginId} 입니다.`)
    } else {
      await api.patch(`/users/${f.id}`, {
        name: f.name, role: f.role, groupId, employmentStatus: f.employmentStatus, ...profile,
      })
      say('ok', '계정을 수정했습니다.')
    }
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['partner-companies'] })
  } catch (e) { fail(e) }
}

const resetTarget = ref<UserRow | null>(null)
async function confirmReset() {
  const u = resetTarget.value
  resetTarget.value = null
  if (!u) return
  try {
    const r = await api.post<{ rule: string }>(`/users/${u.id}/reset-password`)
    say('ok', `"${u.loginId}" 의 비밀번호를 초기화했습니다. ${r.rule}`)
    void qc.invalidateQueries({ queryKey: ['users'] })
  } catch (e) { fail(e) }
}

// ── 그룹 관리 (추가 / 편집 / 삭제) ──────────────────────────────────
const groupDialog = ref<'create' | 'edit' | null>(null)
interface GroupFormState {
  id: number
  name: string
  description: string
}
const groupForm = ref<GroupFormState>({ id: 0, name: '', description: '' })
const isGroupSubmitting = ref(false)

function openGroupCreate() {
  groupForm.value = { id: 0, name: '', description: '' }
  groupDialog.value = 'create'
}

function openGroupEdit(g: GroupRow) {
  groupForm.value = { id: g.id, name: g.name, description: g.description ?? '' }
  groupDialog.value = 'edit'
}

async function submitGroup() {
  const name = groupForm.value.name.trim()
  if (!name) return
  const description = groupForm.value.description.trim() || null
  const mode = groupDialog.value
  isGroupSubmitting.value = true
  try {
    if (mode === 'create') {
      const res = await api.post<{ id: number }>('/groups', { name, description })
      say('ok', `"${name}" 그룹을 추가했습니다.`)
      selectedGroup.value = res.id
    } else if (mode === 'edit') {
      await api.patch(`/groups/${groupForm.value.id}`, { name, description })
      say('ok', `"${name}" 그룹을 수정했습니다.`)
    }
    groupDialog.value = null
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['users'] })
  } catch (e) {
    fail(e)
  } finally {
    isGroupSubmitting.value = false
  }
}

const deleteGroupTarget = ref<GroupRow | null>(null)
const isDeletingGroup = ref(false)
const deleteGroupMemberCount = computed(() => {
  if (!deleteGroupTarget.value) return 0
  return memberCountMap.value.get(deleteGroupTarget.value.id) ?? deleteGroupTarget.value.memberCount ?? 0
})

function openGroupDelete(g: GroupRow) {
  deleteGroupTarget.value = g
}

async function confirmDeleteGroup() {
  const g = deleteGroupTarget.value
  if (!g) return
  isDeletingGroup.value = true
  try {
    await api.delete(`/groups/${g.id}`)
    say('ok', `"${g.name}" 그룹을 삭제했습니다.`)
    if (selectedGroup.value === g.id) {
      selectedGroup.value = 'ALL'
    }
    deleteGroupTarget.value = null
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['users'] })
  } catch (e) {
    fail(e)
  } finally {
    isDeletingGroup.value = false
  }
}

// ── 소속사 관리 (추가 / 편집 / 삭제) ────────────────────────────────
const partnerDialog = ref<'create' | 'edit' | null>(null)
interface PartnerFormState {
  id: number
  name: string
  companyCode: string
  representative: string
  businessType: string
}
const partnerForm = ref<PartnerFormState>({ id: 0, name: '', companyCode: '', representative: '', businessType: '' })
const isPartnerSubmitting = ref(false)

function openPartnerCreate() {
  partnerForm.value = { id: 0, name: '', companyCode: '', representative: '', businessType: '' }
  partnerDialog.value = 'create'
}

function openPartnerEdit(p: PartnerCompanyRow) {
  partnerForm.value = {
    id: p.id,
    name: p.name,
    companyCode: p.companyCode ?? '',
    representative: p.representative ?? '',
    businessType: p.businessType ?? '',
  }
  partnerDialog.value = 'edit'
}

async function submitPartner() {
  const name = partnerForm.value.name.trim()
  if (!name) return
  const companyCode = partnerForm.value.companyCode.trim() || null
  const representative = partnerForm.value.representative.trim() || null
  const businessType = partnerForm.value.businessType.trim() || null
  const mode = partnerDialog.value
  isPartnerSubmitting.value = true
  try {
    if (mode === 'create') {
      const res = await api.post<{ id: number }>('/partner-companies', {
        name, companyCode, representative, businessType,
      })
      say('ok', `"${name}" 소속사를 추가했습니다.`)
      selectedCompany.value = res.id
    } else if (mode === 'edit') {
      await api.patch(`/partner-companies/${partnerForm.value.id}`, {
        name, companyCode, representative, businessType,
      })
      say('ok', `"${name}" 소속사를 수정했습니다.`)
    }
    partnerDialog.value = null
    void qc.invalidateQueries({ queryKey: ['partner-companies'] })
    void qc.invalidateQueries({ queryKey: ['users'] })
  } catch (e) {
    fail(e)
  } finally {
    isPartnerSubmitting.value = false
  }
}

const deletePartnerTarget = ref<PartnerCompanyRow | null>(null)
const isDeletingPartner = ref(false)
const deletePartnerMemberCount = computed(() => {
  if (!deletePartnerTarget.value) return 0
  return partnerMemberCountMap.value.get(deletePartnerTarget.value.id) ?? deletePartnerTarget.value.memberCount ?? 0
})

function openPartnerDelete(p: PartnerCompanyRow) {
  deletePartnerTarget.value = p
}

async function confirmDeletePartner() {
  const p = deletePartnerTarget.value
  if (!p) return
  isDeletingPartner.value = true
  try {
    await api.delete(`/partner-companies/${p.id}`)
    say('ok', `"${p.name}" 소속사를 삭제했습니다.`)
    if (selectedCompany.value === p.id) {
      selectedCompany.value = 'ALL'
    }
    deletePartnerTarget.value = null
    void qc.invalidateQueries({ queryKey: ['partner-companies'] })
    void qc.invalidateQueries({ queryKey: ['users'] })
  } catch (e) {
    fail(e)
  } finally {
    isDeletingPartner.value = false
  }
}
</script>

<template>
  <main class="app-main users">
    <div class="panel head">
      <h1>사용자 관리</h1>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <!-- 드래그 안내 배너 -->
    <div v-if="draggedUser" class="panel drag-banner">
      <span class="drag-banner-icon">🎯</span>
      <span>
        <strong>{{ draggedUser.name }}</strong> ({{ draggedUser.loginId }}) 님을
        왼쪽의 원하는 <strong>{{ leftTab === 'group' ? '그룹' : '소속' }}</strong>으로 끌어다 놓으세요.
        (상단 탭으로 마우스를 가져가면 탭이 전환됩니다)
      </span>
    </div>

    <div class="split">
      <!-- 왼쪽 패널 (그룹 / 소속 탭) -->
      <aside class="panel glist-panel">
        <!-- 탭 전환 헤더 -->
        <div class="glist-tabs" role="tablist">
          <button
            type="button"
            class="glist-tab"
            :class="{ on: leftTab === 'group', 'tab-drag-hover': dragOverTab === 'group' }"
            @click="leftTab = 'group'"
            @dragover.prevent="onTabDragOver('group')"
            @dragleave="dragOverTab = null"
          >
            그룹
            <span class="tab-badge">{{ groups?.items.length ?? 0 }}</span>
          </button>
          <button
            type="button"
            class="glist-tab"
            :class="{ on: leftTab === 'company', 'tab-drag-hover': dragOverTab === 'company' }"
            @click="leftTab = 'company'"
            @dragover.prevent="onTabDragOver('company')"
            @dragleave="dragOverTab = null"
          >
            소속
            <span class="tab-badge">{{ 1 + (partners?.items.length ?? 0) }}</span>
          </button>
        </div>

        <!-- 탭 1: 그룹 탭 -->
        <template v-if="leftTab === 'group'">
          <div class="panel-head glist-head">
            <div class="glist-title">
              <span>그룹 목록</span>
              <span class="muted sub-count">({{ (groups?.items.length ?? 0) }})</span>
            </div>
            <button
              type="button"
              class="btn btn-xs btn-add-group"
              title="새 그룹 추가"
              @click="openGroupCreate"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>그룹 추가</span>
            </button>
          </div>
          <div v-if="(groups?.items.length ?? 0) > 6" class="glist-search">
            <input v-model="groupSearch" type="text" placeholder="그룹 검색" />
          </div>
          <div class="glist">
            <!-- 전체 -->
            <div
              class="grow" :class="{ sel: selectedGroup === 'ALL' }"
              @click="selectedGroup = 'ALL'"
            >
              <div class="g-info">
                <span class="g-name">전체</span>
                <span class="badge">{{ users?.items.length ?? 0 }}</span>
              </div>
              <div class="muted sub">전체 사용자</div>
            </div>

            <!-- 각 그룹 (드롭 대상) -->
            <div
              v-for="g in filteredGroups" :key="g.id"
              class="grow group-drop-zone"
              :class="{
                sel: selectedGroup === g.id,
                'drop-active': isDragOver('group', g.id),
                'drop-disabled': isDropDisabledForGroup(g.id),
              }"
              @click="selectedGroup = g.id"
              @dragover.prevent="onGroupDragOver($event, g)"
              @dragleave="onDragLeave($event, 'group', g.id)"
              @drop.prevent="onGroupDrop(g)"
            >
              <div class="g-info">
                <span class="g-name" :title="g.name">{{ g.name }}</span>
                <div class="g-right">
                  <span class="badge">{{ memberCountMap.get(g.id) ?? g.memberCount ?? 0 }}</span>
                  <div class="g-actions" @click.stop>
                    <button
                      type="button"
                      class="g-btn-icon edit-btn"
                      title="그룹 수정"
                      aria-label="그룹 수정"
                      @click="openGroupEdit(g)"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                        <path d="m15 5 4 4"/>
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="g-btn-icon delete-btn"
                      title="그룹 삭제"
                      aria-label="그룹 삭제"
                      @click="openGroupDelete(g)"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 6h18"/>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        <line x1="10" x2="10" y1="11" y2="17"/>
                        <line x1="14" x2="14" y1="11" y2="17"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="g.description" class="muted sub" :title="g.description">{{ g.description }}</div>
            </div>

            <!-- 미소속 사용자 (드롭 대상: groupId -> null) -->
            <div
              v-if="!groupSearch"
              class="grow group-drop-zone"
              :class="{
                sel: selectedGroup === 'UNASSIGNED',
                'drop-active': isDragOver('group', 'UNASSIGNED'),
                'drop-disabled': isDropDisabledForGroup('UNASSIGNED'),
              }"
              @click="selectedGroup = 'UNASSIGNED'"
              @dragover.prevent="onGroupDragOver($event, { id: 'UNASSIGNED', name: '미소속' })"
              @dragleave="onDragLeave($event, 'group', 'UNASSIGNED')"
              @drop.prevent="onGroupDrop({ id: 'UNASSIGNED', name: '미소속' })"
            >
              <div class="g-info">
                <span class="g-name">미소속</span>
                <span class="badge">{{ unassignedCount }}</span>
              </div>
              <div class="muted sub">그룹 없는 사용자</div>
            </div>
          </div>
        </template>

        <!-- 탭 2: 소속 탭 -->
        <template v-else>
          <div class="panel-head glist-head">
            <div class="glist-title">
              <span>소속 목록</span>
              <span class="muted sub-count">({{ 1 + (partners?.items.length ?? 0) }})</span>
            </div>
            <button
              type="button"
              class="btn btn-xs btn-add-group"
              title="새 협력업체/소속사 추가"
              @click="openPartnerCreate"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>소속 추가</span>
            </button>
          </div>
          <div v-if="(partners?.items.length ?? 0) > 5" class="glist-search">
            <input v-model="companySearch" type="text" placeholder="소속사 검색" />
          </div>
          <div class="glist">
            <!-- 전체 -->
            <div
              class="grow" :class="{ sel: selectedCompany === 'ALL' }"
              @click="selectedCompany = 'ALL'"
            >
              <div class="g-info">
                <span class="g-name">전체</span>
                <span class="badge">{{ users?.items.length ?? 0 }}</span>
              </div>
              <div class="muted sub">전체 사용자</div>
            </div>

            <!-- 본사: SK가스 (드롭 대상: partnerCompanyId -> null, companyCode -> SKGAS) -->
            <div
              v-if="!companySearch || 'sk가스'.includes(companySearch.toLowerCase()) || 'skgas'.includes(companySearch.toLowerCase())"
              class="grow group-drop-zone"
              :class="{
                sel: selectedCompany === 'SKGAS',
                'drop-active': isDragOver('company', 'SKGAS'),
                'drop-disabled': isDropDisabledForCompany('SKGAS'),
              }"
              @click="selectedCompany = 'SKGAS'"
              @dragover.prevent="onCompanyDragOver($event, { id: 'SKGAS', name: 'SK가스' })"
              @dragleave="onDragLeave($event, 'company', 'SKGAS')"
              @drop.prevent="onCompanyDrop({ id: 'SKGAS', name: 'SK가스' })"
            >
              <div class="g-info">
                <span class="g-name">SK가스</span>
                <span class="badge">{{ skgasMemberCount }}</span>
              </div>
              <div class="muted sub">본사 소속 (협력업체 제외)</div>
            </div>

            <!-- 각 협력업체 / 소속사 (드롭 대상: partnerCompanyId -> p.id, companyCode -> COOPERATIVE) -->
            <div
              v-for="p in filteredCompanies" :key="p.id"
              class="grow group-drop-zone"
              :class="{
                sel: selectedCompany === p.id,
                'drop-active': isDragOver('company', p.id),
                'drop-disabled': isDropDisabledForCompany(p.id),
              }"
              @click="selectedCompany = p.id"
              @dragover.prevent="onCompanyDragOver($event, p)"
              @dragleave="onDragLeave($event, 'company', p.id)"
              @drop.prevent="onCompanyDrop(p)"
            >
              <div class="g-info">
                <span class="g-name" :title="p.name">{{ p.name }}</span>
                <div class="g-right">
                  <span class="badge">{{ partnerMemberCountMap.get(p.id) ?? p.memberCount ?? 0 }}</span>
                  <div class="g-actions" @click.stop>
                    <button
                      type="button"
                      class="g-btn-icon edit-btn"
                      title="소속사 수정"
                      aria-label="소속사 수정"
                      @click="openPartnerEdit(p)"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                        <path d="m15 5 4 4"/>
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="g-btn-icon delete-btn"
                      title="소속사 삭제"
                      aria-label="소속사 삭제"
                      @click="openPartnerDelete(p)"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 6h18"/>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        <line x1="10" x2="10" y1="11" y2="17"/>
                        <line x1="14" x2="14" y1="11" y2="17"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
              <div class="muted sub" :title="p.companyCode ?? ''">
                {{ [p.companyCode, p.representative ? `대표: ${p.representative}` : ''].filter(Boolean).join(' · ') || '협력업체' }}
              </div>
            </div>
          </div>
        </template>
      </aside>

      <!-- 오른쪽 사용자 목록 그리드 -->
      <section class="panel users-panel">
        <div class="pad users-inner">
          <div class="bar">
            <!-- 활성화된 그룹/소속 필터 배지 -->
            <span v-if="activeFilterBadge" class="group-filter-badge">
              {{ activeFilterBadge.label }}: <strong>{{ activeFilterBadge.name }}</strong>
              <button type="button" class="btn-clear-group" title="전체 보기" @click="clearActiveFilter">×</button>
            </span>

            <input v-model="keyword" type="text" placeholder="아이디·이름·사번·부서·연락처·소속사" style="width:240px" />
            <select v-model="dept" style="width:140px">
              <option value="">부서 전체</option>
              <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
            </select>
            <span class="seg">
              <button
                v-for="st in STATUS" :key="st.key" type="button"
                class="btn btn-sm" :class="{ on: shown.has(st.key) }"
                @click="toggleStatus(st.key)"
              >{{ st.label }}</button>
            </span>
            <span style="flex:1" />
            <button class="btn btn-sm btn-primary" @click="openCreate">사용자 추가</button>
          </div>

          <div class="tablewrap">
            <DataTable
              :columns="COLUMNS" :rows="rows" :total="rows.length"
              :row-class="(u) => [u.isActive ? '' : 'off', draggedUser?.id === u.id ? 'dragging' : ''].filter(Boolean).join(' ')"
              :draggable-rows="true"
              storage-key="users" excel-name="사용자 목록"
              empty-text="조건에 맞는 사용자가 없습니다."
              @row-click="openEdit"
              @row-dragstart="onRowDragStart"
              @row-dragend="onRowDragEnd"
            >
              <template #cell:drag>
                <span class="row-drag-handle" title="드래그하여 그룹/소속 변경" aria-hidden="true">
                  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                    <circle cx="2.5" cy="2" r="1.5" />
                    <circle cx="7.5" cy="2" r="1.5" />
                    <circle cx="2.5" cy="7" r="1.5" />
                    <circle cx="7.5" cy="7" r="1.5" />
                    <circle cx="2.5" cy="12" r="1.5" />
                    <circle cx="7.5" cy="12" r="1.5" />
                  </svg>
                </span>
              </template>

              <template #cell:company="{ row }">
                <span v-if="row.partnerCompanyName" class="tag tag-info">{{ row.partnerCompanyName }}</span>
                <span v-else class="muted">{{ row.companyCode }}</span>
              </template>

              <template #cell:role="{ row }">
                <span :class="{ tag: row.role === 'ADMIN' }">{{ row.role === 'ADMIN' ? '관리자' : '일반' }}</span>
              </template>

              <template #cell:employmentStatus="{ row }">
                <span class="tag" :class="STATUS.find(x => x.key === row.employmentStatus)?.cls">
                  {{ statusLabel(row.employmentStatus) }}
                </span>
                <span v-if="row.mustChangePassword" class="tag warn-tag"
                      title="첫 로그인 때 변경 화면이 열립니다">초기비번</span>
              </template>

              <template #cell:lastLoginAt="{ row }">
                <span :title="row.previousLoginAt ? `직전 ${row.previousLoginAt.slice(0, 10)}` : ''">
                  {{ row.lastLoginAt?.slice(0, 10) ?? '-' }}
                </span>
              </template>

              <template #cell:act="{ row }">
                <button class="btn btn-sm" @click.stop="openEdit(row)">수정</button>
                <button class="btn btn-sm" @click.stop="resetTarget = row">비번 초기화</button>
              </template>
            </DataTable>
          </div>
        </div>
      </section>
    </div>

    <!-- 사용자 추가·수정 모달 -->
    <Modal v-if="userDialog" :title="userDialog === 'create' ? '사용자 추가' : '사용자 수정'"
           @close="userDialog = null">
      <table class="form">
        <tbody>
          <tr>
            <th>아이디</th>
            <td>
              <input v-model="form.loginId" type="text" :disabled="userDialog === 'edit'" style="width:100%" />
              <div v-if="userDialog === 'create'" class="muted sub">
                초기 비밀번호는 <strong>ghub{{ form.loginId || '아이디' }}</strong> 입니다.
                첫 로그인 때 변경 화면이 열립니다(미루기 가능).
              </div>
            </td>
          </tr>
          <tr><th>이름</th><td><input v-model="form.name" type="text" style="width:100%" /></td></tr>
          <tr>
            <th>권한</th>
            <td>
              <label class="r"><input v-model="form.role" type="radio" value="VIEWER" /> 일반</label>
              <label class="r"><input v-model="form.role" type="radio" value="ADMIN" /> 관리자</label>
              <div class="muted sub">관리자는 권한 트리와 무관하게 전부 통과합니다.</div>
            </td>
          </tr>
          <tr>
            <th>그룹</th>
            <td>
              <select v-model="form.groupId" style="width:100%">
                <option value="">그룹 없음</option>
                <option v-for="g in groups?.items ?? []" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
            </td>
          </tr>
          <tr v-if="userDialog === 'edit'">
            <th>재직 상태</th>
            <td>
              <label v-for="st in STATUS" :key="st.key" class="r">
                <input v-model="form.employmentStatus" type="radio" :value="st.key" /> {{ st.label }}
              </label>
              <div class="muted sub">
                퇴직·삭제로 바꾸면 로그인이 막히고 열려 있던 세션도 끊깁니다.
                계정과 기록은 지우지 않습니다.
              </div>
            </td>
          </tr>

          <tr><th colspan="2" class="sect">신원 · 조직</th></tr>
          <tr>
            <th>사번</th>
            <td class="two">
              <input v-model="form.employeeNumber" type="text" placeholder="0038" />
              <label>입사일 <input v-model="form.hireDate" type="date" /></label>
            </td>
          </tr>
          <tr>
            <th>부서 / 직위</th>
            <td class="two">
              <input v-model="form.department" type="text" placeholder="설비기술팀" />
              <input v-model="form.position" type="text" placeholder="과장" />
            </td>
          </tr>
          <tr>
            <th>소속</th>
            <td class="two">
              <input v-model="form.companyCode" type="text" placeholder="SKGAS" />
              <select v-model="form.partnerCompanyId">
                <option value="">협력업체 아님</option>
                <option v-for="c in partners?.items ?? []" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </td>
          </tr>

          <tr><th colspan="2" class="sect">연락처</th></tr>
          <tr>
            <th>전화</th>
            <td class="two">
              <input v-model="form.extensionNumber" type="text" placeholder="내선 052-916-2016" />
              <input v-model="form.phone" type="text" placeholder="휴대전화 010-0000-0000" />
            </td>
          </tr>
          <tr>
            <th>이메일</th>
            <td><input v-model="form.email" type="text" placeholder="name@skgas.kr" style="width:100%" /></td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <button class="btn" @click="userDialog = null">취소</button>
        <button class="btn btn-primary" :disabled="!form.loginId || !form.name" @click="submitUser">확인</button>
      </template>
    </Modal>

    <Modal v-if="resetTarget" title="비밀번호 초기화" @close="resetTarget = null">
      <p>
        <strong>{{ resetTarget.loginId }}</strong> 의 비밀번호를
        <strong>ghub{{ resetTarget.loginId }}</strong> 로 되돌립니다.
      </p>
      <p class="muted">그 사람의 모든 로그인이 끊기고, 다음 로그인 때 변경 화면이 열립니다.</p>
      <template #footer>
        <button class="btn" @click="resetTarget = null">취소</button>
        <button class="btn btn-primary" @click="confirmReset">초기화</button>
      </template>
    </Modal>

    <!-- 그룹 추가 / 수정 모달 -->
    <Modal
      v-if="groupDialog"
      :title="groupDialog === 'create' ? '그룹 추가' : '그룹 수정'"
      @close="groupDialog = null"
    >
      <table class="form">
        <tbody>
          <tr>
            <th>그룹명 <span class="req">*</span></th>
            <td>
              <input
                v-model="groupForm.name"
                type="text"
                placeholder="예: 설계기술팀, 안전환경팀"
                style="width: 100%"
                maxlength="100"
                autofocus
                @keyup.enter="submitGroup"
              />
            </td>
          </tr>
          <tr>
            <th>설명</th>
            <td>
              <textarea
                v-model="groupForm.description"
                rows="3"
                placeholder="그룹에 대한 설명 (선택)"
                style="width: 100%; resize: vertical;"
                maxlength="500"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <button class="btn" @click="groupDialog = null">취소</button>
        <button
          class="btn btn-primary"
          :disabled="!groupForm.name.trim() || isGroupSubmitting"
          @click="submitGroup"
        >
          {{ isGroupSubmitting ? '저장 중...' : (groupDialog === 'create' ? '추가' : '수정') }}
        </button>
      </template>
    </Modal>

    <!-- 그룹 삭제 확인 모달 -->
    <Modal
      v-if="deleteGroupTarget"
      title="그룹 삭제 확인"
      @close="deleteGroupTarget = null"
    >
      <div class="delete-confirm-box">
        <p>
          <strong>"{{ deleteGroupTarget.name }}"</strong> 그룹을 삭제하시겠습니까?
        </p>
        <div v-if="deleteGroupMemberCount > 0" class="warn-notice">
          ⚠️ 현재 이 그룹에 소속된 사용자가 <strong>{{ deleteGroupMemberCount }}명</strong> 있습니다.<br />
          그룹을 삭제하면 해당 사용자들의 그룹 소속이 <strong>[그룹 없음]</strong>(미소속)으로 자동 변경됩니다.
        </div>
        <p class="muted sub-hint">
          그룹에 부여된 권한 정보도 함께 삭제되며, 삭제 후에는 복구할 수 없습니다.
        </p>
      </div>
      <template #footer>
        <button class="btn" @click="deleteGroupTarget = null">취소</button>
        <button
          class="btn btn-danger"
          :disabled="isDeletingGroup"
          @click="confirmDeleteGroup"
        >
          {{ isDeletingGroup ? '삭제 중...' : '그룹 삭제' }}
        </button>
      </template>
    </Modal>

    <!-- 소속사 추가 / 수정 모달 -->
    <Modal
      v-if="partnerDialog"
      :title="partnerDialog === 'create' ? '소속사 추가' : '소속사 수정'"
      @close="partnerDialog = null"
    >
      <table class="form">
        <tbody>
          <tr>
            <th>업체명 <span class="req">*</span></th>
            <td>
              <input
                v-model="partnerForm.name"
                type="text"
                placeholder="예: 진네트웍스, 신우인더스트리"
                style="width: 100%"
                maxlength="100"
                autofocus
                @keyup.enter="submitPartner"
              />
            </td>
          </tr>
          <tr>
            <th>사업자번호/코드</th>
            <td>
              <input
                v-model="partnerForm.companyCode"
                type="text"
                placeholder="예: 120-81-55152"
                style="width: 100%"
                maxlength="40"
              />
            </td>
          </tr>
          <tr>
            <th>대표자</th>
            <td>
              <input
                v-model="partnerForm.representative"
                type="text"
                placeholder="대표자 이름 (선택)"
                style="width: 100%"
                maxlength="100"
              />
            </td>
          </tr>
          <tr>
            <th>업종 / 업태</th>
            <td>
              <input
                v-model="partnerForm.businessType"
                type="text"
                placeholder="예: 도면설계, 유지보수 (선택)"
                style="width: 100%"
                maxlength="100"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <button class="btn" @click="partnerDialog = null">취소</button>
        <button
          class="btn btn-primary"
          :disabled="!partnerForm.name.trim() || isPartnerSubmitting"
          @click="submitPartner"
        >
          {{ isPartnerSubmitting ? '저장 중...' : (partnerDialog === 'create' ? '추가' : '수정') }}
        </button>
      </template>
    </Modal>

    <!-- 소속사 삭제 확인 모달 -->
    <Modal
      v-if="deletePartnerTarget"
      title="소속사 삭제 확인"
      @close="deletePartnerTarget = null"
    >
      <div class="delete-confirm-box">
        <p>
          <strong>"{{ deletePartnerTarget.name }}"</strong> 소속사를 삭제하시겠습니까?
        </p>
        <div v-if="deletePartnerMemberCount > 0" class="warn-notice">
          ⚠️ 현재 이 소속사에 소속된 사용자가 <strong>{{ deletePartnerMemberCount }}명</strong> 있습니다.<br />
          소속사를 삭제하면 해당 사용자들의 협력업체 소속 지정이 해제됩니다.
        </div>
        <p class="muted sub-hint">
          삭제 후에는 복구할 수 없습니다.
        </p>
      </div>
      <template #footer>
        <button class="btn" @click="deletePartnerTarget = null">취소</button>
        <button
          class="btn btn-danger"
          :disabled="isDeletingPartner"
          @click="confirmDeletePartner"
        >
          {{ isDeletingPartner ? '삭제 중...' : '소속사 삭제' }}
        </button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
.users { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.msg { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; flex: 0 0 auto; }

/* 드래그 안내 배너 */
.drag-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--primary-soft);
  border-left: 4px solid var(--primary);
  font-size: var(--fs-sm);
  color: var(--primary);
  flex: 0 0 auto;
}
.drag-banner-icon {
  font-size: 16px;
}

.split { flex: 1; display: flex; gap: var(--gap); min-height: 0; }

/* 왼쪽 패널 */
.glist-panel {
  width: 270px;
  min-width: 270px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 탭 헤더 */
.glist-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex: 0 0 auto;
}
.glist-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 8px;
  font-size: var(--fs);
  font-weight: 500;
  color: var(--fg-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}
.glist-tab:hover {
  color: var(--fg);
  background: var(--surface);
}
.glist-tab.on {
  color: var(--primary);
  font-weight: 600;
  background: var(--surface);
  border-bottom-color: var(--primary);
}
.glist-tab.tab-drag-hover {
  background: var(--primary-soft);
  border-bottom-color: var(--primary);
}
.tab-badge {
  font-size: var(--fs-xs);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--fg-muted);
}
.glist-tab.on .tab-badge {
  background: var(--primary-soft);
  color: var(--primary);
  border-color: var(--primary-line);
}

.glist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
}
.glist-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
}
.sub-count {
  font-size: var(--fs-sm);
  font-weight: normal;
}
.btn-add-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--primary);
  background: var(--primary-soft);
  border: 1px solid var(--primary-line);
  border-radius: var(--r-sm, 4px);
  cursor: pointer;
  line-height: 1.4;
  transition: all 0.15s ease;
}
.btn-add-group:hover {
  background: var(--primary);
  color: #fff;
}
.glist-search {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.glist-search input {
  width: 100%;
}
.glist {
  flex: 1;
  overflow-y: auto;
}
.grow {
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid transparent;
  transition: background-color 0.1s ease, border-color 0.1s ease, outline 0.1s ease;
}
.grow:hover {
  background: var(--surface-2);
}
.grow.sel {
  background: var(--primary-soft);
  border-left-color: var(--primary);
}

/* 드롭 존 스타일 */
.group-drop-zone * {
  pointer-events: none;
}
.group-drop-zone .g-actions,
.group-drop-zone .g-actions * {
  pointer-events: auto;
}
.group-drop-zone.drop-active {
  background: var(--primary-soft) !important;
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
}
.group-drop-zone.drop-disabled {
  opacity: 0.6;
}

.g-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.g-name {
  font-weight: 600;
  font-size: var(--fs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.grow.sel .g-name {
  color: var(--primary);
}
.g-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.g-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.grow:hover .g-actions,
.grow.sel .g-actions {
  opacity: 1;
}
.g-btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm, 4px);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.g-btn-icon:hover {
  background: var(--surface);
  border-color: var(--border);
}
.g-btn-icon.edit-btn:hover {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: var(--primary-line);
}
.g-btn-icon.delete-btn:hover {
  color: var(--danger, #be123c);
  background: #fee2e2;
  border-color: #fca5a5;
}
.badge {
  font-size: var(--fs-xs);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--border);
}
.grow.sel .badge {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.sub {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 오른쪽 사용자 목록 패널 */
.users-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.users-inner {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.pad { padding: 14px; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; margin-bottom: 2px; flex-wrap: wrap; }
.group-filter-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--control-h);
  padding: 0 10px;
  background: var(--primary-soft);
  color: var(--primary);
  border: 1px solid var(--primary-line);
  border-radius: var(--r);
  font-size: var(--fs-sm);
}
.btn-clear-group {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.btn-clear-group:hover {
  opacity: 0.7;
}

.tablewrap { flex: 1; min-height: 420px; display: flex; }
.tablewrap > * { flex: 1; min-width: 0; }

/* 행 드래그 핸들 */
.row-drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  cursor: grab;
  opacity: 0.6;
  transition: opacity 0.15s ease, color 0.15s ease;
}
:deep(.dt-row:hover) .row-drag-handle {
  opacity: 1;
  color: var(--primary);
}

@media (max-width: 900px) {
  .split { flex-direction: column; }
  .glist-panel { width: auto; min-width: 0; max-height: 260px; flex: 0 0 auto; }
  .users-panel { min-height: 400px; }
}

/* 재직/퇴직/삭제 세 칸 */
.seg { display: inline-flex; }
.seg .btn { border-radius: 0; margin-left: -1px; }
.seg .btn:first-child { border-radius: var(--r) 0 0 var(--r); margin-left: 0; }
.seg .btn:last-child  { border-radius: 0 var(--r) var(--r) 0; }
.seg .btn.on { background: var(--primary-soft); border-color: var(--primary-line); color: var(--primary); font-weight: 600; }

.tag {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--accent); color: var(--primary-fg);
}
.tag.warn-tag { background: var(--warn); margin-left: 4px; }
.tag.tag-info { background: var(--primary-soft); color: var(--primary); border: 1px solid var(--primary-line); }

/* 폼 모달 */
.form th, .form td { padding: 6px 8px; text-align: left; vertical-align: top; }
.form th { width: 70px; font-weight: 600; white-space: nowrap; }
.form .sect {
  text-align: left; padding-top: var(--sp-4);
  color: var(--fg-muted); font-size: var(--fs-sm); font-weight: 600;
}
.form td.two { display: flex; gap: var(--sp-2); }
.form td.two > * { flex: 1; min-width: 0; }
.form td.two label { display: flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--fg-muted); }
.r { margin-right: 12px; }

/* 그룹/소속 삭제 및 경고 */
.delete-confirm-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.warn-notice {
  padding: 10px 12px;
  border-radius: var(--r-sm, 4px);
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.sub-hint {
  font-size: var(--fs-xs);
  margin-top: 4px;
}
.req {
  color: var(--danger, #ef4444);
  font-size: 12px;
}
.btn-danger {
  background: var(--danger, #ef4444);
  color: #fff;
  border-color: var(--danger, #ef4444);
}
.btn-danger:hover {
  background: #dc2626;
  border-color: #dc2626;
}
</style>
