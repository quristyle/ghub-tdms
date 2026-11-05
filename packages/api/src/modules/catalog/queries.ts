import type pg from 'pg'
import { many } from '../../core/db.js'

/** 공사·업체 관리 쿼리. SQL 은 이 파일에만 있다. 표 이름은 코드가 정한 두 가지뿐이다. */

export type CatalogTable = 'projects' | 'vendors'

export interface CatalogRow { id: number; name: string; isHidden: boolean; createdAt: Date }

export function list(table: CatalogTable, includeHidden: boolean) {
  return many<CatalogRow>(
    `SELECT id, name, is_hidden AS "isHidden", created_at AS "createdAt"
       FROM ${table}
      WHERE $1::boolean OR NOT is_hidden
      ORDER BY is_hidden, name`,
    [includeHidden],
  )
}

export async function byId(c: pg.PoolClient, table: CatalogTable, id: number) {
  const r = await c.query<CatalogRow>(
    `SELECT id, name, is_hidden AS "isHidden", created_at AS "createdAt"
       FROM ${table} WHERE id = $1 FOR UPDATE`,
    [id],
  )
  return r.rows[0]
}

/** 대소문자 차이만으로 다른 항목이 되지 않게, 숨긴 것까지 포함해 본다 */
export async function sameName(c: pg.PoolClient, table: CatalogTable, name: string, exceptId: number | null) {
  const r = await c.query<{ name: string }>(
    `SELECT name FROM ${table}
      WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2) LIMIT 1`,
    [name, exceptId],
  )
  return r.rows[0]
}

export async function insert(c: pg.PoolClient, table: CatalogTable, name: string) {
  const r = await c.query<CatalogRow>(
    `INSERT INTO ${table} (name) VALUES ($1)
     RETURNING id, name, is_hidden AS "isHidden", created_at AS "createdAt"`,
    [name],
  )
  return r.rows[0]!
}

export async function rename(c: pg.PoolClient, table: CatalogTable, id: number, name: string) {
  const r = await c.query<CatalogRow>(
    `UPDATE ${table} SET name = $2 WHERE id = $1
     RETURNING id, name, is_hidden AS "isHidden", created_at AS "createdAt"`,
    [id, name],
  )
  return r.rows[0]!
}

export function setHidden(c: pg.PoolClient, table: CatalogTable, id: number, hidden: boolean) {
  return c.query(`UPDATE ${table} SET is_hidden = $2 WHERE id = $1`, [id, hidden])
}

/**
 * 업체명 변경 — 기존 시스템은 과거 반출·리비전 기록에 박힌 업체명 문자열을 전부 새 이름으로
 * 바꿔 그 업체로 나갔던 기록의 표시가 같이 바뀌게 했다(vendors.py rename_vendor). 그대로 따른다.
 */
export async function renameVendorSnapshots(c: pg.PoolClient, vendorId: number, oldName: string, newName: string) {
  await c.query(
    `UPDATE distributions SET vendor_name = $3
      WHERE vendor_name = $2 AND (vendor_id = $1 OR vendor_id IS NULL)`,
    [vendorId, oldName, newName],
  )
  await c.query(
    `UPDATE files SET vendor_name = $3
      WHERE vendor_name = $2 AND (vendor_id = $1 OR vendor_id IS NULL)`,
    [vendorId, oldName, newName],
  )
}
