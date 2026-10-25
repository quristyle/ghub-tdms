import { cached } from '../../core/cache.js'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

export async function tree(docClass: 'TDB' | 'MDB', parentId?: number, expandTo?: number) {
  if (expandTo !== undefined) return q.listExpandedTo(docClass, expandTo)
  return cached('cache_tree', `${docClass}:${parentId ?? 'root'}`, () =>
    q.listChildren(docClass, parentId ?? null),
  )
}

/**
 * 조회 범위에 해당하는 폴더 id 집합.
 * 폴더 미지정이면 그 doc_class 전체.
 */
export async function scopeIds(
  docClass: 'TDB' | 'MDB',
  folderId: number | undefined,
  recursive: boolean,
): Promise<number[]> {
  if (folderId === undefined) {
    return cached('cache_tree', `${docClass}:allids`, async () =>
      (await q.rootIds(docClass)).map((r) => r.id),
    )
  }
  if (!recursive) return [folderId]
  const ids = await cached('cache_tree', `sub:${folderId}`, () => q.subtreeIds(folderId))
  if (!ids.length) throw Errors.notFound('폴더')
  return ids
}

export const ancestorChain = q.ancestorChain
