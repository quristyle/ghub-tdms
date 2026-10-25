import type pg from 'pg'
import type { ExistingFile, OpenDistribution } from '@tdms/contracts'
import { many, one } from '../../core/db.js'

/** 반입·검수 쿼리. SQL 은 이 파일에만 있다. */

// ── 상태 머신 입력 ──────────────────────────────────────────────────────

export async function filesForDecision(c: pg.PoolClient, documentId: number): Promise<ExistingFile[]> {
  const r = await c.query<{ rev: number; branch: string | null; review_status: string }>(
    'SELECT rev, branch, review_status FROM files WHERE document_id = $1',
    [documentId],
  )
  return r.rows.map((x) => ({
    rev: x.rev,
    branch: x.branch,
    reviewStatus: x.review_status as ExistingFile['reviewStatus'],
  }))
}

export async function openDistributions(
  c: pg.PoolClient, documentId: number,
): Promise<OpenDistribution[]> {
  const r = await c.query<{ vendor_name: string; purpose: string; returned: boolean }>(
    `SELECT vendor_name, purpose, (returned_at IS NOT NULL) AS returned
       FROM distributions WHERE document_id = $1`,
    [documentId],
  )
  return r.rows.map((x) => ({
    vendorName: x.vendor_name,
    purpose: x.purpose as OpenDistribution['purpose'],
    returned: x.returned,
  }))
}

/** 자료 행을 잠근다. 잠금 순서는 언제나 '자료 먼저' — 파일부터 잠그면 같은 세트를 서로
 *  하나씩 쥐고 기다리는 교착이 생긴다 (기존 시스템의 2026-09-17 시큐어코딩 메모). */
export function lockDocument(c: pg.PoolClient, documentId: number) {
  return c.query<{ id: number; drawing_no: string; current_rev: number; status: string; folder_id: number }>(
    `SELECT id, drawing_no, current_rev, status, folder_id
       FROM documents WHERE id = $1 FOR UPDATE`,
    [documentId],
  )
}

/** 글자 없이 대기 중이던 시도를 'a' 로 소급한다 (backfillToA) */
export function backfillBranchA(c: pg.PoolClient, documentId: number, rev: number) {
  return c.query(
    `UPDATE files SET branch = 'a'
      WHERE document_id = $1 AND rev = $2 AND branch IS NULL
        AND review_status NOT IN ('MERGED','REJECTED')`,
    [documentId, rev],
  )
}

// ── 검수 대기 목록 ──────────────────────────────────────────────────────

export interface PendingRow {
  fileId: number
  documentId: number
  drawingNo: string
  title: string
  folderName: string
  rev: number
  branch: string | null
  fileExt: string
  displayName: string
  originalFilename: string
  byteSize: number
  vendorLabeledRev: string | null
  revMismatch: boolean
  vendorName: string | null
  projectName: string | null
  uploadedAt: Date
  uploadedBy: string | null
  distributedRev: number | null
}

