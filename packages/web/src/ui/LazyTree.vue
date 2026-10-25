<script setup lang="ts">
import { ref } from 'vue'
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
 */
const props = defineProps<{ docClass: DocClass; selectedId: number | null }>()
const emit = defineEmits<{ select: [folder: FolderNode | null] }>()

const qc = useQueryClient()
const children = ref(new Map<number, FolderNode[]>())
const roots = ref<FolderNode[]>([])
const expanded = ref(new Set<number>())
const loading = ref(new Set<number>())

async function fetchChildren(parentId: number | null): Promise<FolderNode[]> {
  const key = qk.folders.tree(props.docClass, parentId ?? undefined)
  const hit = qc.getQueryData<FolderTreeResponse>(key)
  if (hit) return hit.items
  const data = await api.get<FolderTreeResponse>(
    `/folders${qs({ docClass: props.docClass, parentId: parentId ?? undefined })}`,
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

void (async () => {
  roots.value = await fetchChildren(null)
})()
</script>

<template>
  <div class="tree">
    <div class="tree-row" :class="{ sel: selectedId === null }" @click="emit('select', null)">
      <span class="tree-arrow" />
      <span class="tree-name">전체</span>
    </div>
    <TreeNode
      :nodes="roots" :depth="0"
      :expanded="expanded" :loading="loading" :selected-id="selectedId"
      :children-of="childrenOf"
      @toggle="toggle" @select="(f) => emit('select', f)"
    />
  </div>
</template>

<style>
.tree { padding: 6px 0; font-size: var(--fs-base); }
.tree-row {
  display: flex; align-items: center; gap: 4px;
  height: 26px; padding-right: 8px; cursor: pointer; user-select: none;
}
.tree-row:hover { background: var(--bg); }
.tree-row.sel { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.tree-arrow {
  flex: 0 0 14px; width: 14px; font-size: 9px; color: var(--text-muted);
  transition: transform .12s; text-align: center;
}
.tree-arrow.open { transform: rotate(90deg); }
.tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-count { font-size: 11px; color: var(--text-muted); }
</style>
