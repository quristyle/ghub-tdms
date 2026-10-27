import type { AuditQuery, GroupSaveRequest, UserCreateRequest, UserUpdateRequest } from '@tdms/contracts'
import { LEAF_KEY_SET } from '@tdms/contracts'
import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { Errors } from '../../core/errors.js'
import { encodeCursor } from '../../core/cursor.js'
import { hashPassword, initialPassword } from '../../core/password.js'
import { destroyAllSessions } from '../../core/session.js'
import * as jobs from '../jobs/service.js'
import * as q from './queries.js'

// ── 시스템 로그 ─────────────────────────────────────────────────────────

type AuditSortable = { occurredAt: Date; userName: string | null; screen: string | null
  action: string | null; target: string | null; clientIp: string | null }

function auditCursorValue(r: AuditSortable, sort: string): string {
  switch (sort) {
    case 'userName': return r.userName ?? ''
    case 'screen':   return r.screen ?? ''
    case 'action':   return r.action ?? ''
    case 'target':   return r.target ?? ''
    case 'clientIp': return r.clientIp ?? ''
    default:         return r.occurredAt.toISOString()
  }
}

export async function audit(qp: AuditQuery) {
  const rows = await q.listAudit(qp)
  const hasMore = rows.length > qp.limit
  const items = hasMore ? rows.slice(0, qp.limit) : rows
  const last = items.at(-1)

  return {
    items: items.map((a) => ({
      id: a.id,
      occurredAt: a.occurredAt.toISOString(),
      userName: a.userName,
      screen: a.screen,
      action: a.action,
      target: a.target,
      detail: a.detail,
      clientIp: a.clientIp,
    })),
    // 커서는 **지금 정렬 중인 칸**의 값을 담아야 한다. 늘 시각을 담으면
    // 다른 칸으로 정렬했을 때 다음 쪽이 엉뚱한 곳에서 이어진다.
    nextCursor:
      hasMore && last
        ? encodeCursor({ sortValue: auditCursorValue(last, qp.sort), id: last.id })
        : null,
    total: qp.cursor ? null : await q.countAudit(qp),
  }
}

export async function auditMeta(canSelectOtherUser: boolean, selfId: number, selfName: string) {
  const [screens, actions, users] = await q.auditMeta()
  return {
    screens: screens.map((r) => r.v),
    actions: actions.map((r) => r.v),
    // 다른 사용자를 고를 권한이 없으면 자기 이름만 (기존 정책: "N 선택시 이름만 조회 가능")
    users: canSelectOtherUser ? users : [{ id: selfId, name: selfName }],
    canSelectOtherUser,
  }
}

// ── 사용자 관리 ─────────────────────────────────────────────────────────

export async function users() {
  return {
    items: (await q.listUsers()).map((u) => ({
      ...u,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      previousLoginAt: u.previousLoginAt ? u.previousLoginAt.toISOString() : null,
      syncedAt: u.syncedAt ? u.syncedAt.toISOString() : null,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    })),
  }
}

export async function partnerCompanies() {
  return { items: await q.listPartnerCompanies() }
}

export async function createUser(v: UserCreateRequest) {
  return tx(async (c) => {
    if ((await q.findByLoginId(c, v.loginId)).rows.length) {
      throw Errors.conflict('LOGIN_ID_TAKEN', `아이디 "${v.loginId}" 가 이미 있습니다.`)
    }
    // 초기 비밀번호는 'ghub' + 아이디. 첫 로그인 때 변경 화면이 열린다 (기존 CM 규칙).
    const hash = await hashPassword(initialPassword(v.loginId))
    const id = await q.insertUser(c, { ...v, passwordHash: hash })
    return { id }
  })
}

export async function updateUser(id: number, v: UserUpdateRequest, actorId: number) {
  await tx(async (c) => {
    const found = await q.userById(c, id)
    const user = found.rows[0]
    if (!user) throw Errors.notFound('계정')

    // 재직 상태와 로그인 가능 여부가 어긋나면 "퇴직인데 로그인되는" 계정이 생긴다.
    // 상태만 바꿨으면 is_active 를 따라오게 한다(재직=사용, 퇴직·삭제=중지).
    const patch = { ...v }
    if (v.employmentStatus !== undefined && v.isActive === undefined) {
      patch.isActive = v.employmentStatus === 'ACTIVE'
    }

    // 마지막 관리자를 잃으면 아무도 권한을 고칠 수 없게 된다
    const losingAdmin =
      (v.role !== undefined && v.role !== 'ADMIN' && user.role === 'ADMIN') ||
      (patch.isActive === false && user.role === 'ADMIN')
    if (losingAdmin && (await q.activeAdminCount(c, id)) === 0) {
      throw Errors.conflict('LAST_ADMIN', '마지막 관리자는 내리거나 중지할 수 없습니다.')
    }

    await q.updateUser(c, id, patch)
    if (patch.isActive === false) await destroyAllSessions(id)
    void actorId
  })
  await invalidate('cache_perm')
}