export function listPending(filters: { q?: string; vendorId?: number; projectId?: number }) {
  const params: unknown[] = []
  const where = [`fl.review_status = 'PENDING'`]
  if (filters.q) {
    params.push(`%${filters.q}%`)
    where.push(`(d.search_text ILIKE $${params.length} OR fl.original_filename ILIKE $${params.length})`)
  }
  if (filters.vendorId !== undefined) {
    params.push(filters.vendorId)
    where.push(`fl.vendor_id = $${params.length}`)
  }
  if (filters.projectId !== undefined) {
    params.push(filters.projectId)
    where.push(`fl.project_id = $${params.length}`)
  }

  return many<PendingRow>(
    `SELECT fl.id                AS "fileId",
            fl.document_id       AS "documentId",
            d.drawing_no         AS "drawingNo",
            d.title,
            f.name               AS "folderName",
            fl.rev, fl.branch,
            fl.file_ext          AS "fileExt",
            fl.display_name      AS "displayName",
            fl.original_filename AS "originalFilename",
            b.byte_size          AS "byteSize",
            fl.vendor_labeled_rev AS "vendorLabeledRev",
            fl.rev_mismatch_warning AS "revMismatch",
            coalesce(fl.vendor_name, v.name) AS "vendorName",
            p.name               AS "projectName",
            fl.uploaded_at       AS "uploadedAt",
            u.name               AS "uploadedBy",
            lastdist.rev_at_distribution AS "distributedRev"
       FROM files fl
       JOIN documents d ON d.id = fl.document_id
       JOIN folders f   ON f.id = d.folder_id
       JOIN blobs b     ON b.sha256 = fl.blob_sha256
  LEFT JOIN vendors v   ON v.id = fl.vendor_id
  LEFT JOIN projects p  ON p.id = fl.project_id
  LEFT JOIN users u     ON u.id = fl.uploaded_by
  LEFT JOIN LATERAL (SELECT rev_at_distribution FROM distributions
                      WHERE document_id = d.id
                      ORDER BY distributed_at DESC LIMIT 1) lastdist ON true
      WHERE ${where.join(' AND ')}
      ORDER BY fl.uploaded_at DESC, fl.document_id, fl.rev, fl.branch NULLS FIRST, fl.file_ext`,
    params,
  )
}

/** 한 세트(같은 문서·rev·branch)의 검수대기 파일 전부 */
export async function setFiles(c: pg.PoolClient, documentId: number, rev: number, branch: string | null) {
  const r = await c.query<{ id: number; file_ext: string; vendor_id: number | null; vendor_name: string | null }>(
    `SELECT fl.id, fl.file_ext, fl.vendor_id,
            coalesce(fl.vendor_name, v.name) AS vendor_name
       FROM files fl
  LEFT JOIN vendors v ON v.id = fl.vendor_id
      WHERE fl.document_id = $1 AND fl.rev = $2
        AND fl.branch IS NOT DISTINCT FROM $3
        AND fl.review_status = 'PENDING'`,
    [documentId, rev, branch],
  )
  return r.rows
}

export async function fileForReview(c: pg.PoolClient, fileId: number) {
  const r = await c.query<{
    id: number; document_id: number; rev: number; branch: string | null; review_status: string
  }>(
    'SELECT id, document_id, rev, branch, review_status FROM files WHERE id = $1',
    [fileId],
  )
  return r.rows[0]
}

/** 분기 진행률: 미반납 수정용 반출 몇 건 중 몇 건이 들어왔는가 */
export async function branchProgress(c: pg.PoolClient, documentId: number) {
  const r = await c.query<{ expected: number; arrived: number }>(
    `SELECT count(*)::int AS expected,
            count(*) FILTER (WHERE returned_at IS NOT NULL)::int AS arrived
       FROM distributions
      WHERE document_id = $1 AND purpose = 'MODIFY'`,
    [documentId],
  )
  return r.rows[0] ?? { expected: 0, arrived: 0 }
}

// ── 승인·반려 ───────────────────────────────────────────────────────────

export function markReviewed(
  c: pg.PoolClient, fileIds: number[], status: string, note: string | null, branch?: string | null,
) {
  return c.query(
    branch === undefined
      ? `UPDATE files SET review_status = $2, review_note = $3 WHERE id = ANY($1::bigint[])`
      : `UPDATE files SET review_status = $2, review_note = $3, branch = $4 WHERE id = ANY($1::bigint[])`,
    branch === undefined ? [fileIds, status, note] : [fileIds, status, note, branch],
  )
}

/** 반려된 파일이 어느 반출의 반납이었으면 그 반출을 다시 '미반납'으로 되돌린다.
 *  반려됐으니 실제로는 아직 정상 반납이 아니다 — 중복반출 카운트도 이걸로 자동 보정된다. */
