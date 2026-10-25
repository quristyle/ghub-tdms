import pg from 'pg'
import { config } from './config.js'

/**
 * 커넥션 풀.
 *
 * - 핫 쿼리는 prepared statement 로 돌린다(파싱·플래닝 생략).
 * - search_path 는 연결 시 1회 고정한다.
 * - bigint(int8)는 JS number 로 받는다. 이 시스템의 id 는 2^53 을 넘지 않는다.
 */

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))
// numeric 은 문자열 유지 (정밀도 손실 방지)

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'tdms-api',
})

pool.on('connect', (client) => {
  void client.query(`SET search_path TO ${config.db.schema}, public`)
})

export type Sql = pg.QueryConfig | string

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  name?: string,
): Promise<pg.QueryResult<T>> {
  // name 을 주면 prepared statement 로 캐시된다
  return pool.query<T>(name ? { name, text, values: params as never[] } : { text, values: params as never[] })
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  name?: string,
): Promise<T | undefined> {
  const r = await query<T>(text, params, name)
  return r.rows[0]
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  name?: string,
): Promise<T[]> {
  const r = await query<T>(text, params, name)
  return r.rows
}

/** 트랜잭션. 콜백이 throw 하면 롤백한다. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function healthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}

export async function closePool() {
  await pool.end()
}
