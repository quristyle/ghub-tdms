import { config } from '../../core/config.js'
import { Errors } from '../../core/errors.js'
import { burnTime, hashPassword, initialPassword, verifyPassword } from '../../core/password.js'
import { createSession, destroyAllSessions } from '../../core/session.js'
import * as q from './queries.js'

export interface LoginOutcome {
  sessionId: string
  mustChangePassword: boolean
}

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

  await q.clearFailures(loginId)
  await q.touchLastLogin(user.id)
  const sessionId = await createSession(user.id, ip, userAgent)

  return { sessionId, mustChangePassword: mustChange }
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
