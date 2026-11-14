<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSession } from '@/lib/session'
import { ApiError } from '@/lib/api'

/** 로그인 — 기존 login.html / login.css 와 같은 모양. */

const session = useSession()
const router = useRouter()

const loginId = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const r = await session.login(loginId.value, password.value)
    // 최초 비밀번호 상태면 변경 화면을 먼저 연다 (미루기 가능 — 기존 정책)
    if (r.mustChangePassword) {
      void router.push('/password-change')
      return
    }
    void router.push(session.firstAllowedPath ?? '/')
  } catch (e) {
    error.value =
      e instanceof ApiError
        ? e.status === 429
          ? e.message
          : '아이디 또는 비밀번호가 맞지 않습니다.'
        : '로그인에 실패했습니다.'
  } finally {
    busy.value = false
  }
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

      <label>아이디
        <input v-model="loginId" type="text" autocomplete="username" autofocus />
      </label>
      <label>비밀번호
        <input v-model="password" type="password" autocomplete="current-password" />
      </label>
      <button class="primary" type="submit" :disabled="busy || !loginId || !password">
        {{ busy ? '확인 중…' : '로그인' }}
      </button>

      <p v-if="error" class="login-error">{{ error }}</p>
      <p class="login-rule">5회 연속 실패하면 15분간 잠깁니다.</p>
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

.login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
}
.login-brand-logo { height: 36px; width: auto; }

/* 제목(TDMS)과 부제(기술자료 관리 시스템) 사이만 따로 묶어 로고와의 간격보다 좁게 준다. */
.login-brand-text { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.login-title { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; margin: 0; }
.login-sub { font-size: 13.5px; font-weight: 700; color: var(--text-muted); margin: 0; }

.login-box label {
  display: block;
  margin-top: 14px;
  color: var(--text-muted);
  font-size: 12.5px;
}
.login-box input { width: 100%; height: 36px; margin-top: 5px; }
.login-box button { width: 100%; height: 38px; margin-top: 22px; font-size: 14px; font-weight: 600; }

.login-error {
  margin-top: 14px;
  padding: 8px 10px;
  background: var(--danger-soft);
  border: 1px solid #f3c9c7;
  border-radius: var(--radius);
  color: var(--danger);
  font-size: 12.5px;
  text-align: center;
}

.login-rule { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; text-align: center; }
</style>
