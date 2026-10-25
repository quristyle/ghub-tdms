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
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border-strong); padding: 0 8px; }
.tab {
  padding: 8px 16px; border: 1px solid transparent; border-bottom: none;
  background: transparent; color: var(--text-muted); border-radius: 5px 5px 0 0;
  margin-bottom: -1px;
}
.tab:hover { color: var(--text); }
.tab.on {
  background: var(--surface); border-color: var(--border-strong);
  border-bottom: 1px solid var(--surface);
  color: var(--accent); font-weight: 600;
}
</style>
