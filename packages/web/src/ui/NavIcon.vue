<script setup lang="ts">
/**
 * 내비게이션 아이콘.
 *
 * 아이콘 묶음을 들이지 않는다 — 9개뿐이고, 묶음을 쓰면 번들만 커진다.
 * 모두 16px·선 굵기 1.5 로 맞춰 같은 집안처럼 보이게 했다.
 */
defineProps<{ path: string }>()
</script>

<template>
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <!-- TDB 조회 — 도면 한 장 -->
    <template v-if="path === '/'">
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.4" />
      <path d="M2.2 6h11.6M6 6v7.8" />
    </template>

    <!-- TDB 반입·검수 — 안으로 들어오는 화살표 -->
    <template v-else-if="path === '/import'">
      <path d="M8 2v7.5" />
      <path d="M5 6.8L8 9.8l3-3" />
      <path d="M2.6 11.4v1.2a1.2 1.2 0 0 0 1.2 1.2h8.4a1.2 1.2 0 0 0 1.2-1.2v-1.2" />
    </template>

    <!-- TDB 관리 — 폴더 -->
    <template v-else-if="path === '/editor'">
      <path d="M2.2 4.4a1.2 1.2 0 0 1 1.2-1.2h2.3l1.4 1.7h5.5a1.2 1.2 0 0 1 1.2 1.2v5.5a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z" />
    </template>

    <!-- TDB 반출이력 — 밖으로 나가는 화살표 -->
    <template v-else-if="path === '/distributions'">
      <path d="M8 9.8V2.3" />
      <path d="M5 5.3L8 2.3l3 3" />
      <path d="M2.6 11.4v1.2a1.2 1.2 0 0 0 1.2 1.2h8.4a1.2 1.2 0 0 0 1.2-1.2v-1.2" />
    </template>

    <!-- MDB 조회 — 쌓인 책 -->
    <template v-else-if="path === '/mdb'">
      <path d="M2.4 4.2a1.2 1.2 0 0 1 1.2-1.2H7v10H3.6a1.2 1.2 0 0 0-1.2 1.2z" />
      <path d="M13.6 4.2A1.2 1.2 0 0 0 12.4 3H9v10h3.4a1.2 1.2 0 0 1 1.2 1.2z" />
    </template>

    <!-- MDB 관리 — 책 + 연필 -->
    <template v-else-if="path === '/mdb-editor'">
      <path d="M2.6 4a1.2 1.2 0 0 1 1.2-1.2h7v4.4" />
      <path d="M2.6 4v8.8a1.2 1.2 0 0 0 1.2 1.2h3.6" />
      <path d="M13.9 8.3l-4.3 4.3-2 .5.5-2 4.3-4.3a1 1 0 0 1 1.5 1.5z" />
    </template>

    <!-- 시스템 로그 — 줄 목록 -->
    <template v-else-if="path === '/audit'">
      <path d="M3 4h10M3 8h10M3 12h6" />
      <circle cx="1.6" cy="4" r=".7" fill="currentColor" stroke="none" />
      <circle cx="1.6" cy="8" r=".7" fill="currentColor" stroke="none" />
      <circle cx="1.6" cy="12" r=".7" fill="currentColor" stroke="none" />
    </template>

    <!-- 사용자 관리 — 사람 둘 -->
    <template v-else-if="path === '/users' || path === '/groups'">
      <circle cx="6.2" cy="5.6" r="2.4" />
      <path d="M1.9 13.4c0-2.2 1.9-3.6 4.3-3.6s4.3 1.4 4.3 3.6" />
      <path d="M11 3.6a2.2 2.2 0 0 1 0 4.1M12.4 13.4c0-1.5-.5-2.5-1.3-3.2" />
    </template>

    <!-- 메뉴 관리 — 목록과 위아래 화살표 -->
    <template v-else-if="path === '/menus'">
      <path d="M2.2 4.2h6.4M2.2 8h6.4M2.2 11.8h6.4" />
      <path d="M12.2 5.4V11M12.2 5.4 10.9 6.8M12.2 5.4l1.3 1.4" />
      <path d="M12.2 11l-1.3-1.4M12.2 11l1.3-1.4" />
    </template>

    <!-- 백업 관리 — 저장 더미 -->
    <template v-else-if="path === '/backup'">
      <ellipse cx="8" cy="4" rx="5.4" ry="2" />
      <path d="M2.6 4v4c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V4" />
      <path d="M2.6 8v4c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V8" />
    </template>

    <!-- 도움말 -->
    <template v-else-if="path === '/help'">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" />
      <circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none" />
    </template>

    <!-- 그 밖 -->
    <template v-else>
      <circle cx="8" cy="8" r="5.6" />
    </template>
  </svg>
</template>
