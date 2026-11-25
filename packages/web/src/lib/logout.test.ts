import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from './api'
import { queryClient } from './queryClient'
import { useSession } from './session'

describe('로그아웃 동작 및 세션 정리', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('로그아웃 시 /auth/logout API를 호출하고 me 정보를 null로 정리한다', async () => {
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ ok: true })
    const clearSpy = vi.spyOn(queryClient, 'clear')
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries')

    const session = useSession()
    session.me = {
      id: 1,
      loginId: 'admin',
      name: '관리자',
      role: 'ADMIN',
      groupId: 1,
      groupName: '설비기술팀',
      mustChangePassword: false,
      passwordDeferred: false,
      totpEnabled: true,
      permissions: [],
      menu: [],
      menuPermissions: {},
      layoutMode: 'both',
      sidebarPinned: false,
    }

    expect(session.isLoggedIn).toBe(true)

    await session.logout()

    expect(postSpy).toHaveBeenCalledWith('/auth/logout')
    expect(session.me).toBeNull()
    expect(session.isLoggedIn).toBe(false)
    expect(cancelSpy).toHaveBeenCalled()
    expect(clearSpy).toHaveBeenCalled()
    expect(session.isLoggingOut).toBe(false)
  })

  it('로그아웃 API가 실패(401 등)하더라도 에러를 던지지 않고 세션을 안전하게 정리한다', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Network error or 401'))
    const clearSpy = vi.spyOn(queryClient, 'clear')

    const session = useSession()
    session.me = {
      id: 1,
      loginId: 'admin',
      name: '관리자',
      role: 'ADMIN',
      groupId: 1,
      groupName: '설비기술팀',
      mustChangePassword: false,
      passwordDeferred: false,
      totpEnabled: true,
      permissions: [],
      menu: [],
      menuPermissions: {},
      layoutMode: 'both',
      sidebarPinned: false,
    }

    await expect(session.logout()).resolves.toBeUndefined()
    expect(session.me).toBeNull()
    expect(session.isLoggedIn).toBe(false)
    expect(clearSpy).toHaveBeenCalled()
    expect(session.isLoggingOut).toBe(false)
  })
})
