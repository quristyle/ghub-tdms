<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import type { DocClass, FolderNode, FolderTreeResponse } from '@tdms/contracts'
import TreeNode from './TreeNode.vue'
import { api, qs } from '@/lib/api'
import { qk } from '@/lib/queryKeys'

/**
 * 폴더 트리 — 지연 로딩.
 *
 * 한 번에 전체를 내려받지 않는다. folders 테이블의 hasChildren/docCount 만 보고
 * 펼침 화살표와 배지를 그리고, 펼칠 때 그 폴더의 직계 자식만 가져온다.
 * 서버 쪽도 트리 뼈대를 캐시하므로(cache_tree) 펼치기가 30ms 안에 끝난다.
 *
 * 펼친 가지는 로컬에 들고 있지만, 폴더가 바뀌면(만들기·이름 변경·이동·보관) 스스로 다시 읽는다.
 * 쓰는 쪽에서 `invalidateQueries({ queryKey: ['folders'] })` 만 하면 되고,
 * 트리를 새로 고치는 것을 따로 기억할 필요가 없다 — 예전에는 폴더를 만들어도 트리에
 * 나타나지 않았다.
 */
const props = withDefaults(defineProps<{
  docClass: DocClass
  selectedId: number | null
  /** 숨김 폴더 보기 — 껍데기만 남은 DWG·PDF 폴더까지 드러낸다 */
  showHidden?: boolean
}>(), { showHidden: false })
const emit = defineEmits<{ select: [folder: FolderNode | null] }>()

const qc = useQueryClient()
const children = ref(new Map<number, FolderNode[]>())
const roots = ref<FolderNode[]>([])
const expanded = ref(new Set<number>())
const loading = ref(new Set<number>())

async function fetchChildren(parentId: number | null): Promise<FolderNode[]> {
  const key = [...qk.folders.tree(props.docClass, parentId ?? undefined), props.showHidden]
  const state = qc.getQueryState(key)
  const hit = qc.getQueryData<FolderTreeResponse>(key)
  if (hit && !state?.isInvalidated) return hit.items
  const data = await api.get<FolderTreeResponse>(
    `/folders${qs({
      docClass: props.docClass,
      parentId: parentId ?? undefined,
      showHidden: props.showHidden || undefined,
    })}`,
  )
  qc.setQueryData(key, data)
  return data.items
}

async function toggle(node: FolderNode) {
  if (expanded.value.has(node.id)) {
    expanded.value.delete(node.id)
    expanded.value = new Set(expanded.value)
    return
  }
  if (!children.value.has(node.id)) {
    loading.value = new Set(loading.value).add(node.id)
    try {
      children.value.set(node.id, await fetchChildren(node.id))
      children.value = new Map(children.value)
    } finally {
      const l = new Set(loading.value)
      l.delete(node.id)
      loading.value = l
    }
  }
  expanded.value = new Set(expanded.value).add(node.id)
}

function childrenOf(id: number): FolderNode[] {
  return children.value.get(id) ?? []
}

/** 펼쳐 둔 가지를 모두 다시 읽는다 (펼침 상태는 유지) */
async function reload() {
  children.value = new Map()
  roots.value = await fetchChildren(null)
  for (const id of [...expanded.value]) {
    children.value.set(id, await fetchChildren(id))
  }
  children.value = new Map(children.value)
}

void reload()

// [숨김 폴더 보기] 를 켜고 끄면 트리를 통째로 다시 읽는다
watch(() => props.showHidden, () => { void reload() })

// 폴더 질의가 무효화되면 스스로 다시 읽는다.
// (로컬 맵에 복사해 둔 가지는 캐시만 비워서는 갱신되지 않는다)
let reloading = false
const unsubscribe = qc.getQueryCache().subscribe((ev) => {
  if (ev.type !== 'updated' && ev.type !== 'removed') return
  const key = ev.query.queryKey
  if (!Array.isArray(key) || key[0] !== 'folders') return
  if (ev.query.state.isInvalidated === false && ev.type === 'updated') return
  if (reloading) return
  reloading = true
  queueMicrotask(() => {
    void reload().finally(() => { reloading = false })
  })
})

onBeforeUnmount(unsubscribe)

/** 펼쳐 둔 가지를 모두 접는다 — 트리 머리글의 [폴더]를 누르면 대분류만 남는다 (기존 동작) */
function collapseAll() {
  expanded.value = new Set()
}

/** 한 단계에 동시에 보내는 요청 수 — 폴더가 많아도 서버를 몰아붙이지 않는다 */
const FETCH_CONCURRENCY = 8

/**
 * 주어진 폴더들부터 그 아래 모든 가지를 펼친다.
 * 지연 로딩이라 한 단계씩 자식을 받아 오며 내려간다 (이미 받은 가지는 다시 받지 않는다).
 */
async function expandFrom(startIds: number[]) {
  const next = new Set(expanded.value)
  let level = startIds
  while (level.length) {
    const found: FolderNode[] = []
    for (let i = 0; i < level.length; i += FETCH_CONCURRENCY) {
      const chunk = level.slice(i, i + FETCH_CONCURRENCY)
      const lists = await Promise.all(chunk.map(async (id) => {
        const hit = children.value.get(id)
        if (hit) return hit
        const items = await fetchChildren(id)
        children.value.set(id, items)
        return items
      }))
      for (const items of lists) found.push(...items)
    }
    for (const id of level) next.add(id)
    level = found.filter((n) => n.hasChildren).map((n) => n.id)
  }
  children.value = new Map(children.value)
  expanded.value = next
}

/** 모든 폴더를 끝까지 펼친다 */
async function expandAll() {
  await expandFrom(roots.value.filter((n) => n.hasChildren).map((n) => n.id))
}

/** 선택한 폴더의 하위를 끝까지 펼친다 — [전체]가 선택돼 있으면 모두 펼친다 */
async function expandSelected() {
  if (props.selectedId === null) return expandAll()
  await expandFrom([props.selectedId])
}

defineExpose({ reload, collapseAll, expandAll, expandSelected })
</script>

<template>
  <div class="tree-body">
    <div
      class="tree-node" :class="{ active: selectedId === null }"
      data-depth="0" style="padding-left:8px"
      @click="emit('select', null)"
    >
      <span class="tree-toggle" />
      <span class="tree-icon">📁</span>
      <span class="tree-label">전체</span>
    </div>
    <TreeNode
      :nodes="roots" :depth="0"
      :expanded="expanded" :loading="loading" :selected-id="selectedId"
      :children-of="childrenOf"
      @toggle="toggle" @select="(f) => emit('select', f)"
    />
  </div>
</template>
