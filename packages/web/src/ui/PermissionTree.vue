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

const props = withDefaults(defineProps<{
  tree: PermissionNode[]
  granted: Set<string>
  /**
   * 그룹에서 상속돼 오는 리프. 켜진 채로 **잠긴다**.
   *
   * 접속권한 관리에서 사람을 고를 때 쓴다. 개인 권한과 그룹 권한을 합쳐 한 벌로
   * 보여주면 운영자가 "지워지지 않는 체크박스" 를 만나게 된다 — 개인에서 지워도
   * 그룹에서 계속 오기 때문이다. 그래서 출처를 나눠 보여주고 그 칸은 못 끄게 한다.
   * (그룹을 고를 때는 비어 있다 — 기존 [권한 관리] 탭도 마찬가지다.)
   */
  inherited?: Set<string>
  readonly?: boolean
}>(), { inherited: () => new Set<string>(), readonly: false })
const emit = defineEmits<{ toggle: [keys: string[], on: boolean] }>()

/** 상속분은 켜짐 계산에는 넣되, 토글 대상에서는 뺀다 */
function ownLeavesOf(n: PermissionNode): string[] {
  return leavesOf(n).filter((k) => !props.inherited.has(k))
}

/** 이 노드 아래의 리프 키를 모은다 (자신이 리프면 자신) */
function leavesOf(n: PermissionNode): string[] {
  return n.children?.length ? n.children.flatMap(leavesOf) : [n.key]
}

function stateOf(n: PermissionNode): 'on' | 'off' | 'partial' {
  const leaves = leavesOf(n)
  const on = leaves.filter((k) => props.granted.has(k) || props.inherited.has(k)).length
  return on === 0 ? 'off' : on === leaves.length ? 'on' : 'partial'
}

/** 이 노드 아래가 전부 상속분이면 끌 것이 없다 — 체크박스를 잠근다 */
function lockedOf(n: PermissionNode): boolean {
  return props.readonly || ownLeavesOf(n).length === 0
}

/** 상속으로만 켜져 있는가 — 라벨에 표시를 붙인다 */
function inheritedOnly(n: PermissionNode): boolean {
  const leaves = leavesOf(n)
  return leaves.length > 0 && leaves.every((k) => props.inherited.has(k))
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
          :disabled="lockedOf(n)"
          @change="emit('toggle', ownLeavesOf(n), ($event.target as HTMLInputElement).checked)"
        />
        <span class="label">{{ n.label }}</span>
        <span v-if="inheritedOnly(n)" class="tag">그룹에서 상속</span>
        <span v-if="n.desc" class="desc muted">{{ n.desc }}</span>
      </label>
      <PermissionTree
        v-if="n.children?.length"
        :tree="n.children" :granted="granted" :inherited="inherited" :readonly="readonly"
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
.row input:disabled { cursor: default; }
.row:has(input:disabled) { cursor: default; }
.tag {
  font-size: var(--fs-xs); color: var(--fg-muted);
  border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; white-space: nowrap;
}
.desc { font-size: var(--fs-xs); }
</style>
