import { many, one, query } from '../../core/db.js'
import { SIBLING_LATERAL } from '../mdb/browse.js'

/**
 * 보관 목록 쿼리.
 *
 * markup jsonb 한 칸에 { markup, original_markup, source_name, view_mode, pdf_file_id } 를
 * 함께 담는다 — 기존 시스템의 source_name·view_mode·pdf_file_id 칸을 표에 늘리지 않으려고.
 */

export interface FavoriteRow {
  id: number
  kind: 'TDB' | 'MDB'
  name: string
  note: string | null
  hasMarkup: boolean
  documentId: number | null
  mdbFileId: number | null
  sourceName: string | null
  viewMode: string | null
  currentName: string | null
  path: string | null
  pdfFileId: number | null
  missing: boolean
  createdAt: Date
  updatedAt: Date
}

/** 배열이 아니면 빈 배열로 본다 */
const ARR = (expr: string) =>
  `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`

/**
 * 보관 1건 + 지금 그 자료의 상태.
 * 삭제 보관함에 들어간 자료는 "삭제됨", 폐기 보관함에 들어간 자료는 정상으로 본다
 * (폐기 자료도 상세·미리보기가 열린다 — 기존 D-62 ⑦).
 */
const SELECT_FAV = `
  SELECT fv.id,
         fv.doc_class   AS kind,
         fv.name, fv.note,
         (jsonb_array_length(${ARR("fv.markup->'markup'")})
          + jsonb_array_length(${ARR("fv.markup->'original_markup'")})) > 0 AS "hasMarkup",
         fv.document_id AS "documentId",
         fv.mdb_file_id AS "mdbFileId",
         fv.markup->>'source_name' AS "sourceName",
         fv.markup->>'view_mode'   AS "viewMode",
         CASE WHEN fv.doc_class = 'TDB' THEN d.drawing_no ELSE m.title END AS "currentName",
         (SELECT string_agg(a.name, ' > ' ORDER BY nlevel(a.path))
            FROM folders a WHERE a.path @> fo.path) AS path,
         CASE WHEN fv.doc_class = 'TDB' THEN tp.id
              WHEN lower(m.file_ext) = 'pdf' THEN m.id
              WHEN lower(sib.sib_ext) = 'pdf' THEN sib.sib_id END AS "pdfFileId",
         CASE WHEN fv.doc_class = 'TDB'
              THEN d.id IS NULL OR (d.is_archived AND coalesce(dab.kind, 'TRASH') = 'TRASH')
              ELSE m.id IS NULL OR (m.is_archived AND coalesce(mab.kind, 'TRASH') = 'TRASH') END AS missing,
         fv.created_at AS "createdAt",
         fv.updated_at AS "updatedAt"
    FROM user_favorites fv
LEFT JOIN documents d        ON d.id = fv.document_id
LEFT JOIN archive_batches dab ON dab.id = d.archive_batch_id
LEFT JOIN mdb_files m        ON m.id = fv.mdb_file_id
LEFT JOIN archive_batches mab ON mab.id = m.archive_batch_id
LEFT JOIN folders fo         ON fo.id = coalesce(d.folder_id, m.folder_id)
LEFT JOIN LATERAL (
       SELECT fl.id FROM files fl
        WHERE fl.document_id = d.id AND fl.is_current AND lower(fl.file_ext) = 'pdf'
        ORDER BY fl.id DESC LIMIT 1) tp ON true
     ${SIBLING_LATERAL}`

export function listMine(userId: number) {
  return many<FavoriteRow>(
    `${SELECT_FAV}
      WHERE fv.user_id = $1
      ORDER BY fv.updated_at DESC, fv.id DESC`,
    [userId],
    'favorites_mine_v2',
  )
}

export function findMine(id: number, userId: number) {
  return one<FavoriteRow>(
    `${SELECT_FAV} WHERE fv.id = $1 AND fv.user_id = $2`,
    [id, userId],
    'favorites_one_v2',
  )
}

export async function countMine(userId: number): Promise<number> {
  const r = await one<{ n: number }>(
    'SELECT count(*)::int AS n FROM user_favorites WHERE user_id = $1',
    [userId],
    'favorites_count',
  )
  return r?.n ?? 0
}

