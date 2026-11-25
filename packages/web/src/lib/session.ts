import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { LoginResult, MeResponse, MfaVerifyResult } from '@tdms/contracts'
import { api, ApiError } from './api.js'
import { router } from '../router.js'
import { queryClient } from './queryClient.js'

/**
 * 세션·권한 스토어.
 *
 * 권한 판정은 서버가 이미 한 결과(/auth/me 의 permissions)를 그대로 쓴다.
 * 화면은 버튼을 숨기는 용도로만 쓰고, 진짜 경계는 언제나 서버다.
 */
export const useSession = defineStore('session', () => {
  const me = ref<MeResponse | null>(null)
  const loading = ref(false)

  const isLoggedIn = computed(() => me.value !== null)
  /**
   * 변경 화면을 먼저 열어야 하는가.
   * 미루기는 서버 세션(sessions.password_deferred)에 담긴다 — 새로고침해도 유지되고
   * 다시 로그인하면 초기화된다. 서버도 미루지 않은 세션은 변경 전까지 다른 API 를 막는다.
   */
  const needsPasswordChange = computed(
    () => me.value?.mustChangePassword === true && me.value.passwordDeferred !== true,
  )
  const isAdmin = computed(() => me.value?.role === 'ADMIN')
  const menu = computed(() => me.value?.menu ?? [])

  /** 권한 리프 보유 여부. ADMIN 은 항상 true. */
  function can(key: string): boolean {
    if (!me.value) return false
    if (me.value.role === 'ADMIN') return true
    return me.value.permissions.includes(key)
  }

  /**
   * 메뉴에 대한 C, R, U, D 동작 권한 여부 확인.
   * ADMIN 은 항상 true.
   * @param action 'c' | 'r' | 'u' | 'd' | 'view'
   * @param menuCode 생략 시 현재 라우트의 meta.menuCode 기준
   */
  function canAction(action: string, menuCode?: string): boolean {
    if (!me.value) return false
    if (me.value.role === 'ADMIN') return true
    let code = menuCode
    if (!code) {
      try {
        code = router.currentRoute.value?.meta?.menuCode as string
      } catch {}
    }
    if (!code) return true
    const perms = me.value.menuPermissions?.[code]
    if (!perms) return true
    const a = action.toLowerCase().trim()
    if (a === 'c' || a === 'create') return perms.canCreate
    if (a === 'r' || a === 'read') return perms.canRead
    if (a === 'u' || a === 'update') return perms.canUpdate
    if (a === 'd' || a === 'delete') return perms.canDelete
    if (a === 'view' || a === 'v') return perms.canView
    return true
  }

  async function load(): Promise<boolean> {
    loading.value = true
    try {
      me.value = await api.get<MeResponse>('/auth/me')
      syncSidebarPinnedFromServer()
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) me.value = null
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 1단계 — 비밀번호. 2차 인증이 켜져 있으면 아직 세션이 없다:
   * mfa 가 verify/enroll 이면 인증 앱 코드를 verifyMfa 로 넘겨야 로그인이 끝난다.
   */
  async function login(loginId: string, password: string, skipMfa = false): Promise<LoginResult> {
    queryClient.clear()
    const r = await api.post<LoginResult>('/auth/login', { loginId, password, skipMfa })
    if (r.mfa === 'none') await load()
    return r
  }

  /** 2단계 — 인증 앱(Microsoft Authenticator 등)의 6자리 코드. 맞으면 세션이 생긴다. */
  async function verifyMfa(challenge: string, code: string): Promise<MfaVerifyResult> {
    queryClient.clear()
    const r = await api.post<MfaVerifyResult>('/auth/mfa', { challenge, code })
    await load()
    return r
  }

  /** 그룹별 임의 사용자 빠른 자동 로그인 (개발용) */
  async function quickLogin(loginId: string): Promise<void> {
    queryClient.clear()
    await api.post('/auth/quick-login', { loginId })
    await load()
  }

  const isLoggingOut = ref(false)

  async function logout() {
    isLoggingOut.value = true
    try {
      await api.post('/auth/logout')
    } catch {
      // 이미 세션이 만료되었거나 네트워크 이상이어도 클라이언트 로그아웃은 완료한다
    } finally {
      me.value = null
      queryClient.cancelQueries()
      queryClient.clear()
      isLoggingOut.value = false
    }
  }

  function clear() {
    me.value = null
    queryClient.cancelQueries()
    queryClient.clear()
  }

  /** 미루기 — 서버 세션에 기록한다. 이 세션 동안만 건너뛴다. */
  async function deferPasswordChange() {
    await api.post('/auth/password/defer')
    await load()
  }

  /** 접근 가능한 첫 화면 — 상단 메뉴 차례 그대로 (기존 동작) */
  const firstAllowedPath = computed(() => menu.value[0]?.path ?? null)

  /** 내비게이션 레이아웃 모드: both(둘 다), top(상단만), sidebar(사이드바만) */
  const layoutMode = computed<'both' | 'top' | 'sidebar'>(() => {
    if (me.value?.layoutMode) return me.value.layoutMode
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('tdms_layout_mode')
      if (saved === 'both' || saved === 'top' || saved === 'sidebar') return saved
    }
    return 'both'
  })

  /** 사이드바 핀 고정 여부 */
  const isSidebarPinned = ref<boolean>(
    typeof localStorage !== 'undefined' ? localStorage.getItem('tdms_sidebar_pinned') === 'true' : false
  )

  // me.value 가 로드되면 서버 값과 동기화
  function syncSidebarPinnedFromServer() {
    if (me.value?.sidebarPinned !== undefined) {
      isSidebarPinned.value = Boolean(me.value.sidebarPinned)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('tdms_sidebar_pinned', String(isSidebarPinned.value))
      }
    }
    if (me.value?.layoutMode) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('tdms_layout_mode', me.value.layoutMode)
      }
    }
  }

  async function updateLayoutPreferences(prefs: {
    layoutMode?: 'both' | 'top' | 'sidebar'
    sidebarPinned?: boolean
  }): Promise<void> {
    if (prefs.sidebarPinned !== undefined) {
      isSidebarPinned.value = prefs.sidebarPinned
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('tdms_sidebar_pinned', String(prefs.sidebarPinned))
      }
    }
    if (prefs.layoutMode !== undefined) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('tdms_layout_mode', prefs.layoutMode)
      }
    }
    if (me.value) {
      if (prefs.layoutMode !== undefined) me.value.layoutMode = prefs.layoutMode
      if (prefs.sidebarPinned !== undefined) me.value.sidebarPinned = prefs.sidebarPinned
    }
    try {
      await api.put('/auth/layout', prefs)
    } catch (err) {
      // 오프라인이나 네트워크 지연 시에도 UI 상태는 유지됨
      console.warn('레이아웃 설정 서버 동기화 실패 (로컬 유지):', err)
    }
  }

  return {
    me, loading, isLoggedIn, isAdmin, menu, can, canAction, load, login, quickLogin, verifyMfa, logout,
    isLoggingOut,
    firstAllowedPath, needsPasswordChange, deferPasswordChange, clear,
    layoutMode, isSidebarPinned, updateLayoutPreferences, syncSidebarPinnedFromServer,
  }
})
