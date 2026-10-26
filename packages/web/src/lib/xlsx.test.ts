import { describe, expect, it } from 'vitest'
import { numeric } from './xlsx'

/**
 * 엑셀로 내보낼 때 **무엇을 숫자로 넣을지**가 이 파일의 유일한 함정이다.
 * 사번 "0038" 을 숫자로 넣으면 38 이 되고, 전화번호는 뺄셈으로 읽힌다.
 * 한 번 틀리면 받은 사람이 엉뚱한 자료를 들고 간다 — 그래서 못 박아 둔다.
 */
describe('엑셀 칸 자료형', () => {
  it('앞자리 0 은 글자로 둔다 — 사번·우편번호가 뭉개지지 않게', () => {
    expect(numeric('0038')).toBe(false)
    expect(numeric('0023')).toBe(false)
    expect(numeric('-0045')).toBe(false)
    expect(numeric('0')).toBe(true)      // 0 하나는 숫자가 맞다
    expect(numeric('0.5')).toBe(true)    // 0.5 도 숫자다
  })

  it('기호가 섞이면 글자로 둔다 — 전화번호·도면번호', () => {
    expect(numeric('010-4445-8756')).toBe(false)
    expect(numeric('052-916-2016')).toBe(false)
    expect(numeric('A-101')).toBe(false)
    expect(numeric('1,200')).toBe(false)
    expect(numeric('1200건')).toBe(false)
    expect(numeric('')).toBe(false)
    expect(numeric(' 12 ')).toBe(false)
  })

  it('진짜 숫자는 숫자로 넣는다 — 받아서 바로 합계가 되게', () => {
    expect(numeric('1200')).toBe(true)
    expect(numeric('-45')).toBe(true)
    expect(numeric('3.5')).toBe(true)
    expect(numeric('13.5')).toBe(true)
  })

  it('정밀도를 넘는 긴 숫자는 글자로 둔다 — 사업자번호가 반올림되지 않게', () => {
    expect(numeric('6108172372')).toBe(true)          // 10자리는 안전하다
    expect(numeric('12345678901234567890')).toBe(false)
  })
})
