import { z } from 'zod'
import { BoolParam } from './common.js'
import { MdbListQuery } from './mdb.js'

/**
 * MDB 조회 화면의 보조 창구 — 넘겨보기·폴더 다운·원본/사본 짝.
 * (조회 본체는 mdb.ts. 이 파일은 조회 화면·상세 화면에만 쓰는 것을 따로 모은다.)
 */

/**
 * 자료 상세의 [처음·이전·다음·끝]과 "n / 전체".
 * 목록의 검색 조건·정렬을 그대로 받아, 그 결과 안에서의 자리를 돌려준다.
 * id 대신 pos 를 주면 그 자리의 자료를 찾는다(번호를 적고 Enter).
 */
export const MdbNavQuery = MdbListQuery.omit({ cursor: true, limit: true }).extend({
  id: z.coerce.number().int().optional(),
  pos: z.coerce.number().int().min(1).optional(),
})
export type MdbNavQuery = z.infer<typeof MdbNavQuery>

export const MdbNavResponse = z.object({
  /** 1부터. 검색 결과에 없으면 null */
  position: z.number().int().nullable(),
  total: z.number().int(),
  id: z.number().int().nullable(),
  firstId: z.number().int().nullable(),
  prevId: z.number().int().nullable(),
  nextId: z.number().int().nullable(),
  lastId: z.number().int().nullable(),
})
export type MdbNavResponse = z.infer<typeof MdbNavResponse>

/** 폴더 다운 — 폴더(하위 포함) 안 자료 전부를 다운대기함에 담는다 */
export const MdbIdsByFolderQuery = z.object({
  folderId: z.coerce.number().int(),
  recursive: BoolParam.default(true),
})

export const MdbCartItem = z.object({
  id: z.number().int(),
  title: z.string(),
  folderName: z.string(),
  fileExt: z.string(),
})
export type MdbCartItem = z.infer<typeof MdbCartItem>

export const MdbIdsByFolderResponse = z.object({
  items: z.array(MdbCartItem),
  /** 5,000건(한 번에 묶을 수 있는 상한)을 넘어 잘렸는가 */
  truncated: z.boolean(),
})
export type MdbIdsByFolderResponse = z.infer<typeof MdbIdsByFolderResponse>

/**
 * 원본/사본 짝 (D-102).
 * MDB 는 파일 한 개가 자료 한 건이라, 같은 폴더·같은 이름(확장자만 다른)의 파일을 짝으로 본다.
 */
export const MdbSourcesResponse = z.object({
  /** 사본(PDF) — 이 자료 자신이거나 짝 */
  pdfId: z.number().int().nullable(),
  /** 원본(DWG·DXF·엑셀 등) — 이 자료 자신이거나 짝 */
  originalId: z.number().int().nullable(),
  originalExt: z.string().nullable(),
  /** 원본을 미리보기로 바꿔 볼 수 있는가 (DWG·DXF) */
  originalPreviewable: z.boolean(),
})
export type MdbSourcesResponse = z.infer<typeof MdbSourcesResponse>

export const MdbRendition = z.object({
  state: z.enum(['unsupported', 'pending', 'done', 'failed']),
  error: z.string().nullable(),
})
