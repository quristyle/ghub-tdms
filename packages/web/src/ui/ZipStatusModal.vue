<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { DistributionRow, ZipStatusResult } from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import { api, ApiError, qs } from '@/lib/api'
import { DISTRIBUTION_STATE_LABEL, PURPOSE_LABEL } from '@/lib/labels'

/**
 * Zip 상세 현황 — 반출 Zip 하나에 담긴 자료와 반입 진행 상황.
 *
 * TDB 반출이력의 Zip별 보기와 시스템 로그의 '확인' 칸이 함께 쓴다 —
 * 기존 화면도 두 곳에서 같은 팝업을 열었다(ui.js wireZipButtons).
 */
const props = defineProps<{ zipName: string }>()
const emit = defineEmits<{ close: [] }>()

const { data, isFetching, error } = useQuery({
  queryKey: computed(() => ['dist-zip-status', props.zipName]),
  queryFn: () => api.get<ZipStatusResult>(`/distributions/zip-status${qs({ zipName: props.zipName })}`),
  retry: false,
})

/**
 * 기록만 남고 반출 건은 지워진 Zip 도 있다 — 그때는 빈 표 대신 왜 없는지 적는다.
 * (시스템 로그는 지워진 반출의 기록도 그대로 보여 주기 때문에 생기는 일이다)
 */
const notFound = computed(() => error.value instanceof ApiError && error.value.status === 404)

const day = (v: string) => v.slice(0, 10)
const stateClass = (s: string) => (s === 'INCOMPLETE' ? 'warn' : s === 'ISSUE' ? 'issue' : '')

const COLUMNS: Column<DistributionRow>[] = [
  { key: 'documentLabel', label: '자료명', width: '220px' },
  { key: 'title', label: '내용', render: (r) => r.title ?? '·' },
  { key: 'revAtDistribution', label: '반출Rev', width: '76px', align: 'center',
    render: (r) => `Rev${r.revAtDistribution}` },
  { key: 'purpose', label: '목적', width: '84px', align: 'center',
    render: (r) => PURPOSE_LABEL[r.purpose] ?? r.purpose },
  { key: 'returnedAt', label: '반입일시', width: '104px', align: 'center',
    render: (r) => (r.returnedAt ? day(r.returnedAt) : '·') },
  { key: 'state', label: '상태', width: '120px', align: 'center',
    render: (r) => [DISTRIBUTION_STATE_LABEL[r.state], r.manualReturn ? '수정없음' : '']
      .filter(Boolean).join(' ') },
]
</script>

<template>
  <Modal wide :title="`Zip 상세 현황 — ${zipName}`" @close="emit('close')">
    <div v-if="notFound" class="msg err">
      이 Zip 의 반출 기록이 남아 있지 않습니다. 기록이 지워졌거나 Zip 만들기가 끝나지 않은 묶음입니다.
    </div>

    <template v-else>
      <div class="status-bar" style="margin-bottom:9px">
        <span class="status-bar-left">
          <template v-if="data">
            <b>{{ data.vendorName }}</b>
            <span class="total-count">&nbsp;· {{ data.itemCount }}건 중 {{ data.returnedCount }}건 반입</span>
          </template>
          <span v-else-if="isFetching" class="muted">불러오는 중…</span>
        </span>
      </div>
      <div class="zip-grid">
      <DataTable
        :columns="COLUMNS" :rows="data?.items ?? []" :total="data?.items.length ?? 0"
        :loading="isFetching && !data"
        :row-class="(r) => stateClass(r.state)"
        storage-key="dist-zip-status" :excel-name="`Zip 상세 현황_${zipName}`"
          empty-text="이 Zip 에 담긴 자료가 없습니다."
        />
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.zip-grid { height: 55vh; min-height: 260px; display: flex; }
.zip-grid > * { flex: 1; min-width: 0; }
</style>
