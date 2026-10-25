import { many, one } from '../../core/db.js'
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
