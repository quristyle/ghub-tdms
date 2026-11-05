import { z } from 'zod'
import { DocClass } from './common.js'

/**
 * 마크업 보관 (기존 '즐겨찾기' → '사용자 보관 목록').
 *
 * 기존 시스템은 그린 내용을 `즐겨찾기/` 폴더의 JSON 파일로 저장했다.
 * DB(user_favorites.markup jsonb)로 옮기면 검색·공유·권한이 따라온다.
 *
 * markup jsonb 한 칸에 아래를 함께 담는다 — 표에 칸을 늘리지 않으려고(마이그레이션 없이).
 *   { markup, original_markup, source_name, view_mode, pdf_file_id }
 */

/** 한 사람이 보관해 둘 수 있는 개수 (기존 FAVORITE_LIMIT) */
export const FAVORITE_LIMIT = 50

/** 보관 목록 팝업의 한 줄 — 지금 그 자료의 상태(삭제됨·이름 바뀜)까지 함께 */
export const FavoriteItem = z.object({
  id: z.number().int(),
  kind: DocClass,
  /** 보관 이름 */
  name: z.string(),
  /** 설명(비고) */
  note: z.string().nullable(),
  hasMarkup: z.boolean(),
  documentId: z.number().int().nullable(),
  mdbFileId: z.number().int().nullable(),
  /** 지금 자료명 — 자료가 없어졌으면 null */
  currentName: z.string().nullable(),
  /** 폴더 경로 */
  path: z.string().nullable(),
  /** 지금 열면 보게 될 PDF (TDB 는 files.id, MDB 는 mdb_files.id) */
  pdfFileId: z.number().int().nullable(),
  /** 삭제됨 — 완전 삭제됐거나 삭제 보관함에 들어감 (폐기는 정상으로 본다) */
  missing: z.boolean(),
  /** 이름 바뀜 — 보관할 때의 자료명과 지금 자료명이 다르다 */
  renamed: z.boolean(),
  /** 'original' 이면 원본 미리보기를 보다가 보관한 것 */
  viewMode: z.enum(['original']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FavoriteItem = z.infer<typeof FavoriteItem>

/** 하위 호환 — 예전 이름 */
export const FavoriteSummary = FavoriteItem
export type FavoriteSummary = FavoriteItem

export const FavoriteListResponse = z.object({
  items: z.array(FavoriteItem),
  count: z.number().int(),
  limit: z.number().int(),
})

/** 상단 [보관] 버튼의 건수 — 목록 전체를 받지 않으려고 따로 둔다 */
export const FavoriteCountResponse = z.object({
  count: z.number().int(),
  limit: z.number().int(),
})

/** 뷰어(dms-favorite.js)가 되살릴 때 받아 가는 형태. 필드명을 그대로 맞춘다. */
export const FavoriteMarkupResponse = z.object({
  markup: z.array(z.unknown()),
  original_markup: z.array(z.unknown()),
})

export const FavoriteSaveRequest = z.object({
  docClass: DocClass,
  documentId: z.number().int().nullable().default(null),
  mdbFileId: z.number().int().nullable().default(null),
  name: z.string().trim().min(1).max(200),
  note: z.string().max(2000).nullable().default(null),
  /** 보관할 때의 자료명 — "이름 바뀜" 판단에 쓴다 */
  sourceName: z.string().max(500).nullable().default(null),
  /** 편집 내용을 그릴 때 보고 있던 PDF */
  pdfFileId: z.number().int().nullable().default(null),
  markup: z.array(z.unknown()).default([]),
  originalMarkup: z.array(z.unknown()).default([]),
  /** 지정하면 그 자리를 덮어쓴다, 없으면 새로 보관한다 */
  overwriteId: z.number().int().nullable().default(null),
  viewMode: z.enum(['original']).nullable().default(null),
})

export const FavoriteSaveResult = z.object({ id: z.number().int() })

export const FavoriteNoteRequest = z.object({ note: z.string().max(2000).nullable() })

export const FavoriteDeleteRequest = z.object({
  ids: z.array(z.number().int()).min(1).max(500),
})
export const FavoriteDeleteResult = z.object({ deleted: z.number().int() })

/**
 * 뷰어가 "지금 보고 있는 것이 어느 자료이고 이미 보관돼 있는지" 묻는 창구.
 * 뷰어(기존 코드 그대로)가 읽는 이름이라 snake_case 를 유지한다.
 */
export const FavoriteSlot = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: DocClass,
  has_markup: z.boolean(),
  description: z.string().nullable(),
  target_name: z.string().nullable(),
  missing: z.boolean(),
  updated_at: z.string(),
  pdf_file_id: z.number().int().nullable(),
  path: z.string().nullable(),
  document_id: z.number().int().nullable(),
  mdb_file_id: z.number().int().nullable(),
  view_mode: z.string().nullable(),
  /** 지금 보고 있는 자료를 가리키는 보관인가 */
  same: z.boolean(),
})
export type FavoriteSlot = z.infer<typeof FavoriteSlot>

export const FavoriteTargetQuery = z.object({
  kind: z.enum(['TDB', 'MDB']),
  pdf_file_id: z.coerce.number().int().optional(),
  original_file_id: z.coerce.number().int().optional(),
})

export const FavoriteTargetResponse = z.object({
  kind: DocClass,
  document_id: z.number().int().nullable(),
  mdb_file_id: z.number().int().nullable(),
  name: z.string(),
  pdf_file_id: z.number().int().nullable(),
  saved: z.array(FavoriteSlot),
  all_saved: z.array(FavoriteSlot),
  used: z.number().int(),
  limit: z.number().int(),
})

// 스키마에 대응하는 타입 — 화면에서 응답 타입을 그대로 쓴다
export type FavoriteListResponse = z.infer<typeof FavoriteListResponse>
export type FavoriteCountResponse = z.infer<typeof FavoriteCountResponse>
export type FavoriteMarkupResponse = z.infer<typeof FavoriteMarkupResponse>
export type FavoriteSaveRequest = z.infer<typeof FavoriteSaveRequest>
export type FavoriteSaveResult = z.infer<typeof FavoriteSaveResult>
export type FavoriteNoteRequest = z.infer<typeof FavoriteNoteRequest>
export type FavoriteDeleteRequest = z.infer<typeof FavoriteDeleteRequest>
export type FavoriteTargetResponse = z.infer<typeof FavoriteTargetResponse>
