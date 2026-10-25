<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSession } from '@/lib/session'
import { ApiError } from '@/lib/api'

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
  <div class="login-wrap">
    <form class="login-box" @submit.prevent="submit">
      <h1><strong>TDMS</strong> 기술자료 관리 시스템</h1>
      <input v-model="loginId" type="text" placeholder="아이디" autocomplete="username" autofocus />
      <input v-model="password" type="password" placeholder="비밀번호" autocomplete="current-password" />
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn btn-primary" type="submit" :disabled="busy || !loginId || !password">
        {{ busy ? '확인 중…' : '로그인' }}
      </button>
      <p class="hint muted">5회 연속 실패하면 15분간 잠깁니다.</p>
    </form>
  </div>
</template>

<style scoped>
.login-wrap { display: flex; align-items: center; justify-content: center; height: 100%; }
.login-box {
  width: 320px; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px 28px 22px;
  display: flex; flex-direction: column; gap: 10px;
}
h1 { font-size: var(--fs-h1); margin: 0 0 10px; text-align: center; font-weight: 500; }
h1 strong { color: var(--accent); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 0; }
.hint { font-size: 11px; text-align: center; margin: 4px 0 0; }
</style>
