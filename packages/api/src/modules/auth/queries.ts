import { one, query } from '../../core/db.js'

export interface UserAuthRow {
  id: number
  login_id: string
  name: string
  password_hash: string
  role: 'ADMIN' | 'VIEWER'
  is_active: boolean
  must_change_password: boolean
}

export function findUserByLoginId(loginId: string) {
  return one<UserAuthRow>(
    `SELECT id, login_id, name, password_hash, role, is_active, must_change_password
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

/** 미루기 — 이번 로그인에서는 넘어가지만 다음 로그인 때 다시 묻는다 (기존 정책). */
export function deferPasswordChange(_userId: number) {
  return Promise.resolve()
}
