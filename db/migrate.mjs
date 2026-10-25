#!/usr/bin/env node
/**
 * 마이그레이션 적용기.
 *
 * 규약
 *  - db/migrations/NNNN_name.sql 을 번호순으로 1회 적용한다.
 *  - 적용 이력과 체크섬을 schema_migrations 에 남긴다.
 *  - 이미 적용된 파일이 바뀌면 거부한다 (운영 사고 방지).
 *  - 되돌리기 스크립트는 두지 않는다 — 앞으로만 간다(되돌림은 복원으로).
 *  - 파일 하나가 트랜잭션 하나. 중간 실패 시 그 파일 전체가 롤백된다.
 *
 * 사용: node db/migrate.mjs [up|status|seed]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// .env 읽기 (의존성 없이)
const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const SCHEMA = process.env.PGSCHEMA || 'public'
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function migrationFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
}

async function connect() {
  const client = new pg.Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  })
  await client.connect()
  await client.query(`SET search_path TO ${SCHEMA}, public`)
  return client
}

async function appliedVersions(client) {
  const exists = await client.query(
    `SELECT to_regclass('${SCHEMA}.schema_migrations') IS NOT NULL AS ok`,
  )
  if (!exists.rows[0].ok) return new Map()
  const { rows } = await client.query(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  )
  return new Map(rows.map((r) => [r.version, r.checksum]))
}

async function up() {
  const client = await connect()
  try {
    const dir = join(HERE, 'migrations')
    const files = migrationFiles(dir)
    const applied = await appliedVersions(client)
    let count = 0

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8')
      const sum = sha(sql)
      const version = file.replace(/\.sql$/, '')

      if (applied.has(version)) {
        if (applied.get(version) !== sum) {
          throw new Error(
            `이미 적용된 마이그레이션이 변경되었다: ${file}\n` +
              `  적용 당시: ${applied.get(version)}  현재: ${sum}\n` +
              `  수정하지 말고 새 파일을 추가할 것.`,
          )
        }
        continue
      }

      process.stdout.write(`  적용 ${file} ... `)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [version, sum],
        )
        await client.query('COMMIT')
        console.log('완료')
        count++
      } catch (e) {
        await client.query('ROLLBACK')
        console.log('실패')
        throw e
      }
    }
    console.log(count ? `\n${count}개 적용.` : '\n적용할 마이그레이션 없음 (최신).')
  } finally {
    await client.end()
  }
}

async function status() {
  const client = await connect()
  try {
    const files = migrationFiles(join(HERE, 'migrations'))
    const applied = await appliedVersions(client)
    console.log(`스키마: ${SCHEMA} @ ${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}\n`)
    for (const f of files) {
      const v = f.replace(/\.sql$/, '')
      console.log(`  ${applied.has(v) ? '[적용]' : '[대기]'}  ${f}`)
    }
    const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, ''))).length
    console.log(`\n총 ${files.length}개 / 대기 ${pending}개`)
  } finally {
    await client.end()
  }
}

async function seed() {
  const client = await connect()
  try {
    const dir = join(HERE, 'seed')
    for (const f of migrationFiles(dir)) {
      process.stdout.write(`  시드 ${f} ... `)
      await client.query(readFileSync(join(dir, f), 'utf8'))
      console.log('완료')
    }
  } finally {
    await client.end()
  }
}

const cmd = process.argv[2] || 'up'
const fn = { up, status, seed }[cmd]
if (!fn) {
  console.error('사용: node db/migrate.mjs [up|status|seed]')
  process.exit(1)
}
fn().catch((e) => {
  console.error('\n오류:', e.message)
  process.exit(1)
})
