<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * 최초 로그인 시 비밀번호 변경 — 기존 login.html 의 #change-panel 과 같은 모양.
 * 급할 땐 [다음에 변경하기]로 미루고 다음 로그인 때 다시 안내한다 (2026-09-29).
 */
const router = useRouter()
const session = useSession()

const current = ref('')
const next = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  if (!current.value || !next.value || !confirm.value) {
    error.value = '현재 비밀번호와 새 비밀번호를 모두 입력해 주세요'
    return
  }
  if (next.value !== confirm.value) {
    error.value = '새 비밀번호와 확인이 서로 다릅니다'
    return
  }
  busy.value = true
  try {
    await api.post('/auth/password', { currentPassword: current.value, newPassword: next.value })
    // 모든 세션이 끊겼다 — 다시 로그인한다
    session.clear()
    void router.push('/login')
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '변경에 실패했습니다.'
  } finally {
    busy.value = false
  }
}

async function defer() {
  await session.deferPasswordChange()
  void router.push(session.firstAllowedPath ?? '/')
}

async function logout() {
  await session.logout()
  void router.push('/login')
}
</script>

<template>
  <div class="login-body">
    <form class="login-box" @submit.prevent="submit">
      <div class="login-brand">
        <img class="login-brand-logo" src="/assets/skgas-logo.png" alt="SK gas" />
        <div class="login-brand-text">
          <h1 class="login-title">TDMS</h1>
          <p class="login-sub">기술자료 관리 시스템</p>
        </div>
      </div>

      <p class="login-change-title">새 비밀번호를 정해 주세요</p>
      <label>현재(임시) 비밀번호
        <input v-model="current" type="password" autocomplete="current-password" />
      </label>
      <label>새 비밀번호
        <input v-model="next" type="password" autocomplete="new-password" />
      </label>
      <label>새 비밀번호 확인
        <input v-model="confirm" type="password" autocomplete="new-password" />
      </label>
      <p class="login-rule">규칙: 영문과 숫자를 섞어 8자 이상</p>

      <button class="primary" type="submit" :disabled="busy">비밀번호 변경</button>
      <button class="login-secondary-btn" type="button" @click="defer">다음에 변경하기</button>
      <button class="login-secondary-btn" type="button" @click="logout">로그아웃</button>

      <p v-if="error" class="login-error">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login-body {
  min-height: 100vh;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #eef2f7 0%, #f6f8fa 60%, #eaeef4 100%);
  padding: 20px;
}

.login-box {
  width: 340px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 30px 28px;
  box-shadow: 0 8px 30px rgba(16, 24, 40, 0.1);
}

.login-brand { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 22px; }
.login-brand-logo { height: 36px; width: auto; }
.login-brand-text { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.login-title { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; margin: 0; }
.login-sub { font-size: 13.5px; font-weight: 700; color: var(--text-muted); margin: 0; }

.login-change-title { margin: 0; font-size: 14px; font-weight: 700; text-align: center; }

.login-box label { display: block; margin-top: 14px; color: var(--text-muted); font-size: 12.5px; }
.login-box input { width: 100%; height: 36px; margin-top: 5px; }
.login-box button { width: 100%; height: 38px; margin-top: 22px; font-size: 14px; font-weight: 600; }
.login-box button.login-secondary-btn { height: 32px; margin-top: 8px; font-size: 13px; font-weight: 400; }

.login-rule { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; word-break: keep-all; }

.login-error {
  margin-top: 14px; padding: 8px 10px;
  background: var(--danger-soft); border: 1px solid #f3c9c7;
  border-radius: var(--radius); color: var(--danger);
  font-size: 12.5px; text-align: center;
}
</style>
