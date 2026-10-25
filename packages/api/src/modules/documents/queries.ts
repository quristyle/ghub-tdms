import { many, one, query } from '../../core/db.js'
import type { DocumentListQuery } from '@tdms/contracts'
import { decodeCursor } from '../../core/cursor.js'

/**
 * TDB 목록 — 이 시스템에서 가장 많이 돌고 가장 중요한 쿼리.
 *
 * 성능 설계
 *   · keyset 페이징    OFFSET 금지. 1페이지든 100페이지든 같은 속도
 *   · partial index    ix_documents_browse (ACTIVE · 보관 아님 · Isometric 아님)
 *   · trgm GIN         search_text 생성 컬럼에 대한 ILIKE '%..%'
 *   · LATERAL          '대여중' 표시를 N+1 없이 한 번에
 *   · folder_id = ANY  ltree 조건을 큰 테이블 조인에 직접 걸지 않는다
 */

export interface DocumentListRow {
  id: number
  drawingNo: string
  title: string
  folderId: number
  folderName: string
  docType: string | null
  currentRev: number
  status: string
  isIsometric: boolean
  hasDwg: boolean
  hasPdf: boolean
  hasXlsx: boolean
  hasEtc: boolean
  updatedAt: Date
  lentTo: string | null
  lentAt: Date | null
}

const STATUS_SQL: Record<string, string> = {
  all: `d.status <> 'RETIRED' AND NOT d.is_archived`,
  normal: `d.status = 'ACTIVE' AND NOT d.is_archived`,
  review: `d.status = 'PENDING'`,
  distributed: `EXISTS (SELECT 1 FROM distributions x
                         WHERE x.document_id = d.id AND x.returned_at IS NULL)`,
  archived: `d.is_archived`,
}

const HOLD_SQL: Record<string, string> = {
  all: 'TRUE',
  both: 'd.has_dwg AND d.has_pdf',
  dwg_only: 'd.has_dwg AND NOT d.has_pdf',
  pdf_only: 'd.has_pdf AND NOT d.has_dwg',
}

export async function listDocuments(
  folderIds: number[],
  qp: DocumentListQuery,
): Promise<DocumentListRow[]> {
  const cur = decodeCursor(qp.cursor)
  const params: unknown[] = [folderIds, qp.limit + 1]
  const where: string[] = ['d.folder_id = ANY($1::bigint[])']

  where.push(STATUS_SQL[qp.status] ?? STATUS_SQL.all!)
  where.push(HOLD_SQL[qp.hold] ?? 'TRUE')

  if (!qp.includeIsometric) where.push('NOT d.is_isometric')

  if (qp.q) {
    if (qp.searchTarget === 'folder') {
      params.push(`%${qp.q}%`)
      where.push(`f.name ILIKE $${params.length}`)
    } else {
      params.push(`%${qp.q}%`)
      where.push(`d.search_text ILIKE $${params.length}`)
    }
  }
  if (qp.projectId !== undefined) {
    params.push(qp.projectId)
    where.push(`d.project_id = $${params.length}`)
  }
  if (qp.rev !== undefined) {
    params.push(qp.rev)
    where.push(`d.current_rev = $${params.length}`)
  }
  if (qp.docType) {
    params.push(qp.docType)
    where.push(`d.doc_type = $${params.length}`)
  }
  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(`(d.updated_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`)
  }

  return many<DocumentListRow>(
    `SELECT d.id,
            d.drawing_no   AS "drawingNo",
            d.title,
            d.folder_id    AS "folderId",
            f.name         AS "folderName",
            d.doc_type     AS "docType",
            d.current_rev  AS "currentRev",
            d.status,
            d.is_isometric AS "isIsometric",
            d.has_dwg      AS "hasDwg",
            d.has_pdf      AS "hasPdf",
            d.has_xlsx     AS "hasXlsx",
            d.has_etc      AS "hasEtc",
            d.updated_at   AS "updatedAt",
            lent.vendor_name    AS "lentTo",
            lent.distributed_at AS "lentAt"
       FROM documents d
       JOIN folders f ON f.id = d.folder_id
  LEFT JOIN LATERAL (
            SELECT vendor_name, distributed_at
              FROM distributions
             WHERE document_id = d.id AND returned_at IS NULL
             ORDER BY distributed_at DESC
             LIMIT 1
       ) lent ON true
      WHERE ${where.join('\n        AND ')}
      ORDER BY d.updated_at DESC, d.id DESC
      LIMIT $2`,
    params,
  )
}

