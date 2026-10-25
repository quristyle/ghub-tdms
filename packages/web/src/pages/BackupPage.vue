<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { BackupListResponse, BackupRunRow, BackupStatus } from '@tdms/contracts'
import JobProgress from '@/ui/JobProgress.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

/** 백업 관리 — 기존 backup.html 구성을 재현한다. */

const session = useSession()
const qc = useQueryClient()

const canRun = computed(() => session.can('screen.backup.run'))
const canDeleteFile = computed(() => session.can('screen.backup.delete_file'))

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

const { data: status } = useQuery({
  queryKey: ['backup-status'],
  queryFn: () => api.get<BackupStatus>('/backup/status'),
  staleTime: 30_000,
})

const { data: runs } = useQuery({
  queryKey: ['backup-runs'],
  queryFn: () => api.get<BackupListResponse>('/backup/runs'),
  staleTime: staleTime.worklist,
})

// ── 백업 만들기 ───────────────────────────────────────────────────────
const SCOPES = [
  { key: 'DB', label: 'DB (자료 정보)' },
  { key: 'FILES', label: '자료 파일' },
  { key: 'CODE', label: '서버 코드' },
  { key: 'WEB', label: '화면 코드' },
] as const

const form = ref({
  kind: 'FULL' as 'FULL' | 'INCREMENTAL',
  scope: new Set<string>(['DB', 'FILES']),
  storagePath: '',
  compressed: true,
})
const jobId = ref<number | null>(null)

function toggleScope(k: string) {
  form.value.scope.has(k) ? form.value.scope.delete(k) : form.value.scope.add(k)
  form.value.scope = new Set(form.value.scope)
}

async function run() {
  try {
    const r = await api.post<{ runId: number; jobId: number }>('/backup/run', {
      kind: form.value.kind,
      scope: [...form.value.scope],
      storagePath: form.value.storagePath || null,
      compressed: form.value.compressed,
    })
    jobId.value = r.jobId
    say('ok', `백업 ${r.runId}회차를 만드는 중입니다.`)
    void qc.invalidateQueries({ queryKey: ['backup-runs'] })
  } catch (e) { fail(e) }
}

// ── 이력 조치 ─────────────────────────────────────────────────────────
const deleteTarget = ref<BackupRunRow | null>(null)

async function confirmDelete() {
  const r = deleteTarget.value
  deleteTarget.value = null
  if (!r) return
  try {
    await api.post(`/backup/runs/${r.id}/delete-file`)
    say('ok', `${r.seq}회차의 백업 파일을 지웠습니다. 이력 줄은 남습니다.`)
    void qc.invalidateQueries({ queryKey: ['backup-runs'] })
  } catch (e) { fail(e) }
}

async function saveNote(r: BackupRunRow, note: string) {
  try {
    await api.post(`/backup/runs/${r.id}/note`, { note: note || null })
    say('ok', '비고를 저장했습니다.')
    void qc.invalidateQueries({ queryKey: ['backup-runs'] })
  } catch (e) { fail(e) }
}

