<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 모달 — 포커스 트랩, ESC 닫기, 배경 스크롤 잠금. */
defineProps<{ title: string; wide?: boolean }>()
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
    <div ref="box" class="box" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
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
.backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center; z-index: 100; padding: 24px;
}
.box {
  background: var(--surface); border-radius: var(--radius);
  width: 560px; max-width: 100%; max-height: 100%; display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,.2);
}
.box.wide { width: 880px; }
.box-head { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border); }
.box-head h2 { font-size: var(--fs-lg); margin: 0; font-weight: 600; }
.box-body { padding: 14px; overflow: auto; }
.box-foot { padding: 11px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; }
</style>
