<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { CreateStampBody, StampCategory, StampItem, StampListResponse, UpdateStampBody } from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'

const session = useSession()
const qc = useQueryClient()

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => {
  message.value = { kind, text }
  setTimeout(() => {
    if (message.value?.text === text) message.value = null
  }, 4000)
}
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

const { data, isLoading } = useQuery({
  queryKey: ['stamps', 'all'],
  queryFn: () => api.get<StampListResponse>('/stamps?all=true'),
  staleTime: 30_000,
})

const stamps = computed<StampItem[]>(() => data.value?.items ?? [])

// ── 컬럼 정의 ──────────────────────────────────────────────────────────
const COLUMNS: Column<StampItem>[] = [
  {
    key: 'sortOrder',
    label: '순서',
    width: '64px',
    align: 'center',
    render: (r) => String(r.sortOrder),
    sortable: false,
  },
  {
    key: 'preview',
    label: '미리보기',
    width: '120px',
    align: 'center',
    filterable: false,
    render: () => '',
  },
  {
    key: 'name',
    label: '스탬프 이름',
    width: '180px',
    render: (r) => r.name,
  },
  {
    key: 'category',
    label: '구분',
    width: '90px',
    align: 'center',
    render: (r) => r.category,
  },
  {
    key: 'size',
    label: '크기 (W×H)',
    width: '110px',
    align: 'center',
    render: (r) => `${r.width} × ${r.height}`,
  },
  {
    key: 'description',
    label: '설명',
    render: (r) => r.description ?? '',
  },
  {
    key: 'isEnabled',
    label: '상태',
    width: '85px',
    align: 'center',
    render: (r) => (r.isEnabled ? '사용' : '미사용'),
  },
  {
    key: 'updatedAt',
    label: '최종수정',
    width: '140px',
    align: 'center',
    render: (r) => r.updatedAt.slice(0, 16).replace('T', ' '),
  },
  {
    key: 'act',
    label: '관리',
    width: '120px',
    align: 'center',
    filterable: false,
    render: () => '',
  },
]

// ── 등록 / 수정 모달 ─────────────────────────────────────────────────────
type CreationMode = 'generator' | 'upload'
type TemplateType = 'circle' | 'rect' | 'table' | 'banner'

interface StampForm {
  id: number
  name: string
  category: StampCategory
  description: string
  width: number
  height: number
  isEnabled: boolean
  sortOrder: number
  imageUrl: string
  creationMode: CreationMode
  // 생성기 옵션
  template: TemplateType
  mainText: string
  subText: string
  color: string
}

const editTarget = ref<StampForm | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const isSubmitting = ref(false)

const TEMPLATE_PRESETS = [
  { key: 'circle', label: '원형 도장' },
  { key: 'rect', label: '사각 도장' },
  { key: 'table', label: '확인 표' },
  { key: 'banner', label: '상태 띠도장' },
] as const

const COLOR_PRESETS = [
  { label: '빨강', value: '#d32f2f' },
  { label: '파랑', value: '#1976d2' },
  { label: '초록', value: '#2e7d32' },
  { label: '보라', value: '#7b3fa0' },
  { label: '검정', value: '#333333' },
]

function openCreate() {
  const nextOrder = (stamps.value.length ? Math.max(...stamps.value.map((s) => s.sortOrder)) : 0) + 1
  editTarget.value = {
    id: 0,
    name: '승인 도장',
    category: '도장',
    description: '',
    width: 320,
    height: 320,
    isEnabled: true,
    sortOrder: nextOrder,
    imageUrl: '',
    creationMode: 'generator',
    template: 'circle',
    mainText: '승  인',
    subText: 'APPROVED',
    color: '#d32f2f',
  }
  generateSvg()
}

function openEdit(s: StampItem) {
  editTarget.value = {
    id: s.id,
    name: s.name,
    category: (s.category as StampCategory) || '도장',
    description: s.description ?? '',
    width: s.width,
    height: s.height,
    isEnabled: s.isEnabled,
    sortOrder: s.sortOrder,
    imageUrl: s.imageUrl,
    creationMode: 'upload',
    template: 'rect',
    mainText: s.name,
    subText: '',
    color: '#d32f2f',
  }
}

