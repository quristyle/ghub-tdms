import { createHash, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import type { LoginResult, QuickLoginUser, TotpEnrollment } from '@tdms/contracts'
import { config } from '../../core/config.js'
import { AppError, Errors } from '../../core/errors.js'
import { burnTime, hashPassword, initialPassword, verifyPassword } from '../../core/password.js'
import { createSession, deferPasswordChange, destroyAllSessions } from '../../core/session.js'
import {
  deriveKey, generateSecret, openSecret, otpauthUrl, sealSecret, verifyTotp,
} from '../../core/totp.js'
import * as q from './queries.js'

/** 비밀번호 단계의 결과 — 세션이 생겼거나(2차 인증 끔), 코드를 기다리거나 */
export type LoginOutcome =
  | { kind: 'session'; sessionId: string; mustChangePassword: boolean; mfaSkipped: boolean }
  | { kind: 'challenge'; result: Exclude<LoginResult, { mfa: 'none' }> }

export interface MfaOutcome {
  loginId: string
  sessionId: string
  mustChangePassword: boolean
  enrolled: boolean
}

let totpKey: Buffer | undefined
function key(): Buffer {
  totpKey ??= deriveKey(config.totp.encKeyMaterial)
  return totpKey
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

// ── 접속 주소별 실패 횟수 ────────────────────────────────────────────────
// 계정별 잠금(5회)만으로는 "아이디를 바꿔 가며 같은 비밀번호 한 번씩" 넣는
// 스프레이를 막지 못한다 — 계정마다 1회씩이라 잠기지 않는다. 주소별로도 센다.
// API 가 한 프로세스라 메모리로 충분하다(재시작하면 초기화된다).
const IP_WINDOW_MS = 15 * 60_000
const IP_MAX_FAIL = 20
const IP_TABLE_MAX = 10_000
const ipFailures = new Map<string, { count: number; since: number }>()

function ipBlocked(ip: string | undefined): boolean {
  if (!ip) return false
  const e = ipFailures.get(ip)
  if (!e) return false
  if (Date.now() - e.since > IP_WINDOW_MS) {
    ipFailures.delete(ip)
    return false
  }
  return e.count >= IP_MAX_FAIL
}

function noteIpFailure(ip: string | undefined): void {
  if (!ip) return
  const now = Date.now()
  const e = ipFailures.get(ip)
  if (e && now - e.since <= IP_WINDOW_MS) {
    e.count += 1
    return
  }
  if (ipFailures.size >= IP_TABLE_MAX) {
    // 오래된 것부터 비운다 — Map 은 넣은 차례를 지킨다
    for (const [k, v] of ipFailures) {
      if (now - v.since > IP_WINDOW_MS || ipFailures.size >= IP_TABLE_MAX) ipFailures.delete(k)
      if (ipFailures.size < IP_TABLE_MAX) break
    }
  }
  ipFailures.set(ip, { count: 1, since: now })
}

export async function login(
  loginId: string,
  password: string,
  ip: string | undefined,
  userAgent: string | undefined,
  skipMfa = false,
): Promise<LoginOutcome> {
  if (ipBlocked(ip)) throw Errors.locked(IP_WINDOW_MS / 60_000)

  const attempt = await q.findAttempt(loginId)
  if (attempt?.locked_until && attempt.locked_until > new Date()) {
    throw Errors.locked(config.auth.lockMinutes)
  }

  const user = await q.findUserByLoginId(loginId)

  // 계정이 없어도 같은 시간을 쓴다 — 아이디 존재 여부가 드러나지 않게 (기존 정책)
  if (!user || !user.is_active) {
    await burnTime()
    noteIpFailure(ip)
    await q.recordFailure(loginId, ip ?? null, config.auth.maxFailBeforeLock, config.auth.lockMinutes)
    throw Errors.unauthorized()
  }

  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) {
    noteIpFailure(ip)
    await q.recordFailure(loginId, ip ?? null, config.auth.maxFailBeforeLock, config.auth.lockMinutes)
    throw Errors.unauthorized()
  }

  // 아직 예전 초기 비밀번호('ghub' + 아이디)를 쓰는 계정은 반드시 바꾸게 한다.
  // 플래그가 어긋나 있어도(이행 자료 등) 실제 비밀번호를 보고 다시 세운다.
  let mustChange = user.must_change_password
  if (!mustChange && password === initialPassword(user.login_id)) {
    await q.requirePasswordChange(user.id)
    mustChange = true
  }

  // 2차 인증을 끈 장비이거나, 로그인 화면에서 [2차인증 없이 로그인]을 골랐으면(서버가 허용할 때)
  // 비밀번호만으로 세션을 만든다.
  const mfaSkipped = config.totp.mode !== 'off' && skipMfa && config.totp.allowSkip
  if (config.totp.mode === 'off' || mfaSkipped) {
    await q.clearFailures(loginId)
    await q.touchLastLogin(user.id)
    const sessionId = await createSession(user.id, ip, userAgent)
    return { kind: 'session', sessionId, mustChangePassword: mustChange, mfaSkipped }
  }

  // 비밀번호는 맞았다 — 아직 세션은 만들지 않는다. 실패 횟수도 코드까지 맞아야 지운다
  // (비밀번호를 아는 사람이 코드를 찍어 맞히는 것도 같은 5회 잠금에 걸리게).
  const token = randomBytes(32).toString('base64url')

  if (user.totp_enabled_at && user.totp_secret) {
    await q.insertChallenge(hashToken(token), user.id, 'verify', null, config.totp.verifyTtlMinutes, ip ?? null)
    return {
      kind: 'challenge',
      result: { ok: true, mfa: 'verify', challenge: token, expiresInSec: config.totp.verifyTtlMinutes * 60 },
    }
  }

  // 등록 전 — 새 비밀키를 만들어 등록 대기로 둔다. 코드가 한 번 맞아야 계정에 붙는다.
  const secret = generateSecret()
  await q.insertChallenge(
    hashToken(token), user.id, 'enroll', sealSecret(key(), secret),
    config.totp.enrollTtlMinutes, ip ?? null,
  )
  return {
    kind: 'challenge',
    result: {
      ok: true,
      mfa: 'enroll',
      challenge: token,
      expiresInSec: config.totp.enrollTtlMinutes * 60,
      enrollment: await enrollment(user.login_id, secret),
    },
  }
}

async function enrollment(loginId: string, secret: string): Promise<TotpEnrollment> {
  const issuer = config.totp.issuer
  const url = otpauthUrl(issuer, loginId, secret)
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  // 손으로 넣을 때 읽기 쉽게 4자씩 띄운다(앱은 공백을 무시한다)
  return { secret: secret.replace(/(.{4})(?=.)/g, '$1 '), otpauthUrl: url, qrSvg, issuer, account: loginId }
}

const mfaExpired = () =>
  new AppError('MFA_EXPIRED', 401, '인증 시간이 지났거나 너무 많이 틀렸습니다. 처음부터 다시 로그인하세요.')

/** 2단계 — 인증 앱의 6자리 코드. 맞으면 그제서야 세션이 생긴다. */
export async function verifyMfa(
  challenge: string,
  code: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<MfaOutcome> {
  if (ipBlocked(ip)) throw Errors.locked(IP_WINDOW_MS / 60_000)

  const id = hashToken(challenge)
  const row = await q.findChallenge(id)
  if (!row) {
    noteIpFailure(ip)
    throw mfaExpired()
  }
  if (!row.is_active) {
    await q.deleteChallenge(id)
    throw Errors.unauthorized()
  }
  const attempt = await q.findAttempt(row.login_id)
  if (attempt?.locked_until && attempt.locked_until > new Date()) {
    await q.deleteChallenge(id)
    throw Errors.locked(config.auth.lockMinutes)
  }

  // 등록 대기 중에 다른 창에서 등록을 마쳤거나, 확인 대기 중에 관리자가 OTP 를 초기화했으면 무효
  const sealed = row.purpose === 'enroll'
    ? (row.totp_enabled_at ? null : row.pending_secret)
    : (row.totp_enabled_at ? row.totp_secret : null)
  if (!sealed) {
    await q.deleteChallenge(id)
    throw mfaExpired()
  }

  let secret: string
  try {
    secret = openSecret(key(), sealed)
  } catch {
    // 암호화 키(TOTP_ENC_KEY / SESSION_SECRET)가 바뀐 뒤 — 등록을 새로 해야 한다
    await q.deleteChallenge(id)
    throw new AppError(
      'MFA_SECRET_UNREADABLE', 409,
      '인증 앱 등록 정보를 읽을 수 없습니다. 관리자에게 OTP 초기화를 요청하세요.',
    )
  }

  const step = verifyTotp(secret, code)
  const accepted = step !== null && (row.purpose === 'enroll' || (await q.claimTotpStep(row.user_id, step)))
  if (!accepted) {
    noteIpFailure(ip)
    await q.recordFailure(row.login_id, ip ?? null, config.auth.maxFailBeforeLock, config.auth.lockMinutes)
    const n = await q.failChallenge(id, config.totp.maxAttempts)
    const remaining = Math.max(0, config.totp.maxAttempts - n)
    if (remaining === 0) throw mfaExpired()
    throw new AppError(
      'MFA_INVALID', 422,
      step !== null
        ? '이미 사용한 코드입니다. 앱에 다음 코드가 나오면 넣으세요.'
        : `인증 코드가 맞지 않습니다. (${remaining}번 남음)`,
      { remaining },
    )
  }

  if (row.purpose === 'enroll') await q.enableTotp(row.user_id, sealed, step!)
  await q.deleteChallenge(id)
  await q.clearFailures(row.login_id)
  await q.touchLastLogin(row.user_id)
  const sessionId = await createSession(row.user_id, ip, userAgent)
  return {
    loginId: row.login_id, sessionId,
    mustChangePassword: row.must_change_password, enrolled: row.purpose === 'enroll',
  }
}

export async function changePassword(
  userId: number,
  loginId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await q.findUserByLoginId(loginId)
  if (!user) throw Errors.notFound('계정')

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw Errors.invalid('PASSWORD_MISMATCH', '현재 비밀번호가 맞지 않습니다.')
  }
  if (currentPassword === newPassword) {
    throw Errors.invalid('PASSWORD_SAME', '이전과 다른 비밀번호를 쓰세요.')
  }
  const lowered = newPassword.toLowerCase()
  if (lowered === initialPassword(loginId).toLowerCase()
      || (loginId.length >= 4 && lowered.includes(loginId.toLowerCase()))) {
    throw Errors.invalid('PASSWORD_WEAK', '아이디가 들어간 비밀번호는 쓸 수 없습니다.')
  }

  await q.updatePassword(userId, await hashPassword(newPassword))
  // 비밀번호를 바꾸면 기존 세션을 전부 끊는다 (기존 정책)
  await destroyAllSessions(userId)
}

/** 그룹별 빠른 로그인용 사용자 목록 조회 */
export async function listQuickLoginUsers(): Promise<QuickLoginUser[]> {
  const rows: q.QuickLoginUserRow[] = await q.findQuickLoginUsers()
  return rows.map((r: q.QuickLoginUserRow) => ({
    groupId: r.groupId,
    groupName: r.groupName,
    userId: r.userId,
    loginId: r.loginId,
    name: r.name,
    role: r.role,
  }))
}

/** 빠른 자동 로그인 (비밀번호/TOTP 생략) */
export async function quickLogin(
  loginId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<{ sessionId: string; loginId: string }> {
  const user = await q.findUserByLoginId(loginId)
  if (!user || !user.is_active) {
    throw Errors.unauthorized()
  }

  await q.clearFailures(loginId)
  await q.touchLastLogin(user.id)
  const sessionId = await createSession(user.id, ip, userAgent)
  if (user.must_change_password) {
    await deferPasswordChange(sessionId)
  }
  return { sessionId, loginId: user.login_id }
}
