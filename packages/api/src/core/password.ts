import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'
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
 * 계정 생성·초기화 시의 초기 비밀번호 — 'ghub' + 아이디 (기존 CM 규칙).
 * 첫 로그인 시 변경 화면이 먼저 열리고, 미루기가 가능하다.
 * 보안진단에서 지적될 수 있는 항목이므로 must_change_password 로 경로를 남긴다.
 */
export function initialPassword(loginId: string): string {
  return `ghub${loginId}`
}

/** 계정이 없을 때도 같은 시간을 쓰게 해서 아이디 존재 여부가 드러나지 않게 한다. */
export async function burnTime(): Promise<void> {
  await pbkdf2Async('dummy', 'dummy-salt-16byte', config.auth.pbkdf2Iterations, 32, 'sha256')
}
