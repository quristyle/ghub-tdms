import type pg from 'pg'
import type { MdbListQuery, MdbUnclassifiedQuery } from '@tdms/contracts'
import { many, one } from '../../core/db.js'
import { decodeCursor } from '../../core/cursor.js'

/** MDB 쿼리. TDB 와 표를 공유하지 않는다 — 리비전·반출·검수가 없어 훨씬 단순하다. */

export interface MdbRow {
  id: number
  title: string
  displayName: string
  folderId: number
  folderName: string
  fileExt: string
  byteSize: number
  equipmentType: string | null
  docType: string | null
  projectName: string | null
  year: number | null
  isShared: boolean
  needsCheck: boolean
  tagCount: number
  /** 이 자료에 속한 파일 전부 (대표 파일 포함) */
  files: { id: number; fileExt: string }[] | null
  hasDwg: boolean
  hasXlsx: boolean
  hasEtc: boolean
  hasPdf: boolean
  updatedAt: Date
}

/**
 * 자료 한 건이 가진 파일 종류 — 기존 화면의 DWG·XLSX·ETC·PDF 칸과 원본/사본 조건.
 *
 * MDB 의 '자료 1건' 은 **같은 폴더 + 같은 자료명(title)** 이다. 한 자료가 원본과 사본
 * 두 파일로 나뉘어 있어도 보유 표시는 자료 단위라야 한다 — 그래서 형제 행까지 본다.
 * (원본 = PDF 가 아닌 파일, 사본 = PDF. TDB 조회의 같은 이름 조건과 뜻이 같다.)
 */
function siblingHas(cond: string): string {
  return `EXISTS (SELECT 1 FROM mdb_files s
                   WHERE s.folder_id = m.folder_id AND s.title = m.title
                     AND NOT s.is_archived AND ${cond})`
}
const HAS_DWG  = siblingHas(`lower(s.file_ext) IN ('dwg', 'dxf')`)
const HAS_XLSX = siblingHas(`lower(s.file_ext) IN ('xlsx', 'xls')`)
const HAS_PDF  = siblingHas(`lower(s.file_ext) = 'pdf'`)
const HAS_ETC  = siblingHas(`lower(s.file_ext) NOT IN ('dwg', 'dxf', 'xlsx', 'xls', 'pdf')`)
/** 원본 = PDF 가 아닌 파일 아무거나 */
const HAS_ORIGINAL = siblingHas(`lower(s.file_ext) <> 'pdf'`)

/**
 * 자료 한 건을 대표하는 파일만 남기는 조건.
 *
 * MDB 의 '자료 1건' 은 같은 폴더 + 같은 자료명이고, 원본과 사본이 각각 한 행이다.
 * 목록은 **자료 단위**로 보여야 하므로(기존 화면도 그랬다) 묶음마다 한 줄만 남긴다.
 *
 * GROUP BY 로 묶지 않고 대표 행을 고르는 이유: 정렬·커서 페이징·건수 세기가 모두
 * 행 단위 그대로 유지되기 때문이다. 묶으면 정렬 칸이 전부 집계식이 되고
 * 커서 비교를 HAVING 으로 옮겨야 해서 깨지기 쉬운 곳이 늘어난다.
 */
const REP_ONLY = `
  m.id = (SELECT min(s.id) FROM mdb_files s
           WHERE s.folder_id = m.folder_id AND s.title = m.title AND NOT s.is_archived)`

/**
 * 같은 자료에 속한 파일 전부 — 담기·옮기기·보관은 자료 통째로 움직여야 한다.
 * 다운대기함은 파일 단위라 확장자도 함께 준다(원본·사본이 따로 담긴다).
 */
const SIBLING_FILES = `
  (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'fileExt', s.file_ext) ORDER BY s.id)
     FROM mdb_files s
    WHERE s.folder_id = m.folder_id AND s.title = m.title AND NOT s.is_archived)`

/** 자료가 차지하는 크기 = 속한 파일 크기의 합 */
const SIBLING_BYTES = `
  (SELECT coalesce(sum(sb.byte_size), 0)::bigint FROM mdb_files s
     JOIN blobs sb ON sb.sha256 = s.blob_sha256
    WHERE s.folder_id = m.folder_id AND s.title = m.title AND NOT s.is_archived)`

