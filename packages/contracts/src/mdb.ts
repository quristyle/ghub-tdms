import { z } from 'zod'
import { BoolParam, PageQuery, SortDir, pageResult } from './common.js'

/**
 * MDB — 설비 데이터북 (기존 화면 5·6).
 *
 * TDB 와 테이블도 화면 구성요소도 공유하지 않는다. MDB 는 리비전·반출·검수가 없는
 * **고정 기록**이라 같이 묶으면 양쪽 쿼리가 모두 복잡해진다(기존 시스템의 문제점).
 * 공유하는 것은 폴더 트리와 보관함 기구뿐이다.
 */

/** 기존 화면 라벨: 자료명 / 폴더명 / Tag No */
export const MdbSearchTarget = z.enum(['title', 'folder', 'tag'])

/** 정렬할 수 있는 칸. 서버가 정렬한다 (documents.ts 의 설명과 같은 이유). */
export const MdbSort = z.enum(['updatedAt', 'title', 'equipmentType', 'docType', 'year'])
export type MdbSort = z.infer<typeof MdbSort>

export const MdbListQuery = PageQuery.extend({
  sort: MdbSort.default('updatedAt'),
  dir: SortDir.default('desc'),
  folderId: z.coerce.number().int().optional(),
  recursive: BoolParam.default(true),
  q: z.string().max(200).optional(),
  searchTarget: MdbSearchTarget.default('title'),
  equipmentType: z.string().max(100).optional(),
  docType: z.string().max(100).optional(),
  projectId: z.coerce.number().int().optional(),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  /** 공용 / 전용 */
  shared: BoolParam.optional(),
  /** 확인필요만 보기 */
  needsCheck: BoolParam.optional(),
})
export type MdbListQuery = z.infer<typeof MdbListQuery>

export const MdbListItem = z.object({
  id: z.number().int(),
  title: z.string(),
  displayName: z.string(),
  folderId: z.number().int(),
  folderName: z.string(),
  fileExt: z.string(),
  byteSize: z.number().int(),
  equipmentType: z.string().nullable(),
  docType: z.string().nullable(),
  projectName: z.string().nullable(),
  year: z.number().int().nullable(),
  isShared: z.boolean(),
  needsCheck: z.boolean(),
  tagCount: z.number().int(),
  updatedAt: z.string(),
})
export type MdbListItem = z.infer<typeof MdbListItem>

export const MdbListResponse = pageResult(MdbListItem)
export type MdbListResponse = z.infer<typeof MdbListResponse>

export const MdbDetail = MdbListItem.extend({
  originalFilename: z.string(),
  note: z.string().nullable(),
  folderPath: z.array(z.object({ id: z.number().int(), name: z.string() })),
  tags: z.array(z.string()),
  uploadedBy: z.string().nullable(),
  createdAt: z.string(),
})
export type MdbDetail = z.infer<typeof MdbDetail>

/** 검색 화면의 선택지 — 설비유형·자료유형·공사·연도 */
export const MdbMeta = z.object({
  equipmentTypes: z.array(z.string()),
  docTypes: z.array(z.string()),
  projects: z.array(z.object({ id: z.number().int(), name: z.string() })),
  years: z.array(z.number().int()),
})
export type MdbMeta = z.infer<typeof MdbMeta>

/** Tag No 자동완성 */
export const TagSuggestResponse = z.object({ items: z.array(z.string()) })
export type TagSuggestResponse = z.infer<typeof TagSuggestResponse>

// ── 관리 ────────────────────────────────────────────────────────────────

export const MdbUpdateRequest = z.object({
  title: z.string().min(1).max(500).optional(),
  equipmentType: z.string().max(100).nullable().optional(),
  docType: z.string().max(100).nullable().optional(),
  projectId: z.number().int().nullable().optional(),
  year: z.number().int().min(1900).max(2200).nullable().optional(),
  isShared: z.boolean().optional(),
  needsCheck: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(100)).max(200).optional(),
})
export type MdbUpdateRequest = z.infer<typeof MdbUpdateRequest>

export const MdbMoveRequest = z.object({
  fileIds: z.array(z.number().int()).min(1).max(5000),
  targetFolderId: z.number().int(),
})
export type MdbMoveRequest = z.infer<typeof MdbMoveRequest>

/** 설비유형 일괄 변경 — 기존 화면의 전용 기능 */
export const MdbBulkEquipmentRequest = z.object({
  fileIds: z.array(z.number().int()).min(1).max(5000),
  equipmentType: z.string().max(100).nullable(),
})
export type MdbBulkEquipmentRequest = z.infer<typeof MdbBulkEquipmentRequest>

export const MdbBulkResult = z.object({
  updated: z.number().int(),
  skipped: z.array(z.object({ fileId: z.number().int(), reason: z.string() })),
})
export type MdbBulkResult = z.infer<typeof MdbBulkResult>

// ── Tag 이력 ────────────────────────────────────────────────────────────
//
// 설비 Tag 가 바뀌면(설비 교체·체계 변경·오기 정정) 그 자료들의 Tag 를 한꺼번에 고친다.
// 되돌릴 수 있어야 하므로 어느 자료의 어느 Tag 를 바꿨는지 낱낱이 남긴다.

export const TagHistoryState = z.enum(['DRAFT', 'APPLIED', 'REVERTED'])

export const TagHistory = z.object({
  id: z.number().int(),
  baseTag: z.string(),
  oldTag: z.string().nullable(),
  newTag: z.string().nullable(),
  reason: z.string().nullable(),
  reasonDetail: z.string().nullable(),
  projectName: z.string().nullable(),
  state: TagHistoryState,
  appliedCount: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  revertedAt: z.string().nullable(),
})
export type TagHistory = z.infer<typeof TagHistory>

export const TagHistoryListResponse = z.object({ items: z.array(TagHistory) })
export type TagHistoryListResponse = z.infer<typeof TagHistoryListResponse>

export const TagHistoryCreateRequest = z.object({
  baseTag: z.string().min(1).max(100),
  oldTag: z.string().max(100).nullable().default(null),
  newTag: z.string().min(1).max(100),
  reason: z.string().max(200).nullable().default(null),
  reasonDetail: z.string().max(2000).nullable().default(null),
  projectId: z.number().int().nullable().default(null),
  folderId: z.number().int().nullable().default(null),
})
export type TagHistoryCreateRequest = z.infer<typeof TagHistoryCreateRequest>

/** 적용 전에 "무엇이 바뀌는가" 를 먼저 보여준다 */
export const TagTargetsResponse = z.object({
  items: z.array(
    z.object({
      mdbFileId: z.number().int(),
      title: z.string(),
      folderName: z.string(),
      currentTag: z.string(),
    }),
  ),
})
export type TagTargetsResponse = z.infer<typeof TagTargetsResponse>

export const TagApplyResult = z.object({
  applied: z.number().int(),
  historyId: z.number().int(),
})
export type TagApplyResult = z.infer<typeof TagApplyResult>

export const TagRevertResult = z.object({
  reverted: z.number().int(),
})
export type TagRevertResult = z.infer<typeof TagRevertResult>
