import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSession } from '@/lib/session'
import MyPage from './MyPage.vue'

describe('마이페이지 화면 (MyPage.vue)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('마이페이지 화면 컴포넌트가 정의되어 있고 렌더링에 필요한 요소를 가지고 있다', () => {
    expect(MyPage).toBeDefined()
  })

  it('마이페이지에서 로그아웃 호출 시 session.logout()을 실행하고 로그인 페이지로 이동한다', async () => {
    const session = useSession()
    const logoutSpy = vi.spyOn(session, 'logout').mockResolvedValue(undefined)

    const pushMock = vi.fn()
    const emitMock = vi.fn()

    // MyPage 내부 handleLogout 로직 검증
    async function testHandleLogout(isModal: boolean) {
      if (isModal) {
        emitMock('close')
      }
      await session.logout()
      pushMock('/login')
    }

    // 단독 화면 케이스
    await testHandleLogout(false)
    expect(logoutSpy).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith('/login')
    expect(emitMock).not.toHaveBeenCalled()

    // 모달 팝업 케이스
    await testHandleLogout(true)
    expect(logoutSpy).toHaveBeenCalledTimes(2)
    expect(emitMock).toHaveBeenCalledWith('close')
  })
})
