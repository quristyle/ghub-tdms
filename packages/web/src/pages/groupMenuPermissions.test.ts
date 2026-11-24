import { describe, expect, it } from 'vitest'

interface MockMenuPerm {
  menuId: number
  code: string
  label: string
  canView: boolean
  canCreate: boolean
  canRead: boolean
  canUpdate: boolean
  canDelete: boolean
}

function applyBatchMode(items: MockMenuPerm[], mode: 'all' | 'none' | 'readonly') {
  for (const item of items) {
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

function checkCrudPermission(
  perms: Record<string, { canView: boolean; canCreate: boolean; canRead: boolean; canUpdate: boolean; canDelete: boolean }>,
  menuCode: string,
  action: 'c' | 'r' | 'u' | 'd' | 'view',
  role: 'ADMIN' | 'VIEWER' = 'VIEWER',
): boolean {
  if (role === 'ADMIN') return true
  const p = perms[menuCode]
  if (!p) return true // 기본값
  switch (action) {
    case 'c': return p.canCreate
    case 'r': return p.canRead
    case 'u': return p.canUpdate
    case 'd': return p.canDelete
    case 'view': return p.canView
  }
}

describe('그룹 메뉴권한 관리 - 일괄 설정 및 C/R/U/D 권한 검사', () => {
  it('전체 허용 시 열람 및 모든 C/R/U/D가 true가 된다', () => {
    const list: MockMenuPerm[] = [
      { menuId: 1, code: 'tdb_list', label: 'TDB 조회', canView: false, canCreate: false, canRead: false, canUpdate: false, canDelete: false },
    ]
    applyBatchMode(list, 'all')
    const item = list[0]!
    expect(item.canView).toBe(true)
    expect(item.canCreate).toBe(true)
    expect(item.canRead).toBe(true)
    expect(item.canUpdate).toBe(true)
    expect(item.canDelete).toBe(true)
  })

  it('조회(R)만 허용 시 열람과 R만 true이고 C/U/D는 false가 된다', () => {
    const list: MockMenuPerm[] = [
      { menuId: 2, code: 'tdb_editor', label: 'TDB 관리', canView: true, canCreate: true, canRead: true, canUpdate: true, canDelete: true },
    ]
    applyBatchMode(list, 'readonly')
    const item = list[0]!
    expect(item.canView).toBe(true)
    expect(item.canCreate).toBe(false)
    expect(item.canRead).toBe(true)
    expect(item.canUpdate).toBe(false)
    expect(item.canDelete).toBe(false)
  })

  it('전체 차단 시 모든 열람 및 CRUD가 false가 된다', () => {
    const list: MockMenuPerm[] = [
      { menuId: 3, code: 'users', label: '사용자 관리', canView: true, canCreate: true, canRead: true, canUpdate: true, canDelete: true },
    ]
    applyBatchMode(list, 'none')
    const item = list[0]!
    expect(item.canView).toBe(false)
    expect(item.canCreate).toBe(false)
    expect(item.canRead).toBe(false)
    expect(item.canUpdate).toBe(false)
    expect(item.canDelete).toBe(false)
  })

  it('ADMIN 사용자는 권한 설정과 무관하게 항상 모든 권한이 통과된다', () => {
    const perms = {
      tdb_editor: { canView: false, canCreate: false, canRead: false, canUpdate: false, canDelete: false },
    }
    expect(checkCrudPermission(perms, 'tdb_editor', 'c', 'ADMIN')).toBe(true)
    expect(checkCrudPermission(perms, 'tdb_editor', 'd', 'ADMIN')).toBe(true)
  })

  it('일반 그룹 사용자는 설정된 C, R, U, D 권한에 따라 정확히 허용 여부가 판정된다', () => {
    const perms = {
      tdb_editor: { canView: true, canCreate: true, canRead: true, canUpdate: false, canDelete: false },
    }
    expect(checkCrudPermission(perms, 'tdb_editor', 'c')).toBe(true)
    expect(checkCrudPermission(perms, 'tdb_editor', 'r')).toBe(true)
    expect(checkCrudPermission(perms, 'tdb_editor', 'u')).toBe(false)
    expect(checkCrudPermission(perms, 'tdb_editor', 'd')).toBe(false)
  })
})
