import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  baseName, BranchMergeResult, BulkReviewRequest, BulkReviewResult, DiscardIssueRequest,
  DuplicateDistributionResponse, ErrorResponse, fileExtOf, ImportIssueResponse, ImportOptions,
  ImportTargetQuery, ImportTargetResponse, PendingReviewResponse, ReattachIssueResult,
  RecheckIssueResult, RegisterNewResult, ResolveIssueRequest, ResolveIssueResult,
  ReviewRequest, ReviewResult, revName, UploadResult, ZipImportAccepted,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission, type TdmsRequest } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { registerBlob, storeStream, type StoredBlob } from '../../core/blob.js'
import { tx } from '../../core/db.js'
import { sendBlob } from '../../core/files.js'
import * as jobs from '../jobs/service.js'
import * as engine from './engine.js'
import * as q from './queries.js'
import * as svc from './service.js'
import { ALLOWED, contentProblem, MAX_UPLOAD } from './upload.js'

const SCREEN = 'TDB 반입·검수'
const IdParam = z.object({ id: z.coerce.number().int() })

function assertUsable(stored: { byteSize: number; head: Buffer }, ext: string, filename: string): void {
  const problem = contentProblem(stored, ext, filename)
  if (problem) throw Errors.invalid(problem.code, problem.message)
}

interface UploadedFile {
  stored: StoredBlob
  filename: string
  ext: string
}

/**
 * multipart 를 읽어 파일은 blob 으로 넣고 글자 칸은 모아 돌려준다.
 * 스트림에 곁다리 리스너를 붙이지 않는다 — storeStream 이 파이프라인 안에서
 * 해시·크기·앞머리를 한 번에 뽑아 준다 (core/blob.ts 주석 참조).
 */
async function readMultipart(req: TdmsRequest, allowed: ReadonlySet<string> = ALLOWED) {
  const fields: Record<string, string> = {}
  const files: UploadedFile[] = []
  for await (const part of req.parts()) {
    if (part.type === 'field') {
      fields[part.fieldname] = String(part.value)
      continue
    }
    const filename = baseName(part.filename)
    const ext = fileExtOf(filename)
    if (!allowed.has(ext)) throw Errors.invalid('EXT_NOT_ALLOWED', `받을 수 없는 형식입니다: .${ext}`)
    const stored = await storeStream(part.file, MAX_UPLOAD)
    assertUsable(stored, ext, filename)
    await tx((c) => registerBlob(c, stored))
    files.push({ stored, filename, ext })
  }
  return { fields, files }
}

const optNum = (v: string | undefined) => (v && v.trim() ? Number(v) : null)
const optStr = (v: string | undefined) => (v && v.trim() ? v.trim() : null)

