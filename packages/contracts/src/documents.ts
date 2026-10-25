import { z } from 'zod'
import { BoolParam, PageQuery, pageResult } from './common.js'

/** 기존 화면의 상태·보유·검색대상 필터를 그대로 옮긴 것 */

export const DocStatus = z.enum(['ACTIVE', 'PENDING', 'SUPERSEDED', 'MERGE_REQUIRED', 'RETIRED'])
export type DocStatus = z.infer<typeof DocStatus>

/** 기존 화면 라벨: 전체 / 정상 / 검수 / 반출 / 삭제 */
export const StatusFilter = z.enum(['all', 'normal', 'review', 'distributed', 'archived'])

/** 기존 화면 라벨: 원본/사본 있음 / 원본만 있음 / 사본만 있음 */
export const HoldFilter = z.enum(['all', 'both', 'dwg_only', 'pdf_only'])

/** 기존 화면 라벨: 자료명 / 폴더명 */
export const SearchTarget = z.enum(['title', 'folder'])

export const DocumentListQuery = PageQuery.extend({
  folderId: z.coerce.number().int().optional(),
  /** 하위 폴더까지 포함할지. 기본 true (기존 트리 탐색 동작) */
  recursive: BoolParam.default(true),
  q: z.string().max(200).optional(),
  searchTarget: SearchTarget.default('title'),
  /** Isometric 보기 — 기본 false. 전체의 63%라 켜면 목록이 뒤덮인다 */
  includeIsometric: BoolParam.default(false),
  status: StatusFilter.default('all'),
  hold: HoldFilter.default('all'),
  projectId: z.coerce.number().int().optional(),
  rev: z.coerce.number().int().optional(),
  docType: z.string().max(100).optional(),
})
export type DocumentListQuery = z.infer<typeof DocumentListQuery>

export const DocumentListItem = z.object({
  id: z.number().int(),
  drawingNo: z.string(),
  title: z.string(),
  folderId: z.number().int(),
  folderName: z.string(),
  docType: z.string().nullable(),
  currentRev: z.number().int(),
  status: DocStatus,
  isIsometric: z.boolean(),
  hasDwg: z.boolean(),
  hasPdf: z.boolean(),
  hasXlsx: z.boolean(),
  hasEtc: z.boolean(),
  updatedAt: z.string(),
  /** 대여중 표시 — LATERAL 로 목록 쿼리 한 번에 가져온다(N+1 금지) */
  lentTo: z.string().nullable(),
  lentAt: z.string().nullable(),
})
export type DocumentListItem = z.infer<typeof DocumentListItem>

export const DocumentListResponse = pageResult(DocumentListItem)
export type DocumentListResponse = z.infer<typeof DocumentListResponse>

export const DocumentFile = z.object({
  id: z.number().int(),
  rev: z.number().int(),
  branch: z.string().nullable(),
  fileExt: z.string(),
  displayName: z.string(),
  byteSize: z.number().int(),
  reviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ISSUE']),
  isCurrent: z.boolean(),
  uploadedAt: z.string(),
  uploadedBy: z.string().nullable(),
  note: z.string().nullable(),
})

export const DocumentDetail = DocumentListItem.extend({
  category: z.string().nullable(),
  discipline: z.string().nullable(),
  isblOsbl: z.string().nullable(),
  elevation: z.string().nullable(),
  area: z.string().nullable(),
  equipmentTag: z.string().nullable(),
  projectName: z.string().nullable(),
  folderPath: z.array(z.object({ id: z.number().int(), name: z.string() })),
  note: z.string().nullable(),
  files: z.array(DocumentFile),
})
export type DocumentDetail = z.infer<typeof DocumentDetail>
