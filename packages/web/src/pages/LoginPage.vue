<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { TotpEnrollment } from '@tdms/contracts'
import { useSession } from '@/lib/session'
import { ApiError } from '@/lib/api'

/**
 * 로그인 — 기존 login.html / login.css 와 같은 모양.
 *
 * 2단계로 들어온다.
 *   1) 아이디·비밀번호
 *   2) 인증 앱(Microsoft Authenticator)의 6자리 코드
 *      아직 등록하지 않은 계정은 2) 대신 QR 등록 화면이 열리고, 첫 코드를 넣으면 등록과
 *      로그인이 함께 끝난다.
 */

const session = useSession()
const router = useRouter()

type Step = 'password' | 'verify' | 'enroll'
const step = ref<Step>('password')

const loginId = ref('')
const password = ref('')
const code = ref('')
const challenge = ref('')
const enrollment = ref<TotpEnrollment | null>(null)
const error = ref('')
const busy = ref(false)
const codeInput = ref<HTMLInputElement | null>(null)

/** 코드 입력 제한시간 — 넘기면 처음부터 */
const deadline = ref(0)
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(timer))
const remainSec = computed(() => Math.max(0, Math.ceil((deadline.value - now.value) / 1000)))
const remainLabel = computed(() => {
  const s = remainSec.value
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

const qrSrc = computed(() =>
  enrollment.value ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrollment.value.qrSvg)}` : '',
)
const codeOk = computed(() => /^\d{6}$/.test(code.value))

function goIn(mustChangePassword: boolean) {
  // 초기·임시 비밀번호 상태면 변경 화면을 먼저 연다 ([다음에 변경하기]로 미룰 수 있다)
  if (mustChangePassword) {
    void router.push('/password-change')
    return
  }
  void router.push(session.firstAllowedPath ?? '/')
}

function restart(message = '') {
  step.value = 'password'
  password.value = ''
  code.value = ''
  challenge.value = ''
  enrollment.value = null
  error.value = message
}

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const r = await session.login(loginId.value, password.value)
    if (r.mfa === 'none') {
      goIn(r.mustChangePassword)
      return
    }
    challenge.value = r.challenge
    deadline.value = Date.now() + r.expiresInSec * 1000
    enrollment.value = r.mfa === 'enroll' ? r.enrollment : null
    code.value = ''
    step.value = r.mfa
    password.value = ''
    await nextTick()
    codeInput.value?.focus()
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

async function submitCode() {
  if (!codeOk.value || busy.value) return
  if (remainSec.value === 0) {
    restart('인증 시간이 지났습니다. 처음부터 다시 로그인하세요.')
    return
  }
  error.value = ''
  busy.value = true
  try {
    const r = await session.verifyMfa(challenge.value, code.value)
    goIn(r.mustChangePassword)
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 409 || e.status === 429)) {
      restart(e.message)
      return
    }
    error.value = e instanceof ApiError ? e.message : '확인에 실패했습니다.'
    code.value = ''
    await nextTick()
    codeInput.value?.focus()
  } finally {
    busy.value = false
  }
}

function onCodeInput(ev: Event) {
  code.value = (ev.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6)
  if (codeOk.value) void submitCode()
}
</script>

<template>
  <div class="login-body">
    <form v-if="step === 'password'" class="login-box" @submit.prevent="submit">
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
      <p class="login-rule">5회 연속 실패하면 15분간 잠깁니다.<br />로그인에는 Microsoft Authenticator 앱이 필요합니다.</p>
    </form>

    <form v-else class="login-box" :class="{ 'login-box--wide': step === 'enroll' }" @submit.prevent="submitCode">
      <div class="login-brand">
        <div class="login-brand-text">
          <h1 class="login-title">{{ step === 'enroll' ? '인증 앱 등록' : '2차 인증' }}</h1>
          <p class="login-sub">{{ loginId }}</p>
        </div>
      </div>

      <template v-if="step === 'enroll' && enrollment">
        <ol class="mfa-steps">
          <li>휴대폰에 <strong>Microsoft Authenticator</strong> 앱을 설치합니다.</li>
          <li>앱에서 <strong>＋ (계정 추가)</strong> → <strong>기타 계정(Google, Facebook 등)</strong> 을 고르고 아래 QR 코드를 찍습니다.</li>
          <li>앱에 나온 <strong>6자리 코드</strong>를 아래에 넣으면 등록과 로그인이 끝납니다.</li>
        </ol>
        <div class="mfa-qr">
          <img :src="qrSrc" alt="인증 앱 등록 QR 코드" width="200" height="200" />
        </div>
        <details class="mfa-manual">
          <summary>QR 을 찍을 수 없을 때 — 키 직접 입력</summary>
          <p>앱에서 <strong>코드를 수동으로 입력</strong>을 고르고 아래 값을 넣습니다.</p>
          <dl>
            <dt>계정 이름</dt><dd>{{ enrollment.issuer }} ({{ enrollment.account }})</dd>
            <dt>비밀 키</dt><dd><code class="mfa-secret">{{ enrollment.secret }}</code></dd>
          </dl>
        </details>
      </template>
      <p v-else class="mfa-lead">
        Microsoft Authenticator 앱의 <strong>TDMS</strong> 항목에 나온 6자리 코드를 넣으세요.
      </p>

      <label>인증 코드
        <input
          ref="codeInput"
          class="mfa-code"
          :value="code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          placeholder="000000"
          @input="onCodeInput"
        />
      </label>
      <button class="primary" type="submit" :disabled="busy || !codeOk">
        {{ busy ? '확인 중…' : step === 'enroll' ? '등록하고 로그인' : '확인' }}
      </button>

      <p v-if="error" class="login-error">{{ error }}</p>
      <p class="login-rule">
        남은 시간 {{ remainLabel }}
        · <a href="#" class="mfa-back" @click.prevent="restart()">처음으로</a>
      </p>
      <p v-if="step === 'verify'" class="login-rule">휴대폰을 바꿨거나 잃어버렸으면 관리자에게 OTP 초기화를 요청하세요.</p>
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
  background: linear-gradient(160deg, var(--auth-bg-1) 0%, var(--auth-bg-2) 60%, var(--auth-bg-3) 100%);
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
  border: 1px solid var(--danger-line-soft);
  border-radius: var(--radius);
  color: var(--danger);
  font-size: 12.5px;
  text-align: center;
}

.login-rule { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; text-align: center; }

/* ── 2차 인증 ───────────────────────────────────────────── */
.login-box--wide { width: 400px; }
.mfa-steps { margin: 0 0 12px; padding-left: 18px; font-size: 12.5px; line-height: 1.6; }
.mfa-lead { margin: 0 0 4px; font-size: 13px; line-height: 1.6; text-align: center; }
.mfa-qr { display: flex; justify-content: center; }
/* QR 은 테마와 상관없이 흰 바탕이라야 앱이 읽는다 */
.mfa-qr img { background: #fff; padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
.mfa-manual { margin-top: 10px; font-size: 12px; color: var(--text-muted); }
.mfa-manual summary { cursor: pointer; }
.mfa-manual dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 6px 0 0; }
.mfa-manual dt { font-weight: 600; }
.mfa-manual dd { margin: 0; }
.mfa-secret { user-select: all; font-size: 12.5px; letter-spacing: 0.04em; word-break: break-all; }
.login-box input.mfa-code { font-size: 20px; letter-spacing: 0.4em; text-align: center; font-variant-numeric: tabular-nums; }
.mfa-back { color: inherit; }
</style>
