import { one, query } from '../../core/db.js'

export interface UserAuthRow {
  id: number
  login_id: string
  name: string
  password_hash: string
  role: 'ADMIN' | 'VIEWER'
  is_active: boolean
  must_change_password: boolean
  totp_secret: string | null
  totp_enabled_at: Date | null
}

export function findUserByLoginId(loginId: string) {
  return one<UserAuthRow>(
    `SELECT id, login_id, name, password_hash, role, is_active, must_change_password,
            totp_secret, totp_enabled_at
       FROM users WHERE login_id = $1`,
    [loginId],
    'user_by_login',
  )
}

export interface AttemptRow {
  fail_count: number
  locked_until: Date | null
}

export function findAttempt(loginId: string) {
  return one<AttemptRow>(
    'SELECT fail_count, locked_until FROM login_attempts WHERE login_id = $1',
    [loginId],
    'attempt_by_login',
  )
}

export function recordFailure(loginId: string, ip: string | null, maxFail: number, lockMinutes: number) {
  return query(
    `INSERT INTO login_attempts (login_id, fail_count, last_fail_at, last_fail_ip)
     VALUES ($1, 1, now(), $2)
     ON CONFLICT (login_id) DO UPDATE SET
       fail_count   = login_attempts.fail_count + 1,
       last_fail_at = now(),
       last_fail_ip = $2,
       locked_until = CASE WHEN login_attempts.fail_count + 1 >= $3
                           THEN now() + ($4 || ' minutes')::interval
                           ELSE login_attempts.locked_until END`,
    [loginId, ip, maxFail, String(lockMinutes)],
  )
}

export function clearFailures(loginId: string) {
  return query('DELETE FROM login_attempts WHERE login_id = $1', [loginId])
}

export function touchLastLogin(userId: number) {
  return query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId])
}

export function updatePassword(userId: number, hash: string) {
  return query(
    `UPDATE users
        SET password_hash = $2, must_change_password = false,
            password_changed_at = now(), updated_at = now()
      WHERE id = $1`,
    [userId, hash],
  )
}

/** 예전 초기 비밀번호로 들어온 계정 — 변경을 강제한다 */
export function requirePasswordChange(userId: number) {
  return query('UPDATE users SET must_change_password = true, updated_at = now() WHERE id = $1', [userId])
}

/** 미루기 — 이번 로그인에서는 넘어가지만 다음 로그인 때 다시 묻는다 (기존 정책). */
export function deferPasswordChange(_userId: number) {
  return Promise.resolve()
}

// ── 2차 인증(TOTP) ──────────────────────────────────────────────────────

export interface ChallengeRow {
  id: string
  user_id: number
  purpose: 'verify' | 'enroll'
  pending_secret: string | null
  attempts: number
  login_id: string
  must_change_password: boolean
  is_active: boolean
  totp_secret: string | null
  totp_enabled_at: Date | null
}

export async function insertChallenge(
  idHash: string, userId: number, purpose: 'verify' | 'enroll',
  pendingSecret: string | null, ttlMinutes: number, ip: string | null,
) {
  // 만료된 것은 새로 넣을 때 함께 치운다 — 따로 청소 작업을 두지 않는다
  await query('DELETE FROM login_challenges WHERE expires_at < now()')
  await query(
    `INSERT INTO login_challenges (id, user_id, purpose, pending_secret, expires_at, client_ip)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval, $6)`,
    [idHash, userId, purpose, pendingSecret, String(ttlMinutes), ip],
  )
}

export function findChallenge(idHash: string) {
  return one<ChallengeRow>(
    `SELECT c.id, c.user_id, c.purpose, c.pending_secret, c.attempts,
            u.login_id, u.must_change_password, u.is_active, u.totp_secret, u.totp_enabled_at
       FROM login_challenges c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = $1 AND c.expires_at > now()`,
    [idHash],
    'challenge_by_id',
  )
}

/** 틀린 횟수 +1. 한도에 닿으면 지워 버린다 — 비밀번호부터 다시 */
export async function failChallenge(idHash: string, maxAttempts: number): Promise<number> {
  const r = await one<{ attempts: number }>(
    'UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
    [idHash],
  )
  const n = r?.attempts ?? maxAttempts
  if (n >= maxAttempts) await deleteChallenge(idHash)
  return n
}

export function deleteChallenge(idHash: string) {
  return query('DELETE FROM login_challenges WHERE id = $1', [idHash])
}

/**
 * 받아들인 칸 번호를 남긴다. 이미 그 칸(또는 뒤 칸)을 쓴 적이 있으면 false —
 * 같은 코드를 엿보고 30초 안에 다시 넣는 재사용을 막는다.
 */
export async function claimTotpStep(userId: number, step: number): Promise<boolean> {
  const r = await one<{ id: number }>(
    `UPDATE users SET totp_last_step = $2
      WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
      RETURNING id`,
    [userId, step],
  )
  return r !== undefined
}

/** 등록 완료 — 등록 대기 중이던 비밀키를 계정에 붙인다 */
export function enableTotp(userId: number, sealedSecret: string, step: number) {
  return query(
    `UPDATE users SET totp_secret = $2, totp_enabled_at = now(), totp_last_step = $3,
                      updated_at = now()
      WHERE id = $1`,
    [userId, sealedSecret, step],
  )
}

/** 마이페이지 — 본인의 연락처 정보(이메일, 전화번호, 내선번호) 수정 */
export function updateMyProfile(
  userId: number,
  data: { email?: string | null; phone?: string | null; extensionNumber?: string | null },
) {
  return query(
    `UPDATE users
        SET email = COALESCE($2, email),
            phone = COALESCE($3, phone),
            extension_number = COALESCE($4, extension_number),
            updated_at = now()
      WHERE id = $1`,
    [
      userId,
      data.email !== undefined ? data.email : null,
      data.phone !== undefined ? data.phone : null,
      data.extensionNumber !== undefined ? data.extensionNumber : null,
    ],
  )
}
