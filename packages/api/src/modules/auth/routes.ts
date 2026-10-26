import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  LoginRequest, LoginResult, MeResponse, PasswordChangeRequest,
  ErrorResponse, MENU, LEAF_KEYS,
} from '@tdms/contracts'
import { AUTHENTICATED, PUBLIC, defineRoute } from '../../core/route.js'
import {
  clearSessionCookie, deferPasswordChange, destroySession,
  readSessionCookie, setSessionCookie,
} from '../../core/session.js'
import { cached } from '../../core/cache.js'
import { listEnabledMenus } from '../admin/queries.js'
import * as svc from './service.js'

/**
 * 사이드바에 내려보낼 메뉴 — 운영자가 메뉴관리 화면에서 정해 둔 이름·순서·사용여부.
 *
 * 정본은 DB 의 menus 다(0015). 바뀌는 일이 드물고 /auth/me 마다 읽히므로 캐시하고,
 * 저장할 때 admin 서비스가 cache_menu 를 비운다.
 *
 * 한 줄도 못 읽으면 MENU 상수로 돌아간다. 메뉴가 통째로 사라지면 사용자가 어느
 * 화면으로도 갈 수 없어서, 여기서만은 비어 있는 결과를 그대로 내보내지 않는다.
 */
async function visibleMenu(): Promise<{ path: string; label: string; permission: string }[]> {
  const rows = await cached('cache_menu', 'enabled', async () => ({
    items: await listEnabledMenus(),
  }))
  return rows.items.length > 0 ? rows.items : [...MENU]
}

export function registerAuthRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST',
    url: '/auth/login',
    access: PUBLIC,
    audit: { screen: '로그인', action: '로그인' },
    schema: {
      body: LoginRequest,
      response: { 200: LoginResult, 401: ErrorResponse, 429: ErrorResponse },
    },
    handler: async (req, reply) => {
      const { loginId, password } = LoginRequest.parse(req.body)
      const out = await svc.login(loginId, password, req.ip, req.headers['user-agent'])
      setSessionCookie(reply, out.sessionId)
      req.setAuditTarget(loginId)
      return { ok: true as const, mustChangePassword: out.mustChangePassword }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/auth/logout',
    access: AUTHENTICATED,
    audit: { screen: '로그인', action: '로그아웃' },
    schema: { response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (req, reply) => {
      const sid = readSessionCookie(req)
      if (sid) await destroySession(sid)
      clearSessionCookie(reply)
      req.setAuditTarget(req.auth.user.loginId)
      return { ok: true as const }
    },
  })

  // 화면이 메뉴를 그리고 버튼을 켜고 끄는 데 쓰는 전부.
  // 권한 없는 메뉴는 여기서 빠져서 내려간다 — 화면이 걸러내게 두지 않는다.
  defineRoute(app, {
    method: 'GET',
    url: '/auth/me',
    access: AUTHENTICATED,
    schema: { response: { 200: MeResponse, 401: ErrorResponse } },
    handler: async (req) => {
      const { user, permissions } = req.auth
      const perms = user.role === 'ADMIN' ? [...LEAF_KEYS] : [...permissions]
      return {
        id: user.id,
        loginId: user.loginId,
        name: user.name,
        role: user.role,
        groupId: user.groupId,
        groupName: user.groupName,
        mustChangePassword: user.mustChangePassword,
        passwordDeferred: user.passwordDeferred,
        permissions: perms,
        menu: (await visibleMenu()).filter((m) => user.role === 'ADMIN' || permissions.has(m.permission)),
      }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/auth/password',
    access: AUTHENTICATED,
    audit: { screen: '로그인', action: '비밀번호 변경' },
    schema: {
      body: PasswordChangeRequest,
      response: { 200: z.object({ ok: z.literal(true) }), 422: ErrorResponse },
    },
    handler: async (req, reply) => {
      const body = PasswordChangeRequest.parse(req.body)
      await svc.changePassword(
        req.auth.user.id, req.auth.user.loginId, body.currentPassword, body.newPassword,
      )
      // 모든 세션이 끊겼으므로 쿠키도 지운다 — 다시 로그인하게 한다
      clearSessionCookie(reply)
      req.setAuditTarget(req.auth.user.loginId)
      return { ok: true as const }
    },
  })

  // 미루기 — 이번 로그인은 넘어가고 다음 로그인 때 다시 묻는다 (기존 정책 유지)
  defineRoute(app, {
    method: 'POST',
    url: '/auth/password/defer',
    access: AUTHENTICATED,
    audit: { screen: '로그인', action: '비밀번호 변경 미루기' },
    schema: { response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (req) => {
      await deferPasswordChange(req.auth.sessionId)
      req.setAuditTarget(req.auth.user.loginId)
      return { ok: true as const }
    },
  })
}