/** Tag 는 파일에 붙지만 뜻은 자료의 것이다 — 묶어서 서로 다른 개수를 센다 */
const SIBLING_TAGS = `
  (SELECT count(DISTINCT t.tag_no)::int FROM mdb_files s
     JOIN mdb_file_tags t ON t.mdb_file_id = s.id
    WHERE s.folder_id = m.folder_id AND s.title = m.title AND NOT s.is_archived)`

const HOLD_SQL: Record<string, string> = {
  all: 'TRUE',
  both: `${HAS_ORIGINAL} AND ${HAS_PDF}`,
  dwg_only: `${HAS_ORIGINAL} AND NOT ${HAS_PDF}`,
  pdf_only: `${HAS_PDF} AND NOT ${HAS_ORIGINAL}`,
}

const SELECT_MDB = `
  SELECT m.id, m.title,
         m.display_name   AS "displayName",
         m.folder_id      AS "folderId",
         f.name           AS "folderName",
         m.file_ext       AS "fileExt",
         ${SIBLING_BYTES} AS "byteSize",
         m.equipment_type AS "equipmentType",
         m.doc_type       AS "docType",
         p.name           AS "projectName",
         m.year,
         m.is_shared      AS "isShared",
         m.needs_check    AS "needsCheck",
         ${SIBLING_TAGS}  AS "tagCount",
         ${SIBLING_FILES} AS "files",
         ${HAS_DWG}  AS "hasDwg",
         ${HAS_XLSX} AS "hasXlsx",
         ${HAS_ETC}  AS "hasEtc",
         ${HAS_PDF}  AS "hasPdf",
         m.updated_at     AS "updatedAt"
    FROM mdb_files m
    JOIN folders f  ON f.id = m.folder_id
    JOIN blobs b    ON b.sha256 = m.blob_sha256
    LEFT JOIN projects p ON p.id = m.project_id`

/** 정렬 키 → SQL 식. 여기 적힌 것만 쓴다 (요청 문자열을 ORDER BY 에 끼우지 않는다). */
const SORT_SQL: Record<string, string> = {
  updatedAt:     'm.updated_at',
  title:         'm.title',
  equipmentType: 'm.equipment_type',
  docType:       'm.doc_type',
  year:          'm.year',
}

function sortCastOf(sort: string): string {
  return sort === 'updatedAt' ? 'timestamptz' : sort === 'year' ? 'int' : 'text'
}

/** 커서에 담을 값 — 정렬 칸의 값이어야 다음 쪽이 이어진다 */
export function sortValueOf(row: MdbRow, sort: string): string {
  switch (sort) {
    case 'title':         return row.title
    case 'equipmentType': return row.equipmentType ?? ''
    case 'docType':       return row.docType ?? ''
    case 'year':          return String(row.year ?? 0)
    default:              return row.updatedAt.toISOString()
  }
}

function filters(qp: MdbListQuery, folderIds: number[], params: unknown[]): string[] {
  const where = ['NOT m.is_archived', REP_ONLY]
  params.push(folderIds)
  where.push(`m.folder_id = ANY($${params.length}::bigint[])`)

  if (qp.q) {
    params.push(`%${qp.q}%`)
    const i = params.length
    if (qp.searchTarget === 'folder') where.push(`f.name ILIKE $${i}`)
    else if (qp.searchTarget === 'tag')
      // Tag 는 파일마다 붙어 있다 — 자료 안 어느 파일에 붙어 있어도 그 자료가 걸려야 한다
      where.push(`EXISTS (SELECT 1 FROM mdb_files s JOIN mdb_file_tags t ON t.mdb_file_id = s.id
                           WHERE s.folder_id = m.folder_id AND s.title = m.title
                             AND NOT s.is_archived AND t.tag_no ILIKE $${i})`)
    else where.push(`m.search_text ILIKE $${i}`)
  }
  if (qp.equipmentType) { params.push(qp.equipmentType); where.push(`m.equipment_type = $${params.length}`) }
  if (qp.docType)       { params.push(qp.docType);       where.push(`m.doc_type = $${params.length}`) }
  if (qp.projectId !== undefined) { params.push(qp.projectId); where.push(`m.project_id = $${params.length}`) }
  if (qp.year !== undefined)      { params.push(qp.year);      where.push(`m.year = $${params.length}`) }
  if (qp.shared !== undefined)    { params.push(qp.shared);    where.push(`m.is_shared = $${params.length}`) }
  if (qp.needsCheck !== undefined){ params.push(qp.needsCheck);where.push(`m.needs_check = $${params.length}`) }
  if (qp.hold && qp.hold !== 'all') where.push(HOLD_SQL[qp.hold] ?? 'TRUE')
  return where
}

