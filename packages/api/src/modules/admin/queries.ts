import type pg from 'pg'
import type { AuditQuery } from '@tdms/contracts'
import { many, one } from '../../core/db.js'
import { decodeCursor } from '../../core/cursor.js'

/** 운영 화면 쿼리 — 시스템 로그 / 사용자·권한 / 백업 */

// ── 시스템 로그 ─────────────────────────────────────────────────────────

export interface AuditRow {
  id: number
  occurredAt: Date
  userName: string | null
  screen: string | null
  action: string | null
  target: string | null
  detail: Record<string, unknown> | null
  clientIp: string | null
}

function auditFilters(qp: AuditQuery, params: unknown[]): string[] {
  const where: string[] = []
  if (qp.dateFrom) { params.push(qp.dateFrom); where.push(`a.occurred_at >= $${params.length}::timestamptz`) }
  if (qp.dateTo)   { params.push(qp.dateTo);   where.push(`a.occurred_at < ($${params.length}::timestamptz + interval '1 day')`) }
  if (qp.screen)   { params.push(qp.screen);   where.push(`a.screen = $${params.length}`) }
  if (qp.action)   { params.push(qp.action);   where.push(`a.action = $${params.length}`) }
  if (qp.userId !== undefined) { params.push(qp.userId); where.push(`a.user_id = $${params.length}`) }
  if (qp.q) {
    params.push(`%${qp.q}%`)
    where.push(`(a.target ILIKE $${params.length} OR a.user_name ILIKE $${params.length})`)
  }
  return where
}

export function listAudit(qp: AuditQuery) {
  const params: unknown[] = []
  const where = auditFilters(qp, params)

  const cur = decodeCursor(qp.cursor)
  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(`(a.occurred_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`)
  }
  params.push(qp.limit + 1)

  return many<AuditRow>(
    `SELECT a.id,
            a.occurred_at AS "occurredAt",
            a.user_name   AS "userName",
            a.screen, a.action, a.target, a.detail,
            host(a.client_ip) AS "clientIp"
       FROM audit_log a
      ${where.length ? `WHERE ${where.join('\n        AND ')}` : ''}
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  )
}

export async function countAudit(qp: AuditQuery): Promise<number> {
  const params: unknown[] = []
  const where = auditFilters(qp, params)
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log a
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  )
  return r?.n ?? 0
}

/** 검색 선택지 — 실제로 기록된 값만. 월 파티션이라 최근 3개월만 훑는다. */
export function auditMeta() {
  return Promise.all([
    many<{ v: string }>(
      `SELECT DISTINCT screen AS v FROM audit_log
        WHERE screen IS NOT NULL AND occurred_at > now() - interval '3 months' ORDER BY 1`,
      [], 'audit_meta_screen'),
    many<{ v: string }>(
      `SELECT DISTINCT action AS v FROM audit_log
        WHERE action IS NOT NULL AND occurred_at > now() - interval '3 months' ORDER BY 1`,
      [], 'audit_meta_action'),
    many<{ id: number; name: string }>(
      `SELECT id, name FROM users WHERE is_active ORDER BY name`, [], 'audit_meta_users'),
  ])
}

// ── 사용자 관리 ─────────────────────────────────────────────────────────

export interface UserRowDb {
  id: number
  loginId: string
  name: string
  role: 'ADMIN' | 'VIEWER'
  groupId: number | null
  groupName: string | null
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function listUsers() {
  return many<UserRowDb>(
    `SELECT u.id, u.login_id AS "loginId", u.name, u.role,
            u.group_id AS "groupId", g.name AS "groupName",
            u.is_active AS "isActive",
            u.must_change_password AS "mustChangePassword",
            u.last_login_at AS "lastLoginAt",
            u.created_at AS "createdAt", u.updated_at AS "updatedAt"
       FROM users u LEFT JOIN groups g ON g.id = u.group_id
      ORDER BY u.login_id`,
    [], 'users_list',
  )
}

export function findByLoginId(c: pg.PoolClient, loginId: string) {
  return c.query<{ id: number }>('SELECT id FROM users WHERE login_id = $1', [loginId])
}

export async function insertUser(
  c: pg.PoolClient,
  v: { loginId: string; name: string; role: string; groupId: number | null; passwordHash: string },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO users (login_id, name, role, group_id, password_hash, must_change_password)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [v.loginId, v.name, v.role, v.groupId, v.passwordHash],
  )
  return r.rows[0]!.id
}

export function updateUser(
  c: pg.PoolClient, id: number,
  v: { name?: string; role?: string; groupId?: number | null; isActive?: boolean },
) {
  return c.query(
    `UPDATE users
        SET name       = coalesce($2, name),
            role       = coalesce($3, role),
            group_id   = CASE WHEN $4::boolean THEN $5 ELSE group_id END,
            is_active  = coalesce($6, is_active),
            updated_at = now()
      WHERE id = $1`,
    [id, v.name ?? null, v.role ?? null, v.groupId !== undefined, v.groupId ?? null, v.isActive ?? null],
  )
}

export function resetPassword(c: pg.PoolClient, id: number, hash: string) {
  return c.query(
    `UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now()
      WHERE id = $1`,
    [id, hash],
  )
}

export function userById(c: pg.PoolClient, id: number) {
  return c.query<{ id: number; login_id: string; role: string; is_active: boolean }>(
    'SELECT id, login_id, role, is_active FROM users WHERE id = $1', [id],
  )
}

/** 마지막 관리자를 잃지 않게 — 내리기 전에 센다 */
export async function activeAdminCount(c: pg.PoolClient, exceptId: number): Promise<number> {
  const r = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND is_active AND id <> $1`,
    [exceptId],
  )
  return r.rows[0]?.n ?? 0
}

