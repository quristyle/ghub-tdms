import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ErrorResponse, FAVORITE_LIMIT, FavoriteCountResponse, FavoriteDeleteRequest, FavoriteDeleteResult,
  FavoriteItem, FavoriteListResponse, FavoriteMarkupResponse, FavoriteNoteRequest,
  FavoriteSaveRequest, FavoriteSaveResult, FavoriteTargetQuery, FavoriteTargetResponse,
  type FavoriteSlot,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { sourcesOf } from '../mdb/browse.js'
import * as q from './queries.js'

/**
 * 사용자 보관 목록 (기존 favorites.py).
 *
 * 보관하는 것은 자료의 사본이 아니라 **자료로 가는 바로가기 + 미리보기에서 그린 편집 내용**이다.
 * 그래서 이 표만은 본인이 지울 수 있다 — 자료·파일·이력은 하나도 건드리지 않는다.
 * 로그인만 하면 누구나 자기 것을 보관하고 볼 수 있고, 남의 것은 어떤 방법으로도 보이지 않는다.
 *
 * 뷰어(public/pdfjs/web/dms-favorite.js)가 직접 부르는 두 경로는 모양을 바꾸면 안 된다:
 *   GET /api/favorites/resolve/target   (응답 필드는 snake_case 그대로)
 *   GET /api/favorites/:id/markup
 */

const SCREEN = '보관 목록'
const IdParam = z.object({ id: z.coerce.number().int() })
const Ok = z.object({ ok: z.literal(true) })

/** 편집 내용 한 건의 상한 — 도장을 여러 개 찍으면 그림이 통째로 담겨 커진다 */
const MAX_MARKUP_BYTES = 8 * 1024 * 1024

function toItem(r: q.FavoriteRow) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    note: r.note,
    hasMarkup: r.hasMarkup,
    documentId: r.documentId,
    mdbFileId: r.mdbFileId,
    currentName: r.missing ? null : r.currentName,
    path: r.path,
    pdfFileId: r.missing ? null : r.pdfFileId,
    missing: r.missing,
    // 보관할 때의 자료명과 지금 자료명이 다르면 알린다 (옛 보관분처럼 값이 없으면 견주지 않는다)
    renamed: !r.missing && !!r.sourceName && !!r.currentName && r.sourceName !== r.currentName,
    viewMode: r.viewMode === 'original' ? ('original' as const) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

interface Target {
  kind: 'TDB' | 'MDB'
  document_id: number | null
  mdb_file_id: number | null
  name: string
  pdf_file_id: number | null
}

/** 보관 팝업 "보관 위치" 표의 한 줄 — 목록 팝업 표와 같은 뜻의 값만 담는다 */
function toSlot(r: q.FavoriteRow, t: Target): FavoriteSlot {
  const it = toItem(r)
  return {
    id: it.id,
    name: it.name,
    kind: it.kind,
    has_markup: it.hasMarkup,
    description: it.note,
    target_name: it.currentName,
    missing: it.missing,
    updated_at: it.updatedAt,
    pdf_file_id: it.pdfFileId,
    path: it.path,
    document_id: it.documentId,
    mdb_file_id: it.mdbFileId,
    view_mode: it.viewMode,
    same: t.kind === 'TDB' ? it.kind === 'TDB' && it.documentId === t.document_id
                           : it.kind === 'MDB' && it.mdbFileId === t.mdb_file_id,
  }
}

/** 뷰어가 들고 있는 파일 번호만으로 자료를 찾는다 (화면이 실어 둔 값은 믿지 않는다) */
async function resolveTarget(qp: z.infer<typeof FavoriteTargetQuery>): Promise<Target> {
  const fileId = qp.pdf_file_id ?? qp.original_file_id
  if (fileId === undefined) throw Errors.invalid('NO_FILE', '어느 파일인지 알 수 없습니다.')
  if (qp.kind === 'TDB') {
    const t = await q.tdbTargetOfFile(fileId)
    if (!t || t.missing) throw Errors.notFound('자료')
    return {
      kind: 'TDB', document_id: t.documentId, mdb_file_id: null, name: t.name,
      pdf_file_id: qp.pdf_file_id ?? t.pdfFileId,
    }
  }
  // MDB 는 원본·사본 어느 쪽을 보고 있든 같은 자료 — 가리키는 번호는 언제나 대표(사본 우선)다
  const s = await sourcesOf(fileId)
  if (!s) throw Errors.notFound('자료')
  const rep = s.repId === s.row.id ? s.row.title : (await q.mdbAlive(s.repId))?.name ?? s.row.title
  return { kind: 'MDB', document_id: null, mdb_file_id: s.repId, name: rep, pdf_file_id: s.pdfId }
}

