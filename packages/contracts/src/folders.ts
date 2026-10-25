import { z } from 'zod'
import { DocClass } from './common.js'

/**
 * 폴더 트리.
 *
 * 기존 시스템은 폴더가 documents.source_path 문자열이었다. 여기서는 1급 테이블이고
 * ltree path 의 라벨에 폴더 id 를 쓴다 — 이름을 바꿔도 path 가 그대로라 하위 갱신이 없다.
 */

export const FolderNode = z.object({
  id: z.number().int(),
  parentId: z.number().int().nullable(),
  name: z.string(),
  path: z.string(),
  depth: z.number().int(),
  /** 트리 배지. 하위 전체 자료 수 */
  docCount: z.number().int(),
  /** 자식이 있는지 — 지연 로딩에서 펼침 화살표를 그릴지 정한다 */
  hasChildren: z.boolean(),
  isPlaceholder: z.boolean(),
})
export type FolderNode = z.infer<typeof FolderNode>

export const FolderTreeQuery = z.object({
  docClass: DocClass,
  /** 생략하면 최상위. 지정하면 그 폴더의 직계 자식만 — 지연 로딩 */
  parentId: z.coerce.number().int().optional(),
  /** 화면 복원용: 이 폴더까지의 경로를 한 번에 펼쳐서 내려준다 */
  expandTo: z.coerce.number().int().optional(),
})

export const FolderTreeResponse = z.object({
  items: z.array(FolderNode),
})
export type FolderTreeResponse = z.infer<typeof FolderTreeResponse>

export const FolderCreateRequest = z.object({
  docClass: DocClass,
  parentId: z.number().int().nullable(),
  name: z.string().min(1).max(255),
})

export const FolderRenameRequest = z.object({
  name: z.string().min(1).max(255),
})

export const FolderReparentRequest = z.object({
  newParentId: z.number().int().nullable(),
})

export const FolderMutationResult = z.object({
  ok: z.literal(true),
  folderId: z.number().int(),
  /** 이동 시 path 접두어가 바뀐 하위 폴더 수 */
  affectedFolders: z.number().int().default(0),
})
export type FolderMutationResult = z.infer<typeof FolderMutationResult>

// 스키마에 대응하는 타입 — 화면에서 응답 타입을 그대로 쓴다
export type FolderCreateRequest = z.infer<typeof FolderCreateRequest>
export type FolderRenameRequest = z.infer<typeof FolderRenameRequest>
export type FolderReparentRequest = z.infer<typeof FolderReparentRequest>
