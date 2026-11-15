<script setup lang="ts">
import { computed } from 'vue'
import { THEME_LABEL, useTheme } from '@/lib/theme'

/**
 * 테마 전환 단추 — 상단 바의 사용자 정보 앞에 선다.
 *
 * 누를 때마다 시스템 설정 → 밝게 → 어둡게 → 시스템 설정 으로 돈다.
 * 아이콘은 **지금 걸린 모드**를 보여 준다(시스템=모니터, 밝게=해, 어둡게=달).
 * 시스템 설정일 때는 OS 가 어느 쪽인지도 알아야 하므로 모니터 안을 그에 맞춰 칠한다.
 *
 * 그림은 선 하나짜리 inline SVG 다 — 바깥에서 받아 오는 것이 없어야
 * 사내망에서도 그대로 뜬다(아이콘 글꼴·CDN 을 쓰지 않는 까닭).
 */
const { mode, resolved, cycle, next } = useTheme()

const title = computed(() =>
  `화면 테마: ${THEME_LABEL[mode.value]}`
  + (mode.value === 'system' ? ` (지금 ${resolved.value === 'dark' ? '어둡게' : '밝게'})` : '')
  + ` — 누르면 ${THEME_LABEL[next.value]}`)
</script>

<template>
  <button
    type="button" class="notice-btn theme-btn"
    :class="{ 'is-system-dark': mode === 'system' && resolved === 'dark' }"
    :title="title" :aria-label="title" @click="cycle"
  >
    <!-- 시스템 설정: 모니터 -->
    <svg v-if="mode === 'system'" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </svg>
    <!-- 밝게: 해 -->
    <svg v-else-if="mode === 'light'" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
    </svg>
    <!-- 어둡게: 달 -->
    <svg v-else viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.6 5.6 0 1 0 7 7z" />
    </svg>
  </button>
</template>

<style scoped>
/* .notice-btn 의 크기·테두리를 그대로 쓰고, 글자 대신 그림이 들어가는 만큼만 바꾼다 */
.theme-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  padding: 0;
}
.theme-btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* 시스템 설정일 때, 지금 적용된 쪽을 모니터 화면 안에 칠해 알려 준다 */
.theme-btn.is-system-dark rect { fill: currentColor; opacity: 0.85; }
</style>