function generateSvg() {
  if (!editTarget.value || editTarget.value.creationMode !== 'generator') return
  const f = editTarget.value
  const c = f.color || '#d32f2f'
  const main = f.mainText || '확인'
  const sub = f.subText || ''

  let svg = ''
  if (f.template === 'circle') {
    f.width = 320
    f.height = 320
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="320" height="320">
  <circle cx="160" cy="160" r="156" fill="#ffffff" fill-opacity="0.95" stroke="${c}" stroke-width="6"/>
  <circle cx="160" cy="160" r="144" fill="none" stroke="${c}" stroke-width="2"/>
  <line x1="25" y1="100" x2="295" y2="100" stroke="${c}" stroke-width="2"/>
  <line x1="25" y1="220" x2="295" y2="220" stroke="${c}" stroke-width="2"/>
  <text x="160" y="68" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="22" font-weight="bold" text-anchor="middle">GHUB TDMS</text>
  <text x="160" y="162" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="48" font-weight="bold" text-anchor="middle">${main}</text>
  ${sub ? `<text x="160" y="196" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="20" font-weight="bold" text-anchor="middle">${sub}</text>` : ''}
  <text x="160" y="268" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="22" font-weight="bold" text-anchor="middle">검토 확인</text>
</svg>`
  } else if (f.template === 'rect') {
    f.width = 360
    f.height = 160
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 160" width="360" height="160">
  <rect x="3" y="3" width="354" height="154" rx="8" fill="#ffffff" fill-opacity="0.95" stroke="${c}" stroke-width="5"/>
  <rect x="11" y="11" width="338" height="138" rx="4" fill="none" stroke="${c}" stroke-width="2"/>
  ${sub ? `<line x1="20" y1="100" x2="340" y2="100" stroke="${c}" stroke-width="2"/>
  <text x="180" y="65" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="40" font-weight="bold" text-anchor="middle">${main}</text>
  <text x="180" y="132" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="22" font-weight="bold" text-anchor="middle" letter-spacing="2">${sub}</text>`
  : `<text x="180" y="94" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="44" font-weight="bold" text-anchor="middle">${main}</text>`}
</svg>`
  } else if (f.template === 'banner') {
    f.width = 420
    f.height = 130
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 130" width="420" height="130">
  <rect x="4" y="4" width="412" height="122" rx="6" fill="#ffffff" fill-opacity="0.95" stroke="${c}" stroke-width="6" stroke-dasharray="12 6"/>
  <rect x="14" y="14" width="392" height="102" fill="none" stroke="${c}" stroke-width="2"/>
  <text x="210" y="60" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="38" font-weight="bold" text-anchor="middle" letter-spacing="3">${main}</text>
  ${sub ? `<text x="210" y="98" fill="${c}" font-family="'Malgun Gothic', '맑은 고딕', sans-serif" font-size="18" font-weight="bold" text-anchor="middle" letter-spacing="2">${sub}</text>` : ''}
</svg>`
  } else if (f.template === 'table') {
    f.width = 540
    f.height = 200
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 200" width="540" height="200">
  <rect width="540" height="200" fill="#ffffff" fill-opacity="0.95"/>
  <rect x="0" y="0" width="540" height="50" fill="${c}" fill-opacity="0.12"/>
  <rect x="1.5" y="1.5" width="537" height="197" fill="none" stroke="${c}" stroke-width="3"/>
  <line x1="0" y1="50" x2="540" y2="50" stroke="${c}" stroke-width="2"/>
  <line x1="0" y1="125" x2="540" y2="125" stroke="${c}" stroke-width="2"/>
  <line x1="140" y1="0" x2="140" y2="200" stroke="${c}" stroke-width="2"/>
  <line x1="380" y1="0" x2="380" y2="200" stroke="${c}" stroke-width="2"/>
  <text x="70" y="26" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="18" font-weight="bold" text-anchor="middle" dominant-baseline="central">구분</text>
  <text x="260" y="26" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="18" font-weight="bold" text-anchor="middle" dominant-baseline="central">${main}</text>
  <text x="460" y="26" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="18" font-weight="bold" text-anchor="middle" dominant-baseline="central">서명</text>
  <text x="70" y="88" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="central">현장점검</text>
  <text x="260" y="88" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="15" text-anchor="middle" dominant-baseline="central">도면 일치 여부 확인</text>
  <text x="70" y="163" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="central">안전조치</text>
  <text x="260" y="163" fill="${c}" font-family="'Malgun Gothic', sans-serif" font-size="15" text-anchor="middle" dominant-baseline="central">차단 및 안전 확인</text>
</svg>`
  }

  const encoded = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  f.imageUrl = encoded
}

