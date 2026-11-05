<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import PdfViewer from '@/ui/PdfViewer.vue'
import { api } from '@/lib/api'

/**
 * 원본(DWG·DXF) 미리보기 — 고객 시스템(D-102)처럼 서버가 도면을 PDF 로 바꿔 두면
 * 지금의 PDF 뷰어로 연다. 처음 여는 도면은 워커가 바꾸는 동안(보통 몇 초) 기다린다.
 * 같은 내용의 원본은 한 번만 바꾼다(서버 preview_renditions).
 *
 * TDB 는 /files/:id/…, MDB 는 /mdb/files/:id/… 를 쓴다(base 로 고른다).
 */

const props = withDefaults(defineProps<{
  fileId: number
  documentId?: number
  /** 원본 받기 단추에 쓴다 */
  label?: string
  /** 'mdb' 면 MDB 파일 번호로 묻는다 */
  base?: 'tdb' | 'mdb'
  /** 뷰어 도구모음의 원본/사본 전환 버튼 — 사본(PDF)이 있으면 true */
  altAvailable?: boolean
  /** 보관해 둔 마크업을 되살려 열 때 */
  favoriteId?: number | null
}>(), { base: 'tdb', altAvailable: false, favoriteId: undefined })

const emit = defineEmits<{ switchSource: [to: string] }>()

interface Rendition {
  state: 'unsupported' | 'pending' | 'done' | 'failed'
  error: string | null
}

const prefix = computed(() => (props.base === 'mdb' ? '/mdb/files' : '/files'))

const { data, isError } = useQuery({
  queryKey: computed(() => [props.base, 'files', props.fileId, 'rendition']),
  queryFn: () => api.get<Rendition>(`${prefix.value}/${props.fileId}/rendition`),
  // 바꾸는 중이면 2초마다 다시 묻는다
  refetchInterval: (q) => (q.state.data?.state === 'pending' ? 2000 : false),
  staleTime: 0,
})

const state = computed(() => (isError.value ? 'failed' : data.value?.state))
</script>

<template>
  <PdfViewer v-if="state === 'done'" :file-id="fileId" :document-id="documentId"
             :file-url="`/api${prefix}/${fileId}/preview`"
             :favorite-id="favoriteId"
             :view-mode="base === 'mdb' ? 'original' : undefined"
             :alt-available="altAvailable" :original-label="label"
             @switch-source="(to) => emit('switchSource', to)" />
  <div v-else class="pad muted tc">
    <template v-if="!state || state === 'pending'">
      도면을 미리보기용으로 바꾸는 중입니다… 처음 여는 도면은 몇 초 걸립니다.
    </template>
    <template v-else>
      도면 미리보기를 만들 수 없습니다 — {{ data?.error ?? '서버에 묻지 못했습니다.' }}
      <div style="margin-top:12px">
        <a class="btn btn-sm btn-primary" :href="`/api${prefix}/${fileId}/download`">
          {{ label ?? '원본' }} 받기
        </a>
        <button v-if="altAvailable" class="btn btn-sm" style="margin-left:6px"
                @click="emit('switchSource', 'pdf')">사본(PDF) 보기</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pad { padding: 14px; }
</style>