export function reopenDistributions(c: pg.PoolClient, fileIds: number[]) {
  return c.query(
    `UPDATE distributions SET returned_at = NULL, returned_file_id = NULL
      WHERE returned_file_id = ANY($1::bigint[])`,
    [fileIds],
  )
}

/** 현재본 교체. 기존 현재본은 이력으로 내려가고(행은 남는다) 이번 세트가 올라온다. */
export async function promoteToCurrent(
  c: pg.PoolClient, documentId: number, fileIds: number[], rev: number,
) {
  await c.query('UPDATE files SET is_current = false WHERE document_id = $1 AND is_current', [documentId])
  await c.query('UPDATE files SET is_current = true WHERE id = ANY($1::bigint[])', [fileIds])
  await c.query(
    `UPDATE documents d
        SET current_rev = $2,
            status = 'ACTIVE',
            has_pdf = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext = 'pdf'),
            has_dwg = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext = 'dwg'),
            has_xlsx = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext IN ('xlsx','xls')),
            updated_at = now()
      WHERE d.id = $1`,
    [documentId, rev],
  )
}

export function setDocumentStatus(c: pg.PoolClient, documentId: number, status: string) {
  return c.query('UPDATE documents SET status = $2, updated_at = now() WHERE id = $1', [documentId, status])
}

/** 열려 있던 분기본들을 '통합됨' 으로 닫는다. 행은 지우지 않는다 — 이력에 남아야 한다(D-6). */
export async function closeBranchSiblings(c: pg.PoolClient, documentId: number): Promise<number> {
  const r = await c.query(
    `UPDATE files SET review_status = 'MERGED'
      WHERE document_id = $1 AND branch IS NOT NULL
        AND review_status IN ('PENDING','APPROVED')`,
    [documentId],
  )
  return r.rowCount ?? 0
}

/** 반입된 파일이 어느 반출을 닫았는지 기록한다 */
export function closeDistribution(c: pg.PoolClient, documentId: number, vendorId: number | null, fileId: number) {
  return c.query(
    `UPDATE distributions SET returned_at = now(), returned_file_id = $3
      WHERE id = (SELECT id FROM distributions
                   WHERE document_id = $1 AND returned_at IS NULL
                     AND ($2::bigint IS NULL OR vendor_id = $2)
                   ORDER BY distributed_at LIMIT 1)`,
    [documentId, vendorId, fileId],
  )
}

// ── 리비전 세트 생성 ────────────────────────────────────────────────────

