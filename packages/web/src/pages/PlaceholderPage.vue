<script setup lang="ts">
import { useRoute } from 'vue-router'
const route = useRoute()
const title = () => String(route.meta.title ?? '')
const phase = () => String(route.meta.phase ?? '')
</script>

<template>
  <main class="app-main">
    <div class="panel ph">
      <h1>{{ title() }}</h1>
      <p class="muted">이 화면은 아직 구현 전입니다.</p>
      <p class="muted small">이행 계획 {{ phase() }} 단계 — docs/08-이행계획.md</p>
    </div>
  </main>
</template>

<style scoped>
.ph { padding: 40px; text-align: center; }
h1 { font-size: var(--fs-h1); margin: 0 0 8px; }
.small { font-size: var(--fs-sm); margin-top: 16px; }
</style>
