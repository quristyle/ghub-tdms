import type { ErrorResponse } from '@tdms/contracts'

/**
 * API 클라이언트.
 *
 * 계약(@tdms/contracts)의 타입을 그대로 쓴다 — 수작업 타입 정의가 없다.
 * API 응답 필드가 바뀌면 여기가 아니라 호출부가 컴파일 에러로 알려준다.
 */

const BASE = '/api'

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

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    let err: ErrorResponse
    try {
      err = (await res.json()) as ErrorResponse
    } catch {
      throw new ApiError(res.status, 'NETWORK', `요청에 실패했습니다 (${res.status})`)
    }
    throw new ApiError(res.status, err.code, err.message, err.requiredPermission)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
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
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
