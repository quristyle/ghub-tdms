import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  DistributionListResponse, DocumentDetail, DocumentListQuery, DocumentListResponse,
  ErrorResponse, NoteRequest, NoteResult, RevisionListResponse,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import * as svc from './service.js'

const IdParam = z.object({ id: z.coerce.number().int() })
const RevParams = z.object({
  id: z.coerce.number().int(),
  rev: z.coerce.number().int(),
})

export function registerDocumentRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/documents',
    access: AUTHENTICATED,
    schema: {
      querystring: DocumentListQuery,
      response: { 200: DocumentListResponse, 401: ErrorResponse },
    },
    handler: async (req) => svc.list(DocumentListQuery.parse(req.query)),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/documents/:id',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: DocumentDetail, 404: ErrorResponse } },
    handler: async (req) => svc.detail(IdParam.parse(req.params).id),
  })

  // ── Revision 이력 탭 ────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/documents/:id/revisions',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: RevisionListResponse, 404: ErrorResponse } },
    handler: async (req) => svc.revisions(IdParam.parse(req.params).id),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/documents/:id/revisions/:rev/note',
    access: permission('common.note_edit.revision'),
    audit: { screen: '자료 상세', action: 'Revision 비고 작성' },
    schema: {
      params: RevParams,
      body: NoteRequest.extend({ branch: z.string().nullable().default(null) }),
      response: { 200: NoteResult, 403: ErrorResponse },
    },
    handler: async (req) => {
      const { id, rev } = RevParams.parse(req.params)
      const body = NoteRequest.extend({ branch: z.string().nullable().default(null) }).parse(req.body)
      await svc.setRevisionNote(id, rev, body.branch, body.note)
      req.setAuditTarget(`문서 ${id} Rev${rev}`, { note: body.note })
      return { ok: true as const }
    },
  })

  // ── 반출 이력 탭 ────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/documents/:id/distributions',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: DistributionListResponse, 404: ErrorResponse } },
    handler: async (req) => svc.distributions(IdParam.parse(req.params).id),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/distributions/:id/note',
    access: permission('common.note_edit.distribution'),
    audit: { screen: '반출 이력', action: '비고 작성' },
    schema: { params: IdParam, body: NoteRequest, response: { 200: NoteResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const body = NoteRequest.parse(req.body)
      await svc.setDistributionNote(id, body.note)
      req.setAuditTarget(`반출 ${id}`, { note: body.note })
      return { ok: true as const }
    },
  })

  // 상세 화면의 이전·다음 이동
  defineRoute(app, {
    method: 'GET',
    url: '/documents/:id/neighbors',
    access: AUTHENTICATED,
    schema: {
      params: IdParam,
      response: {
        200: z.object({ prevId: z.number().int().nullable(), nextId: z.number().int().nullable() }),
      },
    },
    handler: async (req) => svc.neighbors(IdParam.parse(req.params).id),
  })
}
