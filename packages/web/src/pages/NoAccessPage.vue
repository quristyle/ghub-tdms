<script setup lang="ts"></script>
<template>
  <div class="login-body">
    <div class="login-box">
      <div class="login-brand">
        <img class="login-brand-logo" src="/assets/skgas-logo.png" alt="SK gas" />
        <div class="login-brand-text">
          <h1 class="login-title">TDMS</h1>
          <p class="login-sub">기술자료 관리 시스템</p>
        </div>
      </div>
      <p class="login-change-title">접속할 수 있는 화면이 없습니다</p>
      <p class="login-rule" style="text-align:center">관리자에게 화면 접속 권한을 요청해 주세요.</p>
      <RouterLink to="/login" class="back-link">로그인 화면으로</RouterLink>
    </div>
  </div>
</template>
<style scoped>
.login-body {
  min-height: 100vh; height: 100%;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, #eef2f7 0%, #f6f8fa 60%, #eaeef4 100%);
  padding: 20px;
}
.login-box {
  width: 340px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 30px 28px; box-shadow: 0 8px 30px rgba(16, 24, 40, 0.1);
  text-align: center;
}
.login-brand { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 22px; }
.login-brand-logo { height: 36px; width: auto; }
.login-brand-text { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.login-title { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; margin: 0; }
.login-sub { font-size: 13.5px; font-weight: 700; color: var(--text-muted); margin: 0; }
.login-change-title { margin: 0; font-size: 14px; font-weight: 700; }
.login-rule { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.back-link {
  display: inline-flex; align-items: center; justify-content: center;
  width: 100%; height: 38px; margin-top: 22px;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text); font-size: 13px;
}
.back-link:hover { background: var(--surface-alt); border-color: var(--text-faint); border-bottom-color: var(--text-faint); }
</style>
