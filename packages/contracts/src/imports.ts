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
  /** 지금 승인된 리비전의 PDF — [비교]의 왼쪽(반출본) */
  currentPdfFileId: z.number().int().nullable(),
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

export const ImportIssueFile = z.object({
  filename: z.string(),
  ext: z.string(),
  byteSize: z.number().int().nullable(),
  /** Zip 안 폴더 (재첨부·개별 업로드면 null) */
  folder: z.string().nullable(),
})

export const ImportIssue = z.object({
  id: z.number().int(),
  filename: z.string(),
  originalFilename: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  /** 사유 코드를 쉼표로 이은 것 (예: "PATH_MISMATCH,PDF_MISSING") */
  reason: z.string(),
  reasonDetail: z.string().nullable(),
  /** 사유 코드 목록 — 라벨은 REASON_LABELS */
  reasons: z.array(z.string()),
  /** [사유상세] 문장 */
  detailText: z.string(),
  /** 목록의 자료명 — 대상 자료가 정해졌으면 그 자료명(꼬리 포함), 아니면 받은 파일 이름 */
  displayName: z.string(),
  files: z.array(ImportIssueFile),
  hasPdf: z.boolean(),
  vendorName: z.string().nullable(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  /** 대상 자료 (반입 진단·경로 재선택으로 정해진 것) */
  suggestedDocumentId: z.number().int().nullable(),
  suggestedDrawingNo: z.string().nullable(),
  /** 대상 자료의 폴더 경로 */
  folderPath: z.string().nullable(),
  /** 대상 자료의 지금 승인된 PDF — [비교]의 왼쪽 */
  currentPdfFileId: z.number().int().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
})
export type ImportIssue = z.infer<typeof ImportIssue>

export const ImportIssueResponse = z.object({ items: z.array(ImportIssue) })

/**
 * 경로 재선택 — 이 파일이 실제로 어느 자료인지 정해 둔다.
 * 등록은 [재검수]에서 한다 — 재첨부와 경로 재선택을 둘 다 한 뒤 한 번에 다시 검사하기 위해서다.
 */
export const ResolveIssueRequest = z.object({
  documentId: z.number().int(),
})

export const ResolveIssueResult = z.object({
  documentId: z.number().int(),
  drawingNo: z.string(),
  message: z.string(),
})

/** 자료 재첨부 결과 — 파일만 갈아끼운다. 다시 검사는 [재검수]가 한다. */
export const ReattachIssueResult = z.object({
  fileCount: z.number().int(),
  message: z.string(),
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

/** Zip 반입 · 반입 자료(선택 반출 건) — 작업으로 넘기고 진행률은 /jobs/:id/stream 으로 본다 */
export const ZipImportAccepted = JobCreated

/** 반입 실행 결과 — 작업(jobs.result)에 남는다 */
export const ImportRunResult = z.object({
  matched: z.array(z.object({
    documentId: z.number().int(),
    drawingNo: z.string(),
    revLabel: z.string(),
    fileCount: z.number().int(),
    branched: z.boolean(),
  })),
  issues: z.array(z.object({
    drawingNo: z.string(),
    reasons: z.array(z.string()),
    reasonText: z.string(),
  })),
  /** 받지 않은 파일 (형식이 맞지 않는 것 등) */
  skipped: z.array(z.string()),
  message: z.string(),
})
export type ImportRunResult = z.infer<typeof ImportRunResult>

/** 반입 자료 — 반출 건 선택 팝업의 한 줄 (기존 /distributions/for-import) */
export const ImportTargetStatus = z.enum(['INCOMPLETE', 'REVIEWING', 'DONE'])
export const ImportTarget = z.object({
  distributionId: z.number().int(),
  documentId: z.number().int(),
  drawingNo: z.string(),
  /** 반출 당시 이름 — `도면번호_Rev00` */
  displayName: z.string(),
  title: z.string(),
  folderPath: z.string(),
  revAtDistribution: z.number().int(),
  vendorName: z.string(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  zipName: z.string().nullable(),
  distributedAt: z.string(),
  hasDwg: z.boolean(),
  hasPdf: z.boolean(),
  hasXlsx: z.boolean(),
  hasEtc: z.boolean(),
  status: ImportTargetStatus,
})
export type ImportTarget = z.infer<typeof ImportTarget>

export const ImportTargetQuery = z.object({
  /** 없으면 반입 미완료 건 전체 (업체·공사 드롭다운 구성용) */
  vendorName: z.string().max(200).optional(),
  projectId: z.coerce.number().int().optional(),
  dateFrom: z.string().max(30).optional(),
  dateTo: z.string().max(30).optional(),
})
export type ImportTargetQuery = z.infer<typeof ImportTargetQuery>

export const ImportTargetResponse = z.object({ items: z.array(ImportTarget) })
export type ImportTargetResponse = z.infer<typeof ImportTargetResponse>

/** 반입 화면의 고르기 목록 (업체·공사) */
export const ImportOptions = z.object({
  vendors: z.array(z.object({ id: z.number().int(), name: z.string() })),
  projects: z.array(z.object({ id: z.number().int(), name: z.string() })),
})
export type ImportOptions = z.infer<typeof ImportOptions>

/** 신규 자료 등록 결과 — Rev00 승인·현재본으로 바로 들어간다 */
export const RegisterNewResult = z.object({
  documentId: z.number().int(),
  drawingNo: z.string(),
  revLabel: z.string(),
  fileCount: z.number().int(),
})
export type RegisterNewResult = z.infer<typeof RegisterNewResult>

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
export type ResolveIssueResult = z.infer<typeof ResolveIssueResult>
export type ReattachIssueResult = z.infer<typeof ReattachIssueResult>
export type RecheckIssueResult = z.infer<typeof RecheckIssueResult>
export type DiscardIssueRequest = z.infer<typeof DiscardIssueRequest>
export type DuplicateDistributionResponse = z.infer<typeof DuplicateDistributionResponse>
export type UploadResult = z.infer<typeof UploadResult>
export type ZipImportAccepted = z.infer<typeof ZipImportAccepted>
export type BranchMergeResult = z.infer<typeof BranchMergeResult>
