#!/usr/bin/env node
/**
 * G.Hub 포털 사용자 → TDMS users 반영.
 *
 *   node db/tools/import-users.mjs <파일.json> [--dry]
 *
 * 입력은 포털 /users 응답 그대로다 ({ resData: [...] } 또는 배열).
 *
 * 규칙
 *  - 같은 사람을 찾는 열쇠는 external_id(포털 id) → login_id 순이다.
 *    아이디가 바뀌어도 같은 사람으로 이어붙기 위해서다.
 *  - 다시 돌려도 결과가 같다(upsert). 운영에서 주기적으로 돌릴 수 있어야 한다.
 *  - **비밀번호는 가져오지 않는다.** 포털의 해시를 모르기 때문이다.
 *    새로 만드는 계정만 초기 비밀번호('ghub'+아이디)를 받고
 *    must_change_password = true 가 된다. 이미 있는 계정의 비밀번호는 건드리지 않는다.
 *  - **권한(role)과 그룹(group_id)도 가져오지 않는다.** 포털에는 그 개념이 없고,
 *    부서 이름을 TDMS 권한그룹에 자동으로 꽂으면 권한이 소리 없이 열린다.
 *    새 계정은 VIEWER·그룹 미배정으로 들어오고, 배정은 사람이 한다.
 *  - 아이디가 빈 레코드는 건너뛴다(포털의 빈 껍데기 행).
 */
