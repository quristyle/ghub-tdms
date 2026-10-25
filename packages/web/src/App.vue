<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'

const route = useRoute()
/** 로그인·비밀번호 변경·안내 화면은 상단 메뉴 없이 단독으로 뜬다. */
const bare = computed(() => route.meta.bare === true)
</script>

<template>
  <RouterView v-if="bare" />
  <AppShell v-else />
</template>