export async function createRevisionSet(
  c: pg.PoolClient,
  v: { documentId: number; rev: number; branch: string | null; reason: string; userId: number },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO revision_sets (document_id, rev, branch, reason, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (document_id, rev, branch) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING id`,
    [v.documentId, v.rev, v.branch, v.reason, v.userId],
  )
  return r.rows[0]!.id
}

export async function insertPendingFile(
  c: pg.PoolClient,
  v: {
    documentId: number; revisionSetId: number; sha256: Buffer; rev: number; branch: string | null
    fileExt: string; displayName: string; originalFilename: string
    vendorId: number | null; vendorName: string; projectId: number | null
    vendorLabeledRev: string | null; revMismatch: boolean; userId: number
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO files (document_id, revision_set_id, blob_sha256, rev, branch, file_ext,
                        display_name, original_filename, review_status, is_current,
                        vendor_id, vendor_name, project_id, vendor_labeled_rev,
                        rev_mismatch_warning, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',false,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [v.documentId, v.revisionSetId, v.sha256, v.rev, v.branch, v.fileExt,
     v.displayName, v.originalFilename, v.vendorId, v.vendorName, v.projectId,
     v.vendorLabeledRev, v.revMismatch, v.userId],
  )
  await c.query('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = $1', [v.sha256])
  return r.rows[0]!.id
}

// ── 확인 필요 ───────────────────────────────────────────────────────────

export interface IssueRow {
  id: number
  filename: string
  originalFilename: string | null
  byteSize: number | null
  reason: string
  reasonDetail: string | null
  vendorName: string | null
  projectName: string | null
  suggestedDocumentId: number | null
  suggestedDrawingNo: string | null
  createdAt: Date
  createdBy: string | null
}

export function listIssues() {
  return many<IssueRow>(
    `SELECT i.id, i.filename,
            i.original_filename AS "originalFilename",
            i.byte_size         AS "byteSize",
            i.reason, i.reason_detail AS "reasonDetail",
            v.name              AS "vendorName",
            p.name              AS "projectName",
            i.suggested_document_id AS "suggestedDocumentId",
            d.drawing_no        AS "suggestedDrawingNo",
            i.created_at        AS "createdAt",
            u.name              AS "createdBy"
       FROM import_issues i
  LEFT JOIN vendors v   ON v.id = i.vendor_id
  LEFT JOIN projects p  ON p.id = i.project_id
  LEFT JOIN documents d ON d.id = i.suggested_document_id
  LEFT JOIN users u     ON u.id = i.created_by
      WHERE i.state = 'OPEN'
      ORDER BY i.created_at DESC`,
    [],
    'import_issues_open',
  )
}

export async function findIssue(c: pg.PoolClient, id: number) {
  const r = await c.query<{
    id: number; filename: string; blob_sha256: Buffer | null; state: string
    vendor_id: number | null; project_id: number | null; suggested_document_id: number | null
  }>(
    `SELECT id, filename, blob_sha256, state, vendor_id, project_id, suggested_document_id
       FROM import_issues WHERE id = $1`,
    [id],
  )
  return r.rows[0]
}

export function closeIssue(c: pg.PoolClient, id: number, state: 'RESOLVED' | 'DISCARDED', userId: number) {
  return c.query(
    `UPDATE import_issues SET state = $2, resolved_at = now(), resolved_by = $3 WHERE id = $1`,
    [id, state, userId],
  )
}

export function setIssueSuggestion(c: pg.PoolClient, id: number, documentId: number | null) {
  return c.query('UPDATE import_issues SET suggested_document_id = $2 WHERE id = $1', [id, documentId])
}

/** 파일명으로 자료를 찾는다 — 재검수·경로 짐작에 쓴다 */
export function findDocumentByName(c: pg.PoolClient, stem: string) {
  return c.query<{ id: number; drawing_no: string }>(
    `SELECT id, drawing_no FROM documents
      WHERE NOT is_archived AND status <> 'RETIRED' AND upper(drawing_no) = upper($1)
      LIMIT 2`,
    [stem],
  )
}

// ── 중복반출 현황 ───────────────────────────────────────────────────────

export interface DuplicateRow {
  distributionId: number
  vendorName: string
  projectName: string | null
  revAtDistribution: number
  distributedAt: Date
  returnedAt: Date | null
  branch: string | null
}

export function listDuplicateDistributions(documentId: number) {
  return many<DuplicateRow>(
    `SELECT x.id AS "distributionId",
            x.vendor_name AS "vendorName",
            p.name        AS "projectName",
            x.rev_at_distribution AS "revAtDistribution",
            x.distributed_at AS "distributedAt",
            x.returned_at    AS "returnedAt",
            rf.branch
       FROM distributions x
  LEFT JOIN projects p ON p.id = x.project_id
  LEFT JOIN files rf   ON rf.id = x.returned_file_id
      WHERE x.document_id = $1 AND x.purpose = 'MODIFY'
      ORDER BY x.distributed_at`,
    [documentId],
    'duplicate_distributions',
  )
}

export function documentBrief(documentId: number) {
  return one<{ id: number; drawingNo: string; title: string; currentRev: number; status: string }>(
    `SELECT id, drawing_no AS "drawingNo", title, current_rev AS "currentRev", status
       FROM documents WHERE id = $1`,
    [documentId],
    'document_brief',
  )
}
