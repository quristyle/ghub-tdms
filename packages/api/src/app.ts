import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { ZodError } from 'zod'
import { z } from 'zod'

import { config } from './core/config.js'
import { AppError } from './core/errors.js'
import { healthy } from './core/db.js'
import { startCacheListener } from './core/cache.js'
import {
  assertRouteDeclarations, defineRoute, PUBLIC, routeSummary, type TdmsRequest,
} from './core/route.js'
import { loadPermissions, loadSession, readSessionCookie } from './core/session.js'

import { registerAuthRoutes } from './modules/auth/routes.js'
import { registerFolderRoutes } from './modules/folders/routes.js'
import { registerDocumentRoutes } from './modules/documents/routes.js'
import { registerFileRoutes } from './modules/files/routes.js'
import { registerJobRoutes } from './modules/jobs/routes.js'
import { registerFavoriteRoutes } from './modules/favorites/routes.js'
import { registerImportRoutes } from './modules/imports/routes.js'
import { registerEditorRoutes } from './modules/editor/routes.js'
import { registerDistributionRoutes } from './modules/distributions/routes.js'
import { registerMdbRoutes } from './modules/mdb/routes.js'
import { registerAdminRoutes } from './modules/admin/routes.js'
import { registerStampRoutes } from './modules/stamps/routes.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.password_hash'],
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    },
    trustProxy: true,
    bodyLimit: 32 * 1024 * 1024,
  })

  // Zod 를 검증기이자 직렬화 컴파일러로 — 응답 JSON 생성이 2~3배 빨라진다
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(cookie, { secret: config.session.secret })
  // 업로드는 디스크로 스트리밍한다 — 메모리에 올리지 않는다. 상한은 nginx 와 맞춘다.
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 50 } })

  // ── 세션 복원 ────────────────────────────────────────────────────────
  // 모든 요청에 대해 한 번만. 권한은 캐시에서 온다(요청당 DB 왕복 없음).
  app.addHook('onRequest', async (req) => {
    const sid = readSessionCookie(req)
    if (!sid) return
    const user = await loadSession(sid)
    if (!user) return
    ;(req as TdmsRequest).auth = {
      sessionId: sid,
      user,
      permissions: await loadPermissions(user),
    }
  })

  // ── CSRF: 동일 출처 쓰기 검사 (SameSite=Strict 와 2중) ────────────────
  app.addHook('onRequest', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return
    const origin = req.headers.origin
    if (!origin) return // 같은 출처 fetch 는 Origin 을 보낸다. 없으면 비브라우저 호출.
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    try {
      if (new URL(origin).host !== host) {
        return reply.code(403).send({ code: 'CROSS_ORIGIN_WRITE', message: '다른 사이트에서 온 요청입니다.' })
      }
    } catch {
      return reply.code(403).send({ code: 'BAD_ORIGIN', message: '출처를 확인할 수 없습니다.' })
    }
  })

  // ── 보안 헤더 (nginx 가 없는 개발 환경에서도 같은 조건으로) ────────────
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'same-origin')
    return payload
  })

  // ── 오류 처리 ────────────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const { requiredPermission, ...detail } = err.detail ?? {}
      return reply.code(err.status).send({
        code: err.code,
        message: err.message,
        ...(requiredPermission ? { requiredPermission } : {}),
        ...(Object.keys(detail).length ? { detail } : {}),
      })
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        code: 'VALIDATION_FAILED',
        message: '입력값이 올바르지 않습니다.',
        detail: { issues: err.issues },
      })
    }

    const status = (err as { statusCode?: number }).statusCode
    const fastifyCode = (err as { code?: string }).code

    // Fastify 가 스키마로 걸러 낸 것은 ZodError 가 아니라 FST_ERR_VALIDATION 으로 온다.
    // 이걸 흘려보내면 입력 실수가 500 으로 둔갑해 호출 측이 원인을 알 수 없다.
    if (fastifyCode === 'FST_ERR_VALIDATION' || status === 400) {
      return reply.code(400).send({
        code: 'VALIDATION_FAILED',
        message: '입력값이 올바르지 않습니다.',
        detail: {
          reason: (err as Error).message,
          issues: (err as { validation?: unknown }).validation ?? undefined,
        },
      })
    }

    if (status === 413 || fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: '파일이 너무 큽니다.' })
    }
    if (status === 415) {
      return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE', message: '받을 수 없는 형식입니다.' })
    }

    // 4xx 는 호출 측 잘못이므로 그대로 돌려준다. 5xx 만 내부 오류로 감춘다.
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({
        code: fastifyCode ?? 'BAD_REQUEST',
        message: (err as Error).message,
      })
    }

    req.log.error({ err }, '처리되지 않은 오류')
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' })
  })

  // ── 라우트 ───────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/health',
    access: PUBLIC,
    schema: {
      response: {
        200: z.object({ status: z.string(), db: z.boolean(), uptime: z.number() }),
      },
    },
    handler: async () => ({
      status: 'ok',
      db: await healthy(),
      uptime: Math.round(process.uptime()),
    }),
  })

  registerAuthRoutes(app)
  registerFolderRoutes(app)
  registerDocumentRoutes(app)
  registerFileRoutes(app)
  registerJobRoutes(app)
  registerFavoriteRoutes(app)
  registerImportRoutes(app)
  registerEditorRoutes(app)
  registerDistributionRoutes(app)
  registerMdbRoutes(app)
  registerAdminRoutes(app)
  registerStampRoutes(app)

  // ── 기동 시점 검증 — 하나라도 어긋나면 서버가 뜨지 않는다 ─────────────
  assertRouteDeclarations()
  app.log.info(routeSummary(), '라우트 선언 검증 통과')

  await startCacheListener(app.log)

  return app
}
