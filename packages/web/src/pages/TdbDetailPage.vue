<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type {
  DistributionListResponse, DocumentDetail, RevisionListResponse,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
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

// ── 표 칸 ──────────────────────────────────────────────────────────────
// render 는 **글자값**이다 — 거르기·엑셀이 이것을 쓴다. 슬롯은 그리는 법만 바꾼다.
// 여기 표들은 줄이 몇 개뿐이라 autoHeight 로 둔다(빈 상자가 되지 않게).

type FileRow = DocumentDetail['files'][number]
const FILE_COLUMNS: Column<FileRow>[] = [
  { key: 'fileExt', label: '구분', width: '72px', align: 'center',
    render: (f) => f.fileExt.toUpperCase() },
  { key: 'displayName', label: '자료명' },
  { key: 'rev', label: 'Rev', width: '86px', align: 'center',
    render: (f) => `Rev${f.rev}${f.branch ? `-${f.branch}` : ''}` },
  { key: 'byteSize', label: '크기', width: '90px', align: 'right', render: (f) => size(f.byteSize) },
  { key: 'reviewStatus', label: '검수상태', width: '90px', align: 'center',
    render: (f) => (f.reviewStatus === 'APPROVED' ? '승인' : f.reviewStatus) },
  { key: 'uploadedAt', label: '업로드일시', width: '110px', align: 'center',
    render: (f) => f.uploadedAt.slice(0, 10) },
  { key: 'act', label: '조치', width: '80px', align: 'center', sortable: false, filterable: false, render: () => '' },
]

/**
 * Revision 이력에는 id 가 없다 — 열쇠는 label(Rev03-A 같은 것)이다.
 * 그리드는 줄을 숫자 id 로 가리므로 목록 안 위치를 쓴다.
 * 목록이 통째로 다시 올 때만 바뀌어 줄이 섞일 일이 없다.
 */
type RevRow = RevisionListResponse['items'][number] & { id: number }
const revRows = computed<RevRow[]>(() =>
  (revisions.value?.items ?? []).map((r, i) => ({ ...r, id: i + 1 })),
)

const REV_COLUMNS: Column<RevRow>[] = [
  // 엑셀에도 "최신본"이 나가야 화면과 같은 뜻이 된다
  { key: 'label', label: 'Rev', width: '110px', align: 'center',
    render: (r) => (r.isCurrent ? `${r.label} 최신본` : r.label) },
  { key: 'createdAt', label: '등록일시', width: '130px', align: 'center',
    render: (r) => r.createdAt.slice(0, 16).replace('T', ' ') },
  { key: 'createdBy', label: '등록자', width: '100px', align: 'center', render: (r) => r.createdBy ?? '' },
  { key: 'reason', label: '사유', render: (r) => r.reason ?? '' },
  { key: 'files', label: '보유 파일', width: '130px',
    render: (r) => r.files.map((f) => f.fileExt.toUpperCase()).join(', ') },
  { key: 'note', label: '비고', width: '180px', render: (r) => r.note ?? '' },
]

type DistRow = DistributionListResponse['items'][number]
const DIST_COLUMNS: Column<DistRow>[] = [
  { key: 'revAtDistribution', label: '반출Rev', width: '86px', align: 'center',
    render: (x) => `Rev${x.revAtDistribution}` },
  { key: 'vendorName', label: '업체', width: '140px' },
  { key: 'projectName', label: '공사', width: '120px', render: (x) => x.projectName ?? '' },
  { key: 'purpose', label: '목적', width: '92px', align: 'center',
    render: (x) => PURPOSE_LABEL[x.purpose] ?? x.purpose },
  { key: 'distributedBy', label: '반출자', width: '100px', align: 'center', render: (x) => x.distributedBy ?? '' },
  { key: 'distributedAt', label: '반출일시', width: '104px', align: 'center',
    render: (x) => x.distributedAt.slice(0, 10) },
  { key: 'returnedAt', label: '반입일시', width: '104px', align: 'center',
    render: (x) => (x.returnedAt ? x.returnedAt.slice(0, 10) : '') },
  { key: 'state', label: '상태', width: '100px', align: 'center',
    render: (x) => DIST_STATE[x.state] ?? x.state },
  { key: 'note', label: '비고', width: '170px', render: (x) => x.note ?? '' },
]
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
          <DataTable
            :columns="FILE_COLUMNS" :rows="doc.files" :total="doc.files.length"
            auto-height :max-height="320"
            :row-class="(f) => (f.isCurrent ? 'cur' : '')"
            storage-key="detail-files" :excel-name="`${doc.drawingNo} 보유자료`"
            empty-text="보유 자료가 없습니다."
          >
            <template #cell:act="{ row }">
              <a class="btn btn-sm" :href="`/api/files/${row.id}/download`" @click.stop>받기</a>
            </template>
          </DataTable>
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
        <section v-else-if="tab === 'revisions'" class="pad grid-tab">
          <DataTable
            :columns="REV_COLUMNS" :rows="revRows" :total="revRows.length"
            :row-class="(r) => (r.isCurrent ? 'cur' : '')"
            storage-key="detail-revisions" :excel-name="`${doc.drawingNo} Revision 이력`"
            empty-text="Revision 이력이 없습니다."
          >
            <template #cell:label="{ row }">
              <span>{{ row.label }}</span>
              <span v-if="row.isCurrent" class="tag">최신본</span>
            </template>

            <template #cell:note="{ row }">
              <span v-if="!session.can('common.note_edit.revision')">{{ row.note ?? '-' }}</span>
              <input v-else type="text" :value="row.note ?? ''" placeholder="비고"
                     style="width:100%" @click.stop />
            </template>
          </DataTable>
        </section>

        <!-- 반출 이력 -->
        <section v-else class="pad grid-tab">
          <DataTable
            :columns="DIST_COLUMNS" :rows="distributions?.items ?? []"
            :total="distributions?.items.length ?? 0"
            :row-class="(x) => (x.state === 'OUTSTANDING' || x.state === 'ISSUE' ? 'warn' : '')"
            storage-key="detail-distributions" :excel-name="`${doc.drawingNo} 반출이력`"
            empty-text="반출 이력이 없습니다."
          >
            <template #cell:note="{ row }">
              <span v-if="!session.can('common.note_edit.distribution')">{{ row.note ?? '-' }}</span>
              <input v-else type="text" :value="row.note ?? ''" placeholder="비고"
                     style="width:100%" @click.stop />
            </template>
          </DataTable>
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

/* 그리드 하나만 있는 절은 스크롤을 그리드에 맡긴다 — 바깥이 한 번 더 스크롤되면
   머리글 고정이 깨진다. '자료내용' 절은 위에 kv 표가 있어 그대로 둔다
   (거기 그리드는 auto-height 라 줄 수만큼만 차지한다). */
.body > section.grid-tab {
  display: flex; flex-direction: column;
  min-height: 0; flex: 1; overflow: hidden;
}
.grid-tab > :deep(.dt) { flex: 1; min-height: 0; }
.preview { display: flex; flex-direction: column; }
h2 { font-size: var(--fs-base); margin: 20px 0 8px; }

.kv { border: 1px solid var(--border); }
.kv th, .kv td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.kv th { background: var(--bg); width: 110px; font-weight: 600; white-space: nowrap; }

.tag {
  font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 4px;
  background: var(--accent); color: var(--primary-fg);
}
</style>
