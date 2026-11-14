import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, qs, setReauthenticationHandler } from './api'

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

describe('qs', () => {
  it('값이 없는 조건은 빼고, 있는 것만 담는다', () => {
    expect(qs({ a: 1, b: undefined, c: null, d: '' })).toBe('?a=1')
  })

  it('여러 개를 고른 조건은 ?k=a&k=b 로 보낸다', () => {
    // "a,b" 한 값으로 뭉치면 서버(MultiParam)가 한 글자열로 받아 아무것도 못 찾는다
    expect(qs({ screen: ['TDB 조회', '로그인'] }))
      .toBe('?screen=TDB+%EC%A1%B0%ED%9A%8C&screen=%EB%A1%9C%EA%B7%B8%EC%9D%B8')
  })

  it('배열 안의 빈 값은 건너뛴다', () => {
    expect(qs({ k: ['a', '', 'b'] })).toBe('?k=a&k=b')
  })
})