// ── 권한 관리 ───────────────────────────────────────────────────────────

export function listGroups() {
  return many<{
    id: number; name: string; description: string | null
    memberCount: number; permissionCount: number
  }>(
    `SELECT g.id, g.name, g.description,
            (SELECT count(*)::int FROM users u WHERE u.group_id = g.id) AS "memberCount",
            (SELECT count(*)::int FROM group_permissions p WHERE p.group_id = g.id) AS "permissionCount"
       FROM groups g ORDER BY g.name`,
    [], 'groups_list',
  )
}

export async function insertGroup(c: pg.PoolClient, name: string, description: string | null) {
  const r = await c.query<{ id: number }>(
    'INSERT INTO groups (name, description) VALUES ($1,$2) RETURNING id', [name, description],
  )
  return r.rows[0]!.id
}

export function updateGroup(c: pg.PoolClient, id: number, name: string, description: string | null) {
  return c.query(
    'UPDATE groups SET name = $2, description = $3, updated_at = now() WHERE id = $1',
    [id, name, description],
  )
}

export function groupMembers(groupId: number) {
  return many<{ id: number; loginId: string; name: string }>(
    `SELECT id, login_id AS "loginId", name FROM users WHERE group_id = $1 ORDER BY login_id`,
    [groupId], 'group_members',
  )
}

export function grantedPermissions(groupId: number) {
  return many<{ permission_key: string }>(
    'SELECT permission_key FROM group_permissions WHERE group_id = $1',
    [groupId], 'group_granted',
  )
}

/** 통째로 갈아 끼운다 — 화면이 보낸 것이 그 그룹의 전부다 */
export async function replacePermissions(c: pg.PoolClient, groupId: number, keys: string[]) {
  await c.query('DELETE FROM group_permissions WHERE group_id = $1', [groupId])
  if (!keys.length) return
  await c.query(
    `INSERT INTO group_permissions (group_id, permission_key)
     SELECT $1::bigint, k FROM unnest($2::text[]) AS k
     ON CONFLICT DO NOTHING`,
    [groupId, keys],
  )
}

// ── 백업 관리 ───────────────────────────────────────────────────────────

export function backupStatus() {
  return Promise.all([
    one<{ tables: number }>(
      `SELECT count(*)::int AS tables FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`, [], 'bk_tables'),
    one<{ files: number; bytes: string }>(
      `SELECT count(*)::int AS files, coalesce(sum(byte_size),0)::text AS bytes FROM blobs`,
      [], 'bk_blobs'),
    one<{ lastFullAt: Date | null; lastIncrementalAt: Date | null; lastBy: string | null }>(
      `SELECT max(created_at) FILTER (WHERE kind='FULL')        AS "lastFullAt",
              max(created_at) FILTER (WHERE kind='INCREMENTAL') AS "lastIncrementalAt",
              (SELECT u.name FROM backup_runs r2 LEFT JOIN users u ON u.id = r2.created_by
                ORDER BY r2.created_at DESC LIMIT 1) AS "lastBy"
         FROM backup_runs`, [], 'bk_last'),
  ])
}

export interface BackupRunDb {
  id: number
  seq: number
  kind: string
  scope: string[]
  storagePath: string | null
  compressed: boolean
  byteSize: number | null
  fileCount: number | null
  missingCount: number
  state: string
  jobId: number | null
  downloadCount: number
  lastDownloadAt: Date | null
  note: string | null
  createdBy: string | null
  createdAt: Date
}

export function listBackups() {
  return many<BackupRunDb>(
    `SELECT r.id, r.seq, r.kind, r.scope,
            r.storage_path AS "storagePath",
            r.compressed, r.byte_size AS "byteSize",
            r.file_count AS "fileCount", r.missing_count AS "missingCount",
            r.state, r.job_id AS "jobId",
            r.download_count AS "downloadCount",
            r.last_download_at AS "lastDownloadAt",
            r.note, u.name AS "createdBy", r.created_at AS "createdAt"
       FROM backup_runs r LEFT JOIN users u ON u.id = r.created_by
      ORDER BY r.created_at DESC`,
    [], 'backup_list',
  )
}

export async function nextSeq(c: pg.PoolClient, kind: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    'SELECT coalesce(max(seq),0) + 1 AS n FROM backup_runs WHERE kind = $1', [kind],
  )
  return r.rows[0]!.n
}

export async function insertBackupRun(
  c: pg.PoolClient,
  v: {
    seq: number; kind: string; scope: string[]
    storagePath: string | null; compressed: boolean; userId: number
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO backup_runs (seq, kind, scope, storage_path, compressed, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [v.seq, v.kind, v.scope, v.storagePath, v.compressed, v.userId],
  )
  return r.rows[0]!.id
}

export function linkBackupJob(c: pg.PoolClient, runId: number, jobId: number) {
  return c.query('UPDATE backup_runs SET job_id = $2 WHERE id = $1', [runId, jobId])
}

export function setBackupNote(c: pg.PoolClient, runId: number, note: string | null) {
  return c.query('UPDATE backup_runs SET note = $2 WHERE id = $1', [runId, note])
}

/** 파일만 지운다 — 이력 줄은 어떤 경우에도 안 지워진다 (기존 정책) */
export function markBackupFileDeleted(c: pg.PoolClient, runId: number) {
  return c.query(
    `UPDATE backup_runs SET state = 'FILE_DELETED' WHERE id = $1 AND state <> 'FILE_DELETED'`,
    [runId],
  )
}
