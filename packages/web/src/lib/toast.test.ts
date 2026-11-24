import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts, dismissToast, showToast, toast, toasts } from './toast'

describe('Toast notification system', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearToasts()
  })

  afterEach(() => {
    clearToasts()
    vi.useRealTimers()
  })

  it('adds ok toast and auto-dismisses after 3500ms', () => {
    toast.ok('성공 메시지')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.kind).toBe('ok')
    expect(toasts.value[0]?.text).toBe('성공 메시지')

    vi.advanceTimersByTime(3499)
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(toasts.value).toHaveLength(0)
  })

  it('adds err toast and auto-dismisses after 5000ms', () => {
    toast.err('오류 메시지')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.kind).toBe('err')

    vi.advanceTimersByTime(4999)
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(toasts.value).toHaveLength(0)
  })

  it('supports options with sub messages', () => {
    toast.warn('경고 메시지', { sub: ['상세 항목 1', '상세 항목 2'] })
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.kind).toBe('warn')
    expect(toasts.value[0]?.sub).toEqual(['상세 항목 1', '상세 항목 2'])
  })

  it('manually dismisses a toast by id', () => {
    const id1 = toast.info('첫 번째')
    toast.info('두 번째')
    expect(toasts.value).toHaveLength(2)

    if (id1) dismissToast(id1)
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.text).toBe('두 번째')
  })

  it('deduplicates identical toast and resets timer', () => {
    toast.err('동일 오류')
    const firstId = toasts.value[0]?.id

    vi.advanceTimersByTime(3000)
    expect(toasts.value).toHaveLength(1)

    // Trigger same toast again
    toast.err('동일 오류')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.id).not.toBe(firstId)

    // Should survive past the first timer's 5000ms
    vi.advanceTimersByTime(3000)
    expect(toasts.value).toHaveLength(1)

    // And dismiss after its own 5000ms
    vi.advanceTimersByTime(2001)
    expect(toasts.value).toHaveLength(0)
  })

  it('showToast supports object payload', () => {
    showToast({ kind: 'ok', text: '객체 전달', duration: 1000 })
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1001)
    expect(toasts.value).toHaveLength(0)
  })
})
