<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 모달 — 포커스 트랩, ESC 닫기, 배경 스크롤 잠금. */
defineProps<{ title: string; wide?: boolean; notice?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const box = ref<HTMLElement | null>(null)
let restore: HTMLElement | null = null

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
  restore?.focus()
})
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div ref="box" class="box" :class="{ wide, notice }" role="dialog" aria-modal="true" :aria-label="title">
      <div class="box-head">
        <h2>{{ title }}</h2>
        <span style="flex:1" />
        <button class="btn btn-sm" @click="emit('close')">닫기</button>
      </div>
      <div class="box-body"><slot /></div>
      <div v-if="$slots.footer" class="box-foot"><slot name="footer" /></div>
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
/* 아래 버튼줄이 없으면 본문 밑여백을 본문이 갖는다 */
.box-body:last-child { padding-bottom: 22px; }
</style>
