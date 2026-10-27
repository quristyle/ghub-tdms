import { createRouter, createWebHistory, createMemoryHistory, type RouteRecordRaw } from 'vue-router'
import { useSession } from '@/lib/session'

/**
 * 화면 라우팅.
 *
 * 메뉴 화면들은 동적 라우팅으로 관리되어 운영자가 /menus 화면에서 경로를 변경하면
 * 해당 변경된 경로가 실시간으로 반영된다.
 *
 * 권한 검사는 서버가 진짜 경계다(/auth/me 가 접근 가능한 메뉴만 내려준다).
 * 여기 가드는 "주소를 직접 친 사람을 접근 가능한 첫 화면으로 보내는" 기존 동작을 재현한다.
 */

export interface MenuRouteDef {
  code: string
  defaultPath: string
  component: () => Promise<any>
  permission: string
  defaultTitle: string
}

export const MENU_ROUTE_DEFINITIONS: Record<string, MenuRouteDef> = {
  tdb_list: {
    code: 'tdb_list',
    defaultPath: '/',
    component: () => import('@/pages/TdbListPage.vue'),
    permission: 'screen.tdb_list.access',
    defaultTitle: 'TDB 조회',
  },
  tdb_import: {
    code: 'tdb_import',
    defaultPath: '/import',
    component: () => import('@/pages/TdbImportPage.vue'),
    permission: 'screen.tdb_import.access',
    defaultTitle: 'TDB 반입·검수',
  },
  tdb_editor: {
    code: 'tdb_editor',
    defaultPath: '/editor',
    component: () => import('@/pages/TdbEditorPage.vue'),
    permission: 'screen.tdb_editor.access',
    defaultTitle: 'TDB 관리',
  },
  tdb_distributions: {
    code: 'tdb_distributions',
    defaultPath: '/distributions',
    component: () => import('@/pages/TdbDistributionsPage.vue'),
    permission: 'screen.tdb_distributions.access',
    defaultTitle: 'TDB 반출이력',
  },
  mdb_list: {
    code: 'mdb_list',
    defaultPath: '/mdb',
    component: () => import('@/pages/MdbListPage.vue'),
    permission: 'screen.mdb_list.access',
    defaultTitle: 'MDB 조회',
  },
  mdb_editor: {
    code: 'mdb_editor',
    defaultPath: '/mdb-editor',
    component: () => import('@/pages/MdbEditorPage.vue'),
    permission: 'screen.mdb_editor.access',
    defaultTitle: 'MDB 관리',
  },
  audit: {
    code: 'audit',
    defaultPath: '/audit',
    component: () => import('@/pages/AuditPage.vue'),
    permission: 'screen.audit.access',
    defaultTitle: '시스템 로그',
  },
  users: {
    code: 'users',
    defaultPath: '/users',
    component: () => import('@/pages/UsersPage.vue'),
    permission: 'screen.users.access',
    defaultTitle: '사용자 관리',
  },
  backup: {
    code: 'backup',
    defaultPath: '/backup',
    component: () => import('@/pages/BackupPage.vue'),
    permission: 'screen.backup.access',
    defaultTitle: '백업 관리',
  },
  menus: {
    code: 'menus',
    defaultPath: '/menus',
    component: () => import('@/pages/MenusPage.vue'),
    permission: 'screen.users.access',
    defaultTitle: '메뉴 관리',
  },
  permissions: {
    code: 'permissions',
    defaultPath: '/permissions',
    component: () => import('@/pages/PermissionsPage.vue'),
    permission: 'screen.users.access',
    defaultTitle: '접속권한 관리',
  },
  stamps: {
    code: 'stamps',
    defaultPath: '/stamps',
    component: () => import('@/pages/StampsPage.vue'),
    permission: 'screen.users.access',
    defaultTitle: '스탬프 관리',
  },
}

