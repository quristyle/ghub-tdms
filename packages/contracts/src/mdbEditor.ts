import { z } from 'zod'

/**
 * MDB 관리 — 등록 · Zip 폴더 업로드 · 파일 교체 · 원본·사본 폴더 병합 · 미분류 정리 ·
 * 값 목록(설비유형 / 자료유형 / Tag No 변경사유) 관리 · Tag 이력 보강.
 *
 * MDB 의 "자료 1건" 은 **같은 폴더 + 같은 자료명(대소문자까지 정확히)** 인 파일 행들이다
 * (A.xlsx + A.pdf = 자료 1건). 기존 mdb_group.py 의 정의를 그대로 따른다.
 */

// ── 등록 / Zip 폴더 업로드 ───────────────────────────────────────────────

/** 한 자료에 같은 형식이 2개 이상 — 어느 게 맞는지 시스템이 판단할 수 없어 먼저 묻는다 */
export const MdbDuplicateGroup = z.object({
  folder: z.string(),
  stem: z.string(),
  exts: z.array(z.string()),
})
export type MdbDuplicateGroup = z.infer<typeof MdbDuplicateGroup>

export const MdbRegisterResult = z.object({
  /** 새로 만든 자료 수 */
  created: z.number().int(),
  /** 기존 자료에 채워 넣은 파일 수 */
  attached: z.number().int(),
  /** 이미 있어 건너뛴 것 · 받을 수 없어 건너뛴 것 */
  skipped: z.array(z.string()),
  /** 같은 이름·같은 형식이 2개 이상이라 확인이 필요하다 (아무것도 등록하지 않았다) */
  needsConfirmation: z.boolean(),
  duplicates: z.array(MdbDuplicateGroup),
})
export type MdbRegisterResult = z.infer<typeof MdbRegisterResult>

/** Zip 폴더 업로드 작업이 끝났을 때 jobs.result 에 남는 값 */
export const MdbZipRegisterJobResult = z.object({
  created: z.number().int(),
  attached: z.number().int(),
  foldersCreated: z.number().int(),
  skipped: z.array(z.string()),
})
export type MdbZipRegisterJobResult = z.infer<typeof MdbZipRegisterJobResult>

/** 파일 교체 — 같은 형식이면 내용만 바꾸고, 없는 형식이면 그 자료에 새로 붙인다 */
export const MdbReplaceResult = z.object({
  fileId: z.number().int(),
  added: z.boolean(),
  message: z.string(),
})
export type MdbReplaceResult = z.infer<typeof MdbReplaceResult>

// ── 원본·사본(DWG·PDF) 폴더 병합 ────────────────────────────────────────

export const MdbPairCandidate = z.object({
  parentId: z.number().int(),
  parentName: z.string(),
  /** 최상위부터 이어 붙인 경로 (표시용) */
  parentPath: z.string(),
  dwgFolderId: z.number().int(),
  dwgFolderName: z.string(),
  pdfFolderId: z.number().int(),
  pdfFolderName: z.string(),
  dwgCount: z.number().int(),
  pdfCount: z.number().int(),
  /** 양쪽에 대소문자까지 같은 이름으로 있어 합칠 수 있는 자료 수 */
  mergeableCount: z.number().int(),
  /** 대소문자만 달라 짝으로 안 잡힌 이름 쌍 — CM 이 이름을 바로잡도록 알린다 */
  caseMismatchCount: z.number().int(),
  caseMismatchNames: z.array(z.string()),
})
export type MdbPairCandidate = z.infer<typeof MdbPairCandidate>

export const MdbPairCandidateResponse = z.object({ items: z.array(MdbPairCandidate) })
export type MdbPairCandidateResponse = z.infer<typeof MdbPairCandidateResponse>

export const MdbPairMergeRequest = z.object({
  parentIds: z.array(z.number().int()).min(1).max(500),
})
export type MdbPairMergeRequest = z.infer<typeof MdbPairMergeRequest>

export const MdbPairMergeResult = z.object({
  merged: z.number().int(),
  skipped: z.array(z.object({ parentId: z.number().int(), name: z.string(), reason: z.string() })),
})
export type MdbPairMergeResult = z.infer<typeof MdbPairMergeResult>

// ── 미분류 자료 정리 ────────────────────────────────────────────────────

/**
 * 분류는 저장값이 아니라 Tag No · 설비유형으로 정해진다 (기존 mdb_group.py 규칙).
 *   전용     = Tag No 가 붙음
 *   공용     = Tag No 는 없고 설비유형만 있음
 *   확인필요 = 둘 다 없음
 */
