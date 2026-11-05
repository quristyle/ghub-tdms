import { INTERNAL_VENDOR, type CatalogItem } from '@tdms/contracts'
import { tx } from '../../core/db.js'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

/**
 * 공사·업체 관리 — 기존 projects.py / vendors.py.
 *
 * 삭제는 없고 숨김만 있다(D-6). 숨기면 드롭다운 후보에서만 빠지고 과거 기록은 그대로다.
 * 이름 중복은 숨긴 항목까지 포함해 대소문자 무시로 막는다.
 */

const LABEL: Record<q.CatalogTable, string> = { projects: '공사', vendors: '업체' }

function toItem(r: q.CatalogRow): CatalogItem {
  return { id: r.id, name: r.name, isHidden: r.isHidden, createdAt: r.createdAt.toISOString() }
}

/** '사내(자체 통합)'은 업체가 아니다 — 이름을 바꾸거나 그 이름으로 바꿀 수 없다 */
function guardInternal(table: q.CatalogTable, ...names: string[]) {
  if (table === 'vendors' && names.some((n) => n === INTERNAL_VENDOR)) {
    throw Errors.invalid('INTERNAL_VENDOR', `'${INTERNAL_VENDOR}'은 업체명으로 쓰거나 바꿀 수 없습니다.`)
  }
}

export async function list(table: q.CatalogTable, includeHidden: boolean) {
  return { items: (await q.list(table, includeHidden)).map(toItem) }
}

export async function create(table: q.CatalogTable, rawName: string): Promise<CatalogItem> {
  const name = rawName.trim()
  guardInternal(table, name)
  return tx(async (c) => {
    const dup = await q.sameName(c, table, name, null)
    if (dup) throw Errors.conflict('NAME_TAKEN', `이미 등록된 ${LABEL[table]}명입니다: ${dup.name}`)
    return toItem(await q.insert(c, table, name))
  })
}

export async function rename(table: q.CatalogTable, id: number, rawName: string) {
  const name = rawName.trim()
  return tx(async (c) => {
    const row = await q.byId(c, table, id)
    if (!row) throw Errors.notFound(LABEL[table])
    guardInternal(table, row.name, name)
    if (row.name === name) return { item: toItem(row), oldName: row.name }
    const dup = await q.sameName(c, table, name, id)
    if (dup) throw Errors.conflict('NAME_TAKEN', `이미 등록된 ${LABEL[table]}명입니다: ${dup.name}`)
    const out = await q.rename(c, table, id, name)
    if (table === 'vendors') await q.renameVendorSnapshots(c, id, row.name, name)
    return { item: toItem(out), oldName: row.name }
  })
}

export async function setHidden(table: q.CatalogTable, id: number, hidden: boolean) {
  return tx(async (c) => {
    const row = await q.byId(c, table, id)
    if (!row) throw Errors.notFound(LABEL[table])
    await q.setHidden(c, table, id, hidden)
    return row.name
  })
}
