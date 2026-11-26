<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { JobDetail } from '@tdms/contracts'
import { api, ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'
import CartModal from '@/ui/CartModal.vue'

// ── 작업 목록 조회 (내 작업 중 zip_build 대상) ───────────────────────────
const qc = useQueryClient()
const filterState = ref<'ALL' | 'ACTIVE' | 'DONE' | 'FAILED'>('ALL')

const {
  data: jobData,
  isLoading,
  isFetching,
  refetch,
} = useQuery({
  queryKey: ['jobs', 'zip_build'],
  queryFn: () => api.get<{ items: JobDetail[] }>('/jobs?kind=zip_build'),
  refetchOnWindowFocus: true,
  staleTime: 1000,
})

const allJobs = computed(() => jobData.value?.items ?? [])

// 활성 작업 (대기중 or 압축 진행중)
const hasActiveJob = computed(() =>
  allJobs.value.some((j) => j.state === 'queued' || j.state === 'running'),
)

// 필터링된 작업 목록
const filteredJobs = computed(() => {
  const list = allJobs.value
  if (filterState.value === 'ACTIVE') {
    return list.filter((j) => j.state === 'queued' || j.state === 'running')
  }
  if (filterState.value === 'DONE') {
    return list.filter((j) => j.state === 'done')
  }
  if (filterState.value === 'FAILED') {
    return list.filter((j) => j.state === 'failed' || j.state === 'canceled')
  }
  return list
})

// ── 실시간 갱신 타이머 (진행 중인 작업이 있으면 1.5초마다 갱신) ─────────────
let pollTimer: ReturnType<typeof setInterval> | null = null

function updatePolling() {
  if (hasActiveJob.value) {
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void refetch()
      }, 1500)
    }
  } else if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(hasActiveJob, () => updatePolling(), { immediate: true })

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

// ── 이전 작업 상태 기억하여 완료 시 토스트 알림 ─────────────────────────
const prevActiveJobIds = ref<Set<number>>(new Set())

watch(allJobs, (jobs) => {
  const currentActive = new Set(
    jobs.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.id),
  )
  for (const id of prevActiveJobIds.value) {
    if (!currentActive.has(id)) {
      const finishedJob = jobs.find((j) => j.id === id)
      if (finishedJob?.state === 'done') {
        toast.ok(`"${finishedJob.resultFilename ?? '압축파일'}" 압축이 완료되었습니다. 지금 다운로드할 수 있습니다.`)
      }
    }
  }
  prevActiveJobIds.value = currentActive
})

// ── 파일 크기 표시 헬퍼 ─────────────────────────────────────────────────
function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0)} ${sizes[i]}`
}

// ── 날짜 포맷 헬퍼 ──────────────────────────────────────────────────────
function formatDate(iso: string | null): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`
  } catch {
    return iso.slice(0, 19).replace('T', ' ')
  }
}

// ── 다운로드 실행 ───────────────────────────────────────────────────────
function handleDownload(job: JobDetail) {
  if (job.state !== 'done') {
    toast.err('아직 압축이 완료되지 않았습니다.')
    return
  }
  // 직접 브라우저 다운로드 링크 호출
  const url = `/api/jobs/${job.id}/download`
  const a = document.createElement('a')
  a.href = url
  a.download = job.resultFilename || `download_${job.id}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  toast.ok(`"${job.resultFilename || 'zip 파일'}" 다운로드를 시작했습니다.`)
}

// ── 작업 취소 ───────────────────────────────────────────────────────────
const canceling = ref<number | null>(null)

async function handleCancel(job: JobDetail) {
  if (!window.confirm(`작업 #${job.id} 압축을 취소하시겠습니까?`)) return
  canceling.value = job.id
  try {
    await api.post(`/jobs/${job.id}/cancel`, {})
    toast.ok('작업을 취소했습니다.')
    await refetch()
  } catch (err) {
    toast.err(err instanceof ApiError ? err.message : '작업 취소에 실패했습니다.')
  } finally {
    canceling.value = null
  }
}

// ── 반출대기함 모달 열기 ─────────────────────────────────────────────────
const cartModalOpen = ref(false)
</script>

