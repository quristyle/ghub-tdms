import { describe, expect, it } from 'vitest'
import { router, syncDynamicRoutes, MENU_ROUTE_DEFINITIONS } from './router'

describe('동적 메뉴 라우팅', () => {
  it('초기 상태에서는 기본 경로로 라우트가 등록되어 있다', () => {
    const r = router.resolve('/import')
    expect(r.name).toBe('menu_tdb_import')
    expect(r.meta.menuCode).toBe('tdb_import')
  })

  it('메뉴 경로가 변경되면 syncDynamicRoutes 에 의해 새 경로로 라우트가 갱신된다', () => {
    const changed = syncDynamicRoutes([
      { code: 'tdb_import', path: '/custom-import', label: 'TDB 반입' },
    ])
    expect(changed).toBe(true)

    // 새 경로로 매칭 확인
    const resolvedNew = router.resolve('/custom-import')
    expect(resolvedNew.name).toBe('menu_tdb_import')
    expect(resolvedNew.meta.menuCode).toBe('tdb_import')

    // 원복
    syncDynamicRoutes([
      { code: 'tdb_import', path: '/import', label: 'TDB 반입·검수' },
    ])
    const restored = router.resolve('/import')
    expect(restored.name).toBe('menu_tdb_import')
  })
})
