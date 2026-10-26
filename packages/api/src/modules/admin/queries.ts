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

/**
 * 정렬 키 → SQL 식.
 * **여기 적힌 것만 쓴다** — 요청 문자열을 ORDER BY 에 바로 끼우면 SQL 주입이 된다.
 */
const AUDIT_SORT_SQL: Record<string, string> = {
  occurredAt: 'a.occurred_at',
  userName:   'a.user_name',
  screen:     'a.screen',
  action:     'a.action',
  target:     'a.target',
  clientIp:   'a.client_ip',
}
/** 커서에 담긴 문자열을 다시 원래 자료형으로 돌려놓을 때 쓴다. */
const auditCast = (sort: string) => (sort === 'occurredAt' ? 'timestamptz' : sort === 'clientIp' ? 'inet' : 'text')

export function listAudit(qp: AuditQuery) {
  const params: unknown[] = []
  const where = auditFilters(qp, params)

  const sortCol = AUDIT_SORT_SQL[qp.sort] ?? AUDIT_SORT_SQL.occurredAt!
  const desc = qp.dir === 'desc'
  const cmp = desc ? '<' : '>'
  // 비어 있는 줄이 섞여도 순서가 흔들리지 않게 NULL 자리를 고정한다
  const nulls = desc ? 'NULLS LAST' : 'NULLS FIRST'

  const cur = decodeCursor(qp.cursor)
  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(
      `(${sortCol}, a.id) ${cmp} ($${params.length - 1}::text::${auditCast(qp.sort)}, $${params.length}::bigint)`,
    )
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
      ORDER BY ${sortCol} ${desc ? 'DESC' : 'ASC'} ${nulls}, a.id ${desc ? 'DESC' : 'ASC'}
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
  employmentStatus: 'ACTIVE' | 'RETIRED' | 'DELETED'
  mustChangePassword: boolean
  lastLoginAt: Date | null
  previousLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
  employeeNumber: string | null
  email: string | null
  phone: string | null
  extensionNumber: string | null
  department: string | null
  position: string | null
  companyCode: string
  partnerCompanyId: number | null
  partnerCompanyName: string | null
  thumbnailUrl: string | null
  hireDate: string | null
  syncedAt: Date | null
}

/** 사용자 신원·조직 — 추가와 수정이 같은 칸을 쓴다. */
export interface UserProfileInput {
  employeeNumber?: string | null
  email?: string | null
  phone?: string | null
  extensionNumber?: string | null
  department?: string | null
  position?: string | null
  companyCode?: string
  partnerCompanyId?: number | null
  hireDate?: string | null
}

export function listUsers() {
  // u.position 은 반드시 테이블을 붙여 쓴다 — position() 은 PostgreSQL 내장 함수다.
  return many<UserRowDb>(
    `SELECT u.id, u.login_id AS "loginId", u.name, u.role,
            u.group_id AS "groupId", g.name AS "groupName",
            u.is_active AS "isActive",
            u.employment_status AS "employmentStatus",
            u.must_change_password AS "mustChangePassword",
            u.last_login_at AS "lastLoginAt",
            u.previous_login_at AS "previousLoginAt",
            u.created_at AS "createdAt", u.updated_at AS "updatedAt",
            u.employee_number AS "employeeNumber",
            u.email, u.phone, u.extension_number AS "extensionNumber",
            u.department, u.position, u.company_code AS "companyCode",
            u.partner_company_id AS "partnerCompanyId", pc.name AS "partnerCompanyName",
            u.thumbnail_url AS "thumbnailUrl",
            -- date 를 Date 객체로 받으면 toISOString() 에서 KST 자정이 UTC 전날로 내려가
            -- 입사일이 하루 밀린다. 여기서 문자열로 끝내면 그 자리가 없어진다.
            to_char(u.hire_date, 'YYYY-MM-DD') AS "hireDate", u.synced_at AS "syncedAt"
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       LEFT JOIN partner_companies pc ON pc.id = u.partner_company_id
      ORDER BY u.login_id`,
    [], 'users_list',
  )
}

