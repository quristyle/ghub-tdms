<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * 마이페이지 팝업 — 상단 바의 사용자 이름을 누르면 뜬다 (기존 auth-guard.js openMypageModal).
 *
 * 계정 정보(아이디·이름·권한)는 값이 바뀌지 않는 조회 전용이라 옅은 배경 박스로 한 덩어리로
 * 묶어 아래 비밀번호 변경 입력 폼과 시각적으로 분리한다.
 *
 * 비밀번호를 바꾸면 서버가 모든 세션을 끊으므로 로그인 화면으로 보낸다.
 */

const emit = defineEmits<{ close: [] }>()

const session = useSession()
const router = useRouter()

const current = ref('')
const next = ref('')
const confirm = ref('')
const error = ref('')
const done = ref('')
const busy = ref(false)

async function change() {
  error.value = ''
  done.value = ''
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
    done.value = '비밀번호가 변경됐습니다. 다시 로그인해 주세요.'
    session.clear()
    setTimeout(() => { void router.push('/login') }, 900)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '비밀번호를 바꾸지 못했습니다.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-box mypage-box" role="dialog" aria-modal="true" aria-label="마이페이지">
      <p class="modal-title">마이페이지</p>

      <div class="mypage-info">
        <div class="mypage-info-row">
          <span class="mypage-info-label">아이디</span>
          <span class="mypage-info-value">{{ session.me?.loginId }}</span>
        </div>
        <div class="mypage-info-row">
          <span class="mypage-info-label">이름</span>
          <span class="mypage-info-value">{{ session.me?.name }}</span>
        </div>
        <div class="mypage-info-row">
          <span class="mypage-info-label">권한</span>
          <span class="mypage-info-value">{{ session.me?.groupName || '미배정' }}</span>
        </div>
      </div>

      <p class="mypage-section-title">비밀번호 변경</p>
      <label class="mypage-field-label" for="mp-current-password">현재 비밀번호</label>
      <input id="mp-current-password" v-model="current" type="password" autocomplete="off" />
      <label class="mypage-field-label" for="mp-new-password">새 비밀번호</label>
      <input id="mp-new-password" v-model="next" type="password" autocomplete="new-password" />
      <label class="mypage-field-label" for="mp-new-password-confirm">새 비밀번호 확인</label>
      <input id="mp-new-password-confirm" v-model="confirm" type="password" autocomplete="new-password" />
      <p class="page-desc" style="margin-top:8px">규칙: 영문과 숫자를 섞어 8자 이상</p>

      <p v-if="error" class="login-error">{{ error }}</p>
      <p v-if="done" class="mypage-done">{{ done }}</p>

      <div class="modal-actions">
        <button type="button" @click="emit('close')">닫기</button>
        <button type="button" class="primary" :disabled="busy" @click="change">비밀번호 변경</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mypage-info {
  margin-top: 4px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--surface-alt);
  border: 1px solid var(--border);
}
.mypage-info-row { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
.mypage-info-row + .mypage-info-row { margin-top: 8px; }
.mypage-info-label { flex: 0 0 40px; color: var(--text-muted); font-size: 12px; }
.mypage-info-value { font-weight: 700; }

.mypage-section-title {
  margin: 20px 0 10px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-muted);
}

.mypage-field-label {
  display: block;
  font-size: 11.5px;
  color: var(--text-muted);
  margin: 10px 0 4px;
}

.mypage-box input[type="password"] { width: 100%; margin-top: 0; }

.login-error {
  margin-top: 14px; padding: 8px 10px;
  background: var(--danger-soft); border: 1px solid #f3c9c7;
  border-radius: var(--radius); color: var(--danger);
  font-size: 12.5px; text-align: center;
}
.mypage-done {
  margin-top: 14px; padding: 8px 10px;
  background: var(--ok-soft); border: 1px solid var(--ok-line);
  border-radius: var(--radius); color: var(--ok);
  font-size: 12.5px; text-align: center;
}
</style>