function handleFileUpload(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file || !editTarget.value) return

  const reader = new FileReader()
  reader.onload = (re) => {
    const dataUrl = re.target?.result as string
    if (!editTarget.value || !dataUrl) return
    editTarget.value.imageUrl = dataUrl

    // 이미지 실제 너비/높이 계산
    const img = new Image()
    img.onload = () => {
      if (editTarget.value) {
        editTarget.value.width = img.naturalWidth || 300
        editTarget.value.height = img.naturalHeight || 150
      }
    }
    img.src = dataUrl
  }
  reader.readAsDataURL(file)
}

async function saveStamp() {
  if (!editTarget.value) return
  const f = editTarget.value
  if (!f.name.trim()) {
    say('err', '스탬프 이름을 입력해 주세요.')
    return
  }
  if (!f.imageUrl) {
    say('err', '스탬프 이미지가 등록되지 않았습니다.')
    return
  }

  isSubmitting.value = true
  try {
    if (f.id === 0) {
      const payload: CreateStampBody = {
        name: f.name.trim(),
        category: f.category,
        imageUrl: f.imageUrl,
        width: Number(f.width) || 300,
        height: Number(f.height) || 150,
        description: f.description.trim() || undefined,
        isEnabled: f.isEnabled,
        sortOrder: Number(f.sortOrder) || 0,
      }
      await api.post('/stamps', payload)
      say('ok', `스탬프 '${f.name}' 등록 완료`)
    } else {
      const payload: UpdateStampBody = {
        name: f.name.trim(),
        category: f.category,
        imageUrl: f.imageUrl,
        width: Number(f.width) || 300,
        height: Number(f.height) || 150,
        description: f.description.trim() || null,
        isEnabled: f.isEnabled,
        sortOrder: Number(f.sortOrder) || 0,
      }
      await api.put(`/stamps/${f.id}`, payload)
      say('ok', `스탬프 '${f.name}' 수정 완료`)
    }
    editTarget.value = null
    void qc.invalidateQueries({ queryKey: ['stamps'] })
  } catch (err) {
    fail(err)
  } finally {
    isSubmitting.value = false
  }
}

// ── 삭제 모달 ─────────────────────────────────────────────────────────
const deleteTarget = ref<StampItem | null>(null)
const isDeleting = ref(false)

async function confirmDelete() {
  const item = deleteTarget.value
  if (!item) return
  isDeleting.value = true
  try {
    await api.delete(`/stamps/${item.id}`)
    say('ok', `스탬프 '${item.name}' 삭제 완료`)
    deleteTarget.value = null
    void qc.invalidateQueries({ queryKey: ['stamps'] })
  } catch (err) {
    fail(err)
  } finally {
    isDeleting.value = false
  }
}

// ── 토글 사용여부 ───────────────────────────────────────────────────────
async function toggleEnabled(s: StampItem) {
  try {
    await api.put(`/stamps/${s.id}`, { isEnabled: !s.isEnabled })
    say('ok', `'${s.name}' ${!s.isEnabled ? '사용' : '미사용'} 설정됨`)
    void qc.invalidateQueries({ queryKey: ['stamps'] })
  } catch (err) {
    fail(err)
  }
}
</script>

