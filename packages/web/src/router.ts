import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useSession } from '@/lib/session'

/**
 * 화면 14개.
 *
 * 권한 검사는 서버가 진짜 경계다(/auth/me 가 접근 가능한 메뉴만 내려준다).
 * 여기 가드는 "주소를 직접 친 사람을 접근 가능한 첫 화면으로 보내는" 기존 동작을 재현한다.
 */

const ph = () => import('@/pages/PlaceholderPage.vue')

const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true, bare: true } },
  { path: '/password-change', component: () => import('@/pages/PasswordChangePage.vue'), meta: { bare: true } },

  { path: '/',              component: () => import('@/pages/TdbListPage.vue'), meta: { permission: 'screen.tdb_list.access', title: 'TDB 조회' } },
  { path: '/import',        component: () => import('@/pages/TdbImportPage.vue'), meta: { permission: 'screen.tdb_import.access', title: 'TDB 반입·검수' } },
  { path: '/editor',        component: () => import('@/pages/TdbEditorPage.vue'), meta: { permission: 'screen.tdb_editor.access', title: 'TDB 관리' } },
  { path: '/distributions', component: () => import('@/pages/TdbDistributionsPage.vue'), meta: { permission: 'screen.tdb_distributions.access', title: 'TDB 반출이력' } },
  { path: '/mdb',           component: () => import('@/pages/MdbListPage.vue'), meta: { permission: 'screen.mdb_list.access', title: 'MDB 조회' } },
  { path: '/mdb-editor',    component: () => import('@/pages/MdbEditorPage.vue'), meta: { permission: 'screen.mdb_editor.access', title: 'MDB 관리' } },
  { path: '/audit',         component: () => import('@/pages/AuditPage.vue'), meta: { permission: 'screen.audit.access', title: '시스템 로그' } },
  { path: '/users',         component: () => import('@/pages/UsersPage.vue'), meta: { permission: 'screen.users.access', title: '사용자 관리' } },
  { path: '/groups',        redirect: '/users' },
  { path: '/backup',        component: () => import('@/pages/BackupPage.vue'), meta: { permission: 'screen.backup.access', title: '백업 관리' } },
  // 메뉴 관리 — 권한은 사용자·권한 관리와 같은 리프를 쓴다(새 리프를 만들면 레거시 패리티가 깨진다).
  { path: '/menus',         component: () => import('@/pages/MenusPage.vue'), meta: { permission: 'screen.users.access', title: '메뉴 관리' } },

  { path: '/documents/:id', component: () => import('@/pages/TdbDetailPage.vue'), meta: { title: 'TDB 자료 상세' } },
  { path: '/mdb/:id',       component: () => import('@/pages/MdbDetailPage.vue'), meta: { title: 'MDB 자료 상세' } },
  { path: '/help',          component: () => import('@/pages/HelpPage.vue'), meta: { title: '도움말' } },

  { path: '/no-access', component: () => import('@/pages/NoAccessPage.vue'), meta: { bare: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach(async (to) => {
  const session = useSession()
  if (to.meta.public) return true

  if (!session.isLoggedIn && !(await session.load())) return '/login'

  // 최초 비밀번호 상태면 변경 화면을 먼저 연다. '미루기'를 누르면 이번 로그인 동안만
  // 건너뛰고, 다음 로그인 때 다시 열린다 (기존 정책).
  if (session.needsPasswordChange && to.path !== '/password-change') return '/password-change'

  const need = to.meta.permission as string | undefined
  if (need && !session.can(need)) {
    // 접근 가능한 첫 화면으로. 하나도 없으면 안내.
    const first = session.firstAllowedPath
    return first && first !== to.path ? first : '/no-access'
  }
  return true
})
