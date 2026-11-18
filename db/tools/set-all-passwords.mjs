#!/usr/bin/env node
/**
 * 모든 계정의 비밀번호를 한 값으로 바꾼다 (운영자 지시로 쓰는 일괄 초기화 도구).
 *
 *   node db/tools/set-all-passwords.mjs <새 비밀번호> <백업파일.json>
 *
 *  - 바꾸기 전 password_hash·must_change_password·password_changed_at 를 백업파일로 남긴다.
 *    백업파일에는 해시가 들어 있으니 저장소 밖에 둔다. 이미 있는 파일은 덮어쓰지 않는다.
 *  - 계정마다 솔트를 따로 쓴다(PBKDF2-HMAC-SHA256 600,000회, core/password.ts 와 같은 형식).
 *  - 한 트랜잭션으로 처리한다. 중간에 실패하면 아무것도 바뀌지 않는다.
 *  - must_change_password 는 건드리지 않는다.
 *
 * 되돌리기: node db/tools/set-all-passwords.mjs --restore <백업파일.json>
 *
 * 접속 정보는 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSCHEMA 환경변수에서 읽는다.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pbkdf2 as _pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import pg from 'pg'

const pbkdf2 = promisify(_pbkdf2)
const ITER = 600_000

async function hash(plain) {
  const salt = randomBytes(16)
  const h = await pbkdf2(plain, salt, ITER, 32, 'sha256')
  return `pbkdf2_sha256$${ITER}$${salt.toString('base64')}$${h.toString('base64')}`
}

const [a1, a2] = process.argv.slice(2)
if (!a1 || !a2) {
  console.error('사용법: set-all-passwords.mjs <새 비밀번호> <백업파일.json>\n       set-all-passwords.mjs --restore <백업파일.json>')
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
  if (a1 === '--restore') {
    const rows = JSON.parse(readFileSync(a2, 'utf8'))
    for (const r of rows) {
      await c.query(
        'UPDATE users SET password_hash = $2, must_change_password = $3, password_changed_at = $4, updated_at = now() WHERE id = $1',
        [r.id, r.password_hash, r.must_change_password, r.password_changed_at],
      )
    }
    console.log(`${rows.length}개 계정 복원.`)
  } else {
    if (existsSync(a2)) throw new Error(`백업파일이 이미 있다: ${a2}`)
    const { rows } = await c.query(
      'SELECT id, login_id, password_hash, must_change_password, password_changed_at FROM users ORDER BY id FOR UPDATE',
    )
    writeFileSync(a2, JSON.stringify(rows, null, 1), { mode: 0o600 })
    for (const u of rows) {
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, await hash(a1)])
    }
    console.log(`${rows.length}개 계정 비밀번호 변경. 백업: ${a2}`)
  }
  await c.query('COMMIT')
} catch (e) {
  await c.query('ROLLBACK')
  console.error('실패, 롤백:', e.message)
  process.exitCode = 1
} finally {
  await c.end()
}