<template>
  <div class="downloads-page">
    <!-- 화면 상단 헤더 및 안내 -->
    <header class="page-header">
      <div class="header-left">
        <h1 class="page-title">
          <span class="icon">📦</span> 반출자료 다운로드
        </h1>
        <p class="page-desc">
          반출 대기함에서 요청한 zip 압축 작업의 진행 상태를 실시간으로 확인하고, 완료된 압축 파일을 내려받을 수 있습니다.
        </p>
      </div>

      <div class="header-right">
        <button
          class="refresh-btn"
          type="button"
          :disabled="isFetching"
          title="목록 새로고침"
          @click="() => refetch()"
        >
          <span class="icon" :class="{ spinning: isFetching }">🔄</span> 새로고침
        </button>
        <button
          class="primary cart-btn"
          type="button"
          title="반출대기함 열기"
          @click="cartModalOpen = true"
        >
          📁 반출대기함 열기
        </button>
      </div>
    </header>

    <!-- 실시간 진행 중 작업 알림 배너 (있을 때 강조 표시) -->
    <section v-if="hasActiveJob" class="active-banner">
      <div class="banner-badge">
        <span class="pulse-dot" /> 압축 진행 중
      </div>
      <div class="active-job-list">
        <div
          v-for="j in allJobs.filter((x) => x.state === 'queued' || x.state === 'running')"
          :key="j.id"
          class="active-job-card"
        >
          <div class="card-info">
            <span class="card-title">
              <strong>#{{ j.id }}</strong>
              {{ j.resultFilename ? j.resultFilename : '반출자료 압축 작업' }}
            </span>
            <span class="card-status-text">
              {{ j.state === 'queued' ? '대기열 대기 중…' : (j.progressNote || '파일 압축 중…') }}
            </span>
          </div>

          <div class="card-progress-wrap">
            <div class="progress-bar-bg">
              <div
                class="progress-bar-fill"
                :style="{ width: `${j.state === 'queued' ? 5 : Math.max(j.progress, 5)}%` }"
              />
            </div>
            <span class="progress-percent">
              {{ j.state === 'queued' ? '대기중' : `${j.progress}%` }}
            </span>
          </div>

          <div class="card-actions">
            <button
              class="small danger"
              type="button"
              :disabled="canceling === j.id"
              @click="handleCancel(j)"
            >
              취소
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 필터 탭 -->
    <div class="filter-bar">
      <div class="tab-group">
        <button
          type="button"
          class="tab-btn"
          :class="{ active: filterState === 'ALL' }"
          @click="filterState = 'ALL'"
        >
          전체 ({{ allJobs.length }})
        </button>
        <button
          type="button"
          class="tab-btn"
          :class="{ active: filterState === 'ACTIVE' }"
          @click="filterState = 'ACTIVE'"
        >
          진행중 ({{ allJobs.filter((x) => x.state === 'queued' || x.state === 'running').length }})
        </button>
        <button
          type="button"
          class="tab-btn"
          :class="{ active: filterState === 'DONE' }"
          @click="filterState = 'DONE'"
        >
          완료 ({{ allJobs.filter((x) => x.state === 'done').length }})
        </button>
        <button
          type="button"
          class="tab-btn"
          :class="{ active: filterState === 'FAILED' }"
          @click="filterState = 'FAILED'"
        >
          실패·취소 ({{ allJobs.filter((x) => x.state === 'failed' || x.state === 'canceled').length }})
        </button>
      </div>

      <span class="total-hint">
        총 <strong>{{ filteredJobs.length }}</strong>건의 작업
      </span>
    </div>

    <!-- 다운로드 작업 목록 테이블 -->
    <div class="table-container">
      <table class="downloads-table">
        <thead>
          <tr>
            <th style="width: 80px; text-align: center;">작업 ID</th>
            <th>압축 파일명 / 내용</th>
            <th style="width: 220px; text-align: center;">진행 상태</th>
            <th style="width: 110px; text-align: right;">파일 크기</th>
            <th style="width: 170px; text-align: center;">요청 일시</th>
            <th style="width: 170px; text-align: center;">완료 일시</th>
            <th style="width: 130px; text-align: center;">다운로드</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="isLoading">
            <td colspan="7" class="loading-cell">
              <span class="spinner" /> 작업 내역을 불러오는 중…
            </td>
          </tr>
          <tr v-else-if="!filteredJobs.length">
            <td colspan="7" class="empty-cell">
              <div class="empty-box">
                <span class="empty-icon">📂</span>
                <p class="empty-title">다운로드 가능한 반출 압축 작업이 없습니다.</p>
                <p class="empty-sub">
                  [반출대기함]에서 자료를 고른 뒤 [반출하기] 단추를 누르면 zip 압축이 비동기로 진행되며 이곳에 표시됩니다.
                </p>
                <button
                  class="primary small"
                  type="button"
                  style="margin-top: 12px;"
                  @click="cartModalOpen = true"
                >
                  반출대기함 열기
                </button>
              </div>
            </td>
          </tr>
          <tr
            v-for="job in filteredJobs"
            :key="job.id"
            :class="{ 'row-active': job.state === 'running' || job.state === 'queued' }"
          >
            <!-- 작업 ID -->
            <td style="text-align: center;">
              <span class="job-id">#{{ job.id }}</span>
            </td>

            <!-- 파일명 및 정보 -->
            <td>
              <div class="file-name-cell">
                <span class="file-icon">📦</span>
                <span class="file-name" :title="job.resultFilename || '반출 자료'">
                  {{ job.resultFilename || `작업 #${job.id} 반출자료` }}
                </span>
              </div>
              <div v-if="job.error" class="error-msg" :title="job.error">
                오류: {{ job.error }}
              </div>
            </td>

            <!-- 진행 상태 -->
            <td>
              <div class="status-cell">
                <!-- 완료 -->
                <template v-if="job.state === 'done'">
                  <span class="badge badge-ok">✅ 완료</span>
                  <span v-if="job.progressNote" class="status-note">{{ job.progressNote }}</span>
                </template>

                <!-- 압축 진행중 -->
                <template v-else-if="job.state === 'running'">
                  <div class="running-status">
                    <span class="badge badge-warning">⚙️ 압축중 ({{ job.progress }}%)</span>
                    <div class="mini-progress-bar">
                      <div class="mini-progress-fill" :style="{ width: `${job.progress}%` }" />
                    </div>
                    <span v-if="job.progressNote" class="status-note">{{ job.progressNote }}</span>
                  </div>
                </template>

                <!-- 대기중 -->
                <template v-else-if="job.state === 'queued'">
                  <span class="badge badge-warning">⏳ 대기중</span>
                  <span class="status-note">대기열에서 순서를 기다리는 중</span>
                </template>

                <!-- 실패 -->
                <template v-else-if="job.state === 'failed'">
                  <span class="badge badge-danger">❌ 실패</span>
                </template>

                <!-- 취소됨 -->
                <template v-else-if="job.state === 'canceled'">
                  <span class="badge badge-neutral">⏹️ 취소됨</span>
                </template>
              </div>
            </td>

            <!-- 파일 크기 -->
            <td style="text-align: right; font-variant-numeric: tabular-nums;">
              {{ formatBytes(job.resultByteSize) }}
            </td>

            <!-- 요청 일시 -->
            <td style="text-align: center; font-size: 0.85rem; color: var(--text-muted); font-variant-numeric: tabular-nums;">
              {{ formatDate(job.createdAt) }}
            </td>

            <!-- 완료 일시 -->
            <td style="text-align: center; font-size: 0.85rem; color: var(--text-muted); font-variant-numeric: tabular-nums;">
              {{ formatDate(job.finishedAt) }}
            </td>

            <!-- 다운로드 단추 / 액션 -->
            <td style="text-align: center;">
              <button
                v-if="job.state === 'done'"
                class="small primary download-btn"
                type="button"
                title="압축된 zip 파일을 내려받습니다"
                @click="handleDownload(job)"
              >
                ⬇️ 다운로드
              </button>

              <button
                v-else-if="job.state === 'queued' || job.state === 'running'"
                class="small danger"
                type="button"
                :disabled="canceling === job.id"
                title="작업 취소"
                @click="handleCancel(job)"
              >
                취소
              </button>

              <span v-else class="text-muted text-sm">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 반출대기함 모달 -->
    <CartModal
      :open="cartModalOpen"
      @close="cartModalOpen = false"
      @distribute="() => { cartModalOpen = false; void refetch() }"
    />
  </div>
