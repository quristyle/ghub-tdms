import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  CreateDistributionRequest, CreateDistributionResult, DistributionListQuery,
  DistributionListResult, ErrorResponse, FilterOptions, ForImportQuery, ForImportResult,
  OutstandingResult, ReturnRequest, ReturnResult, ZipExportListResult, ZipReturnRequest,
  ZipReturnResult, ZipStatusResult,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import { MIME, sendBlob } from '../../core/files.js'
import * as svc from './service.js'

const SCREEN = 'TDB 반출이력'
const ACCESS = 'screen.tdb_distributions.access'
const OTHER_USER = 'screen.tdb_distributions.viewer.other_user'
const MANUAL_RETURN = 'screen.tdb_distributions.confirm.manual_return'
/** 수정용 반출 — 참조용·기타는 TDB 조회에 들어올 수 있으면 누구나 (기존 정책) */
const DISTRIBUTE_MODIFY = 'screen.tdb_list.distribute.modify'
const ZipNameQuery = z.object({ zipName: z.string().min(1).max(300) })

export function registerDistributionRoutes(app: FastifyInstance): void {
  // ── 목록 (자료별) ────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/distributions',
    access: permission(ACCESS),
    schema: {
      querystring: DistributionListQuery,
      response: { 200: DistributionListResult, 403: ErrorResponse },
    },
    handler: async (req) => {
      const qp = DistributionListQuery.parse(req.query)
      // 다른 사용자를 고를 권한이 없으면 자기 것만 보여준다.
      // 화면이 거르게 두지 않는다 — 주소로 다른 사람 id 를 넣어도 통하면 안 된다.
      if (!canOther(req) && qp.distributedBy !== undefined && qp.distributedBy !== req.auth.user.id) {
        throw Errors.forbidden(OTHER_USER)
      }
      return svc.list(qp)
    },
  })

  // ── 목록 (Zip 별) ────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/distributions/zip-exports',
    access: permission(ACCESS),
    schema: {
      querystring: DistributionListQuery,
      response: { 200: ZipExportListResult, 403: ErrorResponse },
    },
    handler: async (req) => svc.zipExports(DistributionListQuery.parse(req.query)),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/distributions/zip-status',
    access: permission(ACCESS),
    schema: {
      querystring: z.object({ zipName: z.string().min(1).max(300) }),
      response: { 200: ZipStatusResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) =>
      svc.zipStatus(z.object({ zipName: z.string().min(1).max(300) }).parse(req.query).zipName),
  })

  // ── Zip 다시 받기 ────────────────────────────────────────────────────
  // 반출이력 Zip별 보기의 [Zip 다운]. 자료가 다시 밖으로 나가는 일이라 감사에 남긴다.
  defineRoute(app, {
    method: 'GET',
    url: '/distributions/zip-file',
    access: permission(ACCESS),
    audit: { screen: SCREEN, action: 'Zip 다운로드' },
    schema: { querystring: ZipNameQuery, response: { 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req, reply) => {
      const { zipName } = ZipNameQuery.parse(req.query)
      const f = await svc.zipFile(zipName)
      req.setAuditTarget(zipName, { mode: 'download' })
      return sendBlob(reply, {
        sha256: f.sha256,
        filename: `${zipName}.zip`,
        contentType: MIME.zip!,
        byteSize: f.byteSize,
      })
    },
  })

  // ── 미입고 현황 ──────────────────────────────────────────────────────
  // "곧 바뀔 수 있는" 반출 건 — 미반납 + 돌아왔지만 검수 전.
  defineRoute(app, {
    method: 'GET',
    url: '/distributions/outstanding',
    access: permission(ACCESS),
    schema: { response: { 200: OutstandingResult, 403: ErrorResponse } },
    handler: async () => svc.outstanding(),
  })

  // ── 반입 대상 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/distributions/for-import',
    access: permission(ACCESS),
    schema: { querystring: ForImportQuery, response: { 200: ForImportResult, 403: ErrorResponse } },
    handler: async (req) => svc.forImport(ForImportQuery.parse(req.query)),
  })

  // ── 검색 보조 ────────────────────────────────────────────────────────
  // TDB 조회의 [반출하기] 창도 업체·공사 목록을 여기서 받는다 — 반출이력 화면 권한이 없는
  // 사람도 반출은 할 수 있으므로 로그인만 본다. 반출자 목록은 아래에서 권한대로 줄인다.
  defineRoute(app, {
    method: 'GET',
    url: '/distributions/filter-options',
    access: AUTHENTICATED,
    schema: { response: { 200: FilterOptions, 403: ErrorResponse } },
    handler: async (req) =>
      svc.filterOptions(canOther(req), req.auth.user.id, req.auth.user.name),
  })

  // ── 반납 처리 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/distributions/return',
    access: permission(ACCESS),
    audit: { screen: SCREEN, action: '반납 처리' },
    schema: {
      body: ReturnRequest,
      response: { 200: ReturnResult, 403: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = ReturnRequest.parse(req.body)
      // '수정없이 반납처리' 는 별도 권한이다 — 실제로 파일을 받지 않고 닫는 일이라
      // 아무나 하면 수정본이 영영 들어오지 않는다.
      if (b.manual && !has(req, MANUAL_RETURN)) throw Errors.forbidden(MANUAL_RETURN)

      const out = await svc.markReturned(b.distributionIds, b.manual, b.note)
      req.setAuditTarget(`${b.distributionIds.length}건`, {
        manual: b.manual, returned: out.returned, skipped: out.skipped.length,
      })
      return out
    },
  })

  // ── Zip 단위 수정없이 반납처리 ────────────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/distributions/zip-return',
    access: permission(MANUAL_RETURN),
    audit: { screen: SCREEN, action: 'Zip 수정없이 반납 처리' },
    schema: {
      body: ZipReturnRequest,
      response: { 200: ZipReturnResult, 403: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = ZipReturnRequest.parse(req.body)
      const out = await svc.returnZips(b.zipNames)
      req.setAuditTarget(b.zipNames.length === 1 ? b.zipNames[0]! : `Zip ${b.zipNames.length}개`, {
        zipNames: b.zipNames, returned: out.returned, skipped: out.skipped.length,
      })
      return out
    },
  })

  // ── 반출 실행 ────────────────────────────────────────────────────────
  // TDB 조회 화면의 반출대기함에서 부른다.
  // 기존처럼 '수정용' 만 권한을 본다 — 참조용·기타는 조회 화면에 들어올 수 있으면 누구나.
  defineRoute(app, {
    method: 'POST',
    url: '/distributions',
    access: permission('screen.tdb_list.access'),
    audit: { screen: 'TDB 조회', action: '반출 실행' },
    schema: {
      body: CreateDistributionRequest,
      response: { 200: CreateDistributionResult, 403: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = CreateDistributionRequest.parse(req.body)
      if (b.purpose === 'MODIFY' && !has(req, DISTRIBUTE_MODIFY)) throw Errors.forbidden(DISTRIBUTE_MODIFY)
      const out = await svc.create(b, req.auth.user.id)
      req.setAuditTarget(`${b.vendorName} ${out.created}건`, {
        zipName: out.zipName, purpose: b.purpose,
        duplicates: out.duplicateWarnings.length, jobId: out.jobId,
      })
      return out
    },
  })
}

interface AuthedRequest {
  auth: { user: { id: number; name: string; role: string }; permissions: ReadonlySet<string> }
}

function has(req: unknown, key: string): boolean {
  const r = req as AuthedRequest
  return r.auth.user.role === 'ADMIN' || r.auth.permissions.has(key)
}

function canOther(req: unknown): boolean {
  return has(req, OTHER_USER)
}
