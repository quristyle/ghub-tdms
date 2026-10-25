import { LRUCache } from 'lru-cache'
import pg from 'pg'
import { config } from './config.js'
import { pool } from './db.js'

/**
 * 프로세스 내 캐시.
 *
 * 기존 시스템은 모든 요청마다 권한을 DB 에서 조회했다(permissions.py).
 * 여기서는 캐시하고, 무효화는 PostgreSQL NOTIFY 가 방송한다.
 *
 * 단일 프로세스여도 이 구조를 지키는 이유: 나중에 프로세스를 늘릴 때 코드 변경이 없다.
 */

export const CHANNELS = ['cache_perm', 'cache_tree', 'cache_types'] as const
export type Channel = (typeof CHANNELS)[number]

// LRUCache 의 값은 null 이 될 수 없다. 저장하는 값(Set, 배열)은 전부 object 다.
type CacheValue = object

const caches: Record<Channel, LRUCache<string, CacheValue>> = {
  cache_perm: new LRUCache({ max: 2_000, ttl: 60_000 }),
  cache_tree: new LRUCache({ max: 500 }),
  cache_types: new LRUCache({ max: 100 }),
}

export function cacheGet<T extends CacheValue>(ch: Channel, key: string): T | undefined {
  return caches[ch].get(key) as T | undefined
}

export function cacheSet<T extends CacheValue>(ch: Channel, key: string, value: T): void {
  caches[ch].set(key, value)
}

/** 캐시 적중이면 그대로, 아니면 loader 를 돌려 채운다. */
export async function cached<T extends CacheValue>(
  ch: Channel,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = caches[ch].get(key)
  if (hit !== undefined) return hit as T
  const value = await loader()
  caches[ch].set(key, value)
  return value
}

/** 트랜잭션 커밋 후에 호출한다. 자기 프로세스 포함 모든 프로세스가 비운다. */
export async function invalidate(ch: Channel): Promise<void> {
  caches[ch].clear()
  await pool.query(`SELECT pg_notify($1, '')`, [ch])
}

let listener: pg.Client | undefined

/** 무효화 방송 수신. 끊기면 다시 붙는다. */
export async function startCacheListener(log: {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}): Promise<void> {
  const client = new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    application_name: 'tdms-api-listener',
  })

  client.on('notification', (msg) => {
    const ch = msg.channel as Channel
    if (caches[ch]) caches[ch].clear()
  })

  client.on('error', (err) => {
    log.error({ err }, '캐시 리스너 연결 오류 — 5초 후 재연결')
    setTimeout(() => void startCacheListener(log), 5_000)
  })

  await client.connect()
  for (const ch of CHANNELS) await client.query(`LISTEN ${ch}`)
  listener = client
  log.info({ channels: CHANNELS }, '캐시 무효화 리스너 시작')
}

export async function stopCacheListener(): Promise<void> {
  await listener?.end()
  listener = undefined
}
