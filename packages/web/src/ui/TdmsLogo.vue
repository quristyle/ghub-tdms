<script setup lang="ts">
/**
 * TDMS 심벌.
 *
 * 가로로 눕힌 도면 한 장이고, 오른쪽 아래 모서리를 **표제란**(title block) 이 차지한다 —
 * 도면번호·Rev·축척이 들어가는 그 칸이다. 이 시스템이 다루는 것이
 * 일반 '문서' 가 아니라 '도면' 이라는 표시다.
 *
 * 요소를 둘로 줄였다. 처음에는 배관선까지 그렸는데 16px 파비콘에서
 * 표제란과 뭉쳐 얼룩이 됐다. 실루엣만 남아도 읽히는 쪽을 골랐다.
 *
 * 색은 토큰을 쓴다 — 어두운 쪽에서도 같은 무게로 보인다.
 * 종이는 늘 흰색이다. 뒤집으면 종이로 안 보인다.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 28 })
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 32 32"
    role="img" aria-label="TDMS" class="tdms-logo"
  >
    <rect width="32" height="32" rx="7.5" fill="var(--primary)" />
    <path
      d="M7 7.5h18a2.5 2.5 0 0 1 2.5 2.5v6.5H17.5a1 1 0 0 0-1 1V24.5H7a2.5 2.5 0 0 1-2.5-2.5V10A2.5 2.5 0 0 1 7 7.5z"
      fill="#fff"
    />
    <rect x="18.6" y="18.6" width="8.9" height="5.9" rx="1.6" fill="#fff" opacity=".45" />
  </svg>
</template>

<style scoped>
.tdms-logo { display: block; flex: 0 0 auto; }
</style>