<template>
  <main class="app-main stamps-page">
    <div class="panel head">
      <div class="title-row">
        <h1>스탬프 관리</h1>
        <span class="muted desc">
          도면 미리보기 툴바에서 날인할 수 있는 도장 및 표 스탬프를 관리합니다.
        </span>
      </div>
      <span style="flex:1" />
      <button class="btn btn-primary" @click="openCreate">
        + 새 스탬프 등록
      </button>
    </div>

    <!-- 알림 메시지 -->
    <div v-if="message" class="toast" :class="message.kind">
      {{ message.text }}
    </div>

    <div class="panel body">
      <div class="summary-bar">
        <span class="count-badge">전체 <strong>{{ stamps.length }}</strong>개</span>
        <span class="count-badge active">사용 중 <strong>{{ stamps.filter(s => s.isEnabled).length }}</strong>개</span>
        <span class="count-badge muted">미사용 <strong>{{ stamps.filter(s => !s.isEnabled).length }}</strong>개</span>
      </div>

      <DataTable
        :columns="COLUMNS"
        :rows="stamps"
        :total="stamps.length"
        storage-key="stamps-list"
        excel-name="스탬프_목록"
        empty-text="등록된 스탬프가 없습니다."
      >
        <template #cell:preview="{ row }">
          <div class="thumb-cell">
            <img :src="row.imageUrl" :alt="row.name" class="table-thumb" />
          </div>
        </template>

        <template #cell:category="{ row }">
          <span class="cat-tag" :class="row.category">{{ row.category }}</span>
        </template>

        <template #cell:isEnabled="{ row }">
          <button
            class="badge-toggle"
            :class="row.isEnabled ? 'badge-on' : 'badge-off'"
            :title="row.isEnabled ? '클릭 시 미사용 전환' : '클릭 시 사용 전환'"
            @click.stop="toggleEnabled(row)"
          >
            {{ row.isEnabled ? '사용' : '미사용' }}
          </button>
        </template>

        <template #cell:act="{ row }">
          <div class="actions-cell">
            <button class="btn btn-sm" @click.stop="openEdit(row)">수정</button>
            <button class="btn btn-sm btn-danger" @click.stop="deleteTarget = row">삭제</button>
          </div>
        </template>
      </DataTable>
    </div>

    <!-- 등록 / 수정 모달 -->
    <Modal
      v-if="editTarget"
      :title="editTarget.id === 0 ? '새 스탬프 등록' : '스탬프 수정'"
      @close="editTarget = null"
    >
      <form class="stamp-form" @submit.prevent="saveStamp">
        <div class="form-grid">
          <!-- 좌측 입력 필드 -->
          <div class="fields-col">
            <label class="form-row">
              <span class="label-text">스탬프 이름 *</span>
              <input v-model="editTarget.name" type="text" class="input" placeholder="스탬프 이름을 입력하세요" required />
            </label>

            <div class="form-row-group">
              <label class="form-row">
                <span class="label-text">구분</span>
                <select v-model="editTarget.category" class="select">
                  <option value="도장">도장</option>
                  <option value="표">표</option>
                  <option value="서명">서명</option>
                  <option value="기타">기타</option>
                </select>
              </label>

              <label class="form-row">
                <span class="label-text">순서</span>
                <input v-model.number="editTarget.sortOrder" type="number" class="input" min="0" />
              </label>
            </div>

            <label class="form-row">
              <span class="label-text">설명</span>
              <input v-model="editTarget.description" type="text" class="input" placeholder="용도 및 메모" />
            </label>

            <!-- 제작 방식 탭 -->
            <div class="mode-tabs">
              <button
                type="button"
                class="mode-tab"
                :class="{ active: editTarget.creationMode === 'generator' }"
                @click="editTarget.creationMode = 'generator'; generateSvg()"
              >
                도장·표 생성기
              </button>
              <button
                type="button"
                class="mode-tab"
                :class="{ active: editTarget.creationMode === 'upload' }"
                @click="editTarget.creationMode = 'upload'"
              >
                이미지 파일 직접 업로드
              </button>
            </div>

            <!-- 생성기 모드 옵션 -->
            <div v-if="editTarget.creationMode === 'generator'" class="generator-box">
              <label class="form-row">
                <span class="label-text">모양 템플릿</span>
                <select v-model="editTarget.template" class="select" @change="generateSvg">
                  <option v-for="t in TEMPLATE_PRESETS" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
              </label>

              <div class="form-row-group">
                <label class="form-row">
                  <span class="label-text">메인 문구</span>
                  <input v-model="editTarget.mainText" type="text" class="input" placeholder="예: 승인, 검토완료" @input="generateSvg" />
                </label>
                <label class="form-row">
                  <span class="label-text">보조/영문 문구</span>
                  <input v-model="editTarget.subText" type="text" class="input" placeholder="예: APPROVED" @input="generateSvg" />
                </label>
              </div>

              <div class="form-row">
                <span class="label-text">스탬프 색상</span>
                <div class="color-options">
                  <button
                    v-for="c in COLOR_PRESETS"
                    :key="c.value"
                    type="button"
                    class="color-btn"
                    :style="{ background: c.value }"
                    :class="{ selected: editTarget.color === c.value }"
                    :title="c.label"
                    @click="editTarget.color = c.value; generateSvg()"
                  />
                </div>
              </div>
            </div>

            <!-- 업로드 모드 옵션 -->
            <div v-else class="upload-box">
              <input
                ref="fileInput"
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                style="display: none"
                @change="handleFileUpload"
              />
              <button type="button" class="btn btn-sm" @click="fileInput?.click()">
                이미지 파일 선택 (PNG, SVG, JPG)
              </button>
              <span class="muted fs-xs">투명 배경의 PNG 또는 SVG 권장</span>
            </div>

            <div class="form-row-group">
              <label class="form-row">
                <span class="label-text">기준 가로폭 (px)</span>
                <input v-model.number="editTarget.width" type="number" class="input" min="50" max="2400" />
              </label>
              <label class="form-row">
                <span class="label-text">기준 세로폭 (px)</span>
                <input v-model.number="editTarget.height" type="number" class="input" min="50" max="2400" />
              </label>
            </div>

            <label class="checkbox-row">
              <input v-model="editTarget.isEnabled" type="checkbox" />
              <span>미리보기 화면에서 사용 활성화</span>
            </label>
          </div>

          <!-- 우측 미리보기 -->
          <div class="preview-col">
            <span class="preview-title">스탬프 미리보기</span>
            <div class="preview-canvas-box">
              <img
                v-if="editTarget.imageUrl"
                :src="editTarget.imageUrl"
                alt="미리보기"
                class="stamp-preview-img"
              />
              <span v-else class="muted">이미지를 등록하세요</span>
            </div>
            <div v-if="editTarget.imageUrl" class="preview-info">
              가로세로 비율: {{ (editTarget.width / (editTarget.height || 1)).toFixed(2) }}:1
            </div>
          </div>
        </div>
      </form>

      <template #footer>
        <button type="button" class="btn" @click="editTarget = null">취소</button>
        <button type="button" class="btn btn-primary" :disabled="isSubmitting" @click="saveStamp">
          {{ isSubmitting ? '저장 중…' : '저장' }}
        </button>
      </template>
    </Modal>

    <!-- 삭제 확인 모달 -->
    <Modal v-if="deleteTarget" title="스탬프 삭제" @close="deleteTarget = null">
      <p>스탬프 <strong>'{{ deleteTarget.name }}'</strong> 을(를) 삭제하시겠습니까?</p>
      <p class="muted fs-sm">이미 도면에 날인된 주석에는 영향을 주지 않으며, 새로 선택할 수 없게 됩니다.</p>
      <template #footer>
        <button class="btn" @click="deleteTarget = null">취소</button>
        <button class="btn btn-danger" :disabled="isDeleting" @click="confirmDelete">
          {{ isDeleting ? '삭제 중…' : '삭제' }}
        </button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
