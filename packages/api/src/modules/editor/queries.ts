import type pg from 'pg'
import { many, one } from '../../core/db.js'

/** TDB 관리 쿼리. SQL 은 이 파일에만 있다. */

// ── 폴더 편집 ───────────────────────────────────────────────────────────

/** folder_create() 함수가 id 라벨 ltree path 까지 채워 준다 (마이그레이션 0007) */
export async function createFolder(
  c: pg.PoolClient, docClass: string, parentId: number | null, name: string, userId: number,
): Promise<number> {
  const r = await c.query<{ folder_create: number }>(
    'SELECT folder_create($1,$2,$3,$4) AS folder_create',
    [docClass, parentId, name, userId],
  )
  return r.rows[0]!.folder_create
}

/** 이름 변경은 row 1개 UPDATE 다 — ltree 라벨이 폴더 id 라 path 가 바뀌지 않는다 */
export function renameFolder(c: pg.PoolClient, id: number, name: string) {
  return c.query('UPDATE folders SET name = $2, updated_at = now() WHERE id = $1', [id, name])
}

/** folder_reparent() 가 하위 전체 path 접두어를 한 번에 바꾸고 영향받은 수를 돌려준다 */
export async function moveFolder(c: pg.PoolClient, id: number, newParentId: number | null): Promise<number> {
  const r = await c.query<{ folder_reparent: number }>(
    'SELECT folder_reparent($1,$2) AS folder_reparent', [id, newParentId],
  )
  return r.rows[0]!.folder_reparent
}

export async function folderById(c: pg.PoolClient, id: number) {
  const r = await c.query<{
    id: number; name: string; parent_id: number | null; doc_class: string
    path: string; doc_count: number; is_archived: boolean
  }>(
    `SELECT id, name, parent_id, doc_class, path::text AS path, doc_count, is_archived
       FROM folders WHERE id = $1`,
    [id],
  )
  return r.rows[0]
}

/** 사람이 읽는 전체 경로 — 보관함의 '원래 자리' 기록에 쓴다 */
export async function folderPathText(c: pg.PoolClient, id: number): Promise<string> {
  const r = await c.query<{ path: string }>(
    `SELECT string_agg(a.name, ' › ' ORDER BY a.depth) AS path
       FROM folders f, folders a
      WHERE f.id = $1 AND a.path @> f.path`,
    [id],
  )
  return r.rows[0]?.path ?? ''
}

export function nameTaken(c: pg.PoolClient, parentId: number | null, name: string, exceptId?: number) {
  return c.query<{ id: number }>(
    `SELECT id FROM folders
      WHERE parent_id IS NOT DISTINCT FROM $1 AND name = $2 AND ($3::bigint IS NULL OR id <> $3)
      LIMIT 1`,
    [parentId, name, exceptId ?? null],
  )
}

// ── 자료 편집 ───────────────────────────────────────────────────────────

export function renameDocument(
  c: pg.PoolClient, id: number, v: { drawingNo?: string; title?: string; note?: string | null },
) {
  return c.query(
    `UPDATE documents
        SET drawing_no = coalesce($2, drawing_no),
            title      = coalesce($3, title),
            note       = CASE WHEN $4::boolean THEN $5 ELSE note END,
            updated_at = now()
      WHERE id = $1`,
    [id, v.drawingNo ?? null, v.title ?? null, v.note !== undefined, v.note ?? null],
  )
}

/** 대상 폴더에 같은 도면번호가 이미 있는지 — 옮기기 전에 본다 */
export function conflictingInFolder(c: pg.PoolClient, targetFolderId: number, documentIds: number[]) {
  return c.query<{ id: number; drawing_no: string }>(
    `SELECT s.id, s.drawing_no
       FROM documents s
      WHERE s.id = ANY($2::bigint[])
        AND EXISTS (SELECT 1 FROM documents t
                     WHERE t.folder_id = $1 AND t.id <> s.id
                       AND upper(t.drawing_no) = upper(s.drawing_no)
                       AND NOT t.is_archived)`,
    [targetFolderId, documentIds],
  )
}