function size(b: number | null): string {
  if (b === null) return '-'
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

const STATE_LABEL: Record<string, string> = {
  PREPARING: '준비 중', READY: '받을 수 있음', FAILED: '실패', FILE_DELETED: '파일 삭제됨',
}
</script>

<template>
  <main class="app-main backup">
    <div class="panel head">
      <h1>자료 백업 관리</h1>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <!-- 지금 상태 -->
    <div class="panel">
      <div class="panel-head">지금 상태</div>
      <div class="pad status">
        <div><span class="muted">담을 항목</span><strong>DB {{ status?.dbTables ?? 0 }}개 표</strong></div>
        <div><span class="muted">지금 자료 파일 수</span><strong>{{ (status?.fileCount ?? 0).toLocaleString() }}개</strong></div>
        <div><span class="muted">크기</span><strong>{{ size(status?.totalBytes ?? 0) }}</strong></div>
        <div><span class="muted">마지막 전체 백업</span><strong>{{ status?.lastFullAt?.slice(0, 10) ?? '없음' }}</strong></div>
        <div><span class="muted">마지막 변경분</span><strong>{{ status?.lastIncrementalAt?.slice(0, 10) ?? '없음' }}</strong></div>
        <div><span class="muted">마지막 만든 사람</span><strong>{{ status?.lastBy ?? '-' }}</strong></div>
      </div>
    </div>

    <!-- 백업 만들기 -->
    <div class="panel">
      <div class="panel-head">백업 만들기</div>
      <div class="pad">
        <div class="bar">
          <span class="group-label">범위</span>
          <label class="r"><input v-model="form.kind" type="radio" value="FULL" /> 전체 백업 만들기</label>
          <label class="r"><input v-model="form.kind" type="radio" value="INCREMENTAL" /> 변경분만 만들기</label>
        </div>
        <div class="bar">
          <span class="group-label">담을 항목</span>
          <label v-for="s in SCOPES" :key="s.key" class="r">
            <input type="checkbox" :checked="form.scope.has(s.key)" @change="toggleScope(s.key)" />
            {{ s.label }}
          </label>
        </div>
        <div class="bar">
          <span class="group-label">저장 위치</span>
          <input v-model="form.storagePath" type="text" placeholder="비우면 기본 위치 (예: /mnt/backup)" style="width:280px" />
          <label class="r"><input v-model="form.compressed" type="checkbox" /> 압축</label>
          <span style="flex:1" />
          <button class="btn btn-sm btn-primary" :disabled="!canRun || !form.scope.size" @click="run">
            백업 만들기
          </button>
        </div>
        <JobProgress v-if="jobId !== null" :job-id="jobId"
                     @done="() => qc.invalidateQueries({ queryKey: ['backup-runs'] })" />
        <p class="muted note">
          만드는 일은 뒤에서 돌아갑니다 — 화면이 멈추지 않습니다.
          되살리기는 묶음 안 안내 파일대로 사람이 수행합니다.
        </p>
      </div>
    </div>

    <!-- 백업 이력 -->
    <div class="panel table-panel">
      <div class="panel-head">
        백업 이력
        <span class="muted sub">이력 줄은 어떤 경우에도 지워지지 않습니다.</span>
      </div>
      <table class="grid">
        <thead>
          <tr><th>회차</th><th>종류</th><th>담은 항목</th><th>저장 위치</th><th>묶음 크기</th>
              <th>파일 수</th><th>만든 시각</th><th>만든 사람</th><th>받은 횟수</th>
              <th>상태</th><th>비고</th><th>조치</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in runs?.items ?? []" :key="r.id"
              :class="{ warn: r.state === 'FAILED' || r.state === 'FILE_DELETED' }">
            <td class="tc">{{ r.seq }}</td>
            <td class="tc">{{ r.kind === 'FULL' ? '전체' : '변경분' }}</td>
            <td class="tc">{{ r.scope.join(', ') }}</td>
            <td class="muted">{{ r.storagePath ?? '기본 위치' }}</td>
            <td class="tr">{{ size(r.byteSize) }}</td>
            <td class="tr">{{ r.fileCount ?? '-' }}</td>
            <td class="tc">{{ r.createdAt.slice(0, 16).replace('T', ' ') }}</td>
            <td class="tc">{{ r.createdBy ?? '-' }}</td>
            <td class="tc">{{ r.downloadCount }}</td>
            <td class="tc">{{ STATE_LABEL[r.state] ?? r.state }}</td>
            <td>
              <span v-if="!canRun">{{ r.note ?? '-' }}</span>
              <input v-else type="text" :value="r.note ?? ''" placeholder="비고" style="width:100%"
                     @change="saveNote(r, ($event.target as HTMLInputElement).value)" />
            </td>
            <td class="tc">
              <a v-if="r.state === 'READY' && r.jobId !== null && canRun"
                 class="btn btn-sm" :href="`/api/jobs/${r.jobId}/download`">받기</a>
              <button v-if="r.state === 'READY'" class="btn btn-sm" :disabled="!canDeleteFile"
                      :title="canDeleteFile ? '' : '권한이 없습니다'"
                      @click="deleteTarget = r">파일 삭제</button>
            </td>
          </tr>
          <tr v-if="!runs?.items.length"><td colspan="12" class="tc muted">백업 이력이 없습니다.</td></tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="deleteTarget" title="백업 파일 삭제" @close="deleteTarget = null">
      <p><strong>{{ deleteTarget.seq }}회차</strong> 의 백업 파일을 지웁니다.</p>
      <p class="muted">이력 줄은 남습니다 — 언제 무엇을 백업했는지는 지워지지 않습니다.</p>
      <template #footer>
        <button class="btn" @click="deleteTarget = null">취소</button>
        <button class="btn btn-primary" @click="confirmDelete">파일 삭제</button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
.backup { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.pad { padding: 12px; }
.status { display: flex; gap: 26px; flex-wrap: wrap; }
.status div { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); }
.bar { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.group-label {
  font-size: var(--fs-sm); color: var(--text-muted); min-width: 68px;
  border-right: 1px solid var(--border); padding-right: 8px;
}
.r { margin-right: 10px; display: inline-flex; align-items: center; gap: 4px; }
.note { font-size: var(--fs-sm); margin: 10px 0 0; }
.sub { font-size: var(--fs-sm); font-weight: 400; margin-left: 8px; }
.table-panel { flex: 1; overflow: auto; min-height: 0; }
.grid { border-top: 1px solid var(--border); }
</style>
