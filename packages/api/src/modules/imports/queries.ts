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
  /** 자료의 분류 — 기존 화면 '분류' 칸 */
  category: string | null
  /** 루트부터의 폴더 이름 — 기존 화면 '경로' 칸 */
  folderNames: string[]
  /** 반출 시점(rev_at_distribution) 파일 확장자 — 기존 화면 '반출자료' 칸 */
  distributedExts: string[]
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
  currentPdfFileId: number | null
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
            d.category,
            fp.names             AS "folderNames",
            coalesce((SELECT array_agg(DISTINCT lower(df.file_ext)) FROM files df
                       WHERE df.document_id = d.id
                         AND df.rev = coalesce(lastdist.rev_at_distribution, 0)
                         AND df.review_status IN ('APPROVED','MERGED')), '{}') AS "distributedExts",
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
            lastdist.rev_at_distribution AS "distributedRev",
            (SELECT cf.id FROM files cf
              WHERE cf.document_id = d.id AND cf.is_current AND cf.file_ext = 'pdf'
              LIMIT 1)           AS "currentPdfFileId"
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
     CROSS JOIN LATERAL (SELECT array_agg(a.name ORDER BY a.depth) AS names
                           FROM folders a WHERE a.path @> f.path) fp
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

/**
 * 분기(중복반출) 진행률의 기준 — '아직 안 끝난' 수정용 반출만 센다.
 *
 *   · 아직 안 돌아온 것, 또는
 *   · 돌아왔지만 그 반납본이 검수 전이거나, 승인됐어도 분기본이라 병합을 기다리는 것.
 *
 * 분기 글자 없이 승인된 반납본은 이미 현재본이 된 '끝난' 반출이라 세지 않는다 —
 * 세면 한 번 반입을 마친 자료가 다음 반입 때 중복반출로 잘못 보인다.
 * 승인 가로막기와 화면 표기가 같은 수를 보도록 규칙을 여기 한 곳에만 둔다.
 */
const OPEN_MODIFY_DIST = `
       FROM distributions x
  LEFT JOIN files rf ON rf.id = x.returned_file_id
      WHERE x.purpose = 'MODIFY'
        AND (x.returned_at IS NULL
             OR rf.review_status = 'PENDING'
             OR (rf.review_status IN ('APPROVED','MERGED') AND rf.branch IS NOT NULL))`

/** 분기 진행률 (한 자료) — 승인 가로막기에 쓴다 */
export async function branchProgress(c: pg.PoolClient, documentId: number) {
  const r = await c.query<{ expected: number; arrived: number }>(
    `SELECT count(*)::int AS expected,
            count(*) FILTER (WHERE x.returned_at IS NOT NULL)::int AS arrived
     ${OPEN_MODIFY_DIST} AND x.document_id = $1`,
    [documentId],
  )
  return r.rows[0] ?? { expected: 0, arrived: 0 }
}

export interface BranchProgressRow { documentId: number; expected: number; arrived: number }

