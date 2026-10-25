import { z } from 'zod'
import { PageQuery, pageResult } from './common.js'
import { DistributionPurpose } from './history.js'

/**
 * 반출이력 (기존 화면 4).
 *
 * 협력사는 시스템에 들어오지 않는다 — CM 이 Zip 으로 묶어 반출하고, 수정본을 받아 반입한다.
 * 그래서 "반출"은 사람이 들고 나간 사본의 기록이고, 반납은 반입·검수와 맞물린다.
 */

/** 화면 라벨: 반입완료 / 반입미완료 / 확인필요 / 검수대기 */
export const DistributionState = z.enum(['DONE', 'INCOMPLETE', 'ISSUE', 'REVIEWING'])
export type DistributionState = z.infer<typeof DistributionState>

export const DISTRIBUTION_STATE_LABEL: Record<DistributionState, string> = {
  DONE: '반입완료',
  INCOMPLETE: '반입미완료',
  ISSUE: '확인필요',
  REVIEWING: '검수대기',
}

export const PURPOSE_LABEL: Record<string, string> = {
  MODIFY: '수정용',
  REFERENCE: '참조용',
  ETC: '기타',
}

// ── 목록 (자료별) ───────────────────────────────────────────────────────

export const DistributionListQuery = PageQuery.extend({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  vendorId: z.coerce.number().int().optional(),
  projectId: z.coerce.number().int().optional(),
  purpose: DistributionPurpose.optional(),
  state: DistributionState.optional(),
  /** 반출자. 'screen.tdb_distributions.viewer.other_user' 가 없으면 자기 것만 볼 수 있다. */
  distributedBy: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
})
export type DistributionListQuery = z.infer<typeof DistributionListQuery>

export const DistributionRow = z.object({
  id: z.number().int(),
  documentId: z.number().int().nullable(),
  /** 자료가 완전 삭제돼도 무엇이었는지 알 수 있는 스냅샷 */
  documentLabel: z.string(),
  title: z.string().nullable(),
  revAtDistribution: z.number().int(),
  vendorName: z.string(),
  projectName: z.string().nullable(),
  purpose: DistributionPurpose,
  purposeNote: z.string().nullable(),
  zipName: z.string().nullable(),
  distributedBy: z.string().nullable(),
  distributedAt: z.string(),
  returnedAt: z.string().nullable(),
  returnNote: z.string().nullable(),
  manualReturn: z.boolean(),
  note: z.string().nullable(),
  state: DistributionState,
  /** 나간 지 며칠 됐는가 (미반납만) */
  daysOut: z.number().int().nullable(),
})
export type DistributionRow = z.infer<typeof DistributionRow>

export const DistributionListResult = pageResult(DistributionRow)
export type DistributionListResult = z.infer<typeof DistributionListResult>

// ── 목록 (Zip 별) ───────────────────────────────────────────────────────

export const ZipExportRow = z.object({
  zipName: z.string(),
  vendorName: z.string(),
  projectName: z.string().nullable(),
  purpose: DistributionPurpose,
  distributedBy: z.string().nullable(),
  distributedAt: z.string(),
  itemCount: z.number().int(),
  returnedCount: z.number().int(),
  /** 전부 돌아왔는가 */
  complete: z.boolean(),
})
export type ZipExportRow = z.infer<typeof ZipExportRow>

export const ZipExportListResult = z.object({ items: z.array(ZipExportRow) })
export type ZipExportListResult = z.infer<typeof ZipExportListResult>

/** Zip 묶음 하나의 상세 — 어느 자료가 돌아왔고 어느 것이 남았는가 */
export const ZipStatusResult = z.object({
  zipName: z.string(),
  vendorName: z.string(),
  itemCount: z.number().int(),
  returnedCount: z.number().int(),
  items: z.array(DistributionRow),
})
export type ZipStatusResult = z.infer<typeof ZipStatusResult>

