#!/usr/bin/env node
/**
 * 아이디 목록의 권한(role)을 바꾼다 (운영자 지시로 쓰는 수동 도구).
 *
 *   node db/tools/set-role.mjs <ADMIN|VIEWER> <아이디> [아이디 ...]
 *
 *  - ADMIN 은 권한 리프 전부와 모든 메뉴를 받는다(auth/routes.ts). "모든 권한" 이 이것이다.
 *  - 없는 아이디가 하나라도 있으면 아무것도 바꾸지 않는다(한 트랜잭션).
 *  - 끝나면 바뀐 결과를 다시 조회해 찍는다.
 *
 * 접속 정보는 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSCHEMA 환경변수에서 읽는다.
 */
import pg from 'pg'

const [role, ...ids] = process.argv.slice(2)
const loginIds = [...new Set(ids.map((s) => s.replace(/,$/, '').trim()).filter(Boolean))]
if (!['ADMIN', 'VIEWER'].includes(role) || !loginIds.length) {
  console.error('사용법: set-role.mjs <ADMIN|VIEWER> <아이디> [아이디 ...]')
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
  const { rows } = await c.query(
    'SELECT id, login_id, role FROM users WHERE login_id = ANY($1) FOR UPDATE', [loginIds])
  const missing = loginIds.filter((id) => !rows.some((r) => r.login_id === id))
  if (missing.length) throw new Error(`없는 아이디: ${missing.join(', ')}`)
  for (const r of rows) {
    await c.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [r.id, role])
    console.log(`  ${r.login_id}: ${r.role} → ${role}`)
  }
  await c.query('COMMIT')
} catch (e) {
  await c.query('ROLLBACK')
  console.error('실패, 롤백:', e.message)
  process.exitCode = 1
}

if (!process.exitCode) {
  const { rows } = await c.query(
    'SELECT id, login_id, name, role, is_active FROM users WHERE login_id = ANY($1) ORDER BY id', [loginIds])
  for (const r of rows) {
    console.log(`  확인 id=${r.id} ${r.login_id} ${r.name} ${r.role} active=${r.is_active}`)
    if (r.role !== role) process.exitCode = 1
  }
}
await c.end()
