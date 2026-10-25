<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type {
  DistributionListResponse, DocumentDetail, RevisionListResponse,
} from '@tdms/contracts'
import Tabs from '@/ui/Tabs.vue'
import PdfViewer from '@/ui/PdfViewer.vue'
import { api } from '@/lib/api'
import { qk, staleTime } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'
import { DOC_STATUS_LABEL, PURPOSE_LABEL } from '@/lib/labels'

/** TDB 자료 상세 — 기존 detail.html 의 4개 탭을 재현한다. */

const route = useRoute()
const router = useRouter()
const session = useSession()

const id = computed(() => Number(route.params.id))
const tab = ref<'info' | 'preview' | 'revisions' | 'distributions'>('info')

const TABS = [
  { key: 'info', label: '자료내용' },
  { key: 'preview', label: '미리보기' },
  { key: 'revisions', label: 'Revision 이력' },
  { key: 'distributions', label: '반출 이력' },
]

const { data: doc, isLoading } = useQuery({
  queryKey: computed(() => qk.documents.detail(id.value)),
  queryFn: () => api.get<DocumentDetail>(`/documents/${id.value}`),
  staleTime: staleTime.detail,
})

// 탭별 지연 조회 — 탭을 열기 전에는 요청하지 않는다
const { data: revisions } = useQuery({
  queryKey: computed(() => [...qk.documents.detail(id.value), 'revisions']),
  queryFn: () => api.get<RevisionListResponse>(`/documents/${id.value}/revisions`),
  enabled: computed(() => tab.value === 'revisions'),
  staleTime: staleTime.detail,
})

const { data: distributions } = useQuery({
  queryKey: computed(() => [...qk.documents.detail(id.value), 'distributions']),
  queryFn: () => api.get<DistributionListResponse>(`/documents/${id.value}/distributions`),
  enabled: computed(() => tab.value === 'distributions'),
  staleTime: staleTime.detail,
})

const { data: neighbors } = useQuery({
  queryKey: computed(() => [...qk.documents.detail(id.value), 'neighbors']),
  queryFn: () => api.get<{ prevId: number | null; nextId: number | null }>(`/documents/${id.value}/neighbors`),
  staleTime: staleTime.detail,
})

// 미리보기 대상: 현재 Rev 의 PDF
const previewFile = computed(() =>
  doc.value?.files.find((f) => f.isCurrent && f.fileExt.toLowerCase() === 'pdf')
  ?? doc.value?.files.find((f) => f.fileExt.toLowerCase() === 'pdf'),
)

watch(id, () => (tab.value = 'info'))

