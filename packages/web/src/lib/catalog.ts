import { computed, ref, type Ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { CatalogItem, CatalogListResponse } from '@tdms/contracts'
import { api, ApiError } from './api.js'
import { toast } from './toast.js'
import { qk } from './queryKeys.js'

/**
 * 공사·업체 목록을 다루는 규칙 한 벌.
 *
 * 쓰는 곳이 둘이다 — 공사/업체 **관리 화면**(조회부 + 그리드)과 반출하기 창의
 * **[관리] 팝업**(좁은 목록). 생김새는 달라도 하는 일(추가·이름 변경·숨김)은 같아서,
 * 두 벌로 적어 두면 한쪽만 고치고 넘어가기 쉽다. 규칙은 여기 한 곳에만 둔다.
 *
 * 삭제는 없고 숨김만 있다(D-6) — 숨기면 고르는 목록에서만 빠지고 지난 반출·리비전
 * 기록은 그대로다. 그래서 과거 기록의 참조가 끊기지 않는다.
 */
export function useCatalog(kind: Ref<'projects' | 'vendors'>) {
  const qc = useQueryClient()
  const label = computed(() => (kind.value === 'projects' ? '공사' : '업체'))
  const base = computed(() => `/${kind.value}`)

  /** 관리하는 자리에서는 숨긴 것까지 받아 와 화면에서 가른다 */
  const { data, isFetching } = useQuery({
    queryKey: computed(() => qk.catalog.list(kind.value, true)),
    queryFn: () => api.get<CatalogListResponse>(`${base.value}?includeHidden=true`),
  })

  const all = computed<CatalogItem[]>(() => data.value?.items ?? [])
  const hiddenCount = computed(() => all.value.filter((r) => r.isHidden).length)

  const error = ref('')

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    error.value = ''
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: qk.catalog.all })
      return true
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '처리하지 못했습니다.'
      error.value = msg
      toast.err(msg)
      return false
    }
  }

  const add = (name: string) => run(() => api.post(base.value, { name: name.trim() }))
  const rename = (id: number, name: string) => run(() => api.patch(`${base.value}/${id}`, { name: name.trim() }))
  const setHidden = (id: number, hidden: boolean) =>
    run(() => api.post(`${base.value}/${id}/${hidden ? 'hide' : 'unhide'}`))

  return { label, all, hiddenCount, isFetching, error, add, rename, setHidden }
}
