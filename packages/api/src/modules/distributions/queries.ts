import type pg from 'pg'
import { many, one } from '../../core/db.js'
import type { DistributionListQuery, ForImportQuery } from '@tdms/contracts'
import { decodeCursor } from '../../core/cursor.js'

/** 반출이력 쿼리. SQL 은 이 파일에만 있다. */

export interface DistRow {
  id: number
  documentId: number | null
  documentLabel: string
  title: string | null
  revAtDistribution: number
  vendorName: string
  projectName: string | null
  purpose: string
  purposeNote: string | null
  zipName: string | null
  distributedBy: string | null
  distributedAt: Date
  returnedAt: Date | null
  returnNote: string | null
  manualReturn: boolean
  note: string | null
  returnedFileReview: string | null
}

/**
 * 반출 1건의 공통 선택부.
 *
 * 자료가 완전 삭제되면 document_id 가 NULL 이 된다(0013). 그때도 document_label
 * 스냅샷으로 무엇이었는지 알 수 있어야 하므로 LEFT JOIN 이다.
 */
const SELECT_DIST = `
  SELECT x.id,
         x.document_id          AS "documentId",
         coalesce(x.document_label, d.drawing_no, '(삭제된 자료)') AS "documentLabel",
         d.title,
         x.rev_at_distribution  AS "revAtDistribution",
         x.vendor_name          AS "vendorName",
         p.name                 AS "projectName",
         x.purpose,
         x.purpose_note         AS "purposeNote",
         x.zip_name             AS "zipName",
         u.name                 AS "distributedBy",
         x.distributed_at       AS "distributedAt",
         x.returned_at          AS "returnedAt",
         x.return_note          AS "returnNote",
         x.manual_return        AS "manualReturn",
         x.note,
         rf.review_status       AS "returnedFileReview"
    FROM distributions x
    LEFT JOIN documents d ON d.id = x.document_id
    LEFT JOIN projects  p ON p.id = x.project_id
    LEFT JOIN users     u ON u.id = x.distributed_by
    LEFT JOIN files    rf ON rf.id = x.returned_file_id`

/** 화면 라벨(반입완료/반입미완료/확인필요/검수대기)로 거르는 조건 */
const STATE_SQL: Record<string, string> = {
  DONE: `x.returned_at IS NOT NULL AND coalesce(rf.review_status,'APPROVED') = 'APPROVED'`,
  INCOMPLETE: `x.returned_at IS NULL`,
  ISSUE: `x.returned_at IS NOT NULL AND rf.review_status = 'ISSUE'`,
  REVIEWING: `x.returned_at IS NOT NULL AND rf.review_status = 'PENDING'`,
}

function buildFilters(qp: DistributionListQuery, params: unknown[]): string[] {
  const where: string[] = []
  if (qp.dateFrom) { params.push(qp.dateFrom); where.push(`x.distributed_at >= $${params.length}::timestamptz`) }
  if (qp.dateTo)   { params.push(qp.dateTo);   where.push(`x.distributed_at < ($${params.length}::timestamptz + interval '1 day')`) }
  if (qp.vendorId !== undefined)  { params.push(qp.vendorId);  where.push(`x.vendor_id = $${params.length}`) }
  if (qp.projectId !== undefined) { params.push(qp.projectId); where.push(`x.project_id = $${params.length}`) }
  if (qp.purpose)                 { params.push(qp.purpose);   where.push(`x.purpose = $${params.length}`) }
  if (qp.distributedBy !== undefined) { params.push(qp.distributedBy); where.push(`x.distributed_by = $${params.length}`) }
  if (qp.q) {
    params.push(`%${qp.q}%`)
    where.push(`(coalesce(x.document_label, d.drawing_no) ILIKE $${params.length} OR d.title ILIKE $${params.length})`)
  }
  if (qp.state) where.push(STATE_SQL[qp.state]!)
  return where
}

export function listDistributions(qp: DistributionListQuery) {
  const params: unknown[] = []
  const where = buildFilters(qp, params)

  const cur = decodeCursor(qp.cursor)
  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(`(x.distributed_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`)
  }
  params.push(qp.limit + 1)

  return many<DistRow>(
    `${SELECT_DIST}
      ${where.length ? `WHERE ${where.join('\n        AND ')}` : ''}
      ORDER BY x.distributed_at DESC, x.id DESC
      LIMIT $${params.length}`,
    params,
  )
}

