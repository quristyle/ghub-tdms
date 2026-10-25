<script setup lang="ts"></script>
<template>
  <div class="wrap">
    <div class="box">
      <h1>접속할 수 있는 화면이 없습니다</h1>
      <p class="muted">관리자에게 화면 접속 권한을 요청해 주세요.</p>
      <RouterLink to="/login" class="btn">로그인 화면으로</RouterLink>
    </div>
  </div>
</template>
<style scoped>
.wrap { display: flex; align-items: center; justify-content: center; height: 100%; width: 100%; }
.box {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 32px 40px; text-align: center;
}
h1 { font-size: var(--fs-h1); margin: 0 0 10px; }
p { margin: 0 0 18px; }
</style>