export async function resetPassword(id: number) {
  await tx(async (c) => {
    const found = await q.userById(c, id)
    const user = found.rows[0]
    if (!user) throw Errors.notFound('계정')
    await q.resetPassword(c, id, await hashPassword(initialPassword(user.login_id)))
  })
  // 비밀번호가 바뀌면 그 사람의 세션을 전부 끊는다 (기존 정책)
  await destroyAllSessions(id)
  return { ok: true as const, rule: '초기 비밀번호는 ghub + 아이디 입니다. 첫 로그인 때 변경 화면이 열립니다.' }
}

// ── 권한 관리 ───────────────────────────────────────────────────────────

export async function groups() {
  return { items: await q.listGroups() }
}

export async function createGroup(v: GroupSaveRequest) {
  const id = await tx((c) => q.insertGroup(c, v.name, v.description))
  return { id }
}

export async function updateGroup(id: number, v: GroupSaveRequest) {
  const g = await q.findGroupById(id)
  if (!g) throw Errors.notFound('그룹')
  await tx((c) => q.updateGroup(c, id, v.name, v.description))
}

export async function deleteGroup(id: number) {
  const g = await q.findGroupById(id)
  if (!g) throw Errors.notFound('그룹')
  await tx((c) => q.deleteGroup(c, id))
  await invalidate('cache_perm')
}

export async function members(groupId: number) {
  return { items: await q.groupMembers(groupId) }
}

export async function permissions(groupId: number) {
  const rows = await q.grantedPermissions(groupId)
  return { groupId, granted: rows.map((r) => r.permission_key) }
}

/**
 * 권한 저장 — 화면이 보낸 것이 그 그룹의 전부다(통째로 교체).
 *
 * 트리 구조는 코드에 고정되어 있으므로 **트리에 없는 키는 거부한다.**
 * 그래야 실제로 없는 기능에 권한이 생기는 일이 없다 (기존 정책).
 */
export async function setPermissions(groupId: number, granted: string[]) {
  const unknown = granted.filter((k) => !LEAF_KEY_SET.has(k))
  if (unknown.length) {
    throw Errors.invalid('UNKNOWN_PERMISSION', `권한 트리에 없는 항목입니다: ${unknown.join(', ')}`)
  }
  await tx((c) => q.replacePermissions(c, groupId, granted))
  // 권한 캐시를 즉시 비운다 — 다음 요청부터 바로 적용된다
  await invalidate('cache_perm')
  return { groupId, granted }
}

// ── 백업 관리 ───────────────────────────────────────────────────────────

export async function backupStatus() {
  const [tables, blobs, last] = await q.backupStatus()
  return {
    dbTables: tables?.tables ?? 0,
    fileCount: blobs?.files ?? 0,
    totalBytes: Number(blobs?.bytes ?? 0),
    lastFullAt: last?.lastFullAt ? last.lastFullAt.toISOString() : null,
    lastIncrementalAt: last?.lastIncrementalAt ? last.lastIncrementalAt.toISOString() : null,
    lastBy: last?.lastBy ?? null,
  }
}

