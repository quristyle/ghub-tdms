<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useQuery } from '@tanstack/vue-query'
import type { FavoriteCountResponse } from '@tdms/contracts'
import { listOpen as favListOpen } from '@/lib/favorites'

/**
 * 마이페이지 화면
 *
 * 팝업(모달) 또는 독립 화면(/mypage)으로 렌더링되며, 로그인한 사용자의
 * 기본 신원/조직 정보 확인, 연락처 수정, 비밀번호 변경, 보안 및 보관함 현황을 제공한다.
 */
const props = withDefaults(defineProps<{
  isModal?: boolean
}>(), {
  isModal: false,
})

const emit = defineEmits<{
  close: []
}>()

const session = useSession()
const router = useRouter()

// ── 탭 관리 ────────────────────────────────────────────────────────────
type TabKey = 'profile' | 'password' | 'security'
const currentTab = ref<TabKey>('profile')

// ── 연락처 수정 폼 ──────────────────────────────────────────────────────
const email = ref('')
const phone = ref('')
const extensionNumber = ref('')
const profileSaving = ref(false)
const profileError = ref('')
const profileSuccess = ref('')

function syncFromSession() {
  if (session.me) {
    email.value = session.me.email ?? ''
    phone.value = session.me.phone ?? ''
    extensionNumber.value = session.me.extensionNumber ?? ''
  }
}

onMounted(() => {
  syncFromSession()
})

async function saveProfile() {
  profileError.value = ''
  profileSuccess.value = ''
  profileSaving.value = true
  try {
    await api.put('/auth/profile', {
      email: email.value.trim() || null,
      phone: phone.value.trim() || null,
      extensionNumber: extensionNumber.value.trim() || null,
    })
    await session.load()
    syncFromSession()
    profileSuccess.value = '연락처 정보가 성공적으로 저장되었습니다.'
    setTimeout(() => { profileSuccess.value = '' }, 3000)
  } catch (e) {
    profileError.value = e instanceof ApiError ? e.message : '연락처 정보를 저장하지 못했습니다.'
  } finally {
    profileSaving.value = false
  }
}

// ── 비밀번호 변경 폼 ──────────────────────────────────────────────────
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const pwError = ref('')
const pwSuccess = ref('')
const pwBusy = ref(false)

async function changePassword() {
  pwError.value = ''
  pwSuccess.value = ''
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    pwError.value = '현재 비밀번호와 새 비밀번호를 모두 입력해 주세요.'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    pwError.value = '새 비밀번호와 확인 입력이 일치하지 않습니다.'
    return
  }
  if (newPassword.value.length < 8) {
    pwError.value = '비밀번호는 최소 8자 이상이어야 합니다.'
    return
  }
  pwBusy.value = true
  try {
    await api.post('/auth/password', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    pwSuccess.value = '비밀번호가 변경되었습니다. 보안을 위해 다시 로그인해 주세요.'
    session.clear()
    setTimeout(() => {
      if (props.isModal) emit('close')
      void router.push('/login')
    }, 1200)
  } catch (e) {
    pwError.value = e instanceof ApiError ? e.message : '비밀번호를 변경하지 못했습니다.'
  } finally {
    pwBusy.value = false
  }
}

// ── 보관함 정보 ────────────────────────────────────────────────────────
const { data: favCount } = useQuery({
  queryKey: ['favorites', 'summary'],
  queryFn: () => api.get<FavoriteCountResponse>('/favorites/summary'),
  enabled: computed(() => session.isLoggedIn),
  staleTime: 60_000,
})

function openFavorites() {
  if (props.isModal) emit('close')
  favListOpen.value = true
}

// ── 날짜 포맷 헬퍼 ────────────────────────────────────────────────────
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso.slice(0, 19).replace('T', ' ')
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    const s = String(d.getSeconds()).padStart(2, '0')
    return `${y}-${m}-${day} ${h}:${min}:${s}`
  } catch {
    return iso.slice(0, 19).replace('T', ' ')
  }
}

