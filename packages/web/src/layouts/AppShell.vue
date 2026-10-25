<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '@/lib/session'

/**
 * 앱 셸 — 상단 메뉴 9개는 전 화면 고정, 순서 유지.
 * 권한 없는 메뉴는 서버(/auth/me)가 이미 빼고 내려준다. 화면이 거르지 않는다.
 */
const session = useSession()
const route = useRoute()
const router = useRouter()

async function logout() {
  await session.logout()
  void router.push('/login')
}
</script>

<template>
  <header class="app-header">
    <RouterLink to="/" class="app-brand">
      <strong>TDMS</strong> 기술자료 관리 시스템
    </RouterLink>
    <nav class="app-nav">
      <RouterLink
        v-for="m in session.menu" :key="m.path" :to="m.path"
        :class="{ active: route.path === m.path }"
      >{{ m.label }}</RouterLink>
    </nav>
    <div class="app-user">
      <span>{{ session.me?.name }}</span>
      <span v-if="session.isAdmin" class="badge">관리자</span>
      <button class="btn btn-sm" @click="logout">로그아웃</button>
    </div>
  </header>

  <div class="app-body">
    <RouterView />
  </div>
</template>

<style scoped>
.badge {
  font-size: 11px; padding: 1px 6px; border-radius: 9px;
  background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);
}
</style>
