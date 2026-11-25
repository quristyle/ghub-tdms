import { z } from 'zod'
import { DocumentListItem } from './documents.js'

/**
 * 반출대기함 사용자별 폴더 및 자료 관리 규약
 */

export const CartFolder = z.object({
  id: z.number().int(),
  parentId: z.number().int().nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
  docCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CartFolder = z.infer<typeof CartFolder>

export const CartFolderListResponse = z.object({
  items: z.array(CartFolder),
  totalCount: z.number().int(),
  rootCount: z.number().int(),
})
export type CartFolderListResponse = z.infer<typeof CartFolderListResponse>

export const CartFolderCreateRequest = z.object({
  name: z.string().min(1).max(255),
  parentId: z.number().int().nullable().optional(),
})
export type CartFolderCreateRequest = z.infer<typeof CartFolderCreateRequest>

export const CartFolderUpdateRequest = z.object({
  name: z.string().min(1).max(255).optional(),
  parentId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
})
export type CartFolderUpdateRequest = z.infer<typeof CartFolderUpdateRequest>

export const CartFolderMutationResult = z.object({
  ok: z.literal(true),
  folder: CartFolder,
})
export type CartFolderMutationResult = z.infer<typeof CartFolderMutationResult>

export const CartItem = DocumentListItem.extend({
  cartItemId: z.number().int(),
  cartFolderId: z.number().int().nullable(),
  cartFolderName: z.string().nullable(),
  addedAt: z.string(),
})
export type CartItem = z.infer<typeof CartItem>

export const CartItemListQuery = z.object({
  /** 'all': 전체, 'root': 미분류/기본, 숫자: 해당 폴더 */
  folderId: z
    .preprocess(
      (v) => (v === undefined || v === '' ? undefined : v === 'root' ? 'root' : v === 'all' ? 'all' : Number(v)),
      z.union([z.number().int(), z.literal('root'), z.literal('all')]).optional(),
    ),
  q: z.string().max(200).optional(),
})
export type CartItemListQuery = z.infer<typeof CartItemListQuery>

export const CartItemListResponse = z.object({
  items: z.array(CartItem),
  total: z.number().int(),
})
export type CartItemListResponse = z.infer<typeof CartItemListResponse>

export const CartAddRequest = z.object({
  documentIds: z.array(z.number().int()).min(1),
  folderId: z.number().int().nullable().optional(),
})
export type CartAddRequest = z.infer<typeof CartAddRequest>

export const CartAddResponse = z.object({
  ok: z.literal(true),
  added: z.number().int(),
  total: z.number().int(),
})
export type CartAddResponse = z.infer<typeof CartAddResponse>

export const CartMoveRequest = z.object({
  documentIds: z.array(z.number().int()).min(1),
  targetFolderId: z.number().int().nullable(),
})
export type CartMoveRequest = z.infer<typeof CartMoveRequest>

export const CartMoveResponse = z.object({
  ok: z.literal(true),
  moved: z.number().int(),
})
export type CartMoveResponse = z.infer<typeof CartMoveResponse>

export const CartRemoveRequest = z.object({
  documentIds: z.array(z.number().int()).min(1),
})
export type CartRemoveRequest = z.infer<typeof CartRemoveRequest>

export const CartRemoveResponse = z.object({
  ok: z.literal(true),
  removed: z.number().int(),
  total: z.number().int(),
})
export type CartRemoveResponse = z.infer<typeof CartRemoveResponse>

export const CartClearRequest = z.object({
  folderId: z.number().int().nullable().optional(),
})
export type CartClearRequest = z.infer<typeof CartClearRequest>
