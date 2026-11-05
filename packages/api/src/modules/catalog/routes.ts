import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  CatalogHideResult, CatalogItem, CatalogListQuery, CatalogListResponse, CatalogNameRequest, ErrorResponse,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import * as svc from './service.js'
import type { CatalogTable } from './queries.js'

/**
 * 공사·업체 관리.
 *
 * 권한 트리에 항목이 없는 기능이라 로그인한 사람 누구나 쓴다(2026-08-12 CM 확정 정책 — 기존
 * 시스템도 반출하기 창의 ＋추가에서 누구나 공사를 만들고 숨겼다). 쓰기는 전부 감사에 남는다.
 */

const IdParam = z.object({ id: z.coerce.number().int() })

function register(app: FastifyInstance, table: CatalogTable, base: string, label: string) {
  const screen = `${label} 관리`

  defineRoute(app, {
    method: 'GET',
    url: base,
    access: AUTHENTICATED,
    schema: { querystring: CatalogListQuery, response: { 200: CatalogListResponse } },
    handler: async (req) => svc.list(table, CatalogListQuery.parse(req.query).includeHidden),
  })

  defineRoute(app, {
    method: 'POST',
    url: base,
    access: AUTHENTICATED,
    audit: { screen, action: `${label} 추가` },
    schema: { body: CatalogNameRequest, response: { 200: CatalogItem, 409: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const b = CatalogNameRequest.parse(req.body)
      const out = await svc.create(table, b.name)
      req.setAuditTarget(out.name, { id: out.id })
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: `${base}/:id`,
    access: AUTHENTICATED,
    audit: { screen, action: `${label}명 변경` },
    schema: {
      params: IdParam, body: CatalogNameRequest,
      response: { 200: CatalogItem, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = CatalogNameRequest.parse(req.body)
      const out = await svc.rename(table, id, b.name)
      req.setAuditTarget(out.item.name, { id, oldName: out.oldName })
      return out.item
    },
  })

  for (const [suffix, hidden, action] of [['hide', true, '숨김'], ['unhide', false, '숨김 해제']] as const) {
    defineRoute(app, {
      method: 'POST',
      url: `${base}/:id/${suffix}`,
      access: AUTHENTICATED,
      audit: { screen, action: `${label} ${action}` },
      schema: { params: IdParam, response: { 200: CatalogHideResult, 404: ErrorResponse } },
      handler: async (req) => {
        const { id } = IdParam.parse(req.params)
        const name = await svc.setHidden(table, id, hidden)
        req.setAuditTarget(name, { id })
        return { ok: true as const }
      },
    })
  }
}

export function registerCatalogRoutes(app: FastifyInstance): void {
  register(app, 'projects', '/projects', '공사')
  register(app, 'vendors', '/vendors', '업체')
}