/** 분기 진행률 (여러 자료 한 번에) — 검수대기 목록의 '1-a(2/3)' 표기에 쓴다 */
export function branchProgressMany(documentIds: number[]) {
  return many<BranchProgressRow>(
    `SELECT x.document_id AS "documentId",
            count(*)::int AS expected,
            count(*) FILTER (WHERE x.returned_at IS NOT NULL)::int AS arrived
     ${OPEN_MODIFY_DIST} AND x.document_id = ANY($1::bigint[])
      GROUP BY x.document_id`,
    [documentIds],
    'branch_progress',
  )
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

/** 반출 기록에 자료명 스냅샷을 채운다 (자료가 완전 삭제돼도 남아야 한다) */
export function stampDistributionLabels(c: pg.PoolClient, documentId: number) {
  return c.query(
    `UPDATE distributions x SET document_label = d.drawing_no
       FROM documents d
      WHERE d.id = x.document_id AND x.document_id = $1 AND x.document_label IS NULL`,
    [documentId],
  )
}

/** 반입된 파일이 어느 반출을 닫았는지 기록한다 */
export function closeDistribution(
  c: pg.PoolClient, documentId: number, vendorId: number | null, fileId: number,
  distributionId: number | null = null,
) {
  // 반입 진단이 어느 반출 건인지 이미 골랐으면(반출목록의 업체 기준) 그 건을 닫는다 —
  // 중복반출일 때 엉뚱한 업체의 반출 건이 닫히지 않게 한다
  if (distributionId !== null) {
    return c.query(
      `UPDATE distributions SET returned_at = now(), returned_file_id = $2
        WHERE id = $1 AND returned_at IS NULL`,
      [distributionId, fileId],
    )
  }
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

// ── 반입 진단의 기준 (반출된 자료) ──────────────────────────────────────

export interface ExpectedRow {
  documentId: number
  drawingNo: string
  currentRev: number
  /** 루트부터의 폴더 이름 */
  folderNames: string[]
  distributionId: number
  vendorId: number | null
  vendorName: string
  projectId: number | null
  revAtDistribution: number
  returned: boolean
  keepPaths: boolean
  /** 반출 시점(rev_at_distribution) 파일 확장자 = '반출자료' */
  exts: string[]
}

/** x = 고른 반출 건, d = 자료. FROM 절만 바꿔 끼운다. */
function expectedSelect(from: string): string {
  return `
    SELECT d.id AS "documentId", d.drawing_no AS "drawingNo", d.current_rev AS "currentRev",
           fp.names AS "folderNames",
           x.id AS "distributionId", x.vendor_id AS "vendorId", x.vendor_name AS "vendorName",
           x.project_id AS "projectId", x.rev_at_distribution AS "revAtDistribution",
           (x.returned_at IS NOT NULL) AS returned, x.keep_paths AS "keepPaths",
           coalesce((SELECT array_agg(DISTINCT lower(fl.file_ext)) FROM files fl
                      WHERE fl.document_id = d.id AND fl.rev = x.rev_at_distribution
                        AND fl.review_status IN ('APPROVED','MERGED')), '{}') AS exts
      ${from}
      JOIN folders f ON f.id = d.folder_id
     CROSS JOIN LATERAL (SELECT array_agg(a.name ORDER BY a.depth) AS names
                           FROM folders a WHERE a.path @> f.path) fp`
}

/**
 * 반출목록(문서ID, 업체) → 자료별 반출 건.
 * 업체가 적혀 있으면 그 업체의 반출 건을 먼저 고른다 — 같은 자료가 여러 업체로 나가 있어도
 * (중복반출) 엉뚱한 업체의 반출 건에 반입되지 않게 한다. 미반납 건이 먼저다.
 */
export function expectedFromManifest(c: pg.PoolClient, ids: number[], vendors: (string | null)[]) {
  return c.query<ExpectedRow>(
    `${expectedSelect(`
      FROM unnest($1::bigint[], $2::text[]) WITH ORDINALITY AS m(doc_id, vendor, ord)
      JOIN documents d ON d.id = m.doc_id
      JOIN LATERAL (SELECT * FROM distributions x
                     WHERE x.document_id = d.id AND x.purpose = 'MODIFY'
                     ORDER BY (m.vendor IS NOT NULL AND x.vendor_name = m.vendor) DESC,
                              (x.returned_at IS NOT NULL), x.distributed_at
                     LIMIT 1) x ON true`)}
     ORDER BY m.ord`,
    [ids, vendors],
  )
}

/** 고른 반출 건 → 자료별 대표 한 건 (미반납 우선) */
export function expectedFromDistributions(c: pg.PoolClient, distributionIds: number[]) {
  return c.query<ExpectedRow>(
    `${expectedSelect(`
      FROM (SELECT DISTINCT ON (x.document_id) x.* FROM distributions x
             WHERE x.id = ANY($1::bigint[]) AND x.document_id IS NOT NULL
             ORDER BY x.document_id, (x.returned_at IS NOT NULL), x.distributed_at) x
      JOIN documents d ON d.id = x.document_id`)}
     ORDER BY d.drawing_no`,
    [distributionIds],
  )
}

/** Zip 묶음 이름으로 반출 건을 고른다 */
export function expectedFromZipName(c: pg.PoolClient, zipName: string) {
  return c.query<ExpectedRow>(
    `${expectedSelect(`
      FROM (SELECT DISTINCT ON (x.document_id) x.* FROM distributions x
             WHERE x.zip_name = $1 AND x.purpose = 'MODIFY' AND x.document_id IS NOT NULL
             ORDER BY x.document_id, (x.returned_at IS NOT NULL), x.distributed_at) x
      JOIN documents d ON d.id = x.document_id`)}
     ORDER BY d.drawing_no`,
    [zipName],
  )
}

// ── 반입 자료 — 반출 건 고르기 ──────────────────────────────────────────

export interface ImportTargetRow {
  distributionId: number
  documentId: number
  drawingNo: string
  title: string
  folderNames: string[]
  revAtDistribution: number
  vendorName: string
  projectId: number | null
  projectName: string | null
  zipName: string | null
  distributedAt: Date
  hasDwg: boolean
  hasPdf: boolean
  hasXlsx: boolean
  hasEtc: boolean
  status: 'INCOMPLETE' | 'REVIEWING' | 'DONE'
}

export function listImportTargets(qp: {
  vendorName?: string; projectId?: number; dateFrom?: string; dateTo?: string
}) {
  const params: unknown[] = []
  const where = [`x.purpose = 'MODIFY'`, 'x.document_id IS NOT NULL']
  if (qp.vendorName) {
    params.push(qp.vendorName)
    where.push(`x.vendor_name = $${params.length}`)
  } else {
    // 업체를 아직 안 골랐으면 드롭다운용 — 반입 미완료 건만
    where.push('x.returned_at IS NULL')
  }
  if (qp.projectId !== undefined) {
    params.push(qp.projectId)
    where.push(`x.project_id = $${params.length}`)
  }
  if (qp.dateFrom) {
    params.push(qp.dateFrom)
    where.push(`x.distributed_at >= $${params.length}::date`)
  }
  if (qp.dateTo) {
    params.push(qp.dateTo)
    where.push(`x.distributed_at < $${params.length}::date + 1`)
  }
  return many<ImportTargetRow>(
    `SELECT x.id AS "distributionId", d.id AS "documentId", d.drawing_no AS "drawingNo", d.title,
            (SELECT array_agg(a.name ORDER BY a.depth) FROM folders a WHERE a.path @> f.path) AS "folderNames",
            x.rev_at_distribution AS "revAtDistribution", x.vendor_name AS "vendorName",
            x.project_id AS "projectId", p.name AS "projectName", x.zip_name AS "zipName",
            x.distributed_at AS "distributedAt",
            d.has_dwg AS "hasDwg", d.has_pdf AS "hasPdf", d.has_xlsx AS "hasXlsx", d.has_etc AS "hasEtc",
            CASE WHEN x.returned_at IS NULL THEN 'INCOMPLETE'
                 WHEN rf.review_status = 'PENDING' THEN 'REVIEWING'
                 ELSE 'DONE' END AS status
       FROM distributions x
       JOIN documents d ON d.id = x.document_id
       JOIN folders f   ON f.id = d.folder_id
  LEFT JOIN projects p  ON p.id = x.project_id
  LEFT JOIN files rf    ON rf.id = x.returned_file_id
      WHERE ${where.join(' AND ')}
      ORDER BY x.distributed_at DESC, d.drawing_no
      LIMIT 5000`,
    params,
  )
}

export function importOptions() {
  return Promise.all([
    many<{ id: number; name: string }>(
      'SELECT id, name FROM vendors WHERE NOT is_hidden ORDER BY name', [], 'import_vendor_options',
    ),
    many<{ id: number; name: string }>(
      'SELECT id, name FROM projects WHERE NOT is_hidden ORDER BY name', [], 'import_project_options',
    ),
  ])
}

// ── 확인 필요 ───────────────────────────────────────────────────────────

/** import_issues.files 한 칸 */
export interface IssueFile {
  sha256: string
  filename: string
  ext: string
  byteSize: number | null
  folder: string | null
}

export interface IssueRow {
  id: number
  filename: string
  originalFilename: string | null
  byteSize: number | null
  reason: string
  reasonDetail: string | null
  reasons: string[]
  detail: { text?: string; actualStems?: string[] } | null
  files: IssueFile[]
  vendorName: string | null
  projectId: number | null
  projectName: string | null
  suggestedDocumentId: number | null
  suggestedDrawingNo: string | null
  suggestedCurrentRev: number | null
  folderNames: string[] | null
  currentPdfFileId: number | null
  /** 그 사이 대상 자료가 정상 반입됐는가 — 화면에서 '기 반입 완료'로 바꿔 보여 준다 */
  reimportedAfter: boolean
  createdAt: Date
  createdBy: string | null
}

export function listIssues() {
  return many<IssueRow>(
    `SELECT i.id, i.filename,
            i.original_filename AS "originalFilename",
            i.byte_size         AS "byteSize",
            i.reason, i.reason_detail AS "reasonDetail",
            i.reasons, i.detail, i.files,
            coalesce(i.vendor_name, v.name) AS "vendorName",
            i.project_id        AS "projectId",
            p.name              AS "projectName",
            i.suggested_document_id AS "suggestedDocumentId",
            d.drawing_no        AS "suggestedDrawingNo",
            d.current_rev       AS "suggestedCurrentRev",
            (SELECT array_agg(a.name ORDER BY a.depth) FROM folders a
               JOIN folders f ON f.id = d.folder_id WHERE a.path @> f.path) AS "folderNames",
            (SELECT cf.id FROM files cf
              WHERE cf.document_id = d.id AND cf.is_current AND cf.file_ext = 'pdf' LIMIT 1) AS "currentPdfFileId",
            (d.id IS NOT NULL AND EXISTS (
               SELECT 1 FROM files rf
                WHERE rf.document_id = d.id AND rf.uploaded_at >= i.created_at
                  AND rf.review_status IN ('PENDING','APPROVED','MERGED'))) AS "reimportedAfter",
            i.created_at        AS "createdAt",
            u.name              AS "createdBy"
       FROM import_issues i
  LEFT JOIN vendors v   ON v.id = i.vendor_id
  LEFT JOIN projects p  ON p.id = i.project_id
  LEFT JOIN documents d ON d.id = i.suggested_document_id
  LEFT JOIN users u     ON u.id = i.created_by
      WHERE i.state = 'OPEN'
      ORDER BY i.created_at DESC, i.id DESC`,
    [],
    'import_issues_open_v2',
  )
}

export interface IssueRecord {
  id: number
  filename: string
  state: string
  files: IssueFile[]
  reasons: string[]
  vendor_id: number | null
  vendor_name: string | null
  project_id: number | null
  suggested_document_id: number | null
  zip_path: string | null
}

/** 처리할 항목을 잠그고 읽는다 — 두 사람이 같은 항목을 동시에 처리하지 않게 */
export async function lockIssue(c: pg.PoolClient, id: number): Promise<IssueRecord | undefined> {
  const r = await c.query<IssueRecord>(
    `SELECT i.id, i.filename, i.state, i.files, i.reasons, i.vendor_id,
            coalesce(i.vendor_name, v.name) AS vendor_name,
            i.project_id, i.suggested_document_id, i.zip_path
       FROM import_issues i LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE i.id = $1 FOR UPDATE OF i`,
    [id],
  )
  return r.rows[0]
}

export function findIssueFiles(id: number) {
  return one<{ id: number; files: IssueFile[]; displayName: string }>(
    `SELECT i.id, i.files, coalesce(d.drawing_no, i.filename) AS "displayName"
       FROM import_issues i LEFT JOIN documents d ON d.id = i.suggested_document_id
      WHERE i.id = $1`,
    [id],
  )
}

/** 확인 필요 한 건을 만든다. 파일은 항목이 닫힐 때까지 GC 되지 않게 참조를 올린다. */
export async function insertIssue(
  c: pg.PoolClient,
  v: {
    files: IssueFile[]; reasons: string[]; detail: unknown; detailText: string
    intendedDocumentId: number | null; vendorId: number | null; vendorName: string | null
    projectId: number | null; zipPath: string | null; jobId: number | null; userId: number
  },
): Promise<number> {
  const first = v.files[0]!
  const r = await c.query<{ id: number }>(
    `INSERT INTO import_issues (blob_sha256, filename, original_filename, byte_size, reason, reason_detail,
                                reasons, detail, files, suggested_document_id, vendor_id, vendor_name,
                                project_id, zip_path, job_id, created_by)
     VALUES (decode($1,'hex'), $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [first.sha256, first.filename, first.byteSize, v.reasons.join(','), v.detailText,
     v.reasons, JSON.stringify(v.detail), JSON.stringify(v.files), v.intendedDocumentId,
     v.vendorId, v.vendorName, v.projectId, v.zipPath, v.jobId, v.userId],
  )
  await addFileRefs(c, v.files, 1)
  return r.rows[0]!.id
}

export async function addFileRefs(c: pg.PoolClient, files: IssueFile[], delta: number) {
  if (!files.length) return
  await c.query(
    `UPDATE blobs SET refcount = GREATEST(0, refcount + $2)
      WHERE sha256 = ANY(SELECT decode(h, 'hex') FROM unnest($1::text[]) h)`,
    [files.map((f) => f.sha256), delta],
  )
}

export function closeIssue(
  c: pg.PoolClient, id: number, state: 'RESOLVED' | 'DISCARDED' | 'SUPERSEDED', userId: number,
  extra: { documentId?: number | null; note?: string | null; supersededBy?: number | null } = {},
) {
  return c.query(
    `UPDATE import_issues
        SET state = $2, resolved_at = now(), resolved_by = $3,
            document_id = coalesce($4, document_id), resolve_note = $5, superseded_by = $6
      WHERE id = $1`,
    [id, state, userId, extra.documentId ?? null, extra.note ?? null, extra.supersededBy ?? null],
  )
}

/** 경로 재선택 — 대상 자료와 [사유상세] 문장만 바꾼다 */
export function retargetIssue(c: pg.PoolClient, id: number, documentId: number, text: string) {
  return c.query(
    `UPDATE import_issues
        SET suggested_document_id = $2, reason_detail = $3,
            detail = jsonb_set(coalesce(detail, '{}'::jsonb), '{text}', to_jsonb($3::text))
      WHERE id = $1`,
    [id, documentId, text],
  )
}

/** 자료 재첨부 — 파일만 갈아끼운다 */
export function replaceIssueFiles(c: pg.PoolClient, id: number, files: IssueFile[]) {
  const first = files[0]!
  return c.query(
    `UPDATE import_issues
        SET files = $2, blob_sha256 = decode($3,'hex'), filename = $4, original_filename = $4, byte_size = $5
      WHERE id = $1`,
    [id, JSON.stringify(files), first.sha256, first.filename, first.byteSize],
  )
}

export function setIssueSuggestion(c: pg.PoolClient, id: number, documentId: number | null) {
  return c.query('UPDATE import_issues SET suggested_document_id = $2 WHERE id = $1', [id, documentId])
}

/** 재검수의 대상 자료 */
export async function documentForDiagnosis(c: pg.PoolClient, documentId: number) {
  const r = await c.query<{ id: number; drawing_no: string; current_rev: number; folder_names: string[] }>(
    `SELECT d.id, d.drawing_no, d.current_rev,
            (SELECT array_agg(a.name ORDER BY a.depth) FROM folders a WHERE a.path @> f.path) AS folder_names
       FROM documents d JOIN folders f ON f.id = d.folder_id
      WHERE d.id = $1`,
    [documentId],
  )
  return r.rows[0]
}

/** 그 자료의 수정용 반출 건 하나 — 이 항목의 업체 것을 먼저, 미반납을 먼저 */
export async function modifyDistributionFor(c: pg.PoolClient, documentId: number, vendorName: string | null) {
  const r = await c.query<{
    id: number; vendor_id: number | null; vendor_name: string; project_id: number | null
    rev_at_distribution: number; returned: boolean; keep_paths: boolean; exts: string[]
  }>(
    `SELECT x.id, x.vendor_id, x.vendor_name, x.project_id, x.rev_at_distribution,
            (x.returned_at IS NOT NULL) AS returned, x.keep_paths,
            coalesce((SELECT array_agg(DISTINCT lower(fl.file_ext)) FROM files fl
                       WHERE fl.document_id = x.document_id AND fl.rev = x.rev_at_distribution
                         AND fl.review_status IN ('APPROVED','MERGED')), '{}') AS exts
       FROM distributions x
      WHERE x.document_id = $1 AND x.purpose = 'MODIFY'
      ORDER BY ($2::text IS NOT NULL AND x.vendor_name = $2) DESC,
               (x.returned_at IS NOT NULL), x.distributed_at
      LIMIT 1`,
    [documentId, vendorName],
  )
  return r.rows[0]
}

/**
 * [경로 재선택]을 안 거쳐도, 파일 이름이 '이 업체·공사로 나가서 아직 안 돌아온' 자료 이름과
 * 정확히 하나로만 맞으면 그 자료로 본다(2026-08-18 CM). 둘 이상이면 고르지 않는다.
 */
export async function findOutstandingByName(
  c: pg.PoolClient, stem: string, vendorName: string | null, projectId: number | null,
) {
  const r = await c.query<{ id: number }>(
    `SELECT DISTINCT d.id
       FROM documents d JOIN distributions x ON x.document_id = d.id
      WHERE x.purpose = 'MODIFY' AND x.returned_at IS NULL
        AND lower(d.drawing_no) = lower($1)
        AND ($2::text IS NULL OR x.vendor_name = $2)
        AND ($3::bigint IS NULL OR x.project_id = $3)
      LIMIT 2`,
    [stem, vendorName, projectId],
  )
  return r.rows.length === 1 ? r.rows[0]!.id : null
}

// ── 신규 자료 등록 ──────────────────────────────────────────────────────

export async function folderForNew(c: pg.PoolClient, folderId: number) {
  const r = await c.query<{ id: number; doc_class: string; is_archived: boolean }>(
    'SELECT id, doc_class, is_archived FROM folders WHERE id = $1',
    [folderId],
  )
  return r.rows[0]
}

export async function sameNameInFolder(c: pg.PoolClient, folderId: number, drawingNo: string) {
  const r = await c.query<{ id: number }>(
    `SELECT id FROM documents
      WHERE folder_id = $1 AND lower(drawing_no) = lower($2) AND NOT is_archived AND status <> 'RETIRED'
      LIMIT 1`,
    [folderId, drawingNo],
  )
  return r.rows[0]?.id ?? null
}

export async function insertDocument(
  c: pg.PoolClient,
  v: {
    folderId: number; drawingNo: string; title: string; category: string | null
    discipline: string | null; docType: string | null; isblOsbl: string | null
    elevation: string | null; area: string | null; projectId: number | null; isIsometric: boolean
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO documents (folder_id, drawing_no, title, category, discipline, doc_type, isbl_osbl,
                            elevation, area, project_id, is_isometric, current_rev, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,'ACTIVE')
     RETURNING id`,
    [v.folderId, v.drawingNo, v.title, v.category, v.discipline, v.docType, v.isblOsbl,
     v.elevation, v.area, v.projectId, v.isIsometric],
  )
  return r.rows[0]!.id
}

/** 신규 등록 파일 — CM 이 직접 올리는 것이라 바로 승인·현재본이다 */
export async function insertApprovedFile(
  c: pg.PoolClient,
  v: {
    documentId: number; revisionSetId: number; sha256: Buffer; fileExt: string
    displayName: string; originalFilename: string; vendorName: string | null
    projectId: number | null; userId: number
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO files (document_id, revision_set_id, blob_sha256, rev, branch, file_ext,
                        display_name, original_filename, review_status, is_current,
                        vendor_name, project_id, uploaded_by)
     VALUES ($1,$2,$3,0,NULL,$4,$5,$6,'APPROVED',true,$7,$8,$9)
     RETURNING id`,
    [v.documentId, v.revisionSetId, v.sha256, v.fileExt, v.displayName, v.originalFilename,
     v.vendorName, v.projectId, v.userId],
  )
  await c.query('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = $1', [v.sha256])
  return r.rows[0]!.id
}

export function refreshDocumentFlags(c: pg.PoolClient, documentId: number) {
  return c.query(
    `UPDATE documents d
        SET has_pdf  = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext = 'pdf'),
            has_dwg  = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext = 'dwg'),
            has_xlsx = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext IN ('xlsx','xls')),
            has_etc  = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current
                                 AND file_ext NOT IN ('pdf','dwg','xlsx','xls')),
            updated_at = now()
      WHERE d.id = $1`,
    [documentId],
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
