<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MenuListResponse } from '@tdms/contracts'
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
type Draft = { path: string; label: string; isEnabled: boolean }
const draft = ref<Draft[]>([])
const saving = ref(false)

// 서버에서 받아올 때마다 사본을 새로 만든다(저장 직후 응답도 여기로 들어온다).
watch(data, (d) => {
  if (d) draft.value = d.items.map((m) => ({ path: m.path, label: m.label, isEnabled: m.isEnabled }))
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
    draft.value = data.value.items.map((m) => ({ path: m.path, label: m.label, isEnabled: m.isEnabled }))
  }
  message.value = null
}

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
        <table class="grid">
          <thead>
            <tr>
              <th style="width:56px" class="tc">순서</th>
              <th style="width:120px" class="tc">올리기·내리기</th>
              <th>메뉴 이름</th>
              <th style="width:150px">경로</th>
              <th style="width:80px" class="tc">사용</th>
              <th style="width:170px">마지막 변경</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(m, i) in draft" :key="m.path" :class="{ off: !m.isEnabled }">
              <td class="tc muted">{{ i + 1 }}</td>
              <td class="tc nowrap">
                <button class="btn btn-sm" :disabled="i === 0" title="위로" @click="move(i, -1)">↑</button>
                <button
                  class="btn btn-sm" :disabled="i === draft.length - 1" title="아래로"
                  @click="move(i, 1)"
                >↓</button>
              </td>
              <td>
                <input
                  v-model="m.label" class="in" maxlength="40"
                  :class="{ bad: m.label.trim() === '' }"
                  :aria-label="`${m.path} 메뉴 이름`"
                />
              </td>
              <td class="muted mono">{{ m.path }}</td>
              <td class="tc">
                <input
                  v-model="m.isEnabled" type="checkbox"
                  :disabled="meta(m.path)?.isFixed"
                  :title="meta(m.path)?.isFixed
                    ? '이 메뉴는 끌 수 없습니다 — 끄면 되돌릴 화면이 없어집니다'
                    : ''"
                  :aria-label="`${m.label} 사용`"
                />
              </td>
              <td class="muted sm">
                {{ meta(m.path)?.updatedAt?.slice(0, 10) ?? '-' }}
                <span v-if="meta(m.path)?.updatedBy"> · {{ meta(m.path)?.updatedBy }}</span>
              </td>
            </tr>
          </tbody>
        </table>
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
.nowrap { white-space: nowrap; }
.in { width: 100%; }
.in.bad { border-color: var(--danger, #c33); }
/* 꺼 둔 메뉴는 흐리게 — 순서는 그대로 보여야 하므로 숨기지 않는다. */
tr.off td:not(:nth-child(2)) { opacity: .55; }
</style>
