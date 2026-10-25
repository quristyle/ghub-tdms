<script setup lang="ts">
import { computed } from 'vue'
import type { PermissionNode } from '@tdms/contracts'

/**
 * 권한 트리 — 리프 36개에 Y/N 을 매긴다.
 *
 * 규칙 (기존 정책 그대로)
 *  · 구조는 코드에 고정되어 있다. 화면에서 노드를 추가·삭제할 수 없다.
 *  · 상위 노드를 켜면 하위가 전부 켜진다(cascade). **저장은 언제나 leaf 키로** 푼다.
 *  · 상위 노드는 하위의 상태를 비춰 보여준다 — 일부만 켜져 있으면 중간 상태.
 */

const props = defineProps<{ tree: PermissionNode[]; granted: Set<string> }>()
const emit = defineEmits<{ toggle: [keys: string[], on: boolean] }>()

/** 이 노드 아래의 리프 키를 모은다 (자신이 리프면 자신) */
function leavesOf(n: PermissionNode): string[] {
  return n.children?.length ? n.children.flatMap(leavesOf) : [n.key]
}

function stateOf(n: PermissionNode): 'on' | 'off' | 'partial' {
  const leaves = leavesOf(n)
  const on = leaves.filter((k) => props.granted.has(k)).length
  return on === 0 ? 'off' : on === leaves.length ? 'on' : 'partial'
}

const roots = computed(() => props.tree)
</script>

<template>
  <ul class="ptree">
    <li v-for="n in roots" :key="n.key">
      <label class="row" :class="stateOf(n)">
        <input
          type="checkbox"
          :checked="stateOf(n) === 'on'"
          :indeterminate.prop="stateOf(n) === 'partial'"
          @change="emit('toggle', leavesOf(n), ($event.target as HTMLInputElement).checked)"
        />
        <span class="label">{{ n.label }}</span>
        <span v-if="n.desc" class="desc muted">{{ n.desc }}</span>
      </label>
      <PermissionTree
        v-if="n.children?.length"
        :tree="n.children" :granted="granted"
        @toggle="(k, on) => emit('toggle', k, on)"
      />
    </li>
  </ul>
</template>

<script lang="ts">
export default { name: 'PermissionTree' }
</script>

<style scoped>
.ptree { list-style: none; margin: 0; padding-left: 18px; }
.ptree > li > .row {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 6px; border-radius: var(--r); cursor: pointer;
}
.row:hover { background: var(--surface-2); }
.row.on > .label { font-weight: 600; color: var(--primary); }
.row.partial > .label { font-weight: 600; }
.label { white-space: nowrap; }
.desc { font-size: var(--fs-xs); }
</style>
