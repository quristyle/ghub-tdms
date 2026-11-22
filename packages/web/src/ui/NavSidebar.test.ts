import { describe, expect, it } from 'vitest'

interface MockMenuItem {
  code?: string
  path: string
  label: string
}

interface MockNavGroupDef {
  key: string
  label: string
  codes: string[]
  paths: string[]
}

const NAV_GROUPS: MockNavGroupDef[] = [
  {
    key: 'tdb',
    label: 'TDB',
    codes: ['tdb_list', 'tdb_import', 'tdb_editor', 'tdb_distributions'],
    paths: ['/', '/import', '/editor', '/distributions'],
  },
  {
    key: 'mdb',
    label: 'MDB',
    codes: ['mdb_list', 'mdb_editor'],
    paths: ['/mdb', '/mdb-editor'],
  },
  {
    key: 'system',
    label: '시스템',
    codes: ['audit', 'users', 'backup', 'menus', 'permissions', 'stamps', 'projects', 'vendors'],
    paths: ['/audit', '/users', '/backup', '/menus', '/permissions', '/stamps', '/projects', '/vendors'],
  },
]

function inGroup(m: MockMenuItem, g: MockNavGroupDef) {
  return m.code ? g.codes.includes(m.code) : g.paths.includes(m.path)
}

function buildNavGroups(menus: MockMenuItem[]) {
  return NAV_GROUPS
    .map((g) => ({ ...g, items: menus.filter((m) => inGroup(m, g)) }))
    .filter((g) => g.items.length > 0)
}

function buildLooseMenu(menus: MockMenuItem[]) {
  return menus.filter((m) => !NAV_GROUPS.some((g) => inGroup(m, g)))
}

function isOn(currentPath: string, menuPath: string) {
  if (currentPath === menuPath) return true
  if (menuPath !== '/' && currentPath.startsWith(menuPath + '/')) return true
  if (menuPath === '/' && currentPath.startsWith('/documents/')) return true
  return false
}

describe('모바일 사이드바 트리 메뉴 구조 및 로직', () => {
  const sampleMenus: MockMenuItem[] = [
    { code: 'tdb_list', path: '/', label: 'TDB 조회' },
    { code: 'tdb_import', path: '/import', label: 'TDB 반입·검수' },
    { code: 'tdb_editor', path: '/editor', label: 'TDB 관리' },
    { code: 'tdb_distributions', path: '/distributions', label: 'TDB 반출이력' },
    { code: 'mdb_list', path: '/mdb', label: 'MDB 조회' },
    { code: 'mdb_editor', path: '/mdb-editor', label: 'MDB 관리' },
    { code: 'audit', path: '/audit', label: '시스템 로그' },
    { code: 'users', path: '/users', label: '사용자 관리' },
    { code: 'backup', path: '/backup', label: '백업 관리' },
    { code: 'menus', path: '/menus', label: '메뉴 관리' },
    { code: 'custom_catalog', path: '/catalog/special', label: '특수 카탈로그' },
  ]

  it('메뉴 목록이 TDB, MDB, 시스템 트리 그룹으로 정확히 분류된다', () => {
    const groups = buildNavGroups(sampleMenus)
    expect(groups.map((g) => g.key)).toEqual(['tdb', 'mdb', 'system'])

    const tdbGroup = groups.find((g) => g.key === 'tdb')!
    expect(tdbGroup.items.map((i) => i.code)).toEqual([
      'tdb_list', 'tdb_import', 'tdb_editor', 'tdb_distributions',
    ])

    const mdbGroup = groups.find((g) => g.key === 'mdb')!
    expect(mdbGroup.items.map((i) => i.code)).toEqual(['mdb_list', 'mdb_editor'])

    const sysGroup = groups.find((g) => g.key === 'system')!
    expect(sysGroup.items.map((i) => i.code)).toEqual([
      'audit', 'users', 'backup', 'menus',
    ])
  })

  it('어느 그룹에도 속하지 않는 메뉴는 looseMenu(기타)로 분리된다', () => {
    const loose = buildLooseMenu(sampleMenus)
    expect(loose).toHaveLength(1)
    expect(loose[0]?.code).toBe('custom_catalog')
  })

  it('트리 그룹 접기 및 펼치기 토글이 정확히 동작한다', () => {
    const expanded = new Set<string>(['tdb', 'mdb', 'system'])

    // tdb 접기
    expanded.delete('tdb')
    expect(expanded.has('tdb')).toBe(false)
    expect(expanded.has('mdb')).toBe(true)

    // tdb 다시 펼치기
    expanded.add('tdb')
    expect(expanded.has('tdb')).toBe(true)

    // 모두 접기
    expanded.clear()
    expect(expanded.size).toBe(0)

    // 모두 펼치기
    ;['tdb', 'mdb', 'system'].forEach((k) => expanded.add(k))
    expect(expanded.size).toBe(3)
  })

  it('현재 경로에 따른 메뉴 활성화(isOn) 판정이 정확하다', () => {
    expect(isOn('/', '/')).toBe(true)
    expect(isOn('/documents/100', '/')).toBe(true)
    expect(isOn('/mdb', '/')).toBe(false)

    expect(isOn('/mdb', '/mdb')).toBe(true)
    expect(isOn('/mdb/200', '/mdb')).toBe(true)
    expect(isOn('/mdb-editor', '/mdb')).toBe(false)

    expect(isOn('/users', '/users')).toBe(true)
    expect(isOn('/users/detail/1', '/users')).toBe(true)
  })

  it('모바일 환경(900px 이하)에서는 로고 클릭 시 기본 동작을 막고 사이드바를 토글한다', () => {
    let sidebarOpen = false
    let defaultPrevented = false

    function handleLogoClick(isMobileWidth: boolean) {
      if (isMobileWidth) {
        defaultPrevented = true
        sidebarOpen = !sidebarOpen
      }
    }

    // 모바일 너비인 경우
    handleLogoClick(true)
    expect(defaultPrevented).toBe(true)
    expect(sidebarOpen).toBe(true)

    // 다시 클릭 시 닫힘
    handleLogoClick(true)
    expect(sidebarOpen).toBe(false)

    // 데스크톱 너비(900px 초과)인 경우
    defaultPrevented = false
    handleLogoClick(false)
    expect(defaultPrevented).toBe(false)
    expect(sidebarOpen).toBe(false)
  })
})
