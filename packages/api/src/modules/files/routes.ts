import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { ErrorResponse } from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { mimeFor, sendBlob } from '../../core/files.js'
import * as q from './queries.js'

/**
 * 파일 내보내기.
 *
 * 앱은 권한 검사와 감사 기록만 하고 X-Accel-Redirect 로 넘긴다 — nginx 가 커널 sendfile 로
 * 직송하므로 6.5GB Zip 반출 중에도 이벤트 루프가 비어 있다.
 *
 * 기존 시스템은 PDF 인라인 열람을 감사에 남기지 않았다(S-07).
 * 여기서는 모든 파일 접근이 이 모듈을 지나고, 라우트의 audit 선언이 빠지면
 * 기동 시점 검증에서 서버가 뜨지 않으므로 누락이 구조적으로 불가능하다.
 */

const Params = z.object({ id: z.coerce.number().int() })
const Rendition = z.object({
  state: z.enum(['unsupported', 'pending', 'done', 'failed']),
  error: z.string().nullable(),
})

export function registerFileRoutes(app: FastifyInstance): void {
  // 브라우저 안에서 열어 보기 (PDF 뷰어가 쓴다)
  defineRoute(app, {
    method: 'GET',
    url: '/files/:id/view',
    access: AUTHENTICATED,
    audit: { screen: '자료 상세', action: '열람' },
    schema: { params: Params, response: { 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = Params.parse(req.params)
      const f = await q.findFileForDownload(id)
      if (!f) throw Errors.notFound('파일')
      req.setAuditTarget(f.displayName, { documentId: f.documentId, fileId: f.id, mode: 'inline' })
      return sendBlob(reply, {
        sha256: f.blobSha256,
        filename: f.displayName,
        contentType: mimeFor(f.fileExt),
        inline: true,
        byteSize: f.byteSize,
      })
    },
  })

  // 원본(DWG·DXF) 미리보기 상태. 없으면 워커에 변환을 맡긴다 — 화면은 done 이 될 때까지 다시 묻는다.
  // 파일을 내주지 않으므로 감사에 남기지 않는다(열람은 아래 /preview 가 남긴다).
  defineRoute(app, {
    method: 'GET',
    url: '/files/:id/rendition',
    access: AUTHENTICATED,
    schema: { params: Params, response: { 200: Rendition, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = Params.parse(req.params)
      const f = await q.findFileForDownload(id)
      if (!f) throw Errors.notFound('파일')
      const ext = f.fileExt.toLowerCase()
      if (!q.RENDITION_EXTS.has(ext)) {
        return { state: 'unsupported' as const, error: '이 형식은 미리보기를 지원하지 않습니다.' }
      }
      let r = await q.findRendition(f.blobSha256)
      if (!r || r.state !== 'done') {
        await q.requestRendition(f.blobSha256, ext, req.auth.user.id)
        r = await q.findRendition(f.blobSha256)
      }
      return { state: r?.state ?? 'pending', error: r?.state === 'failed' ? r.error : null }
    },
  })

  // 바꿔 둔 미리보기 PDF — PDF 뷰어가 연다
  defineRoute(app, {
    method: 'GET',
    url: '/files/:id/preview',
    access: AUTHENTICATED,
    audit: { screen: '자료 상세', action: '열람' },
    schema: { params: Params, response: { 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = Params.parse(req.params)
      const f = await q.findFileForDownload(id)
      if (!f) throw Errors.notFound('파일')
      const r = await q.findRendition(f.blobSha256)
      if (r?.state !== 'done' || !r.pdfSha256) throw Errors.notFound('미리보기')
      req.setAuditTarget(f.displayName, { documentId: f.documentId, fileId: f.id, mode: 'preview' })
      return sendBlob(reply, {
        sha256: r.pdfSha256,
        filename: `${f.displayName.replace(/\.[^.]+$/, '')}.pdf`,
        contentType: 'application/pdf',
        inline: true,
        byteSize: r.pdfByteSize ?? undefined,
      })
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/files/:id/download',
    access: AUTHENTICATED,
    audit: { screen: '자료 상세', action: '다운로드' },
    schema: { params: Params, response: { 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = Params.parse(req.params)
      const f = await q.findFileForDownload(id)
      if (!f) throw Errors.notFound('파일')
      req.setAuditTarget(f.displayName, { documentId: f.documentId, fileId: f.id, mode: 'download' })
      return sendBlob(reply, {
        sha256: f.blobSha256,
        filename: f.displayName,
        contentType: mimeFor(f.fileExt),
        byteSize: f.byteSize,
      })
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb/files/:id/download',
    access: AUTHENTICATED,
    audit: { screen: 'MDB 상세', action: '다운로드' },
    schema: { params: Params, response: { 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = Params.parse(req.params)
      const f = await q.findMdbFileForDownload(id)
      if (!f) throw Errors.notFound('파일')
      req.setAuditTarget(f.displayName, { mdbFileId: f.id })
      return sendBlob(reply, {
        sha256: f.blobSha256,
        filename: f.displayName,
        contentType: mimeFor(f.fileExt),
        byteSize: f.byteSize,
      })
    },
  })
}
