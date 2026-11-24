import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { router, MENU_ROUTE_DEFINITIONS } from '../router'

describe('화면 KeepAlive 기능 (AppShell 라우터 뷰 캐싱)', () => {
  it('AppShell.vue 의 본문 컨테이너에 RouterView 와 KeepAlive 가 설정되어 있다', () => {
    const appShellPath = path.resolve(__dirname, 'AppShell.vue')
    const content = fs.readFileSync(appShellPath, 'utf-8')

    // RouterView v-slot="{ Component, route }" 형태 확인
    expect(content).toMatch(/<RouterView\s+v-slot="{[^}]*Component[^}]*route[^}]*}"/)
    // KeepAlive 로 component 를 감싸고 있는지 확인
    expect(content).toContain('<KeepAlive>')
    expect(content).toContain('</KeepAlive>')
    // route.path 를 고유 key 로 바인딩하여 화면별 상태가 유지되도록 했는지 확인
    expect(content).toMatch(/<component\s+:is="Component"\s+:key="route\.path"\s*\/>/)
  })

  it('시스템의 모든 메뉴 및 동적 라우트가 각기 독립된 고유 path 를 가져 KeepAlive 캐시 키가 충돌하지 않는다', () => {
    const paths = new Set<string>()
    for (const def of Object.values(MENU_ROUTE_DEFINITIONS)) {
      expect(paths.has(def.defaultPath)).toBe(false)
      paths.add(def.defaultPath)
    }

    // 동일한 CatalogPage 컴포넌트를 사용하는 공사 관리(/projects)와 업체 관리(/vendors)도
    // 각각 고유의 path 를 가져 KeepAlive 캐시 키가 분리된다
    expect(MENU_ROUTE_DEFINITIONS.projects?.defaultPath).toBe('/projects')
    expect(MENU_ROUTE_DEFINITIONS.vendors?.defaultPath).toBe('/vendors')
    expect(MENU_ROUTE_DEFINITIONS.projects?.defaultPath).not.toBe(MENU_ROUTE_DEFINITIONS.vendors?.defaultPath)
  })

  it('상세 화면(/documents/:id, /mdb/:id)도 id별로 독립된 path 를 가져 개별 화면 상태가 유지된다', () => {
    const doc1 = router.resolve('/documents/100')
    const doc2 = router.resolve('/documents/200')
    expect(doc1.path).toBe('/documents/100')
    expect(doc2.path).toBe('/documents/200')
    expect(doc1.path).not.toBe(doc2.path)

    const mdb1 = router.resolve('/mdb/10')
    const mdb2 = router.resolve('/mdb/20')
    expect(mdb1.path).toBe('/mdb/10')
    expect(mdb2.path).toBe('/mdb/20')
    expect(mdb1.path).not.toBe(mdb2.path)
  })
})
