<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { DocClass, FolderNode } from '@tdms/contracts'
import LazyTree from './LazyTree.vue'

type TreeApi = {
  reload: () => Promise<void>
  collapseAll: () => void
  expandAll: () => Promise<void>
  expandSelected: () => Promise<void>
}

/**
 * 목록 화면 왼쪽의 폴더 트리 칸 + 폭 조절 손잡이 (기존 tree.css 의 .tree-panel · .tree-resize-handle).
 *
 * 두 요소를 한 덩어리로 내보낸다 — .main-layout 안에서 나란히 놓여야 하기 때문이다.
 * 끌어서 바꾼 폭은 화면마다 따로 기억한다(localStorage).
 */
const props = withDefaults(defineProps<{
  docClass: DocClass
  selectedId: number | null
  /** 머리글 글자 (기존 화면은 전부 '폴더') */
  title?: string
  /** 폭을 기억할 열쇠 — 화면마다 다르게 */
  storageKey?: string
  /** 숨김 폴더 보기 — 껍데기만 남은 DWG·PDF 폴더까지 드러낸다 */
  showHidden?: boolean
}>(), { title: '폴더', storageKey: 'tree', showHidden: false })

const emit = defineEmits<{ select: [folder: FolderNode | null] }>()

const MIN_W = 220
const MAX_W = 680
const width = ref(360)
const panel = ref<HTMLElement | null>(null)
const tree = ref<TreeApi | null>(null)
const resizing = ref(false)
/** 펼치는 중 — 지연 로딩이라 가지를 받아 오는 동안 단추를 잠근다 */
const busy = ref(false)

async function run(fn: (() => Promise<void>) | undefined) {
  if (!fn || busy.value) return
  busy.value = true
  try { await fn() } finally { busy.value = false }
}

const key = () => `tdms.treeWidth.${props.storageKey}`

onMounted(() => {
  const saved = Number(localStorage.getItem(key()))
  if (saved >= MIN_W && saved <= MAX_W) width.value = saved
})

let startX = 0
let startW = 0

function onMove(e: PointerEvent) {
  const next = Math.min(MAX_W, Math.max(MIN_W, startW + (e.clientX - startX)))
  width.value = next
}

function onUp() {
  resizing.value = false
  localStorage.setItem(key(), String(width.value))
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
}

function startResize(e: PointerEvent) {
  startX = e.clientX
  startW = panel.value?.offsetWidth ?? width.value
  resizing.value = true
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
})
</script>

<template>
  <aside ref="panel" class="tree-panel" :style="{ flex: `0 0 ${width}px` }">
    <div class="tree-head">
      <b :title="`${title} — 눌러서 대분류만 보이게 접기`" @click="tree?.collapseAll()">{{ title }}</b>
      <span class="tree-tools">
        <button
          type="button" class="tree-tool" :disabled="busy"
          title="모두 펼치기" aria-label="모두 펼치기" @click="run(tree?.expandAll)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 3.5 8 7.5 12 3.5M4 8.5 8 12.5 12 8.5" />
          </svg>
        </button>
        <button
          type="button" class="tree-tool" :disabled="busy"
          title="모두 접기 — 대분류만 남깁니다" aria-label="모두 접기" @click="tree?.collapseAll()"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 7.5 8 3.5 12 7.5M4 12.5 8 8.5 12 12.5" />
          </svg>
        </button>
        <button
          type="button" class="tree-tool" :disabled="busy"
          :title="selectedId === null ? '선택 폴더 하위 펼치기 — [전체]가 선택돼 있어 모두 펼칩니다' : '선택 폴더 하위 펼치기'"
          aria-label="선택 폴더 하위 펼치기" @click="run(tree?.expandSelected)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 2.5v4h4M2.5 4.5h3" />
            <rect x="7" y="2.5" width="6.5" height="4" rx="1" />
            <path d="M5 6.5v6.5h2.5M5 10h2.5" />
            <path d="M9.5 9 11 10.5 12.5 9M9.5 11.5 11 13 12.5 11.5" />
          </svg>
        </button>
      </span>
      <slot name="head-right" />
    </div>
    <LazyTree
      ref="tree" :doc-class="docClass" :selected-id="selectedId" :show-hidden="showHidden"
      @select="(f) => emit('select', f)"
    />
  </aside>

  <div
    class="tree-resize-handle" :class="{ resizing }"
    title="끌어서 폴더 칸 너비를 바꿉니다"
    @pointerdown.prevent="startResize"
  />
</template>
