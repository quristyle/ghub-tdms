import type { FastifyInstance } from 'fastify'
import { ErrorResponse, FolderTreeQuery, FolderTreeResponse } from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import * as svc from './service.js'

export function registerFolderRoutes(app: FastifyInstance): void {
  // 트리는 권한 트리에 없는 기능이라 로그인만 하면 열린다 (2026-08-12 CM 확정 정책).
  // 화면 접속 권한은 화면 라우트에서 따로 본다.
  defineRoute(app, {
    method: 'GET',
    url: '/folders',
    access: AUTHENTICATED,
    schema: {
      querystring: FolderTreeQuery,
      response: { 200: FolderTreeResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const qp = FolderTreeQuery.parse(req.query)
      return { items: await svc.tree(qp.docClass, qp.parentId, qp.expandTo) }
    },
  })
}
