import { many, one, query } from '../../core/db.js'

export interface StampRow {
  id: number
  name: string
  category: string
  imageUrl: string
  width: number
  height: number
  description: string | null
  isEnabled: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  updatedBy: string | null
}

const SELECT_STAMP = `
  SELECT s.id,
         s.name,
         s.category,
         s.image_url   AS "imageUrl",
         s.width,
         s.height,
         s.description,
         s.is_enabled  AS "isEnabled",
         s.sort_order  AS "sortOrder",
         s.created_at  AS "createdAt",
         s.updated_at  AS "updatedAt",
         u1.name       AS "createdBy",
         u2.name       AS "updatedBy"
    FROM stamps s
    LEFT JOIN users u1 ON u1.id = s.created_by
    LEFT JOIN users u2 ON u2.id = s.updated_by
`

export function listStamps(all = false) {
  if (all) {
    return many<StampRow>(
      `${SELECT_STAMP} ORDER BY s.sort_order ASC, s.id ASC`,
      [],
      'stamps_list_all',
    )
  }
  return many<StampRow>(
    `${SELECT_STAMP} WHERE s.is_enabled = true ORDER BY s.sort_order ASC, s.id ASC`,
    [],
    'stamps_list_enabled',
  )
}

export function findStamp(id: number) {
  return one<StampRow>(
    `${SELECT_STAMP} WHERE s.id = $1`,
    [id],
    'stamps_find_one',
  )
}

export async function insertStamp(data: {
  name: string
  category?: string
  imageUrl: string
  width?: number
  height?: number
  description?: string | null
  isEnabled?: boolean
  sortOrder?: number
  userId?: number
}) {
  const r = await query<{ id: number }>(
    `INSERT INTO stamps (name, category, image_url, width, height, description, is_enabled, sort_order, created_by, updated_by)
     VALUES ($1, coalesce($2, '도장'), $3, coalesce($4, 300), coalesce($5, 150), $6, coalesce($7, true), coalesce($8, 0), $9, $9)
     RETURNING id`,
    [
      data.name,
      data.category,
      data.imageUrl,
      data.width,
      data.height,
      data.description ?? null,
      data.isEnabled ?? true,
      data.sortOrder ?? 0,
      data.userId ?? null,
    ],
  )
  if (!r.rows[0]) throw new Error('스탬프 생성에 실패했습니다.')
  return r.rows[0].id
}

export async function updateStamp(
  id: number,
  data: {
    name?: string
    category?: string
    imageUrl?: string
    width?: number
    height?: number
    description?: string | null
    isEnabled?: boolean
    sortOrder?: number
    userId?: number
  },
) {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = [id]

  if (data.name !== undefined) {
    params.push(data.name)
    sets.push(`name = $${params.length}`)
  }
  if (data.category !== undefined) {
    params.push(data.category)
    sets.push(`category = $${params.length}`)
  }
  if (data.imageUrl !== undefined) {
    params.push(data.imageUrl)
    sets.push(`image_url = $${params.length}`)
  }
  if (data.width !== undefined) {
    params.push(data.width)
    sets.push(`width = $${params.length}`)
  }
  if (data.height !== undefined) {
    params.push(data.height)
    sets.push(`height = $${params.length}`)
  }
  if (data.description !== undefined) {
    params.push(data.description)
    sets.push(`description = $${params.length}`)
  }
  if (data.isEnabled !== undefined) {
    params.push(data.isEnabled)
    sets.push(`is_enabled = $${params.length}`)
  }
  if (data.sortOrder !== undefined) {
    params.push(data.sortOrder)
    sets.push(`sort_order = $${params.length}`)
  }
  if (data.userId !== undefined) {
    params.push(data.userId)
    sets.push(`updated_by = $${params.length}`)
  }

  await query(`UPDATE stamps SET ${sets.join(', ')} WHERE id = $1`, params)
}

export async function deleteStamp(id: number) {
  const r = await query('DELETE FROM stamps WHERE id = $1 RETURNING id', [id])
  return (r.rowCount ?? 0) > 0
}