export const MdbCategory = z.enum(['UNCHECKED', 'SHARED', 'DEDICATED'])
export type MdbCategory = z.infer<typeof MdbCategory>

export const MdbUnclassifiedQuery = z.object({
  category: z.enum(['UNCHECKED', 'SHARED', 'DEDICATED', 'ALL']).default('UNCHECKED'),
  projectId: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
})
export type MdbUnclassifiedQuery = z.infer<typeof MdbUnclassifiedQuery>

export const MdbUnclassifiedItem = z.object({
  /** 대표 파일 id (자료의 첫 파일) */
  id: z.number().int(),
  title: z.string(),
  folderId: z.number().int(),
  folderName: z.string(),
  year: z.number().int().nullable(),
  projectName: z.string().nullable(),
  exts: z.array(z.string()),
  equipmentType: z.string().nullable(),
  docType: z.string().nullable(),
  tagCount: z.number().int(),
  category: MdbCategory,
})
export type MdbUnclassifiedItem = z.infer<typeof MdbUnclassifiedItem>

export const MdbUnclassifiedResponse = z.object({
  items: z.array(MdbUnclassifiedItem),
  total: z.number().int(),
})
export type MdbUnclassifiedResponse = z.infer<typeof MdbUnclassifiedResponse>

// ── 값 목록 (설비유형 / 자료유형 / Tag No 변경사유) ────────────────────────

/** 주소 앞머리와 같다: /equipment-types · /mdb-doc-types · /mdb-tag-reasons */
export const TypeListKind = z.enum(['equipment-types', 'mdb-doc-types', 'mdb-tag-reasons'])
export type TypeListKind = z.infer<typeof TypeListKind>

export const TypeListItem = z.object({
  id: z.number().int(),
  name: z.string(),
  isHidden: z.boolean(),
})
export type TypeListItem = z.infer<typeof TypeListItem>

export const TypeListResponse = z.object({ items: z.array(TypeListItem) })
export type TypeListResponse = z.infer<typeof TypeListResponse>

export const TypeListQuery = z.object({
  includeHidden: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

export const TypeNameRequest = z.object({ name: z.string().min(1).max(100) })
export type TypeNameRequest = z.infer<typeof TypeNameRequest>

export const TypeRenameResult = z.object({
  item: TypeListItem,
  /** 이 이름을 들고 있던 자료 중 함께 갈아끼운 파일 수 (변경사유는 늘 0) */
  updatedFiles: z.number().int(),
})
export type TypeRenameResult = z.infer<typeof TypeRenameResult>

// ── Tag 이력 보강 ───────────────────────────────────────────────────────

export const TagHistoryMeta = z.object({
  /** 고를 수 있는 변경사유 (숨긴 것 제외) */
  reasons: z.array(z.string()),
  /** 이력에 실제로 적힌 등록 연도 · 공사 — 목록 거르기용 */
  years: z.array(z.number().int()),
  projects: z.array(z.string()),
})
export type TagHistoryMeta = z.infer<typeof TagHistoryMeta>

/** 등록 팝업의 공사 드롭다운 — MDB 폴더 트리 최상위 폴더 */
export const TagProjectFolder = z.object({
  folderId: z.number().int(),
  name: z.string(),
  /** "2016. 03. - 공사명" 처럼 앞에 붙은 연도 */
  year: z.number().int().nullable(),
})
export const TagProjectFolderResponse = z.object({ items: z.array(TagProjectFolder) })
export type TagProjectFolderResponse = z.infer<typeof TagProjectFolderResponse>

export const TagPreviewQuery = z.object({
  tag: z.string().min(1).max(100),
  folderId: z.coerce.number().int().optional(),
})

/**
 * 이력 수정. 적용 전(DRAFT)은 무엇이든 고칠 수 있고, 적용된 이력의 Tag·범위를 고치면
 * 예전 적용분을 되돌린 뒤 새 내용으로 다시 적용한다 (기존 화면 규칙).
 * `note` 는 예전 호출(비고만 수정)과의 호환용 — reasonDetail 과 같다.
 */
export const TagHistoryUpdateRequest = z.object({
  baseTag: z.string().min(1).max(100).optional(),
  newTag: z.string().min(1).max(100).optional(),
  reason: z.string().max(200).nullable().optional(),
  reasonDetail: z.string().max(2000).nullable().optional(),
  folderId: z.number().int().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
})
export type TagHistoryUpdateRequest = z.infer<typeof TagHistoryUpdateRequest>
