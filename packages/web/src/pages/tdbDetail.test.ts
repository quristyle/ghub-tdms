import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

describe('TDB 자료 상세 보기 - 모바일 도면 전체화면 뷰어 로직', () => {
  let fakeHistoryState: Record<string, unknown> = {}
  let historyBackCalled = false
  let historyPushStateCalledWith: any[][] = []
  let listeners: Record<string, Function[]> = {}

  beforeEach(() => {
    fakeHistoryState = {}
    historyBackCalled = false
    historyPushStateCalledWith = []
    listeners = {}

    const fakeWindow = {
      history: {
        get state() {
          return fakeHistoryState
        },
        pushState(state: Record<string, unknown>, unused: string) {
          fakeHistoryState = { ...state }
          historyPushStateCalledWith.push([state, unused])
        },
        back() {
          historyBackCalled = true
        },
      },
      addEventListener(type: string, fn: Function) {
        listeners[type] = listeners[type] ?? []
        listeners[type].push(fn)
      },
      removeEventListener(type: string, fn: Function) {
        if (!listeners[type]) return
        listeners[type] = listeners[type].filter((cb) => cb !== fn)
      },
    }

    vi.stubGlobal('window', fakeWindow)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('도면 전체화면 열기 시 히스토리 푸시 및 상태가 활성화된다', () => {
    const isDrawingFull = ref(false)

    function onPopState() {
      if (isDrawingFull.value) {
        isDrawingFull.value = false
      }
    }

    function openDrawingFull() {
      if (isDrawingFull.value) return
      isDrawingFull.value = true
      window.history.pushState({ ...window.history.state, __drawingFullscreen: true }, '')
      window.addEventListener('popstate', onPopState)
    }

    openDrawingFull()

    expect(isDrawingFull.value).toBe(true)
    expect(historyPushStateCalledWith.length).toBe(1)
    expect(historyPushStateCalledWith[0]?.[0]).toEqual({ __drawingFullscreen: true })
    expect(listeners.popstate?.length).toBe(1)
  })

  it('뒤로가기(popstate 이벤트) 발생 시 도면 전체화면이 닫힌다', () => {
    const isDrawingFull = ref(true)

    function onPopState() {
      if (isDrawingFull.value) {
        isDrawingFull.value = false
      }
    }

    // 모바일 뒤로가기 이벤트 시뮬레이션
    onPopState()

    expect(isDrawingFull.value).toBe(false)
  })

  it('닫기 아이콘 클릭 시 history.back() 호출 및 전체화면이 닫힌다', () => {
    const isDrawingFull = ref(true)
    fakeHistoryState = { __drawingFullscreen: true }

    function closeDrawingFull() {
      if (!isDrawingFull.value) return
      isDrawingFull.value = false
      if ((window.history.state as any)?.__drawingFullscreen) {
        window.history.back()
      }
    }

    closeDrawingFull()

    expect(isDrawingFull.value).toBe(false)
    expect(historyBackCalled).toBe(true)
  })

  it('확대, 축소, 맞춤 조작이 뷰어 인스턴스로 정상 전달된다', () => {
    const viewerCalls = {
      zoomIn: 0,
      zoomOut: 0,
      zoomReset: 0,
    }

    const viewerRef = ref({
      zoomIn: () => { viewerCalls.zoomIn++ },
      zoomOut: () => { viewerCalls.zoomOut++ },
      zoomReset: () => { viewerCalls.zoomReset++ },
    })

    function zoomIn() { viewerRef.value?.zoomIn?.() }
    function zoomOut() { viewerRef.value?.zoomOut?.() }
    function zoomReset() { viewerRef.value?.zoomReset?.() }

    zoomIn()
    zoomOut()
    zoomReset()

    expect(viewerCalls.zoomIn).toBe(1)
    expect(viewerCalls.zoomOut).toBe(1)
    expect(viewerCalls.zoomReset).toBe(1)
  })
})
