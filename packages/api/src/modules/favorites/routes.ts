import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ErrorResponse, FavoriteListResponse, FavoriteMarkupResponse,
  FavoriteSaveRequest, FavoriteSaveResult, FavoriteTargetResponse,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

/**
 * 마크업 보관.
 *
 * 뷰어(public/pdfjs/web/dms-favorite.js)가 직접 부르는 두 경로는 경로 모양을 바꾸면 안 된다:
 *   GET /api/favorites/resolve/target
 *   GET /api/favorites/:id/markup
 */

const IdParam = z.object({ id: z.coerce.number().int() })

export function registerFavoriteRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/favorites',
    access: AUTHENTICATED,
    schema: { response: { 200: FavoriteListResponse } },
    handler: async (req) => ({
      items: (await q.listMine(req.auth.user.id)).map((f) => ({
        ...f,
        docClass: f.docClass as never,
        updatedAt: f.updatedAt.toISOString(),
      })),
    }),
  })

  // 뷰어가 직접 부른다 — 경로 고정
  defineRoute(app, {
    method: 'GET',
    url: '/favorites/resolve/target',
    access: AUTHENTICATED,
    schema: {
      querystring: z.object({
        kind: z.enum(['TDB', 'MDB']),
        doc_id: z.coerce.number().int().optional(),
        file_id: z.coerce.number().int().optional(),
      }),
      response: { 200: FavoriteTargetResponse },
    },
    handler: async (req) => {
      const qp = z
        .object({
          kind: z.enum(['TDB', 'MDB']),
          doc_id: z.coerce.number().int().optional(),
          file_id: z.coerce.number().int().optional(),
        })
        .parse(req.query)
      const hit = await q.findTarget(
        req.auth.user.id, qp.kind, qp.doc_id ?? null, qp.file_id ?? null,
      )
      return { favoriteId: hit?.id ?? null, name: hit?.name ?? null }
    },
  })

  // 뷰어가 직접 부른다 — 응답 필드명(markup / original_markup)도 고정
  defineRoute(app, {
    method: 'GET',
    url: '/favorites/:id/markup',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: FavoriteMarkupResponse, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const row = await q.findMarkup(id, req.auth.user.id)
      if (!row) throw Errors.notFound('보관 내용')
      const m = (row.markup ?? {}) as { markup?: unknown[]; original_markup?: unknown[] }
      return { markup: m.markup ?? [], original_markup: m.original_markup ?? [] }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/favorites',
    access: AUTHENTICATED,
    audit: { screen: '자료 상세', action: '마크업 보관' },
    schema: { body: FavoriteSaveRequest, response: { 200: FavoriteSaveResult } },
    handler: async (req) => {
      const body = FavoriteSaveRequest.parse(req.body)
      const id = await q.upsert(req.auth.user.id, body)
      req.setAuditTarget(body.name, { favoriteId: id, overwrite: body.overwriteId !== null })
      return { id }
    },
  })

  defineRoute(app, {
    method: 'DELETE',
    url: '/favorites/:id',
    access: AUTHENTICATED,
    audit: { screen: '자료 상세', action: '마크업 보관 삭제' },
    schema: { params: IdParam, response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      await q.remove(id, req.auth.user.id)
      req.setAuditTarget(`보관 ${id}`)
      return { ok: true as const }
    },
  })
}
