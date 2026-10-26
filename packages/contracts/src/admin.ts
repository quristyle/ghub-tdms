import { z } from 'zod'
import { PageQuery, SortDir, pageResult } from './common.js'

/** 운영 화면 — 시스템 로그 / 사용자·권한 / 백업 (기존 화면 7·8·9·10) */

// ── 시스템 로그 ─────────────────────────────────────────────────────────

/**
 * 정렬할 수 있는 칸.
 *
 * **서버가 정렬한다.** 불러온 300건만 정렬하면 "가장 오래된 기록"이 실제로는
 * 아닐 수 있다 — 수십만 건 중 앞 300건만 보고 고른 것이기 때문이다.
 * keyset 커서도 이 칸을 기준으로 움직인다.
 */
export const AuditSort = z.enum(['occurredAt', 'userName', 'screen', 'action', 'target', 'clientIp'])
export type AuditSort = z.infer<typeof AuditSort>

export const AuditQuery = PageQuery.extend({
  sort: AuditSort.default('occurredAt'),
  dir: SortDir.default('desc'),
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

/**
 * 재직 상태 3단계 — 기존 시스템(employment_status)과 같다.
 * "삭제"도 실제로 지우지 않는다(D-6). 로그인 차단은 isActive 가 하고
 * 이 값은 표시·거르기용이다 — 둘이 어긋나지 않게 서버가 함께 움직인다.
 */
export const EmploymentStatus = z.enum(['ACTIVE', 'RETIRED', 'DELETED'])
export type EmploymentStatus = z.infer<typeof EmploymentStatus>

/** 사람이 소속된 협력업체. 도면 제작 업체(vendor)와 다른 것이다. */
export const PartnerCompanyRow = z.object({
  id: z.number().int(),
  name: z.string(),
  companyCode: z.string().nullable(),
  representative: z.string().nullable(),
  businessType: z.string().nullable(),
  isActive: z.boolean(),
  memberCount: z.number().int(),
})
export type PartnerCompanyRow = z.infer<typeof PartnerCompanyRow>

export const PartnerCompanyListResponse = z.object({ items: z.array(PartnerCompanyRow) })
export type PartnerCompanyListResponse = z.infer<typeof PartnerCompanyListResponse>

export const UserRow = z.object({
  id: z.number().int(),
  loginId: z.string(),
  name: z.string(),
  role: z.enum(['ADMIN', 'VIEWER']),
  groupId: z.number().int().nullable(),
  groupName: z.string().nullable(),
  isActive: z.boolean(),
  employmentStatus: EmploymentStatus,
  mustChangePassword: z.boolean(),
  lastLoginAt: z.string().nullable(),
  previousLoginAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),

  // ── 신원·조직 ────────────────────────────────────────────────────────
  // 반출 기록에 "누가 가져갔나"를 이름 하나로만 남기면 동명이인과 퇴직자가
  // 구분되지 않는다. 사번·부서·소속사가 그 자리를 메운다.
  employeeNumber: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  extensionNumber: z.string().nullable(),
  department: z.string().nullable(),
  position: z.string().nullable(),
  companyCode: z.string(),
  partnerCompanyId: z.number().int().nullable(),
  partnerCompanyName: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  hireDate: z.string().nullable(),
  /** 포털에서 마지막으로 받아 온 시각. 손으로 만든 계정은 null. */
  syncedAt: z.string().nullable(),
})
export type UserRow = z.infer<typeof UserRow>

export const UserListResponse = z.object({ items: z.array(UserRow) })
export type UserListResponse = z.infer<typeof UserListResponse>

/** 신원·연락처 — 추가와 수정이 같은 모양이라 한 벌로 쓴다. */
const UserProfileFields = {
  employeeNumber: z.string().max(32).nullable().default(null),
  email: z.string().max(200).nullable().default(null),
  phone: z.string().max(40).nullable().default(null),
  extensionNumber: z.string().max(40).nullable().default(null),
  department: z.string().max(100).nullable().default(null),
  position: z.string().max(100).nullable().default(null),
  companyCode: z.string().max(40).default('SKGAS'),
  partnerCompanyId: z.number().int().nullable().default(null),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
}

export const UserCreateRequest = z.object({
  loginId: z.string().min(2).max(64).regex(/^[A-Za-z0-9_.-]+$/, '영문·숫자·._- 만 쓸 수 있습니다'),
  name: z.string().min(1).max(100),
  role: z.enum(['ADMIN', 'VIEWER']).default('VIEWER'),
  groupId: z.number().int().nullable().default(null),
  ...UserProfileFields,
})
export type UserCreateRequest = z.infer<typeof UserCreateRequest>

export const UserUpdateRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['ADMIN', 'VIEWER']).optional(),
  groupId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
  employmentStatus: EmploymentStatus.optional(),
  employeeNumber: z.string().max(32).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  extensionNumber: z.string().max(40).nullable().optional(),
  department: z.string().max(100).nullable().optional(),
  position: z.string().max(100).nullable().optional(),
  companyCode: z.string().max(40).optional(),
  partnerCompanyId: z.number().int().nullable().optional(),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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

