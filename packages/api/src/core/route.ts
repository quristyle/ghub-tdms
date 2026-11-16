import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify'
import type { ZodTypeAny } from 'zod'
import { LEAF_KEY_SET, type PermissionKey } from '@tdms/contracts'
import { AppError, Errors } from './errors.js'
import { hasPermission, type AuthContext } from './session.js'
import { writeAudit } from './audit.js'

/**
 * 선언형 라우트.
 *
 * 기존 시스템의 두 가지 구조적 누락을 코드가 아니라 **구조로** 막는다.
 *   S-06  권한 트리에 없는 기능은 로그인만 하면 전부 열림
 *   S-07  PDF 인라인 열람은 감사 미기록
 *
 * 모든 라우트는 access 를 명시해야 한다. 빠뜨리면 기동 시점에 서버가 뜨지 않는다.
 */

export type Access =
  /** 로그인 없이 열린다 (로그인 화면, health) */
  | { kind: 'public' }
  /** 로그인만 하면 된다 — 권한 트리에 없는 기능 (2026-08-12 CM 확정 정책) */
  | { kind: 'authenticated' }
  /** 리프 권한이 필요하다 */
  | { kind: 'permission'; key: PermissionKey }
  /** 나열한 리프 중 하나라도 있으면 된다 — 여러 화면이 함께 쓰는 조회·파일 경로 */
  | { kind: 'anyPermission'; keys: readonly PermissionKey[] }

export const PUBLIC: Access = { kind: 'public' }
export const AUTHENTICATED: Access = { kind: 'authenticated' }
export const permission = (key: PermissionKey): Access => ({ kind: 'permission', key })
export const anyPermission = (...keys: PermissionKey[]): Access => ({ kind: 'anyPermission', keys })

/**
 * TDB 자료·파일을 읽는 화면들. 자료 상세·PDF 보기는 조회·반입검수·관리·반출이력 화면이
 * 함께 쓴다. 예전에는 로그인만 보았기 때문에 권한이 하나도 없는 계정도 id 를 차례로
 * 넣어 모든 도면을 내려받을 수 있었다.
 */
export const TDB_READ = anyPermission(
  'screen.tdb_list.access', 'screen.tdb_import.access',
  'screen.tdb_editor.access', 'screen.tdb_distributions.access',
)
/** MDB 자료·파일을 읽는 화면들 */
export const MDB_READ = anyPermission('screen.mdb_list.access', 'screen.mdb_editor.access')

export interface AuditSpec {
  screen: string
  action: string
}

export interface RouteSpec {
  method: HTTPMethods | HTTPMethods[]
  url: string
  access: Access
  /** 감사 로그에 남길 화면·동작. 쓰기 작업과 파일 접근은 필수. */
  audit?: AuditSpec
  schema?: {
    body?: ZodTypeAny
    querystring?: ZodTypeAny
    params?: ZodTypeAny
    response?: Record<number, ZodTypeAny>
  }
  handler: (req: TdmsRequest, reply: FastifyReply) => Promise<unknown>
}

export interface TdmsRequest extends FastifyRequest {
  auth: AuthContext
  /** 감사 로그의 '자료명' 칸. 핸들러가 대상만 덧붙인다. */
  setAuditTarget: (target: string, detail?: Record<string, unknown>) => void
}

/** 기동 시 검증을 위해 모든 선언을 모아 둔다. */
export const routeRegistry: RouteSpec[] = []

/** 비밀번호를 바꿔야 하는 세션이 부를 수 있는 것 — 자기 정보·변경·로그아웃뿐 */
const PASSWORD_CHANGE_ALLOWED: ReadonlySet<string> = new Set(['/auth/me', '/auth/password', '/auth/logout'])

const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isMutating(method: HTTPMethods | HTTPMethods[]): boolean {
  const list = Array.isArray(method) ? method : [method]
  return list.some((m) => MUTATING.has(m))
}

/** 파일 바이트를 내보내는 경로는 전부 감사 대상이다 (S-07). */
function isFileRoute(url: string): boolean {
  return /\/(download|view|preview|export|zip-file|stream)(\/|$)/.test(url)
}

