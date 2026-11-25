import { many, one, query } from '../../core/db.js'

export interface CartFolderRow {
  id: number
  userId: number
  parentId: number | null
  name: string
  sortOrder: number
  docCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CartItemRow {
  cartItemId: number
  cartFolderId: number | null
  cartFolderName: string | null
  addedAt: Date
  id: number
  drawingNo: string
  title: string
  folderId: number
  folderName: string
  docType: string | null
  currentRev: number
  status: string
  isIsometric: boolean
  hasDwg: boolean
  hasPdf: boolean
  hasXlsx: boolean
  hasEtc: boolean
  updatedAt: Date
  isModified: boolean
  lentTo: string | null
  lentAt: Date | null
}

export async function listCartFolders(userId: number): Promise<CartFolderRow[]> {
  return many<CartFolderRow>(
    `SELECT f.id,
            f.user_id AS "userId",
            f.parent_id AS "parentId",
            f.name,
            f.sort_order AS "sortOrder",
            f.created_at AS "createdAt",
            f.updated_at AS "updatedAt",
            COUNT(i.id)::int AS "docCount"
       FROM user_cart_folders f
  LEFT JOIN user_cart_items i ON i.folder_id = f.id AND i.user_id = f.user_id
      WHERE f.user_id = $1
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.name ASC, f.id ASC`,
    [userId],
  )
}

export async function getCartCounts(userId: number): Promise<{ totalCount: number; rootCount: number }> {
  const row = await one<{ totalCount: number; rootCount: number }>(
    `SELECT COUNT(*)::int AS "totalCount",
            COUNT(CASE WHEN folder_id IS NULL THEN 1 END)::int AS "rootCount"
       FROM user_cart_items
      WHERE user_id = $1`,
    [userId],
  )
  return row ?? { totalCount: 0, rootCount: 0 }
}

export async function createCartFolder(
  userId: number,
  name: string,
  parentId?: number | null,
): Promise<CartFolderRow> {
  if (parentId) {
    const parent = await findCartFolder(userId, parentId)
    if (!parent) throw new Error('상위 대기함 폴더를 찾을 수 없습니다.')
  }
  const row = await one<CartFolderRow>(
    `INSERT INTO user_cart_folders (user_id, parent_id, name, sort_order)
     VALUES ($1, $2, $3, (
       SELECT COALESCE(MAX(sort_order), 0) + 1
         FROM user_cart_folders
        WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2
     ))
     RETURNING id, user_id AS "userId", parent_id AS "parentId", name,
               sort_order AS "sortOrder", created_at AS "createdAt",
               updated_at AS "updatedAt", 0 AS "docCount"`,
    [userId, parentId ?? null, name.trim()],
  )
  if (!row) throw new Error('폴더 생성에 실패했습니다.')
  return row
}

export async function findCartFolder(userId: number, folderId: number): Promise<CartFolderRow | null> {
  const row = await one<CartFolderRow>(
    `SELECT f.id,
            f.user_id AS "userId",
            f.parent_id AS "parentId",
            f.name,
            f.sort_order AS "sortOrder",
            f.created_at AS "createdAt",
            f.updated_at AS "updatedAt",
            COUNT(i.id)::int AS "docCount"
       FROM user_cart_folders f
  LEFT JOIN user_cart_items i ON i.folder_id = f.id AND i.user_id = f.user_id
      WHERE f.id = $1 AND f.user_id = $2
      GROUP BY f.id`,
    [folderId, userId],
  )
  return row ?? null
}

export async function updateCartFolder(
  userId: number,
  folderId: number,
  data: { name?: string; parentId?: number | null; sortOrder?: number },
): Promise<CartFolderRow | null> {
  if (data.parentId) {
    if (data.parentId === folderId) throw new Error('자기 자신을 상위 폴더로 지정할 수 없습니다.')
    const parent = await findCartFolder(userId, data.parentId)
    if (!parent) throw new Error('상위 대기함 폴더를 찾을 수 없습니다.')
  }
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = [folderId, userId]

  if (data.name !== undefined) {
    params.push(data.name.trim())
    sets.push(`name = $${params.length}`)
  }
  if (data.parentId !== undefined) {
    params.push(data.parentId)
    sets.push(`parent_id = $${params.length}`)
  }
  if (data.sortOrder !== undefined) {
    params.push(data.sortOrder)
    sets.push(`sort_order = $${params.length}`)
  }

  const row = await one<CartFolderRow>(
    `UPDATE user_cart_folders
        SET ${sets.join(', ')}
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id AS "userId", parent_id AS "parentId", name,
                sort_order AS "sortOrder", created_at AS "createdAt",
                updated_at AS "updatedAt",
                (SELECT COUNT(*)::int FROM user_cart_items WHERE folder_id = id AND user_id = $2) AS "docCount"`,
    params,
  )
  return row ?? null
}

export async function deleteCartFolder(userId: number, folderId: number): Promise<boolean> {
  const res = await query(
    'DELETE FROM user_cart_folders WHERE id = $1 AND user_id = $2',
    [folderId, userId],
  )
  return (res.rowCount ?? 0) > 0
}

export async function listCartItems(
  userId: number,
  folderId?: number | 'root' | 'all',
  qStr?: string,
): Promise<CartItemRow[]> {
  const params: unknown[] = [userId]
  const where: string[] = ['i.user_id = $1']

  if (folderId === 'root') {
    where.push('i.folder_id IS NULL')
  } else if (typeof folderId === 'number') {
    params.push(folderId)
    where.push(`i.folder_id = $${params.length}`)
  }

  if (qStr && qStr.trim()) {
    params.push(`%${qStr.trim()}%`)
    const p = params.length
    where.push(`(d.drawing_no ILIKE $${p} OR d.title ILIKE $${p} OR COALESCE(f.name, '') ILIKE $${p})`)
  }

  return many<CartItemRow>(
    `SELECT i.id AS "cartItemId",
            i.folder_id AS "cartFolderId",
            cf.name AS "cartFolderName",
            i.created_at AS "addedAt",
            d.id,
            d.drawing_no AS "drawingNo",
            d.title,
            d.folder_id AS "folderId",
            f.name AS "folderName",
            d.doc_type AS "docType",
            d.current_rev AS "currentRev",
            d.status,
            d.is_isometric AS "isIsometric",
            d.has_dwg AS "hasDwg",
            d.has_pdf AS "hasPdf",
            d.has_xlsx AS "hasXlsx",
            d.has_etc AS "hasEtc",
            d.updated_at AS "updatedAt",
            (d.updated_at > d.created_at
             OR d.created_at >= (SELECT min(created_at) + interval '1 day' FROM documents)) AS "isModified",
            lent.vendor_name AS "lentTo",
            lent.distributed_at AS "lentAt"
       FROM user_cart_items i
       JOIN documents d ON d.id = i.document_id
       JOIN folders f ON f.id = d.folder_id
  LEFT JOIN user_cart_folders cf ON cf.id = i.folder_id AND cf.user_id = i.user_id
  LEFT JOIN LATERAL (
       SELECT vendor_name, distributed_at
         FROM distributions
        WHERE document_id = d.id AND returned_at IS NULL
        ORDER BY distributed_at DESC
        LIMIT 1
  ) lent ON TRUE
      WHERE ${where.join('\n        AND ')}
      ORDER BY i.created_at DESC, d.id DESC`,
    params,
  )
}

export async function addCartItems(
  userId: number,
  documentIds: number[],
  folderId?: number | null,
): Promise<{ added: number; total: number }> {
  if (!documentIds.length) {
    const counts = await getCartCounts(userId)
    return { added: 0, total: counts.totalCount }
  }

  const targetFolderId = folderId ?? null
  if (targetFolderId !== null) {
    const folder = await findCartFolder(userId, targetFolderId)
    if (!folder) throw new Error('대기함 폴더를 찾을 수 없습니다.')
  }

  const res = await query(
    `INSERT INTO user_cart_items (user_id, document_id, folder_id)
     SELECT $1, doc_id, $3
       FROM unnest($2::bigint[]) AS doc_id
     ON CONFLICT (user_id, document_id)
     DO UPDATE SET folder_id = COALESCE(EXCLUDED.folder_id, user_cart_items.folder_id)`,
    [userId, documentIds, targetFolderId],
  )

  const counts = await getCartCounts(userId)
  return { added: res.rowCount ?? 0, total: counts.totalCount }
}

export async function moveCartItems(
  userId: number,
  documentIds: number[],
  targetFolderId: number | null,
): Promise<number> {
  if (!documentIds.length) return 0
  if (targetFolderId !== null) {
    const folder = await findCartFolder(userId, targetFolderId)
    if (!folder) throw new Error('대상 대기함 폴더를 찾을 수 없습니다.')
  }
  const res = await query(
    `UPDATE user_cart_items
        SET folder_id = $3
      WHERE user_id = $1 AND document_id = ANY($2::bigint[])`,
    [userId, documentIds, targetFolderId],
  )
  return res.rowCount ?? 0
}

export async function removeCartItems(
  userId: number,
  documentIds: number[],
): Promise<{ removed: number; total: number }> {
  if (!documentIds.length) {
    const counts = await getCartCounts(userId)
    return { removed: 0, total: counts.totalCount }
  }
  const res = await query(
    `DELETE FROM user_cart_items
      WHERE user_id = $1 AND document_id = ANY($2::bigint[])`,
    [userId, documentIds],
  )
  const counts = await getCartCounts(userId)
  return { removed: res.rowCount ?? 0, total: counts.totalCount }
}

export async function clearCart(
  userId: number,
  folderId?: number | null,
): Promise<number> {
  let sql = 'DELETE FROM user_cart_items WHERE user_id = $1'
  const params: unknown[] = [userId]
  if (folderId !== undefined) {
    if (folderId === null) {
      sql += ' AND folder_id IS NULL'
    } else {
      params.push(folderId)
      sql += ` AND folder_id = $${params.length}`
    }
  }
  const res = await query(sql, params)
  return res.rowCount ?? 0
}
