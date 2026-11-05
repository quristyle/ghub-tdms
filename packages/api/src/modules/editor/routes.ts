import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  ArchiveListResponse, ArchiveRequest, ArchiveResult, DocumentMoveRequest, DocumentMoveResult,
  DocumentRenameRequest, ErrorResponse, FolderCreateRequest, FolderMutationResult,
  FolderRenameRequest, FolderReparentRequest, NoteRequest, NoteResult,
  PairFolderCandidateResponse, PairFolderMergeRequest, PairFolderMergeResult,
  PurgeRequest, PurgeResult, RestoreResult,
  ExistingRevLookup, ExistingRevQuery, RegisterResult, ReplaceBulkResult, ReplaceResult,
  JobCreated, ZipRegisterCheck,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission, type TdmsRequest } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { tx } from '../../core/db.js'
import { registerBlob, storeStream } from '../../core/blob.js'
import * as jobs from '../jobs/service.js'
import * as svc from './service.js'
import * as up from './upload.js'

const SCREEN = 'TDB 관리'
const IdParam = z.object({ id: z.coerce.number().int() })

/**
 * multipart 본문을 읽는다 — 파일은 받는 대로 blob 으로 저장하고 필드는 모은다.
 * 같은 이름 필드가 여럿이면(documentIds) 배열로 모인다.
 */
