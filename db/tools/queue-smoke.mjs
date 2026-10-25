#!/usr/bin/env node
/**
 * 작업 큐 스모크 테스트.
 *
 * Python 워커(packages/worker)가 쓰는 것과 **똑같은 SQL** 로 큐 계약을 검증한다.
 *   ① INSERT 트리거가 pg_notify('job_enqueued') 를 보내는가
 *   ② FOR UPDATE SKIP LOCKED 가 워커 둘이 같은 작업을 집지 않게 하는가
 *   ③ 진행률 갱신이 보이는가
 *   ④ 좀비 회수(heartbeat 2분 초과)가 동작하는가
 *
 * 사용: node db/tools/queue-smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// API 와 같게 bigint 를 숫자로 받는다 (안 하면 문자열로 와서 요청이 검증에 걸린다)
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT, '.env'))) {
  for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const CLAIM_SQL = `
UPDATE jobs
   SET state='running', locked_by=$1, heartbeat_at=now(),
       started_at=coalesce(started_at, now()), attempts=attempts+1
 WHERE id = (SELECT id FROM jobs WHERE state='queued'
              ORDER BY priority, id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id, kind, payload`

const cfg = {
  host: process.env.PGHOST, port: +process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
}
const connect = async () => {
  const c = new pg.Client(cfg)
  await c.connect()
  await c.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)
  return c
}

let pass = 0, fail = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  ok ? pass++ : fail++
}

const main = async () => {
  const a = await connect()
  const b = await connect()
  const listener = await connect()

  // 테스트 흔적 정리
  await a.query(`DELETE FROM jobs WHERE kind = 'smoke_test'`)

  // ── ① NOTIFY ────────────────────────────────────────────────────
  const notified = new Promise((res) => {
    listener.on('notification', (m) => m.channel === 'job_enqueued' && res(m.payload))
  })
  await listener.query('LISTEN job_enqueued')

  const uid = (await a.query(`SELECT id FROM users WHERE login_id='admin'`)).rows[0]?.id ?? null
  const { rows: [job] } = await a.query(
    `INSERT INTO jobs (kind, payload, requested_by) VALUES ('smoke_test','{"n":1}'::jsonb,$1) RETURNING id`,
    [uid],
  )
  const payload = await Promise.race([notified, new Promise((r) => setTimeout(() => r(null), 3000))])
  check(payload === String(job.id), 'INSERT 트리거가 job_enqueued 를 방송한다', `payload=${payload}`)

  // ── ② SKIP LOCKED ───────────────────────────────────────────────
  // 큐에 2건을 두고 두 워커가 동시에 집으면 서로 다른 것을 집어야 한다.
  await a.query(`INSERT INTO jobs (kind, payload, requested_by) VALUES ('smoke_test','{"n":2}'::jsonb,$1)`, [uid])

  await a.query('BEGIN'); await b.query('BEGIN')
  const [ra, rb] = await Promise.all([a.query(CLAIM_SQL, ['w-a']), b.query(CLAIM_SQL, ['w-b'])])
  await a.query('COMMIT'); await b.query('COMMIT')

  const ida = ra.rows[0]?.id, idb = rb.rows[0]?.id
  check(ida && idb && ida !== idb, '워커 둘이 서로 다른 작업을 집는다', `w-a=${ida} w-b=${idb}`)

  const { rows: [{ n: running }] } = await a.query(
    `SELECT count(*)::int n FROM jobs WHERE kind='smoke_test' AND state='running'`)
  check(running === 2, '중복 획득 없이 둘 다 running 이다', `running=${running}`)

  // ── ③ 진행률 ────────────────────────────────────────────────────
  await a.query(`UPDATE jobs SET progress=42, progress_note='3,000행 기록', heartbeat_at=now() WHERE id=$1`, [ida])
  const { rows: [p] } = await a.query(`SELECT progress, progress_note FROM jobs WHERE id=$1`, [ida])
  check(p.progress === 42 && p.progress_note === '3,000행 기록', '진행률과 안내문이 기록된다')

  // ── ④ 좀비 회수 ─────────────────────────────────────────────────
  await a.query(`UPDATE jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id=$1`, [idb])
  const revived = await a.query(
    `UPDATE jobs
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            locked_by = NULL
      WHERE state='running' AND heartbeat_at < now() - interval '2 minutes'
      RETURNING id, state`)
  check(revived.rows.length === 1 && revived.rows[0].id === idb,
        '하트비트가 끊긴 작업만 큐로 되돌린다', `회수=${revived.rows.map(r => r.id).join(',')}`)

  const { rows: [{ state: stillRunning }] } = await a.query(`SELECT state FROM jobs WHERE id=$1`, [ida])
  check(stillRunning === 'running', '살아 있는 작업은 건드리지 않는다')

  // ── 정리 ────────────────────────────────────────────────────────
  await a.query(`DELETE FROM jobs WHERE kind='smoke_test'`)
  await Promise.all([a.end(), b.end(), listener.end()])

  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1) })
