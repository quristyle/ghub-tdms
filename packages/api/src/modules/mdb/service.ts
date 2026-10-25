import type pg from 'pg'
import type { MdbListQuery, MdbUpdateRequest } from '@tdms/contracts'
import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { encodeCursor } from '../../core/cursor.js'
import { Errors } from '../../core/errors.js'
import * as archive from '../archive/service.js'
import * as folders from '../folders/service.js'
import * as folderQ from '../folders/queries.js'
import * as q from './queries.js'

const DOC_CLASS = 'MDB' as const

// ── 조회 ────────────────────────────────────────────────────────────────

function toItem(r: q.MdbRow) {
  return {
    id: r.id,
    title: r.title,
    displayName: r.displayName,
    folderId: r.folderId,
    folderName: r.folderName,
    fileExt: r.fileExt,
    byteSize: r.byteSize,
    equipmentType: r.equipmentType,
    docType: r.docType,
    projectName: r.projectName,
    year: r.year,
    isShared: r.isShared,
    needsCheck: r.needsCheck,
    tagCount: r.tagCount,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function list(qp: MdbListQuery) {
  const folderIds = await folders.scopeIds(DOC_CLASS, qp.folderId, qp.recursive)
  const rows = await q.listMdb(folderIds, qp)
  const hasMore = rows.length > qp.limit
  const items = hasMore ? rows.slice(0, qp.limit) : rows
  const last = items.at(-1)

  return {
    items: items.map(toItem),
    nextCursor:
      hasMore && last
        ? encodeCursor({ sortValue: last.updatedAt.toISOString(), id: last.id })
        : null,
    total: qp.cursor ? null : await q.countMdb(folderIds, qp),
  }
}

export async function detail(id: number) {
  const row = await q.findMdb(id)
  if (!row) throw Errors.notFound('자료')
  const [chain, tags] = await Promise.all([folders.ancestorChain(row.folderId), q.listTags(id)])
  return {
    ...toItem(row),
    originalFilename: row.originalFilename,
    note: row.note,
    folderPath: chain,
    tags: tags.map((t) => t.tag_no),
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function meta() {
  const [equip, docTypes, projects, years] = await q.meta()
  return {
    equipmentTypes: equip.map((r) => r.v),
    docTypes: docTypes.map((r) => r.v),
    projects,
    years: years.map((r) => r.v),
  }
}

export async function suggestTags(prefix: string) {
  return { items: (await q.suggestTags(prefix)).map((r) => r.tag_no) }
}

// ── 관리 ────────────────────────────────────────────────────────────────

export async function update(id: number, v: MdbUpdateRequest) {
  await tx(async (c) => {
    const found = await q.mdbBrief(c, [id])
    if (!found.rows.length) throw Errors.notFound('자료')
    await q.updateMdb(c, id, v)
    if (v.tags !== undefined) await q.replaceTags(c, id, v.tags)
  })
}

export async function move(fileIds: number[], targetFolderId: number) {
  const out = await tx(async (c) => {
    const target = await folderQ.findById(targetFolderId)
    if (!target || target.isPlaceholder === undefined) throw Errors.notFound('옮길 폴더')

    // 같은 이름이 이미 있는 건만 건너뛴다 — 전체를 막지 않는다
    const conflicts = await q.conflictingTitles(c, targetFolderId, fileIds)
    const skip = new Set(conflicts.rows.map((r) => r.id))
    const movable = fileIds.filter((id) => !skip.has(id))

    return {
      updated: movable.length ? await q.moveMdb(c, movable, targetFolderId) : 0,
      skipped: conflicts.rows.map((r) => ({
        fileId: r.id,
        reason: `옮길 폴더에 "${r.title}" 이(가) 이미 있습니다.`,
      })),
    }
  })
  await invalidate('cache_tree')
  return out
}

/** 설비유형 일괄 변경 — 기존 화면의 전용 기능 */
export async function bulkEquipmentType(fileIds: number[], equipmentType: string | null) {
  const updated = await tx((c) => q.bulkEquipmentType(c, fileIds, equipmentType))
  return { updated, skipped: [] }
}

// ── 보관함 (기구는 modules/archive 공용) ────────────────────────────────

async function briefOf(c: pg.PoolClient, ids: number[]) {
  const r = await q.mdbBrief(c, ids)
  return r.rows.map((m) => ({
    id: m.id, label: m.title, folderId: m.folder_id, isArchived: m.is_archived,
  }))
}

export function sendToTrash(
  v: { fileIds: number[]; folderId: number | null; reason: string | null }, userId: number,
) {
  return archive.sendToTrash(
    DOC_CLASS, { itemIds: v.fileIds, folderId: v.folderId, reason: v.reason }, userId, briefOf,
  )
}

export function retire(fileIds: number[], reason: string | null, userId: number) {
  return archive.retire(DOC_CLASS, fileIds, reason, userId, briefOf)
}

export function listBox(kind: 'TRASH' | 'RETIRE') {
  return archive.listBox(DOC_CLASS, kind)
}

export function purge(batchIds: number[], userId: number) {
  return archive.purge(batchIds, userId, (c, id) => q.purgeBatch(c, id))
}

export const setNote = archive.setNote
export const restore = archive.restore
