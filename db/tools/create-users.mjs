#!/usr/bin/env node
/**
 * 아이디 목록으로 계정을 만든다 (운영자 지시로 쓰는 수동 등록 도구).
 *
 *   node db/tools/create-users.mjs <비밀번호> <아이디> [아이디 ...]
 *
 *  - 없는 아이디는 새로 만든다: 이름 = 아이디, VIEWER, 그룹 미배정,
 *    must_change_password = true (첫 로그인에서 변경을 요구한다).
 *  - 이미 있는 아이디는 비밀번호만 주어진 값으로 바꾼다. 권한·그룹·이름은 건드리지 않는다.
 *  - 계정마다 솔트를 따로 쓴다(PBKDF2-HMAC-SHA256 600,000회, core/password.ts 와 같은 형식).
 *  - 한 트랜잭션으로 처리한다. 중간에 실패하면 아무것도 바뀌지 않는다.
 *  - 끝나면 저장된 해시로 비밀번호를 다시 검증해 결과를 찍는다.
 *
 * 접속 정보는 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSCHEMA 환경변수에서 읽는다.
 */
import { pbkdf2 as _pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import pg from 'pg'

const pbkdf2 = promisify(_pbkdf2)
const ITER = 600_000

async function hash(plain) {
  const salt = randomBytes(16)
  const h = await pbkdf2(plain, salt, ITER, 32, 'sha256')
  return `pbkdf2_sha256$${ITER}$${salt.toString('base64')}$${h.toString('base64')}`
}

async function verify(plain, stored) {
  const [alg, it, salt, h] = stored.split('$')
  if (alg !== 'pbkdf2_sha256') return false
  const want = Buffer.from(h, 'base64')
  const got = await pbkdf2(plain, Buffer.from(salt, 'base64'), +it, want.length, 'sha256')
  return timingSafeEqual(want, got)
}

const [password, ...ids] = process.argv.slice(2)
const loginIds = [...new Set(ids.map((s) => s.replace(/,$/, '').trim()).filter(Boolean))]
if (!password || !loginIds.length) {
  console.error('사용법: create-users.mjs <비밀번호> <아이디> [아이디 ...]')
  process.exit(2)
}

const c = new pg.Client({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
})
await c.connect()
if (process.env.PGSCHEMA) await c.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)

try {
  await c.query('BEGIN')
  for (const id of loginIds) {
    const found = await c.query('SELECT id FROM users WHERE login_id = $1 FOR UPDATE', [id])
    if (found.rowCount) {
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
        [found.rows[0].id, await hash(password)])
      console.log(`  갱신(비밀번호): ${id}`)
    } else {
      await c.query(
        `INSERT INTO users (login_id, name, password_hash, role, must_change_password)
         VALUES ($1, $1, $2, 'VIEWER', true)`,
        [id, await hash(password)],
      )
      console.log(`  신규: ${id}`)
    }
  }
  await c.query('COMMIT')
} catch (e) {
  await c.query('ROLLBACK')
  console.error('실패, 롤백:', e.message)
  process.exitCode = 1
}

if (!process.exitCode) {
  const { rows } = await c.query(
    'SELECT id, login_id, name, role, is_active, employment_status, password_hash FROM users WHERE login_id = ANY($1) ORDER BY id',
    [loginIds],
  )
  for (const r of rows) {
    const ok = await verify(password, r.password_hash)
    console.log(`  확인 id=${r.id} ${r.login_id} ${r.role} ${r.employment_status} active=${r.is_active} 비밀번호일치=${ok}`)
    if (!ok) process.exitCode = 1
  }
  if (rows.length !== loginIds.length) { console.error(`  ${loginIds.length}개 중 ${rows.length}개만 조회됨`); process.exitCode = 1 }
}
await c.end()
