import { describe, expect, it } from 'vitest'

interface MockUser {
  id: number
  name: string
  loginId: string
  groupId: number | null
  employmentStatus: 'ACTIVE' | 'RETIRED'
}

function filterGroupUsers(
  users: MockUser[],
  pickedGroup: number | string | null,
  memberFilter: string = '',
) {
  if (pickedGroup === null) return []
  const active = users.filter((u) => u.employmentStatus === 'ACTIVE')
  const matched = pickedGroup === 'unassigned'
    ? active.filter((u) => u.groupId === null || !u.groupId)
    : active.filter((u) => u.groupId === pickedGroup)

  const q = memberFilter.trim().toLowerCase()
  if (!q) return matched
  return matched.filter(
    (u) => u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q),
  )
}

function resolveDropTarget(
  targetGroup: { id: number | string; isUnassigned?: boolean },
  currentUser: MockUser,
) {
  const targetGroupId = targetGroup.isUnassigned ? null : (targetGroup.id as number)
  const isAlreadyInGroup = targetGroup.isUnassigned
    ? (currentUser.groupId === null || !currentUser.groupId)
    : currentUser.groupId === targetGroup.id

  return { targetGroupId, isAlreadyInGroup }
}

describe('접속권한 관리 - 그룹 사용자 탭 및 소속 이동 로직', () => {
  const mockUsers: MockUser[] = [
    { id: 1, name: '홍길동', loginId: 'gdhong', groupId: 10, employmentStatus: 'ACTIVE' },
    { id: 2, name: '이순신', loginId: 'sslee', groupId: 10, employmentStatus: 'ACTIVE' },
    { id: 3, name: '강감찬', loginId: 'gckang', groupId: 20, employmentStatus: 'ACTIVE' },
    { id: 4, name: '김유신', loginId: 'yskim', groupId: null, employmentStatus: 'ACTIVE' },
    { id: 5, name: '퇴직자', loginId: 'retired', groupId: 10, employmentStatus: 'RETIRED' },
    { id: 6, name: '미소속퇴직자', loginId: 'unassigned_ret', groupId: null, employmentStatus: 'RETIRED' },
  ]

  it('일반 그룹 선택 시 해당 그룹의 재직 사용자만 추출된다', () => {
    const list = filterGroupUsers(mockUsers, 10)
    expect(list.map((u) => u.name)).toEqual(['홍길동', '이순신'])
  })

  it('미소속사용자그룹 선택 시 groupId가 없는 재직 사용자만 추출된다', () => {
    const list = filterGroupUsers(mockUsers, 'unassigned')
    expect(list.map((u) => u.name)).toEqual(['김유신'])
  })

  it('그룹 사용자 검색 필터가 정상 동작한다', () => {
    const list = filterGroupUsers(mockUsers, 10, 'sslee')
    expect(list.map((u) => u.name)).toEqual(['이순신'])
  })

  it('드래그 드롭 대상이 동일 그룹인 경우 이동이 스킵된다', () => {
    const userInGroup10 = mockUsers[0]!
    const targetGroup = { id: 10, isUnassigned: false }
    const { isAlreadyInGroup } = resolveDropTarget(targetGroup, userInGroup10)
    expect(isAlreadyInGroup).toBe(true)
  })

  it('일반 그룹 사용자를 다른 그룹으로 드롭하면 대상 그룹 ID가 설정된다', () => {
    const userInGroup10 = mockUsers[0]!
    const targetGroup = { id: 20, isUnassigned: false }
    const { targetGroupId, isAlreadyInGroup } = resolveDropTarget(targetGroup, userInGroup10)
    expect(isAlreadyInGroup).toBe(false)
    expect(targetGroupId).toBe(20)
  })

  it('미소속사용자그룹으로 드롭하면 groupId가 null로 설정된다', () => {
    const userInGroup10 = mockUsers[0]!
    const targetGroup = { id: 'unassigned', isUnassigned: true }
    const { targetGroupId, isAlreadyInGroup } = resolveDropTarget(targetGroup, userInGroup10)
    expect(isAlreadyInGroup).toBe(false)
    expect(targetGroupId).toBeNull()
  })

  it('이미 미소속인 사용자를 미소속사용자그룹으로 드롭하면 이동이 스킵된다', () => {
    const unassignedUser = mockUsers[3]!
    const targetGroup = { id: 'unassigned', isUnassigned: true }
    const { isAlreadyInGroup } = resolveDropTarget(targetGroup, unassignedUser)
    expect(isAlreadyInGroup).toBe(true)
  })
})

