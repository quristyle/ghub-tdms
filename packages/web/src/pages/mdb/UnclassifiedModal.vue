<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MdbMeta, MdbUnclassifiedResponse } from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import MdbInfoModal from './MdbInfoModal.vue'
import { api, qs } from '@/lib/api'
import { staleTime } from '@/lib/queryKeys'

/**
 * Tag No·유형 미분류 정리 (기존 mdb-editor.js openUnclassifiedManager).
 *
 * 분류는 Tag No · 설비유형으로 정해진다 — 전용(Tag No 있음) / 공용(설비유형만) / 확인필요(둘 다 없음).
 * 폴더와 무관하게 연다. 자료명을 누르면 정보 변경 팝업이 떠서 그 자리에서 고치고,
 * 저장하면 목록을 다시 받아 더 이상 미분류가 아닌 자료는 빠진다.
 */
const emit = defineEmits<{ close: []; changed: [] }>()
const qc = useQueryClient()

const category = ref<'UNCHECKED' | 'SHARED' | 'DEDICATED' | 'ALL'>('UNCHECKED')
const projectId = ref<number | ''>('')
const keyword = ref('')
const applied = ref('')

const params = computed(() => ({
  category: category.value,
  projectId: projectId.value === '' ? undefined : projectId.value,
  q: applied.value || undefined,
}))

const { data, isFetching } = useQuery({
  queryKey: computed(() => ['mdb-unclassified', params.value]),
  queryFn: () => api.get<MdbUnclassifiedResponse>(`/mdb-editor/unclassified${qs(params.value)}`),
  placeholderData: (p) => p,
})
const { data: meta } = useQuery({
  queryKey: ['mdb-meta'],
  queryFn: () => api.get<MdbMeta>('/mdb/meta'),
  staleTime: staleTime.types,
})

const CAT: Record<string, string> = { UNCHECKED: '확인필요', SHARED: '공용', DEDICATED: '전용' }

function reset() { category.value = 'UNCHECKED'; projectId.value = ''; keyword.value = ''; applied.value = '' }

const editing = ref<number | null>(null)
function onSaved() {
  editing.value = null
  void qc.invalidateQueries({ queryKey: ['mdb-unclassified'] })
  void qc.invalidateQueries({ queryKey: ['mdb-detail'] })
  emit('changed')
}
</script>

<template>
  <Modal wide title="Tag No·유형 미분류 정리" @close="emit('close')">
    <div class="bar">
      <label>분류
        <select v-model="category">
          <option value="UNCHECKED">확인필요</option>
          <option value="SHARED">공용</option>
          <option value="DEDICATED">전용</option>
          <option value="ALL">전체</option>
        </select>
      </label>
      <label>공사
        <select v-model="projectId">
          <option value="">전체</option>
          <option v-for="p in meta?.projects ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <span style="flex:1" />
      <input v-model="keyword" type="text" placeholder="자료명 / 폴더" style="width:200px"
             @keydown.enter="applied = keyword.trim()" />
      <button class="btn btn-sm btn-primary" @click="applied = keyword.trim()">검색</button>
      <button class="btn btn-sm" @click="reset">조건 초기화</button>
    </div>
    <p class="muted count">
      <template v-if="data && data.total > data.items.length">
        전체 {{ data.total }}건 중 {{ data.items.length }}건 표시 (검색으로 좁혀보세요)
      </template>
      <template v-else>전체 {{ data?.total ?? 0 }}건</template>
      <span v-if="isFetching"> · 불러오는 중…</span>
      — 자료명을 누르면 Tag No·설비유형·자료유형을 고칠 수 있습니다.
    </p>
    <div class="scroll">
      <table class="grid">
        <thead>
          <tr><th style="width:44px">No</th><th>자료명</th><th style="width:60px">연도</th>
              <th style="width:130px">공사</th><th style="width:170px">폴더</th>
              <th style="width:110px">형식</th><th style="width:110px">설비유형</th><th style="width:70px">분류</th></tr>
        </thead>
        <tbody>
          <tr v-for="(it, i) in data?.items ?? []" :key="it.id">
            <td class="tc">{{ i + 1 }}</td>
            <td><a href="#" @click.prevent="editing = it.id">{{ it.title }}</a></td>
            <td class="tc muted">{{ it.year ?? '-' }}</td>
            <td class="muted">{{ it.projectName ?? '-' }}</td>
            <td class="muted">{{ it.folderName }}</td>
            <td class="tc">{{ it.exts.map((e) => e.toUpperCase()).join(', ') }}</td>
            <td>{{ it.equipmentType ?? '-' }}</td>
            <td class="tc">{{ CAT[it.category] }}</td>
          </tr>
          <tr v-if="!data?.items.length"><td colspan="8" class="tc muted">조건에 맞는 자료가 없습니다.</td></tr>
        </tbody>
      </table>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">닫기</button>
    </template>
  </Modal>

  <MdbInfoModal v-if="editing !== null" :file-id="editing" @close="editing = null" @saved="onSaved" />
</template>

<style scoped>
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.bar label { font-size: var(--fs-sm); display: inline-flex; gap: 4px; align-items: center; }
.count { font-size: var(--fs-sm); margin: 0 0 6px; }
.scroll { max-height: 55vh; overflow: auto; }
</style>
