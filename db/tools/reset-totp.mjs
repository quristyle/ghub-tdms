#!/usr/bin/env node
/**
 * 인증 앱(OTP) 등록을 지운다 — 화면에서 풀 수 없을 때 쓰는 비상용.
 *
 *   node db/tools/reset-totp.mjs <아이디> [<아이디> …]
 *   node db/tools/reset-totp.mjs --list          등록 상태만 본다
 *
 * 평소에는 사용자 관리 화면의 [OTP 초기화] 를 쓴다. 이 도구는 관리자 자신이 휴대폰을
 * 잃어 화면에 들어갈 수 없을 때를 위한 것이다. 지운 계정은 세션도 끊기고,
 * 다음 로그인 때 비밀번호 다음에 QR 등록 화면이 열린다.
 *
 * 접속 정보는 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSCHEMA 환경변수에서 읽는다.
 */
import pg from 'pg'

const args = process.argv.slice(2)
if (!args.length) {
  console.error('사용법: reset-totp.mjs <아이디> [<아이디> …]\n       reset-totp.mjs --list')
  process.exit(2)
}

const c = new pg.Client({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
})
await c.connect()
if (process.env.PGSCHEMA) await c.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)

try {
  if (args[0] === '--list') {
    const { rows } = await c.query(
      `SELECT login_id, name, totp_enabled_at FROM users ORDER BY (totp_enabled_at IS NULL), login_id`,
    )
    for (const r of rows) {
      console.log(`${r.totp_enabled_at ? '등록  ' + r.totp_enabled_at.toISOString() : '미등록'}  ${r.login_id}  ${r.name}`)
    }
    console.log(`등록 ${rows.filter((r) => r.totp_enabled_at).length} / 전체 ${rows.length}`)
  } else {
    await c.query('BEGIN')
    const { rows } = await c.query('SELECT id, login_id FROM users WHERE login_id = ANY($1)', [args])
    const missing = args.filter((a) => !rows.some((r) => r.login_id === a))
    if (missing.length) throw new Error(`없는 아이디: ${missing.join(', ')}`)
    const ids = rows.map((r) => r.id)
    await c.query(
      `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = now()
        WHERE id = ANY($1)`, [ids])
    await c.query('DELETE FROM login_challenges WHERE user_id = ANY($1)', [ids])
    await c.query('DELETE FROM sessions WHERE user_id = ANY($1)', [ids])
    await c.query('COMMIT')
    console.log(`OTP 초기화: ${rows.map((r) => r.login_id).join(', ')}`)
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {})
  console.error(e.message)
  process.exitCode = 1
} finally {
  await c.end()
}
