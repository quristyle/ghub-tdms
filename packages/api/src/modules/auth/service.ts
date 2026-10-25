import { config } from '../../core/config.js'
import { Errors } from '../../core/errors.js'
import { burnTime, hashPassword, verifyPassword } from '../../core/password.js'
import { createSession, destroyAllSessions } from '../../core/session.js'
import * as q from './queries.js'

export interface LoginOutcome {
  sessionId: string
  mustChangePassword: boolean
}

export async function login(
  loginId: string,
  password: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<LoginOutcome> {
  const attempt = await q.findAttempt(loginId)
  if (attempt?.locked_until && attempt.locked_until > new Date()) {
    throw Errors.locked(config.auth.lockMinutes)
  }

  const user = await q.findUserByLoginId(loginId)

  // 계정이 없어도 같은 시간을 쓴다 — 아이디 존재 여부가 드러나지 않게 (기존 정책)
  if (!user || !user.is_active) {
    await burnTime()
    await q.recordFailure(loginId, ip ?? null, config.auth.maxFailBeforeLock, config.auth.lockMinutes)
    throw Errors.unauthorized()
  }

  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) {
    await q.recordFailure(loginId, ip ?? null, config.auth.maxFailBeforeLock, config.auth.lockMinutes)
    throw Errors.unauthorized()
  }

  await q.clearFailures(loginId)
  await q.touchLastLogin(user.id)
  const sessionId = await createSession(user.id, ip, userAgent)

  return { sessionId, mustChangePassword: user.must_change_password }
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

  await q.updatePassword(userId, await hashPassword(newPassword))
  // 비밀번호를 바꾸면 기존 세션을 전부 끊는다 (기존 정책)
  await destroyAllSessions(userId)
}
