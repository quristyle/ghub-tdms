import { one } from '../../core/db.js'

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
