<script setup lang="ts">
import type { FolderNode } from '@tdms/contracts'
import TreeNode from './TreeNode.vue'

/** 폴더 트리의 한 단계. 자기 자신을 재귀 호출한다. (기존 script.js renderTree 와 같은 모양) */
defineProps<{
  nodes: FolderNode[]
  depth: number
  expanded: Set<number>
  loading: Set<number>
  selectedId: number | null
  childrenOf: (id: number) => FolderNode[]
}>()

const emit = defineEmits<{
  toggle: [node: FolderNode]
  select: [node: FolderNode]
}>()
</script>

<template>
  <template v-for="n in nodes" :key="n.id">
    <div
      class="tree-node" :class="{ active: selectedId === n.id }"
      :data-depth="Math.min(depth, 3)"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      @click="emit('select', n)"
    >
      <span
        class="tree-toggle"
        @click.stop="n.hasChildren && emit('toggle', n)"
      >{{ n.hasChildren ? (loading.has(n.id) ? '·' : (expanded.has(n.id) ? '▾' : '▸')) : '' }}</span>
      <span class="tree-icon">📁</span>
      <span class="tree-label" :title="n.name">{{ n.name }}</span>
      <span class="tree-count">({{ n.docCount }})</span>
    </div>

    <TreeNode
      v-if="expanded.has(n.id)"
      :nodes="childrenOf(n.id)" :depth="depth + 1"
      :expanded="expanded" :loading="loading" :selected-id="selectedId"
      :children-of="childrenOf"
      @toggle="(x) => emit('toggle', x)"
      @select="(x) => emit('select', x)"
    />
  </template>
</template>
