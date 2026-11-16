import { describe, expect, it, vi } from 'vitest'

// config 는 불러올 때 SESSION_SECRET·DB 설정을 요구한다 — 시험에서는 비밀번호 설정만 있으면 된다
vi.mock('../config.js', () => ({ config: { auth: { pbkdf2Iterations: 1000 } } }))

const { temporaryPassword, initialPassword, hashPassword, verifyPassword } = await import('../password.js')

describe('임시 비밀번호', () => {
  it('12자, 영문과 숫자를 모두 담아 변경 규칙을 만족한다', () => {
    for (let i = 0; i < 200; i++) {
      const p = temporaryPassword()
      expect(p).toHaveLength(12)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[0-9]/)
    }
  })

  it('매번 다르다 — 아이디로 맞힐 수 있는 예전 규칙과 다르다', () => {
    const seen = new Set(Array.from({ length: 500 }, () => temporaryPassword()))
    expect(seen.size).toBe(500)
    expect(seen.has(initialPassword('admin'))).toBe(false)
  })

  it('해시·검증이 짝을 이룬다', async () => {
    const p = temporaryPassword()
    const h = await hashPassword(p)
    expect(await verifyPassword(p, h)).toBe(true)
    expect(await verifyPassword(`${p}x`, h)).toBe(false)
  })
})
