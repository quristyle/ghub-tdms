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

  /**
   * 앞단 프록시를 얼마나 믿을지 (req.ip 를 X-Forwarded-For 에서 고를 때).
   *
   * 예전에는 true(전부 믿음)였다 — 그러면 맨 왼쪽 값, 즉 **클라이언트가 직접 적어 보낸**
   * 주소가 req.ip 가 되어 감사 로그의 접속 주소를 아무렇게나 꾸밀 수 있었다.
   * 숫자면 그 홉 수만큼만 믿는다(운영: 호스트 nginx → 웹 컨테이너 nginx = 2).
   * 아니면 proxy-addr 의 주소 목록(기본: 루프백·사설망만).
   */
  trustProxy: ((v) => (/^\d+$/.test(v) ? Number(v) : v))(
    process.env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal',
  ) as number | string,

  storageRoot: process.env.STORAGE_ROOT ?? '/srv/tdms',

  /** 백업 묶음 자리. 워커가 쓰고 API 가 내려준다 — 자료 전체를 blob 으로 한 벌 더 두지 않는다. */
  backupRoot: process.env.BACKUP_ROOT ?? `${process.env.STORAGE_ROOT ?? '/srv/tdms'}/backup`,

  auth: {
    pbkdf2Iterations: 600_000,
    maxFailBeforeLock: 5,
    lockMinutes: 15,
  },

  /**
   * 2차 인증(TOTP — Microsoft Authenticator 등).
   *
   * required(기본): 모든 계정이 비밀번호 다음에 인증 앱 코드를 넣어야 들어온다.
   *   등록하지 않은 계정은 첫 로그인 때 QR 을 찍어 등록부터 한다.
   * off: 비밀번호만으로 들어온다 — 개발 장비에서 흐름 검증 도구를 돌릴 때만 쓴다.
   *
   * allowSkip: 로그인 화면의 [2차인증 없이 로그인](skipMfa)을 받아 줄지.
   *   기본은 받아 준다. AUTH_TOTP_SKIP=off 면 체크해도 코드를 묻는다.
   *
   * 비밀키는 DB 에 AES-256-GCM 으로 싸서 둔다. 키는 TOTP_ENC_KEY(32자 이상),
   * 없으면 SESSION_SECRET 에서 유도한다 — 그 경우 SESSION_SECRET 을 바꾸면 등록이 전부
   * 풀리므로(코드가 맞지 않는다) 사용자 관리의 [OTP 초기화]로 다시 등록해야 한다.
   */
  totp: {
    mode: (process.env.AUTH_TOTP === 'off' ? 'off' : 'required') as 'off' | 'required',
    allowSkip: process.env.AUTH_TOTP_SKIP !== 'off',
    issuer: process.env.TOTP_ISSUER ?? 'GHub TDMS',
    encKeyMaterial: credential('totp-enc-key') ?? process.env.TOTP_ENC_KEY ?? sessionSecret,
    /** 코드 확인 대기 시간 — 등록은 앱을 깔고 찍을 시간까지 넉넉히 */
    verifyTtlMinutes: 5,
    enrollTtlMinutes: 15,
    maxAttempts: 5,
  },
} as const