/** 총 건수는 비싸다 — 첫 페이지에서만 센다. */
export async function countDocuments(folderIds: number[], qp: DocumentListQuery): Promise<number> {
  const params: unknown[] = [folderIds]
  const where: string[] = ['d.folder_id = ANY($1::bigint[])']
  where.push(STATUS_SQL[qp.status] ?? STATUS_SQL.all!)
  where.push(HOLD_SQL[qp.hold] ?? 'TRUE')
  if (!qp.includeIsometric) where.push('NOT d.is_isometric')
  if (qp.q) {
    params.push(`%${qp.q}%`)
    where.push(qp.searchTarget === 'folder'
      ? `f.name ILIKE $${params.length}`
      : `d.search_text ILIKE $${params.length}`)
  }
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM documents d JOIN folders f ON f.id = d.folder_id
      WHERE ${where.join(' AND ')}`,
    params,
  )
  return row?.n ?? 0
}

export interface DocumentDetailRow extends DocumentListRow {
  category: string | null
  discipline: string | null
  isblOsbl: string | null
  elevation: string | null
  area: string | null
  equipmentTag: string | null
  projectName: string | null
  note: string | null
}

export function findDocument(id: number) {
  return one<DocumentDetailRow>(
    `SELECT d.id, d.drawing_no AS "drawingNo", d.title,
            d.folder_id AS "folderId", f.name AS "folderName",
            d.doc_type AS "docType", d.current_rev AS "currentRev", d.status,
            d.is_isometric AS "isIsometric",
            d.has_dwg AS "hasDwg", d.has_pdf AS "hasPdf",
            d.has_xlsx AS "hasXlsx", d.has_etc AS "hasEtc",
            d.updated_at AS "updatedAt",
            d.category, d.discipline, d.isbl_osbl AS "isblOsbl",
            d.elevation, d.area, d.equipment_tag AS "equipmentTag",
            p.name AS "projectName", d.note,
            lent.vendor_name AS "lentTo", lent.distributed_at AS "lentAt"
       FROM documents d
       JOIN folders f  ON f.id = d.folder_id
  LEFT JOIN projects p ON p.id = d.project_id
  LEFT JOIN LATERAL (
            SELECT vendor_name, distributed_at FROM distributions
             WHERE document_id = d.id AND returned_at IS NULL
             ORDER BY distributed_at DESC LIMIT 1) lent ON true
      WHERE d.id = $1`,
    [id],
    'document_detail',
  )
}

export interface DocumentFileRow {
  id: number
  rev: number
  branch: string | null
  fileExt: string
  displayName: string
  byteSize: number
  reviewStatus: string
  isCurrent: boolean
  uploadedAt: Date
  uploadedBy: string | null
  note: string | null
}

export function listDocumentFiles(documentId: number) {
  return many<DocumentFileRow>(
    `SELECT fl.id, fl.rev, fl.branch,
            fl.file_ext     AS "fileExt",
            fl.display_name AS "displayName",
            b.byte_size     AS "byteSize",
            fl.review_status AS "reviewStatus",
            fl.is_current   AS "isCurrent",
            fl.uploaded_at  AS "uploadedAt",
            u.name          AS "uploadedBy",
            fl.note
       FROM files fl
       JOIN blobs b ON b.sha256 = fl.blob_sha256
  LEFT JOIN users u ON u.id = fl.uploaded_by
      WHERE fl.document_id = $1
      ORDER BY fl.rev DESC, fl.branch NULLS FIRST, fl.file_ext`,
    [documentId],
    'document_files',
  )
}

// ── Revision 이력 / 반출 이력 (상세 화면 탭) ─────────────────────────────

export interface RevisionRow {
  rev: number
  branch: string | null
  reason: string | null
  note: string | null
  createdAt: Date
  createdBy: string | null
  isCurrent: boolean
}

export function listRevisions(documentId: number) {
  return many<RevisionRow>(
    `SELECT rs.rev, rs.branch, rs.reason, rs.note,
            rs.created_at AS "createdAt",
            u.name        AS "createdBy",
            EXISTS (SELECT 1 FROM files f
                     WHERE f.revision_set_id = rs.id AND f.is_current) AS "isCurrent"
       FROM revision_sets rs
  LEFT JOIN users u ON u.id = rs.created_by
      WHERE rs.document_id = $1
      ORDER BY rs.rev DESC, rs.branch NULLS FIRST`,
    [documentId],
    'document_revisions',
  )
}

export interface RevisionFileRow {
  id: number
  rev: number
  branch: string | null
  fileExt: string
  displayName: string
  byteSize: number
  reviewStatus: string
  uploadedAt: Date
}

export function listFilesByRevision(documentId: number) {
  return many<RevisionFileRow>(
    `SELECT fl.id, fl.rev, fl.branch,
            fl.file_ext      AS "fileExt",
            fl.display_name  AS "displayName",
            b.byte_size      AS "byteSize",
            fl.review_status AS "reviewStatus",
            fl.uploaded_at   AS "uploadedAt"
       FROM files fl
       JOIN blobs b ON b.sha256 = fl.blob_sha256
      WHERE fl.document_id = $1
      ORDER BY fl.rev DESC, fl.branch NULLS FIRST, fl.file_ext`,
    [documentId],
    'document_rev_files',
  )
}

export interface DistributionRow {
  id: number
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

export function listDistributions(documentId: number) {
  return many<DistributionRow>(
    `SELECT x.id,
            x.rev_at_distribution AS "revAtDistribution",
            x.vendor_name         AS "vendorName",
            p.name                AS "projectName",
            x.purpose, x.purpose_note AS "purposeNote",
            x.zip_name            AS "zipName",
            u.name                AS "distributedBy",
            x.distributed_at      AS "distributedAt",
            x.returned_at         AS "returnedAt",
            x.return_note         AS "returnNote",
            x.manual_return       AS "manualReturn",
            x.note,
            rf.review_status      AS "returnedFileReview"
       FROM distributions x
  LEFT JOIN projects p ON p.id = x.project_id
  LEFT JOIN users u    ON u.id = x.distributed_by
  LEFT JOIN files rf   ON rf.id = x.returned_file_id
      WHERE x.document_id = $1
      ORDER BY x.distributed_at DESC`,
    [documentId],
    'document_distributions',
  )
}

/** 비고 작성 — 권한은 라우트가 막는다 */
export function updateRevisionNote(documentId: number, rev: number, branch: string | null, note: string | null) {
  return query(
    `UPDATE revision_sets SET note = $4
      WHERE document_id = $1 AND rev = $2 AND branch IS NOT DISTINCT FROM $3`,
    [documentId, rev, branch, note],
  )
}

export function updateDistributionNote(distributionId: number, note: string | null) {
  return query('UPDATE distributions SET note = $2 WHERE id = $1', [distributionId, note])
}

/** 상세 화면의 이전·다음 이동 (목록 정렬과 같은 기준) */
export function neighborIds(documentId: number) {
  return one<{ prevId: number | null; nextId: number | null }>(
    `WITH cur AS (SELECT updated_at, id, folder_id FROM documents WHERE id = $1)
     SELECT (SELECT d.id FROM documents d, cur
              WHERE d.folder_id = cur.folder_id
                AND (d.updated_at, d.id) > (cur.updated_at, cur.id)
              ORDER BY d.updated_at, d.id LIMIT 1) AS "prevId",
            (SELECT d.id FROM documents d, cur
              WHERE d.folder_id = cur.folder_id
                AND (d.updated_at, d.id) < (cur.updated_at, cur.id)
              ORDER BY d.updated_at DESC, d.id DESC LIMIT 1) AS "nextId"`,
    [documentId],
    'document_neighbors',
  )
}
