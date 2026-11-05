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

/**
 * 정렬 키 → SQL 식.
 *
 * **여기 적힌 것만 쓴다** — 요청 문자열을 ORDER BY 에 바로 끼우면 SQL 주입이 된다.
 * keyset 페이징이므로 정렬 칸은 커서 비교에도 그대로 쓰인다.
 */
const SORT_SQL: Record<string, string> = {
  updatedAt:  'd.updated_at',
  drawingNo:  'd.drawing_no',
  title:      'd.title',
  currentRev: 'd.current_rev',
  docType:    'd.doc_type',
}

const HOLD_SQL: Record<string, string> = {
  all: 'TRUE',
  both: 'd.has_dwg AND d.has_pdf',
  dwg_only: 'd.has_dwg AND NOT d.has_pdf',
  pdf_only: 'd.has_pdf AND NOT d.has_dwg',
}

/** 목록·넘겨보기·건수가 함께 쓰는 거르개 — 셋이 어긋나면 "n / 전체" 가 목록과 다르다 */
export type ListFilter = Pick<
  DocumentListQuery,
  'status' | 'hold' | 'includeIsometric' | 'q' | 'searchTarget' | 'projectId' | 'rev' | 'docType'
>

/** WHERE 조각들. params[0] 은 언제나 폴더 id 목록이다. */
function buildListWhere(qp: ListFilter, params: unknown[]): string[] {
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
  return where
}

/** 목록 한 줄의 선택부 — 목록과 폴더 반출이 같은 모양을 내려준다 */
const LIST_SELECT = `
  SELECT d.id,
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
    ) lent ON true`

/** 정렬 칸·방향 → ORDER BY. 커서·넘겨보기도 같은 순서를 쓴다. */
function orderOf(qp: Pick<DocumentListQuery, 'sort' | 'dir'>) {
  const sortCol = SORT_SQL[qp.sort] ?? SORT_SQL.updatedAt!
  const desc = qp.dir === 'desc'
  // 정렬 칸이 비어 있는 줄이 섞여도 순서가 흔들리지 않게 NULL 자리를 고정한다
  const nulls = desc ? 'NULLS LAST' : 'NULLS FIRST'
  return {
    sortCol,
    desc,
    sql: `${sortCol} ${desc ? 'DESC' : 'ASC'} ${nulls}, d.id ${desc ? 'DESC' : 'ASC'}`,
  }
}

export async function listDocuments(
  folderIds: number[],
  qp: DocumentListQuery,
): Promise<DocumentListRow[]> {
  const cur = decodeCursor(qp.cursor)
  const params: unknown[] = [folderIds]
  const where = buildListWhere(qp, params)

  // 정렬 칸과 방향. 커서 비교도 같은 칸으로 한다 — 그래야 다음 쪽이 이어진다.
  const order = orderOf(qp)
  const cmp = order.desc ? '<' : '>'

  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(
      `(${order.sortCol}, d.id) ${cmp} ($${params.length - 1}::text::${sortCastOf(qp.sort)}, $${params.length}::bigint)`,
    )
  }
  params.push(qp.limit + 1)

  return many<DocumentListRow>(
    `${LIST_SELECT}
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${order.sql}
      LIMIT $${params.length}`,
    params,
  )
}

/** 커서에 담긴 값(문자열)을 정렬 칸의 타입으로 되돌린다 */
function sortCastOf(sort: string): string {
  return sort === 'updatedAt' ? 'timestamptz' : sort === 'currentRev' ? 'int' : 'text'
}

/** 커서에 담을 값 — 정렬 칸의 값이어야 다음 쪽이 이어진다 */
export function sortValueOf(row: DocumentListRow, sort: string): string {
  switch (sort) {
    case 'drawingNo':  return row.drawingNo
    case 'title':      return row.title
    case 'currentRev': return String(row.currentRev)
    case 'docType':    return row.docType ?? ''
    default:           return row.updatedAt.toISOString()
  }
}

