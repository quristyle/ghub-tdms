import type pg from 'pg'
import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { Errors } from '../../core/errors.js'
import * as archive from '../archive/service.js'
import * as q from './queries.js'

export type DocClass = 'TDB' | 'MDB'

/**
 * TDB 관리.
 *
 * 폴더가 1급 테이블이라 이름 변경·이동이 DB 작업만으로 끝난다 — 디스크를 건드리지 않는다.
 * 52,000건 실측에서 이름 변경 0.89ms, 이동 8.16ms 였다.
 *
 * 삭제는 없다. 보관함으로 옮기고 복구할 수 있게 한다(D-6).
 * 완전 삭제는 **삭제 보관함에만** 있고 폐기 보관함에는 없다 — 폐기는 이력을 찾으려고
 * 남겨 두는 것이기 때문이다.
 */

const DOC_CLASS: DocClass = 'TDB'

// ── 폴더 편집 ───────────────────────────────────────────────────────────

export async function createFolder(
  docClass: DocClass, parentId: number | null, name: string, userId: number,
) {
  const id = await tx(async (c) => {
    if ((await q.nameTaken(c, parentId, name)).rows.length) {
      throw Errors.conflict('NAME_TAKEN', `같은 자리에 "${name}" 폴더가 이미 있습니다.`)
    }
    return q.createFolder(c, docClass, parentId, name, userId)
  })
  await invalidate('cache_tree')
  return { ok: true as const, folderId: id, affectedFolders: 0 }
}

export async function renameFolder(id: number, name: string) {
  await tx(async (c) => {
    const f = await q.folderById(c, id)
    if (!f) throw Errors.notFound('폴더')
    if ((await q.nameTaken(c, f.parent_id, name, id)).rows.length) {
      throw Errors.conflict('NAME_TAKEN', `같은 자리에 "${name}" 폴더가 이미 있습니다.`)
    }
    await q.renameFolder(c, id, name)
  })
  await invalidate('cache_tree')
  return { ok: true as const, folderId: id, affectedFolders: 0 }
}

export async function moveFolder(id: number, newParentId: number | null) {
  const affected = await tx(async (c) => {
    const f = await q.folderById(c, id)
    if (!f) throw Errors.notFound('폴더')
    if (newParentId !== null) {
      const target = await q.folderById(c, newParentId)
      if (!target) throw Errors.notFound('옮길 자리')
      if (target.doc_class !== f.doc_class) {
        throw Errors.invalid('CLASS_MISMATCH', 'TDB 와 MDB 사이로는 옮길 수 없습니다.')
      }
    }
    if ((await q.nameTaken(c, newParentId, f.name, id)).rows.length) {
      throw Errors.conflict('NAME_TAKEN', `옮길 자리에 "${f.name}" 폴더가 이미 있습니다.`)
    }
    // folder_reparent() 가 순환(자기 하위로 이동)을 막는다
    try {
      return await q.moveFolder(c, id, newParentId)
    } catch (e) {
      if (e instanceof Error && e.message.includes('자기 하위')) {
        throw Errors.invalid('CIRCULAR_MOVE', '폴더를 자기 하위로 옮길 수 없습니다.')
      }
      throw e
    }
  })
  await invalidate('cache_tree')
  return { ok: true as const, folderId: id, affectedFolders: affected }
}

// ── 자료 편집 ───────────────────────────────────────────────────────────

export async function renameDocument(
  id: number, v: { drawingNo?: string; title?: string; note?: string | null },
) {
  await tx(async (c) => {
    const found = await q.documentsBrief(c, [id])
    if (!found.rows.length) throw Errors.notFound('자료')
    await q.renameDocument(c, id, v)
  })
  return { ok: true as const, folderId: 0, affectedFolders: 0 }
}

export async function moveDocuments(documentIds: number[], targetFolderId: number) {
  const out = await tx(async (c) => {
    const target = await q.folderById(c, targetFolderId)
    if (!target || target.is_archived) throw Errors.notFound('옮길 폴더')

    // 대상 폴더에 같은 도면번호가 있으면 그 건만 건너뛴다 — 전체를 막지 않는다
    const conflicts = await q.conflictingInFolder(c, targetFolderId, documentIds)
    const skipIds = new Set(conflicts.rows.map((r) => r.id))
    const movable = documentIds.filter((id) => !skipIds.has(id))

    const moved = movable.length ? await q.moveDocuments(c, movable, targetFolderId) : 0
    return {
      moved,
      skipped: conflicts.rows.map((r) => ({
        documentId: r.id,
        reason: `옮길 폴더에 "${r.drawing_no}" 가 이미 있습니다.`,
      })),
    }
  })
  await invalidate('cache_tree')
  return out
}

// ── 보관함 ──────────────────────────────────────────────────────────────
//
// 기구는 modules/archive 에 있다 — TDB·MDB 가 같은 규칙을 쓰기 때문이다.
// 여기서는 TDB 전용인 부분(자료 요약 읽기, 완전 삭제 시 딸린 표 정리)만 넘긴다.

async function briefOf(c: pg.PoolClient, ids: number[]) {
  const r = await q.documentsBrief(c, ids)
  return r.rows.map((d) => ({
    id: d.id, label: d.drawing_no, folderId: d.folder_id, isArchived: d.is_archived,
  }))
}

export function sendToTrash(
  v: { documentIds: number[]; folderId: number | null; reason: string | null },
  userId: number,
) {
  return archive.sendToTrash(
    DOC_CLASS, { itemIds: v.documentIds, folderId: v.folderId, reason: v.reason }, userId, briefOf,
  )
}

export function retire(documentIds: number[], reason: string | null, userId: number) {
  return archive.retire(DOC_CLASS, documentIds, reason, userId, briefOf)
}

export function listBox(kind: 'TRASH' | 'RETIRE') {
  return archive.listBox(DOC_CLASS, kind)
}

export const setNote = archive.setNote
export const restore = archive.restore

export function purge(batchIds: number[], userId: number) {
  return archive.purge(batchIds, userId, (c, id) => q.purgeBatch(c, id))
}

// ── 원본·사본 분리 폴더 ─────────────────────────────────────────────────

export async function pairFolderCandidates() {
  return { items: await q.pairFolderCandidates(DOC_CLASS) }
}

export async function mergePairFolders(parentId: number, dwgFolderId: number, pdfFolderId: number) {
  const merged = await tx(async (c) => {
    const parent = await q.folderById(c, parentId)
    if (!parent) throw Errors.notFound('상위 폴더')
    return q.mergePairFolders(c, parentId, dwgFolderId, pdfFolderId)
  })
  await invalidate('cache_tree')
  return { merged, skipped: 0 }
}
