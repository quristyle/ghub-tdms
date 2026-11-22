#!/usr/bin/env node
/**
 * psql 없이 DB 에 한 줄 묻는다.
 *
 * 제어판의 DB 점검은 원래 `psql -tA` 를 쓴다. psql 은 리눅스 개발 장비에는 대개
 * 깔려 있지만 Windows 에는 없는 쪽이 보통이고, 그것 하나 때문에 상태 화면의 DB
 * 칸이 통째로 비어 "DB 가 죽은 것처럼" 보인다. 앱은 이미 pg 로 붙고 있으니
 * 같은 드라이버로 물어 본다.
 *
 * 출력은 **psql -tA 와 똑같이** 맞춘다 — 칸은 `|`, 한 줄에 한 행. 부르는 쪽
 * (checks.sh·json.sh)을 고치지 않으려는 것이다.
 *
 * 접속값은 환경에서 읽는다. dev.sh 의 load_env 가 .env 를 이미 올려 두었다.
 *
 * 끝값: 0 성공 · 1 질의/접속 실패 · 2 인자 없음 · 3 pg 모듈 없음(pnpm install 전)
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// pnpm 은 의존성을 패키지별로 숨겨 둔다. api 패키지 자리에서 찾아야 pg 가 잡힌다.
const require = createRequire(join(ROOT, 'packages/api/package.json'))
let pg
try {
  pg = require('pg')
} catch {
  process.exit(3)
}

const sql = process.argv[2]
if (!sql) process.exit(2)

const client = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD || '',
  connectionTimeoutMillis: 6000,
})

let code = 0
try {
  await client.connect()
  const r = await client.query(sql)
  for (const row of r.rows) {
    console.log(Object.values(row).map((v) => (v === null ? '' : String(v))).join('|'))
  }
} catch (e) {
  if (process.env.DEVCTL_DB_DEBUG) console.error(e.message)
  code = 1
} finally {
  try {
    await client.end()
  } catch {}
}
process.exit(code)
