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
let beat: NodeJS.Timeout | undefined
let stopping = false
let reconnecting = false

/** 끊긴 뒤 다시 붙는다. 여러 사건(error·end)이 겹쳐도 한 번만 붙는다. */
function scheduleReconnect(log: Logger, why: string): void {
  if (stopping || reconnecting) return
  reconnecting = true
  log.error({ why }, '캐시 리스너가 끊겼다 — 5초 뒤 다시 붙는다')
  setTimeout(() => {
    reconnecting = false
    void startCacheListener(log).catch((err: unknown) => scheduleReconnect(log, String(err)))
  }, 5_000)
}

type Logger = {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}

/**
 * 무효화 방송 수신. 끊기면 다시 붙는다.
 *
 * ## 조용히 죽는 길을 막는다
 *
 * 이 연결은 **아무 것도 보내지 않는다** — LISTEN 만 걸고 가만히 있는다.
 * 그래서 중간의 NAT·방화벽이 놀고 있는 줄로 보고 조용히 끊어 버린다.
 * 그렇게 끊기면 pg 는 `error` 가 아니라 `end` 를 낸다.
 *
 * `error` 만 듣고 있으면 리스너는 죽은 채 살아 있는 척한다 —
 * 서버는 멀쩡히 돌지만 권한을 바꿔도 반영되지 않는다. 실제로 그렇게 멈췄다.
 * 그래서 `end` 도 듣고, TCP 킵얼라이브를 켜고, 주기적으로 한 번씩 찔러 본다.
 */
export async function startCacheListener(log: Logger): Promise<void> {
  stopping = false
  const client = new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    application_name: 'tdms-api-listener',
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
  })

  client.on('notification', (msg) => {
    const ch = msg.channel as Channel
    if (caches[ch]) caches[ch].clear()
  })

  client.on('error', (err) => scheduleReconnect(log, `error: ${String(err)}`))
  client.on('end', () => scheduleReconnect(log, 'end (상대가 끊었다)'))

  await client.connect()
  for (const ch of CHANNELS) await client.query(`LISTEN ${ch}`)
  listener = client

  // 살아 있는지 주기적으로 확인한다. 실패하면 end/error 가 뒤따라 재연결로 이어진다.
  clearInterval(beat)
  beat = setInterval(() => {
    client.query('SELECT 1').catch((err: unknown) => scheduleReconnect(log, `heartbeat: ${String(err)}`))
  }, 30_000)
  beat.unref?.()

  log.info({ channels: CHANNELS }, '캐시 무효화 리스너 시작')
}

export async function stopCacheListener(): Promise<void> {
  stopping = true          // end 이벤트가 재연결로 이어지지 않게
  clearInterval(beat)
  beat = undefined
  await listener?.end()
  listener = undefined
}
