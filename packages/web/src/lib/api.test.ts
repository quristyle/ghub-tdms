import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, setReauthenticationHandler } from './api'

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  setReauthenticationHandler(null)
  vi.unstubAllGlobals()
})

describe('API 재인증', () => {
  it('세션 만료 뒤 로그인하면 multipart 요청을 같은 내용으로 한 번 재시도한다', async () => {
    const form = new FormData()
    form.set('filename', 'drawing.dwg')
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, 401))
      .mockResolvedValueOnce(response({ ok: true }, 200))
    vi.stubGlobal('fetch', fetchMock)
    const authenticate = vi.fn().mockResolvedValue(true)
    setReauthenticationHandler(authenticate)

    await expect(api.upload<{ ok: boolean }>('/documents/1/revisions', form))
      .resolves.toEqual({ status: 200, body: { ok: true } })

    expect(authenticate).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(form)
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(form)
  })

  it('동시에 만료된 요청은 공통 로그인 팝업을 하나만 표시한다', async () => {
    let callCount = 0
    const fetchMock = vi.fn<typeof fetch>(async () => {
      callCount += 1
      return callCount <= 2
        ? response({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, 401)
        : response({ ok: true }, 200)
    })
    vi.stubGlobal('fetch', fetchMock)

    let releaseAuthentication: ((authenticated: boolean) => void) | undefined
    const authentication = new Promise<boolean>((resolve) => { releaseAuthentication = resolve })
    const authenticate = vi.fn(() => authentication)
    setReauthenticationHandler(authenticate)

    const requests = Promise.all([
      api.get<{ ok: boolean }>('/documents'),
      api.get<{ ok: boolean }>('/folders'),
    ])
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce())
    releaseAuthentication?.(true)

    await expect(requests).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('로그인 요청 자체가 401이면 재인증 팝업을 다시 띄우지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      response({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, 401),
    ))
    const authenticate = vi.fn()
    setReauthenticationHandler(authenticate)

    await expect(api.post('/auth/login', { loginId: 'lee', password: 'bad' }))
      .rejects.toMatchObject({ status: 401 })
    expect(authenticate).not.toHaveBeenCalled()
  })
})
