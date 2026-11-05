<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { MdbPairCandidateResponse, MdbPairMergeResult } from '@tdms/contracts'
import Modal from '@/ui/Modal.vue'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * MDB 원본·사본(DWG·PDF) 폴더 병합 (기존 mdb-editor.js 99·156).
 *
 * 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 둘 다 있는 자리를 보여준다. 양쪽에 대소문자까지 같은
 * 이름으로 있는 자료를 상위 폴더의 자료 1건으로 합친다. 대소문자만 다른 것은 합치지 않고 알린다.
 */
const emit = defineEmits<{ close: []; merged: [] }>()
const session = useSession()
const canFolder = computed(() => session.can('screen.mdb_editor.tag'))

const { data, refetch, isFetching } = useQuery({
  queryKey: ['mdb-pair-folders'],
  queryFn: () => api.get<MdbPairCandidateResponse>('/mdb-editor/pair-folders/candidates'),
})

const picked = ref(new Set<number>())
function toggle(id: number) {
  picked.value.has(id) ? picked.value.delete(id) : picked.value.add(id)
  picked.value = new Set(picked.value)
}
const allOn = computed(() => !!data.value?.items.length && data.value.items.every((c) => picked.value.has(c.parentId)))
function toggleAll() {
  picked.value = allOn.value ? new Set() : new Set((data.value?.items ?? []).map((c) => c.parentId))
}

const result = ref<{ kind: 'ok' | 'err'; text: string; skipped: MdbPairMergeResult['skipped'] } | null>(null)
const busy = ref(false)

async function merge() {
  busy.value = true
  try {
    const r = await api.post<MdbPairMergeResult>('/mdb-editor/pair-folders/merge', { parentIds: [...picked.value] })
    result.value = {
      kind: r.skipped.length ? 'err' : 'ok',
      text: `${r.merged}건을 합쳤습니다.` + (r.skipped.length ? ` ${r.skipped.length}건은 합치지 못했습니다.` : ''),
      skipped: r.skipped,
    }
    picked.value = new Set()
    void refetch()
    emit('merged')
  } catch (e) {
    result.value = { kind: 'err', text: e instanceof ApiError ? e.message : '병합하지 못했습니다.', skipped: [] }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal wide title="원본·사본(DWG·PDF) 폴더 병합" @close="emit('close')">
    <p class="muted hint">
      한 폴더 바로 밑에 <strong>DWG 폴더와 PDF 폴더가 둘 다</strong> 있는 자리입니다. 양쪽에 이름이
      <strong>대소문자까지 같은</strong> 자료를 상위 폴더의 자료 1건(원본+사본)으로 합칩니다.
      대소문자만 다른 이름은 합치지 않으니 이름을 바로잡은 뒤 다시 병합하세요.
    </p>
    <div v-if="result" class="msg" :class="result.kind">
      {{ result.text }}
      <ul v-if="result.skipped.length">
        <li v-for="(s, i) in result.skipped.slice(0, 20)" :key="i">{{ s.name }} — {{ s.reason }}</li>
      </ul>
    </div>
    <div class="scroll">
      <table class="grid">
        <thead>
          <tr>
            <th style="width:34px"><input type="checkbox" :checked="allOn" @change="toggleAll" /></th>
            <th>병합 대상 폴더</th><th style="width:70px">DWG</th><th style="width:70px">PDF</th>
            <th style="width:90px">합칠 수 있음</th><th style="width:240px">대소문자만 다름</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in data?.items ?? []" :key="c.parentId">
            <td class="tc"><input type="checkbox" :checked="picked.has(c.parentId)" @change="toggle(c.parentId)" /></td>
            <td>{{ c.parentPath }}</td>
            <td class="tc">{{ c.dwgCount }}</td>
            <td class="tc">{{ c.pdfCount }}</td>
            <td class="tc">{{ c.mergeableCount }}</td>
            <td class="muted small">
              <template v-if="c.caseMismatchCount">
                {{ c.caseMismatchCount }}건 — {{ c.caseMismatchNames.slice(0, 3).join(', ') }}
                <template v-if="c.caseMismatchCount > 3"> 외</template>
              </template>
              <template v-else>-</template>
            </td>
          </tr>
          <tr v-if="!data?.items.length">
            <td colspan="6" class="tc muted">{{ isFetching ? '불러오는 중…' : '병합할 폴더가 없습니다.' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">닫기</button>
      <button class="btn btn-primary" :disabled="!canFolder || !picked.size || busy" @click="merge">
        선택 {{ picked.size }}곳 병합</button>
    </template>
  </Modal>
</template>

<style scoped>
.hint { font-size: var(--fs-sm); margin: 0 0 8px; }
.scroll { max-height: 55vh; overflow: auto; }
.small { font-size: var(--fs-sm); }
.msg { padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; font-size: var(--fs-sm); background: var(--accent-soft); }
.msg.err { color: var(--danger); background: var(--surface-3); }
.msg ul { margin: 4px 0 0; padding-left: 18px; }
</style>