const userInitial = computed(() => {
  const name = session.me?.name || 'U'
  return name.charAt(0)
})

const companyName = computed(() => {
  if (session.me?.partnerCompanyName) return session.me.partnerCompanyName
  if (session.me?.companyCode === 'SKGAS') return 'SK가스'
  return session.me?.companyCode || 'SK가스'
})
</script>

<template>
  <div class="mypage-page" :class="{ 'in-modal': isModal }">
    <!-- 상단 프로필 헤더 카드 -->
    <div class="profile-hero">
      <div class="hero-avatar" aria-hidden="true">
        {{ userInitial }}
      </div>
      <div class="hero-meta">
        <div class="hero-name-row">
          <h2 class="hero-name">{{ session.me?.name }}</h2>
          <span class="role-badge" :class="session.isAdmin ? 'badge-admin' : 'badge-viewer'">
            {{ session.isAdmin ? '시스템 관리자' : '조회자' }}
          </span>
          <span class="status-badge">
            {{ session.me?.employmentStatus === 'RETIRED' ? '퇴직' : '재직중' }}
          </span>
        </div>
        <div class="hero-sub-row">
          <span class="hero-sub-item"><strong>아이디:</strong> {{ session.me?.loginId }}</span>
          <span v-if="session.me?.employeeNumber" class="hero-sub-item">
            <strong>사번:</strong> {{ session.me.employeeNumber }}
          </span>
          <span class="hero-sub-item"><strong>소속:</strong> {{ companyName }}</span>
          <span v-if="session.me?.department" class="hero-sub-item">
            <strong>부서:</strong> {{ session.me.department }}
          </span>
          <span v-if="session.me?.position" class="hero-sub-item">
            <strong>직위:</strong> {{ session.me.position }}
          </span>
        </div>
      </div>
    </div>

    <!-- 탭 내비게이션 -->
    <div class="mypage-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: currentTab === 'profile' }"
        :aria-selected="currentTab === 'profile'"
        @click="currentTab = 'profile'"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tab-icon">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        기본 정보 및 연락처
      </button>
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: currentTab === 'password' }"
        :aria-selected="currentTab === 'password'"
        @click="currentTab = 'password'"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tab-icon">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        비밀번호 변경
      </button>
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: currentTab === 'security' }"
        :aria-selected="currentTab === 'security'"
        @click="currentTab = 'security'"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tab-icon">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        보안 및 활동 현황
      </button>
    </div>

    <!-- 탭 1: 기본 정보 및 연락처 -->
    <div v-if="currentTab === 'profile'" class="tab-content profile-tab" role="tabpanel">
      <!-- 기본 신원 및 소속 정보 (읽기 전용) -->
      <section class="mypage-section">
        <h3 class="section-heading">계정 및 조직 정보</h3>
        <div class="info-grid">
          <div class="info-cell">
            <span class="info-label">로그인 아이디</span>
            <span class="info-val">{{ session.me?.loginId }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">성명</span>
            <span class="info-val font-semibold">{{ session.me?.name }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">사번</span>
            <span class="info-val">{{ session.me?.employeeNumber || '-' }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">소속 회사</span>
            <span class="info-val">{{ companyName }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">부서</span>
            <span class="info-val">{{ session.me?.department || '-' }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">직위</span>
            <span class="info-val">{{ session.me?.position || '-' }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">권한 그룹</span>
            <span class="info-val">{{ session.me?.groupName || '미배정' }}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">시스템 역할</span>
            <span class="info-val">{{ session.isAdmin ? '시스템 관리자 (ADMIN)' : '일반 조회자 (VIEWER)' }}</span>
          </div>
        </div>
      </section>

      <!-- 연락처 수정 섹션 -->
      <section class="mypage-section">
        <div class="section-heading-row">
          <h3 class="section-heading">연락처 정보 관리</h3>
          <span class="section-desc">본인의 이메일 및 전화번호를 최신으로 유지하세요.</span>
        </div>
        <form class="contact-form" @submit.prevent="saveProfile">
          <div class="form-row">
            <div class="form-group">
              <label for="mp-email" class="form-label">이메일 주소</label>
              <input
                id="mp-email"
                v-model="email"
                type="email"
                placeholder="example@skgas.co.kr"
                autocomplete="email"
              />
            </div>
          </div>
          <div class="form-row two-cols">
            <div class="form-group">
              <label for="mp-phone" class="form-label">휴대전화번호</label>
              <input
                id="mp-phone"
                v-model="phone"
                type="tel"
                placeholder="010-0000-0000"
                autocomplete="tel"
              />
            </div>
            <div class="form-group">
              <label for="mp-ext" class="form-label">사내 내선번호</label>
              <input
                id="mp-ext"
                v-model="extensionNumber"
                type="text"
                placeholder="예: 1234"
              />
            </div>
          </div>

          <div v-if="profileError" class="alert-box error">{{ profileError }}</div>
          <div v-if="profileSuccess" class="alert-box success">{{ profileSuccess }}</div>

          <div class="form-actions">
            <button type="submit" class="primary save-btn" :disabled="profileSaving">
              {{ profileSaving ? '저장 중...' : '연락처 저장' }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <!-- 탭 2: 비밀번호 변경 -->
    <div v-if="currentTab === 'password'" class="tab-content password-tab" role="tabpanel">
      <section class="mypage-section">
        <div class="section-heading-row">
          <h3 class="section-heading">계정 비밀번호 변경</h3>
          <span class="section-desc">주기적인 비밀번호 변경으로 계정을 안전하게 보호하세요.</span>
        </div>

        <form class="password-form" @submit.prevent="changePassword">
          <div class="form-group">
            <label for="mp-cur-pw" class="form-label">현재 비밀번호</label>
            <input
              id="mp-cur-pw"
              v-model="currentPassword"
              type="password"
              placeholder="현재 사용 중인 비밀번호"
              autocomplete="current-password"
            />
          </div>

          <div class="form-group">
            <label for="mp-new-pw" class="form-label">새 비밀번호</label>
            <input
              id="mp-new-pw"
              v-model="newPassword"
              type="password"
              placeholder="새로운 비밀번호 (8자 이상)"
              autocomplete="new-password"
            />
            <p class="field-hint">영문과 숫자를 조합하여 8자 이상 입력해 주세요.</p>
          </div>

          <div class="form-group">
            <label for="mp-conf-pw" class="form-label">새 비밀번호 확인</label>
            <input
              id="mp-conf-pw"
              v-model="confirmPassword"
              type="password"
              placeholder="새 비밀번호 다시 입력"
              autocomplete="new-password"
            />
          </div>

          <div v-if="pwError" class="alert-box error">{{ pwError }}</div>
          <div v-if="pwSuccess" class="alert-box success">{{ pwSuccess }}</div>

          <div class="form-actions">
            <button type="submit" class="primary save-btn" :disabled="pwBusy">
              {{ pwBusy ? '변경 중...' : '비밀번호 변경하기' }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <!-- 탭 3: 보안 및 활동 현황 -->
    <div v-if="currentTab === 'security'" class="tab-content security-tab" role="tabpanel">
      <section class="mypage-section">
        <h3 class="section-heading">계정 보안 현황</h3>
        <div class="security-card-grid">
          <div class="sec-card">
            <div class="sec-card-header">
              <span class="sec-card-title">2차 인증 (MFA)</span>
              <span class="sec-badge" :class="session.me?.totpEnabled ? 'badge-on' : 'badge-off'">
                {{ session.me?.totpEnabled ? '사용 중' : '미등록' }}
              </span>
            </div>
            <p class="sec-card-desc">
              {{ session.me?.totpEnabled
                ? 'Microsoft Authenticator 등을 통한 2차 인증이 등록되어 계정이 안전하게 보호되고 있습니다.'
                : '2차 인증 등록 시 로그인 보안 수준을 한층 높일 수 있습니다. (초기화 필요 시 관리자에게 문의)' }}
            </p>
          </div>

          <div class="sec-card">
            <div class="sec-card-header">
              <span class="sec-card-title">비밀번호 변경 정책</span>
              <span class="sec-badge" :class="session.me?.mustChangePassword ? 'badge-warn' : 'badge-on'">
                {{ session.me?.mustChangePassword ? '변경 권고' : '정상' }}
              </span>
            </div>
            <p class="sec-card-desc">
              {{ session.me?.mustChangePassword
                ? '초기 또는 임시 비밀번호 상태이므로 즉시 비밀번호를 변경해 주시기 바랍니다.'
                : '정상적인 비밀번호를 사용 중입니다.' }}
            </p>
          </div>
        </div>
      </section>

      <section class="mypage-section">
        <h3 class="section-heading">접속 이력</h3>
        <div class="history-list">
          <div class="history-row">
            <span class="hist-label">최근 로그인 일시</span>
            <span class="hist-val">{{ formatDateTime(session.me?.lastLoginAt) }}</span>
          </div>
          <div class="history-row">
            <span class="hist-label">직전 로그인 일시</span>
            <span class="hist-val">{{ formatDateTime(session.me?.previousLoginAt) }}</span>
          </div>
          <div class="history-row">
            <span class="hist-label">계정 생성 일시</span>
            <span class="hist-val">{{ formatDateTime(session.me?.createdAt) }}</span>
          </div>
        </div>
      </section>

      <section class="mypage-section">
        <div class="section-heading-row">
          <h3 class="section-heading">내 보관함 바로가기</h3>
          <span class="section-desc">자주 참조하는 도면 및 기술자료 보관 현황입니다.</span>
        </div>
        <div class="fav-summary-box">
          <div class="fav-summary-info">
            <span class="fav-icon" aria-hidden="true">⭐</span>
            <span class="fav-count-text">
              현재 보관 중인 기술자료: <strong>{{ favCount?.count ?? 0 }}</strong>건
            </span>
          </div>
          <button type="button" class="fav-open-link-btn" @click="openFavorites">
            보관함 열기 &rarr;
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mypage-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text);
  font-family: inherit;
}

.mypage-page:not(.in-modal) {
  max-width: 860px;
  margin: 24px auto;
  padding: 0 16px;
}

/* ── 상단 프로필 헤더 카드 ────────────────────────────────────────── */
.profile-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 20px;
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 8px);
}

.hero-avatar {
  width: 54px;
  height: 54px;
  flex-shrink: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--primary, #0070c0), #004b87);
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}

.hero-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.hero-name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.hero-name {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}

.role-badge, .status-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 12px;
  line-height: 1.3;
}

.badge-admin {
  background: var(--primary-soft, #e8f4fc);
  color: var(--primary, #0070c0);
  border: 1px solid var(--primary-line, #b3d7f5);
}

.badge-viewer {
  background: var(--surface-sunken);
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.status-badge {
  background: var(--ok-soft, #eafaf1);
  color: var(--ok, #2ecc71);
  border: 1px solid var(--ok-line, #abebc6);
}

.hero-sub-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.hero-sub-item strong {
  color: var(--text-dark-gray, #555);
  font-weight: 600;
  margin-right: 3px;
}

/* ── 탭 내비게이션 ────────────────────────────────────────────────── */
.mypage-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 2px solid var(--border);
  padding-bottom: 0;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
  border-radius: 0;
}

.tab-btn:hover {
  color: var(--text);
  background: var(--surface-alt);
}

.tab-btn.active {
  color: var(--primary, #0070c0);
  border-bottom-color: var(--primary, #0070c0);
  background: transparent;
}

.tab-icon {
  flex-shrink: 0;
}

/* ── 탭 콘텐츠 공통 ──────────────────────────────────────────────── */
.tab-content {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 0 10px;
}

.mypage-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
}

.section-heading-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.section-heading {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.section-heading-row .section-heading {
  margin-bottom: 0;
}

.section-desc {
  font-size: 11.5px;
  color: var(--text-muted);
}

/* ── 기본 정보 그리드 ────────────────────────────────────────────── */
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px 16px;
  background: var(--surface-alt);
  padding: 14px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.info-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.info-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}

.info-val {
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
}

.font-semibold {
  font-weight: 600;
}

/* ── 폼 스타일 ────────────────────────────────────────────────────── */
.contact-form, .password-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  gap: 16px;
  width: 100%;
}

.form-row.two-cols > .form-group {
  flex: 1;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
}

.form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dark-gray, #444);
}

.field-hint {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
}

input[type="text"],
input[type="email"],
input[type="tel"],
input[type="password"] {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  box-sizing: border-box;
}

input:focus {
  outline: none;
  border-color: var(--primary, #0070c0);
  box-shadow: 0 0 0 2px var(--primary-soft, rgba(0, 112, 192, 0.15));
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}

.save-btn {
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 600;
}

/* ── 알림 박스 ────────────────────────────────────────────────────── */
.alert-box {
  padding: 9px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  text-align: center;
  font-weight: 500;
}

.alert-box.error {
  background: var(--danger-soft, #fdf0ed);
  border: 1px solid var(--danger-line-soft, #fadbd8);
  color: var(--danger, #c0392b);
}

.alert-box.success {
  background: var(--ok-soft, #eafaf1);
  border: 1px solid var(--ok-line, #abebc6);
  color: var(--ok, #27ae60);
}

/* ── 보안 & 활동 현황 ────────────────────────────────────────────── */
.security-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.sec-card {
  padding: 12px 14px;
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.sec-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.sec-card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.sec-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 10px;
}

.badge-on {
  background: var(--ok-soft, #eafaf1);
  color: var(--ok, #27ae60);
  border: 1px solid var(--ok-line, #abebc6);
}

.badge-off {
  background: var(--surface-sunken);
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.badge-warn {
  background: var(--warning-soft, #fef9e7);
  color: var(--warning, #d35400);
  border: 1px solid var(--warning-line, #f9e79f);
}

.sec-card-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface-alt);
  padding: 12px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.history-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 12.5px;
}

.history-row + .history-row {
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}

.hist-label {
  color: var(--text-muted);
}

.hist-val {
  font-weight: 600;
  font-family: monospace, sans-serif;
}

.fav-summary-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  flex-wrap: wrap;
  gap: 12px;
}

.fav-summary-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
}

.fav-icon {
  font-size: 16px;
}

.fav-count-text strong {
  color: var(--primary, #0070c0);
  font-size: 15px;
}

.fav-open-link-btn {
  padding: 7px 14px;
  font-size: 12.5px;
  font-weight: 600;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s ease;
}

.fav-open-link-btn:hover {
  background: var(--primary, #0070c0);
  color: #fff;
  border-color: var(--primary, #0070c0);
}

/* ── 모달 내부 배치 시 여백 최적화 ──────────────────────────────── */
.mypage-page.in-modal {
  padding: 0;
}

/* ── 모바일 반응형 ────────────────────────────────────────────────── */
@media (max-width: 600px) {
  .profile-hero {
    flex-direction: column;
    text-align: center;
    padding: 14px;
  }
  .hero-name-row {
    justify-content: center;
  }
  .hero-sub-row {
    justify-content: center;
    gap: 8px;
  }
  .form-row.two-cols {
    flex-direction: column;
    gap: 12px;
  }
  .info-grid {
    grid-template-columns: 1fr;
  }
  .tab-btn {
    padding: 8px 10px;
    font-size: 12px;
  }
}
</style>
