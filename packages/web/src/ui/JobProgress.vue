<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import type { JobDetail } from '@tdms/contracts'

/**
 * 장시간 작업 진행률.
 *
 * 엑셀 내보내기·Zip 반출·백업·변환이 전부 이 하나를 쓴다.
 * 기존 시스템은 백업 화면에만 진행률이 있었고 나머지는 화면이 멈췄다.
 */
const props = defineProps<{ jobId: number | null }>()
const emit = defineEmits<{ done: [job: JobDetail]; failed: [job: JobDetail] }>()

const job = ref<JobDetail | null>(null)
let source: EventSource | null = null

function close() {
  source?.close()
  source = null
}

watch(
  () => props.jobId,
  (id) => {
    close()
    job.value = null
    if (id === null) return

    source = new EventSource(`/api/jobs/${id}/stream`)
    source.onmessage = (ev: MessageEvent<string>) => {
      const j = JSON.parse(ev.data) as JobDetail
      job.value = j
      if (j.state === 'done') {
        close()
        emit('done', j)
      } else if (j.state === 'failed' || j.state === 'canceled') {
        close()
        emit('failed', j)
      }
    }
    source.onerror = () => close()
  },
  { immediate: true },
)

onUnmounted(close)

const LABEL: Record<string, string> = {
  queued: '차례를 기다리는 중', running: '만드는 중',
  done: '완료', failed: '실패', canceled: '취소됨',
}
</script>

<template>
  <div v-if="job" class="job" :class="job.state">
    <div class="job-head">
      <span>{{ LABEL[job.state] ?? job.state }}</span>
      <span class="muted">{{ job.progressNote }}</span>
      <span style="flex:1" />
      <span v-if="job.state === 'running'">{{ job.progress }}%</span>
      <a
        v-if="job.state === 'done'" class="btn btn-sm btn-primary"
        :href="`/api/jobs/${job.id}/download`"
      >받기</a>
    </div>
    <div class="bar"><div class="fill" :style="{ width: `${job.progress}%` }" /></div>
    <p v-if="job.error" class="err">{{ job.error }}</p>
  </div>
</template>

<style scoped>
.job { padding: 10px var(--sp-3); border-top: 1px solid var(--border); }
.job-head { display: flex; gap: 10px; align-items: center; font-size: var(--fs-sm); }
.bar {
  height: 5px; background: var(--surface-3);
  border-radius: var(--r-pill); margin-top: 7px; overflow: hidden;
}
.fill {
  height: 100%; background: var(--primary);
  border-radius: var(--r-pill); transition: width .3s ease;
}
.job.done .fill { background: var(--ok); }
.job.failed .fill { background: var(--danger); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 7px 0 0; }
</style>
