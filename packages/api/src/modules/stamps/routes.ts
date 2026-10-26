import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  CreateStampBody,
  ErrorResponse,
  StampItem,
  StampListResponse,
  UpdateStampBody,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import * as svc from './service.js'

export function registerStampRoutes(app: FastifyInstance): void {
  // 스탬프 목록 조회 — 미리보기 뷰어 및 스탬프 관리 화면 양쪽에서 사용
  defineRoute(app, {
    method: 'GET',
    url: '/stamps',
    access: AUTHENTICATED,
    schema: {
      querystring: z.object({
        all: z.coerce.boolean().optional(),
      }),
      response: { 200: StampListResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const q = req.query as { all?: boolean }
      return svc.listStamps(q.all ?? false)
    },
  })

  // 단일 스탬프 상세 조회
  defineRoute(app, {
    method: 'GET',
    url: '/stamps/:id',
    access: AUTHENTICATED,
    schema: {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 200: StampItem, 404: ErrorResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = req.params as { id: number }
      return svc.getStamp(id)
    },
  })

  // 스탬프 추가
  defineRoute(app, {
    method: 'POST',
    url: '/stamps',
    access: permission('screen.users.access'),
    audit: { screen: '스탬프 관리', action: '스탬프 등록' },
    schema: {
      body: CreateStampBody,
      response: { 200: StampItem, 400: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const body = CreateStampBody.parse(req.body)
      const stamp = await svc.createStamp(body, req.auth.user.id)
      req.setAuditTarget(stamp.name, { category: stamp.category, id: stamp.id })
      return stamp
    },
  })

  // 스탬프 수정
  defineRoute(app, {
    method: 'PUT',
    url: '/stamps/:id',
    access: permission('screen.users.access'),
    audit: { screen: '스탬프 관리', action: '스탬프 수정' },
    schema: {
      params: z.object({ id: z.coerce.number().int() }),
      body: UpdateStampBody,
      response: { 200: StampItem, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = req.params as { id: number }
      const body = UpdateStampBody.parse(req.body)
      const stamp = await svc.updateStamp(id, body, req.auth.user.id)
      req.setAuditTarget(stamp.name, { category: stamp.category, id: stamp.id })
      return stamp
    },
  })

  // 스탬프 삭제
  defineRoute(app, {
    method: 'DELETE',
    url: '/stamps/:id',
    access: permission('screen.users.access'),
    audit: { screen: '스탬프 관리', action: '스탬프 삭제' },
    schema: {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 200: z.object({ ok: z.boolean() }), 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = req.params as { id: number }
      const stamp = await svc.getStamp(id)
      await svc.deleteStamp(id)
      req.setAuditTarget(stamp.name, { id })
      return { ok: true }
    },
  })
}
