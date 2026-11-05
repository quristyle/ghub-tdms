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

// ── 자료 교체 · 신규 등록 · Zip 폴더 업로드 ─────────────────────────────
//
// 전부 multipart 라 요청 본문 스키마는 없고 응답만 계약으로 둔다.
// 확인이 필요한 경우(같은 형식 2개, 이름 불일치, 원본·사본 한쪽만 등)는 아무것도 바꾸지 않고
// needsConfirmation 으로 돌려보낸다 — 화면이 확인창을 띄운 뒤 confirm* 필드를 켜서 다시 보낸다.
// (기존 editor.py 의 needs_confirmation 흐름 그대로)

/** 원본·사본 중 한쪽만 있는 자료 — 확인창 표와 엑셀 내보내기에 그대로 쓴다 */
export const PartialItem = z.object({
  stem: z.string(),
  ext: z.string(),
  /** Zip 안 폴더 경로 (Zip 등록만) */
  folder: z.string().nullable().default(null),
})
export type PartialItem = z.infer<typeof PartialItem>

/** 같은 형식 파일이 2개 이상이라 어느 게 맞는지 알 수 없는 자료 */
export const DuplicateGroup = z.object({
  stem: z.string(),
  folder: z.string().nullable().default(null),
  exts: z.array(z.string()),
})
export type DuplicateGroup = z.infer<typeof DuplicateGroup>

/** 같은 이름·같은 형식이 이미 있어 올리지 않은 것 (내용을 바꾸려면 자료 교체) */
export const AlreadyExists = z.object({ stem: z.string(), exts: z.array(z.string()) })

export const ReplaceResult = z.object({
  needsConfirmation: z.boolean(),
  message: z.string(),
  documentId: z.number().int().nullable(),
  rev: z.number().int().nullable(),
  fileCount: z.number().int(),
  duplicateExts: z.array(z.string()),
})
export type ReplaceResult = z.infer<typeof ReplaceResult>

export const ReplaceBulkResult = z.object({
  needsConfirmation: z.boolean(),
  message: z.string(),
  replaced: z.number().int(),
  duplicateExts: z.array(z.string()),
  /** 선택했는데 짝 파일이 없는 자료 / 첨부했는데 맞는 자료가 없는 파일 */
  unmatchedDocs: z.array(z.string()),
  unmatchedFiles: z.array(z.string()),
  partial: z.array(PartialItem),
})
export type ReplaceBulkResult = z.infer<typeof ReplaceBulkResult>

export const ExistingRevQuery = z.object({
  folderId: z.coerce.number().int(),
  stem: z.string().max(255),
})

export const ExistingRevLookup = z.object({
  found: z.boolean(),
  documentId: z.number().int().nullable(),
  currentRev: z.number().int().nullable(),
  /** 그 자료가 이미 갖고 있는 형식 */
  exts: z.array(z.string()),
})
export type ExistingRevLookup = z.infer<typeof ExistingRevLookup>

export const RegisterResult = z.object({
  needsConfirmation: z.boolean(),
  message: z.string(),
  created: z.number().int(),
  /** 같은 이름의 기존 자료에 붙인 파일 수 */
  attached: z.number().int(),
  alreadyExists: z.array(AlreadyExists),
  duplicates: z.array(DuplicateGroup),
  partial: z.array(PartialItem),
})
export type RegisterResult = z.infer<typeof RegisterResult>

/**
 * Zip 폴더 업로드 — 확인이 필요하면 200 으로 이 응답을, 바로 진행하면 202 {jobId} 를 준다.
 * 다시 보낼 때는 Zip 을 또 올리지 않고 token 만 보낸다 (30분 유효).
 */
export const ZipRegisterCheck = z.object({
  needsConfirmation: z.literal(true),
  token: z.string(),
  /** 상위 폴더로 빠져나가려는 이름(..)이 든 경로 — 진행해도 그 조각은 버린다 */
  unsafePaths: z.array(z.string()),
  duplicates: z.array(DuplicateGroup),
  partial: z.array(PartialItem),
  /** 자동으로 합친 DWG·PDF 짝 폴더 */
  pairFolders: z.array(z.string()),
})
export type ZipRegisterCheck = z.infer<typeof ZipRegisterCheck>

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
export type ExistingRevQuery = z.infer<typeof ExistingRevQuery>
export type AlreadyExists = z.infer<typeof AlreadyExists>
