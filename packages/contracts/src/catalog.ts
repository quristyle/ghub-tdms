import { z } from 'zod'
import { BoolParam } from './common.js'

/**
 * 공사(projects)·업체(vendors) 관리.
 *
 * 기존 시스템 projects.py / vendors.py 를 옮긴 것.
 * '삭제'는 없다 — 드롭다운 후보에서만 빼는 숨김이다(D-6). 과거 반출·리비전 기록의 FK 를 지키기 위해서다.
 * 이름은 대소문자·앞뒤 공백 차이만으로 다른 항목이 되지 않게, 숨긴 항목까지 포함해 중복을 막는다.
 */

export const CatalogItem = z.object({
  id: z.number().int(),
  name: z.string(),
  isHidden: z.boolean(),
  createdAt: z.string(),
})
export type CatalogItem = z.infer<typeof CatalogItem>

export const CatalogListQuery = z.object({
  /** 관리 화면에서는 숨긴 것도 함께 본다 */
  includeHidden: BoolParam.default(false),
})

export const CatalogListResponse = z.object({ items: z.array(CatalogItem) })
export type CatalogListResponse = z.infer<typeof CatalogListResponse>

export const CatalogNameRequest = z.object({
  name: z.string().trim().min(1, '이름을 입력해 주세요.').max(200),
})
export type CatalogNameRequest = z.infer<typeof CatalogNameRequest>

export const CatalogHideResult = z.object({ ok: z.literal(true) })
