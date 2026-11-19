import { z } from 'zod'

export const LoginRequest = z.object({
  loginId: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  /**
   * 로그인 화면의 [2차인증 없이 로그인] — true 면 인증 앱 코드를 묻지 않고 바로 세션을 만든다.
   * 서버가 AUTH_TOTP_SKIP=off 로 막아 두면 무시된다. 보내지 않으면 false(코드를 묻는다).
   */
  skipMfa: z.boolean().optional(),
})

/** 인증 앱 등록에 필요한 것 — 등록 단계에서 한 번만 내려간다 */
export const TotpEnrollment = z.object({
  /** 인증 앱에 손으로 넣을 때 쓰는 키(base32) */
  secret: z.string(),
  /** otpauth://totp/… — QR 의 내용 */
  otpauthUrl: z.string(),
  /** 위 주소를 그린 QR (SVG 문서) */
  qrSvg: z.string(),
  issuer: z.string(),
  account: z.string(),
})
export type TotpEnrollment = z.infer<typeof TotpEnrollment>

/**
 * POST /auth/login 결과.
 *
 * - mfa = none   : (2차 인증을 끈 개발 장비) 바로 세션이 생겼다.
 * - mfa = verify : 비밀번호는 맞았다. 인증 앱의 6자리 코드를 challenge 와 함께 /auth/mfa 로.
 * - mfa = enroll : 아직 인증 앱을 등록하지 않았다. enrollment 의 QR 을 찍고 코드를 /auth/mfa 로.
 *
 * verify·enroll 에서는 아직 세션이 없다 — 코드까지 맞아야 세션 쿠키가 나간다.
 */
export const LoginResult = z.discriminatedUnion('mfa', [
  z.object({
    ok: z.literal(true),
    mfa: z.literal('none'),
    /** 최초 비밀번호(ghub+아이디) 상태면 변경 화면을 먼저 연다. 미루기 가능 — 기존 정책. */
    mustChangePassword: z.boolean(),
  }),
  z.object({
    ok: z.literal(true),
    mfa: z.literal('verify'),
    challenge: z.string(),
    expiresInSec: z.number().int(),
  }),
  z.object({
    ok: z.literal(true),
    mfa: z.literal('enroll'),
    challenge: z.string(),
    expiresInSec: z.number().int(),
    enrollment: TotpEnrollment,
  }),
])

/** POST /auth/mfa — 2단계: 인증 앱 코드 */
export const MfaVerifyRequest = z.object({
  challenge: z.string().min(16).max(128),
  code: z.string().trim().regex(/^\d{6}$/, '6자리 숫자를 넣으세요'),
})

export const MfaVerifyResult = z.object({
  ok: z.literal(true),
  mustChangePassword: z.boolean(),
  /** 이번에 인증 앱 등록을 마쳤는가 */
  enrolled: z.boolean(),
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
  /** 인증 앱(TOTP) 등록을 마쳤는가 */
  totpEnabled: z.boolean(),
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
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>
export type MfaVerifyResult = z.infer<typeof MfaVerifyResult>
