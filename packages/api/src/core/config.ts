import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 설정.
 *
 * 운영에서는 비밀값을 systemd LoadCredential= 로 받는다 — 평문 .env 를 서버에 두지 않는다.
 * CREDENTIALS_DIRECTORY 가 있으면 그쪽을 먼저 본다.
 */

function loadDotEnv(root: string) {
  const p = join(root, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m?.[1] && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

function credential(name: string): string | undefined {
  const dir = process.env.CREDENTIALS_DIRECTORY
  if (!dir) return undefined
  const p = join(dir, name)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined
}

loadDotEnv(process.env.TDMS_ROOT ?? join(process.cwd(), '../..'))

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`설정 누락: ${name} — 서버를 시작할 수 없습니다.`)
  return value
}

const sessionSecret = credential('session-secret') ?? process.env.SESSION_SECRET
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET 이 없거나 32자 미만입니다 — 서버를 시작할 수 없습니다.')
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  listen: process.env.API_LISTEN ?? '0.0.0.0:8080',

  db: {
    host: required('PGHOST', process.env.PGHOST),
    port: Number(process.env.PGPORT ?? 5432),
    database: required('PGDATABASE', process.env.PGDATABASE),
    user: required('PGUSER', process.env.PGUSER),
    password: credential('db-password') ?? process.env.PGPASSWORD ?? '',
    schema: process.env.PGSCHEMA ?? 'public',
    poolMax: Number(process.env.PG_POOL_MAX ?? 16),
  },

  session: {
    secret: sessionSecret,
    ttlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    cookieName: 'tdms_sid',
    /** last_seen_at 갱신 간격. 매 요청 UPDATE 하면 쓰기 증폭이 크다. */
    touchIntervalMs: 60_000,
  },

  /** nginx 뒤에서는 파일 전송을 X-Accel-Redirect 로 위임한다. */
  useXAccel: process.env.USE_X_ACCEL === 'true',

  storageRoot: process.env.STORAGE_ROOT ?? '/srv/tdms',

  auth: {
    pbkdf2Iterations: 600_000,
    maxFailBeforeLock: 5,
    lockMinutes: 15,
  },
} as const