import { readFileSync } from 'node:fs'
import { pbkdf2 as _pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const pbkdf2 = promisify(_pbkdf2)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const file = process.argv[2]
const dry = process.argv.includes('--dry')
if (!file) {
  console.error('사용: node db/tools/import-users.mjs <파일.json> [--dry]')
  process.exit(1)
}

/** 빈 문자열은 null 로. 포털은 "없음"을 ""와 null 두 가지로 쓴다. */
const s = (v) => {
  const t = typeof v === 'string' ? v.trim() : v
  return t === '' || t == null ? null : t
}

/** TDMS 가 쓰지 않는 포털 값. 버리지 않고 portal_profile 로 넣는다. */
const PORTAL_ONLY = [
  'lastName', 'firstName',
  'notifySubscription', 'notifyKakao', 'notifyEmail', 'notifyWeather', 'notifyAppPush',
  'emailNotifyStartTime', 'emailNotifyEndTime',
  'isMobileHeaderVisible', 'mobileMenuLocation', 'mobileScrollToTopLocation',
  'birthDate', 'isLunar', 'isCelebrated',
  'totalAnnualLeave', 'usedAnnualLeave',
  'preferencesJson', 'mediumPhotoUrl',
]

async function initialHash(loginId) {
  const iterations = 600_000
  const salt = randomBytes(16)
  const hash = await pbkdf2(`ghub${loginId}`, salt, iterations, 32, 'sha256')
  return `pbkdf2_sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`
}

async function upsertPartner(c, p) {
  if (!p) return null
  const r = await c.query(
    `INSERT INTO partner_companies (external_id, company_code, name, representative, business_type, is_active)
     VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::boolean)
     ON CONFLICT (lower(name)) DO UPDATE
        SET external_id    = coalesce(EXCLUDED.external_id, partner_companies.external_id),
            company_code   = coalesce(EXCLUDED.company_code, partner_companies.company_code),
            representative = coalesce(EXCLUDED.representative, partner_companies.representative),
            business_type  = coalesce(EXCLUDED.business_type, partner_companies.business_type),
            is_active      = EXCLUDED.is_active,
            updated_at     = now()
     RETURNING id`,
    [p.id ?? null, s(p.companyCode), p.name, s(p.representative), s(p.businessType), p.isActive !== false],
  )
  return r.rows[0].id
}

async function main() {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const rows = Array.isArray(raw) ? raw : raw.resData
  if (!Array.isArray(rows)) throw new Error('resData 배열을 찾지 못했습니다')

  const pool = new pg.Pool({
    host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  })
  const c = await pool.connect()
  const schema = process.env.PGSCHEMA || 'public'
  await c.query(`SET search_path = ${schema}`)
  await c.query('BEGIN')

  const stat = { created: 0, updated: 0, skipped: [], partners: 0 }
  try {
    for (const u of rows) {
      const loginId = s(u.userId)
      if (!loginId) { stat.skipped.push(`(빈 아이디, 포털 id=${u.id})`); continue }
      const name = s(u.fullName) ?? loginId

      const partnerId = await upsertPartner(c, u.partnerCompany)

      const extra = {}
      for (const k of PORTAL_ONLY) if (u[k] !== undefined && u[k] !== null && u[k] !== '') extra[k] = u[k]

      // 퇴직/삭제 구분이 포털에 없다. isDeleted → 삭제, isActive=false → 퇴직으로 읽는다.
      const status = u.isDeleted ? 'DELETED' : (u.isActive === false ? 'RETIRED' : 'ACTIVE')

      const found = await c.query(
        `SELECT id FROM users WHERE ($1::bigint IS NOT NULL AND external_id = $1::bigint)
                                 OR login_id = $2::text
          ORDER BY (external_id = $1::bigint) DESC NULLS LAST LIMIT 1`,
        [u.id ?? null, loginId],
      )

      const cols = [
        s(u.employeeNumber), s(u.email), s(u.phone), s(u.extensionNumber),
        s(u.department), s(u.position), s(u.companyCode) ?? 'SKGAS', partnerId,
        s(u.photoUrl), s(u.thumbnailUrl), s(u.hireDate),
        u.lastLoginAt ?? null, u.previousLoginAt ?? null,
        status, u.isActive !== false && !u.isDeleted, u.id ?? null, JSON.stringify(extra),
      ]

      if (found.rowCount) {
        await c.query(
          `UPDATE users SET
             name = $2, employee_number = $3, email = $4, phone = $5, extension_number = $6,
             department = $7, position = $8, company_code = $9, partner_company_id = $10,
             photo_url = $11, thumbnail_url = $12, hire_date = $13::date,
             last_login_at = coalesce($14::timestamptz, last_login_at),
             previous_login_at = coalesce($15::timestamptz, previous_login_at),
             employment_status = $16, is_active = $17,
             external_id = coalesce($18::bigint, external_id),
             portal_profile = $19::jsonb, synced_at = now(), updated_at = now()
           WHERE id = $1`,
          [found.rows[0].id, name, ...cols],
        )
        stat.updated++
      } else {
        await c.query(
          `INSERT INTO users
             (login_id, name, password_hash, role, must_change_password,
              employee_number, email, phone, extension_number,
              department, position, company_code, partner_company_id,
              photo_url, thumbnail_url, hire_date, last_login_at, previous_login_at,
              employment_status, is_active, external_id, portal_profile, synced_at)
           VALUES ($1, $2, $3, 'VIEWER', true,
                   $4, $5, $6, $7, $8, $9, $10, $11::bigint,
                   $12, $13, $14::date, $15::timestamptz, $16::timestamptz,
                   $17, $18, $19::bigint, $20::jsonb, now())`,
          [loginId, name, await initialHash(loginId), ...cols],
        )
        stat.created++
      }
    }
    const p = await c.query('SELECT count(*)::int AS n FROM partner_companies')
    stat.partners = p.rows[0].n

    if (dry) { await c.query('ROLLBACK'); console.log('[--dry] 되돌렸습니다.') }
    else await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release(); await pool.end()
  }

  console.log(`  신규 ${stat.created}명 / 갱신 ${stat.updated}명 / 건너뜀 ${stat.skipped.length}건`)
  for (const sk of stat.skipped) console.log(`    건너뜀: ${sk}`)
  console.log(`  협력업체 ${stat.partners}곳`)
  console.log('  새 계정의 초기 비밀번호는 ghub+아이디, 첫 로그인에서 변경을 요구합니다.')
  console.log('  권한(role)과 그룹은 배정하지 않았습니다 — 사용자 관리 화면에서 지정하세요.')
}

main().catch((e) => { console.error(e.message); process.exit(1) })
