import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ArchiveListResponse, ArchiveRequest, ArchiveResult, DocumentMoveResult, ErrorResponse,
  FolderCreateRequest, FolderMutationResult, FolderRenameRequest, FolderReparentRequest,
  MdbBulkEquipmentRequest, MdbBulkResult, MdbDetail, MdbListQuery, MdbListResponse,
  MdbMeta, MdbMoveRequest, MdbUpdateRequest, NoteRequest, NoteResult, PurgeRequest,
  PurgeResult, RestoreResult, TagApplyResult, TagHistoryCreateRequest,
  TagHistoryListResponse, TagRevertResult, TagSuggestResponse, TagTargetsResponse,
} from '@tdms/contracts'
import { JobCreated } from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import * as jobs from '../jobs/service.js'
import * as editor from '../editor/service.js'
import * as svc from './service.js'
import * as tags from './tagHistory.js'

const LIST = 'MDB 조회'
const EDIT = 'MDB 관리'
const IdParam = z.object({ id: z.coerce.number().int() })

export function registerMdbRoutes(app: FastifyInstance): void {
  // ── 조회 ─────────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb',
    access: permission('screen.mdb_list.access'),
    schema: { querystring: MdbListQuery, response: { 200: MdbListResponse, 403: ErrorResponse } },
    handler: async (req) => svc.list(MdbListQuery.parse(req.query)),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb/meta',
    access: permission('screen.mdb_list.access'),
    schema: { response: { 200: MdbMeta, 403: ErrorResponse } },
    handler: async () => svc.meta(),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb/tags/suggest',
    access: permission('screen.mdb_list.access'),
    schema: {
      querystring: z.object({ q: z.string().max(100).default('') }),
      response: { 200: TagSuggestResponse, 403: ErrorResponse },
    },
    handler: async (req) =>
      svc.suggestTags(z.object({ q: z.string().max(100).default('') }).parse(req.query).q),
  })

  // 다운대기함 — 고른 자료를 Zip 으로 묶는다. 묶는 일은 워커가 한다.
  defineRoute(app, {
    method: 'POST',
    url: '/mdb/download-zip',
    access: permission('screen.mdb_list.access'),
    audit: { screen: LIST, action: '다운로드 Zip 요청' },
    schema: {
      body: z.object({ fileIds: z.array(z.number().int()).min(1).max(5000) }),
      response: { 202: JobCreated, 403: ErrorResponse },
    },
    handler: async (req, reply) => {
      const b = z.object({ fileIds: z.array(z.number().int()).min(1).max(5000) }).parse(req.body)
      const jobId = await jobs.create('zip_build', { kind: 'MDB', fileIds: b.fileIds }, req.auth.user.id)
      req.setAuditTarget(`${b.fileIds.length}건`, { jobId })
      return reply.code(202).send({ jobId })
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb/:id',
    access: AUTHENTICATED,
    schema: { params: IdParam, response: { 200: MdbDetail, 404: ErrorResponse } },
    handler: async (req) => svc.detail(IdParam.parse(req.params).id),
  })

  // ── 관리: 폴더 (기구는 editor 와 공용, doc_class 만 다르다) ───────────
  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/folders',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: '폴더 만들기' },
    schema: {
      body: FolderCreateRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const b = FolderCreateRequest.parse(req.body)
      const out = await editor.createFolder('MDB', b.parentId, b.name, req.auth.user.id)
      req.setAuditTarget(b.name, { folderId: out.folderId })
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: '/mdb-editor/folders/:id',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: '폴더 이름 변경' },
    schema: {
      params: IdParam, body: FolderRenameRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = FolderRenameRequest.parse(req.body)
      const out = await editor.renameFolder(id, b.name)
      req.setAuditTarget(b.name, { folderId: id })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/folders/:id/move',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: '폴더 이동' },
    schema: {
      params: IdParam, body: FolderReparentRequest,
      response: { 200: FolderMutationResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = FolderReparentRequest.parse(req.body)
      const out = await editor.moveFolder(id, b.newParentId)
      req.setAuditTarget(`폴더 ${id}`, { affected: out.affectedFolders })
      return out
    },
  })

  // ── 관리: 자료 ───────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'PATCH',
    url: '/mdb-editor/files/:id',
    access: permission('screen.mdb_editor.document'),
    audit: { screen: EDIT, action: '자료 수정' },
    schema: {
      params: IdParam, body: MdbUpdateRequest,
      response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = MdbUpdateRequest.parse(req.body)
      await svc.update(id, b)
      req.setAuditTarget(b.title ?? `자료 ${id}`, b as Record<string, unknown>)
      return { ok: true as const }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/files/move',
    access: permission('screen.mdb_editor.document'),
    audit: { screen: EDIT, action: '자료 이동' },
    schema: {
      body: MdbMoveRequest,
      response: { 200: MdbBulkResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const b = MdbMoveRequest.parse(req.body)
      const out = await svc.move(b.fileIds, b.targetFolderId)
      req.setAuditTarget(`${b.fileIds.length}건`, { moved: out.updated, skipped: out.skipped.length })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/files/equipment-type',
    access: permission('screen.mdb_editor.document'),
    audit: { screen: EDIT, action: '설비유형 일괄 변경' },
    schema: { body: MdbBulkEquipmentRequest, response: { 200: MdbBulkResult, 403: ErrorResponse } },
    handler: async (req) => {
      const b = MdbBulkEquipmentRequest.parse(req.body)
      const out = await svc.bulkEquipmentType(b.fileIds, b.equipmentType)
      req.setAuditTarget(`${b.fileIds.length}건`, { equipmentType: b.equipmentType })
      return out
    },
  })

  // ── 관리: 보관함 2종 ─────────────────────────────────────────────────
  const boxes = [
    { kind: 'TRASH' as const, url: 'trash', perm: 'screen.mdb_editor.restore' as const, label: '삭제' },
    { kind: 'RETIRE' as const, url: 'retired', perm: 'screen.mdb_editor.retire' as const, label: '폐기' },
  ]

  for (const box of boxes) {
    defineRoute(app, {
      method: 'POST',
      url: `/mdb-editor/${box.url}`,
      access: permission(box.perm),
      audit: { screen: EDIT, action: `${box.label} 보관함으로 보내기` },
      schema: { body: ArchiveRequest, response: { 200: ArchiveResult, 403: ErrorResponse, 422: ErrorResponse } },
      handler: async (req) => {
        const b = ArchiveRequest.parse(req.body)
        const out = box.kind === 'TRASH'
          ? await svc.sendToTrash({ fileIds: b.documentIds, folderId: b.folderId, reason: b.reason }, req.auth.user.id)
          : await svc.retire(b.documentIds, b.reason, req.auth.user.id)
        req.setAuditTarget(
          b.folderId !== null ? `폴더 ${b.folderId}` : `자료 ${b.documentIds.length}건`,
          { archived: out.archived },
        )
        return out
      },
    })

    defineRoute(app, {
      method: 'GET',
      url: `/mdb-editor/${box.url}`,
      access: permission('screen.mdb_editor.access'),
      schema: { response: { 200: ArchiveListResponse, 403: ErrorResponse } },
      handler: async () => svc.listBox(box.kind),
    })

    defineRoute(app, {
      method: 'POST',
      url: `/mdb-editor/${box.url}/restore`,
      access: permission(box.perm),
      audit: { screen: EDIT, action: `${box.label} 보관함 복구` },
      schema: {
        body: z.object({ batchIds: z.array(z.number().int()).min(1).max(500) }),
        response: { 200: RestoreResult, 403: ErrorResponse },
      },
      handler: async (req) => {
        const b = z.object({ batchIds: z.array(z.number().int()).min(1).max(500) }).parse(req.body)
        const out = await svc.restore(b.batchIds, req.auth.user.id)
        req.setAuditTarget(`${b.batchIds.length}묶음`, { restored: out.restored })
        return out
      },
    })

    defineRoute(app, {
      method: 'POST',
      url: `/mdb-editor/${box.url}/:id/note`,
      access: permission(box.kind === 'TRASH' ? 'common.note_edit.mdb_trash' : box.perm),
      audit: { screen: EDIT, action: `${box.label} 보관함 비고 작성` },
      schema: { params: IdParam, body: NoteRequest, response: { 200: NoteResult, 403: ErrorResponse } },
      handler: async (req) => {
        const { id } = IdParam.parse(req.params)
        const b = NoteRequest.parse(req.body)
        await svc.setNote(id, b.note)
        req.setAuditTarget(`묶음 ${id}`, { note: b.note })
        return { ok: true as const }
      },
    })
  }

  // 완전 삭제는 삭제 보관함에만 있다 — 폐기는 이력을 찾으려고 남기는 자리다
  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/trash/purge',
    access: permission('screen.mdb_editor.restore'),
    audit: { screen: EDIT, action: '완전 삭제' },
    schema: { body: PurgeRequest, response: { 200: PurgeResult, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const b = PurgeRequest.parse(req.body)
      const out = await svc.purge(b.batchIds, req.auth.user.id)
      req.setAuditTarget(`${b.batchIds.length}묶음`, { purged: out.purged, freedBytes: out.freedBytes })
      return out
    },
  })

  // ── Tag 이력 ─────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb-tag-history',
    access: permission('screen.mdb_editor.access'),
    schema: { response: { 200: TagHistoryListResponse, 403: ErrorResponse } },
    handler: async () => tags.list(),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-tag-history',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: 'Tag 이력 등록' },
    schema: {
      body: TagHistoryCreateRequest,
      response: { 200: z.object({ id: z.number().int() }), 403: ErrorResponse },
    },
    handler: async (req) => {
      const b = TagHistoryCreateRequest.parse(req.body)
      const out = await tags.create(b, req.auth.user.id)
      req.setAuditTarget(`${b.baseTag} → ${b.newTag}`, { historyId: out.id })
      return out
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb-tag-history/:id/targets',
    access: permission('screen.mdb_editor.access'),
    schema: { params: IdParam, response: { 200: TagTargetsResponse, 403: ErrorResponse } },
    handler: async (req) => tags.targets(IdParam.parse(req.params).id),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-tag-history/:id/apply',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: 'Tag 이력 적용' },
    schema: {
      params: IdParam,
      response: { 200: TagApplyResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const out = await tags.apply(id)
      req.setAuditTarget(`Tag 이력 ${id}`, { applied: out.applied })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-tag-history/:id/revert',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: 'Tag 이력 되돌리기' },
    schema: {
      params: IdParam,
      response: { 200: TagRevertResult, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const out = await tags.revert(id)
      req.setAuditTarget(`Tag 이력 ${id}`, { reverted: out.reverted })
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: '/mdb-tag-history/:id',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: 'Tag 이력 비고 수정' },
    schema: { params: IdParam, body: NoteRequest, response: { 200: NoteResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = NoteRequest.parse(req.body)
      await tags.updateNote(id, b.note)
      req.setAuditTarget(`Tag 이력 ${id}`)
      return { ok: true as const }
    },
  })

  void DocumentMoveResult
}
