import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

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

const DOC_CLASS = 'TDB'

// ── 폴더 편집 ───────────────────────────────────────────────────────────

export async function createFolder(parentId: number | null, name: string, userId: number) {
  const id = await tx(async (c) => {
    if ((await q.nameTaken(c, parentId, name)).rows.length) {
      throw Errors.conflict('NAME_TAKEN', `같은 자리에 "${name}" 폴더가 이미 있습니다.`)
    }
    return q.createFolder(c, DOC_CLASS, parentId, name, userId)
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

/**
 * 삭제 보관함 — 폴더째 묶어 한 줄. 복구와 완전 삭제가 모두 가능하다.
 */
export async function sendToTrash(
  v: { documentIds: number[]; folderId: number | null; reason: string | null },
  userId: number,
) {
  const out = await tx(async (c) => {
    let ids = v.documentIds
    let label: string
    let originalPath: string | null = null

    if (v.folderId !== null) {
      const f = await q.folderById(c, v.folderId)
      if (!f) throw Errors.notFound('폴더')
      ids = await q.documentsUnderFolder(c, v.folderId)
      label = f.name
      originalPath = await q.folderPathText(c, v.folderId)
    } else {
      if (!ids.length) throw Errors.invalid('NO_TARGET', '보관할 자료를 골라 주세요.')
      label = `자료 ${ids.length}건`
      const first = await q.documentsBrief(c, [ids[0]!])
      const folderId = first.rows[0]?.folder_id
      if (folderId !== undefined) originalPath = await q.folderPathText(c, folderId)
    }

    const batchId = await q.createBatch(c, {
      kind: 'TRASH', docClass: DOC_CLASS, label, originalPath,
      folderId: v.folderId, reason: v.reason, itemCount: ids.length, userId,
    })
    if (ids.length) await q.archiveDocuments(c, ids, batchId, false)
    if (v.folderId !== null) await q.archiveFolderTree(c, v.folderId, batchId)

    return { batchIds: [batchId], archived: ids.length }
  })
  await invalidate('cache_tree')
  return out
}

/**
 * 폐기 보관함 — **자료 1건 = 이력 1건**.
 * 여러 건을 한 번에 폐기해도 자료마다 따로 남긴다(줄마다 비고를 쓰기 때문).
 * 완전 삭제가 없고 복구만 있다.
 */
export async function retire(documentIds: number[], reason: string | null, userId: number) {
  if (!documentIds.length) throw Errors.invalid('NO_TARGET', '폐기할 자료를 골라 주세요.')

  const out = await tx(async (c) => {
    const docs = await q.documentsBrief(c, documentIds)
    if (!docs.rows.length) throw Errors.notFound('자료')

    const batchIds: number[] = []
    for (const d of docs.rows) {
      if (d.is_archived) continue
      const batchId = await q.createBatch(c, {
        kind: 'RETIRE', docClass: DOC_CLASS,
        label: d.drawing_no,
        originalPath: await q.folderPathText(c, d.folder_id),
        folderId: d.folder_id, reason, itemCount: 1, userId,
      })
      await q.archiveDocuments(c, [d.id], batchId, true)
      batchIds.push(batchId)
    }
    return { batchIds, archived: batchIds.length }
  })
  await invalidate('cache_tree')
  return out
}

export async function listBox(kind: 'TRASH' | 'RETIRE') {
  const [items, count] = await Promise.all([
    q.listBatches(DOC_CLASS, kind),
    q.countBatches(DOC_CLASS, kind),
  ])
  return {
    items: items.map((b) => ({
      ...b,
      kind: b.kind as 'TRASH' | 'RETIRE',
      archivedAt: b.archivedAt.toISOString(),
    })),
    count: count?.n ?? 0,
  }
}

export async function setNote(batchId: number, note: string | null) {
  await tx(async (c) => {
    const b = await q.batchById(c, batchId)
    if (!b) throw Errors.notFound('보관 묶음')
    await q.setBatchNote(c, batchId, note)
  })
}

export async function restore(batchIds: number[], userId: number) {
  const out = await tx(async (c) => {
    let restored = 0
    const blocked: { batchId: number; reason: string }[] = []

    for (const id of batchIds) {
      const b = await q.batchById(c, id)
      if (!b) { blocked.push({ batchId: id, reason: '묶음을 찾을 수 없습니다.' }); continue }
      if (b.purged_at) { blocked.push({ batchId: id, reason: '이미 완전 삭제되었습니다.' }); continue }
      if (b.restored_at) { blocked.push({ batchId: id, reason: '이미 복구되었습니다.' }); continue }
      if (!(await q.restoreTargetAlive(c, id))) {
        blocked.push({ batchId: id, reason: '원래 있던 폴더가 사라져 되돌릴 수 없습니다.' })
        continue
      }
      restored += await q.restoreBatch(c, id, userId)
    }
    return { restored, blocked }
  })
  await invalidate('cache_tree')
  return out
}

/** 완전 삭제 — 삭제 보관함에만 있다. 폐기 보관함 묶음은 거부한다. */
export async function purge(batchIds: number[], userId: number) {
  const out = await tx(async (c) => {
    let purged = 0
    let freedBytes = 0
    for (const id of batchIds) {
      const b = await q.batchById(c, id)
      if (!b) throw Errors.notFound('보관 묶음')
      if (b.kind !== 'TRASH') {
        throw Errors.invalid(
          'PURGE_NOT_ALLOWED',
          '폐기 보관함은 완전 삭제할 수 없습니다. 이력을 찾기 위해 남겨 두는 자리입니다.',
        )
      }
      if (b.purged_at) continue
      const r = await q.purgeBatch(c, id, userId)
      purged += r.purged
      freedBytes += r.freedBytes
    }
    return { purged, freedBytes }
  })
  await invalidate('cache_tree')
  return out
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