export async function backups() {
  return {
    items: (await q.listBackups()).map((r) => ({
      ...r,
      kind: r.kind as 'FULL' | 'INCREMENTAL',
      state: r.state as never,
      lastDownloadAt: r.lastDownloadAt ? r.lastDownloadAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

export async function runBackup(
  v: { kind: 'FULL' | 'INCREMENTAL'; scope: string[]; storagePath: string | null; compressed: boolean },
  userId: number,
) {
  const runId = await tx(async (c) => {
    const seq = await q.nextSeq(c, v.kind)
    return q.insertBackupRun(c, { seq, ...v, userId })
  })

  // 실제로 뜨는 일(pg_dump·restic)은 워커가 한다
  const jobId = await jobs.create('backup', { runId, ...v }, userId)
  await tx((c) => q.linkBackupJob(c, runId, jobId))
  return { runId, jobId }
}

export async function setBackupNote(runId: number, note: string | null) {
  await tx((c) => q.setBackupNote(c, runId, note))
}

/** 파일만 지운다 — 이력 줄은 어떤 경우에도 안 지워진다 (기존 정책) */
export async function deleteBackupFile(runId: number) {
  await tx((c) => q.markBackupFileDeleted(c, runId))
}

// ── 메뉴 관리 ───────────────────────────────────────────────────────────

export function menus() {
  return q.listMenus().then((items) => ({
    items: items.map((m) => ({ ...m, updatedAt: m.updatedAt.toISOString() })),
  }))
}

/**
 * 메뉴 저장.
 *
 * 고유 식별자(id 또는 code)로 기존 메뉴와 매핑하며, 경로·이름·순서·사용여부를 저장한다.
 * 자물쇠 걸린 메뉴(메뉴관리 자신)는 끌 수 없다.
 */
export async function saveMenus(
  items: { id?: number; code?: string; path: string; label: string; category?: string; isEnabled: boolean }[],
  userId: number,
) {
  const known = await q.listMenus()
  const knownById = new Map(known.map((m) => [m.id, m]))
  const knownByCode = new Map(known.map((m) => [m.code, m]))
  const knownByPath = new Map(known.map((m) => [m.path, m]))

  // Match items with known menu records
  const resolved = items.map((item) => {
    let match = item.id !== undefined ? knownById.get(item.id) : undefined
    if (!match && item.code) match = knownByCode.get(item.code)
    if (!match && item.path) match = knownByPath.get(item.path)
    return { item, match }
  })

  const unknown = resolved.filter((r) => !r.match)
  if (unknown.length) {
    throw Errors.invalid('UNKNOWN_MENU', `없는 메뉴입니다: ${unknown.map((u) => u.item.path).join(', ')}`)
  }

  const matchedIds = new Set(resolved.map((r) => r.match!.id))
  if (matchedIds.size !== items.length) {
    throw Errors.invalid('DUPLICATE_MENU', '같은 메뉴가 두 번 들어 있습니다.')
  }

  const missing = known.filter((m) => !matchedIds.has(m.id))
  if (missing.length) {
    throw Errors.invalid('MENU_MISSING', `빠진 메뉴가 있습니다: ${missing.map((m) => m.label).join(', ')}`)
  }

  // 경로 정규화 및 유효성 검사
  const normalized = resolved.map(({ item, match }) => {
    let p = item.path.trim()
    if (!p.startsWith('/')) p = `/${p}`
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '')
    const cat = item.category?.trim() || match!.category || '일반'
    return {
      id: match!.id,
      code: match!.code,
      path: p,
      label: item.label.trim(),
      category: cat,
      isEnabled: item.isEnabled,
    }
  })

  // 중복 경로 검사
  const paths = normalized.map((m) => m.path)
  if (new Set(paths).size !== paths.length) {
    throw Errors.invalid('DUPLICATE_PATH', '중복된 경로가 있습니다.')
  }

  // 자물쇠 걸린 메뉴(메뉴관리 자신)를 끄면 되돌릴 화면이 없어진다.
  const fixedIds = new Set(known.filter((m) => m.isFixed).map((m) => m.id))
  const lockedOff = normalized.filter((m) => fixedIds.has(m.id) && !m.isEnabled)
  if (lockedOff.length) {
    throw Errors.conflict(
      'MENU_LOCKED',
      `${lockedOff.map((m) => m.label).join(', ')} 은(는) 끌 수 없습니다 — 되돌릴 화면이 없어집니다.`,
    )
  }

  await q.saveMenus(normalized, userId)
  await invalidate('cache_menu')
  return menus()
}

// ── 접속권한 관리 — 사용자 개인 권한 (0016) ─────────────────────────────

/**
 * 한 사람의 권한 현황.
 *
 * 개인 권한과 그룹 권한을 **나눠서** 내려준다. 화면이 합쳐 놓으면 운영자가
 * "이건 내가 준 건가, 그룹에서 오는 건가" 를 구분하지 못해, 지우려 해도 안 지워지는
 * 체크박스를 만나게 된다.
 */
export async function userPermissions(userId: number) {
  const user = await q.findUser(userId)
  if (!user) throw Errors.notFound('계정')

  const [own, group] = await Promise.all([
    q.userGrantedPermissions(userId),
    user.groupId === null
      ? Promise.resolve([])
      : q.grantedPermissions(user.groupId),
  ])

  return {
    userId,
    granted: own.map((r) => r.permission_key),
    fromGroup: group.map((r) => r.permission_key),
    groupId: user.groupId,
    groupName: user.groupName,
    isAdmin: user.role === 'ADMIN',
  }
}

/**
 * 개인 권한 저장 — 보낸 것이 그 사람의 개인 권한 전부다(통째로 교체).
 *
 * 그룹에서 이미 오는 권한을 개인에도 적으면 지울 수 없는 중복이 된다
 * (합집합이라 결과가 같고, 나중에 그룹에서 내려도 개인 쪽이 남아 안 내려간다).
 * 그래서 **그룹에 있는 키는 받지 않는다** — 화면도 그 칸을 상속으로 잠근다.
 */
export async function setUserPermissions(userId: number, granted: string[], actorId: number) {
  const user = await q.findUser(userId)
  if (!user) throw Errors.notFound('계정')

  const unknown = granted.filter((k) => !LEAF_KEY_SET.has(k))
  if (unknown.length) {
    throw Errors.invalid('UNKNOWN_PERMISSION', `권한 트리에 없는 항목입니다: ${unknown.join(', ')}`)
  }

  if (user.groupId !== null) {
    const group = new Set((await q.grantedPermissions(user.groupId)).map((r) => r.permission_key))
    const dup = granted.filter((k) => group.has(k))
    if (dup.length) {
      throw Errors.invalid(
        'ALREADY_FROM_GROUP',
        `소속 그룹에서 이미 오는 권한입니다: ${dup.join(', ')}`,
      )
    }
  }

  await tx((c) => q.replaceUserPermissions(c, userId, granted, actorId))
  await invalidate('cache_perm')
  return userPermissions(userId)
}

export async function ownPermissionCounts() {
  const rows = await q.usersWithOwnPermissions()
  return { items: rows.map((r) => ({ userId: Number(r.userId), count: r.n })) }
}
