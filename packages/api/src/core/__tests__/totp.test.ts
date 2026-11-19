import { describe, expect, it } from 'vitest'
import {
  base32Decode, base32Encode, deriveKey, generateSecret, hotp, openSecret, otpauthUrl,
  sealSecret, verifyTotp,
} from '../totp.js'

// RFC 6238 부록 B — SHA1, 비밀키 "12345678901234567890"
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP', () => {
  it('base32 왕복', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890')
    const s = generateSecret()
    expect(s).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Encode(base32Decode(s))).toBe(s)
  })

  it('RFC 6238 시험 벡터(뒤 6자리)와 같다', () => {
    expect(hotp(RFC_SECRET, Math.floor(59 / 30))).toBe('287082')
    expect(hotp(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804')
    expect(hotp(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924')
    expect(hotp(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037')
  })

  it('앞뒤 한 칸까지 받고 그 밖은 거절한다', () => {
    const t = 1111111109_000
    const step = Math.floor(1111111109 / 30)
    expect(verifyTotp(RFC_SECRET, '081804', t)).toBe(step)
    expect(verifyTotp(RFC_SECRET, '081804', t + 30_000)).toBe(step)
    expect(verifyTotp(RFC_SECRET, '081804', t - 30_000)).toBe(step)
    expect(verifyTotp(RFC_SECRET, '081804', t + 90_000)).toBeNull()
    expect(verifyTotp(RFC_SECRET, '081 804', t)).toBe(step)
    expect(verifyTotp(RFC_SECRET, '000000', t)).toBeNull()
    expect(verifyTotp(RFC_SECRET, 'abcdef', t)).toBeNull()
    expect(verifyTotp(RFC_SECRET, '12345', t)).toBeNull()
  })

  it('저장용 암호화 왕복, 다른 키로는 열리지 않는다', () => {
    const k = deriveKey('x'.repeat(40))
    const sealed = sealSecret(k, RFC_SECRET)
    expect(sealed.startsWith('v1.')).toBe(true)
    expect(sealed).not.toContain(RFC_SECRET)
    expect(openSecret(k, sealed)).toBe(RFC_SECRET)
    expect(() => openSecret(deriveKey('y'.repeat(40)), sealed)).toThrow()
  })

  it('otpauth 주소 — Microsoft Authenticator 가 읽는 형식', () => {
    const u = otpauthUrl('GHub TDMS', 'admin', RFC_SECRET)
    expect(u).toBe(
      'otpauth://totp/GHub%20TDMS%3Aadmin?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
      + '&issuer=GHub%20TDMS&algorithm=SHA1&digits=6&period=30',
    )
  })
})
