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
