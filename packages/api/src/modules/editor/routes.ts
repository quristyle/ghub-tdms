import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ArchiveListResponse, ArchiveRequest, ArchiveResult, DocumentMoveRequest, DocumentMoveResult,
  DocumentRenameRequest, ErrorResponse, FolderCreateRequest, FolderMutationResult,
  FolderRenameRequest, FolderReparentRequest, NoteRequest, NoteResult,
  PairFolderCandidateResponse, PairFolderMergeRequest, PairFolderMergeResult,
  PurgeRequest, PurgeResult, RestoreResult,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import * as svc from './service.js'

const SCREEN = 'TDB 관리'
const IdParam = z.object({ id: z.coerce.number().int() })

export function registerEditorRoutes(app: FastifyInstance): void {
  // ── 폴더 편집 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/editor/folders',
    access: permission('screen.tdb_editor.folder'),
    audit: { screen: SCREEN, action: '폴더 만들기' },
    schema: {
      body: FolderCreateRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const b = FolderCreateRequest.parse(req.body)
      const out = await svc.createFolder(b.parentId, b.name, req.auth.user.id)
      req.setAuditTarget(b.name, { parentId: b.parentId, folderId: out.folderId })
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: '/editor/folders/:id',
    access: permission('screen.tdb_editor.folder'),
    audit: { screen: SCREEN, action: '폴더 이름 변경' },
    schema: {
      params: IdParam, body: FolderRenameRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = FolderRenameRequest.parse(req.body)
      const out = await svc.renameFolder(id, b.name)
      req.setAuditTarget(b.name, { folderId: id })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/folders/:id/move',
    access: permission('screen.tdb_editor.folder'),
    audit: { screen: SCREEN, action: '폴더 이동' },
    schema: {
      params: IdParam, body: FolderReparentRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = FolderReparentRequest.parse(req.body)
      const out = await svc.moveFolder(id, b.newParentId)
      req.setAuditTarget(`폴더 ${id}`, { newParentId: b.newParentId, affected: out.affectedFolders })
      return out
    },
  })

  // ── 자료 편집 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'PATCH',
    url: '/editor/documents/:id',
    access: permission('screen.tdb_editor.document'),
    audit: { screen: SCREEN, action: '자료 수정' },
    schema: {
      params: IdParam, body: DocumentRenameRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = DocumentRenameRequest.parse(req.body)
      const out = await svc.renameDocument(id, b)
      req.setAuditTarget(b.drawingNo ?? `자료 ${id}`, b as Record<string, unknown>)
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/documents/move',
    access: permission('screen.tdb_editor.document'),
    audit: { screen: SCREEN, action: '자료 이동' },
    schema: {
      body: DocumentMoveRequest,
      response: { 200: DocumentMoveResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const b = DocumentMoveRequest.parse(req.body)
      const out = await svc.moveDocuments(b.documentIds, b.targetFolderId)
      req.setAuditTarget(`${b.documentIds.length}건`, {
        targetFolderId: b.targetFolderId, moved: out.moved, skipped: out.skipped.length,
      })
      return out
    },
  })

  // ── 삭제 보관함 ──────────────────────────────────────────────────────
  // 오류 등으로 없애는 것. 폴더째 묶어 한 줄이고 완전 삭제까지 갈 수 있다.
  defineRoute(app, {
    method: 'POST',
    url: '/editor/trash',
    access: permission('screen.tdb_editor.restore'),
    audit: { screen: SCREEN, action: '삭제 보관함으로 보내기' },
    schema: { body: ArchiveRequest, response: { 200: ArchiveResult, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const b = ArchiveRequest.parse(req.body)
      const out = await svc.sendToTrash(b, req.auth.user.id)
      req.setAuditTarget(b.folderId !== null ? `폴더 ${b.folderId}` : `자료 ${b.documentIds.length}건`,
        { archived: out.archived, reason: b.reason })
      return out
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/editor/trash',
    access: permission('screen.tdb_editor.access'),
    schema: { response: { 200: ArchiveListResponse, 403: ErrorResponse } },
    handler: async () => svc.listBox('TRASH'),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/trash/restore',
    access: permission('screen.tdb_editor.restore'),
    audit: { screen: SCREEN, action: '삭제 보관함 복구' },
    schema: {
      body: z.object({ batchIds: z.array(z.number().int()).min(1).max(500) }),
      response: { 200: RestoreResult, 403: ErrorResponse },
    },
    handler: async (req) => {
      const b = z.object({ batchIds: z.array(z.number().int()).min(1).max(500) }).parse(req.body)
      const out = await svc.restore(b.batchIds, req.auth.user.id)
      req.setAuditTarget(`${b.batchIds.length}묶음`, { restored: out.restored, blocked: out.blocked.length })
      return out
    },
  })

  // 완전 삭제 — 되돌릴 수 없다. 삭제 보관함에만 있다.
  defineRoute(app, {
    method: 'POST',
    url: '/editor/trash/purge',
    access: permission('screen.tdb_editor.restore'),
    audit: { screen: SCREEN, action: '완전 삭제' },
    schema: { body: PurgeRequest, response: { 200: PurgeResult, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const b = PurgeRequest.parse(req.body)
      const out = await svc.purge(b.batchIds, req.auth.user.id)
      req.setAuditTarget(`${b.batchIds.length}묶음`, { purged: out.purged, freedBytes: out.freedBytes })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/trash/:id/note',
    access: permission('common.note_edit.tdb_trash'),
    audit: { screen: SCREEN, action: '삭제 보관함 비고 작성' },
    schema: { params: IdParam, body: NoteRequest, response: { 200: NoteResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = NoteRequest.parse(req.body)
      await svc.setNote(id, b.note)
      req.setAuditTarget(`묶음 ${id}`, { note: b.note })
      return { ok: true as const }
    },
  })

  // ── 폐기 보관함 ──────────────────────────────────────────────────────
  // 리비전이 진행되며 최신본에서 빠진 것. 자료 1건 = 이력 1건. 완전 삭제가 없다.
  defineRoute(app, {
    method: 'POST',
    url: '/editor/retired',
    access: permission('screen.tdb_editor.retire'),
    audit: { screen: SCREEN, action: '폐기 보관함으로 보내기' },
    schema: { body: ArchiveRequest, response: { 200: ArchiveResult, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const b = ArchiveRequest.parse(req.body)
      const out = await svc.retire(b.documentIds, b.reason, req.auth.user.id)
      req.setAuditTarget(`자료 ${b.documentIds.length}건`, { archived: out.archived, reason: b.reason })
      return out
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/editor/retired',
    access: permission('screen.tdb_editor.access'),
    schema: { response: { 200: ArchiveListResponse, 403: ErrorResponse } },
    handler: async () => svc.listBox('RETIRE'),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/retired/restore',
    access: permission('screen.tdb_editor.retire'),
    audit: { screen: SCREEN, action: '폐기 보관함 복구' },
    schema: {
      body: z.object({ batchIds: z.array(z.number().int()).min(1).max(500) }),
      response: { 200: RestoreResult, 403: ErrorResponse },
    },
    handler: async (req) => {
      const b = z.object({ batchIds: z.array(z.number().int()).min(1).max(500) }).parse(req.body)
      const out = await svc.restore(b.batchIds, req.auth.user.id)
      req.setAuditTarget(`${b.batchIds.length}건`, { restored: out.restored })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/retired/:id/note',
    access: permission('screen.tdb_editor.retire'),
    audit: { screen: SCREEN, action: '폐기 보관함 비고 작성' },
    schema: { params: IdParam, body: NoteRequest, response: { 200: NoteResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = NoteRequest.parse(req.body)
      await svc.setNote(id, b.note)
      req.setAuditTarget(`폐기 ${id}`, { note: b.note })
      return { ok: true as const }
    },
  })

  // ── 원본·사본 분리 폴더 병합 ─────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/editor/pair-folders/candidates',
    access: permission('screen.tdb_editor.access'),
    schema: { response: { 200: PairFolderCandidateResponse, 403: ErrorResponse } },
    handler: async () => svc.pairFolderCandidates(),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/pair-folders/merge',
    access: permission('screen.tdb_editor.folder'),
    audit: { screen: SCREEN, action: '원본·사본 폴더 병합' },
    schema: {
      body: PairFolderMergeRequest,
      response: { 200: PairFolderMergeResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const b = PairFolderMergeRequest.parse(req.body)
      const out = await svc.mergePairFolders(b.parentId, b.dwgFolderId, b.pdfFolderId)
      req.setAuditTarget(`폴더 ${b.parentId}`, { merged: out.merged })
      return out
    },
  })

  void AUTHENTICATED
}
