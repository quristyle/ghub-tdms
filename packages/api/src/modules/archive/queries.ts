import type pg from 'pg'
import { many, one } from '../../core/db.js'

/**
 * 보관함 공용 쿼리 — TDB·MDB 가 같은 기구를 쓴다.
 *
 * 자료를 담는 표만 다르고(documents / mdb_files) 나머지 규칙은 같으므로
 * 표 이름만 매개변수로 받는다. **doc_class 로 갈라 조회하므로 서로 섞이지 않는다.**
 *
 * 삭제 — 오류 등으로 없애는 것. 폴더째 묶어 한 줄. 복구 + 완전 삭제 가능.
 * 폐기 — 리비전 후 최신본에서 빠진 것. 자료 1건 = 이력 1건. 복구만 가능.
 */

export type DocClass = 'TDB' | 'MDB'
export type ArchiveKind = 'TRASH' | 'RETIRE'

/** 자료를 담는 표. SQL 조각에 직접 끼우므로 여기 적힌 값만 쓸 수 있다. */
const ITEM_TABLE: Record<DocClass, string> = {
  TDB: 'documents',
  MDB: 'mdb_files',
}

/** 그 표가 상태 컬럼을 갖는가 (TDB 만 RETIRED 상태가 있다) */
const HAS_STATUS: Record<DocClass, boolean> = { TDB: true, MDB: false }

function table(docClass: DocClass): string {
  const t = ITEM_TABLE[docClass]
  if (!t) throw new Error(`알 수 없는 doc_class: ${docClass}`)
  return t
}

export async function createBatch(
  c: pg.PoolClient,
  v: {
    kind: ArchiveKind; docClass: DocClass; label: string
    originalPath: string | null; folderId: number | null
    reason: string | null; itemCount: number; userId: number
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO archive_batches
       (kind, doc_class, label, original_path, folder_id, reason, item_count, archived_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [v.kind, v.docClass, v.label, v.originalPath, v.folderId, v.reason, v.itemCount, v.userId],
  )
  return r.rows[0]!.id
}

export function archiveItems(
  c: pg.PoolClient, docClass: DocClass, ids: number[], batchId: number, retired: boolean,
) {
  const t = table(docClass)
  const statusPart = HAS_STATUS[docClass] && retired ? `, status = 'RETIRED'` : ''
  return c.query(
    `UPDATE ${t}
        SET is_archived = true, archive_batch_id = $2${statusPart}, updated_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids, batchId],
  )
}

export function archiveFolderTree(c: pg.PoolClient, folderId: number, batchId: number) {
  return c.query(
    `WITH tree AS (SELECT d.id FROM folders r, folders d WHERE r.id = $1 AND d.path <@ r.path)
     UPDATE folders SET is_archived = true, archive_batch_id = $2, updated_at = now()
      WHERE id IN (SELECT id FROM tree)`,
    [folderId, batchId],
  )
}

export async function itemsUnderFolder(
  c: pg.PoolClient, docClass: DocClass, folderId: number,
): Promise<number[]> {
  const t = table(docClass)
  const r = await c.query<{ id: number }>(
    `SELECT i.id FROM ${t} i
       JOIN folders f ON f.id = i.folder_id
       JOIN folders r ON r.id = $1
      WHERE f.path <@ r.path AND NOT i.is_archived`,
    [folderId],
  )
  return r.rows.map((x) => x.id)
}

export interface BatchRow {
  id: number
  kind: string
  label: string
  originalPath: string | null
  reason: string | null
  note: string | null
  itemCount: number
  archivedAt: Date
  archivedBy: string | null
}

export function listBatches(docClass: DocClass, kind: ArchiveKind) {
  return many<BatchRow>(
    `SELECT b.id, b.kind, b.label,
            b.original_path AS "originalPath",
            b.reason, b.note,
            b.item_count    AS "itemCount",
            b.archived_at   AS "archivedAt",
            u.name          AS "archivedBy"
       FROM archive_batches b
  LEFT JOIN users u ON u.id = b.archived_by
      WHERE b.doc_class = $1 AND b.kind = $2
        AND b.restored_at IS NULL AND b.purged_at IS NULL
      ORDER BY b.archived_at DESC`,
    [docClass, kind],
    'archive_list',
  )
}

export function countBatches(docClass: DocClass, kind: ArchiveKind) {
  return one<{ n: number }>(
    `SELECT count(*)::int AS n FROM archive_batches
      WHERE doc_class = $1 AND kind = $2 AND restored_at IS NULL AND purged_at IS NULL`,
    [docClass, kind],
    'archive_count',
  )
}

export function setBatchNote(c: pg.PoolClient, batchId: number, note: string | null) {
  return c.query('UPDATE archive_batches SET note = $2 WHERE id = $1', [batchId, note])
}

export async function batchById(c: pg.PoolClient, id: number) {
  const r = await c.query<{
    id: number; kind: ArchiveKind; doc_class: DocClass; label: string
    folder_id: number | null; restored_at: Date | null; purged_at: Date | null
  }>(
    `SELECT id, kind, doc_class, label, folder_id, restored_at, purged_at
       FROM archive_batches WHERE id = $1`,
    [id],
  )
  return r.rows[0]
}

/**
 * 복구할 때 원래 자리가 아직 살아 있는지.
 *
 * 폴더째 보관한 묶음은 그 폴더도 같은 묶음에 들어가 있다 — 함께 복구되므로
 * 장애물로 치면 안 된다. 다른 묶음으로 보관됐거나 아예 없어진 폴더만 막는다.
 */
export async function restoreTargetAlive(
  c: pg.PoolClient, docClass: DocClass, batchId: number,
): Promise<boolean> {
  const t = table(docClass)
  const r = await c.query<{ ok: boolean }>(
    `SELECT coalesce(bool_and(
              f.id IS NOT NULL AND (NOT f.is_archived OR f.archive_batch_id = $1)
            ), true) AS ok
       FROM ${t} i
  LEFT JOIN folders f ON f.id = i.folder_id
      WHERE i.archive_batch_id = $1`,
    [batchId],
  )
  return r.rows[0]?.ok ?? true
}

export async function restoreBatch(
  c: pg.PoolClient, docClass: DocClass, batchId: number, userId: number,
): Promise<number> {
  const t = table(docClass)
  const statusPart = HAS_STATUS[docClass]
    ? `, status = CASE WHEN status = 'RETIRED' THEN 'ACTIVE' ELSE status END`
    : ''
  const items = await c.query(
    `UPDATE ${t}
        SET is_archived = false, archive_batch_id = NULL${statusPart}, updated_at = now()
      WHERE archive_batch_id = $1`,
    [batchId],
  )
  await c.query(
    `UPDATE folders SET is_archived = false, archive_batch_id = NULL WHERE archive_batch_id = $1`,
    [batchId],
  )
  await c.query(
    'UPDATE archive_batches SET restored_at = now(), restored_by = $2 WHERE id = $1',
    [batchId, userId],
  )
  return items.rowCount ?? 0
}
