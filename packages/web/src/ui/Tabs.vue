<script setup lang="ts">
defineProps<{ tabs: { key: string; label: string }[]; modelValue: string }>()
defineEmits<{ 'update:modelValue': [key: string] }>()
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="t in tabs" :key="t.key" role="tab"
      class="tab" :class="{ on: modelValue === t.key }"
      :aria-selected="modelValue === t.key"
      @click="$emit('update:modelValue', t.key)"
    >{{ t.label }}</button>
  </div>
</template>

<style scoped>
/* 밑줄 탭 — 칸을 덜 먹고 어느 것이 켜졌는지가 분명하다 */
.tabs {
  display: flex; gap: 2px;
  border-bottom: 1px solid var(--border);
  padding: 0 var(--sp-2);
  flex: 0 0 auto;
}
.tab {
  position: relative;
  padding: 9px 14px;
  border: 0; background: transparent;
  color: var(--fg-muted); font-size: var(--fs);
  border-radius: var(--r) var(--r) 0 0;
  transition: color .12s ease, background-color .12s ease;
}
.tab:hover { color: var(--fg); background: var(--surface-2); }
.tab.on { color: var(--primary); font-weight: 600; }
.tab.on::after {
  content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px;
  height: 2px; background: var(--primary); border-radius: 2px 2px 0 0;
}
</style>
