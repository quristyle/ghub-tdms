<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { CatalogItem } from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import FloatField from '@/ui/FloatField.vue'
import { useCatalog } from '@/lib/catalog'

/**
 * 공사 관리 · 업체 관리 화면.
 *
 * 둘은 다루는 것만 다르고 하는 일이 같아서(추가·이름 변경·숨김) 한 화면으로 둔다 —
 * 어느 쪽인지는 라우트의 meta.catalogKind 가 정한다.
 *
 * 구성은 다른 화면과 같다: 제목 → 조회부(필터 바) → 상태줄 → 그리드.
 * 그리드는 공통 그리드라 칸 너비 조절·칸별 거르기·정렬·건수·엑셀·쪽 넘기기를 그냥 가진다.
 *
 * 추가·이름 변경·숨김 규칙은 반출하기 창의 [관리] 팝업과 같은 것(lib/catalog)을 쓴다.
 */
const route = useRoute()

const kind = computed<'projects' | 'vendors'>(() =>
  (route.meta.catalogKind === 'vendors' ? 'vendors' : 'projects'))

const { label, all, hiddenCount, isFetching, error, add, rename, setHidden } = useCatalog(kind)

const subtitle = computed(() =>
  (kind.value === 'projects'
    ? '반출·반입·자료 등록에 쓰는 공사 목록 관리'
    : '반출·반입에 쓰는 업체 목록 관리'))

// ── 조회 조건 ──────────────────────────────────────────────────────────
const statusFilter = ref<'all' | 'using' | 'hidden'>('all')
const keyword = ref('')

function resetFilter() {
  statusFilter.value = 'all'
  keyword.value = ''
}

// 공사↔업체를 오가면 조건과 편집 중이던 줄을 비운다
watch(kind, () => { resetFilter(); editingId.value = null; newName.value = '' })

const rows = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return all.value.filter((r) => {
    if (statusFilter.value === 'using' && r.isHidden) return false
    if (statusFilter.value === 'hidden' && !r.isHidden) return false
    return !k || r.name.toLowerCase().includes(k)
  })
})

// ── 추가 · 이름 변경 · 숨김 ────────────────────────────────────────────
const newName = ref('')
const editingId = ref<number | null>(null)
const editName = ref('')

async function onAdd() {
  const name = newName.value.trim()
  if (!name) return
  if (await add(name)) newName.value = ''
}

function startEdit(r: CatalogItem) { editingId.value = r.id; editName.value = r.name }

async function saveEdit() {
  const id = editingId.value
  const name = editName.value.trim()
  if (id === null || !name) return
  if (await rename(id, name)) editingId.value = null
}

/* 이름은 거르기·엑셀이 쓰는 글자값 그대로 두고, 그리는 법만 슬롯에서 바꾼다 */
const columns = computed<Column<CatalogItem>[]>(() => [
  { key: 'name', label: `${label.value}명`, width: '320px' },
  { key: 'isHidden', label: '상태', width: '90px', align: 'center',
    render: (r) => (r.isHidden ? '숨김' : '사용') },
  { key: 'createdAt', label: '등록일', width: '120px', align: 'center',
    render: (r) => r.createdAt.slice(0, 10) },
  { key: 'act', label: '조치', width: '240px', align: 'center',
    sortable: false, filterable: false, exportable: false, render: () => '' },
])
</script>

<template>
  <main class="app-main">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          {{ label }} 관리<span class="page-title-sub">{{ subtitle }}</span>
        </h1>
      </div>
    </div>

    <!-- 조회 -->
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <FloatField label="상태">
            <select id="cat-status" v-model="statusFilter">
              <option value="all">전체</option>
              <option value="using">사용</option>
              <option value="hidden">숨김 ({{ hiddenCount }})</option>
            </select>
          </FloatField>
          <FloatField class="filter-search" :label="`${label}명 검색`">
            <input v-model="keyword" type="text" />
          </FloatField>
        </div>
        <div class="filter-actions">
          <button type="button" @click="resetFilter">조건 초기화</button>
        </div>
      </div>
    </div>

    <p v-if="error" class="msg err">
      {{ error }}<span style="flex:1" />
      <button class="small" @click="error = ''">닫기</button>
    </p>

    <div class="status-bar">
      <span class="status-bar-left">
        <span class="total-count">전체 {{ rows.length.toLocaleString() }}건</span>
        <span class="muted">
          &nbsp;· {{ label }}는 지우지 않고 <b>숨김</b>만 합니다 — 고르는 목록에서만 빠지고 지난 기록은 그대로입니다.<template
            v-if="kind === 'vendors'"> 업체명을 바꾸면 지난 반출·반입 기록의 업체명도 함께 바뀝니다.</template>
        </span>
      </span>
      <span class="cart-status">
        <input
          v-model="newName" type="text" class="new-name" maxlength="200"
          :placeholder="`새 ${label}명`" @keydown.enter="onAdd"
        />
        <button class="cart-btn primary" type="button" :disabled="!newName.trim()" @click="onAdd">
          ＋ {{ label }} 추가
        </button>
      </span>
    </div>

    <div class="table-box">
      <DataTable
        :columns="columns" :rows="rows" :total="rows.length"
        :loading="isFetching && !all.length"
        :row-class="(r) => (r.isHidden ? 'off' : '')"
        :storage-key="`catalog-${kind}`" :excel-name="`${label} 목록`"
        :empty-text="`등록된 ${label}가 없습니다.`"
      >
        <template #cell:name="{ row }">
          <input
            v-if="editingId === row.id" v-model="editName" type="text" maxlength="200"
            style="width:100%" @click.stop
            @keydown.enter="saveEdit" @keydown.esc.stop="editingId = null"
          />
          <template v-else>{{ row.name }}</template>
        </template>

        <template #cell:isHidden="{ row }">
          <span class="badge" :class="row.isHidden ? 'badge-neutral' : 'badge-success'">
            {{ row.isHidden ? '숨김' : '사용' }}
          </span>
        </template>

        <template #cell:act="{ row }">
          <template v-if="editingId === row.id">
            <button class="small primary" :disabled="!editName.trim()" @click.stop="saveEdit">저장</button>
            <button class="small" @click.stop="editingId = null">취소</button>
          </template>
          <template v-else>
            <button class="small" @click.stop="startEdit(row)">이름 변경</button>
            <button v-if="!row.isHidden" class="small" @click.stop="setHidden(row.id, true)">숨김</button>
            <button v-else class="small" @click.stop="setHidden(row.id, false)">숨김 해제</button>
          </template>
        </template>
      </DataTable>
    </div>
  </main>
</template>

<style scoped>
.table-box {
  flex: 1 1 auto;
  min-height: 300px;
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table-box > * { flex: 1; min-width: 0; }

/* 상태줄 오른쪽의 '새 이름 + 추가' — 아래 그리드 오른쪽 끝과 맞춘다 */
.new-name { width: 220px; }
.status-bar-left .muted { font-weight: 400; }
</style>
