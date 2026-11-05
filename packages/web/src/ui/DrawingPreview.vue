<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import PdfViewer from '@/ui/PdfViewer.vue'
import { api } from '@/lib/api'

/**
 * 원본(DWG·DXF) 미리보기 — 고객 시스템(D-102)처럼 서버가 도면을 PDF 로 바꿔 두면
 * 지금의 PDF 뷰어로 연다. 처음 여는 도면은 워커가 바꾸는 동안(보통 몇 초) 기다린다.
 * 같은 내용의 원본은 한 번만 바꾼다(서버 preview_renditions).
 */

const props = defineProps<{
  fileId: number
  documentId?: number
  /** 원본 받기 단추에 쓴다 */
  label?: string
}>()

interface Rendition {
  state: 'unsupported' | 'pending' | 'done' | 'failed'
  error: string | null
}

const { data, isError } = useQuery({
  queryKey: computed(() => ['files', props.fileId, 'rendition']),
  queryFn: () => api.get<Rendition>(`/files/${props.fileId}/rendition`),
  // 바꾸는 중이면 2초마다 다시 묻는다
  refetchInterval: (q) => (q.state.data?.state === 'pending' ? 2000 : false),
  staleTime: 0,
})

const state = computed(() => (isError.value ? 'failed' : data.value?.state))
</script>

<template>
  <PdfViewer v-if="state === 'done'" :file-id="fileId" :document-id="documentId"
             :file-url="`/api/files/${fileId}/preview`" />
  <div v-else class="pad muted tc">
    <template v-if="!state || state === 'pending'">
      도면을 미리보기용으로 바꾸는 중입니다… 처음 여는 도면은 몇 초 걸립니다.
    </template>
    <template v-else>
      도면 미리보기를 만들 수 없습니다 — {{ data?.error ?? '서버에 묻지 못했습니다.' }}
      <div style="margin-top:12px">
        <a class="btn btn-sm btn-primary" :href="`/api/files/${fileId}/download`">
          {{ label ?? '원본' }} 받기
        </a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pad { padding: 14px; }
</style>