export function registerImportRoutes(app: FastifyInstance): void {
  // ── 반입 등록 (개별 자료) ────────────────────────────────────────────
  // multipart 라 응답 스키마만 선언하고 본문은 직접 읽는다.
  defineRoute(app, {
    method: 'POST',
    url: '/documents/:id/revisions',
    access: permission('screen.tdb_import.register'),
    audit: { screen: SCREEN, action: '반입등록 (개별 자료)' },
    schema: {
      params: IdParam,
      response: { 200: UploadResult, 403: ErrorResponse, 413: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const { fields, files } = await readMultipart(req)
      const vendorName = fields.vendorName ?? ''
      if (!vendorName) throw Errors.invalid('VENDOR_REQUIRED', '업체를 지정해 주세요.')

      const out = await svc.registerRevision(
        id,
        files.map((f) => ({ sha256: f.stored.sha256, originalFilename: f.filename, fileExt: f.ext })),
        { id: optNum(fields.vendorId), name: vendorName }, optNum(fields.projectId), req.auth.user.id,
      )
      req.setAuditTarget(`${out.documentId} ${out.revLabel}`, {
        files: out.created, branched: out.branched, reason: out.reason,
      })
      return out
    },
  })

  // ── 반입 Zip — 반출 때 받은 Zip 을 그대로 올린다 ───────────────────────
  // 업로드만 요청 안에서 받고, 풀기·진단·등록은 작업으로 돈다(진행률은 /jobs/:id/stream).
  // 진단이 깨끗한 세트는 리비전 등록을 그대로 써야 해서 워커가 아니라 API 안에서 돈다.
  defineRoute(app, {
    method: 'POST',
    url: '/imports/zip',
    access: permission('screen.tdb_import.register'),
    audit: { screen: SCREEN, action: '반입등록 (Zip 파일)' },
    schema: { response: { 202: ZipImportAccepted, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req, reply) => {
      const part = await req.file()
      if (!part) throw Errors.invalid('NO_FILE', '올릴 Zip 파일이 없습니다.')
      if (fileExtOf(part.filename) !== 'zip') {
        throw Errors.invalid('EXT_NOT_ALLOWED', 'Zip 파일만 올릴 수 있습니다.')
      }
      const stored = await storeStream(part.file, MAX_UPLOAD)
      assertUsable(stored, 'zip', part.filename)
      await tx((c) => registerBlob(c, stored))

      const userId = req.auth.user.id
      const jobId = await jobs.runInApi(
        'bulk_import',
        { mode: 'zip', sha256: stored.sha256.toString('hex'), filename: part.filename },
        userId,
        (job, progress) => engine.runZipImport(job, stored.sha256, userId, progress),
        req.log,
      )
      req.setAuditTarget(part.filename, { jobId, byteSize: stored.byteSize })
      return reply.code(202).send({ jobId })
    },
  })

  // ── 반입 자료 — 반출 건을 고르고 파일(또는 Zip)을 올린다 ───────────────
  defineRoute(app, {
    method: 'GET',
    url: '/imports/targets',
    access: permission('screen.tdb_import.access'),
    schema: { querystring: ImportTargetQuery, response: { 200: ImportTargetResponse, 403: ErrorResponse } },
    handler: async (req) => {
      const rows = await q.listImportTargets(ImportTargetQuery.parse(req.query))
      return {
        items: rows.map((r) => ({
          ...r,
          displayName: revName(r.drawingNo, r.revAtDistribution),
          folderPath: (r.folderNames ?? []).join(' > '),
          distributedAt: r.distributedAt.toISOString(),
        })),
      }
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/imports/options',
    access: permission('screen.tdb_import.access'),
    schema: { response: { 200: ImportOptions, 403: ErrorResponse } },
    handler: async () => {
      const [vendors, projects] = await q.importOptions()
      return { vendors, projects }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/imports/by-selection',
    access: permission('screen.tdb_import.register'),
    audit: { screen: SCREEN, action: '반입등록 (반입 자료)' },
    schema: { response: { 202: ZipImportAccepted, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req, reply) => {
      const { fields, files } = await readMultipart(req)
      const distributionIds = (fields.distributionIds ?? '')
        .split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0)
      const zipName = optStr(fields.zipName)
      if (!distributionIds.length && !zipName) {
        throw Errors.invalid('NO_TARGET', '대상 도면을 먼저 선택해주세요.')
      }
      if (!files.length) throw Errors.invalid('NO_FILES', '업로드할 파일을 선택해주세요.')

      const payload: engine.SelectionPayload = {
        distributionIds: distributionIds.slice(0, 5000),
        zipName,
        uploads: files.filter((f) => f.ext !== 'zip').map((f) => ({
          sha256: f.stored.sha256.toString('hex'), filename: f.filename, byteSize: f.stored.byteSize,
        })),
        zips: files.filter((f) => f.ext === 'zip').map((f) => f.stored.sha256.toString('hex')),
      }
      const userId = req.auth.user.id
      const jobId = await jobs.runInApi(
        'bulk_import', { mode: 'selection', ...payload }, userId,
        (job, progress) => engine.runSelectionImport(job, payload, userId, progress),
        req.log,
      )
      req.setAuditTarget(zipName ?? `반출 ${distributionIds.length}건`, { jobId, files: files.length })
      return reply.code(202).send({ jobId })
    },
  })

  // ── 신규 자료 등록 ───────────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/imports/register-new',
    access: permission('screen.tdb_import.register'),
    audit: { screen: SCREEN, action: '신규 자료 등록' },
    schema: { response: { 200: RegisterNewResult, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse } },
    handler: async (req) => {
      const allowed = new Set([...ALLOWED].filter((e) => e !== 'zip'))
      const { fields, files } = await readMultipart(req, allowed)
      const folderId = optNum(fields.folderId)
      if (folderId === null || !Number.isInteger(folderId)) {
        throw Errors.invalid('FOLDER_REQUIRED', '등록할 폴더를 골라 주세요.')
      }
      const out = await svc.registerNew(
        {
          folderId,
          drawingNo: fields.drawingNo ?? '',
          title: optStr(fields.title),
          category: optStr(fields.category),
          discipline: optStr(fields.discipline),
          docType: optStr(fields.docType),
          isblOsbl: optStr(fields.isblOsbl),
          elevation: optStr(fields.elevation),
          area: optStr(fields.area),
          vendorName: optStr(fields.vendorName),
          projectId: optNum(fields.projectId),
        },
        files.map((f) => ({ sha256: f.stored.sha256, originalFilename: f.filename, fileExt: f.ext })),
        req.auth.user.id,
      )
      req.setAuditTarget(out.drawingNo, { documentId: out.documentId, files: out.fileCount })
      return out
    },
  })

  // ── 검수 대기 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/revisions/pending-review',
    access: permission('screen.tdb_import.access'),
    schema: {
      querystring: z.object({
        q: z.string().max(200).optional(),
        vendorId: z.coerce.number().int().optional(),
        projectId: z.coerce.number().int().optional(),
      }),
      response: { 200: PendingReviewResponse, 403: ErrorResponse },
    },
    handler: async (req) =>
      svc.pendingReview(
        z.object({
          q: z.string().max(200).optional(),
          vendorId: z.coerce.number().int().optional(),
          projectId: z.coerce.number().int().optional(),
        }).parse(req.query),
      ),
  })

  // 승인·반려는 권한이 다르다(approve / reject). 라우트 하나에서 action 으로 갈리므로
  // 접속 권한만 선언하고 실제 분기 권한은 서비스에 넘긴다.
  defineRoute(app, {
    method: 'POST',
    url: '/revisions/:id/review',
    access: permission('screen.tdb_import.access'),
    audit: { screen: SCREEN, action: '검수 처리' },
    schema: {
      params: IdParam,
      body: ReviewRequest,
      response: { 200: ReviewResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const body = ReviewRequest.parse(req.body)
      const out = await svc.review(id, body.action, body.note, (k) =>
        req.auth.user.role === 'ADMIN' ||
        req.auth.permissions.has(
          k === 'approve' ? 'screen.tdb_import.review.approve' : 'screen.tdb_import.review.reject',
        ),
      )
      req.setAuditTarget(`파일 ${id} ${out.revLabel}`, { action: body.action, note: body.note })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/revisions/review-bulk',
    access: permission('screen.tdb_import.access'),
    audit: { screen: SCREEN, action: '검수 일괄 처리' },
    schema: { body: BulkReviewRequest, response: { 200: BulkReviewResult, 403: ErrorResponse } },
    handler: async (req) => {
      const body = BulkReviewRequest.parse(req.body)
      const can = (k: 'approve' | 'reject') =>
        req.auth.user.role === 'ADMIN' ||
        req.auth.permissions.has(
          k === 'approve' ? 'screen.tdb_import.review.approve' : 'screen.tdb_import.review.reject',
        )

      let done = 0
      const failed: { fileId: number; message: string }[] = []
      // 한 건이 실패해도 나머지는 처리한다 — 어느 건이 왜 막혔는지 화면에 돌려준다
      for (const fileId of body.fileIds) {
        try {
          await svc.review(fileId, body.action, body.note, can)
          done++
        } catch (e) {
          failed.push({ fileId, message: e instanceof Error ? e.message : '처리하지 못했습니다' })
        }
      }
      req.setAuditTarget(`${body.fileIds.length}건`, { action: body.action, done, failed: failed.length })
      return { done, failed }
    },
  })

  // ── 확인 필요 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/import-issues',
    access: permission('screen.tdb_import.access'),
    schema: { response: { 200: ImportIssueResponse, 403: ErrorResponse } },
    handler: async () => svc.issues(),
  })

  // 승인 전 파일이라 files 행이 없어 /files/:id/view 를 못 쓴다 — 항목이 가진 PDF 를 내준다
  defineRoute(app, {
    method: 'GET',
    url: '/import-issues/:id/preview',
    access: permission('screen.tdb_import.access'),
    audit: { screen: SCREEN, action: '확인 필요 — PDF 미리보기' },
    schema: { params: IdParam, response: { 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { id } = IdParam.parse(req.params)
      const pdf = await svc.issuePdf(id)
      req.setAuditTarget(pdf.filename, { issueId: id, mode: 'inline' })
      reply.header('Cache-Control', 'no-store')
      return sendBlob(reply, {
        sha256: pdf.sha256, filename: pdf.filename, contentType: 'application/pdf',
        inline: true, byteSize: pdf.byteSize,
      })
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/import-issues/:id/resolve',
    access: permission('screen.tdb_import.issue.repath'),
    audit: { screen: SCREEN, action: '확인 필요 — 경로 재선택' },
    schema: {
      params: IdParam, body: ResolveIssueRequest,
      response: { 200: ResolveIssueResult, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const body = ResolveIssueRequest.parse(req.body)
      const out = await svc.resolveIssue(id, body.documentId)
      req.setAuditTarget(`확인필요 ${id} → ${out.drawingNo}`, { documentId: out.documentId })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/import-issues/:id/reattach',
    access: permission('screen.tdb_import.issue.reattach'),
    audit: { screen: SCREEN, action: '확인 필요 — 자료 재첨부' },
    schema: {
      params: IdParam,
      response: { 200: ReattachIssueResult, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const allowed = new Set([...ALLOWED].filter((e) => e !== 'zip'))
      const { files } = await readMultipart(req, allowed)
      const out = await svc.reattachIssue(id, files.map((f) => svc.toIssueFile({
        sha256: f.stored.sha256, filename: f.filename, ext: f.ext, byteSize: f.stored.byteSize, folder: null,
      })))
      req.setAuditTarget(`확인필요 ${id}`, { files: files.map((f) => f.filename) })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/import-issues/:id/recheck',
    access: permission('screen.tdb_import.issue.recheck'),
    audit: { screen: SCREEN, action: '확인 필요 — 재검수' },
    schema: {
      params: IdParam,
      response: { 200: RecheckIssueResult, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const out = await svc.recheckIssue(id, req.auth.user.id)
      req.setAuditTarget(`확인필요 ${id}`, { resolved: out.resolved, message: out.message })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/import-issues/:id/discard',
    access: permission('screen.tdb_import.issue.reject'),
    audit: { screen: SCREEN, action: '확인 필요 — 반려' },
    schema: {
      params: IdParam, body: DiscardIssueRequest,
      response: { 200: z.object({ ok: z.literal(true) }), 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const body = DiscardIssueRequest.parse(req.body ?? {})
      await svc.discardIssue(id, body.note, req.auth.user.id)
      req.setAuditTarget(`확인필요 ${id}`, { note: body.note })
      return { ok: true as const }
    },
  })

  // ── 중복반출 현황 ────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/documents/:id/duplicate-distributions',
    access: AUTHENTICATED,
    schema: {
      params: IdParam,
      response: { 200: DuplicateDistributionResponse, 404: ErrorResponse },
    },
    handler: async (req) => svc.duplicateDistributions(IdParam.parse(req.params).id),
  })

  // ── 병합본 첨부 후 승인 ──────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/documents/:id/branch-merge',
    access: permission('screen.tdb_import.review.approve'),
    audit: { screen: SCREEN, action: '병합본 첨부 후 승인' },
    schema: {
      params: IdParam,
      response: { 200: BranchMergeResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const { fields, files } = await readMultipart(req)
      if (files.length === 0) throw Errors.invalid('NO_FILES', '통합본 파일을 첨부해 주세요.')
      const out = await svc.branchMerge(
        id,
        files.map((f) => ({ sha256: f.stored.sha256, originalFilename: f.filename, fileExt: f.ext })),
        optNum(fields.projectId), req.auth.user.id,
      )
      req.setAuditTarget(`자료 ${id} ${out.revLabel}`, { closedBranches: out.closedBranches })
      return out
    },
  })
}
