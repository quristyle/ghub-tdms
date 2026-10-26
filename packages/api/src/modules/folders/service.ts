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

/**
 * 자료 상세의 폴더 경로(빵부스러기).
 *
 * 목록에서 행에 마우스를 올리면 상세를 미리 받는다(TdbListPage 의 prefetch). 같은 폴더의
 * 자료를 훑으면 같은 조상 경로를 그 횟수만큼 다시 묻게 되므로 캐시한다 —
 * 06 성능기준의 "프로세스 내 캐시(권한·트리·타입)" 에 트리가 들어 있는데 이 경로만
 * 빠져 있었다.
 *
 * cache_tree 를 쓴다. 폴더 이름이 결과에 들어 있어 이름 변경·이동에 낡으면 안 되는데,
 * 그 셋은 이미 이 채널을 통째로 비운다(editor·mdb·archive 서비스).
 */
export function ancestorChain(folderId: number) {
  return cached('cache_tree', `chain:${folderId}`, async () => ({
    items: await q.ancestorChain(folderId),
  })).then((v) => v.items)
}