/** 고정된 기본 라우트 (메뉴에 종속되지 않는 화면들) */
const staticRoutes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true, bare: true } },
  { path: '/password-change', component: () => import('@/pages/PasswordChangePage.vue'), meta: { bare: true } },

  { path: '/documents/:id', component: () => import('@/pages/TdbDetailPage.vue'), meta: { title: 'TDB 자료 상세' } },
  { path: '/mdb/:id',       component: () => import('@/pages/MdbDetailPage.vue'), meta: { title: 'MDB 자료 상세' } },
  { path: '/help',          component: () => import('@/pages/HelpPage.vue'), meta: { title: '도움말' } },

  { path: '/no-access', component: () => import('@/pages/NoAccessPage.vue'), meta: { bare: true } },
  {
    path: '/groups',
    redirect: () => {
      const session = useSession()
      const m = session.menu.find((x) => x.code === 'users')
      return m?.path ?? '/users'
    },
  },
]

export const router = createRouter({
  history: typeof window !== 'undefined' ? createWebHistory() : createMemoryHistory(),
  routes: staticRoutes,
})

/** 초기 기본 메뉴 라우트 등록 */
for (const def of Object.values(MENU_ROUTE_DEFINITIONS)) {
  router.addRoute({
    name: 'menu_' + def.code,
    path: def.defaultPath,
    component: def.component,
    meta: {
      menuCode: def.code,
      permission: def.permission,
      title: def.defaultTitle,
    },
  })
}

// 404 및 미일치 라우트용 catch-all 등록
router.addRoute({
  name: 'catchAll',
  path: '/:pathMatch(.*)*',
  redirect: () => {
    const session = useSession()
    return session.firstAllowedPath || '/'
  },
})

/**
 * 서버에서 내려받은 메뉴 목록을 바탕으로 라우트를 동적으로 동기화한다.
 * 경로가 변경된 메뉴는 기존 라우트를 제거하고 새 경로로 등록한다.
 */
export function syncDynamicRoutes(menus: { code?: string; path: string; label?: string }[]): boolean {
  let changed = false
  for (const m of menus) {
    let code = m.code
    if (!code) {
      const found = Object.values(MENU_ROUTE_DEFINITIONS).find((d) => d.defaultPath === m.path)
      code = found?.code
    }
    if (!code) continue
    const def = MENU_ROUTE_DEFINITIONS[code]
    if (!def) continue

    const routeName = 'menu_' + code
    const existing = router.hasRoute(routeName) ? router.getRoutes().find((r) => r.name === routeName) : null
    if (!existing || existing.path !== m.path) {
      if (existing) {
        router.removeRoute(routeName)
      }
      router.addRoute({
        name: routeName,
        path: m.path,
        component: def.component,
        meta: {
          menuCode: code,
          permission: def.permission,
          title: m.label || def.defaultTitle,
        },
      })
      changed = true
    }
  }
  return changed
}

router.beforeEach(async (to) => {
  const session = useSession()
  if (to.meta.public) return true

  if (!session.isLoggedIn && !(await session.load())) return '/login'

  // 최초 비밀번호 상태면 변경 화면을 먼저 연다
  if (session.needsPasswordChange && to.path !== '/password-change') return '/password-change'

  // 세션의 최신 메뉴 정보를 기반으로 동적 라우트 동기화
  const routesChanged = syncDynamicRoutes(session.menu)

  // 동적 라우트가 변경되었고, 현재 네비게이션이 catchAll로 잡혔거나 매칭되지 않은 경우 재진입
  if (routesChanged && (to.matched.length === 0 || to.name === 'catchAll')) {
    return { path: to.fullPath, replace: true }
  }

  const need = to.meta.permission as string | undefined
  if (need && !session.can(need)) {
    // 접근 가능한 첫 화면으로. 하나도 없으면 안내.
    const first = session.firstAllowedPath
    return first && first !== to.path ? first : '/no-access'
  }
  return true
})
