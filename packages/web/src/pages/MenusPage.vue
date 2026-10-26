<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MenuListResponse } from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import { api, ApiError } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { useSession } from '@/lib/session'

/**
 * 메뉴 관리 — 왼쪽 내비게이션에 뜨는 메뉴의 이름·표시 순서·사용여부를 정한다.
 *
 * 바꿀 수 있는 것은 그 셋뿐이다. 줄을 늘리거나 지우지 못한다 —
 * 경로는 SPA 라우터에 컴파일되어 있고(router.ts) 권한 키는 권한 트리의 리프와 짝이다.
 * 그래서 이 화면에는 [추가]·[삭제]가 없다. 까닭은 0015 마이그레이션 머리글에 적어 두었다.
 *
 * "어느 그룹에 이 메뉴를 보일지"는 여기가 아니라 [사용자 관리 > 권한 관리] 에서 정한다.
 * 여기서 켜 둔 메뉴라도 그룹에 권한이 없으면 그 사람에게는 보이지 않는다.
 */

const session = useSession()
const qc = useQueryClient()

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '저장하지 못했습니다.')

const { data, isLoading } = useQuery({
  queryKey: ['menus'],
  queryFn: () => api.get<MenuListResponse>('/menus'),
  staleTime: 30_000,
})

/** 편집용 사본. 저장을 누를 때까지 서버에 보내지 않는다. */
type Draft = { id: number; path: string; label: string; isEnabled: boolean }
const draft = ref<Draft[]>([])
const saving = ref(false)

// 서버에서 받아올 때마다 사본을 새로 만든다(저장 직후 응답도 여기로 들어온다).
watch(data, (d) => {
  if (d) draft.value = d.items.map((m, i) => ({
    id: i + 1, path: m.path, label: m.label, isEnabled: m.isEnabled,
  }))
}, { immediate: true })

const byPath = computed(() => new Map((data.value?.items ?? []).map((m) => [m.path, m])))
const meta = (path: string) => byPath.value.get(path)

const dirty = computed(() => {
  const saved = data.value?.items ?? []
  if (saved.length !== draft.value.length) return true
  return draft.value.some((d, i) => {
    const was = saved[i]
    return !was || d.path !== was.path || d.label !== was.label || d.isEnabled !== was.isEnabled
  })
})

const invalid = computed(() => draft.value.some((d) => d.label.trim() === ''))

function move(i: number, by: -1 | 1) {
  const j = i + by
  const next = draft.value.slice()
  const a = next[i]
  const b = next[j]
  if (!a || !b) return
  next[i] = b
  next[j] = a
  draft.value = next
}

function reset() {
  if (data.value) {
    draft.value = data.value.items.map((m, i) => ({
      id: i + 1, path: m.path, label: m.label, isEnabled: m.isEnabled,
    }))
  }
  message.value = null
}

const COLUMNS: Column<Draft>[] = [
  {
    key: 'order', label: '순서', width: '56px', align: 'center', filterable: false,
    render: (m) => String(draft.value.findIndex((item) => item.path === m.path) + 1),
  },
  { key: 'move', label: '올리기·내리기', width: '120px', align: 'center', filterable: false, render: () => '' },
  { key: 'label', label: '메뉴 이름', render: (m) => m.label },
  { key: 'path', label: '경로', width: '150px', render: (m) => m.path },
  { key: 'isEnabled', label: '사용', width: '80px', align: 'center', filterable: false,
    render: (m) => m.isEnabled ? '사용' : '미사용' },
  {
    key: 'updatedAt', label: '마지막 변경', width: '170px', filterable: false,
    render: (m) => {
      const updated = meta(m.path)
      return `${updated?.updatedAt?.slice(0, 10) ?? '-'}${updated?.updatedBy ? ` · ${updated.updatedBy}` : ''}`
    },
  },
]

