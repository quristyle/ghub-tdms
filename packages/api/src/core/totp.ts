import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto'

/**
 * TOTP (RFC 6238) — Microsoft Authenticator · Google Authenticator 등이 쓰는 6자리 코드.
 *
 * Microsoft Authenticator 는 algorithm·digits·period 를 바꿔도 SHA1·6자리·30초로만 만든다.
 * 그래서 그 값으로 고정한다 — 다르게 두면 앱에는 등록되는데 코드가 맞지 않는다.
 */

export const TOTP_PERIOD = 30
export const TOTP_DIGITS = 6
/** 앞뒤로 받아 줄 칸 수 — 휴대폰 시계가 30초 남짓 어긋나도 들어오게 */
export const TOTP_WINDOW = 1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('base32 가 아닌 글자')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 새 비밀키 — 160bit (RFC 4226 권장 길이), base32 32자 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD)
}

/** 한 칸(step) 의 코드 */
export function hotp(secretB32: string, step: number): string {
  const key = base32Decode(secretB32)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', key).update(msg).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin =
    ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * 코드가 맞으면 그 칸 번호, 아니면 null.
 * 칸 번호를 돌려주는 까닭: 호출부가 "이미 쓴 칸보다 뒤인가" 를 보고 재사용을 막는다.
 */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): number | null {
  const given = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const now = currentStep(nowMs)
  let matched: number | null = null
  // 맞는 칸을 찾아도 끝까지 돈다 — 어느 칸에서 맞았는지가 시간으로 드러나지 않게
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const expect = Buffer.from(hotp(secretB32, now + d))
    if (timingSafeEqual(expect, Buffer.from(given)) && matched === null) matched = now + d
  }
  return matched
}

/** 인증 앱이 QR 로 읽는 주소 */
export function otpauthUrl(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const q = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  })
  // URLSearchParams 는 공백을 + 로 바꾸는데 일부 앱이 그대로 보여 준다 — %20 으로 둔다
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, '%20')}`
}

// ── 저장 시 암호화 ───────────────────────────────────────────────────────
// DB 가 새어도 비밀키가 그대로 나가지 않게 AES-256-GCM 으로 싼다.

export function deriveKey(material: string): Buffer {
  return Buffer.from(hkdfSync('sha256', material, 'tdms', 'totp-secret-v1', 32))
}

export function sealSecret(key: Buffer, secretB32: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

export function openSecret(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('TOTP 비밀키 형식이 다릅니다')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}
