import type { DocumentListQuery, DocClass } from '@tdms/contracts'

/** 캐시 키를 한 곳에 모은다 — 무효화 범위를 실수 없이 잡기 위해서다. */
export const qk = {
  me: ['me'] as const,
  folders: {
    all: ['folders'] as const,
    tree: (docClass: DocClass, parentId?: number) => ['folders', docClass, parentId ?? 'root'] as const,
  },
  documents: {
    all: ['documents'] as const,
    list: (p: Partial<DocumentListQuery>) => ['documents', 'list', p] as const,
    detail: (id: number) => ['documents', 'detail', id] as const,
  },
} as const

/** 자원별 캐시 수명 — 04 설계문서의 기준표 그대로 */
export const staleTime = {
  types: Infinity,     // 업체·공사·설비유형 (변경 시 수동 무효화)
  tree: 5 * 60_000,
  list: 30_000,
  detail: 30_000,
  worklist: 0,         // 검수 대기 / 미입고 — 항상 최신
} as const