async function save() {
  if (!dirty.value || invalid.value) return
  saving.value = true
  try {
    const items = draft.value.map((d) => ({ ...d, label: d.label.trim() }))
    const out = await api.put<MenuListResponse>('/menus', { items })
    qc.setQueryData(['menus'], out)
    // 사이드바는 /auth/me 가 내려준 메뉴로 그린다 — 다시 받아야 바뀐 것이 보인다.
    await qc.invalidateQueries({ queryKey: qk.me })
    await session.load()
    say('ok', '메뉴를 저장했습니다. 왼쪽 메뉴에 바로 반영됩니다.')
  } catch (e) {
    fail(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="app-main menus">
    <div class="panel head">
      <h1>메뉴 관리</h1>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel">
      <div class="panel-head">
        왼쪽 메뉴
        <span style="flex:1" />
        <button class="btn btn-sm" :disabled="!dirty || saving" @click="reset">되돌리기</button>
        <button
          class="btn btn-sm btn-primary" :disabled="!dirty || invalid || saving"
          @click="save"
        >{{ saving ? '저장 중…' : '저장' }}</button>
      </div>

      <div class="pad note muted">
        이름과 표시 순서, 사용여부를 정합니다. 메뉴를 새로 만들거나 지울 수는 없습니다 —
        각 줄은 화면 하나와 짝이기 때문입니다.
        <strong>어느 그룹에 보일지</strong>는
        <RouterLink to="/users">사용자 관리 &gt; 권한 관리</RouterLink> 에서 정합니다.
        여기서 켜 두어도 그룹에 권한이 없으면 그 사람에게는 보이지 않습니다.
      </div>

      <div v-if="isLoading" class="pad muted">불러오는 중…</div>

      <div v-else class="tablewrap">
        <DataTable
          :columns="COLUMNS" :rows="draft" :row-class="(m) => m.isEnabled ? '' : 'off'"
          :row-number="false" :filter-row="false" :excel="false" auto-height
          empty-text="메뉴가 없습니다."
        >
          <template #cell:order="{ index }">{{ index + 1 }}</template>

          <template #cell:move="{ index }">
            <button
              class="btn btn-sm" :disabled="index === 0"
              title="위로" @click.stop="move(index, -1)"
            >↑</button>
            <button
              class="btn btn-sm" :disabled="index === draft.length - 1"
              title="아래로" @click.stop="move(index, 1)"
            >↓</button>
          </template>

          <template #cell:label="{ row }">
            <input
              v-model="row.label" class="in" maxlength="40"
              :class="{ bad: row.label.trim() === '' }"
              :aria-label="`${row.path} 메뉴 이름`"
            />
          </template>

          <template #cell:path="{ row }">
            <span class="muted mono">{{ row.path }}</span>
          </template>

          <template #cell:isEnabled="{ row }">
            <input
              v-model="row.isEnabled" type="checkbox"
              :disabled="meta(row.path)?.isFixed"
              :title="meta(row.path)?.isFixed
                ? '이 메뉴는 끌 수 없습니다 — 끄면 되돌릴 화면이 없어집니다'
                : ''"
              :aria-label="`${row.label} 사용`"
            />
          </template>

          <template #cell:updatedAt="{ row }">
            <span class="muted sm">
              {{ meta(row.path)?.updatedAt?.slice(0, 10) ?? '-' }}
              <span v-if="meta(row.path)?.updatedBy"> · {{ meta(row.path)?.updatedBy }}</span>
            </span>
          </template>
        </DataTable>
      </div>

      <div v-if="invalid" class="pad msg err">메뉴 이름을 비울 수 없습니다.</div>
    </div>
  </main>
</template>

<style scoped>
.menus { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.note { line-height: 1.6; }
.note a { text-decoration: underline; }
.mono { font-family: var(--font-mono, monospace); }
.sm { font-size: var(--fs-xs); }
.in { width: 100%; }
.in.bad { border-color: var(--danger, #c33); }
/* 꺼 둔 메뉴는 흐리게 — 순서는 그대로 보여야 하므로 숨기지 않는다. */
:deep(.dt-row.off .dt-cell:not(:nth-child(2))) { opacity: .55; }
</style>