/** 총 건수는 비싸다 — 첫 페이지에서만 센다. */
export async function countDocuments(folderIds: number[], qp: ListFilter): Promise<number> {
  const params: unknown[] = [folderIds]
  const where = buildListWhere(qp, params)
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

/**
 * 처음·이전·다음·끝과 "n / 전체" — 목록과 같은 거르개·같은 정렬로 번호를 매긴다.
 *
 * 기존 detail.js 는 목록 전체 id 를 브라우저에 쥐고 다녔다. 여기서는 번호만 묻는다 —
 * 폴더 전체(수만 건)여도 응답은 숫자 몇 개다.
 * 기준은 id(지금 자료) 또는 at(번호 칸에 넣은 자리) 중 하나다.
 */
export function navigate(
  folderIds: number[],
  qp: ListFilter & Pick<DocumentListQuery, 'sort' | 'dir'>,
  by: { id?: number; at?: number },
) {
  const params: unknown[] = [folderIds]
  const where = buildListWhere(qp, params)
  let curCond = 'FALSE'
  if (by.at !== undefined) {
    params.push(by.at)
    curCond = `s.rn = LEAST($${params.length}::int, (SELECT total FROM n))`
  } else if (by.id !== undefined) {
    params.push(by.id)
    curCond = `s.id = $${params.length}::bigint`
  }

  return one<{
    currentId: number | null; position: number | null; total: number
    firstId: number | null; prevId: number | null; nextId: number | null; lastId: number | null
  }>(
    `WITH s AS (
       SELECT d.id, row_number() OVER (ORDER BY ${orderOf(qp).sql})::int AS rn
         FROM documents d JOIN folders f ON f.id = d.folder_id
        WHERE ${where.join(' AND ')}
     ),
     n   AS (SELECT count(*)::int AS total FROM s),
     cur AS (SELECT s.id, s.rn FROM s WHERE ${curCond} LIMIT 1)
     SELECT (SELECT id FROM cur)                                AS "currentId",
            (SELECT rn FROM cur)                                AS position,
            (SELECT total FROM n)                               AS total,
            (SELECT s.id FROM s WHERE s.rn = 1)                 AS "firstId",
            (SELECT s.id FROM s, cur WHERE s.rn = cur.rn - 1)   AS "prevId",
            (SELECT s.id FROM s, cur WHERE s.rn = cur.rn + 1)   AS "nextId",
            (SELECT s.id FROM s, n WHERE s.rn = n.total)        AS "lastId"`,
    params,
  )
}

/** 반출 한 번에 담을 수 있는 자료 수 — CreateDistributionRequest.documentIds 의 상한과 같다 */
export const FOLDER_CART_MAX = 5000

/** 폴더 반출 — 그 폴더(하위 포함 여부는 recursive)의 자료 전부. 상한에서 하나 더 읽어 넘침을 안다. */
export function listFolderDocuments(folderIds: number[], includeIsometric: boolean) {
  const params: unknown[] = [folderIds]
  const where = buildListWhere(
    { status: 'all', hold: 'all', includeIsometric, searchTarget: 'title' },
    params,
  )
  return many<DocumentListRow>(
    `${LIST_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY f.name, d.drawing_no, d.id
      LIMIT ${FOLDER_CART_MAX + 1}`,
    params,
  )
}

// ── TDB 수정 (최근수정본) ───────────────────────────────────────────────

/**
 * "수정된 자료" 로 볼 것인가 — 기존 is_modified_condition 을 옮긴 것.
 *
 *   ① 등록된 뒤로 실제로 무언가 바뀐 것 (updated_at > created_at)
 *   ② 초기 일괄적재 **이후**에 새로 등록된 것 — 등록 자체를 수정으로 본다
 *
 * 기존은 ② 의 기준일을 날짜로 박아 두었다(2026-08-14). 이 시스템은 이관 적재일이
 * 따로 있으므로 "가장 먼저 등록된 날의 다음 날" 을 기준으로 삼는다 — 그래야 이관된
 * 수만 건이 통째로 "최근 수정" 으로 물들지 않고, 이관을 다시 돌려도 저절로 맞는다.
 */
const MODIFIED_SQL = `
  (d.updated_at > d.created_at
   OR d.created_at >= (SELECT min(created_at) + interval '1 day' FROM documents))`

const RECENT_WHERE = `
  NOT d.is_archived AND d.status <> 'RETIRED'
  AND ${MODIFIED_SQL}
  AND d.updated_at >= now() - make_interval(days => $1::int)`

export interface RecentChangeRow {
  id: number
  drawingNo: string
  title: string
  category: string | null
  path: string | null
  updatedAt: Date
  currentRev: number
  revTo: number | null
  vendorName: string | null
  projectName: string | null
  changedBy: string | null
}

/**
 * 기간 안에 승인된 리비전(rev 1 이상)이 있으면 "내용이 바뀐 것"(Rev a → b),
 * 없으면 "일반 수정". 누가 바꿨는지는 그 리비전을 올린 사람이다 —
 * 기존은 감사 로그에서 찾았는데 이 시스템의 감사 로그는 자료 id 를 따로 두지 않는다.
 */
export function listRecentChanges(days: number) {
  return many<RecentChangeRow>(
    `WITH docs AS (
       SELECT d.id, d.drawing_no, d.title, d.category, d.folder_id, d.updated_at, d.current_rev
         FROM documents d
        WHERE ${RECENT_WHERE}
     )
     SELECT docs.id,
            docs.drawing_no  AS "drawingNo",
            docs.title,
            docs.category,
            fp.path,
            docs.updated_at  AS "updatedAt",
            docs.current_rev AS "currentRev",
            rf.rev           AS "revTo",
            rf.vendor_name   AS "vendorName",
            p.name           AS "projectName",
            u.name           AS "changedBy"
       FROM docs
       JOIN folders fo ON fo.id = docs.folder_id
  LEFT JOIN LATERAL (
            SELECT string_agg(a.name, ' / ' ORDER BY a.depth) AS path
              FROM folders a WHERE a.path @> fo.path) fp ON true
  LEFT JOIN LATERAL (
            SELECT fl.rev, coalesce(fl.vendor_name, v.name) AS vendor_name,
                   fl.project_id, fl.uploaded_by
              FROM files fl LEFT JOIN vendors v ON v.id = fl.vendor_id
             WHERE fl.document_id = docs.id
               AND fl.rev >= 1 AND fl.review_status = 'APPROVED'
               AND fl.uploaded_at >= now() - make_interval(days => $1::int)
             ORDER BY fl.rev DESC, fl.id DESC
             LIMIT 1) rf ON true
  LEFT JOIN projects p ON p.id = rf.project_id
  LEFT JOIN users    u ON u.id = rf.uploaded_by
      ORDER BY docs.updated_at DESC, docs.id`,
    [days],
    'document_recent_changes',
  )
}

/** 상단 [TDB 수정] 단추의 건수 — 권한과 무관하게 누구나 같은 숫자를 본다 (기존 CM 확정) */
export async function countRecentChanges(days: number): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents d WHERE ${RECENT_WHERE}`,
    [days],
    'document_recent_count',
  )
  return row?.n ?? 0
}
