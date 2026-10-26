import type { CreateStampBody, StampItem, StampListResponse, UpdateStampBody } from '@tdms/contracts'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

function toItem(r: q.StampRow): StampItem {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    imageUrl: r.imageUrl,
    width: r.width,
    height: r.height,
    description: r.description,
    isEnabled: r.isEnabled,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
  }
}

export async function listStamps(all = false): Promise<StampListResponse> {
  const rows = await q.listStamps(all)
  return {
    items: rows.map(toItem),
    total: rows.length,
  }
}

export async function getStamp(id: number): Promise<StampItem> {
  const r = await q.findStamp(id)
  if (!r) throw Errors.notFound('스탬프를 찾을 수 없습니다.')
  return toItem(r)
}

export async function createStamp(b: CreateStampBody, userId?: number): Promise<StampItem> {
  const id = await q.insertStamp({
    name: b.name.trim(),
    category: b.category,
    imageUrl: b.imageUrl,
    width: b.width,
    height: b.height,
    description: b.description?.trim() || null,
    isEnabled: b.isEnabled,
    sortOrder: b.sortOrder,
    userId,
  })
  return getStamp(id)
}

export async function updateStamp(id: number, b: UpdateStampBody, userId?: number): Promise<StampItem> {
  const exists = await q.findStamp(id)
  if (!exists) throw Errors.notFound('스탬프를 찾을 수 없습니다.')
  await q.updateStamp(id, {
    name: b.name?.trim(),
    category: b.category,
    imageUrl: b.imageUrl,
    width: b.width,
    height: b.height,
    description: b.description === undefined ? undefined : (b.description?.trim() || null),
    isEnabled: b.isEnabled,
    sortOrder: b.sortOrder,
    userId,
  })
  return getStamp(id)
}

export async function deleteStamp(id: number): Promise<void> {
  const ok = await q.deleteStamp(id)
  if (!ok) throw Errors.notFound('스탬프를 찾을 수 없습니다.')
}
