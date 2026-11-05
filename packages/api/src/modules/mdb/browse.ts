import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ErrorResponse, MdbIdsByFolderQuery, MdbIdsByFolderResponse, MdbNavQuery, MdbNavResponse,
  MdbRendition, MdbSourcesResponse,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { many, one } from '../../core/db.js'
import { sendBlob } from '../../core/files.js'
import * as folders from '../folders/service.js'
import * as fileQ from '../files/queries.js'

/**
 * MDB 조회·상세의 보조 창구.
 *
 *   GET /mdb/files/:id/view       PDF 인라인 열람 (뷰어가 연다 — 감사 기록)
 *   GET /mdb/files/:id/rendition  원본(DWG·DXF) 미리보기 상태
 *   GET /mdb/files/:id/preview    원본을 바꿔 둔 미리보기 PDF
 *   GET /mdb/:id/sources          원본/사본 짝 (D-102 전환 버튼)
 *   GET /mdb/nav                  상세의 [처음·이전·다음·끝]과 "n / 전체"
 *   GET /mdb/ids-by-folder        폴더 다운 — 폴더 안 자료 전부
 *
 * MDB 는 파일 한 개가 자료 한 건이다. 기존 시스템처럼 원본(DWG·엑셀)과 사본(PDF)이 함께
 * 있으면 **같은 폴더·같은 이름(확장자만 다름)** 인 두 줄로 들어오므로, 그 둘을 짝으로 본다.
 */

const SCREEN = 'MDB 상세'
const Params = z.object({ id: z.coerce.number().int() })

/** 확장자를 뗀 이름 — 원본/사본 짝을 찾는 열쇠 */
const BASE = (col: string) => `regexp_replace(${col}, '\\.[^.]*$', '')`

/**
 * 짝 파일을 찾는 SQL 조각 (alias m 기준, 결과 열: sib_id, sib_ext).
 * 사본(PDF)이면 원본을, 원본이면 PDF 를 찾는다. 원본 후보가 여럿이면 DWG·DXF 를 먼저.
 * favorites 모듈도 같은 규칙을 쓴다.
 */