export async function moveDocuments(
  c: pg.PoolClient, documentIds: number[], targetFolderId: number,
): Promise<number> {
  const r = await c.query(
    `UPDATE documents SET folder_id = $2, updated_at = now()
      WHERE id = ANY($1::bigint[]) AND folder_id <> $2`,
    [documentIds, targetFolderId],
  )
  return r.rowCount ?? 0
}

export function documentsBrief(c: pg.PoolClient, ids: number[]) {
  return c.query<{ id: number; drawing_no: string; folder_id: number; is_archived: boolean }>(
    `SELECT id, drawing_no, folder_id, is_archived FROM documents WHERE id = ANY($1::bigint[])`,
    [ids],
  )
}

// ── 보관함 ──────────────────────────────────────────────────────────────

export async function createBatch(
  c: pg.PoolClient,
  v: {
    kind: 'TRASH' | 'RETIRE'; docClass: string; label: string
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

export function archiveDocuments(c: pg.PoolClient, ids: number[], batchId: number, retired: boolean) {
  return c.query(
    `UPDATE documents
        SET is_archived = true, archive_batch_id = $2,
            status = CASE WHEN $3::boolean THEN 'RETIRED' ELSE status END,
            updated_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids, batchId, retired],
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

/** 폴더 하위(자신 포함)의 보관 대상 자료 id */
export async function documentsUnderFolder(c: pg.PoolClient, folderId: number): Promise<number[]> {
  const r = await c.query<{ id: number }>(
    `SELECT d.id FROM documents d
       JOIN folders f ON f.id = d.folder_id
       JOIN folders r ON r.id = $1
      WHERE f.path <@ r.path AND NOT d.is_archived`,
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

export function listBatches(docClass: string, kind: 'TRASH' | 'RETIRE') {
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
    'archive_batches_list',
  )
}

export function countBatches(docClass: string, kind: 'TRASH' | 'RETIRE') {
  return one<{ n: number }>(
    `SELECT count(*)::int AS n FROM archive_batches
      WHERE doc_class = $1 AND kind = $2 AND restored_at IS NULL AND purged_at IS NULL`,
    [docClass, kind],
    'archive_batches_count',
  )
}

export function setBatchNote(c: pg.PoolClient, batchId: number, note: string | null) {
  return c.query('UPDATE archive_batches SET note = $2 WHERE id = $1', [batchId, note])
}

export async function batchById(c: pg.PoolClient, id: number) {
  const r = await c.query<{
    id: number; kind: string; doc_class: string; label: string
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
 * 장애물로 치면 안 된다. **다른 묶음으로** 보관됐거나 아예 없어진 폴더만 막는다.
 */
export async function restoreTargetAlive(c: pg.PoolClient, batchId: number): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT coalesce(bool_and(
              f.id IS NOT NULL
              AND (NOT f.is_archived OR f.archive_batch_id = $1)
            ), true) AS ok
       FROM documents d
  LEFT JOIN folders f ON f.id = d.folder_id
      WHERE d.archive_batch_id = $1`,
    [batchId],
  )
  return r.rows[0]?.ok ?? true
}

export async function restoreBatch(c: pg.PoolClient, batchId: number, userId: number): Promise<number> {
  const docs = await c.query(
    `UPDATE documents
        SET is_archived = false, archive_batch_id = NULL,
            status = CASE WHEN status = 'RETIRED' THEN 'ACTIVE' ELSE status END,
            updated_at = now()
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
  return docs.rowCount ?? 0
}

/**
 * 완전 삭제 — 삭제 보관함에만 있다.
 * 자료 행은 지우되 blob 은 refcount 만 내린다(야간 GC 가 수거). 감사 로그는 남는다.
 */
export async function purgeBatch(c: pg.PoolClient, batchId: number) {
  const sized = await c.query<{ bytes: string }>(
    `SELECT coalesce(sum(b.byte_size),0)::text AS bytes
       FROM documents d JOIN files fl ON fl.document_id = d.id
       JOIN blobs b ON b.sha256 = fl.blob_sha256
      WHERE d.archive_batch_id = $1`,
    [batchId],
  )
  await c.query(
    `UPDATE blobs SET refcount = GREATEST(0, refcount - 1)
      WHERE sha256 IN (SELECT fl.blob_sha256 FROM files fl
                         JOIN documents d ON d.id = fl.document_id
                        WHERE d.archive_batch_id = $1)`,
    [batchId],
  )
  // 반출 기록은 남긴다 — 누가 받아 갔는지는 자료가 사라져도 알아야 한다.
  // 자료명을 스냅샷해 두고 FK 만 끊는다 (0013).
  await c.query(
    `UPDATE distributions x
        SET document_label = coalesce(x.document_label, d.drawing_no),
            document_id    = NULL,
            returned_file_id = NULL
       FROM documents d
      WHERE d.id = x.document_id AND d.archive_batch_id = $1`,
    [batchId],
  )
  await c.query(
    `DELETE FROM files WHERE document_id IN (SELECT id FROM documents WHERE archive_batch_id = $1)`,
    [batchId],
  )
  await c.query(
    `DELETE FROM revision_sets WHERE document_id IN (SELECT id FROM documents WHERE archive_batch_id = $1)`,
    [batchId],
  )
  const del = await c.query(`DELETE FROM documents WHERE archive_batch_id = $1`, [batchId])
  return { purged: del.rowCount ?? 0, freedBytes: Number(sized.rows[0]?.bytes ?? 0) }
}

// ── 원본·사본 분리 폴더 ─────────────────────────────────────────────────

export function pairFolderCandidates(docClass: string) {
  return many<{
    parentId: number; parentName: string
    dwgFolderId: number; pdfFolderId: number
    matchedCount: number; dwgOnly: number; pdfOnly: number
  }>(
    `WITH pairs AS (
       SELECT p.id AS "parentId", p.name AS "parentName",
              dwg.id AS "dwgFolderId", pdf.id AS "pdfFolderId"
         FROM folders p
         JOIN folders dwg ON dwg.parent_id = p.id AND upper(dwg.name) = 'DWG' AND NOT dwg.is_archived
         JOIN folders pdf ON pdf.parent_id = p.id AND upper(pdf.name) = 'PDF' AND NOT pdf.is_archived
        WHERE p.doc_class = $1 AND NOT p.is_archived
     )
     SELECT x.*,
            (SELECT count(*)::int FROM documents a JOIN documents b
                    ON upper(a.drawing_no) = upper(b.drawing_no)
                  WHERE a.folder_id = x."dwgFolderId" AND b.folder_id = x."pdfFolderId") AS "matchedCount",
            (SELECT count(*)::int FROM documents a WHERE a.folder_id = x."dwgFolderId") AS "dwgOnly",
            (SELECT count(*)::int FROM documents b WHERE b.folder_id = x."pdfFolderId") AS "pdfOnly"
       FROM pairs x
      ORDER BY x."parentName"`,
    [docClass],
    'pair_folder_candidates',
  )
}

/** DWG·PDF 폴더의 자료를 부모 폴더로 올려 한 건으로 합친다 */
export async function mergePairFolders(
  c: pg.PoolClient, parentId: number, dwgFolderId: number, pdfFolderId: number,
) {
  const moved = await c.query(
    `UPDATE documents SET folder_id = $1, pairing_folder =
            CASE WHEN folder_id = $2 THEN 'DWG' ELSE 'PDF' END,
            updated_at = now()
      WHERE folder_id IN ($2, $3)`,
    [parentId, dwgFolderId, pdfFolderId],
  )
  // 빈 껍데기가 된 폴더는 표시용 placeholder 로 남긴다 (삭제하지 않는다)
  await c.query(
    `UPDATE folders SET is_placeholder = true WHERE id IN ($1, $2)`,
    [dwgFolderId, pdfFolderId],
  )
  return moved.rowCount ?? 0
}
