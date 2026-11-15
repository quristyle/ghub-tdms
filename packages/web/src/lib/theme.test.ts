import { describe, expect, it, vi } from 'vitest'
import type { ThemeMode } from './theme'

/**
 * 이 저장소의 테스트는 node 에서 돈다(브라우저 흉내 패키지를 두지 않는다).
 * 그래서 theme.ts 가 만지는 세 가지 — localStorage · document · matchMedia — 를
 * 손으로 세워 준다. 세 가지뿐이라 흉내가 짧게 끝난다.
 *
 * theme.ts 는 불러오는 순간 저장소와 OS 설정을 한 번 읽어 모듈 안에 둔다.
 * 시작 조건을 바꿔 보려면 매번 모듈을 다시 불러야 한다.
 */
function fakeDom() {
  const store = new Map<string, string>()
  const root = { dataset: {} as { theme?: string } }
  const meta = { content: '' }
  return {
    store,
    root,
    meta,
    install() {
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      })
      vi.stubGlobal('document', {
        documentElement: root,
        querySelector: () => ({ setAttribute: (_: string, v: string) => { meta.content = v } }),
        // vue 의 runtime-dom 이 불러오는 순간 template 하나를 만든다 — 빈 껍데기면 족하다
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      })
    },
  }
}

async function load(stored: string | null, osDark: boolean) {
  vi.resetModules()
  const dom = fakeDom()
  if (stored !== null) dom.store.set('tdms.theme', stored)
  dom.install()
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: osDark && q.includes('dark'),
    addEventListener: () => {},
  }))
  const m = await import('./theme')
  m.initTheme()
  return { ...m, dom }
}

describe('화면 테마', () => {
  it('고른 적이 없으면 시스템 설정을 따른다', async () => {
    const a = await load(null, true)
    expect(a.useTheme().mode.value).toBe('system')
    expect(a.dom.root.dataset.theme).toBe('dark')

    const b = await load(null, false)
    expect(b.dom.root.dataset.theme).toBe('light')
  })

  it('직접 고른 값은 OS 설정보다 앞선다', async () => {
    const a = await load('light', true)      // OS 는 어둡게인데 밝게를 골라 둔 경우
    expect(a.dom.root.dataset.theme).toBe('light')

    const b = await load('dark', false)
    expect(b.dom.root.dataset.theme).toBe('dark')
  })

  it('누를 때마다 시스템 → 밝게 → 어둡게 → 시스템 으로 돈다', async () => {
    const { useTheme } = await load(null, false)
    const { mode, cycle } = useTheme()
    const seen: ThemeMode[] = [mode.value]
    for (let i = 0; i < 3; i++) { cycle(); seen.push(mode.value) }
    expect(seen).toEqual(['system', 'light', 'dark', 'system'])
  })

  it('고른 값을 저장소에 남겨 다음에 열 때도 그대로다', async () => {
    const a = await load(null, false)
    a.useTheme().set('dark')
    expect(a.dom.store.get('tdms.theme')).toBe('dark')
    expect(a.dom.root.dataset.theme).toBe('dark')

    // 새로 연 것처럼 다시 불러도 어둡게다 — OS 는 밝은데도
    const b = await load('dark', false)
    expect(b.dom.root.dataset.theme).toBe('dark')
  })

  it('저장소에 엉뚱한 값이 들어 있어도 시스템 설정으로 돌아간다', async () => {
    const a = await load('보라색', true)
    expect(a.useTheme().mode.value).toBe('system')
    expect(a.dom.root.dataset.theme).toBe('dark')
  })

  it('모바일 주소창 색도 테마를 따라간다', async () => {
    const a = await load('dark', false)
    expect(a.dom.meta.content).toBe('#1a1a18')

    const b = await load('light', true)
    expect(b.dom.meta.content).toBe('#1c1c1b')
  })
})
