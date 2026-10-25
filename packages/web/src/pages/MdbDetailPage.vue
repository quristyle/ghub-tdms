<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { MdbDetail } from '@tdms/contracts'
import Tabs from '@/ui/Tabs.vue'
import PdfViewer from '@/ui/PdfViewer.vue'
import { api } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'

/** MDB 자료 상세 — 자료내용 / 미리보기 두 탭 (리비전·반출이 없다). */

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const tab = ref<'info' | 'preview'>('info')
const TABS = [{ key: 'info', label: '자료내용' }, { key: 'preview', label: '미리보기' }]

const { data: doc, isLoading } = useQuery({
  queryKey: computed(() => ['mdb', 'detail', id.value]),
  queryFn: () => api.get<MdbDetail>(`/mdb/${id.value}`),
  staleTime: staleTime.detail,
})

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`
}
</script>

<template>
  <main class="app-main detail">
    <div v-if="isLoading" class="panel pad muted">불러오는 중…</div>

    <template v-else-if="doc">
      <div class="panel head">
        <h1>MDB 자료 상세 보기</h1>
        <span style="flex:1" />
        <a class="btn btn-sm" :href="`/api/mdb/files/${doc.id}/download`">받기</a>
        <button class="btn btn-sm" @click="router.push('/mdb')">목록으로</button>
      </div>

      <div class="panel body">
        <Tabs v-model="tab" :tabs="TABS" />

        <section v-if="tab === 'info'" class="pad">
          <table class="kv">
            <tbody>
              <tr><th>자료명</th><td colspan="3">{{ doc.title }}</td></tr>
              <tr>
                <th>경로</th>
                <td colspan="3">{{ doc.folderPath.map(f => f.name).join(' › ') }}</td>
              </tr>
              <tr>
                <th>설비유형</th><td>{{ doc.equipmentType ?? '-' }}</td>
                <th>자료유형</th><td>{{ doc.docType ?? '-' }}</td>
              </tr>
              <tr>
                <th>공사</th><td>{{ doc.projectName ?? '-' }}</td>
                <th>연도</th><td>{{ doc.year ?? '-' }}</td>
              </tr>
              <tr>
                <th>공용/전용</th><td>{{ doc.isShared ? '공용' : '전용' }}</td>
                <th>확인필요</th><td>{{ doc.needsCheck ? '예' : '아니오' }}</td>
              </tr>
              <tr>
                <th>파일</th>
                <td>{{ doc.originalFilename }} ({{ size(doc.byteSize) }})</td>
                <th>등록</th>
                <td>{{ doc.createdAt.slice(0, 10) }} {{ doc.uploadedBy ?? '' }}</td>
              </tr>
              <tr>
                <th>Tag No</th>
                <td colspan="3">
                  <span v-for="t in doc.tags" :key="t" class="tag">{{ t }}</span>
                  <span v-if="!doc.tags.length" class="muted">-</span>
                </td>
              </tr>
              <tr><th>비고</th><td colspan="3">{{ doc.note ?? '-' }}</td></tr>
            </tbody>
          </table>
        </section>

        <section v-else class="preview">
          <PdfViewer v-if="doc.fileExt.toLowerCase() === 'pdf'" :file-id="doc.id" />
          <div v-else class="pad muted tc">
            이 형식은 미리보기를 지원하지 않습니다.
            <div style="margin-top:12px">
              <a class="btn btn-sm" :href="`/api/mdb/files/${doc.id}/download`">
                {{ doc.fileExt.toUpperCase() }} 받기
              </a>
            </div>
          </div>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.body > section { flex: 1; overflow: auto; min-height: 0; }
.pad { padding: 14px; }
.preview { display: flex; flex-direction: column; }
.kv { border: 1px solid var(--border); }
.kv th, .kv td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.kv th { background: var(--bg); width: 100px; font-weight: 600; white-space: nowrap; }
.tag {
  display: inline-block; font-size: 11px; padding: 1px 7px; margin-right: 4px;
  border: 1px solid var(--border-strong); border-radius: 9px;
}
</style>
