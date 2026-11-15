<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ProjectManager from '@/ui/ProjectManager.vue'

/**
 * 공사 관리 · 업체 관리 화면.
 *
 * 둘은 다루는 것만 다르고 하는 일이 같아서(추가·이름 변경·숨김) 한 화면으로 둔다 —
 * 어느 쪽인지는 라우트의 meta.catalogKind 가 정한다.
 *
 * 본문은 반출하기 창에서 쓰는 것과 **같은 부품**(ProjectManager)이다. 두 벌로 두면
 * 한쪽만 고치고 넘어가기 쉬워서 창에서 열든 화면으로 열든 같은 것을 보게 한다.
 */
const route = useRoute()

const kind = computed<'projects' | 'vendors'>(() =>
  (route.meta.catalogKind === 'vendors' ? 'vendors' : 'projects'))

const label = computed(() => (kind.value === 'projects' ? '공사' : '업체'))
const subtitle = computed(() =>
  (kind.value === 'projects'
    ? '반출·반입·자료 등록에 쓰는 공사 목록 관리'
    : '반출·반입에 쓰는 업체 목록 관리'))
</script>

<template>
  <main class="app-main">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          {{ label }} 관리<span class="page-title-sub">{{ subtitle }}</span>
        </h1>
      </div>
    </div>

    <div class="card pad catalog-card">
      <!-- kind 가 바뀌면(공사↔업체) 안쪽 상태까지 새로 시작해야 한다 -->
      <ProjectManager :key="kind" :kind="kind" />
    </div>
  </main>
</template>

<style scoped>
/* 목록이 길어지면 카드 안에서 스크롤된다 — 화면이 통째로 늘어나지 않게 */
.catalog-card { flex: 0 0 auto; }
.catalog-card :deep(.pm-list) { max-height: 62vh; }
</style>
