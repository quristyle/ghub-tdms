import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  DocumentDetail, DocumentListQuery, DocumentListResponse, ErrorResponse,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import * as svc from './service.js'

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
    schema: {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 200: DocumentDetail, 404: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params)
      return svc.detail(id)
    },
  })
}
