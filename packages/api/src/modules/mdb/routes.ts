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
import {
  JobCreated, MdbPairCandidateResponse, MdbPairMergeRequest, MdbPairMergeResult,
  MdbRegisterResult, MdbReplaceResult, MdbUnclassifiedQuery, MdbUnclassifiedResponse,
  TagHistoryMeta, TagHistoryUpdateRequest, TagPreviewQuery, TagProjectFolderResponse,
} from '@tdms/contracts'
import { unlink } from 'node:fs/promises'
import { Errors } from '../../core/errors.js'
import { PayloadTooLargeError, registerBlob, storeStream } from '../../core/blob.js'
import { tx } from '../../core/db.js'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import * as jobs from '../jobs/service.js'
import * as editor from '../editor/service.js'
import * as svc from './service.js'
import * as tags from './tagHistory.js'
import * as pairs from './pairs.js'
import * as reg from './register.js'
import * as zip from './zipRegister.js'
import { BLOCKED_EXT, fileExtOf } from './grouping.js'
import { registerTypeListRoutes } from './typeLists.js'

const LIST = 'MDB 조회'
const EDIT = 'MDB 관리'
const IdParam = z.object({ id: z.coerce.number().int() })

/** 낱개 파일 업로드 상한 — nginx client_max_body_size 와 맞춘다 */
const MAX_FILE = 2 * 1024 * 1024 * 1024