export function findMarkup(id: number, userId: number) {
  return one<{ markup: unknown }>(
    'SELECT markup FROM user_favorites WHERE id = $1 AND user_id = $2',
    [id, userId],
    'favorite_markup',
  )
}

// ── 뷰어가 보는 자료 찾기 ──────────────────────────────────────────────

/** TDB 파일 → 자료. 지금 리비전의 파일만 보관 대상이다(옛 Rev·검수 대기분은 아니다). */
export function tdbTargetOfFile(fileId: number) {
  return one<{ documentId: number; name: string; pdfFileId: number | null; missing: boolean }>(
    `SELECT d.id AS "documentId", d.drawing_no AS name,
            (SELECT p.id FROM files p
              WHERE p.document_id = d.id AND p.is_current AND lower(p.file_ext) = 'pdf'
              ORDER BY p.id DESC LIMIT 1) AS "pdfFileId",
            (d.is_archived AND coalesce(ab.kind, 'TRASH') = 'TRASH') AS missing
       FROM files fl
       JOIN documents d ON d.id = fl.document_id
  LEFT JOIN archive_batches ab ON ab.id = d.archive_batch_id
      WHERE fl.id = $1 AND fl.is_current AND fl.review_status = 'APPROVED'`,
    [fileId],
    'favorite_tdb_target',
  )
}

/** 보관하려는 TDB 자료가 아직 열리는가 */
export function tdbAlive(documentId: number) {
  return one<{ name: string }>(
    `SELECT d.drawing_no AS name FROM documents d
  LEFT JOIN archive_batches ab ON ab.id = d.archive_batch_id
      WHERE d.id = $1 AND NOT (d.is_archived AND coalesce(ab.kind, 'TRASH') = 'TRASH')`,
    [documentId],
    'favorite_tdb_alive',
  )
}

/** 보관하려는 MDB 자료가 아직 열리는가 */
export function mdbAlive(mdbFileId: number) {
  return one<{ name: string }>(
    `SELECT m.title AS name FROM mdb_files m
  LEFT JOIN archive_batches ab ON ab.id = m.archive_batch_id
      WHERE m.id = $1 AND NOT (m.is_archived AND coalesce(ab.kind, 'TRASH') = 'TRASH')`,
    [mdbFileId],
    'favorite_mdb_alive',
  )
}

// ── 보관 · 고치기 · 지우기 ─────────────────────────────────────────────

export async function save(
  userId: number,
  v: {
    kind: 'TDB' | 'MDB'
    documentId: number | null
    mdbFileId: number | null
    name: string
    note: string | null
    payload: string
    overwriteId: number | null
  },
): Promise<number | null> {
  if (v.overwriteId !== null) {
    const row = await one<{ id: number }>(
      `UPDATE user_favorites
          SET doc_class = $3, document_id = $4, mdb_file_id = $5,
              name = $6, note = $7, markup = $8::jsonb, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [v.overwriteId, userId, v.kind, v.documentId, v.mdbFileId, v.name, v.note, v.payload],
    )
    return row?.id ?? null
  }
  const row = await one<{ id: number }>(
    `INSERT INTO user_favorites (user_id, doc_class, document_id, mdb_file_id, name, note, markup)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [userId, v.kind, v.documentId, v.mdbFileId, v.name, v.note, v.payload],
  )
  return row!.id
}

export async function setNote(id: number, userId: number, note: string | null): Promise<boolean> {
  const r = await query(
    'UPDATE user_favorites SET note = $3 WHERE id = $1 AND user_id = $2',
    [id, userId, note],
  )
  return (r.rowCount ?? 0) > 0
}

/** 자기 것만 지운다. 지운 것의 이름을 돌려준다(감사 기록용). */
export async function removeMany(ids: number[], userId: number) {
  const r = await query<{ id: number; name: string }>(
    'DELETE FROM user_favorites WHERE id = ANY($1::bigint[]) AND user_id = $2 RETURNING id, name',
    [ids, userId],
  )
  return r.rows
}
