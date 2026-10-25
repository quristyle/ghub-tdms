import { z } from 'zod'
import { PageQuery, pageResult } from './common.js'

/** 운영 화면 — 시스템 로그 / 사용자·권한 / 백업 (기존 화면 7·8·9·10) */

// ── 시스템 로그 ─────────────────────────────────────────────────────────

export const AuditQuery = PageQuery.extend({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  screen: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  /** 'screen.audit.viewer.other_user' 가 없으면 자기 것만 볼 수 있다 */
  userId: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
})
export type AuditQuery = z.infer<typeof AuditQuery>

export const AuditEntry = z.object({
  id: z.number().int(),
  occurredAt: z.string(),
  userName: z.string().nullable(),
  screen: z.string().nullable(),
  action: z.string().nullable(),
  target: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  clientIp: z.string().nullable(),
})
export type AuditEntry = z.infer<typeof AuditEntry>

export const AuditListResponse = pageResult(AuditEntry)
export type AuditListResponse = z.infer<typeof AuditListResponse>

/** 검색 선택지 — 실제로 기록된 화면·동작만 */
export const AuditMeta = z.object({
  screens: z.array(z.string()),
  actions: z.array(z.string()),
  users: z.array(z.object({ id: z.number().int(), name: z.string() })),
  canSelectOtherUser: z.boolean(),
})
export type AuditMeta = z.infer<typeof AuditMeta>

// ── 사용자 관리 ─────────────────────────────────────────────────────────

export const UserRow = z.object({
  id: z.number().int(),
  loginId: z.string(),
  name: z.string(),
  role: z.enum(['ADMIN', 'VIEWER']),
  groupId: z.number().int().nullable(),
  groupName: z.string().nullable(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type UserRow = z.infer<typeof UserRow>

export const UserListResponse = z.object({ items: z.array(UserRow) })
export type UserListResponse = z.infer<typeof UserListResponse>

export const UserCreateRequest = z.object({
  loginId: z.string().min(2).max(64).regex(/^[A-Za-z0-9_.-]+$/, '영문·숫자·._- 만 쓸 수 있습니다'),
  name: z.string().min(1).max(100),
  role: z.enum(['ADMIN', 'VIEWER']).default('VIEWER'),
  groupId: z.number().int().nullable().default(null),
})
export type UserCreateRequest = z.infer<typeof UserCreateRequest>

export const UserUpdateRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['ADMIN', 'VIEWER']).optional(),
  groupId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
})
export type UserUpdateRequest = z.infer<typeof UserUpdateRequest>

/** 비밀번호 초기화 — 초기값은 'ghub' + 아이디 (기존 CM 규칙) */
export const PasswordResetResult = z.object({
  ok: z.literal(true),
  /** 화면에 안내할 초기 비밀번호 규칙 (값 자체는 돌려주지 않는다) */
  rule: z.string(),
})
export type PasswordResetResult = z.infer<typeof PasswordResetResult>

// ── 권한 관리 ───────────────────────────────────────────────────────────

export const GroupRow = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int(),
  permissionCount: z.number().int(),
})
export type GroupRow = z.infer<typeof GroupRow>

export const GroupListResponse = z.object({ items: z.array(GroupRow) })
export type GroupListResponse = z.infer<typeof GroupListResponse>

export const GroupSaveRequest = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().default(null),
})
export type GroupSaveRequest = z.infer<typeof GroupSaveRequest>

export const GroupMembersResponse = z.object({
  items: z.array(z.object({ id: z.number().int(), loginId: z.string(), name: z.string() })),
})
export type GroupMembersResponse = z.infer<typeof GroupMembersResponse>

/** 권한 트리 — 구조는 코드에 고정되어 있고 여기서는 켜진 리프만 주고받는다 */
export const GroupPermissionsResponse = z.object({
  groupId: z.number().int(),
  /** 켜져 있는 리프 키 */
  granted: z.array(z.string()),
})
export type GroupPermissionsResponse = z.infer<typeof GroupPermissionsResponse>

export const GroupPermissionsRequest = z.object({
  granted: z.array(z.string()).max(200),
})
export type GroupPermissionsRequest = z.infer<typeof GroupPermissionsRequest>

// ── 백업 관리 ───────────────────────────────────────────────────────────

export const BackupScope = z.enum(['DB', 'FILES', 'CODE', 'WEB'])
export type BackupScope = z.infer<typeof BackupScope>

export const BackupStatus = z.object({
  /** 담을 항목별 현재 크기 추정 */
  dbTables: z.number().int(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  lastFullAt: z.string().nullable(),
  lastIncrementalAt: z.string().nullable(),
  lastBy: z.string().nullable(),
})
export type BackupStatus = z.infer<typeof BackupStatus>

export const BackupRunRequest = z.object({
  kind: z.enum(['FULL', 'INCREMENTAL']),
  scope: z.array(BackupScope).min(1),
  /** 외장하드 등 다른 자리에 바로 만들 때 */
  storagePath: z.string().max(500).nullable().default(null),
  compressed: z.boolean().default(true),
})
export type BackupRunRequest = z.infer<typeof BackupRunRequest>

export const BackupRunRow = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  kind: z.enum(['FULL', 'INCREMENTAL']),
  scope: z.array(z.string()),
  storagePath: z.string().nullable(),
  compressed: z.boolean(),
  byteSize: z.number().int().nullable(),
  fileCount: z.number().int().nullable(),
  missingCount: z.number().int(),
  state: z.enum(['PREPARING', 'READY', 'FAILED', 'FILE_DELETED']),
  jobId: z.number().int().nullable(),
  downloadCount: z.number().int(),
  lastDownloadAt: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
})
export type BackupRunRow = z.infer<typeof BackupRunRow>

export const BackupListResponse = z.object({ items: z.array(BackupRunRow) })
export type BackupListResponse = z.infer<typeof BackupListResponse>

export const BackupRunResult = z.object({
  runId: z.number().int(),
  jobId: z.number().int(),
})
export type BackupRunResult = z.infer<typeof BackupRunResult>