const STATUS_LABEL = DOC_STATUS_LABEL
const DIST_STATE: Record<string, string> = {
  RETURNED: '반입완료', OUTSTANDING: '반입미완료',
  ISSUE: '확인필요', PENDING_REVIEW: '검수대기',
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
</script>

<template>
  <main class="app-main detail">
    <div v-if="isLoading" class="panel pad muted">불러오는 중…</div>

    <template v-else-if="doc">
      <div class="panel head">
        <h1>TDB 자료 상세 보기</h1>
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="!neighbors?.prevId"
                @click="router.push(`/documents/${neighbors!.prevId}`)">◀ 이전</button>
        <button class="btn btn-sm" :disabled="!neighbors?.nextId"
                @click="router.push(`/documents/${neighbors!.nextId}`)">다음 ▶</button>
        <button class="btn btn-sm" @click="router.push('/')">목록으로</button>
      </div>

      <div class="panel body">
        <Tabs v-model="tab" :tabs="TABS" />

        <!-- 자료내용 -->
        <section v-if="tab === 'info'" class="pad">
          <table class="kv">
            <tbody>
              <tr><th>자료명</th><td>{{ doc.drawingNo }}</td><th>현재 Rev</th><td>Rev{{ doc.currentRev }}</td></tr>
              <tr><th>내용</th><td colspan="3">{{ doc.title }}</td></tr>
              <tr>
                <th>경로</th>
                <td colspan="3">{{ doc.folderPath.map(f => f.name).join(' › ') }}</td>
              </tr>
              <tr><th>분류</th><td>{{ doc.docType ?? '-' }}</td><th>공종</th><td>{{ doc.discipline ?? '-' }}</td></tr>
              <tr><th>ISBL/OSBL</th><td>{{ doc.isblOsbl ?? '-' }}</td><th>구역</th><td>{{ doc.area ?? '-' }}</td></tr>
              <tr><th>설비 Tag</th><td>{{ doc.equipmentTag ?? '-' }}</td><th>공사</th><td>{{ doc.projectName ?? '-' }}</td></tr>
              <tr>
                <th>상태</th>
                <td>{{ STATUS_LABEL[doc.status] ?? doc.status }}</td>
                <th>대여</th>
                <td>{{ doc.lentTo ? `${doc.lentTo} (${doc.lentAt?.slice(0,10)})` : '-' }}</td>
              </tr>
              <tr><th>비고</th><td colspan="3">{{ doc.note ?? '-' }}</td></tr>
            </tbody>
          </table>

          <h2>보유 자료</h2>
          <table class="grid">
            <thead>
              <tr><th>구분</th><th>자료명</th><th>Rev</th><th>크기</th><th>검수상태</th><th>업로드일시</th><th>조치</th></tr>
            </thead>
            <tbody>
              <tr v-for="f in doc.files" :key="f.id" :class="{ cur: f.isCurrent }">
                <td class="tc">{{ f.fileExt.toUpperCase() }}</td>
                <td>{{ f.displayName }}</td>
                <td class="tc">Rev{{ f.rev }}{{ f.branch ? `-${f.branch}` : '' }}</td>
                <td class="tr">{{ size(f.byteSize) }}</td>
                <td class="tc">{{ f.reviewStatus === 'APPROVED' ? '승인' : f.reviewStatus }}</td>
                <td class="tc">{{ f.uploadedAt.slice(0, 10) }}</td>
                <td class="tc">
                  <a class="btn btn-sm" :href="`/api/files/${f.id}/download`">받기</a>
                </td>
              </tr>
              <tr v-if="!doc.files.length"><td colspan="7" class="tc muted">보유 자료가 없습니다.</td></tr>
            </tbody>
          </table>
        </section>

        <!-- 미리보기 -->
        <section v-else-if="tab === 'preview'" class="preview">
          <PdfViewer v-if="previewFile" :file-id="previewFile.id" :document-id="doc.id" />
          <div v-else class="pad muted tc">
            PDF 미보유 — 원본(DWG)만 있는 자료입니다.
            <div style="margin-top:12px">
              <a v-for="f in doc.files" :key="f.id" class="btn btn-sm"
                 :href="`/api/files/${f.id}/download`" style="margin:0 4px">
                {{ f.fileExt.toUpperCase() }} 받기
              </a>
            </div>
          </div>
        </section>

        <!-- Revision 이력 -->
        <section v-else-if="tab === 'revisions'" class="pad">
          <table class="grid">
            <thead>
              <tr><th>Rev</th><th>등록일시</th><th>등록자</th><th>사유</th><th>보유 파일</th><th>비고</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in revisions?.items ?? []" :key="r.label" :class="{ cur: r.isCurrent }">
                <td class="tc">
                  {{ r.label }}
                  <span v-if="r.isCurrent" class="tag">최신본</span>
                </td>
                <td class="tc">{{ r.createdAt.slice(0, 16).replace('T', ' ') }}</td>
                <td class="tc">{{ r.createdBy ?? '-' }}</td>
                <td>{{ r.reason ?? '-' }}</td>
                <td>{{ r.files.map(f => f.fileExt.toUpperCase()).join(', ') || '-' }}</td>
                <td>
                  <span v-if="!session.can('common.note_edit.revision')">{{ r.note ?? '-' }}</span>
                  <input v-else type="text" :value="r.note ?? ''" placeholder="비고" style="width:100%" />
                </td>
              </tr>
              <tr v-if="!revisions?.items.length">
                <td colspan="6" class="tc muted">Revision 이력이 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 반출 이력 -->
        <section v-else class="pad">
          <table class="grid">
            <thead>
              <tr>
                <th>반출Rev</th><th>업체</th><th>공사</th><th>목적</th>
                <th>반출자</th><th>반출일시</th><th>반입일시</th><th>상태</th><th>비고</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in distributions?.items ?? []" :key="x.id"
                  :class="{ warn: x.state === 'OUTSTANDING' || x.state === 'ISSUE' }">
                <td class="tc">Rev{{ x.revAtDistribution }}</td>
                <td>{{ x.vendorName }}</td>
                <td>{{ x.projectName ?? '-' }}</td>
                <td class="tc">{{ PURPOSE_LABEL[x.purpose] ?? x.purpose }}</td>
                <td class="tc">{{ x.distributedBy ?? '-' }}</td>
                <td class="tc">{{ x.distributedAt.slice(0, 10) }}</td>
                <td class="tc">{{ x.returnedAt?.slice(0, 10) ?? '-' }}</td>
                <td class="tc">{{ DIST_STATE[x.state] ?? x.state }}</td>
                <td>
                  <span v-if="!session.can('common.note_edit.distribution')">{{ x.note ?? '-' }}</span>
                  <input v-else type="text" :value="x.note ?? ''" placeholder="비고" style="width:100%" />
                </td>
              </tr>
              <tr v-if="!distributions?.items.length">
                <td colspan="9" class="tc muted">반출 이력이 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-h1); margin: 0; font-weight: 600; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.body > section { flex: 1; overflow: auto; min-height: 0; }
.pad { padding: 14px; }
.preview { display: flex; flex-direction: column; }
h2 { font-size: var(--fs-base); margin: 20px 0 8px; }

.kv { border: 1px solid var(--border); }
.kv th, .kv td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.kv th { background: var(--bg); width: 110px; font-weight: 600; white-space: nowrap; }

.grid { border: 1px solid var(--border); }
.grid th, .grid td { border: 1px solid var(--border); padding: 5px 8px; }
.grid th { background: var(--bg); font-weight: 600; white-space: nowrap; }
.grid tr.cur { background: var(--accent-soft); }
.grid tr.warn { background: var(--warn-bg); }
.tag {
  font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 4px;
  background: var(--accent); color: #fff;
}
</style>
