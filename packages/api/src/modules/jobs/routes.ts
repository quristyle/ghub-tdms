import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ErrorResponse, ExcelExportRequest, JobCreated, JobDetail,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { mimeFor, sendBlob } from '../../core/files.js'
import * as svc from './service.js'

/**
 * 장시간 작업.
 *
 *   POST /...../export   → 202 {jobId}       (즉시 응답)
 *   GET  /jobs/:id/stream → SSE 진행률
 *   GET  /jobs/:id/download → X-Accel-Redirect
 *
 * 진행률 UI(JobProgress.vue)는 하나를 만들어 엑셀·Zip·백업·변환에 전부 쓴다.
 */

const IdParam = z.object({ id: z.coerce.number().int() })

export function registerJobRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST',
    url: '/jobs/excel-export',
    access: AUTHENTICATED,
    audit: { screen: '공통', action: '엑셀 내보내기 요청' },
    schema: { body: ExcelExportRequest, response: { 202: JobCreated, 401: ErrorResponse } },
    handler: async (req, reply) => {
      const body = ExcelExportRequest.parse(req.body)
      const jobId = await svc.create('excel_export', body, req.auth.user.id)
      req.setAuditTarget(body.target, { jobId })
      return reply.code(202).send({ jobId })
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/jobs/:id',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: JobDetail, 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req) =>
      svc.detail(IdParam.parse(req.params).id, req.auth.user.id, req.auth.user.role === 'ADMIN'),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/jobs',
    access: AUTHENTICATED,
    schema: { response: { 200: z.object({ items: z.array(JobDetail) }) } },
    handler: async (req) => svc.mine(req.auth.user.id),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/jobs/:id/cancel',
    access: AUTHENTICATED,
    audit: { screen: '공통', action: '작업 취소' },
    schema: { params: IdParam, response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      await svc.cancel(id, req.auth.user.id)
      req.setAuditTarget(`작업 ${id}`)
      return { ok: true as const }
    },
  })

  // ── SSE 진행률 ──────────────────────────────────────────────────────
  // 폴링하지 않는다. 워커가 progress 를 갱신하고 NOTIFY 를 보내면 그때만 흘린다.
  // nginx 쪽은 proxy_buffering off 가 필요하다 (deploy/nginx.conf 에 있다).
  app.get<{ Params: { id: string } }>('/jobs/:id/stream', async (req, reply) => {
    const auth = (req as unknown as { auth?: { user: { id: number; role: string } } }).auth
    if (!auth) throw Errors.unauthorized()
    const id = Number(req.params.id)
    const isAdmin = auth.user.role === 'ADMIN'

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let closed = false
    req.raw.on('close', () => {
      closed = true
    })

    const send = (data: unknown) => {
      if (!closed) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // 작업이 끝날 때까지 1초 간격으로 상태를 확인한다.
    // (작업 1건당 최대 수십 회라 DB 부담이 없다. 완료되면 즉시 끊는다.)
    try {
      for (;;) {
        if (closed) break
        const j = await svc.detail(id, auth.user.id, isAdmin)
        send(j)
        if (j.state === 'done' || j.state === 'failed' || j.state === 'canceled') break
        await new Promise((r) => setTimeout(r, 1000))
      }
    } catch (e) {
      send({ state: 'failed', error: e instanceof Error ? e.message : '알 수 없는 오류' })
    } finally {
      if (!closed) reply.raw.end()
    }
  })

  // ── 결과 내려받기 ───────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/jobs/:id/download',
    access: AUTHENTICATED,
    audit: { screen: '공통', action: '작업 결과 내려받기' },
    schema: { params: IdParam, response: { 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = IdParam.parse(req.params)
      const j = await svc.raw(id, req.auth.user.id, req.auth.user.role === 'ADMIN')
      if (j.state !== 'done' || !j.result?.sha256 || !j.result.filename) {
        throw Errors.invalid('JOB_NOT_READY', '아직 결과가 없습니다.')
      }
      req.setAuditTarget(j.result.filename, { jobId: id })
      const ext = j.result.filename.split('.').pop() ?? 'bin'
      return sendBlob(reply, {
        sha256: Buffer.from(j.result.sha256, 'hex'),
        filename: j.result.filename,
        contentType: mimeFor(ext),
        byteSize: j.result.byteSize,
      })
    },
  })
}
