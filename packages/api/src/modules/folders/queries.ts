import { many, one } from '../../core/db.js'

/**
 * 폴더 트리 쿼리.
 *
 * ltree 라벨은 폴더 id 다 ('1.14.57'). 이름은 name 컬럼에 따로 있으므로
 * 이름을 바꿔도 path 가 변하지 않는다 — 하위 갱신이 아예 없다.
 */

export interface FolderRow {
  id: number
  parentId: number | null
  name: string
  path: string
  depth: number
  docCount: number
  hasChildren: boolean
  isPlaceholder: boolean
}

const SELECT_FOLDER = `
  SELECT f.id,
         f.parent_id      AS "parentId",
         f.name,
         f.path::text     AS path,
         f.depth,
         f.doc_count      AS "docCount",
         EXISTS (SELECT 1 FROM folders c
                  WHERE c.parent_id = f.id AND NOT c.is_archived) AS "hasChildren",
         f.is_placeholder AS "isPlaceholder"
    FROM folders f`

/** 직계 자식만 — 트리 지연 로딩의 기본 동작 */
export function listChildren(docClass: string, parentId: number | null) {
  return many<FolderRow>(
    `${SELECT_FOLDER}
      WHERE f.doc_class = $1
        AND f.parent_id IS NOT DISTINCT FROM $2
        AND NOT f.is_archived
      ORDER BY coalesce(f.sort_key, f.name), f.id`,
    [docClass, parentId],
    'folder_children',
  )
}

/**
 * 특정 폴더까지의 경로를 한 번에 펼친다 (화면 복원용).
 * 조상들의 형제까지 모두 가져와야 트리가 제대로 그려진다.
 */
export function listExpandedTo(docClass: string, targetId: number) {
  return many<FolderRow>(
    `WITH target AS (SELECT path FROM folders WHERE id = $2)
     ${SELECT_FOLDER}, target t
      WHERE f.doc_class = $1
        AND NOT f.is_archived
        AND (f.parent_id IS NULL
             OR f.parent_id IN (SELECT fa.id FROM folders fa, target tt
                                 WHERE fa.path @> tt.path))
      ORDER BY f.depth, coalesce(f.sort_key, f.name), f.id`,
    [docClass, targetId],
    'folder_expanded',
  )
}

/** 상세 화면의 breadcrumb */
export function ancestorChain(folderId: number) {
  return many<{ id: number; name: string }>(
    `SELECT a.id, a.name
       FROM folders f, folders a
      WHERE f.id = $1 AND a.path @> f.path
      ORDER BY a.depth`,
    [folderId],
    'folder_chain',
  )
}

/**
 * 서브트리 폴더 id 목록.
 *
 * ltree 조건을 documents 조인에 직접 거는 대신 id 를 먼저 풀어서 배열로 넘긴다.
 * folders 는 수백 행이라 비용이 사실상 0 이고, 플래너가 흔들리지 않는다.
 */
export async function subtreeIds(folderId: number): Promise<number[]> {
  const rows = await many<{ id: number }>(
    `SELECT d.id FROM folders r, folders d
      WHERE r.id = $1 AND d.path <@ r.path AND NOT d.is_archived`,
    [folderId],
    'folder_subtree_ids',
  )
  return rows.map((r) => r.id)
}

export function findById(id: number) {
  return one<FolderRow>(`${SELECT_FOLDER} WHERE f.id = $1`, [id], 'folder_by_id')
}

export function rootIds(docClass: string) {
  return many<{ id: number }>(
    `SELECT id FROM folders WHERE doc_class = $1 AND NOT is_archived`,
    [docClass],
    'folder_all_ids',
  )
}
