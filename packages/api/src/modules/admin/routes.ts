import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  AuditListResponse, AuditMeta, AuditQuery, BackupListResponse, BackupRunRequest,
  BackupRunResult, BackupStatus, ErrorResponse, GroupListResponse, GroupMembersResponse,
  GroupPermissionsRequest, GroupPermissionsResponse, GroupSaveRequest,
  MenuListResponse, MenuSaveRequest, NoteRequest, NoteResult, OwnPermissionCounts,
  UserPermissionsRequest, UserPermissionsResponse,
  PERMISSION_TREE, PartnerCompanyListResponse, PartnerCompanySaveRequest, PasswordResetResult,
  UserCreateRequest, UserListResponse, UserUpdateRequest,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import { Errors } from '../../core/errors.js'
import * as svc from './service.js'

const IdParam = z.object({ id: z.coerce.number().int() })
const OTHER_USER = 'screen.audit.viewer.other_user'

interface Authed {
  auth: { user: { id: number; name: string; role: string }; permissions: ReadonlySet<string> }
}
const has = (req: unknown, key: string) => {
  const r = req as Authed
  return r.auth.user.role === 'ADMIN' || r.auth.permissions.has(key)
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // ── 시스템 로그 ──────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/audit-log',
    access: permission('screen.audit.access'),
    schema: { querystring: AuditQuery, response: { 200: AuditListResponse, 403: ErrorResponse } },
    handler: async (req) => {
      const qp = AuditQuery.parse(req.query)
      // 다른 사용자를 고를 권한이 없으면 자기 것만. 주소로 남의 id 를 넣어도 막는다.
      if (!has(req, OTHER_USER)) {
        if (qp.userId !== undefined && qp.userId !== req.auth.user.id) {
          throw Errors.forbidden(OTHER_USER)
        }
        qp.userId = req.auth.user.id
      }
      return svc.audit(qp)
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/audit-log/meta',
    access: permission('screen.audit.access'),
    schema: { response: { 200: AuditMeta, 403: ErrorResponse } },
    handler: async (req) =>
      svc.auditMeta(has(req, OTHER_USER), req.auth.user.id, req.auth.user.name),
  })

  // ── 사용자 관리 ──────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/users',
    access: permission('screen.users.access'),
    schema: { response: { 200: UserListResponse, 403: ErrorResponse } },
    handler: async () => svc.users(),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/partner-companies',
    access: permission('screen.users.access'),
    schema: { response: { 200: PartnerCompanyListResponse, 403: ErrorResponse } },
    handler: async () => svc.partnerCompanies(),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/partner-companies',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '소속사 추가' },
    schema: {
      body: PartnerCompanySaveRequest,
      response: { 200: z.object({ id: z.number().int() }), 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const b = PartnerCompanySaveRequest.parse(req.body)
      const out = await svc.createPartnerCompany(b)
      req.setAuditTarget(b.name)
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: '/partner-companies/:id',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '소속사 수정' },
    schema: {
      params: IdParam,
      body: PartnerCompanySaveRequest,
      response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = PartnerCompanySaveRequest.parse(req.body)
      await svc.updatePartnerCompany(id, b)
      req.setAuditTarget(b.name, { partnerCompanyId: id })
      return { ok: true as const }
    },
  })

  defineRoute(app, {
    method: 'DELETE',
    url: '/partner-companies/:id',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '소속사 삭제' },
    schema: {
      params: IdParam,
      response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      await svc.deletePartnerCompany(id)
      req.setAuditTarget(`소속사 ${id}`, { partnerCompanyId: id })
      return { ok: true as const }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/users',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '사용자 추가' },
    schema: {
      body: UserCreateRequest,
      response: { 200: z.object({ id: z.number().int() }), 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const b = UserCreateRequest.parse(req.body)
      const out = await svc.createUser(b)
      req.setAuditTarget(b.loginId, { role: b.role, groupId: b.groupId })
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: '/users/:id',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '사용자 수정' },
    schema: {
      params: IdParam, body: UserUpdateRequest,
      response: { 200: NoteResult, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = UserUpdateRequest.parse(req.body)
      await svc.updateUser(id, b, req.auth.user.id)
      req.setAuditTarget(`사용자 ${id}`, b as Record<string, unknown>)
      return { ok: true as const }
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/users/:id/reset-password',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '비밀번호 초기화' },
    schema: { params: IdParam, response: { 200: PasswordResetResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const out = await svc.resetPassword(id)
      req.setAuditTarget(`사용자 ${id}`)
      return out
    },
  })

  // ── 권한 관리 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/groups',
    access: permission('screen.users.access'),
    schema: { response: { 200: GroupListResponse, 403: ErrorResponse } },
    handler: async () => svc.groups(),
  })

  // 트리 구조는 코드에 고정되어 있다 — 화면이 그대로 받아 그린다
  defineRoute(app, {
    method: 'GET',
    url: '/groups/permission-tree',
    access: permission('screen.users.access'),
    schema: {
      response: {
        200: z.object({ tree: z.array(z.unknown()) }),
        403: ErrorResponse,
      },
    },
    handler: async () => ({ tree: PERMISSION_TREE }),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/groups',
    access: permission('screen.users.access'),
    audit: { screen: '권한 관리', action: '그룹 추가' },
    schema: {
      body: GroupSaveRequest,
      response: { 200: z.object({ id: z.number().int() }), 403: ErrorResponse },
    },
    handler: async (req) => {
      const b = GroupSaveRequest.parse(req.body)
      const out = await svc.createGroup(b)
      req.setAuditTarget(b.name)
      return out
    },
  })

  defineRoute(app, {
    method: 'PATCH',
    url: '/groups/:id',
    access: permission('screen.users.access'),
    audit: { screen: '권한 관리', action: '그룹 수정' },
    schema: { params: IdParam, body: GroupSaveRequest, response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = GroupSaveRequest.parse(req.body)
      await svc.updateGroup(id, b)
      req.setAuditTarget(b.name, { groupId: id })
      return { ok: true as const }
    },
  })

  defineRoute(app, {
    method: 'DELETE',
    url: '/groups/:id',
    access: permission('screen.users.access'),
    audit: { screen: '사용자 관리', action: '그룹 삭제' },
    schema: { params: IdParam, response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      await svc.deleteGroup(id)
      req.setAuditTarget(`그룹 ${id}`, { groupId: id })
      return { ok: true as const }
    },
  })

  defineRoute(app, {
    method: 'GET',
    url: '/groups/:id/members',
    access: permission('screen.users.access'),
    schema: { params: IdParam, response: { 200: GroupMembersResponse, 403: ErrorResponse } },
    handler: async (req) => svc.members(IdParam.parse(req.params).id),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/groups/:id/permissions',
    access: permission('screen.users.access'),
    schema: { params: IdParam, response: { 200: GroupPermissionsResponse, 403: ErrorResponse } },
    handler: async (req) => svc.permissions(IdParam.parse(req.params).id),
  })

  defineRoute(app, {
    method: 'PUT',
    url: '/groups/:id/permissions',
    access: permission('screen.users.access'),
    audit: { screen: '권한 관리', action: '권한 저장' },
    schema: {
      params: IdParam, body: GroupPermissionsRequest,
      response: { 200: GroupPermissionsResponse, 403: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = GroupPermissionsRequest.parse(req.body)
      const out = await svc.setPermissions(id, b.granted)
      req.setAuditTarget(`그룹 ${id}`, { count: b.granted.length })
      return out
    },
  })

  // ── 접속권한 관리 — 사용자 개인 권한 (0016) ──────────────────────────
  // 그룹 권한은 위의 /groups/:id/permissions 를 그대로 쓴다. 새 화면과 기존
  // [사용자 관리 > 권한 관리] 탭이 같은 API 를 지나므로 두 화면이 갈라지지 않는다.
  defineRoute(app, {
    method: 'GET',
    url: '/users/permission-counts',
    access: permission('screen.users.access'),
    schema: { response: { 200: OwnPermissionCounts, 403: ErrorResponse } },
    handler: async () => svc.ownPermissionCounts(),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/users/:id/permissions',
    access: permission('screen.users.access'),
    schema: {
      params: IdParam,
      response: { 200: UserPermissionsResponse, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (req) => svc.userPermissions(IdParam.parse(req.params).id),
  })

  defineRoute(app, {
    method: 'PUT',
    url: '/users/:id/permissions',
    access: permission('screen.users.access'),
    audit: { screen: '접속권한 관리', action: '개인 권한 저장' },
    schema: {
      params: IdParam, body: UserPermissionsRequest,
      response: {
        200: UserPermissionsResponse, 403: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse,
      },
    },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = UserPermissionsRequest.parse(req.body)
      const out = await svc.setUserPermissions(id, b.granted, req.auth.user.id)
      req.setAuditTarget(`계정 ${id}`, { count: b.granted.length, granted: b.granted })
      return out
    },
  })

  // ── 메뉴 관리 ────────────────────────────────────────────────────────
  // 권한은 사용자·권한 관리와 같은 리프를 쓴다(새 리프를 만들면 레거시 패리티가 깨진다).
  defineRoute(app, {
    method: 'GET',
    url: '/menus',
    access: permission('screen.users.access'),
    schema: { response: { 200: MenuListResponse, 403: ErrorResponse } },
    handler: async () => svc.menus(),
  })

  defineRoute(app, {
    method: 'PUT',
    url: '/menus',
    access: permission('screen.users.access'),
    audit: { screen: '메뉴 관리', action: '메뉴 저장' },
    schema: {
      body: MenuSaveRequest,
      response: { 200: MenuListResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
    handler: async (req) => {
      const b = MenuSaveRequest.parse(req.body)
      const out = await svc.saveMenus(b.items, req.auth.user.id)
      req.setAuditTarget(
        `메뉴 ${b.items.length}개`,
        { off: b.items.filter((m) => !m.isEnabled).map((m) => m.path) },
      )
      return out
    },
  })

  // ── 백업 관리 ────────────────────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/backup/status',
    access: permission('screen.backup.access'),
    schema: { response: { 200: BackupStatus, 403: ErrorResponse } },
    handler: async () => svc.backupStatus(),
  })

  defineRoute(app, {
    method: 'GET',
    url: '/backup/runs',
    access: permission('screen.backup.access'),
    schema: { response: { 200: BackupListResponse, 403: ErrorResponse } },
    handler: async () => svc.backups(),
  })

  defineRoute(app, {
    method: 'POST',
    url: '/backup/run',
    access: permission('screen.backup.run'),
    audit: { screen: '백업 관리', action: '백업 만들기' },
    schema: { body: BackupRunRequest, response: { 200: BackupRunResult, 403: ErrorResponse } },
    handler: async (req) => {
      const b = BackupRunRequest.parse(req.body)
      const out = await svc.runBackup(b, req.auth.user.id)
      req.setAuditTarget(`${b.kind} ${b.scope.join('+')}`, out as unknown as Record<string, unknown>)
      return out
    },
  })

  defineRoute(app, {
    method: 'POST',
    url: '/backup/runs/:id/note',
    access: permission('screen.backup.run'),
    audit: { screen: '백업 관리', action: '백업 비고 작성' },
    schema: { params: IdParam, body: NoteRequest, response: { 200: NoteResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      const b = NoteRequest.parse(req.body)
      await svc.setBackupNote(id, b.note)
      req.setAuditTarget(`백업 ${id}`, { note: b.note })
      return { ok: true as const }
    },
  })

  // 파일만 지운다 — 이력 줄은 어떤 경우에도 안 지워진다 (기존 정책)
  defineRoute(app, {
    method: 'POST',
    url: '/backup/runs/:id/delete-file',
    access: permission('screen.backup.delete_file'),
    audit: { screen: '백업 관리', action: '백업 파일 삭제' },
    schema: { params: IdParam, response: { 200: NoteResult, 403: ErrorResponse } },
    handler: async (req) => {
      const { id } = IdParam.parse(req.params)
      await svc.deleteBackupFile(id)
      req.setAuditTarget(`백업 ${id}`)
      return { ok: true as const }
    },
  })

  void AUTHENTICATED
}
