import type pg from 'pg'

/**
 * TDB 관리의 파일 쓰기 쿼리 — 자료 교체·신규 등록·Zip 폴더 업로드.
 *
 * CM 이 관리 화면에서 직접 하는 편집이라 검수 대기를 거치지 않고 바로 승인·현재본이 된다
 * (기존 editor.py replace / register / zip_register 와 같다).
 */

export interface EditDoc {
  id: number
  drawing_no: string
  folder_id: number
  current_rev: number
  is_archived: boolean
  status: string
}

/** 자료 행을 잠그고 읽는다. 잠금 순서는 언제나 '자료 먼저' (imports 와 같은 규칙). */
export async function lockDocs(c: pg.PoolClient, ids: number[]): Promise<EditDoc[]> {
  const r = await c.query<EditDoc>(
    `SELECT id, drawing_no, folder_id, current_rev, is_archived, status
       FROM documents WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [ids],
  )
  return r.rows
}

/** 같은 폴더에 같은 이름(대소문자까지 정확히)으로 있는 자료 — 보관함에 간 것은 빼고 */
export async function docsByNameInFolder(c: pg.PoolClient, folderId: number, drawingNo: string) {
  const r = await c.query<EditDoc>(
    `SELECT id, drawing_no, folder_id, current_rev, is_archived, status
       FROM documents
      WHERE folder_id = $1 AND drawing_no = $2 AND NOT is_archived
      ORDER BY id LIMIT 2`,
    [folderId, drawingNo],
  )
  return r.rows
}

export interface CurrentFile { id: number; file_ext: string; blob_sha256: Buffer; rev: number }

export async function currentFiles(c: pg.PoolClient, documentId: number): Promise<CurrentFile[]> {
  const r = await c.query<CurrentFile>(
    `SELECT id, file_ext, blob_sha256, rev FROM files WHERE document_id = $1 AND is_current`,
    [documentId],
  )
  return r.rows
}

export async function ensureRevisionSet(
  c: pg.PoolClient, documentId: number, rev: number, reason: string, userId: number,
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO revision_sets (document_id, rev, branch, reason, created_by)
     VALUES ($1, $2, NULL, $3, $4)
     ON CONFLICT (document_id, rev, branch) DO UPDATE SET reason = coalesce(revision_sets.reason, EXCLUDED.reason)
     RETURNING id`,
    [documentId, rev, reason, userId],
  )
  return r.rows[0]!.id
}

/** "Rev 유지" 교체 — 같은 행의 내용(blob)만 바꾼다. 리비전·이력은 그대로다. */
export async function swapBlob(
  c: pg.PoolClient, fileId: number, oldSha: Buffer, newSha: Buffer,
  originalFilename: string, userId: number,
) {
  await c.query(
    `UPDATE files SET blob_sha256 = $2, original_filename = $3, uploaded_by = $4, uploaded_at = now()
      WHERE id = $1`,
    [fileId, newSha, originalFilename, userId],
  )
  await c.query('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = $1', [newSha])
  await c.query('UPDATE blobs SET refcount = GREATEST(0, refcount - 1) WHERE sha256 = $1', [oldSha])
}

export async function insertApprovedFile(
  c: pg.PoolClient,
  v: {
    documentId: number; revisionSetId: number; sha256: Buffer; rev: number; fileExt: string
    displayName: string; originalFilename: string; isCurrent: boolean; userId: number
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO files (document_id, revision_set_id, blob_sha256, rev, branch, file_ext,
                        display_name, original_filename, review_status, is_current, uploaded_by)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,'APPROVED',$8,$9)
     RETURNING id`,
    [v.documentId, v.revisionSetId, v.sha256, v.rev, v.fileExt,
     v.displayName, v.originalFilename, v.isCurrent, v.userId],
  )
  await c.query('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = $1', [v.sha256])
  return r.rows[0]!.id
}

/** 지금 현재본을 이력으로 내린다 (행은 남는다) */
export function demoteCurrent(c: pg.PoolClient, documentId: number) {
  return c.query('UPDATE files SET is_current = false WHERE document_id = $1 AND is_current', [documentId])
}

/** 현재본 기준으로 has_* 를 다시 계산한다. rev 를 주면 current_rev 도 바꾼다. */
export function refreshDoc(c: pg.PoolClient, documentId: number, rev: number | null = null) {
  return c.query(
    `UPDATE documents d
        SET current_rev = coalesce($2, current_rev),
            has_pdf  = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext = 'pdf'),
            has_dwg  = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext = 'dwg'),
            has_xlsx = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current AND file_ext IN ('xlsx','xls')),
            has_etc  = EXISTS (SELECT 1 FROM files WHERE document_id = d.id AND is_current
                                 AND file_ext NOT IN ('pdf','dwg','xlsx','xls')),
            updated_at = now()
      WHERE d.id = $1`,
    [documentId, rev],
  )
}

export async function createDocument(
  c: pg.PoolClient, folderId: number, drawingNo: string, rev: number,
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO documents (folder_id, drawing_no, title, current_rev, status)
     VALUES ($1, $2, $2, $3, 'ACTIVE') RETURNING id`,
    [folderId, drawingNo, rev],
  )
  return r.rows[0]!.id
}

/** 자료가 들어간 폴더는 더 이상 '빈 폴더 표시용'이 아니다 */
export function unmarkPlaceholder(c: pg.PoolClient, folderId: number) {
  return c.query(
    'UPDATE folders SET is_placeholder = false WHERE id = $1 AND is_placeholder',
    [folderId],
  )
}

export async function childFolder(c: pg.PoolClient, parentId: number, name: string) {
  const r = await c.query<{ id: number; is_archived: boolean }>(
    'SELECT id, is_archived FROM folders WHERE parent_id = $1 AND name = $2',
    [parentId, name],
  )
  return r.rows[0]
}