export async function countDistributions(qp: DistributionListQuery): Promise<number> {
  const params: unknown[] = []
  const where = buildFilters(qp, params)
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM distributions x
       LEFT JOIN documents d ON d.id = x.document_id
       LEFT JOIN files    rf ON rf.id = x.returned_file_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  )
  return row?.n ?? 0
}

// ── Zip 별 보기 ─────────────────────────────────────────────────────────

export interface ZipRow {
  zipName: string
  vendorName: string
  projectName: string | null
  purpose: string
  distributedBy: string | null
  distributedAt: Date
  itemCount: number
  returnedCount: number
}

export function listZipExports(qp: DistributionListQuery) {
  const params: unknown[] = []
  const where = buildFilters(qp, params)
  where.push('x.zip_name IS NOT NULL')

  return many<ZipRow>(
    `SELECT x.zip_name          AS "zipName",
            min(x.vendor_name)  AS "vendorName",
            min(p.name)         AS "projectName",
            min(x.purpose)      AS "purpose",
            min(u.name)         AS "distributedBy",
            min(x.distributed_at) AS "distributedAt",
            count(*)::int       AS "itemCount",
            count(x.returned_at)::int AS "returnedCount"
       FROM distributions x
       LEFT JOIN documents d ON d.id = x.document_id
       LEFT JOIN projects  p ON p.id = x.project_id
       LEFT JOIN users     u ON u.id = x.distributed_by
       LEFT JOIN files    rf ON rf.id = x.returned_file_id
      WHERE ${where.join(' AND ')}
      GROUP BY x.zip_name
      ORDER BY min(x.distributed_at) DESC`,
    params,
  )
}

export function listByZip(zipName: string) {
  return many<DistRow>(
    `${SELECT_DIST} WHERE x.zip_name = $1 ORDER BY coalesce(x.document_label, d.drawing_no)`,
    [zipName],
    'dist_by_zip',
  )
}

// ── 미입고 ──────────────────────────────────────────────────────────────

/**
 * "곧 바뀔 수 있는" 반출 건 — 오래 나가 있는 순.
 *
 * 두 가지를 함께 센다 (기존 2026-08-14 CM 확정)
 *   ① 아직 안 돌아온 것
 *   ② 돌아왔지만 아직 검수 전인 것 — 승인되는 순간 리비전이 바뀐다
 * 검수까지 끝난 것은 더 이상 "곧 바뀔" 상태가 아니므로 빠진다.
 */
const OUTSTANDING_WHERE = `
  x.purpose = 'MODIFY'
  AND (x.returned_at IS NULL OR rf.review_status = 'PENDING')`

export function listOutstanding() {
  return many<DistRow>(
    `${SELECT_DIST} WHERE ${OUTSTANDING_WHERE} ORDER BY x.distributed_at`,
    [],
    'dist_outstanding',
  )
}

