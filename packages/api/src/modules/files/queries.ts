import { one, tx } from '../../core/db.js'

export interface FileBlobRow {
  id: number
  documentId: number
  blobSha256: Buffer
  fileExt: string
  displayName: string
  byteSize: number
  drawingNo: string
  reviewStatus: string
}

/** 다운로드·열람에 필요한 최소 정보. 권한 검사와 감사 기록에 쓸 자료명도 함께 가져온다. */
export function findFileForDownload(fileId: number) {
  return one<FileBlobRow>(
    `SELECT fl.id,
            fl.document_id  AS "documentId",
            fl.blob_sha256  AS "blobSha256",
            fl.file_ext     AS "fileExt",
            fl.display_name AS "displayName",
            b.byte_size     AS "byteSize",
            d.drawing_no    AS "drawingNo",
            fl.review_status AS "reviewStatus"
       FROM files fl
       JOIN blobs b     ON b.sha256 = fl.blob_sha256
       JOIN documents d ON d.id = fl.document_id
      WHERE fl.id = $1`,
    [fileId],
    'file_for_download',
  )
}

export function findMdbFileForDownload(mdbFileId: number) {
  return one<Omit<FileBlobRow, 'documentId' | 'drawingNo' | 'reviewStatus'> & { title: string }>(
    `SELECT m.id,
            m.blob_sha256  AS "blobSha256",
            m.file_ext     AS "fileExt",
            m.display_name AS "displayName",
            b.byte_size    AS "byteSize",
            m.title
       FROM mdb_files m
       JOIN blobs b ON b.sha256 = m.blob_sha256
      WHERE m.id = $1`,
    [mdbFileId],
    'mdb_file_for_download',
  )
}

// ── 원본(DWG·DXF) 미리보기 ─────────────────────────────────────────────
// 워커 handlers/preview.py 의 CONVERTER_VERSION 과 같아야 한다.
export const RENDITION_VERSION = 1
export const RENDITION_EXTS = new Set(['dwg', 'dxf'])

export interface RenditionRow {
  state: 'pending' | 'done' | 'failed'
  error: string | null
  pdfSha256: Buffer | null
  pdfByteSize: number | null
}

export function findRendition(sourceSha256: Buffer) {
  return one<RenditionRow>(
    `SELECT r.state, r.error,
            r.pdf_sha256 AS "pdfSha256",
            b.byte_size  AS "pdfByteSize"
       FROM preview_renditions r
       LEFT JOIN blobs b ON b.sha256 = r.pdf_sha256
      WHERE r.source_sha256 = $1 AND r.converter_version = $2`,
    [sourceSha256, RENDITION_VERSION],
    'rendition_find',
  )
}

/**
 * 변환을 맡긴다. 없던 것이거나, 실패한 지 하루가 지났거나, 맡긴 지 30분이 지나도
 * 끝나지 않은(워커가 죽은) 것만 다시 맡긴다. 둘이 동시에 열어도 작업은 하나만 생긴다 —
 * 같은 행을 잠그고 조건을 보기 때문이다.
 */
export async function requestRendition(sourceSha256: Buffer, ext: string, userId: number): Promise<void> {
  await tx(async (c) => {
    const claimed = await c.query(
      `INSERT INTO preview_renditions (source_sha256, converter_version, state)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (source_sha256, converter_version) DO UPDATE
          SET state = 'pending', error = NULL, updated_at = now()
        WHERE (preview_renditions.state = 'failed'  AND preview_renditions.updated_at < now() - interval '1 day')
           OR (preview_renditions.state = 'pending' AND preview_renditions.updated_at < now() - interval '30 minutes')
       RETURNING 1`,
      [sourceSha256, RENDITION_VERSION],
    )
    if (!claimed.rowCount) return
    // 엑셀(100)보다 앞에 둔다 — 사람이 화면을 보며 기다린다
    const job = await c.query<{ id: number }>(
      `INSERT INTO jobs (kind, payload, requested_by, priority, max_attempts)
       VALUES ('convert_preview', $1, $2, 50, 2) RETURNING id`,
      [JSON.stringify({ sourceSha: sourceSha256.toString('hex'), ext }), userId],
    )
    await c.query(
      'UPDATE preview_renditions SET job_id = $3 WHERE source_sha256 = $1 AND converter_version = $2',
      [sourceSha256, RENDITION_VERSION, job.rows[0]!.id],
    )
  })
}