export function registerFavoriteRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/favorites',
    access: AUTHENTICATED,
    schema: { response: { 200: FavoriteListResponse } },
    handler: async (req) => {
      const items = (await q.listMine(req.auth.user.id)).map(toItem)
      return { items, count: items.length, limit: FAVORITE_LIMIT }
    },
  })

  // 상단 [보관 (N)] 버튼 — 목록 전체를 받지 않도록 따로 둔다
  defineRoute(app, {
    method: 'GET',
    url: '/favorites/summary',
    access: AUTHENTICATED,
    schema: { response: { 200: FavoriteCountResponse } },
    handler: async (req) => ({ count: await q.countMine(req.auth.user.id), limit: FAVORITE_LIMIT }),
  })

  // 뷰어가 직접 부른다 — 경로·응답 필드 고정
  defineRoute(app, {
    method: 'GET',
    url: '/favorites/resolve/target',
    access: AUTHENTICATED,
    schema: {
      querystring: FavoriteTargetQuery,
      response: { 200: FavoriteTargetResponse, 404: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const target = await resolveTarget(FavoriteTargetQuery.parse(req.query))
      // 보관 위치 표에는 보관해 둔 것 **전부**를 담는다 (다른 자료 것까지 — 기존 CM 지시)
      const all = (await q.listMine(req.auth.user.id)).map((r) => toSlot(r, target))
      return {
        ...target,
        all_saved: all,
        saved: all.filter((s) => s.same),
        used: all.length,
        limit: FAVORITE_LIMIT,
      }
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/favorites/:id',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: FavoriteItem, 404: ErrorResponse } },
    handler: async (req) => {
      const row = await q.findMine(IdParam.parse(req.params).id, req.auth.user.id)
      // 남의 것은 있는지조차 알려주지 않는다
      if (!row) throw Errors.notFound('보관한 자료')
      return toItem(row)
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
      const m = (row.markup ?? {}) as { markup?: unknown; original_markup?: unknown }
      return {
        markup: Array.isArray(m.markup) ? m.markup : [],
        original_markup: Array.isArray(m.original_markup) ? m.original_markup : [],
      }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/favorites',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '보관' },
    schema: {
      body: FavoriteSaveRequest,
      response: { 200: FavoriteSaveResult, 404: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = FavoriteSaveRequest.parse(req.body)
      const userId = req.auth.user.id

      // 가리키는 자료가 실제로 있는지 — 없어진 자료를 보관해 두면 열 수 없다
      const alive = b.docClass === 'TDB'
        ? (b.documentId !== null ? await q.tdbAlive(b.documentId) : undefined)
        : (b.mdbFileId !== null ? await q.mdbAlive(b.mdbFileId) : undefined)
      if (!alive) throw Errors.notFound('보관하려는 자료')

      if (b.overwriteId === null) {
        const used = await q.countMine(userId)
        if (used >= FAVORITE_LIMIT) {
          throw Errors.invalid(
            'FAVORITE_LIMIT',
            `보관은 ${FAVORITE_LIMIT}개까지 할 수 있습니다(지금 ${used}개). 목록에서 쓰지 않는 것을 지우거나, 덮어쓸 자리를 골라 주세요.`,
          )
        }
      }

      const payload = JSON.stringify({
        markup: b.markup,
        original_markup: b.originalMarkup,
        // 보관할 때의 자료명 — 화면이 안 보내면 지금 자료명을 적어 둔다("이름 바뀜" 판단용)
        source_name: b.sourceName?.trim() || alive.name,
        view_mode: b.viewMode,
        pdf_file_id: b.pdfFileId,
      })
      if (Buffer.byteLength(payload, 'utf8') > MAX_MARKUP_BYTES) {
        throw Errors.invalid(
          'MARKUP_TOO_LARGE',
          `편집 내용이 너무 많아 보관할 수 없습니다(최대 ${MAX_MARKUP_BYTES / 1024 / 1024}MB). 표시를 줄이거나, 미리보기에서 [다운로드]로 받아 두세요.`,
        )
      }

      const id = await q.save(userId, {
        kind: b.docClass,
        documentId: b.docClass === 'TDB' ? b.documentId : null,
        mdbFileId: b.docClass === 'MDB' ? b.mdbFileId : null,
        name: b.name.trim(),
        note: b.note?.trim() || null,
        payload,
        overwriteId: b.overwriteId,
      })
      if (id === null) throw Errors.notFound('덮어쓸 보관 자리')
      req.setAuditTarget(b.name, {
        favoriteId: id, kind: b.docClass, overwrite: b.overwriteId !== null,
        hasMarkup: b.markup.length + b.originalMarkup.length > 0,
      })
      return { id }
    },
  })

  // 설명(비고)만 고친다 — 이름은 보관할 때 그대로 둔다 (기존 CM 확정)
  defineRoute(app, {
    method: 'POST',
    url: '/favorites/:id/note',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '설명 수정' },
    schema: { params: IdParam, body: FavoriteNoteRequest, response: { 200: Ok, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = FavoriteNoteRequest.parse(req.body)
      const ok = await q.setNote(id, req.auth.user.id, b.note?.trim() || null)
      if (!ok) throw Errors.notFound('보관한 자료')
      req.setAuditTarget(`보관 ${id}`)
      return { ok: true as const }
    },
  })

  // [선택 삭제] — 자기 것만. 자료는 그대로 남는다.
  defineRoute(app, {
    method: 'POST',
    url: '/favorites/delete',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '삭제' },
    schema: { body: FavoriteDeleteRequest, response: { 200: FavoriteDeleteResult } },
    handler: async (req) => {
      const b = FavoriteDeleteRequest.parse(req.body)
      const gone = await q.removeMany(b.ids, req.auth.user.id)
      req.setAuditTarget(gone.map((g) => g.name).join(', ').slice(0, 300) || `${b.ids.length}건`, {
        favoriteIds: gone.map((g) => g.id),
      })
      return { deleted: gone.length }
    },
  })

  defineRoute(app, {
    method: 'DELETE',
    url: '/favorites/:id',
    access: AUTHENTICATED,
    audit: { screen: SCREEN, action: '삭제' },
    schema: { params: IdParam, response: { 200: Ok, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const gone = await q.removeMany([id], req.auth.user.id)
      if (!gone.length) throw Errors.notFound('보관한 자료')
      req.setAuditTarget(gone[0]!.name, { favoriteId: id })
      return { ok: true as const }
    },
  })
}