// ── 미입고 현황 ─────────────────────────────────────────────────────────
//
// "곧 바뀔 수 있는" 반출 건. 두 가지를 함께 센다 (기존 2026-08-14 CM 확정)
//   ① 아직 안 돌아온 것
//   ② 돌아왔지만 아직 검수 전인 것 — 승인되는 순간 리비전이 바뀐다
// 검수까지 끝난 것은 더 이상 "곧 바뀔" 상태가 아니므로 빠진다.

export const OutstandingSummary = z.object({
  total: z.number().int(),
  notReturned: z.number().int(),
  reviewing: z.number().int(),
  /** 가장 오래 나가 있는 건의 일수 */
  oldestDays: z.number().int().nullable(),
  byVendor: z.array(z.object({ vendorName: z.string(), count: z.number().int() })),
})
export type OutstandingSummary = z.infer<typeof OutstandingSummary>

export const OutstandingResult = z.object({
  items: z.array(DistributionRow),
  summary: OutstandingSummary,
})
export type OutstandingResult = z.infer<typeof OutstandingResult>

// ── 반입 대상 ───────────────────────────────────────────────────────────
// 한 업체·공사가 수정용으로 반출한 목록 + 반입 진행 상태. 반입미완료만 반입 대상이 된다.

export const ForImportQuery = z.object({
  vendorId: z.coerce.number().int().optional(),
  vendorName: z.string().max(200).optional(),
  projectId: z.coerce.number().int().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  state: DistributionState.optional(),
})
export type ForImportQuery = z.infer<typeof ForImportQuery>

export const ForImportResult = z.object({ items: z.array(DistributionRow) })
export type ForImportResult = z.infer<typeof ForImportResult>

// ── 반납 처리 ───────────────────────────────────────────────────────────

export const ReturnRequest = z.object({
  distributionIds: z.array(z.number().int()).min(1).max(1000),
  /**
   * 수정 없이 반납 — 업체가 손대지 않고 그대로 돌려준 경우.
   * 별도 권한(screen.tdb_distributions.confirm.manual_return)이 필요하다.
   */
  manual: z.boolean().default(false),
  note: z.string().max(2000).nullable().default(null),
})
export type ReturnRequest = z.infer<typeof ReturnRequest>

export const ReturnResult = z.object({
  returned: z.number().int(),
  skipped: z.array(z.object({ id: z.number().int(), reason: z.string() })),
})
export type ReturnResult = z.infer<typeof ReturnResult>

// ── 반출 실행 ───────────────────────────────────────────────────────────

export const CreateDistributionRequest = z.object({
  documentIds: z.array(z.number().int()).min(1).max(5000),
  vendorId: z.number().int().nullable().default(null),
  vendorName: z.string().min(1).max(200),
  projectId: z.number().int().nullable().default(null),
  purpose: DistributionPurpose,
  purposeNote: z.string().max(500).nullable().default(null),
  /** Zip 안에서 원본 폴더 구조를 유지할지 */
  keepPaths: z.boolean().default(true),
})
export type CreateDistributionRequest = z.infer<typeof CreateDistributionRequest>

export const CreateDistributionResult = z.object({
  zipName: z.string(),
  created: z.number().int(),
  /** Zip 을 만드는 작업 — 진행률은 SSE 로 받는다 */
  jobId: z.number().int(),
  /** 이미 다른 업체가 수정 중인 자료 — 막지 않고 경고만 한다 */
  duplicateWarnings: z.array(
    z.object({
      documentId: z.number().int(),
      drawingNo: z.string(),
      vendorName: z.string(),
      distributedAt: z.string(),
    }),
  ),
})
export type CreateDistributionResult = z.infer<typeof CreateDistributionResult>

// ── 검색 보조 ───────────────────────────────────────────────────────────

export const FilterOptions = z.object({
  vendors: z.array(z.object({ id: z.number().int(), name: z.string() })),
  projects: z.array(z.object({ id: z.number().int(), name: z.string() })),
  distributors: z.array(z.object({ id: z.number().int(), name: z.string() })),
  /** 다른 사용자를 고를 수 있는가 (screen.tdb_distributions.viewer.other_user) */
  canSelectOtherUser: z.boolean(),
})
export type FilterOptions = z.infer<typeof FilterOptions>
