import { pbkdf2, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.js'

const pbkdf2Async = promisify(pbkdf2)

/**
 * 비밀번호 해시 — PBKDF2-HMAC-SHA256 600,000회 (기존 시스템과 동일).
 * 저장 형식: pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
 */

export async function hashPassword(plain: string, iterations = config.auth.pbkdf2Iterations): Promise<string> {
  const salt = randomBytes(16)
  const hash = await pbkdf2Async(plain, salt, iterations, 32, 'sha256')
  return `pbkdf2_sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false
  const iterations = Number(parts[1])
  const salt = Buffer.from(parts[2] as string, 'base64')
  const expected = Buffer.from(parts[3] as string, 'base64')
  if (!Number.isFinite(iterations) || iterations < 1) return false
  const actual = await pbkdf2Async(plain, salt, iterations, expected.length, 'sha256')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * 예전 시스템의 초기 비밀번호 규칙 — 'ghub' + 아이디.
 *
 * 아이디만 알면 누구나 맞힐 수 있어서 **더는 새로 발급하지 않는다**(생성·초기화는
 * temporaryPassword()). 옮겨 온 계정이 아직 이 값을 쓰는지 가려내는 데만 남겨 둔다.
 */
export function initialPassword(loginId: string): string {
  return `ghub${loginId}`
}

/**
 * 생성·초기화 때 내주는 임시 비밀번호 — 무작위 12자(영문 소문자·숫자, 헷갈리는 글자 뺌).
 * 변경 규칙(영문+숫자 8자 이상)을 늘 만족하도록 영문·숫자를 하나씩은 넣는다.
 */
export function temporaryPassword(length = 12): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = letters + digits
  const pick = (set: string) => set[randomInt(set.length)]!
  const chars = [pick(letters), pick(digits)]
  while (chars.length < length) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

/** 계정이 없을 때도 같은 시간을 쓰게 해서 아이디 존재 여부가 드러나지 않게 한다. */
export async function burnTime(): Promise<void> {
  await pbkdf2Async('dummy', 'dummy-salt-16byte', config.auth.pbkdf2Iterations, 32, 'sha256')
}
