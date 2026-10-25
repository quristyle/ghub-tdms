import type pg from 'pg'
import type { MdbListQuery } from '@tdms/contracts'
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
  updatedAt: Date
}

const SELECT_MDB = `
  SELECT m.id, m.title,
         m.display_name   AS "displayName",
         m.folder_id      AS "folderId",
         f.name           AS "folderName",
         m.file_ext       AS "fileExt",
         b.byte_size      AS "byteSize",
         m.equipment_type AS "equipmentType",
         m.doc_type       AS "docType",
         p.name           AS "projectName",
         m.year,
         m.is_shared      AS "isShared",
         m.needs_check    AS "needsCheck",
         (SELECT count(*)::int FROM mdb_file_tags t WHERE t.mdb_file_id = m.id) AS "tagCount",
         m.updated_at     AS "updatedAt"
    FROM mdb_files m
    JOIN folders f  ON f.id = m.folder_id
    JOIN blobs b    ON b.sha256 = m.blob_sha256
    LEFT JOIN projects p ON p.id = m.project_id`

function filters(qp: MdbListQuery, folderIds: number[], params: unknown[]): string[] {
  const where = ['NOT m.is_archived']
  params.push(folderIds)
  where.push(`m.folder_id = ANY($${params.length}::bigint[])`)

  if (qp.q) {
    params.push(`%${qp.q}%`)
    const i = params.length
    if (qp.searchTarget === 'folder') where.push(`f.name ILIKE $${i}`)
    else if (qp.searchTarget === 'tag')
      where.push(`EXISTS (SELECT 1 FROM mdb_file_tags t WHERE t.mdb_file_id = m.id AND t.tag_no ILIKE $${i})`)
    else where.push(`m.search_text ILIKE $${i}`)
  }
  if (qp.equipmentType) { params.push(qp.equipmentType); where.push(`m.equipment_type = $${params.length}`) }
  if (qp.docType)       { params.push(qp.docType);       where.push(`m.doc_type = $${params.length}`) }
  if (qp.projectId !== undefined) { params.push(qp.projectId); where.push(`m.project_id = $${params.length}`) }
  if (qp.year !== undefined)      { params.push(qp.year);      where.push(`m.year = $${params.length}`) }
  if (qp.shared !== undefined)    { params.push(qp.shared);    where.push(`m.is_shared = $${params.length}`) }
  if (qp.needsCheck !== undefined){ params.push(qp.needsCheck);where.push(`m.needs_check = $${params.length}`) }
  return where
}

export function listMdb(folderIds: number[], qp: MdbListQuery) {
  const params: unknown[] = []
  const where = filters(qp, folderIds, params)

  const cur = decodeCursor(qp.cursor)
  if (cur) {
    params.push(cur.sortValue, cur.id)
    where.push(`(m.updated_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`)
  }
  params.push(qp.limit + 1)

  return many<MdbRow>(
    `${SELECT_MDB}
      WHERE ${where.join('\n        AND ')}
      ORDER BY m.updated_at DESC, m.id DESC
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