describe('접속권한 관리 - 메뉴 C/R/U/D 권한 부여 및 버튼 활성 제어 로직', () => {
  interface MenuPermItem {
    menuId: number
    code: string
    canView: boolean
    canCreate: boolean
    canRead: boolean
    canUpdate: boolean
    canDelete: boolean
  }

  function handleViewToggle(item: MenuPermItem) {
    if (!item.canView) {
      item.canCreate = false
      item.canRead = false
      item.canUpdate = false
      item.canDelete = false
    } else {
      item.canRead = true
    }
  }

  function handleCrudToggle(item: MenuPermItem) {
    if (item.canCreate || item.canRead || item.canUpdate || item.canDelete) {
      item.canView = true
    }
  }

  function evaluateCanAction(
    action: string,
    perms: Record<string, { canView: boolean; canCreate: boolean; canRead: boolean; canUpdate: boolean; canDelete: boolean }>,
    menuCode: string,
    isAdmin = false,
  ) {
    if (isAdmin) return true
    const menu = perms[menuCode]
    if (!menu) return true
    const actions = action.split(',').map((s) => s.toLowerCase().trim()).filter(Boolean)
    if (!actions.length) return true

    return actions.some((a) => {
      if (a === 'c' || a === 'create') return menu.canCreate
      if (a === 'r' || a === 'read') return menu.canRead
      if (a === 'u' || a === 'update') return menu.canUpdate
      if (a === 'd' || a === 'delete') return menu.canDelete
      if (a === 'view' || a === 'v') return menu.canView
      return true
    })
  }

  it('메뉴 열람 권한을 해제하면 모든 C, R, U, D 권한이 false 로 초기화된다', () => {
    const item: MenuPermItem = {
      menuId: 1,
      code: 'tdb_editor',
      canView: false,
      canCreate: true,
      canRead: true,
      canUpdate: true,
      canDelete: true,
    }
    handleViewToggle(item)
    expect(item.canView).toBe(false)
    expect(item.canCreate).toBe(false)
    expect(item.canRead).toBe(false)
    expect(item.canUpdate).toBe(false)
    expect(item.canDelete).toBe(false)
  })

  it('메뉴 열람 권한을 켜면 기본적으로 R(조회) 권한이 활성화된다', () => {
    const item: MenuPermItem = {
      menuId: 1,
      code: 'tdb_editor',
      canView: true,
      canCreate: false,
      canRead: false,
      canUpdate: false,
      canDelete: false,
    }
    handleViewToggle(item)
    expect(item.canView).toBe(true)
    expect(item.canRead).toBe(true)
  })

  it('C, R, U, D 중 하나라도 체크하면 canView(메뉴 열람)가 자동으로 켜진다', () => {
    const item: MenuPermItem = {
      menuId: 1,
      code: 'tdb_editor',
      canView: false,
      canCreate: true,
      canRead: false,
      canUpdate: false,
      canDelete: false,
    }
    handleCrudToggle(item)
    expect(item.canView).toBe(true)
  })

  it('버튼 퍼미션 속성 단일 액션(c, r, u, d) 권한에 따라 정상 평가된다', () => {
    const perms = {
      tdb_editor: { canView: true, canCreate: true, canRead: true, canUpdate: false, canDelete: false },
    }
    expect(evaluateCanAction('c', perms, 'tdb_editor')).toBe(true)
    expect(evaluateCanAction('r', perms, 'tdb_editor')).toBe(true)
    expect(evaluateCanAction('u', perms, 'tdb_editor')).toBe(false)
    expect(evaluateCanAction('d', perms, 'tdb_editor')).toBe(false)
  })

  it('복수 권한(permission="c,r,u,d") 속성이 지정되었을 때 허용된 액션이 있으면 통과한다', () => {
    const perms = {
      tdb_editor: { canView: true, canCreate: false, canRead: true, canUpdate: false, canDelete: false },
    }
    expect(evaluateCanAction('c,u', perms, 'tdb_editor')).toBe(false)
    expect(evaluateCanAction('c,r,u,d', perms, 'tdb_editor')).toBe(true)
  })

  it('관리자(ADMIN)는 모든 퍼미션 속성에 대해 항상 true(활성)를 반환한다', () => {
    const perms = {
      tdb_editor: { canView: false, canCreate: false, canRead: false, canUpdate: false, canDelete: false },
    }
    expect(evaluateCanAction('d', perms, 'tdb_editor', true)).toBe(true)
    expect(evaluateCanAction('c,r,u,d', perms, 'tdb_editor', true)).toBe(true)
  })
})
