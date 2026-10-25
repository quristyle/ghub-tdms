import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  BranchMergeResult, BulkReviewRequest, BulkReviewResult, DiscardIssueRequest,
  DuplicateDistributionResponse, ErrorResponse, ImportIssueResponse,
  PendingReviewResponse, RecheckIssueResult, ResolveIssueRequest,
  ReviewRequest, ReviewResult, UploadResult, ZipImportAccepted,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { registerBlob, storeStream } from '../../core/blob.js'
import { tx } from '../../core/db.js'
import * as jobs from '../jobs/service.js'
import * as svc from './service.js'

const SCREEN = 'TDB 반입·검수'
const IdParam = z.object({ id: z.coerce.number().int() })

/** 업로드 상한. nginx 의 client_max_body_size 와 맞춘다. */
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024

/** 확장자만 믿지 않는다 — 앞머리 바이트로 한 번 더 본다. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  dwg: (b) => b.subarray(0, 2).toString('latin1') === 'AC',
}

const ALLOWED = new Set(['pdf', 'dwg', 'dxf', 'xlsx', 'xls', 'docx', 'pptx', 'zip'])

/**
 * 올라온 파일이 쓸 만한지 본다.
 *   · 비어 있지 않은가 — 0바이트는 업로드가 끊겼거나 스트림을 잘못 읽은 것이다
 *   · 앞머리 바이트가 확장자와 맞는가 — 확장자만 바꿔 올린 파일을 막는다
 */
function assertUsable(stored: { byteSize: number; head: Buffer }, ext: string, filename: string): void {
  if (stored.byteSize === 0) {
    throw Errors.invalid('EMPTY_FILE', `내용이 비어 있습니다: ${filename}`)
  }
  const check = MAGIC[ext]
  if (check && !check(stored.head)) {
    throw Errors.invalid('CONTENT_MISMATCH', `내용이 .${ext} 형식이 아닙니다: ${filename}`)
  }
}

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
      const parts = req.parts()

      const files: svc.IncomingFile[] = []
      let vendorName = ''
      let vendorId: number | null = null
      let projectId: number | null = null

      for await (const part of parts) {
        if (part.type === 'field') {
          const v = String(part.value)
          if (part.fieldname === 'vendorName') vendorName = v
          if (part.fieldname === 'vendorId' && v) vendorId = Number(v)
          if (part.fieldname === 'projectId' && v) projectId = Number(v)
          continue
        }

        const ext = (part.filename.split('.').pop() ?? '').toLowerCase()
        if (!ALLOWED.has(ext)) {
          throw Errors.invalid('EXT_NOT_ALLOWED', `받을 수 없는 형식입니다: .${ext}`)
        }

        // 스트림에 곁다리 리스너를 붙이지 않는다 — storeStream 이 파이프라인 안에서
        // 해시·크기·앞머리를 한 번에 뽑아 준다 (core/blob.ts 주석 참조).
        const stored = await storeStream(part.file, MAX_UPLOAD)
        assertUsable(stored, ext, part.filename)
        await tx((c) => registerBlob(c, stored))
        files.push({ sha256: stored.sha256, originalFilename: part.filename, fileExt: ext })
      }

      if (!vendorName) throw Errors.invalid('VENDOR_REQUIRED', '업체를 지정해 주세요.')

      const out = await svc.registerRevision(
        id, files, { id: vendorId, name: vendorName }, projectId, req.auth.user.id,
      )
      req.setAuditTarget(`${out.documentId} ${out.revLabel}`, {
        files: out.created, branched: out.branched, reason: out.reason,
      })
      return out
    },
  })

  // ── 반입 등록 (Zip 대량) — 워커로 넘긴다 ─────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/imports/zip',
    access: permission('screen.tdb_import.register'),
    audit: { screen: SCREEN, action: '반입등록 (Zip 파일)' },
    schema: { response: { 202: ZipImportAccepted, 403: ErrorResponse, 422: ErrorResponse } },
    handler: async (req, reply) => {
      const part = await req.file()
      if (!part) throw Errors.invalid('NO_FILE', '올릴 Zip 파일이 없습니다.')
      if (!part.filename.toLowerCase().endsWith('.zip')) {
        throw Errors.invalid('EXT_NOT_ALLOWED', 'Zip 파일만 올릴 수 있습니다.')
      }

      const fields = part.fields as Record<string, { value?: unknown } | undefined>
      const stored = await storeStream(part.file, MAX_UPLOAD)
      assertUsable(stored, 'zip', part.filename)
      await tx((c) => registerBlob(c, stored))

      // 압축을 푸는 것은 워커가 한다 — 요청 스레드에서 수백 건을 처리하지 않는다
      const jobId = await jobs.create(
        'bulk_import',
        {
          sha256: stored.sha256.toString('hex'),
          filename: part.filename,
          vendorName: String(fields.vendorName?.value ?? ''),
          projectId: fields.projectId?.value ? Number(fields.projectId.value) : null,
        },
        req.auth.user.id,
      )
      req.setAuditTarget(part.filename, { jobId, byteSize: stored.byteSize })
      return reply.code(202).send({ jobId })
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

  defineRoute(app, {
    method: 'POST',
    url: '/import-issues/:id/resolve',
    access: permission('screen.tdb_import.issue.repath'),
    audit: { screen: SCREEN, action: '확인 필요 — 경로 재선택' },
    schema: {
      params: IdParam, body: ResolveIssueRequest,
      response: { 200: UploadResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const body = ResolveIssueRequest.parse(req.body)
      const out = await svc.resolveIssue(
        id, body.documentId, { id: null, name: body.vendorName }, body.projectId, req.auth.user.id,
      )
      req.setAuditTarget(`확인필요 ${id} → 자료 ${body.documentId}`, { revLabel: out.revLabel })
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/import-issues/:id/recheck',
    access: permission('screen.tdb_import.issue.recheck'),
    audit: { screen: SCREEN, action: '확인 필요 — 재검수' },
    schema: { params: IdParam, response: { 200: RecheckIssueResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const out = await svc.recheckIssue(id, req.auth.user.id)
      req.setAuditTarget(`확인필요 ${id}`, { message: out.message })
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
      response: { 200: z.object({ ok: z.literal(true) }), 403: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const body = DiscardIssueRequest.parse(req.body)
      await svc.discardIssue(id, req.auth.user.id)
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
      const files: svc.IncomingFile[] = []
      let projectId: number | null = null

      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'projectId' && part.value) projectId = Number(part.value)
          continue
        }
        const ext = (part.filename.split('.').pop() ?? '').toLowerCase()
        if (!ALLOWED.has(ext)) throw Errors.invalid('EXT_NOT_ALLOWED', `받을 수 없는 형식입니다: .${ext}`)
        const stored = await storeStream(part.file, MAX_UPLOAD)
        assertUsable(stored, ext, part.filename)
        await tx((c) => registerBlob(c, stored))
        files.push({ sha256: stored.sha256, originalFilename: part.filename, fileExt: ext })
      }

      if (files.length === 0) throw Errors.invalid('NO_FILES', '통합본 파일을 첨부해 주세요.')
      const out = await svc.branchMerge(id, files, projectId, req.auth.user.id)
      req.setAuditTarget(`자료 ${id} ${out.revLabel}`, { closedBranches: out.closedBranches })
      return out
    },
  })
}
