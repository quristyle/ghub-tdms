#!/usr/bin/env node
/** 시드 계정의 비밀번호 해시를 채운다. 초기 규칙: 'ghub' + 아이디 */
import { pbkdf2 } from 'node:crypto'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT, '.env'))) {
  for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const pbkdf2Async = promisify(pbkdf2)
const ITER = 600_000

async function hash(plain) {
  const salt = randomBytes(16)
  const h = await pbkdf2Async(plain, salt, ITER, 32, 'sha256')
  return `pbkdf2_sha256$${ITER}$${salt.toString('base64')}$${h.toString('base64')}`
}

const c = new pg.Client({
  host: process.env.PGHOST, port: +process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
})
await c.connect()
await c.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)

const { rows } = await c.query(`SELECT id, login_id FROM users WHERE password_hash = '!'`)
for (const u of rows) {
  await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hash(`ghub${u.login_id}`)])
  console.log(`  비밀번호 설정: ${u.login_id} (초기값 ghub${u.login_id})`)
}
console.log(rows.length ? `\n${rows.length}개 계정 설정 완료.` : '설정할 계정 없음.')
await c.end()
