<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 모달 — 포커스 트랩, ESC 닫기, 배경 스크롤 잠금.
 * movable: 머리글을 잡고 옮길 수 있다. resizable: 오른쪽·아래·모서리를 잡고 크기를 바꿀 수 있다.
 * width: 기본 너비(예: '680px'). 화면보다 넓으면 화면에 맞춰 줄어든다.
 */
const props = defineProps<{
  title: string; wide?: boolean; notice?: boolean
  movable?: boolean; resizable?: boolean; width?: string
}>()
const emit = defineEmits<{ close: [] }>()

const box = ref<HTMLElement | null>(null)
let restore: HTMLElement | null = null

// ── 옮기기 · 크기 바꾸기 ────────────────────────────────────────────────
// 처음 잡는 순간 가운데 정렬에서 고정 좌표(left/top)로 바꾼 뒤 그 좌표를 움직인다.
const pos = ref<{ left: number; top: number } | null>(null)
const size = ref<{ w: number; h: number } | null>(null)
const MIN_W = 320, MIN_H = 200, KEEP = 80 // KEEP: 화면 밖으로 나가도 남겨 둘 최소 폭

const boxStyle = computed(() => {
  const st: Record<string, string> = {}
  if (props.width) st.width = props.width
  if (pos.value) {
    st.position = 'fixed'; st.margin = '0'
    st.left = `${pos.value.left}px`; st.top = `${pos.value.top}px`
  }
  if (size.value) {
    st.width = `${size.value.w}px`; st.height = `${size.value.h}px`
    st.maxWidth = 'none'; st.maxHeight = 'none'
  }
  return st
})

function pin() {
  const r = box.value!.getBoundingClientRect()
  if (!pos.value) pos.value = { left: r.left, top: r.top }
  return r
}

type Drag = { kind: 'move' | 'e' | 's' | 'se'; x: number; y: number; left: number; top: number; w: number; h: number }
let drag: Drag | null = null

function start(kind: Drag['kind'], e: PointerEvent) {
  if (e.button !== 0 || !box.value) return
  if (kind === 'move' && (e.target as HTMLElement).closest('button,input,select,textarea,a')) return
  const r = pin()
  drag = { kind, x: e.clientX, y: e.clientY, left: pos.value!.left, top: pos.value!.top, w: r.width, h: r.height }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  document.body.style.userSelect = 'none'
  e.preventDefault()
}

function move(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y
  const vw = window.innerWidth, vh = window.innerHeight
  if (drag.kind === 'move') {
    pos.value = {
      left: Math.min(Math.max(drag.left + dx, KEEP - drag.w), vw - KEEP),
      top: Math.min(Math.max(drag.top + dy, 0), vh - 40),
    }
    return
  }
  const w = drag.kind === 's' ? drag.w : Math.min(Math.max(drag.w + dx, MIN_W), vw - drag.left)
  const h = drag.kind === 'e' ? drag.h : Math.min(Math.max(drag.h + dy, MIN_H), vh - drag.top)
  size.value = { w, h }
}

function end() {
  if (!drag) return
  drag = null
  document.body.style.userSelect = ''
}

// 배경을 누르고 뗀 경우에만 닫는다 — 끌거나 글자를 고르다 배경에서 떼도 닫히지 않게.
let downOnBackdrop = false
function onBackdropDown(e: PointerEvent) { downOnBackdrop = e.target === e.currentTarget }
function onBackdropClick(e: MouseEvent) {
  if (downOnBackdrop && e.target === e.currentTarget) emit('close')
  downOnBackdrop = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { emit('close'); return }
  if (e.key !== 'Tab' || !box.value) return
  const items = box.value.querySelectorAll<HTMLElement>(
    'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
  )
  if (!items.length) return
  const first = items[0]!, last = items[items.length - 1]!
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

onMounted(() => {
  restore = document.activeElement as HTMLElement | null
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKey)
  box.value?.querySelector<HTMLElement>('button,input,textarea,select')?.focus()
})
onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKey)
  document.body.style.userSelect = ''
  restore?.focus()
})
</script>

<template>
  <div class="backdrop" @pointerdown="onBackdropDown" @click="onBackdropClick">
    <div ref="box" class="box" :class="{ wide, notice, sized: !!size }" :style="boxStyle"
         role="dialog" aria-modal="true" :aria-label="title">
      <div class="box-head" :class="{ movable }"
           @pointerdown="movable && start('move', $event)" @pointermove="move" @pointerup="end" @pointercancel="end">
        <h2>{{ title }}</h2>
        <span style="flex:1" />
        <button class="btn btn-sm" @click="emit('close')">닫기</button>
      </div>
      <div class="box-body"><slot /></div>
      <div v-if="$slots.footer" class="box-foot"><slot name="footer" /></div>
      <template v-if="resizable">
        <div class="grip grip-e" @pointerdown="start('e', $event)" @pointermove="move" @pointerup="end" @pointercancel="end" />
        <div class="grip grip-s" @pointerdown="start('s', $event)" @pointermove="move" @pointerup="end" @pointercancel="end" />
        <div class="grip grip-se" title="크기 조절"
             @pointerdown="start('se', $event)" @pointermove="move" @pointerup="end" @pointercancel="end" />
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 기존 화면의 .modal-overlay / .modal-box 와 같은 모양 (style.css) */
.backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(16, 24, 40, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.box {
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 400px; max-width: 100%; max-height: 90vh;
  display: flex; flex-direction: column;
  position: relative;
}
.box.wide { width: 900px; max-width: 92vw; }
/* 상단 알림 팝업([TDB 수정]·[TDB 반출]) — 표가 들어가므로 가로 스크롤이 안 생기게 넓게 */
.box.notice { width: 1420px; max-width: 94vw; }

.box-head {
  display: flex; align-items: center;
  padding: 18px 22px 10px;
}
.box-head h2 { font-size: 15px; font-weight: 700; margin: 0; }

.box-body { padding: 0 22px; overflow: auto; flex: 1; min-height: 0; }

.box-foot {
  padding: 20px 22px 22px;
  display: flex; gap: 8px; align-items: center; justify-content: flex-end;
}
/* 머리글을 잡고 옮기기 */
.box-head.movable { cursor: move; touch-action: none; user-select: none; }
.box-head.movable button { cursor: pointer; }

/* 크기 조절 손잡이 — 오른쪽 · 아래 · 오른쪽 아래 모서리 */
.grip { position: absolute; z-index: 1; touch-action: none; }
.grip-e { top: 0; right: -3px; width: 8px; height: 100%; cursor: ew-resize; }
.grip-s { left: 0; bottom: -3px; width: 100%; height: 8px; cursor: ns-resize; }
.grip-se {
  right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;
  border-bottom-right-radius: var(--radius-lg);
  background:
    linear-gradient(135deg, transparent 50%, var(--border, #c8ccd4) 50%, var(--border, #c8ccd4) 58%,
      transparent 58%, transparent 70%, var(--border, #c8ccd4) 70%, var(--border, #c8ccd4) 78%, transparent 78%);
}

/* 아래 버튼줄이 없으면 본문 밑여백을 본문이 갖는다 */
.box-body:last-child { padding-bottom: 22px; }
</style>