async function readUpload(req: TdmsRequest, allowed: Set<string>) {
  const fields = new Map<string, string[]>()
  const files: up.Incoming[] = []
  for await (const part of req.parts()) {
    if (part.type === 'field') {
      const list = fields.get(part.fieldname) ?? []
      list.push(String(part.value))
      fields.set(part.fieldname, list)
      continue
    }
    const ext = (part.filename.split('.').pop() ?? '').toLowerCase()
    if (!allowed.has(ext)) {
      part.file.resume()
      throw Errors.invalid('EXT_NOT_ALLOWED', `받을 수 없는 형식입니다: .${ext}`)
    }
    // 스트림에 곁다리 리스너를 붙이지 않는다 (core/blob.ts 주석 참조)
    const stored = await storeStream(part.file, up.MAX_UPLOAD)
    up.assertUsable(stored, ext, part.filename)
    await tx((c) => registerBlob(c, stored))
    files.push(up.incomingOf(stored, part.filename))
  }
  const one = (k: string) => fields.get(k)?.[0] ?? ''
  const flag = (k: string) => ['true', '1', 'yes'].includes(one(k))
  const int = (k: string, dflt: number) => {
    const v = one(k)
    if (v === '') return dflt
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw Errors.invalid('BAD_FIELD', `${k} 값이 올바르지 않습니다.`)
    return n
  }
  const ints = (k: string) => (fields.get(k) ?? [])
    .flatMap((v) => v.split(','))
    .filter((v) => v.trim() !== '')
    .map((v) => {
      const n = Number(v)
      if (!Number.isInteger(n)) throw Errors.invalid('BAD_FIELD', `${k} 값이 올바르지 않습니다.`)
      return n
    })
  return { files, one, flag, int, ints }
}

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
      const out = await svc.createFolder('TDB', b.parentId, b.name, req.auth.user.id)
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
      response: { 200: FolderMutationResult, 403: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse },
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

  // ── 자료 교체 · 일괄 교체 ───────────────────────────────────────────
  // multipart: files[], keepRev(기본 true = "Rev 유지"), confirm* (확인창을 거친 뒤 다시 보낼 때)
  defineRoute(app, {
    method: 'POST',
    url: '/editor/documents/:id/replace',
    access: permission('screen.tdb_editor.document'),
    audit: { screen: SCREEN, action: '자료 교체' },
    schema: {
      params: IdParam,
      response: { 200: ReplaceResult, 403: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const u = await readUpload(req, up.ALLOWED)
      const keepRev = u.one('keepRev') === '' ? true : u.flag('keepRev')
      const out = await up.replaceOne(
        id, u.files, { keepRev, confirmDuplicates: u.flag('confirmDuplicates') }, req.auth.user.id,
      )
      req.setAuditTarget(`자료 ${id}`, {
        keepRev, rev: out.rev, files: u.files.map((f) => f.filename), needsConfirmation: out.needsConfirmation,
      })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/editor/documents/replace-bulk',
    access: permission('screen.tdb_editor.document'),
    audit: { screen: SCREEN, action: '일괄 자료 교체' },
    schema: { response: { 200: ReplaceBulkResult, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const u = await readUpload(req, up.ALLOWED)
      const ids = u.ints('documentIds')
      const keepRev = u.one('keepRev') === '' ? true : u.flag('keepRev')
      const out = await up.replaceBulk(ids, u.files, {
        keepRev,
        confirmDuplicates: u.flag('confirmDuplicates'),
        confirmMismatch: u.flag('confirmMismatch'),
        confirmPartial: u.flag('confirmPartial'),
      }, req.auth.user.id)
      req.setAuditTarget(`자료 ${ids.length}건`, {
        keepRev, replaced: out.replaced, files: u.files.length, needsConfirmation: out.needsConfirmation,
      })
      return out
    },
  })

  // ── 기존 Rev 조회 · 신규 자료 등록 ──────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/editor/documents/existing-rev',
    access: permission('screen.tdb_editor.document'),
    schema: { querystring: ExistingRevQuery, response: { 200: ExistingRevLookup, 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req) => {
      const qy = ExistingRevQuery.parse(req.query)
      return up.existingRev(qy.folderId, qy.stem)
    },
  })

  // multipart: folderId, rev(기본 0), files[], confirmDuplicates, confirmPartial
  defineRoute(app, {
    method: 'POST',
    url: '/editor/documents/register',
    access: permission('screen.tdb_editor.document'),
    audit: { screen: SCREEN, action: '신규 자료 등록' },
    schema: { response: { 200: RegisterResult, 403: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const u = await readUpload(req, up.ALLOWED)
      const folderId = u.int('folderId', -1)
      if (folderId < 0) throw Errors.invalid('NO_FOLDER', '등록할 폴더를 골라 주세요.')
      const rev = u.int('rev', 0)
      const out = await up.register(folderId, u.files, {
        rev, confirmDuplicates: u.flag('confirmDuplicates'), confirmPartial: u.flag('confirmPartial'),
      }, req.auth.user.id)
      req.setAuditTarget(`폴더 ${folderId}`, {
        rev, created: out.created, attached: out.attached, files: u.files.length,
        needsConfirmation: out.needsConfirmation,
      })
      return out
    },
  })

  // ── Zip 폴더 업로드 ─────────────────────────────────────────────────
  // Zip 안 폴더 구조가 선택한 폴더 아래 폴더가 되고, 파일은 자료가 된다(DWG+PDF 는 이름으로 짝).
  // 확인이 필요하면 200 {needsConfirmation, token}, 진행하면 202 {jobId} — 처리는 응답 뒤에 한다.
  // 반입(검수) 파이프라인인 /imports/zip 과는 다르다 — 이건 CM 이 직접 넣는 등록이다.
  defineRoute(app, {
    method: 'POST',
    url: '/editor/zip-register',
    access: permission('screen.tdb_editor.zip_register'),
    audit: { screen: SCREEN, action: 'Zip 폴더 업로드' },
    schema: {
      response: {
        200: ZipRegisterCheck, 202: JobCreated,
        403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const u = await readUpload(req, new Set(['zip']))
      const userId = req.auth.user.id
      const folderId = u.int('folderId', -1)
      if (folderId < 0) throw Errors.invalid('NO_FOLDER', 'Zip 을 넣을 폴더를 골라 주세요.')

      let zipBlob: { sha256: Buffer; filename: string }
      if (u.files.length) {
        if (u.files.length > 1) throw Errors.invalid('ONE_ZIP', 'Zip 파일은 한 번에 하나씩 올려 주세요.')
        zipBlob = { sha256: u.files[0]!.sha256, filename: u.files[0]!.filename }
      } else if (u.one('token')) {
        zipBlob = up.redeemTicket(u.one('token'), userId)
      } else {
        throw Errors.invalid('NO_FILE', '올릴 Zip 파일이 없습니다.')
      }

      const o: up.ZipRegisterOptions = {
        folderId,
        rev: u.int('rev', 0),
        confirmUnsafePaths: u.flag('confirmUnsafePaths'),
        confirmDuplicates: u.flag('confirmDuplicates'),
        confirmPartial: u.flag('confirmPartial'),
      }
      const { check, groups } = await up.zipCheck(zipBlob, o, userId)
      if (check) {
        req.setAuditTarget(zipBlob.filename, { folderId, needsConfirmation: true })
        return check
      }

      const jobId = await jobs.createRunning('zip_register', {
        sha256: zipBlob.sha256.toString('hex'), filename: zipBlob.filename, ...o,
      }, userId)
      req.setAuditTarget(zipBlob.filename, { folderId, rev: o.rev, jobId, groups })
      // 응답을 먼저 보내고 같은 프로세스에서 처리한다 (runZipRegister 는 예외를 던지지 않는다)
      setImmediate(() => { void up.runZipRegister(jobId, zipBlob, o, userId) })
      return reply.code(202).send({ jobId })
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

  // 묶음 다운로드 — 워커의 zip_build 로 넘긴다. 결과는 /jobs/:id/download 로 받는다.
  defineRoute(app, {
    method: 'POST',
    url: '/editor/trash/:id/download',
    access: permission('screen.tdb_editor.access'),
    audit: { screen: SCREEN, action: '삭제 보관함 다운로드' },
    schema: {
      params: IdParam,
      response: { 202: JobCreated, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req, reply) => {
      const { id } = IdParam.parse(req.params)
      const b = await svc.trashBatchForDownload(id)
      const jobId = await jobs.create('zip_build', { kind: 'TRASH', docClass: 'TDB', batchId: id }, req.auth.user.id)
      req.setAuditTarget(b.label, { batchId: id, jobId })
      return reply.code(202).send({ jobId })
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