</template>

<style scoped>
.downloads-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  max-width: 1400px;
  margin: 0 auto;
  width: 100%;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #e2e8f0);
}

.page-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text-color, #1e293b);
}

.page-desc {
  margin: 4px 0 0;
  font-size: 0.88rem;
  color: var(--text-muted, #64748b);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 0.85rem;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  100% {
    transform: rotate(360deg);
  }
}

/* ── 실시간 진행 중 배너 ── */
.active-banner {
  background: var(--bg-surface-elevated, #f8fafc);
  border: 1px solid var(--border-focus, #3b82f6);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.08);
}

.banner-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--primary, #2563eb);
  margin-bottom: 12px;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2563eb;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { transform: scale(0.9); opacity: 0.8; }
  50% { transform: scale(1.3); opacity: 1; }
  100% { transform: scale(0.9); opacity: 0.8; }
}

.active-job-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.active-job-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 12px 16px;
}

.card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
}

.card-title {
  font-weight: 600;
  font-size: 0.95rem;
}

.card-title strong {
  color: var(--primary, #2563eb);
  margin-right: 6px;
}

.card-status-text {
  font-size: 0.82rem;
  color: var(--text-muted, #64748b);
}

.card-progress-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 500px;
}

.progress-bar-bg {
  flex: 1;
  height: 10px;
  background: #e2e8f0;
  border-radius: 5px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #2563eb);
  transition: width 0.3s ease;
}

.progress-percent {
  font-size: 0.85rem;
  font-weight: 700;
  color: #1e293b;
  min-width: 45px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ── 필터 바 ── */
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.tab-group {
  display: inline-flex;
  background: var(--bg-surface-elevated, #f1f5f9);
  padding: 3px;
  border-radius: 6px;
  gap: 2px;
}

.tab-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 0.84rem;
  color: var(--text-muted, #475569);
  cursor: pointer;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}

.tab-btn:hover {
  color: #1e293b;
}

.tab-btn.active {
  background: #ffffff;
  color: var(--primary, #2563eb);
  font-weight: 700;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.total-hint {
  font-size: 0.85rem;
  color: var(--text-muted, #64748b);
}

/* ── 테이블 ── */
.table-container {
  background: #ffffff;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  overflow: auto;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.downloads-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  text-align: left;
}

.downloads-table th {
  background: #f8fafc;
  color: #475569;
  font-weight: 600;
  padding: 10px 14px;
  border-bottom: 1px solid #e2e8f0;
  white-space: nowrap;
}

.downloads-table td {
  padding: 12px 14px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
}

.downloads-table tr:hover {
  background: #f8fafc;
}

.row-active {
  background: #eff6ff !important;
}

.job-id {
  font-weight: 600;
  color: var(--text-muted, #64748b);
}

.file-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #1e293b;
}

.file-icon {
  font-size: 1.1rem;
}

.file-name {
  word-break: break-all;
}

.error-msg {
  margin-top: 4px;
  font-size: 0.78rem;
  color: #dc2626;
}

.status-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.status-note {
  font-size: 0.78rem;
  color: var(--text-muted, #64748b);
}

.running-status {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.mini-progress-bar {
  width: 100%;
  max-width: 140px;
  height: 6px;
  background: #e2e8f0;
  border-radius: 3px;
  overflow: hidden;
}

.mini-progress-fill {
  height: 100%;
  background: #3b82f6;
  transition: width 0.3s ease;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.76rem;
  font-weight: 600;
}

.badge-ok {
  background: #dcfce7;
  color: #15803d;
}

.badge-warning {
  background: #fef3c7;
  color: #b45309;
}

.badge-danger {
  background: #fee2e2;
  color: #b91c1c;
}

.badge-neutral {
  background: #f1f5f9;
  color: #64748b;
}

.download-btn {
  font-weight: 600;
  white-space: nowrap;
}

.loading-cell,
.empty-cell {
  text-align: center;
  padding: 48px 16px;
}

.empty-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.empty-icon {
  font-size: 2.2rem;
  opacity: 0.6;
}

.empty-title {
  font-size: 1rem;
  font-weight: 600;
  color: #334155;
  margin: 0;
}

.empty-sub {
  font-size: 0.84rem;
  color: #64748b;
  margin: 0;
  max-width: 500px;
}
</style>
