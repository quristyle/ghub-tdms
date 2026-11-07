<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import { ApiError, setReauthenticationHandler } from '@/lib/api'
import { useSession } from '@/lib/session'
import Modal from './Modal.vue'

const session = useSession()
const queryClient = useQueryClient()
const router = useRouter()

const open = ref(false)
const useAnotherUser = ref(!session.me)
const loginId = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)
let complete: ((authenticated: boolean) => void) | null = null

function requestAuthentication(): Promise<boolean> {
  loginId.value = session.me?.loginId ?? ''
  password.value = ''
  error.value = ''
  useAnotherUser.value = !session.me
  open.value = true
  return new Promise((resolve) => { complete = resolve })
}

function finish(authenticated: boolean) {
  open.value = false
  complete?.(authenticated)
  complete = null
}

async function submit() {
  if (busy.value) return
  const account = useAnotherUser.value ? loginId.value.trim() : session.me?.loginId
  if (!account || !password.value) {
    error.value = '아이디와 비밀번호를 입력해 주세요.'
    return
  }

  busy.value = true
  error.value = ''
  const previousUserId = session.me?.id
  try {
    await session.login(account, password.value)
    if (previousUserId !== undefined && session.me?.id !== previousUserId) {
      queryClient.clear()
    }
    finish(true)
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 429
        ? e.message
        : e instanceof ApiError && e.status === 401
          ? '아이디 또는 비밀번호가 맞지 않습니다.'
          : '로그인 중 오류가 발생했습니다. 다시 시도해 주세요.'
    password.value = ''
  } finally {
    busy.value = false
  }
}

function cancel() {
  if (busy.value) return
  session.clear()
  finish(false)
  void router.push('/login')
}

setReauthenticationHandler(requestAuthentication)
onBeforeUnmount(() => setReauthenticationHandler(null))
</script>

<template>
  <Modal v-if="open" title="로그인 정보 확인" @close="cancel">
    <p class="reauth-message">
      세션이 만료되었습니다. 비밀번호를 입력하면 진행 중이던 작업을 다시 시도합니다.
    </p>
    <p v-if="!useAnotherUser && session.me" class="reauth-account">
      {{ session.me.name }} ({{ session.me.loginId }}) 계정으로 다시 로그인합니다.
    </p>
    <form id="reauth-form" class="reauth-form" @submit.prevent="submit">
      <label v-if="useAnotherUser">
        아이디
        <input v-model="loginId" type="text" autocomplete="username" required :disabled="busy">
      </label>
      <label>
        비밀번호
        <input v-model="password" type="password" autocomplete="current-password" required :disabled="busy">
      </label>
      <p v-if="error" class="reauth-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button
        v-if="session.me"
        class="btn"
        type="button"
        :disabled="busy"
        @click="useAnotherUser = !useAnotherUser; error = ''"
      >{{ useAnotherUser ? '현재 사용자로 로그인' : '다른 사용자로 로그인' }}</button>
      <span style="flex:1" />
      <button class="btn" type="button" :disabled="busy" @click="cancel">취소</button>
      <button class="btn btn-primary" type="submit" form="reauth-form" :disabled="busy || !password">
        {{ busy ? '확인 중…' : '다시 로그인' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.reauth-message { margin: 0 0 10px; }
.reauth-account { margin: 0 0 12px; color: var(--fg-muted); font-size: var(--fs-sm); }
.reauth-form, .reauth-form label { display: flex; flex-direction: column; gap: 7px; }
.reauth-form { gap: 12px; }
.reauth-form input { width: 100%; }
.reauth-error { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
</style>