export function defineRoute(app: FastifyInstance, spec: RouteSpec): void {
  routeRegistry.push(spec)

  app.route({
    method: spec.method,
    url: spec.url,
    schema: spec.schema as never,
    preHandler: async (req, reply) => {
      const r = req as TdmsRequest

      if (spec.access.kind !== 'public') {
        if (!r.auth) throw Errors.unauthorized()
        // 초기·임시 비밀번호 상태에서는 바꾸기 전까지 다른 기능을 쓰지 못한다.
        // 화면이 변경 창을 먼저 띄우지만, 그건 화면 사정이고 경계는 여기다 —
        // 주소를 직접 부르면 그대로 통과하던 구멍을 막는다.
        if (r.auth.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(spec.url)) {
          throw new AppError('PASSWORD_CHANGE_REQUIRED', 403, '비밀번호를 먼저 바꿔야 합니다.')
        }
        if (spec.access.kind === 'permission' && !hasPermission(r.auth, spec.access.key)) {
          throw Errors.forbidden(spec.access.key)
        }
        if (spec.access.kind === 'anyPermission') {
          const keys = spec.access.keys
          if (!keys.some((k) => hasPermission(r.auth, k))) throw Errors.forbidden(keys[0])
        }
      }

      // 감사 대상 수집기 부착
      let target: string | null = null
      let detail: Record<string, unknown> | undefined
      r.setAuditTarget = (t, d) => {
        target = t
        detail = d
      }

      if (spec.audit) {
        reply.then(
          () => {
            // 2xx 로 끝난 요청만 기록한다
            if (reply.statusCode >= 400) return
            void writeAudit({
              userId: r.auth?.user.id ?? null,
              userName: r.auth?.user.name ?? null,
              screen: spec.audit!.screen,
              action: spec.audit!.action,
              target,
              detail: detail ?? null,
              clientIp: req.ip,
              requestId: req.id,
            })
          },
          () => {},
        )
      }
    },
    handler: async (req, reply) => spec.handler(req as TdmsRequest, reply),
  })
}

// ── 기동 시점 검증 ────────────────────────────────────────────────────────
// 하나라도 어긋나면 프로세스가 뜨지 않는다. 운영에 나간 뒤 발견되는 것을 막는다.

export function assertRouteDeclarations(): void {
  const problems: string[] = []

  for (const r of routeRegistry) {
    const where = `${Array.isArray(r.method) ? r.method.join('|') : r.method} ${r.url}`

    // ① 권한 키가 트리에 실제로 있는가
    if (r.access.kind === 'permission' && !LEAF_KEY_SET.has(r.access.key)) {
      problems.push(`${where} — 권한 트리에 없는 키: ${r.access.key}`)
    }
    if (r.access.kind === 'anyPermission') {
      if (!r.access.keys.length) problems.push(`${where} — anyPermission 에 키가 없음`)
      for (const k of r.access.keys) {
        if (!LEAF_KEY_SET.has(k)) problems.push(`${where} — 권한 트리에 없는 키: ${k}`)
      }
    }

    // ② 쓰기 작업에 감사 선언이 있는가
    if (isMutating(r.method) && !r.audit) {
      problems.push(`${where} — 쓰기 작업인데 audit 선언이 없음`)
    }

    // ③ 파일을 내보내는 경로에 감사 선언이 있는가 (S-07)
    if (isFileRoute(r.url) && !r.audit) {
      problems.push(`${where} — 파일 접근 경로인데 audit 선언이 없음`)
    }

    // ④ 응답 스키마가 있는가 (Fastify 직렬화 컴파일 = 성능)
    if (!r.schema?.response && !isFileRoute(r.url)) {
      problems.push(`${where} — response 스키마가 없음 (직렬화 컴파일 불가)`)
    }
  }

  if (problems.length) {
    throw new AppError(
      'ROUTE_DECLARATION_INVALID',
      500,
      `라우트 선언 검증 실패 ${problems.length}건:\n  - ${problems.join('\n  - ')}`,
    )
  }
}

export function routeSummary(): { total: number; byAccess: Record<string, number> } {
  const byAccess: Record<string, number> = { public: 0, authenticated: 0, permission: 0, anyPermission: 0 }
  for (const r of routeRegistry) byAccess[r.access.kind] = (byAccess[r.access.kind] ?? 0) + 1
  return { total: routeRegistry.length, byAccess }
}
