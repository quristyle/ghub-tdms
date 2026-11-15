import { computed, ref } from 'vue'

/**
 * 화면 테마 — 시스템 설정 따름 · 밝게 · 어둡게.
 *
 * 고른 값(system|light|dark)은 localStorage 에 두고, 실제로 적용되는 값
 * (light|dark)만 <html data-theme> 에 적는다. 'system' 일 때는 OS 설정을 읽어
 * 둘 중 하나로 풀어 쓰고, OS 설정이 바뀌면 그때 다시 적는다.
 *
 * CSS 가 @media (prefers-color-scheme) 로 직접 받지 않고 이렇게 한 번 풀어 쓰는 까닭은,
 * '시스템 따름'과 '사용자가 직접 고름'을 CSS 에서 가르려면 어두운 값 한 벌을
 * 미디어쿼리용·속성용으로 **두 번** 적어야 하기 때문이다. 한 벌만 두려고 JS 에서 푼다.
 *
 * 첫 칠 전에 적용하는 일은 index.html 의 짧은 인라인 스크립트가 맡는다 —
 * 번들을 기다리면 어두운 테마인데도 흰 화면이 한 번 번쩍인다.
 */
export type ThemeMode = 'system' | 'light' | 'dark'

export const THEME_KEY = 'tdms.theme'

const MODES: ThemeMode[] = ['system', 'light', 'dark']

/** 누를 때 가는 다음 자리. 배열 인덱스로 돌리는 것보다 순서가 눈에 보인다. */
const NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' }

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: '시스템 설정',
  light: '밝게',
  dark: '어둡게',
}

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return MODES.includes(v as ThemeMode) ? (v as ThemeMode) : 'system'
  } catch {
    return 'system'   // 사생활 보호 모드 등으로 저장소를 못 읽는 경우
  }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

const mode = ref<ThemeMode>(read())
/** OS 가 어둡게인가 — 시스템 설정이 바뀌면 따라 바뀐다 */
const systemDark = ref(media?.matches ?? false)

media?.addEventListener('change', (e) => {
  systemDark.value = e.matches
  apply()
})

/** 실제로 화면에 걸리는 테마 */
const resolved = computed<'light' | 'dark'>(() =>
  (mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value))

function apply(): void {
  const el = document.documentElement
  el.dataset.theme = resolved.value
  // 모바일 브라우저의 주소창 색도 함께 맞춘다
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved.value === 'dark' ? '#1a1a18' : '#1c1c1b')
}

function set(next: ThemeMode): void {
  mode.value = next
  try { localStorage.setItem(THEME_KEY, next) } catch { /* 저장 못 해도 이번 세션은 바뀐다 */ }
  apply()
}

/** 시스템 → 밝게 → 어둡게 → 시스템 */
function cycle(): void {
  set(NEXT[mode.value])
}

/** 인라인 스크립트가 적어 둔 값과 어긋나지 않게 앱이 뜰 때 한 번 맞춘다 */
export function initTheme(): void {
  apply()
}

export function useTheme() {
  return { mode, resolved, set, cycle, next: computed(() => NEXT[mode.value]) }
}