.stamps-page { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.head .desc { font-size: var(--fs-sm); margin-left: 8px; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; padding: 14px; }

.summary-bar { display: flex; gap: 10px; margin-bottom: 12px; }
.count-badge {
  font-size: var(--fs-xs);
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border);
}
.count-badge.active { background: #e8f5e9; border-color: #c8e6c9; color: #2e7d32; }
.count-badge.muted { color: var(--text-muted); }

.thumb-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
}
.table-thumb {
  max-width: 100px;
  max-height: 48px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: #fff;
}

.cat-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
}
.cat-tag.도장 { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
.cat-tag.표 { background: #f3e8ff; color: #6b21a8; border-color: #d8b4fe; }
.cat-tag.서명 { background: #e0f2fe; color: #075985; border-color: #7dd3fc; }
.cat-tag.기타 { background: #f1f5f9; color: #475569; }

.badge-toggle {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
}
.badge-on { background: #dcfce7; color: #166534; border-color: #86efac; }
.badge-off { background: #f1f5f9; color: #64748b; border-color: #cbd5e1; }

.actions-cell { display: flex; gap: 4px; justify-content: center; }

/* 모달 폼 스타일 */
.stamp-form { display: flex; flex-direction: column; gap: 12px; }
.form-grid { display: grid; grid-template-columns: 1fr 240px; gap: 16px; }
.fields-col { display: flex; flex-direction: column; gap: 10px; }
.form-row { display: flex; flex-direction: column; gap: 4px; }
.form-row-group { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.label-text { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
.input, .select {
  padding: 6px 8px;
  font-size: var(--fs-sm);
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: inherit;
}
.checkbox-row { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); cursor: pointer; }

.mode-tabs { display: flex; border-bottom: 1px solid var(--border); gap: 8px; margin-top: 4px; }
.mode-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 10px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
}
.mode-tab.active { border-color: var(--primary); color: var(--primary); }

.generator-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--bg-card);
  border-radius: 4px;
  border: 1px solid var(--border);
}
.upload-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px;
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: 4px;
}

.color-options { display: flex; gap: 8px; }
.color-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}
.color-btn.selected { border-color: #000; box-shadow: 0 0 0 1px #fff inset; }

.preview-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.preview-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
.preview-canvas-box {
  width: 100%;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #f8fafc;
  padding: 8px;
  overflow: hidden;
}
.stamp-preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.preview-info { font-size: 11px; color: var(--text-muted); }

.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: var(--fs-sm);
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.toast.ok { background: #166534; color: #fff; }
.toast.err { background: #991b1b; color: #fff; }
.btn-danger { background: #ef4444; color: #fff; }
.btn-danger:hover { background: #dc2626; }
.fs-xs { font-size: 11px; }
.fs-sm { font-size: 12px; }
</style>