export function outstandingSummary() {
  return one<{
    total: number; notReturned: number; reviewing: number; oldestDays: number | null
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE x.returned_at IS NULL)::int AS "notReturned",
            count(*) FILTER (WHERE x.returned_at IS NOT NULL)::int AS reviewing,
            max(extract(day FROM now() - x.distributed_at))::int AS "oldestDays"
       FROM distributions x
       LEFT JOIN files rf ON rf.id = x.returned_file_id
      WHERE ${OUTSTANDING_WHERE}`,
    [],
    'dist_outstanding_summary',
  )
}

export function outstandingByVendor() {
  return many<{ vendorName: string; count: number }>(
    `SELECT x.vendor_name AS "vendorName", count(*)::int AS count
       FROM distributions x
       LEFT JOIN files rf ON rf.id = x.returned_file_id
      WHERE ${OUTSTANDING_WHERE}
      GROUP BY x.vendor_name
      ORDER BY count DESC`,
    [],
    'dist_outstanding_by_vendor',
  )
}

// ── 반입 대상 ───────────────────────────────────────────────────────────

export function listForImport(qp: ForImportQuery) {
  const params: unknown[] = []
  const where = [`x.purpose = 'MODIFY'`]
  if (qp.vendorId !== undefined) { params.push(qp.vendorId); where.push(`x.vendor_id = $${params.length}`) }
  else if (qp.vendorName) { params.push(qp.vendorName); where.push(`x.vendor_name = $${params.length}`) }
  if (qp.projectId !== undefined) { params.push(qp.projectId); where.push(`x.project_id = $${params.length}`) }
  if (qp.dateFrom) { params.push(qp.dateFrom); where.push(`x.distributed_at >= $${params.length}::timestamptz`) }
  if (qp.dateTo)   { params.push(qp.dateTo);   where.push(`x.distributed_at < ($${params.length}::timestamptz + interval '1 day')`) }
  if (qp.state)    where.push(STATE_SQL[qp.state]!)

  return many<DistRow>(
    `${SELECT_DIST} WHERE ${where.join(' AND ')} ORDER BY x.distributed_at DESC`,
    params,
  )
}

// ── 반납 처리 ───────────────────────────────────────────────────────────

export async function findForReturn(c: pg.PoolClient, ids: number[]) {
  const r = await c.query<{ id: number; returned_at: Date | null; document_label: string | null }>(
    `SELECT id, returned_at, document_label FROM distributions WHERE id = ANY($1::bigint[]) FOR UPDATE`,
    [ids],
  )
  return r.rows
}

/** 수정 없이 반납 — 업체가 손대지 않고 그대로 돌려준 경우. 파일이 따라오지 않는다. */
export async function markReturned(
  c: pg.PoolClient, ids: number[], manual: boolean, note: string | null,
): Promise<number> {
  const r = await c.query(
    `UPDATE distributions
        SET returned_at = now(), manual_return = $2, return_note = coalesce($3, return_note)
      WHERE id = ANY($1::bigint[]) AND returned_at IS NULL`,
    [ids, manual, note],
  )
  return r.rowCount ?? 0
}

// ── 반출 실행 ───────────────────────────────────────────────────────────

export function documentsForDistribution(c: pg.PoolClient, ids: number[]) {
  return c.query<{ id: number; drawing_no: string; current_rev: number; is_archived: boolean }>(
    `SELECT id, drawing_no, current_rev, is_archived FROM documents WHERE id = ANY($1::bigint[])`,
    [ids],
  )
}

/** 이미 다른 업체가 수정 중인 자료 — 막지 않고 경고만 한다 (기존 정책) */
export function duplicateWarnings(c: pg.PoolClient, ids: number[], vendorName: string) {
  return c.query<{ document_id: number; drawing_no: string; vendor_name: string; distributed_at: Date }>(
    `SELECT DISTINCT ON (x.document_id)
            x.document_id, d.drawing_no, x.vendor_name, x.distributed_at
       FROM distributions x JOIN documents d ON d.id = x.document_id
      WHERE x.document_id = ANY($1::bigint[])
        AND x.purpose = 'MODIFY' AND x.returned_at IS NULL
        AND x.vendor_name <> $2
      ORDER BY x.document_id, x.distributed_at DESC`,
    [ids, vendorName],
  )
}

export async function insertDistributions(
  c: pg.PoolClient,
  v: {
    docs: { id: number; drawing_no: string; current_rev: number }[]
    vendorId: number | null; vendorName: string; projectId: number | null
    purpose: string; purposeNote: string | null
    zipName: string; keepPaths: boolean; userId: number
  },
): Promise<number> {
  const r = await c.query(
    `INSERT INTO distributions
       (document_id, document_label, rev_at_distribution, vendor_id, vendor_name,
        project_id, purpose, purpose_note, zip_name, keep_paths, distributed_by)
     SELECT u.id, u.label, u.rev, $2, $3, $4, $5, $6, $7, $8, $9
       FROM unnest($1::bigint[], $10::text[], $11::int[]) AS u(id, label, rev)`,
    [
      v.docs.map((d) => d.id), v.vendorId, v.vendorName, v.projectId,
      v.purpose, v.purposeNote, v.zipName, v.keepPaths, v.userId,
      v.docs.map((d) => d.drawing_no), v.docs.map((d) => d.current_rev),
    ],
  )
  return r.rowCount ?? 0
}

// ── 검색 보조 ───────────────────────────────────────────────────────────

export function filterOptions() {
  return Promise.all([
    many<{ id: number; name: string }>(
      `SELECT id, name FROM vendors WHERE NOT is_hidden ORDER BY name`, [], 'opt_vendors'),
    many<{ id: number; name: string }>(
      `SELECT id, name FROM projects WHERE NOT is_hidden ORDER BY name`, [], 'opt_projects'),
    many<{ id: number; name: string }>(
      `SELECT DISTINCT u.id, u.name FROM distributions x JOIN users u ON u.id = x.distributed_by
        ORDER BY u.name`, [], 'opt_distributors'),
  ])
}
