import { z } from 'zod'

export const LoginRequest = z.object({
  loginId: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

export const LoginResult = z.object({
  ok: z.literal(true),
  /** 최초 비밀번호(ghub+아이디) 상태면 변경 화면을 먼저 연다. 미루기 가능 — 기존 정책. */
  mustChangePassword: z.boolean(),
})

export const PasswordChangeRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  // 기존 규칙 유지: 영문+숫자 8자 이상
  newPassword: z
    .string()
    .min(8, '8자 이상이어야 합니다')
    .max(256)
    .regex(/[A-Za-z]/, '영문을 포함해야 합니다')
    .regex(/[0-9]/, '숫자를 포함해야 합니다'),
})

export const MenuItem = z.object({
  id: z.number().int().optional(),
  code: z.string().optional(),
  path: z.string(),
  label: z.string(),
  category: z.string().optional(),
  permission: z.string(),
})
export type MenuItem = z.infer<typeof MenuItem>

/** GET /auth/me — 화면이 메뉴를 그리고 버튼을 켜고 끄는 데 쓰는 전부 */
export const MeResponse = z.object({
  id: z.number().int(),
  loginId: z.string(),
  name: z.string(),
  role: z.enum(['ADMIN', 'VIEWER']),
  groupId: z.number().int().nullable(),
  groupName: z.string().nullable(),
  mustChangePassword: z.boolean(),
  /** 이 세션에서 변경을 미뤘는가. 새로고침해도 유지되고 재로그인하면 초기화된다. */
  passwordDeferred: z.boolean(),
  /** 이 사용자가 가진 리프 권한. ADMIN 은 36개 전부. */
  permissions: z.array(z.string()),
  /** 접근 가능한 메뉴만 추려서 내려준다(순서 유지) */
  menu: z.array(MenuItem),
})
export type MeResponse = z.infer<typeof MeResponse>

// 스키마에 대응하는 타입 — 화면에서 응답 타입을 그대로 쓴다
export type LoginRequest = z.infer<typeof LoginRequest>
export type LoginResult = z.infer<typeof LoginResult>
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequest>
