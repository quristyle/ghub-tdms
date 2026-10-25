<script setup lang="ts" generic="T extends { id: number }">
import { computed, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'

/**
 * 가상 스크롤 테이블.
 *
 * 1만 행이어도 DOM 노드는 보이는 40행 정도만 유지한다.
 * 기존 화면의 표 모양(행 높이 30px, 테두리, No 칸)을 그대로 재현한다.
 */

export interface Column<T> {
  key: string
  label: string
  width?: string
  align?: 'left' | 'center' | 'right'
  render?: (row: T) => string
}

const props = defineProps<{
  columns: Column<T>[]
  rows: T[]
  selectable?: boolean
  selected?: Set<number>
  rowHeight?: number
  loading?: boolean
  emptyText?: string
}>()

const emit = defineEmits<{
  rowClick: [row: T]
  rowHover: [row: T]
  toggle: [id: number]
  toggleAll: [checked: boolean]
}>()

const scrollEl = ref<HTMLElement | null>(null)
const rowH = computed(() => props.rowHeight ?? 30)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.rows.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => rowH.value,
    overscan: 12,
  })),
)

const items = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

const allChecked = computed(
  () => props.rows.length > 0 && props.rows.every((r) => props.selected?.has(r.id)),
)

// 목록이 바뀌면 맨 위로
watch(
  () => props.rows,
  () => scrollEl.value?.scrollTo({ top: 0 }),
)

function cell(row: T, col: Column<T>): string {
  if (col.render) return col.render(row)
  const v = (row as Record<string, unknown>)[col.key]
  return v === null || v === undefined ? '' : String(v)
}
</script>

<template>
  <div class="dt">
    <div class="dt-head">
      <div v-if="selectable" class="dt-cell dt-check">
        <input type="checkbox" :checked="allChecked" @change="emit('toggleAll', ($event.target as HTMLInputElement).checked)" />
      </div>
      <div
        v-for="col in columns" :key="col.key" class="dt-cell"
        :style="{ width: col.width, textAlign: col.align ?? 'left' }"
      >{{ col.label }}</div>
    </div>

    <div ref="scrollEl" class="dt-body">
      <div v-if="loading" class="dt-empty muted">불러오는 중…</div>
      <div v-else-if="!rows.length" class="dt-empty muted">{{ emptyText ?? '자료가 없습니다.' }}</div>

      <div v-else :style="{ height: `${totalSize}px`, position: 'relative' }">
        <div
          v-for="v in items" :key="rows[v.index]!.id"
          class="dt-row"
          :style="{ position:'absolute', top:0, left:0, right:0, height:`${v.size}px`, transform:`translateY(${v.start}px)` }"
          @click="emit('rowClick', rows[v.index]!)"
          @mouseenter="emit('rowHover', rows[v.index]!)"
        >
          <div v-if="selectable" class="dt-cell dt-check" @click.stop>
            <input type="checkbox" :checked="selected?.has(rows[v.index]!.id)" @change="emit('toggle', rows[v.index]!.id)" />
          </div>
          <div
            v-for="col in columns" :key="col.key" class="dt-cell"
            :style="{ width: col.width, textAlign: col.align ?? 'left' }"
            :title="cell(rows[v.index]!, col)"
          >{{ cell(rows[v.index]!, col) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dt {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-variant-numeric: tabular-nums;
}
.dt-head {
  display: flex; background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-weight: 600; font-size: var(--fs-sm); color: var(--fg-muted);
  position: sticky; top: 0; z-index: 2;
}
.dt-body { flex: 1; overflow: auto; min-height: 0; }
.dt-row {
  display: flex; align-items: center; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.dt-row:hover { background: var(--surface-2); }
.dt-cell {
  padding: 0 9px; line-height: calc(var(--row-h) - 1px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 0;
}
.dt-head .dt-cell { line-height: 28px; }
.dt-check { flex: 0 0 36px; width: 36px; text-align: center; }
.dt-empty { padding: 36px; text-align: center; color: var(--fg-muted); }
</style>
