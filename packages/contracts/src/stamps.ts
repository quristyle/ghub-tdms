import { z } from 'zod'

/** 스탬프 구분: 도장 / 표 / 서명 / 기타 */
export const StampCategory = z.enum(['도장', '표', '서명', '기타'])
export type StampCategory = z.infer<typeof StampCategory>

export const StampItem = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(100),
  category: z.string().max(50),
  imageUrl: z.string(),
  width: z.number().int().positive().default(300),
  height: z.number().int().positive().default(150),
  description: z.string().nullable().optional(),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable().optional(),
  updatedBy: z.string().nullable().optional(),
})
export type StampItem = z.infer<typeof StampItem>

export const StampListResponse = z.object({
  items: z.array(StampItem),
  total: z.number().int(),
})
export type StampListResponse = z.infer<typeof StampListResponse>

export const CreateStampBody = z.object({
  name: z.string().min(1, '스탬프 이름을 입력해 주세요.').max(100),
  category: z.string().max(50).default('도장'),
  imageUrl: z.string().min(1, '스탬프 이미지가 필요합니다.'),
  width: z.number().int().positive().default(300),
  height: z.number().int().positive().default(150),
  description: z.string().max(500).optional(),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
})
export type CreateStampBody = z.infer<typeof CreateStampBody>

export const UpdateStampBody = z.object({
  name: z.string().min(1, '스탬프 이름을 입력해 주세요.').max(100).optional(),
  category: z.string().max(50).optional(),
  imageUrl: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  description: z.string().max(500).nullable().optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})
export type UpdateStampBody = z.infer<typeof UpdateStampBody>
