import { z } from 'zod'

/**
 * TDB 관리 (기존 화면 3).
 *
 * 폴더가 1급 테이블이라 이름 변경·이동이 DB 작업만으로 끝난다.
 * 기존 시스템은 documents.source_path 문자열이어서 수천 row UPDATE + 디스크 이동이 함께 돌았다.
 */

// 폴더 변경 스키마(FolderCreateRequest / FolderRenameRequest / FolderReparentRequest /
// FolderMutationResult)는 폴더 도메인 소관이라 folders.ts 에 있다. 여기서 다시 정의하지 않는다.

// ── 자료 편집 ───────────────────────────────────────────────────────────

export const DocumentRenameRequest = z.object({
  drawingNo: z.string().min(1).max(255).optional(),
  title: z.string().min(1).max(500).optional(),
  note: z.string().max(2000).nullable().optional(),
})

export const DocumentMoveRequest = z.object({
  documentIds: z.array(z.number().int()).min(1).max(5000),
  targetFolderId: z.number().int(),
})

export const DocumentMoveResult = z.object({
  moved: z.number().int(),
  /** 대상 폴더에 같은 이름이 이미 있어 건너뛴 것 */
  skipped: z.array(z.object({ documentId: z.number().int(), reason: z.string() })),
})

// ── 보관함 2종 ──────────────────────────────────────────────────────────
//
// 삭제 — 오류 등으로 없애는 것. 폴더째 묶어 한 줄. 복구 + 완전 삭제 가능.
// 폐기 — 리비전이 진행되며 최신본에서 빠진 것. 자료 1건 = 이력 1건. 복구만 가능.

export const ArchiveKind = z.enum(['TRASH', 'RETIRE'])
export type ArchiveKind = z.infer<typeof ArchiveKind>

export const ArchiveRequest = z.object({
  documentIds: z.array(z.number().int()).max(5000).default([]),
  /** 폴더째 보낼 때 (삭제 보관함만) */
  folderId: z.number().int().nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
})

export const ArchiveResult = z.object({
  /** 삭제는 묶음 하나, 폐기는 자료마다 하나 */
  batchIds: z.array(z.number().int()),
  archived: z.number().int(),
})

export const ArchiveBatch = z.object({
  id: z.number().int(),
  kind: ArchiveKind,
  label: z.string(),
  originalPath: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  itemCount: z.number().int(),
  archivedAt: z.string(),
  archivedBy: z.string().nullable(),
})
export type ArchiveBatch = z.infer<typeof ArchiveBatch>

export const ArchiveListResponse = z.object({
  items: z.array(ArchiveBatch),
  count: z.number().int(),
})

export const RestoreResult = z.object({
  restored: z.number().int(),
  /** 원래 자리가 사라져 되돌리지 못한 것 */
  blocked: z.array(z.object({ batchId: z.number().int(), reason: z.string() })),
})

/** 완전 삭제 — 삭제 보관함에만 있다. 폐기 보관함에는 없다. */
export const PurgeRequest = z.object({
  batchIds: z.array(z.number().int()).min(1).max(500),
  /** 되돌릴 수 없으므로 한 번 더 확인한다 */
  confirm: z.literal(true),
})

export const PurgeResult = z.object({
  purged: z.number().int(),
  freedBytes: z.number().int(),
})

// ── 원본·사본 분리 폴더 병합 ────────────────────────────────────────────
//
// 원본 공유폴더에서 DWG 와 PDF 가 각각 다른 폴더로 갈려 있던 경우.
// 화면에서는 한 건으로 합쳐 보여야 한다.

export const PairFolderCandidate = z.object({
  parentId: z.number().int(),
  parentName: z.string(),
  dwgFolderId: z.number().int(),
  pdfFolderId: z.number().int(),
  /** 양쪽에 같은 이름으로 있는 자료 수 */
  matchedCount: z.number().int(),
  dwgOnly: z.number().int(),
  pdfOnly: z.number().int(),
})

export const PairFolderCandidateResponse = z.object({ items: z.array(PairFolderCandidate) })

export const PairFolderMergeRequest = z.object({
  parentId: z.number().int(),
  dwgFolderId: z.number().int(),
  pdfFolderId: z.number().int(),
})

export const PairFolderMergeResult = z.object({
  merged: z.number().int(),
  skipped: z.number().int(),
})

// 스키마에 대응하는 타입
export type DocumentRenameRequest = z.infer<typeof DocumentRenameRequest>
export type DocumentMoveRequest = z.infer<typeof DocumentMoveRequest>
export type DocumentMoveResult = z.infer<typeof DocumentMoveResult>
export type ArchiveRequest = z.infer<typeof ArchiveRequest>
export type ArchiveResult = z.infer<typeof ArchiveResult>
export type ArchiveListResponse = z.infer<typeof ArchiveListResponse>
export type RestoreResult = z.infer<typeof RestoreResult>
export type PurgeRequest = z.infer<typeof PurgeRequest>
export type PurgeResult = z.infer<typeof PurgeResult>
export type PairFolderCandidateResponse = z.infer<typeof PairFolderCandidateResponse>
export type PairFolderMergeRequest = z.infer<typeof PairFolderMergeRequest>
export type PairFolderMergeResult = z.infer<typeof PairFolderMergeResult>
