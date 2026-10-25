import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { LEAF_KEYS, type PermissionKey } from '@tdms/contracts'
import { config } from './config.js'
import { many, one, query } from './db.js'
import { cached } from './cache.js'

export interface SessionUser {
  id: number
  loginId: string
  name: string
  role: 'ADMIN' | 'VIEWER'
  groupId: number | null
  groupName: string | null
  mustChangePassword: boolean
  /** 이 세션에서 비밀번호 변경을 미뤘는가 (새로고침해도 유지, 재로그인 시 초기화) */
  passwordDeferred: boolean
}

export interface AuthContext {
  sessionId: string
  user: SessionUser
  permissions: ReadonlySet<string>
}

export async function createSession(
  userId: number,
  clientIp: string | undefined,
  userAgent: string | undefined,
): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO sessions (id, user_id, expires_at, client_ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
    [id, userId, String(config.session.ttlHours), clientIp ?? null, userAgent ?? null],
  )
  return id
}

export async function destroySession(sessionId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId])
}

/** 비밀번호 변경 시 그 사용자의 모든 세션을 끊는다 (기존 정책 유지). */
export async function destroyAllSessions(userId: number): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId])
}

interface SessionRow extends SessionUser {
  session_id: string
  needs_touch: boolean
}

export async function loadSession(sessionId: string): Promise<SessionUser | undefined> {
  const row = await one<SessionRow & Record<string, unknown>>(
    `SELECT s.id              AS session_id,
            u.id, u.login_id  AS "loginId", u.name, u.role,
            u.group_id        AS "groupId", g.name AS "groupName",
            u.must_change_password AS "mustChangePassword",
            s.password_deferred    AS "passwordDeferred",
            (s.last_seen_at < now() - ($2 || ' milliseconds')::interval) AS needs_touch
       FROM sessions s
       JOIN users u  ON u.id = s.user_id
  LEFT JOIN groups g ON g.id = u.group_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [sessionId, String(config.session.touchIntervalMs)],
    'session_load',
  )
  if (!row) return undefined

  // 매 요청 UPDATE 하면 쓰기 증폭이 크다 — 간격을 넘겼을 때만 갱신한다.
  if (row.needs_touch) {
    void query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId])
  }

  return {
    id: row.id,
    loginId: row.loginId,
    name: row.name,
    role: row.role,
    groupId: row.groupId,
    groupName: row.groupName,
    mustChangePassword: row.mustChangePassword,
    passwordDeferred: row.passwordDeferred,
  }
}

/** 미루기 — 이 세션에서만 변경 화면을 건너뛴다. */
export async function deferPasswordChange(sessionId: string): Promise<void> {
  await query('UPDATE sessions SET password_deferred = true WHERE id = $1', [sessionId])
}

/**
 * 사용자의 리프 권한 집합.
 * ADMIN 은 항상 전체 통과 (기존 정책).
 */
export async function loadPermissions(user: SessionUser): Promise<ReadonlySet<string>> {
  if (user.role === 'ADMIN') return new Set(LEAF_KEYS)
  if (user.groupId === null) return new Set()

  return cached('cache_perm', `g:${user.groupId}`, async () => {
    const rows = await many<{ permission_key: string }>(
      'SELECT permission_key FROM group_permissions WHERE group_id = $1',
      [user.groupId],
      'perm_by_group',
    )
    return new Set(rows.map((r) => r.permission_key))
  })
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(config.session.cookieName, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    path: '/',
    maxAge: config.session.ttlHours * 3600,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.session.cookieName, { path: '/' })
}

export function readSessionCookie(req: FastifyRequest): string | undefined {
  return req.cookies[config.session.cookieName]
}

export function hasPermission(ctx: AuthContext, key: PermissionKey): boolean {
  return ctx.user.role === 'ADMIN' || ctx.permissions.has(key)
}
