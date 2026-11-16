import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MeResponse } from '@tdms/contracts'
import { api, ApiError } from './api.js'

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
   * 변경 화면을 먼저 열어야 하는가. 미루기는 없다 — 서버도 바꾸기 전에는
   * /auth/me·/auth/password·/auth/logout 말고는 403(PASSWORD_CHANGE_REQUIRED)을 낸다.
   */
  const needsPasswordChange = computed(() => me.value?.mustChangePassword === true)
  const isAdmin = computed(() => me.value?.role === 'ADMIN')
  const menu = computed(() => me.value?.menu ?? [])

  /** 권한 리프 보유 여부. ADMIN 은 항상 true. */
  function can(key: string): boolean {
    if (!me.value) return false
    if (me.value.role === 'ADMIN') return true
    return me.value.permissions.includes(key)
  }

  async function load(): Promise<boolean> {
    loading.value = true
    try {
      me.value = await api.get<MeResponse>('/auth/me')
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) me.value = null
      return false
    } finally {
      loading.value = false
    }
  }

  async function login(loginId: string, password: string) {
    const r = await api.post<{ ok: true; mustChangePassword: boolean }>('/auth/login', { loginId, password })
    await load()
    return r
  }

  async function logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      me.value = null
    }
  }

  function clear() {
    me.value = null
  }

  /** 접근 가능한 첫 화면 — 상단 메뉴 차례 그대로 (기존 동작) */
  const firstAllowedPath = computed(() => menu.value[0]?.path ?? null)

  return {
    me, loading, isLoggedIn, isAdmin, menu, can, load, login, logout,
    firstAllowedPath, needsPasswordChange, clear,
  }
})
