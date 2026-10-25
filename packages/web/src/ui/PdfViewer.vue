<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * PDF 뷰어 — 이식한 PDF.js(public/pdfjs)를 iframe 으로 띄운다.
 *
 * 뷰어 자체는 기존 시스템 것을 그대로 쓴다. 이 컴포넌트가 하는 일은
 * ① 주소를 만들고 ② 호스트 쪽 연동 창구를 열어 주는 것뿐이다.
 * 자세한 계약은 public/pdfjs/README.md 참조.
 */

const props = defineProps<{
  fileId: number
  documentId?: number
  /** 보관해 둔 마크업을 되살려 열 때의 보관 번호 */
  favoriteId?: number
}>()

const emit = defineEmits<{ switchSource: [to: string] }>()

const frame = ref<HTMLIFrameElement | null>(null)
const src = ref('')

function build() {
  const file = encodeURIComponent(`/api/files/${props.fileId}/view`)
  const fav = props.favoriteId ? `&fav=${props.favoriteId}` : ''
  src.value = `/pdfjs/web/viewer.html?file=${file}${fav}`
}

watch(() => [props.fileId, props.favoriteId], build, { immediate: true })

/** 뷰어가 "우리 앱 안"이라고 판단하는 조건 — showAlert 가 함수로 있어야 한다. */
function installHostApi() {
  const w = window as unknown as Record<string, unknown>
  if (typeof w.showAlert !== 'function') {
    w.showAlert = (message: string) => window.alert(message)
  }
}

function onMessage(ev: MessageEvent) {
  if (ev.origin !== window.location.origin) return
  const data = ev.data as { type?: string; to?: string }
  if (data?.type === 'dms-preview-switch' && data.to) emit('switchSource', data.to)
}

/** 지금 그려 둔 마크업을 거둬 온다 (보관하기에서 쓴다). */
function collectMarkup(): unknown[] {
  const win = frame.value?.contentWindow as unknown as
    { dmsMarkup?: { collect?: () => unknown[] } } | null
  return win?.dmsMarkup?.collect?.() ?? []
}

/** 떠나기 전에 저장하지 않은 편집이 있는지 묻는다. */
function hasChanges(): boolean {
  const win = frame.value?.contentWindow as unknown as
    { dmsMarkup?: { hasChanges?: () => boolean } } | null
  return win?.dmsMarkup?.hasChanges?.() ?? false
}

defineExpose({ collectMarkup, hasChanges })

onMounted(() => {
  installHostApi()
  window.addEventListener('message', onMessage)
})
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <iframe
    ref="frame" :src="src" class="pdf-frame"
    title="자료 미리보기"
    allow="fullscreen"
  />
</template>

<style scoped>
.pdf-frame { flex: 1; width: 100%; border: 0; min-height: 520px; background: var(--bg); }
</style>