export const SIBLING_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT s.id AS sib_id, s.file_ext AS sib_ext
      FROM mdb_files s
     WHERE s.folder_id = m.folder_id AND s.id <> m.id AND NOT s.is_archived
       AND ${BASE('s.display_name')} = ${BASE('m.display_name')}
       AND (lower(s.file_ext) = 'pdf') <> (lower(m.file_ext) = 'pdf')
     ORDER BY (lower(s.file_ext) IN ('dwg', 'dxf')) DESC, s.id
     LIMIT 1
  ) sib ON true`

interface MdbFileRow {
  id: number
  title: string
  displayName: string
  fileExt: string
  blobSha256: Buffer
  byteSize: number
  /** 삭제 보관함에 들어가 열 수 없다 (폐기는 연다 — 기존 D-62 ⑦) */
  trashed: boolean
  sibId: number | null
  sibExt: string | null
}

function findWithSibling(id: number) {
  return one<MdbFileRow>(
    `SELECT m.id, m.title,
            m.display_name AS "displayName",
            m.file_ext     AS "fileExt",
            m.blob_sha256  AS "blobSha256",
            b.byte_size    AS "byteSize",
            (m.is_archived AND coalesce(ab.kind, 'TRASH') = 'TRASH') AS trashed,
            sib.sib_id     AS "sibId",
            sib.sib_ext    AS "sibExt"
       FROM mdb_files m
       JOIN blobs b ON b.sha256 = m.blob_sha256
  LEFT JOIN archive_batches ab ON ab.id = m.archive_batch_id
       ${SIBLING_LATERAL}
      WHERE m.id = $1`,
    [id],
    'mdb_browse_with_sibling',
  )
}

const isPdf = (ext: string | null | undefined) => (ext ?? '').toLowerCase() === 'pdf'

/** 원본/사본 짝 — 화면의 전환 버튼과 보관(favorites)이 함께 쓴다 */
export async function sourcesOf(id: number) {
  const r = await findWithSibling(id)
  if (!r || r.trashed) return null
  const pdfId = isPdf(r.fileExt) ? r.id : isPdf(r.sibExt) ? r.sibId : null
  const original = !isPdf(r.fileExt)
    ? { id: r.id, ext: r.fileExt }
    : r.sibId !== null ? { id: r.sibId, ext: r.sibExt ?? '' } : null
  return {
    row: r,
    pdfId,
    originalId: original?.id ?? null,
    originalExt: original ? original.ext.toUpperCase() : null,
    originalPreviewable: !!original && fileQ.RENDITION_EXTS.has(original.ext.toLowerCase()),
    /** 보관·넘겨보기에서 이 자료를 가리키는 번호 — 사본이 있으면 사본, 없으면 원본 */
    repId: pdfId ?? original?.id ?? r.id,
  }
}

// ── 목록과 같은 거르기 (queries.ts 의 filters 와 같은 규칙) ──────────────

const SORT_SQL: Record<string, string> = {
  updatedAt:     'm.updated_at',
  title:         'm.title',
  equipmentType: 'm.equipment_type',
  docType:       'm.doc_type',
  year:          'm.year',
}

function navFilters(qp: MdbNavQuery, folderIds: number[], params: unknown[]): string[] {
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

async function nav(qp: MdbNavQuery) {
  const folderIds = await folders.scopeIds('MDB', qp.folderId, qp.recursive)
  const params: unknown[] = []
  const where = navFilters(qp, folderIds, params)
  const sortCol = SORT_SQL[qp.sort] ?? SORT_SQL.updatedAt!
  const desc = qp.dir === 'desc'
  const order = `${sortCol} ${desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}, m.id ${desc ? 'DESC' : 'ASC'}`
  params.push(qp.id ?? null, qp.pos ?? null)
  const idP = params.length - 1
  const posP = params.length

  const row = await one<{
    total: number; position: number | null; id: number | null
    firstId: number | null; prevId: number | null; nextId: number | null; lastId: number | null
  }>(
    `WITH r AS (
       SELECT m.id, row_number() OVER (ORDER BY ${order})::int AS pos
         FROM mdb_files m JOIN folders f ON f.id = m.folder_id
        WHERE ${where.join(' AND ')}
     ), t AS (SELECT count(*)::int AS total FROM r),
     me AS (
       SELECT CASE WHEN $${idP}::bigint IS NOT NULL
                   THEN (SELECT pos FROM r WHERE id = $${idP}::bigint)
                   ELSE least(greatest($${posP}::int, 1), (SELECT total FROM t)) END AS p
     )
     SELECT t.total, me.p AS position,
            (SELECT id FROM r WHERE pos = me.p)         AS id,
            (SELECT id FROM r WHERE pos = 1)            AS "firstId",
            (SELECT id FROM r WHERE pos = me.p - 1)     AS "prevId",
            (SELECT id FROM r WHERE pos = me.p + 1)     AS "nextId",
            (SELECT id FROM r WHERE pos = t.total)      AS "lastId"
       FROM t, me`,
    params,
  )
  return {
    total: row?.total ?? 0,
    position: row?.position && row.position > 0 ? row.position : null,
    id: row?.id ?? null,
    firstId: row?.firstId ?? null,
    prevId: row?.prevId ?? null,
    nextId: row?.nextId ?? null,
    lastId: row?.lastId ?? null,
  }
}

const CART_MAX = 5000

export function registerMdbBrowseRoutes(app: FastifyInstance): void {
  // ── 열람: 뷰어가 여는 PDF ──────────────────────────────────────────────
  // 원본(엑셀·DWG)인 자료여도 짝 PDF 가 있으면 그것을 연다 (기존 mdb.py view_file).
  defineRoute(app, {
    method: 'GET',
    url: '/mdb/files/:id/view',
    access: permission('screen.mdb_list.access'),
    audit: { screen: SCREEN, action: '열람' },
    schema: { params: Params, response: { 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = Params.parse(req.params)
      const r = await findWithSibling(id)
      if (!r || r.trashed) throw Errors.notFound('자료')
      let pdf: { id: number; sha: Buffer; size: number } | null = null
      if (isPdf(r.fileExt)) pdf = { id: r.id, sha: r.blobSha256, size: r.byteSize }
      else if (r.sibId !== null && isPdf(r.sibExt)) {
        const s = await fileQ.findMdbFileForDownload(r.sibId)
        if (s) pdf = { id: s.id, sha: s.blobSha256, size: s.byteSize }
      }
      if (!pdf) throw Errors.notFound('PDF 사본')
      req.setAuditTarget(r.title, { mdbFileId: pdf.id, mode: 'inline' })
      return sendBlob(reply, {
        sha256: pdf.sha,
        filename: `${r.title.replace(/\.pdf$/i, '')}.pdf`,
        contentType: 'application/pdf',
        inline: true,
        byteSize: pdf.size,
      })
    },
  })

  // ── 원본(DWG·DXF) 미리보기 — TDB 의 /files/:id/rendition 과 같은 기구 ──────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb/files/:id/rendition',
    access: permission('screen.mdb_list.access'),
    schema: { params: Params, response: { 200: MdbRendition, 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = Params.parse(req.params)
      const r = await findWithSibling(id)
      if (!r || r.trashed) throw Errors.notFound('자료')
      const ext = r.fileExt.toLowerCase()
      if (!fileQ.RENDITION_EXTS.has(ext)) {
        return { state: 'unsupported' as const, error: '이 형식은 미리보기를 지원하지 않습니다.' }
      }
      let rd = await fileQ.findRendition(r.blobSha256)
      if (!rd || rd.state !== 'done') {
        await fileQ.requestRendition(r.blobSha256, ext, req.auth.user.id)
        rd = await fileQ.findRendition(r.blobSha256)
      }
      return { state: rd?.state ?? 'pending', error: rd?.state === 'failed' ? rd.error : null }
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb/files/:id/preview',
    access: permission('screen.mdb_list.access'),
    audit: { screen: SCREEN, action: '열람' },
    schema: { params: Params, response: { 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = Params.parse(req.params)
      const r = await findWithSibling(id)
      if (!r || r.trashed) throw Errors.notFound('자료')
      const rd = await fileQ.findRendition(r.blobSha256)
      if (rd?.state !== 'done' || !rd.pdfSha256) throw Errors.notFound('미리보기')
      req.setAuditTarget(r.title, { mdbFileId: r.id, mode: 'preview' })
      return sendBlob(reply, {
        sha256: rd.pdfSha256,
        filename: `${r.displayName.replace(/\.[^.]+$/, '')}.pdf`,
        contentType: 'application/pdf',
        inline: true,
        byteSize: rd.pdfByteSize ?? undefined,
      })
    },
  })

  // ── 원본/사본 짝 ───────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb/:id/sources',
    access: AUTHENTICATED,
    schema: { params: Params, response: { 200: MdbSourcesResponse, 404: ErrorResponse } },
    handler: async (req) => {
      const s = await sourcesOf(Params.parse(req.params).id)
      if (!s) throw Errors.notFound('자료')
      return {
        pdfId: s.pdfId,
        originalId: s.originalId,
        originalExt: s.originalExt,
        originalPreviewable: s.originalPreviewable,
      }
    },
  })

  // ── 넘겨보기 ─────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb/nav',
    access: permission('screen.mdb_list.access'),
    schema: { querystring: MdbNavQuery, response: { 200: MdbNavResponse, 403: ErrorResponse } },
    handler: async (req) => nav(MdbNavQuery.parse(req.query)),
  })

  // ── 폴더 다운 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb/ids-by-folder',
    access: permission('screen.mdb_list.access'),
    schema: { querystring: MdbIdsByFolderQuery, response: { 200: MdbIdsByFolderResponse, 403: ErrorResponse } },
    handler: async (req) => {
      const qp = MdbIdsByFolderQuery.parse(req.query)
      const ids = await folders.scopeIds('MDB', qp.folderId, qp.recursive)
      const rows = await many<{ id: number; title: string; folderName: string; fileExt: string }>(
        `SELECT m.id, m.title, f.name AS "folderName", m.file_ext AS "fileExt"
           FROM mdb_files m JOIN folders f ON f.id = m.folder_id
          WHERE NOT m.is_archived AND m.folder_id = ANY($1::bigint[])
          ORDER BY f.path, m.title, m.id
          LIMIT $2`,
        [ids, CART_MAX + 1],
      )
      return { items: rows.slice(0, CART_MAX), truncated: rows.length > CART_MAX }
    },
  })
}
