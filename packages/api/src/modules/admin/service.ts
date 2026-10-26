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
    nextCursor:
      hasMore && last ? encodeCursor({ sortValue: last.occurredAt.toISOString(), id: last.id }) : null,
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
  await tx((c) => q.updateGroup(c, id, v.name, v.description))
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