const optId = (v: unknown): number | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isInteger(n)) throw Errors.invalid('BAD_FOLDER', '폴더 번호가 올바르지 않습니다.')
  return n
}
const truthy = (v: unknown) => ['true', '1', 'on'].includes(String(v ?? '').toLowerCase())
/** 브라우저가 경로째 보내는 경우가 있어 마지막 조각만 쓴다 */
const baseName = (f: string) => f.split('/').pop()!.split('\\').pop()!

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

  // ── 관리: 자료 등록 (신규추가) ────────────────────────────────────────
  // multipart 라 응답 스키마만 선언하고 본문은 직접 읽는다. 필드(targetFolderId,
  // confirmDuplicates)를 파일보다 먼저 보내야 한다.
  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/register',
    access: permission('screen.mdb_editor.document'),
    audit: { screen: EDIT, action: '자료 등록 (신규추가)' },
    schema: {
      response: {
        200: MdbRegisterResult, 403: ErrorResponse, 404: ErrorResponse, 413: ErrorResponse, 422: ErrorResponse,
      },
    },
    handler: async (req) => {
      let targetFolderId: number | null = null
      let confirm = false
      const entries: reg.RegisterEntry[] = []
      const skipped: string[] = []

      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'targetFolderId') targetFolderId = optId(part.value)
          if (part.fieldname === 'confirmDuplicates') confirm = truthy(part.value)
          continue
        }
        const filename = baseName(part.filename)
        const ext = fileExtOf(filename)
        if (BLOCKED_EXT.has(ext)) {
          part.file.resume()
          skipped.push(`${filename} (받지 않는 형식 .${ext})`)
          continue
        }
        const stored = await storeStream(part.file, MAX_FILE)
        const bad = reg.unusableReason(stored, ext)
        if (bad) { skipped.push(`${filename} (${bad})`); continue }
        await tx((c) => registerBlob(c, stored))
        entries.push({
          folder: '', pairing: null, filename, ext,
          data: { sha256: stored.sha256, byteSize: stored.byteSize },
        })
      }
      if (targetFolderId === null) throw Errors.invalid('FOLDER_REQUIRED', '등록할 폴더를 고르세요.')
      if (!entries.length && !skipped.length) throw Errors.invalid('NO_FILE', '올릴 파일이 없습니다.')
      await reg.assertTargetFolder(null, targetFolderId)

      const duplicates = reg.checkDuplicates(entries)
      if (duplicates.length && !confirm) {
        req.setAuditTarget(`폴더 ${targetFolderId}`, { needsConfirmation: true })
        return { created: 0, attached: 0, skipped, needsConfirmation: true, duplicates }
      }
      const out = await reg.storeEntries(targetFolderId, entries, req.auth.user.id)
      const all = [...skipped, ...out.skipped]
      req.setAuditTarget(`폴더 ${targetFolderId}`, {
        created: out.created, attached: out.attached, skipped: all.slice(0, 50),
      })
      return { created: out.created, attached: out.attached, skipped: all, needsConfirmation: false, duplicates: [] }
    },
  })

  // ── 관리: Zip 폴더 업로드 ────────────────────────────────────────────
  // 이름 목록 점검(Zip 폭탄·경로·같은 이름 같은 형식)은 요청 안에서, 압축 풀기·등록은
  // 202 로 답한 뒤 API 안에서 한다. 같은 이름·같은 형식이 있으면 200 으로 확인을 먼저 받는다.
  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/zip-register',
    access: permission('screen.mdb_editor.zip_register'),
    audit: { screen: EDIT, action: 'Zip 폴더 업로드' },
    schema: {
      response: {
        200: MdbRegisterResult, 202: JobCreated,
        403: ErrorResponse, 404: ErrorResponse, 413: ErrorResponse, 422: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const part = await req.file()
      if (!part) throw Errors.invalid('NO_FILE', '올릴 Zip 파일이 없습니다.')
      if (!part.filename.toLowerCase().endsWith('.zip')) {
        part.file.resume()
        throw Errors.invalid('EXT_NOT_ALLOWED', 'Zip 파일만 올릴 수 있습니다.')
      }
      const fields = part.fields as Record<string, { value?: unknown } | undefined>
      const targetFolderId = optId(fields.targetFolderId?.value)
      const confirm = truthy(fields.confirmDuplicates?.value)

      let path: string
      try {
        path = await zip.saveTemp(part.file, zip.MAX_ZIP_UPLOAD)
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw Errors.invalid('TOO_LARGE', e.message)
        throw e
      }

      let handedOver = false
      try {
        await reg.assertTargetFolder(null, targetFolderId)
        let scan: Awaited<ReturnType<typeof zip.scanZip>>
        try {
          scan = await zip.scanZip(path)
        } catch (e) {
          if (e instanceof zip.ZipRejected) throw Errors.invalid('ZIP_REJECTED', e.message)
          throw e
        }
        if (!scan.items.length) throw Errors.invalid('EMPTY_ZIP', 'Zip 안에 등록할 파일이 없습니다.')

        const duplicates = zip.preflight(scan.items)
        if (duplicates.length && !confirm) {
          req.setAuditTarget(part.filename, { needsConfirmation: true, targetFolderId })
          return reply.code(200).send({
            created: 0, attached: 0, skipped: scan.skipped, needsConfirmation: true, duplicates,
          })
        }

        const userId = req.auth.user.id
        const jobId = await jobs.createRunning(
          'mdb_zip_register',
          { filename: part.filename, targetFolderId, files: scan.items.length },
          userId,
        )
        handedOver = true
        // 응답을 먼저 보내고 처리한다 — 결과·오류는 jobs 표에 남는다 (runZipJob 은 throw 하지 않는다)
        const items = scan.items
        const scanSkipped = scan.skipped
        setImmediate(() => {
          void zip.runZipJob({ jobId, path, items, scanSkipped, targetFolderId, userId })
        })
        req.setAuditTarget(part.filename, { jobId, targetFolderId, files: items.length })
        return reply.code(202).send({ jobId })
      } finally {
        if (!handedOver) await unlink(path).catch(() => {})
      }
    },
  })

  // ── 관리: 파일 교체 ──────────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/files/:id/replace',
    access: permission('screen.mdb_editor.document'),
    audit: { screen: EDIT, action: '자료 교체' },
    schema: {
      params: IdParam,
      response: {
        200: MdbReplaceResult, 403: ErrorResponse, 404: ErrorResponse, 413: ErrorResponse, 422: ErrorResponse,
      },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const part = await req.file()
      if (!part) throw Errors.invalid('NO_FILE', '교체할 파일이 없습니다.')
      const ext = fileExtOf(baseName(part.filename))
      if (BLOCKED_EXT.has(ext)) {
        part.file.resume()
        throw Errors.invalid('EXT_NOT_ALLOWED', `받을 수 없는 형식입니다: .${ext}`)
      }
      const stored = await storeStream(part.file, MAX_FILE)
      const bad = reg.unusableReason(stored, ext)
      if (bad) throw Errors.invalid('UNUSABLE_FILE', `${bad}: ${part.filename}`)
      await tx((c) => registerBlob(c, stored))
      const out = await reg.replaceFile(id, { sha256: stored.sha256, byteSize: stored.byteSize }, ext, req.auth.user.id)
      req.setAuditTarget(out.title, { fileId: out.fileId, ext, added: out.added })
      return { fileId: out.fileId, added: out.added, message: out.message }
    },
  })

  // ── 관리: 미분류 자료 정리 ───────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb-editor/unclassified',
    access: permission('screen.mdb_editor.access'),
    schema: { querystring: MdbUnclassifiedQuery, response: { 200: MdbUnclassifiedResponse, 403: ErrorResponse } },
    handler: async (req) => svc.unclassified(MdbUnclassifiedQuery.parse(req.query)),
  })

  // ── 관리: 원본·사본(DWG·PDF) 폴더 병합 ───────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/mdb-editor/pair-folders/candidates',
    access: permission('screen.mdb_editor.tag'),
    schema: { response: { 200: MdbPairCandidateResponse, 403: ErrorResponse } },
    handler: async () => pairs.candidates(),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/pair-folders/merge',
    access: permission('screen.mdb_editor.tag'),
    audit: { screen: EDIT, action: '원본·사본 폴더 병합' },
    schema: { body: MdbPairMergeRequest, response: { 200: MdbPairMergeResult, 403: ErrorResponse } },
    handler: async (req) => {
      const b = MdbPairMergeRequest.parse(req.body)
      const out = await pairs.merge(b.parentIds)
      req.setAuditTarget(`폴더 ${b.parentIds.length}곳`, {
        parentIds: b.parentIds, merged: out.merged, skipped: out.skipped.length,
      })
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

  // 삭제 보관함 묶음 하나를 Zip 으로 받는다. 묶는 일은 워커(zip_build)가 한다.
  defineRoute(app, {
    method: 'POST',
    url: '/mdb-editor/trash/:id/download-zip',
    access: permission('screen.mdb_editor.restore'),
    audit: { screen: EDIT, action: '삭제 보관함 다운로드 요청' },
    schema: { params: IdParam, response: { 202: JobCreated, 403: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = IdParam.parse(req.params)
      const jobId = await jobs.create('zip_build', { kind: 'TRASH', docClass: 'MDB', batchId: id }, req.auth.user.id)
      req.setAuditTarget(`묶음 ${id}`, { jobId })
      return reply.code(202).send({ jobId })
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
    method: 'GET',
    url: '/mdb-tag-history/meta',
    access: permission('screen.mdb_editor.access'),
    schema: { response: { 200: TagHistoryMeta, 403: ErrorResponse } },
    handler: async () => tags.meta(),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/mdb-tag-history/project-folders',
    access: permission('screen.mdb_editor.access'),
    schema: { response: { 200: TagProjectFolderResponse, 403: ErrorResponse } },
    handler: async () => tags.projectFolders(),
  })

  // 등록 전 미리보기 — 이 Tag No 가 붙은 자료
  defineRoute(app, {
    method: 'GET',
    url: '/mdb-tag-history/tag-targets',
    access: permission('screen.mdb_editor.access'),
    schema: { querystring: TagPreviewQuery, response: { 200: TagTargetsResponse, 403: ErrorResponse } },
    handler: async (req) => {
      const v = TagPreviewQuery.parse(req.query)
      return tags.preview(v.tag, v.folderId ?? null)
    },
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
    audit: { screen: EDIT, action: 'Tag 이력 수정' },
    schema: {
      params: IdParam, body: TagHistoryUpdateRequest,
      response: {
        200: z.object({ ok: z.literal(true), reapplied: z.number().int().nullable() }),
        403: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse,
      },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = TagHistoryUpdateRequest.parse(req.body)
      const out = await tags.update(id, b)
      req.setAuditTarget(`Tag 이력 ${id}`, { ...b, reapplied: out.reapplied })
      return out
    },
  })

  // 설비유형 · 자료유형 · Tag No 변경사유 목록 (/equipment-types · /mdb-doc-types · /mdb-tag-reasons)
  registerTypeListRoutes(app)

  void DocumentMoveResult
}
