import { z } from 'zod'
import { JobCreated } from './jobs.js'

/** 반입·검수 (기존 화면 2) */

// ── 검수 대기 ───────────────────────────────────────────────────────────

export const PendingFile = z.object({
  id: z.number().int(),
  fileExt: z.string(),
  displayName: z.string(),
  originalFilename: z.string(),
  byteSize: z.number().int(),
  /** 업체가 파일명에 적어 온 리비전 표기 (예: "Rev03") */
  vendorLabeledRev: z.string().nullable(),
  /** 그 표기가 시스템이 매긴 rev 와 다른가 */
  revMismatch: z.boolean(),
})

/** 한 줄 = 한 리비전 세트 (DWG+PDF 가 함께 올라온다) */
export const PendingReviewGroup = z.object({
  documentId: z.number().int(),
  drawingNo: z.string(),
  title: z.string(),
  folderName: z.string(),
  rev: z.number().int(),
  branch: z.string().nullable(),
  revLabel: z.string(),
  /** 반출 당시 Rev — 화면의 '반출Rev' 칸 */
  distributedRev: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  projectName: z.string().nullable(),
  uploadedAt: z.string(),
  uploadedBy: z.string().nullable(),
  files: z.array(PendingFile),
  /** 중복반출로 생긴 분기인가 */
  isBranch: z.boolean(),
  /** 분기면 (들어온 수 / 나간 수). 전부 들어와야 승인할 수 있다. */
  branchArrived: z.number().int().nullable(),
  branchExpected: z.number().int().nullable(),
  hasWarning: z.boolean(),
})
export type PendingReviewGroup = z.infer<typeof PendingReviewGroup>

export const PendingReviewResponse = z.object({ items: z.array(PendingReviewGroup) })
export type PendingReviewResponse = z.infer<typeof PendingReviewResponse>

export const ReviewRequest = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  note: z.string().max(2000).nullable().default(null),
})

export const ReviewResult = z.object({
  status: z.enum(['approved', 'rejected']),
  revLabel: z.string(),
  documentStatus: z.string(),
})

export const BulkReviewRequest = z.object({
  /** 세트 대표 파일 id 목록 */
  fileIds: z.array(z.number().int()).min(1).max(500),
  action: z.enum(['APPROVE', 'REJECT']),
  note: z.string().max(2000).nullable().default(null),
})

export const BulkReviewResult = z.object({
  done: z.number().int(),
  failed: z.array(z.object({ fileId: z.number().int(), message: z.string() })),
})

// ── 확인 필요 ───────────────────────────────────────────────────────────

export const ImportIssue = z.object({
  id: z.number().int(),
  filename: z.string(),
  originalFilename: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  reason: z.string(),
  reasonDetail: z.string().nullable(),
  vendorName: z.string().nullable(),
  projectName: z.string().nullable(),
  /** 파일명으로 짐작한 대상 자료 */
  suggestedDocumentId: z.number().int().nullable(),
  suggestedDrawingNo: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
})
export type ImportIssue = z.infer<typeof ImportIssue>

export const ImportIssueResponse = z.object({ items: z.array(ImportIssue) })

/** 경로 재선택 — 어느 자료에 붙일지 정해 준다 */
export const ResolveIssueRequest = z.object({
  documentId: z.number().int(),
  vendorName: z.string().min(1).max(200),
  projectId: z.number().int().nullable().default(null),
})

/** 재검수 — 파일은 그대로 두고 다시 검사한다 */
export const RecheckIssueResult = z.object({
  resolved: z.boolean(),
  documentId: z.number().int().nullable(),
  message: z.string(),
})

export const DiscardIssueRequest = z.object({
  note: z.string().max(2000).nullable().default(null),
})

// ── 중복반출 현황 ───────────────────────────────────────────────────────

export const DuplicateDistribution = z.object({
  distributionId: z.number().int(),
  vendorName: z.string(),
  projectName: z.string().nullable(),
  revAtDistribution: z.number().int(),
  distributedAt: z.string(),
  returnedAt: z.string().nullable(),
  /** 이 반출에 대응하는 반입본이 들어왔는가 */
  arrived: z.boolean(),
  branch: z.string().nullable(),
})

export const DuplicateDistributionResponse = z.object({
  documentId: z.number().int(),
  drawingNo: z.string(),
  /** 서로 다른 업체 수 — 2 이상이면 중복반출 */
  vendorCount: z.number().int(),
  items: z.array(DuplicateDistribution),
})

// ── 반입 등록 ───────────────────────────────────────────────────────────

/** 개별 자료 업로드 결과 (multipart 응답) */
export const UploadResult = z.object({
  documentId: z.number().int(),
  revLabel: z.string(),
  created: z.number().int(),
  /** 업체 표기 리비전과 다른 파일이 있었는가 */
  warning: z.boolean(),
  /** 중복반출로 분기가 생겼는가 */
  branched: z.boolean(),
  reason: z.string(),
})

/** Zip 대량 반입 — 워커로 넘긴다 */
export const ZipImportAccepted = JobCreated

// ── 병합본 첨부 후 승인 ─────────────────────────────────────────────────

export const BranchMergeResult = z.object({
  documentId: z.number().int(),
  revLabel: z.string(),
  closedBranches: z.number().int(),
})

// 스키마에 대응하는 타입 — 화면에서 응답 타입을 그대로 쓴다
export type ReviewRequest = z.infer<typeof ReviewRequest>
export type ReviewResult = z.infer<typeof ReviewResult>
export type BulkReviewRequest = z.infer<typeof BulkReviewRequest>
export type BulkReviewResult = z.infer<typeof BulkReviewResult>
export type ImportIssueResponse = z.infer<typeof ImportIssueResponse>
export type ResolveIssueRequest = z.infer<typeof ResolveIssueRequest>
export type RecheckIssueResult = z.infer<typeof RecheckIssueResult>
export type DiscardIssueRequest = z.infer<typeof DiscardIssueRequest>
export type DuplicateDistributionResponse = z.infer<typeof DuplicateDistributionResponse>
export type UploadResult = z.infer<typeof UploadResult>
export type ZipImportAccepted = z.infer<typeof ZipImportAccepted>
export type BranchMergeResult = z.infer<typeof BranchMergeResult>
