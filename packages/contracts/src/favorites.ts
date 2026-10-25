import { z } from 'zod'
import { DocClass } from './common.js'

/**
 * 마크업 보관 (기존 '즐겨찾기').
 *
 * 기존 시스템은 그린 내용을 `즐겨찾기/` 폴더의 JSON 파일로 저장했다.
 * DB(user_favorites.markup jsonb)로 옮기면 검색·공유·권한이 따라온다.
 */

export const FavoriteSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  note: z.string().nullable(),
  docClass: DocClass,
  documentId: z.number().int().nullable(),
  mdbFileId: z.number().int().nullable(),
  /** 되살려 열 때 쓸 자료명 */
  targetName: z.string().nullable(),
  updatedAt: z.string(),
})
export type FavoriteSummary = z.infer<typeof FavoriteSummary>

export const FavoriteListResponse = z.object({ items: z.array(FavoriteSummary) })

/** 뷰어(dms-favorite.js)가 되살릴 때 받아 가는 형태. 필드명을 그대로 맞춘다. */
export const FavoriteMarkupResponse = z.object({
  markup: z.array(z.unknown()),
  original_markup: z.array(z.unknown()),
})

export const FavoriteSaveRequest = z.object({
  docClass: DocClass,
  documentId: z.number().int().nullable().default(null),
  mdbFileId: z.number().int().nullable().default(null),
  name: z.string().min(1).max(200),
  note: z.string().max(2000).nullable().default(null),
  markup: z.array(z.unknown()).default([]),
  originalMarkup: z.array(z.unknown()).default([]),
  /** 지정하면 덮어쓴다 ([보관하기]), 없으면 새로 만든다 ([다른 이름으로 보관]) */
  overwriteId: z.number().int().nullable().default(null),
})

export const FavoriteSaveResult = z.object({ id: z.number().int() })

/** 뷰어가 "이 자료에 이미 보관한 것이 있는가" 를 묻는 창구 */
export const FavoriteTargetResponse = z.object({
  favoriteId: z.number().int().nullable(),
  name: z.string().nullable(),
})