export interface PartnerCompanyRowDb {
  id: number
  name: string
  companyCode: string | null
  representative: string | null
  businessType: string | null
  isActive: boolean
  memberCount: number
}

export function listPartnerCompanies() {
  return many<PartnerCompanyRowDb>(
    `SELECT pc.id, pc.name, pc.company_code AS "companyCode",
            pc.representative, pc.business_type AS "businessType",
            pc.is_active AS "isActive",
            (SELECT count(*)::int FROM users u WHERE u.partner_company_id = pc.id) AS "memberCount"
       FROM partner_companies pc
      ORDER BY pc.name`,
    [], 'partner_companies',
  )
}

export function findByLoginId(c: pg.PoolClient, loginId: string) {
  return c.query<{ id: number }>('SELECT id FROM users WHERE login_id = $1', [loginId])
}

export async function insertUser(
  c: pg.PoolClient,
  v: {
    loginId: string; name: string; role: string; groupId: number | null; passwordHash: string
  } & UserProfileInput,
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO users (login_id, name, role, group_id, password_hash, must_change_password,
                        employee_number, email, phone, extension_number,
                        department, position, company_code, partner_company_id, hire_date)
     VALUES ($1,$2,$3,$4,$5,true,
             $6,$7,$8,$9,$10,$11,coalesce($12,'SKGAS'),$13::bigint,$14::date) RETURNING id`,
    [
      v.loginId, v.name, v.role, v.groupId, v.passwordHash,
      v.employeeNumber ?? null, v.email ?? null, v.phone ?? null, v.extensionNumber ?? null,
      v.department ?? null, v.position ?? null, v.companyCode ?? null,
      v.partnerCompanyId ?? null, v.hireDate ?? null,
    ],
  )
  return r.rows[0]!.id
}

export function updateUser(
  c: pg.PoolClient, id: number,
  v: {
    name?: string; role?: string; groupId?: number | null
    isActive?: boolean; employmentStatus?: string
  } & UserProfileInput,
) {
  // null 로 **지우는 것**과 손대지 않는 것을 가려야 한다. coalesce 만 쓰면 둘이 같아진다.
  // 그래서 칸마다 "보냈는가"를 boolean 으로 함께 넘긴다.
  const sent = (x: unknown) => x !== undefined
  return c.query(
    `UPDATE users
        SET name              = coalesce($2, name),
            role              = coalesce($3, role),
            group_id          = CASE WHEN $4::boolean  THEN $5::bigint  ELSE group_id END,
            is_active         = coalesce($6, is_active),
            employment_status = coalesce($7, employment_status),
            employee_number   = CASE WHEN $8::boolean  THEN $9::text    ELSE employee_number END,
            email             = CASE WHEN $10::boolean THEN $11::text   ELSE email END,
            phone             = CASE WHEN $12::boolean THEN $13::text   ELSE phone END,
            extension_number  = CASE WHEN $14::boolean THEN $15::text   ELSE extension_number END,
            department        = CASE WHEN $16::boolean THEN $17::text   ELSE department END,
            position          = CASE WHEN $18::boolean THEN $19::text   ELSE position END,
            company_code      = coalesce($20, company_code),
            partner_company_id = CASE WHEN $21::boolean THEN $22::bigint ELSE partner_company_id END,
            hire_date         = CASE WHEN $23::boolean THEN $24::date   ELSE hire_date END,
            updated_at = now()
      WHERE id = $1`,
    [
      id, v.name ?? null, v.role ?? null,
      sent(v.groupId), v.groupId ?? null,
      v.isActive ?? null, v.employmentStatus ?? null,
      sent(v.employeeNumber), v.employeeNumber ?? null,
      sent(v.email), v.email ?? null,
      sent(v.phone), v.phone ?? null,
      sent(v.extensionNumber), v.extensionNumber ?? null,
      sent(v.department), v.department ?? null,
      sent(v.position), v.position ?? null,
      v.companyCode ?? null,
      sent(v.partnerCompanyId), v.partnerCompanyId ?? null,
      sent(v.hireDate), v.hireDate ?? null,
    ],
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
