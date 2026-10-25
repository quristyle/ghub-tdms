import { z } from 'zod'
import { JobState } from './common.js'

/**
 * 장시간 작업.
 *
 * 기존 시스템은 엑셀 17종·Zip·백업·DWG 변환을 요청 스레드에서 동기 실행해
 * 큰 건은 화면이 수십 초 멈췄다. 여기서는 전부 큐로 넘기고 SSE 로 진행률을 받는다.
 * 호출 측에서 보는 경로는 그대로이고, 응답만 202 {jobId} 로 바뀐다.
 */

export const JobKind = z.enum([
  'excel_export',
  'zip_build',
  'backup',
  'convert',
  'bulk_import',
  'mirror',
  'gc',
])
export type JobKind = z.infer<typeof JobKind>

export const JobDetail = z.object({
  id: z.number().int(),
  kind: z.string(),
  state: JobState,
  progress: z.number().int(),
  progressNote: z.string().nullable(),
  error: z.string().nullable(),
  /** 완료 시 결과 파일 정보 */
  resultFilename: z.string().nullable(),
  resultByteSize: z.number().int().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
})
export type JobDetail = z.infer<typeof JobDetail>

export const JobCreated = z.object({ jobId: z.number().int() })

/** 엑셀 내보내기 요청 — 목록 화면의 검색 조건을 그대로 넘긴다 */
export const ExcelExportRequest = z.object({
  target: z.enum(['tdb_documents', 'mdb_files', 'audit_log', 'distributions']),
  /** 화면의 현재 검색 조건. 서버가 같은 쿼리로 전량을 뽑는다. */
  filters: z.record(z.string(), z.unknown()).default({}),
  filename: z.string().max(200).optional(),
})

// 스키마에 대응하는 타입 — 화면에서 응답 타입을 그대로 쓴다
export type JobCreated = z.infer<typeof JobCreated>
export type ExcelExportRequest = z.infer<typeof ExcelExportRequest>