// ── 메뉴 관리 ───────────────────────────────────────────────────────────
// 줄을 늘리거나 지우지 않는다 — 경로는 SPA 라우터에, 권한 키는 권한 트리에 묶여 있다.
// 바꿀 수 있는 것은 이름·표시 순서·사용여부 셋뿐이다(0015 마이그레이션 머리글 참조).

export const MenuAdminRow = z.object({
  path: z.string(),
  permissionKey: z.string(),
  label: z.string(),
  sortOrder: z.number().int(),
  isEnabled: z.boolean(),
  /** 끌 수 없는 메뉴 — 메뉴관리 자신. 화면이 토글을 잠그는 데 쓴다. */
  isFixed: z.boolean(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
})
export type MenuAdminRow = z.infer<typeof MenuAdminRow>

export const MenuListResponse = z.object({ items: z.array(MenuAdminRow) })
export type MenuListResponse = z.infer<typeof MenuListResponse>

/**
 * 저장은 통째로 받는다 — 순서를 한 줄씩 보내면 중간 상태에서 sort_order 가 겹친다.
 * 보낸 경로가 DB 의 경로 집합과 정확히 같아야 한다(서버가 검사한다).
 */
export const MenuSaveRequest = z.object({
  items: z.array(z.object({
    path: z.string().min(1),
    label: z.string().trim().min(1, '메뉴 이름을 비울 수 없습니다').max(40),
    isEnabled: z.boolean(),
  })).min(1),
})
export type MenuSaveRequest = z.infer<typeof MenuSaveRequest>

// ── 접속권한 관리 (0016) ────────────────────────────────────────────────
// 그룹 권한은 기존 /groups/:id/permissions 를 그대로 쓴다 — 새 화면과 기존
// [사용자 관리 > 권한 관리] 탭이 **같은 API** 를 지나므로 두 화면이 갈라지지 않는다.

export const UserPermissionsResponse = z.object({
  userId: z.number().int(),
  /** 이 사람에게 직접 준 권한 */
  granted: z.array(z.string()),
  /** 소속 그룹에서 오는 권한 — 화면이 "상속" 으로 흐리게 보여준다 */
  fromGroup: z.array(z.string()),
  groupId: z.number().int().nullable(),
  groupName: z.string().nullable(),
  /** ADMIN 은 권한 트리와 무관하게 전부 통과한다 */
  isAdmin: z.boolean(),
})
export type UserPermissionsResponse = z.infer<typeof UserPermissionsResponse>

export const UserPermissionsRequest = z.object({
  granted: z.array(z.string()).max(200),
})
export type UserPermissionsRequest = z.infer<typeof UserPermissionsRequest>

/** 개인 권한을 따로 가진 사람 — 목록에 표시를 붙인다 */
export const OwnPermissionCount = z.object({
  userId: z.number().int(),
  count: z.number().int(),
})
export const OwnPermissionCounts = z.object({ items: z.array(OwnPermissionCount) })
export type OwnPermissionCounts = z.infer<typeof OwnPermissionCounts>
