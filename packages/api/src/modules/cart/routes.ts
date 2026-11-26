import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  CartAddRequest,
  CartAddResponse,
  CartClearRequest,
  CartExportZipRequest,
  CartExportZipResponse,
  CartFolderCreateRequest,
  CartFolderListResponse,
  CartFolderMutationResult,
  CartFolderUpdateRequest,
  CartItemListQuery,
  CartItemListResponse,
  CartMoveRequest,
  CartMoveResponse,
  CartRemoveRequest,
  CartRemoveResponse,
  ErrorResponse,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'
import * as jobs from '../jobs/service.js'

const SCREEN = '반출대기함'
const IdParam = z.object({ id: z.coerce.number().int() })
const Ok = z.object({ ok: z.literal(true) })

function toFolder(r: q.CartFolderRow) {
  return {
    id: r.id,
    parentId: r.parentId,
    name: r.name,
    sortOrder: r.sortOrder,
    docCount: r.docCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function toCartItem(r: q.CartItemRow) {
  return {
    cartItemId: r.cartItemId,
    cartFolderId: r.cartFolderId,
    cartFolderName: r.cartFolderName,
    addedAt: r.addedAt.toISOString(),
    id: r.id,
    drawingNo: r.drawingNo,
    title: r.title,
    folderId: r.folderId,
    folderName: r.folderName,
    docType: r.docType,
    currentRev: r.currentRev,
    status: r.status as never,
    isIsometric: r.isIsometric,
    hasDwg: r.hasDwg,
    hasPdf: r.hasPdf,
    hasXlsx: r.hasXlsx,
    hasEtc: r.hasEtc,
    updatedAt: r.updatedAt.toISOString(),
    isModified: r.isModified,
    lentTo: r.lentTo,
    lentAt: r.lentAt ? r.lentAt.toISOString() : null,
  }
}

export function registerCartRoutes(app: FastifyInstance): void {
  // ── 폴더 목록 및 건수 ───────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/cart/folders',
    access: AUTHENTICATED,
    schema: { response: { 200: CartFolderListResponse } },
    handler: async (req) => {
      const [folders, counts] = await Promise.all([
        q.listCartFolders(req.auth.user.id),
        q.getCartCounts(req.auth.user.id),
      ])
      return {
        items: folders.map(toFolder),
        totalCount: counts.totalCount,
        rootCount: counts.rootCount,
      }
    },
  })

  // ── 새 폴더 만들기 ─────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/cart/folders',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '폴더 생성' },
    schema: {
      body: CartFolderCreateRequest,
      response: { 200: CartFolderMutationResult, 400: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = CartFolderCreateRequest.parse(req.body)
      const folder = await q.createCartFolder(req.auth.user.id, b.name, b.parentId)
      req.setAuditTarget(b.name, { folderId: folder.id, parentId: folder.parentId })
      return { ok: true as const, folder: toFolder(folder) }
    },
  })

  // ── 폴더 수정 (이름·위치) ──────────────────────────────────────────────
  defineRoute(app, {
    method: 'PATCH',
    url: '/cart/folders/:id',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '폴더 수정' },
    schema: {
      params: IdParam,
      body: CartFolderUpdateRequest,
      response: { 200: CartFolderMutationResult, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = CartFolderUpdateRequest.parse(req.body)
      const updated = await q.updateCartFolder(req.auth.user.id, id, b)
      if (!updated) throw Errors.notFound('대기함 폴더')
      req.setAuditTarget(updated.name, { folderId: id })
      return { ok: true as const, folder: toFolder(updated) }
    },
  })

  // ── 폴더 삭제 ──────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'DELETE',
    url: '/cart/folders/:id',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '폴더 삭제' },
    schema: { params: IdParam, response: { 200: Ok, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const ok = await q.deleteCartFolder(req.auth.user.id, id)
      if (!ok) throw Errors.notFound('대기함 폴더')
      req.setAuditTarget(`대기함 폴더 ${id}`, { folderId: id })
      return { ok: true as const }
    },
  })

  // ── 대기함 자료 목록 조회 ──────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/cart/items',
    access: AUTHENTICATED,
    schema: {
      querystring: CartItemListQuery,
      response: { 200: CartItemListResponse },
    },
    handler: async (req) => {
      const qp = CartItemListQuery.parse(req.query)
      const rows = await q.listCartItems(req.auth.user.id, qp.folderId, qp.q)
      return {
        items: rows.map(toCartItem),
        total: rows.length,
      }
    },
  })

  // ── 대기함에 자료 담기 (선택 반출 / 폴더 반출) ────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/cart/items',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '자료 추가' },
    schema: {
      body: CartAddRequest,
      response: { 200: CartAddResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = CartAddRequest.parse(req.body)
      const res = await q.addCartItems(req.auth.user.id, b.documentIds, b.folderId)
      req.setAuditTarget(`${b.documentIds.length}건 추가`, {
        count: b.documentIds.length,
        folderId: b.folderId,
      })
      return { ok: true as const, added: res.added, total: res.total }
    },
  })

  // ── 대기함 자료의 폴더 이동 ────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/cart/items/move',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '자료 이동' },
    schema: {
      body: CartMoveRequest,
      response: { 200: CartMoveResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = CartMoveRequest.parse(req.body)
      const moved = await q.moveCartItems(req.auth.user.id, b.documentIds, b.targetFolderId)
      req.setAuditTarget(`${moved}건 이동`, {
        moved,
        targetFolderId: b.targetFolderId,
      })
      return { ok: true as const, moved }
    },
  })

  // ── 대기함에서 선택 자료 삭제 ──────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/cart/items/remove',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '자료 제외' },
    schema: {
      body: CartRemoveRequest,
      response: { 200: CartRemoveResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = CartRemoveRequest.parse(req.body)
      const res = await q.removeCartItems(req.auth.user.id, b.documentIds)
      req.setAuditTarget(`${res.removed}건 제외`, { removed: res.removed })
      return { ok: true as const, removed: res.removed, total: res.total }
    },
  })

  // ── 대기함 비우기 ──────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/cart/clear',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '대기함 비우기' },
    schema: {
      body: CartClearRequest,
      response: { 200: Ok },
    },
    handler: async (req) => {
      const b = CartClearRequest.parse(req.body)
      const cleared = await q.clearCart(req.auth.user.id, b.folderId)
      req.setAuditTarget(`대기함 비우기 (${cleared}건)`, { cleared, folderId: b.folderId })
      return { ok: true as const }
    },
  })

  // ── 반출 자료 Zip 압축 요청 (비동기 워커 실행) ──────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/cart/export-zip',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '반출 자료 Zip 압축 요청' },
    schema: {
      body: CartExportZipRequest,
      response: { 202: CartExportZipResponse, 400: ErrorResponse, 401: ErrorResponse },
    },
    handler: async (req, reply) => {
      const b = CartExportZipRequest.parse(req.body)
      let docIds: number[] = []

      if (b.documentIds && b.documentIds.length > 0) {
        docIds = b.documentIds
      } else {
        docIds = await q.getCartDocumentIds(req.auth.user.id, b.folderId)
      }

      if (!docIds.length) {
        throw Errors.invalid('NO_DOCUMENTS', '압축할 자료가 없습니다.')
      }

      const now = new Date()
      const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const zipName = b.zipName?.trim() || `${stamp}_반출자료`

      const jobId = await jobs.create(
        'zip_build',
        {
          kind: 'TDB',
          zipName,
          documentIds: docIds,
          keepPaths: true,
          vendorName: '반출대기함',
        },
        req.auth.user.id,
      )

      req.setAuditTarget(zipName, { jobId, docCount: docIds.length })
      return reply.code(202).send({
        ok: true as const,
        jobId,
        zipName,
        count: docIds.length,
      })
    },
  })
}
