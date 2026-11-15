import { describe, expect, it } from 'vitest'
import { isChunkLoadError } from './chunkReload'

describe('isChunkLoadError', () => {
  it('브라우저마다 다른 청크 실패 문구를 알아본다', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/LoginPage-CyZfEgvi.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true)
  })

  it('다른 오류는 건드리지 않는다', () => {
    expect(isChunkLoadError(new Error('요청에 실패했습니다 (500)'))).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})
