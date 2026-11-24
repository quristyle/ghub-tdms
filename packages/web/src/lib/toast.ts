import { ref } from 'vue'

export type ToastKind = 'ok' | 'err' | 'warn' | 'info'

export interface ToastOptions {
  sub?: string[]
  duration?: number
}

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  sub?: string[]
  duration: number
}

let nextId = 1
export const toasts = ref<ToastItem[]>([])

const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function dismissToast(id: number) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx !== -1) {
    toasts.value.splice(idx, 1)
  }
}

export function clearToasts() {
  timers.forEach((t) => clearTimeout(t))
  timers.clear()
  toasts.value = []
}

export function showToast(
  kindOrPayload: ToastKind | { kind: ToastKind; text: string; sub?: string[]; duration?: number },
  text?: string,
  options?: ToastOptions,
): number | undefined {
  let kind: ToastKind = 'ok'
  let msgText = ''
  let sub: string[] | undefined
  let duration: number | undefined

  if (typeof kindOrPayload === 'object' && kindOrPayload !== null) {
    kind = kindOrPayload.kind
    msgText = kindOrPayload.text
    sub = kindOrPayload.sub
    duration = kindOrPayload.duration
  } else {
    kind = kindOrPayload
    msgText = text ?? ''
    sub = options?.sub
    duration = options?.duration
  }

  if (!msgText && (!sub || sub.length === 0)) return undefined

  const defaultDuration = kind === 'ok' || kind === 'info' ? 3500 : 5000
  const finalDuration = duration !== undefined ? duration : defaultDuration

  const id = nextId++
  const item: ToastItem = {
    id,
    kind,
    text: msgText,
    sub,
    duration: finalDuration,
  }

  // Deduplicate exact same message if already present: replace it and restart timer
  const existingIdx = toasts.value.findIndex(
    (t) => t.kind === item.kind && t.text === item.text && JSON.stringify(t.sub) === JSON.stringify(item.sub),
  )
  if (existingIdx !== -1) {
    const existing = toasts.value[existingIdx]!
    dismissToast(existing.id)
  }

  toasts.value.push(item)

  if (finalDuration > 0) {
    const timer = setTimeout(() => {
      dismissToast(id)
    }, finalDuration)
    timers.set(id, timer)
  }

  return id
}

export const toast = {
  show: showToast,
  ok: (text: string, options?: ToastOptions) => showToast('ok', text, options),
  err: (text: string, options?: ToastOptions) => showToast('err', text, options),
  warn: (text: string, options?: ToastOptions) => showToast('warn', text, options),
  info: (text: string, options?: ToastOptions) => showToast('info', text, options),
  dismiss: dismissToast,
  clear: clearToasts,
}

export function useToast() {
  return toast
}
