/**
 * 화면 조각(청크)을 못 받았을 때 스스로 다시 읽어 들인다.
 *
 * 배포가 일어나면 두 가지로 깨진다.
 *   1. 배포 도중 웹 컨테이너가 바뀌는 몇 초 — 청크 요청이 502/503 이 된다.
 *   2. 배포 뒤 — 이미 열려 있던 탭의 index.html 은 **옛 해시** 의 청크를 가리킨다.
 *      새 컨테이너에는 그 파일이 없어 404 가 난다(예: LoginPage-CyZfEgvi.js).
 * 어느 쪽이든 라우터가 `import()` 에서 실패해 화면이 열리지 않고 멈춘다.
 * 이때 가려던 주소로 전체 새로고침을 하면 새 index.html → 새 청크를 받는다.
 *
 * 무한 새로고침을 막으려고 sessionStorage 에 마지막 시도 시각을 적어 두고
 * RETRY_GAP 안에는 한 번만 한다. 서버가 오래 죽어 있으면 호스트 nginx 의
 * 점검 화면이 받아 스스로 다시 시도한다.
 */
const KEY = 'tdms:chunk-reload-at'
const RETRY_GAP = 10_000

const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '')
  return CHUNK_ERROR.test(msg)
}

/** 새로고침을 했으면 true. 방금 한 번 했으면 false(호출 쪽이 오류를 그대로 드러낸다). */
export function reloadForNewBuild(targetUrl?: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < RETRY_GAP) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    // sessionStorage 를 못 쓰는 환경 — 그래도 한 번은 시도한다
  }
  if (targetUrl && targetUrl !== location.pathname + location.search + location.hash) {
    location.assign(targetUrl)
  } else {
    location.reload()
  }
  return true
}

/** Vite 가 청크·CSS 미리 받기에 실패하면 내는 이벤트. 라우터 밖의 import() 도 여기로 온다. */
export function installPreloadErrorHandler(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewBuild()) event.preventDefault()
  })
}
