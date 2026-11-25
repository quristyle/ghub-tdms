import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  LoginRequest, LoginResult, MeResponse, PasswordChangeRequest,
  MfaVerifyRequest, MfaVerifyResult, ErrorResponse, MENU, LEAF_KEYS,
  UpdateProfileRequest, QuickLoginUsersResponse, QuickLoginRequest,
  UpdateLayoutRequest,
} from '@tdms/contracts'
import { AUTHENTICATED, PUBLIC, defineRoute } from '../../core/route.js'
import {
  clearSessionCookie, deferPasswordChange, destroySession,
  readSessionCookie, setSessionCookie,
} from '../../core/session.js'
import { cached } from '../../core/cache.js'
import { listEnabledMenus, getUserMenuPermissions } from '../admin/queries.js'
import { updateMyProfile } from './queries.js'
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
async function visibleMenu(): Promise<{ id?: number; code?: string; path: string; label: string; category?: string; permission: string }[]> {
  const rows = await cached('cache_menu', 'enabled', async () => ({
    items: await listEnabledMenus(),
  }))
  return rows.items.length > 0 ? rows.items : [...MENU]
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // ── 그룹별 빠른 로그인용 사용자 목록 (로그인 화면 버튼용) ─────────
  defineRoute(app, {
    method: 'GET',
    url: '/auth/quick-login-users',
    access: PUBLIC,
    schema: {
      response: { 200: QuickLoginUsersResponse },
    },
    handler: async () => {
      const items = await svc.listQuickLoginUsers()
      return { items }
    },
  })

  // ── 그룹별 사용자 빠른 자동 로그인 ────────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/auth/quick-login',
    access: PUBLIC,
    audit: { screen: '로그인', action: '자동 로그인' },
    schema: {
      body: QuickLoginRequest,
      response: {
        200: z.object({ ok: z.literal(true), mustChangePassword: z.boolean() }),
        401: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const { loginId } = QuickLoginRequest.parse(req.body)
      const out = await svc.quickLogin(loginId, req.ip, req.headers['user-agent'])
      setSessionCookie(reply, out.sessionId)
      req.setAuditTarget(out.loginId, { step: '자동 로그인' })
      return { ok: true as const, mustChangePassword: false }
    },
  })

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
      const { loginId, password, skipMfa } = LoginRequest.parse(req.body)
      const out = await svc.login(loginId, password, req.ip, req.headers['user-agent'], skipMfa === true)
      req.setAuditTarget(loginId, out.kind === 'session' && out.mfaSkipped ? { step: '2차 인증 생략' } : undefined)
      if (out.kind === 'challenge') return out.result
      setSessionCookie(reply, out.sessionId)
      return { ok: true as const, mfa: 'none' as const, mustChangePassword: out.mustChangePassword }
    },
  })

  // 2단계 — 인증 앱(Microsoft Authenticator 등)의 6자리 코드.
  // 맞아야 세션 쿠키가 나간다. 등록 대기(enroll)였다면 이때 등록이 끝난다.
  defineRoute(app, {
    method: 'POST',
    url: '/auth/mfa',
    access: PUBLIC,
    audit: { screen: '로그인', action: '2차 인증' },
    schema: {
      body: MfaVerifyRequest,
      response: { 200: MfaVerifyResult, 401: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse },
    },
    handler: async (req, reply) => {
      const { challenge, code } = MfaVerifyRequest.parse(req.body)
      const out = await svc.verifyMfa(challenge, code, req.ip, req.headers['user-agent'])
      setSessionCookie(reply, out.sessionId)
      req.setAuditTarget(out.loginId, { step: out.enrolled ? '인증 앱 등록' : '코드 확인' })
      return { ok: true as const, mustChangePassword: out.mustChangePassword, enrolled: out.enrolled }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/auth/logout',
    access: PUBLIC,
    audit: { screen: '로그인', action: '로그아웃' },
    schema: { response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (req, reply) => {
      const sid = readSessionCookie(req)
      if (sid) await destroySession(sid)
      clearSessionCookie(reply)
      const authUser = (req as any).auth?.user
      if (authUser?.loginId) {
        (req as any).setAuditTarget?.(authUser.loginId)
      }
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
      const allMenus = await visibleMenu()

      const menuPermissions: Record<string, {
        canView: boolean
        canCreate: boolean
        canRead: boolean
        canUpdate: boolean
        canDelete: boolean
      }> = {}

      if (user.role === 'ADMIN') {
        for (const m of allMenus) {
          if (m.code) {
            menuPermissions[m.code] = { canView: true, canCreate: true, canRead: true, canUpdate: true, canDelete: true }
          }
        }
      } else if (user.groupId) {
        const rows = await cached('cache_perm', `menu_g:${user.groupId}`, () => getUserMenuPermissions(user.groupId!))
        for (const r of rows) {
          menuPermissions[r.code] = {
            canView: r.canView,
            canCreate: r.canCreate,
            canRead: r.canRead,
            canUpdate: r.canUpdate,
            canDelete: r.canDelete,
          }
        }
      }

      const allowedMenus = allMenus.filter((m) => {
        if (user.role === 'ADMIN') return true
        const p = m.code ? menuPermissions[m.code] : undefined
        if (p && p.canView === false) {
          return false
        }
        return !m.permission || m.permission === 'common' || permissions.has(m.permission)
      })

      return {
        id: user.id,
        loginId: user.loginId,
        name: user.name,
        role: user.role,
        groupId: user.groupId,
        groupName: user.groupName,
        mustChangePassword: user.mustChangePassword,
        passwordDeferred: user.passwordDeferred,
        totpEnabled: user.totpEnabled,
        permissions: perms,
        menu: allowedMenus,
        menuPermissions,
        employeeNumber: user.employeeNumber ?? null,
        email: user.email ?? null,
        phone: user.phone ?? null,
        extensionNumber: user.extensionNumber ?? null,
        department: user.department ?? null,
        position: user.position ?? null,
        companyCode: user.companyCode ?? 'SKGAS',
        partnerCompanyName: user.partnerCompanyName ?? null,
        employmentStatus: user.employmentStatus ?? 'ACTIVE',
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
        previousLoginAt: user.previousLoginAt ? new Date(user.previousLoginAt).toISOString() : null,
        createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
        layoutMode: user.layoutMode ?? 'both',
        sidebarPinned: user.sidebarPinned ?? false,
      }
    },
  })

  // 마이페이지 — 본인의 연락처 정보(이메일, 휴대전화, 내선번호) 및 레이아웃 수정
  defineRoute(app, {
    method: 'PUT',
    url: '/auth/profile',
    access: AUTHENTICATED,
    audit: { screen: '마이페이지', action: '내 정보 수정' },
    schema: {
      body: UpdateProfileRequest,
      response: { 200: z.object({ ok: z.literal(true) }), 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = req.body as UpdateProfileRequest
      await updateMyProfile(req.auth.user.id, {
        email: b.email,
        phone: b.phone,
        extensionNumber: b.extensionNumber,
        layoutMode: b.layoutMode,
        sidebarPinned: b.sidebarPinned,
      })
      req.setAuditTarget(req.auth.user.loginId)
      return { ok: true as const }
    },
  })

  // 화면 레이아웃 및 사이드바 핀 고정 설정
  defineRoute(app, {
    method: 'PUT',
    url: '/auth/layout',
    access: AUTHENTICATED,
    audit: { screen: '마이페이지', action: '화면 레이아웃 설정' },
    schema: {
      body: UpdateLayoutRequest,
      response: { 200: z.object({ ok: z.literal(true) }), 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = req.body as UpdateLayoutRequest
      await updateMyProfile(req.auth.user.id, {
        layoutMode: b.layoutMode,
        sidebarPinned: b.sidebarPinned,
      })
      req.setAuditTarget(req.auth.user.loginId)
      return { ok: true as const }
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
