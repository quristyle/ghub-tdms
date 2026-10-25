import type pg from 'pg'
import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { Errors } from '../../core/errors.js'
import * as folders from '../folders/queries.js'
import * as q from './queries.js'

export type { DocClass, ArchiveKind } from './queries.js'

/**
 * 보관함 공용 서비스 — TDB·MDB 가 같은 기구를 쓴다.
 *
 * 완전 삭제만 doc_class 마다 다르다(딸린 표가 다르므로). 그래서 그 부분만
 * 호출하는 쪽이 함수로 넘긴다.
 */

interface Brief { id: number; label: string; folderId: number; isArchived: boolean }

/** 삭제 보관함 — 폴더째 묶어 한 줄 */
export async function sendToTrash(
  docClass: q.DocClass,
  v: { itemIds: number[]; folderId: number | null; reason: string | null },
  userId: number,
  briefOf: (c: pg.PoolClient, ids: number[]) => Promise<Brief[]>,
) {
  const out = await tx(async (c) => {
    let ids = v.itemIds
    let label: string
    let originalPath: string | null = null

    if (v.folderId !== null) {
      const f = await folders.findById(v.folderId)
      if (!f) throw Errors.notFound('폴더')
      ids = await q.itemsUnderFolder(c, docClass, v.folderId)
      label = f.name
      originalPath = await folderPathText(c, v.folderId)
    } else {
      if (!ids.length) throw Errors.invalid('NO_TARGET', '보관할 자료를 골라 주세요.')
      label = `자료 ${ids.length}건`
      const first = await briefOf(c, [ids[0]!])
      if (first[0]) originalPath = await folderPathText(c, first[0].folderId)
    }

    const batchId = await q.createBatch(c, {
      kind: 'TRASH', docClass, label, originalPath,
      folderId: v.folderId, reason: v.reason, itemCount: ids.length, userId,
    })
    if (ids.length) await q.archiveItems(c, docClass, ids, batchId, false)
    if (v.folderId !== null) await q.archiveFolderTree(c, v.folderId, batchId)

    return { batchIds: [batchId], archived: ids.length }
  })
  await invalidate('cache_tree')
  return out
}

/**
 * 폐기 보관함 — **자료 1건 = 이력 1건**.
 * 여러 건을 한 번에 폐기해도 자료마다 따로 남긴다(줄마다 비고를 쓰기 때문).
 */
export async function retire(
  docClass: q.DocClass,
  itemIds: number[],
  reason: string | null,
  userId: number,
  briefOf: (c: pg.PoolClient, ids: number[]) => Promise<Brief[]>,
) {
  if (!itemIds.length) throw Errors.invalid('NO_TARGET', '폐기할 자료를 골라 주세요.')

  const out = await tx(async (c) => {
    const items = await briefOf(c, itemIds)
    if (!items.length) throw Errors.notFound('자료')

    const batchIds: number[] = []
    for (const it of items) {
      if (it.isArchived) continue
      const batchId = await q.createBatch(c, {
        kind: 'RETIRE', docClass, label: it.label,
        originalPath: await folderPathText(c, it.folderId),
        folderId: it.folderId, reason, itemCount: 1, userId,
      })
      await q.archiveItems(c, docClass, [it.id], batchId, true)
      batchIds.push(batchId)
    }
    return { batchIds, archived: batchIds.length }
  })
  await invalidate('cache_tree')
  return out
}

export async function listBox(docClass: q.DocClass, kind: q.ArchiveKind) {
  const [items, count] = await Promise.all([
    q.listBatches(docClass, kind),
    q.countBatches(docClass, kind),
  ])
  return {
    items: items.map((b) => ({
      ...b,
      kind: b.kind as q.ArchiveKind,
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
      if (!(await q.restoreTargetAlive(c, b.doc_class, id))) {
        blocked.push({ batchId: id, reason: '원래 있던 폴더가 사라져 되돌릴 수 없습니다.' })
        continue
      }
      restored += await q.restoreBatch(c, b.doc_class, id, userId)
    }
    return { restored, blocked }
  })
  await invalidate('cache_tree')
  return out
}

/**
 * 완전 삭제 — 삭제 보관함에만 있다.
 * 딸린 표를 지우는 일은 doc_class 마다 다르므로 호출하는 쪽이 넘긴다.
 */
export async function purge(
  batchIds: number[],
  userId: number,
  purgeOne: (c: pg.PoolClient, batchId: number) => Promise<{ purged: number; freedBytes: number }>,
) {
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
      const r = await purgeOne(c, id)
      purged += r.purged
      freedBytes += r.freedBytes
      await c.query(
        'UPDATE archive_batches SET purged_at = now(), purged_by = $2 WHERE id = $1',
        [id, userId],
      )
    }
    return { purged, freedBytes }
  })
  await invalidate('cache_tree')
  return out
}

/** 사람이 읽는 전체 경로 — 보관함의 '원래 자리' 기록에 쓴다 */
async function folderPathText(c: pg.PoolClient, id: number): Promise<string> {
  const r = await c.query<{ path: string }>(
    `SELECT string_agg(a.name, ' › ' ORDER BY a.depth) AS path
       FROM folders f, folders a
      WHERE f.id = $1 AND a.path @> f.path`,
    [id],
  )
  return r.rows[0]?.path ?? ''
}
