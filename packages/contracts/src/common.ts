import { z } from 'zod'

/**
 * 공통 스키마.
 *
 * 페이징은 전 구간 keyset(cursor) 방식이다. OFFSET 을 쓰지 않는 이유는
 * 뒤 페이지로 갈수록 느려지기 때문 — 기존 시스템의 "끝 페이지" 버튼이 느렸던 원인이다.
 * 커서는 (정렬키, id) 쌍을 base64url 로 인코딩한 불투명 문자열이다.
 */

/**
 * 쿼리스트링 불리언.
 *
 * z.coerce.boolean() 을 쓰면 안 된다 — 내부가 Boolean(value) 라서
 * 문자열 "false" 가 true 가 된다. 실제로 Isometric 토글(전체 도면의 63%를 가르는
 * 가장 중요한 필터)이 이 함정 때문에 무력화된 적이 있다.
 */
export const BoolParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1' || v === 'yes'))

export const Cursor = z.string().max(200)

export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type PageQuery = z.infer<typeof PageQuery>

export function pageResult<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: Cursor.nullable(),
    /** 총 건수. 비싸므로 첫 페이지에서만 계산하고 이후에는 null 이다. */
    total: z.number().int().nullable(),
  })
}

export const DocClass = z.enum(['TDB', 'MDB'])
export type DocClass = z.infer<typeof DocClass>

export const SortDir = z.enum(['asc', 'desc'])

/** 모든 실패 응답의 공통 형태. 화면이 code 로 분기하고 message 를 보여준다. */
export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  /** 403 일 때 어떤 권한이 필요한지 알려준다 */
  requiredPermission: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponse>

/** 장시간 작업은 즉시 202 로 이 형태를 돌려준다. 진행률은 SSE 로 받는다. */
export const JobAccepted = z.object({
  jobId: z.number().int(),
})

export const JobState = z.enum(['queued', 'running', 'done', 'failed', 'canceled'])

export const JobStatus = z.object({
  id: z.number().int(),
  kind: z.string(),
  state: JobState,
  progress: z.number().int().min(0).max(100),
  progressNote: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
})
export type JobStatus = z.infer<typeof JobStatus>
