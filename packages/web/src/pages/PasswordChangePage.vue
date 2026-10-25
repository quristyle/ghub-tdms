<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'

/** 최초 로그인 시 비밀번호 변경. 미루기 가능 — 미루면 다음 로그인 때 다시 열린다. */
const router = useRouter()
const session = useSession()

const current = ref('')
const next = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  if (next.value !== confirm.value) {
    error.value = '새 비밀번호가 서로 다릅니다.'
    return
  }
  busy.value = true
  try {
    await api.post('/auth/password', { currentPassword: current.value, newPassword: next.value })
    // 모든 세션이 끊겼다 — 다시 로그인한다
    session.me = null
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
</script>

<template>
  <div class="wrap">
    <form class="box" @submit.prevent="submit">
      <h1>비밀번호 변경</h1>
      <p class="muted small">처음 로그인했습니다. 비밀번호를 바꿔 주세요. (영문+숫자 8자 이상)</p>
      <input v-model="current" type="password" placeholder="현재 비밀번호" autocomplete="current-password" />
      <input v-model="next" type="password" placeholder="새 비밀번호" autocomplete="new-password" />
      <input v-model="confirm" type="password" placeholder="새 비밀번호 확인" autocomplete="new-password" />
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn btn-primary" type="submit" :disabled="busy">변경</button>
      <button class="btn" type="button" @click="defer">나중에 하기</button>
    </form>
  </div>
</template>

<style scoped>
.wrap { display: flex; align-items: center; justify-content: center; height: 100%; width: 100%; }
.box {
  width: 340px; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px; display: flex; flex-direction: column; gap: 10px;
}
h1 { font-size: var(--fs-h1); margin: 0; }
.small { font-size: var(--fs-sm); margin: 0 0 6px; }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 0; }
</style>
