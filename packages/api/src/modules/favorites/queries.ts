import { many, one, query } from '../../core/db.js'

export interface FavoriteRow {
  id: number
  name: string
  note: string | null
  docClass: string
  documentId: number | null
  mdbFileId: number | null
  targetName: string | null
  updatedAt: Date
}

export function listMine(userId: number) {
  return many<FavoriteRow>(
    `SELECT fv.id, fv.name, fv.note,
            fv.doc_class   AS "docClass",
            fv.document_id AS "documentId",
            fv.mdb_file_id AS "mdbFileId",
            coalesce(d.drawing_no, m.title) AS "targetName",
            fv.updated_at  AS "updatedAt"
       FROM user_favorites fv
  LEFT JOIN documents d ON d.id = fv.document_id
  LEFT JOIN mdb_files m ON m.id = fv.mdb_file_id
      WHERE fv.user_id = $1
      ORDER BY fv.updated_at DESC`,
    [userId],
    'favorites_mine',
  )
}

export function findMarkup(id: number, userId: number) {
  return one<{ markup: unknown }>(
    'SELECT markup FROM user_favorites WHERE id = $1 AND user_id = $2',
    [id, userId],
    'favorite_markup',
  )
}

/** 이 자료에 이 사람이 이미 보관한 것이 있는가 — 뷰어의 [보관하기] 버튼 상태를 정한다 */
export function findTarget(
  userId: number,
  docClass: string,
  documentId: number | null,
  mdbFileId: number | null,
) {
  return one<{ id: number; name: string }>(
    `SELECT id, name FROM user_favorites
      WHERE user_id = $1 AND doc_class = $2
        AND document_id IS NOT DISTINCT FROM $3
        AND mdb_file_id IS NOT DISTINCT FROM $4
      ORDER BY updated_at DESC LIMIT 1`,
    [userId, docClass, documentId, mdbFileId],
    'favorite_target',
  )
}

export async function upsert(
  userId: number,
  v: {
    docClass: string
    documentId: number | null
    mdbFileId: number | null
    name: string
    note: string | null
    markup: unknown[]
    originalMarkup: unknown[]
    overwriteId: number | null
  },
): Promise<number> {
  const payload = JSON.stringify({ markup: v.markup, original_markup: v.originalMarkup })

  if (v.overwriteId !== null) {
    const row = await one<{ id: number }>(
      `UPDATE user_favorites
          SET name = $3, note = $4, markup = $5::jsonb, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [v.overwriteId, userId, v.name, v.note, payload],
    )
    if (row) return row.id
    // 남의 것이거나 없어진 것이면 새로 만든다
  }

  const row = await one<{ id: number }>(
    `INSERT INTO user_favorites (user_id, doc_class, document_id, mdb_file_id, name, note, markup)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [userId, v.docClass, v.documentId, v.mdbFileId, v.name, v.note, payload],
  )
  return row!.id
}

export function remove(id: number, userId: number) {
  return query('DELETE FROM user_favorites WHERE id = $1 AND user_id = $2', [id, userId])
}