export function listMdb(folderIds: number[], qp: MdbListQuery) {
  const params: unknown[] = []
  const where = filters(qp, folderIds, params)

  const sortCol = SORT_SQL[qp.sort] ?? SORT_SQL.updatedAt!
  const desc = qp.dir === 'desc'
  const cmp = desc ? '<' : '>'
  const nulls = desc ? 'NULLS LAST' : 'NULLS FIRST'

  const cur = decodeCursor(qp.cursor)
  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(
      `(${sortCol}, m.id) ${cmp} ($${params.length - 1}::text::${sortCastOf(qp.sort)}, $${params.length}::bigint)`,
    )
  }
  params.push(qp.limit + 1)

  return many<MdbRow>(
    `${SELECT_MDB}
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${sortCol} ${desc ? 'DESC' : 'ASC'} ${nulls}, m.id ${desc ? 'DESC' : 'ASC'}
      LIMIT $${params.length}`,
    params,
  )
}

export async function countMdb(folderIds: number[], qp: MdbListQuery): Promise<number> {
  const params: unknown[] = []
  const where = filters(qp, folderIds, params)
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM mdb_files m JOIN folders f ON f.id = m.folder_id
      WHERE ${where.join(' AND ')}`,
    params,
  )
  return row?.n ?? 0
}

export interface MdbDetailRow extends MdbRow {
  originalFilename: string
  note: string | null
  uploadedBy: string | null
  createdAt: Date
}

export function findMdb(id: number) {
  return one<MdbDetailRow>(
    `SELECT m.id, m.title,
            m.display_name      AS "displayName",
            m.folder_id         AS "folderId",
            f.name              AS "folderName",
            m.file_ext          AS "fileExt",
            b.byte_size         AS "byteSize",
            m.equipment_type    AS "equipmentType",
            m.doc_type          AS "docType",
            p.name              AS "projectName",
            m.year,
            m.is_shared         AS "isShared",
            m.needs_check       AS "needsCheck",
            (SELECT count(*)::int FROM mdb_file_tags t WHERE t.mdb_file_id = m.id) AS "tagCount",
            m.updated_at        AS "updatedAt",
            m.original_filename AS "originalFilename",
            m.note,
            u.name              AS "uploadedBy",
            m.created_at        AS "createdAt"
       FROM mdb_files m
       JOIN folders f  ON f.id = m.folder_id
       JOIN blobs b    ON b.sha256 = m.blob_sha256
  LEFT JOIN projects p ON p.id = m.project_id
  LEFT JOIN users u    ON u.id = m.uploaded_by
      WHERE m.id = $1`,
    [id],
    'mdb_detail',
  )
}

export function listTags(mdbFileId: number) {
  return many<{ tag_no: string }>(
    'SELECT tag_no FROM mdb_file_tags WHERE mdb_file_id = $1 ORDER BY tag_no',
    [mdbFileId],
    'mdb_tags',
  )
}

/** 검색 화면의 선택지 — 실제로 쓰이는 값만 내려준다 */
export function meta() {
  return Promise.all([
    many<{ v: string }>(
      `SELECT DISTINCT equipment_type AS v FROM mdb_files
        WHERE equipment_type IS NOT NULL AND NOT is_archived ORDER BY 1`, [], 'mdb_meta_equip'),
    many<{ v: string }>(
      `SELECT DISTINCT doc_type AS v FROM mdb_files
        WHERE doc_type IS NOT NULL AND NOT is_archived ORDER BY 1`, [], 'mdb_meta_doctype'),
    many<{ id: number; name: string }>(
      `SELECT DISTINCT p.id, p.name FROM mdb_files m JOIN projects p ON p.id = m.project_id
        WHERE NOT m.is_archived ORDER BY p.name`, [], 'mdb_meta_project'),
    many<{ v: number }>(
      `SELECT DISTINCT year AS v FROM mdb_files
        WHERE year IS NOT NULL AND NOT is_archived ORDER BY 1 DESC`, [], 'mdb_meta_year'),
  ])
}

/** Tag No 자동완성 — trgm 인덱스를 탄다 */
export function suggestTags(prefix: string, limit = 20) {
  return many<{ tag_no: string }>(
    `SELECT DISTINCT tag_no FROM mdb_file_tags
      WHERE tag_no ILIKE $1 ORDER BY tag_no LIMIT $2`,
    [`%${prefix}%`, limit],
    'mdb_tag_suggest',
  )
}

// ── 관리 ────────────────────────────────────────────────────────────────

export function mdbBrief(c: pg.PoolClient, ids: number[]) {
  return c.query<{ id: number; title: string; folder_id: number; is_archived: boolean }>(
    'SELECT id, title, folder_id, is_archived FROM mdb_files WHERE id = ANY($1::bigint[])',
    [ids],
  )
}

export function updateMdb(
  c: pg.PoolClient, id: number,
  v: {
    title?: string; equipmentType?: string | null; docType?: string | null
    projectId?: number | null; year?: number | null
    isShared?: boolean; needsCheck?: boolean; note?: string | null
  },
) {
  return c.query(
    `UPDATE mdb_files
        SET title          = coalesce($2, title),
            equipment_type = CASE WHEN $3::boolean THEN $4  ELSE equipment_type END,
            doc_type       = CASE WHEN $5::boolean THEN $6  ELSE doc_type END,
            project_id     = CASE WHEN $7::boolean THEN $8  ELSE project_id END,
            year           = CASE WHEN $9::boolean THEN $10 ELSE year END,
            is_shared      = coalesce($11, is_shared),
            needs_check    = coalesce($12, needs_check),
            note           = CASE WHEN $13::boolean THEN $14 ELSE note END,
            updated_at     = now()
      WHERE id = $1`,
    [
      id, v.title ?? null,
      v.equipmentType !== undefined, v.equipmentType ?? null,
      v.docType !== undefined, v.docType ?? null,
      v.projectId !== undefined, v.projectId ?? null,
      v.year !== undefined, v.year ?? null,
      v.isShared ?? null, v.needsCheck ?? null,
      v.note !== undefined, v.note ?? null,
    ],
  )
}

export async function replaceTags(c: pg.PoolClient, mdbFileId: number, tags: string[]) {
  await c.query('DELETE FROM mdb_file_tags WHERE mdb_file_id = $1', [mdbFileId])
  if (!tags.length) return
  await c.query(
    `INSERT INTO mdb_file_tags (mdb_file_id, tag_no)
     SELECT DISTINCT $1::bigint, trim(t.tag)
       FROM unnest($2::text[]) AS t(tag)
      WHERE trim(t.tag) <> ''
     ON CONFLICT DO NOTHING`,
    [mdbFileId, tags],
  )
}

export function conflictingTitles(c: pg.PoolClient, targetFolderId: number, ids: number[]) {
  return c.query<{ id: number; title: string }>(
    `SELECT s.id, s.title FROM mdb_files s
      WHERE s.id = ANY($2::bigint[])
        AND EXISTS (SELECT 1 FROM mdb_files t
                     WHERE t.folder_id = $1 AND t.id <> s.id
                       AND upper(t.title) = upper(s.title) AND NOT t.is_archived)`,
    [targetFolderId, ids],
  )
}

export async function moveMdb(c: pg.PoolClient, ids: number[], targetFolderId: number) {
  const r = await c.query(
    `UPDATE mdb_files SET folder_id = $2, updated_at = now()
      WHERE id = ANY($1::bigint[]) AND folder_id <> $2`,
    [ids, targetFolderId],
  )
  return r.rowCount ?? 0
}

export async function bulkEquipmentType(
  c: pg.PoolClient, ids: number[], equipmentType: string | null,
) {
  const r = await c.query(
    `UPDATE mdb_files SET equipment_type = $2, updated_at = now() WHERE id = ANY($1::bigint[])`,
    [ids, equipmentType],
  )
  return r.rowCount ?? 0
}

/** 완전 삭제 — 삭제 보관함에만 있다. blob 은 refcount 만 내린다(야간 GC 가 수거). */
export async function purgeBatch(c: pg.PoolClient, batchId: number) {
  const sized = await c.query<{ bytes: string }>(
    `SELECT coalesce(sum(b.byte_size),0)::text AS bytes
       FROM mdb_files m JOIN blobs b ON b.sha256 = m.blob_sha256
      WHERE m.archive_batch_id = $1`,
    [batchId],
  )
  await c.query(
    `UPDATE blobs SET refcount = GREATEST(0, refcount - 1)
      WHERE sha256 IN (SELECT blob_sha256 FROM mdb_files WHERE archive_batch_id = $1)`,
    [batchId],
  )
  await c.query(
    `DELETE FROM mdb_file_tags WHERE mdb_file_id IN
       (SELECT id FROM mdb_files WHERE archive_batch_id = $1)`, [batchId],
  )
  await c.query(
    `DELETE FROM mdb_tag_history_items WHERE mdb_file_id IN
       (SELECT id FROM mdb_files WHERE archive_batch_id = $1)`, [batchId],
  )
  await c.query(
    `DELETE FROM user_favorites WHERE mdb_file_id IN
       (SELECT id FROM mdb_files WHERE archive_batch_id = $1)`, [batchId],
  )
  const del = await c.query('DELETE FROM mdb_files WHERE archive_batch_id = $1', [batchId])
  return { purged: del.rowCount ?? 0, freedBytes: Number(sized.rows[0]?.bytes ?? 0) }
}

// ── 미분류 자료 정리 ────────────────────────────────────────────────────

/**
 * 자료(같은 폴더 + 같은 자료명) 단위로 묶어 분류를 계산한다 (기존 mdb_group.py 규칙).
 *   전용 = Tag No 가 붙음 / 공용 = Tag No 없이 설비유형만 / 확인필요 = 둘 다 없음
 * 한 번에 넉넉히 500건까지 — 더 많으면 검색으로 좁힌다 (기존 화면과 같다).
 */
export function unclassified(v: MdbUnclassifiedQuery) {
  const params: unknown[] = []
  const where = ['NOT m.is_archived']
  if (v.projectId !== undefined) { params.push(v.projectId); where.push(`m.project_id = $${params.length}`) }
  if (v.q) {
    params.push(`%${v.q}%`)
    where.push(`(m.title ILIKE $${params.length} OR f.name ILIKE $${params.length})`)
  }
  params.push(v.category === 'ALL' ? null : v.category)
  const cat = params.length

  return many<{
    id: number; title: string; folderId: number; folderName: string; year: number | null
    projectName: string | null; exts: string[]; equipmentType: string | null; docType: string | null
    tagCount: number; category: 'UNCHECKED' | 'SHARED' | 'DEDICATED'; total: number
  }>(
    `WITH g AS (
       SELECT min(m.id)::int               AS id,
              m.title,
              m.folder_id::int             AS "folderId",
              f.name                       AS "folderName",
              max(m.year)::int             AS year,
              max(p.name)                  AS "projectName",
              array_agg(DISTINCT lower(m.file_ext)) AS exts,
              max(m.equipment_type)        AS "equipmentType",
              max(m.doc_type)              AS "docType",
              (SELECT count(DISTINCT upper(t.tag_no))::int
                 FROM mdb_file_tags t
                 JOIN mdb_files mm ON mm.id = t.mdb_file_id
                WHERE mm.folder_id = m.folder_id AND mm.title = m.title
                  AND NOT mm.is_archived) AS "tagCount"
         FROM mdb_files m
         JOIN folders f       ON f.id = m.folder_id
    LEFT JOIN projects p      ON p.id = m.project_id
        WHERE ${where.join(' AND ')}
        GROUP BY m.folder_id, f.name, m.title
     ), c AS (
       SELECT g.*,
              CASE WHEN g."tagCount" > 0 THEN 'DEDICATED'
                   WHEN coalesce(g."equipmentType", '') <> '' THEN 'SHARED'
                   ELSE 'UNCHECKED' END AS category
         FROM g
     )
     SELECT c.*, (count(*) OVER ())::int AS total
       FROM c
      WHERE $${cat}::text IS NULL OR c.category = $${cat}::text
      ORDER BY c."folderName", c.title
      LIMIT 500`,
    params,
  )
}
