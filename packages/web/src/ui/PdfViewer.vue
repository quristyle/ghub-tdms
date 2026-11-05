<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { openFavoriteSaveDialog } from '@/lib/favorites'

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
  /** 보관해 둔 마크업을 되살려 열 때의 보관 번호. 없으면 주소의 ?fav= 를 본다(보관 목록에서 열었을 때) */
  favoriteId?: number | null
  /** PDF 주소를 따로 줄 때 (DWG 미리보기 — /api/files/:id/preview). 없으면 그 파일의 /view */
  fileUrl?: string
  /**
   * 원본/사본 전환 버튼 (D-102) — 뷰어 도구모음 회전 버튼 뒤에 붙는다(dms-source-switch.js).
   * 이 창이 사본(pdf)인지 원본(original)인지. 없으면 버튼을 만들지 않는다.
   */
  viewMode?: 'pdf' | 'original'
  /** 반대쪽(원본↔사본)을 볼 수 있는가 */
  altAvailable?: boolean
  /** 원본 형식 이름(DWG·XLSX…) — 버튼 글자와 원본 다운로드 이름에 쓴다 */
  originalLabel?: string
}>()

const emit = defineEmits<{ switchSource: [to: string] }>()

const route = useRoute()
const frame = ref<HTMLIFrameElement | null>(null)
const src = ref('')

function favFromRoute(): number | null {
  const v = Number(route.query.fav)
  return Number.isInteger(v) && v > 0 ? v : null
}

function build() {
  const sp = new URLSearchParams()
  sp.set('file', props.fileUrl ?? `/api/files/${props.fileId}/view`)
  const fav = props.favoriteId === undefined ? favFromRoute() : props.favoriteId
  if (fav) sp.set('fav', String(fav))
  if (props.viewMode) {
    sp.set('dmsView', props.viewMode)
    if (props.altAvailable) sp.set('dmsAlt', '1')
    if (props.originalLabel) sp.set('dmsLabel', props.originalLabel)
  }
  src.value = `/pdfjs/web/viewer.html?${sp.toString()}`
}

watch(
  () => [props.fileId, props.favoriteId, props.fileUrl, props.viewMode, props.altAvailable, props.originalLabel],
  build,
  { immediate: true },
)

/**
 * 뷰어가 "우리 앱 안"이라고 판단하는 조건 — showAlert 가 함수로 있어야 한다.
 * openFavoriteSaveDialog 가 있어야 도구모음 [»] 안에 [보관하기]·[다른 이름으로 보관]이 생긴다.
 */
function installHostApi() {
  const w = window as unknown as Record<string, unknown>
  if (typeof w.showAlert !== 'function') {
    w.showAlert = (message: string) => window.alert(message)
  }
  w.openFavoriteSaveDialog = openFavoriteSaveDialog
}

function onMessage(ev: MessageEvent) {
  if (ev.origin !== window.location.origin) return
  // 우리 iframe 이 보낸 것만 — 원본·사본 두 창이 함께 떠 있을 때 서로 헷갈리지 않게
  if (frame.value && ev.source !== frame.value.contentWindow) return
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

// 뷰어 iframe 이 들어서기 전에 창구를 연다 — 뷰어는 붙는 순간 한 번만 확인한다
installHostApi()
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
