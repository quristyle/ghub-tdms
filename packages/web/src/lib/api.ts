import type { ErrorResponse } from '@tdms/contracts'

/**
 * API 클라이언트.
 *
 * 계약(@tdms/contracts)의 타입을 그대로 쓴다 — 수작업 타입 정의가 없다.
 * API 응답 필드가 바뀌면 여기가 아니라 호출부가 컴파일 에러로 알려준다.
 */

const BASE = '/api'

type ReauthenticationHandler = () => Promise<boolean>
let reauthenticationHandler: ReauthenticationHandler | null = null
let reauthenticationPrompt: Promise<boolean> | null = null

export function setReauthenticationHandler(handler: ReauthenticationHandler | null): void {
  reauthenticationHandler = handler
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requiredPermission?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  retryAfterAuthentication = true,
): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal,
  })

  if (
    res.status === 401 &&
    retryAfterAuthentication &&
    path !== '/auth/login' &&
    path !== '/auth/me' &&
    reauthenticationHandler
  ) {
    reauthenticationPrompt ??= reauthenticationHandler().finally(() => {
      reauthenticationPrompt = null
    })
    if (await reauthenticationPrompt) {
      return request<T>(method, path, body, signal, false)
    }
  }

  if (!res.ok) {
    let err: ErrorResponse
    try {
      err = (await res.json()) as ErrorResponse
    } catch {
      throw new ApiError(res.status, 'NETWORK', `요청에 실패했습니다 (${res.status})`)
    }
    throw new ApiError(res.status, err.code, err.message, err.requiredPermission)
  }

  if (res.status === 204) return { status: res.status, body: undefined as T }
  return { status: res.status, body: (await res.json()) as T }
}

async function requestBody<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await request<T>(method, path, body, signal)).body
}

/** 객체를 쿼리스트링으로. undefined 는 보내지 않는다. */
export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => requestBody<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => requestBody<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => requestBody<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => requestBody<T>('PATCH', path, body),
  delete: <T>(path: string) => requestBody<T>('DELETE', path),
  upload: <T>(path: string, body: FormData) => request<T>('POST', path, body),
}
