import type { MdbCartItem } from '@tdms/contracts'

/**
 * MDB 조회의 검색 조건과 다운대기함 — 탭(sessionStorage) 안에서 기억한다.
 *
 * 상세 화면에 갔다가 [목록으로] 돌아와도 조건·폴더·정렬이 그대로여야 하고(기존 동작),
 * 상세 화면의 [이전·다음]도 **같은 조건·같은 정렬** 안에서 움직여야 하므로 한 곳에 둔다.
 * 창을 닫으면 사라진다 — 다른 창·다른 사람과 섞이지 않는다.
 */

export type MdbCategory = '' | '전용' | '공용' | '확인필요'

export interface MdbSearchState {
  folder: { id: number; name: string } | null
  keyword: string
  searchTarget: 'title' | 'folder' | 'tag'
  equipmentType: string
  docType: string
  projectId: string
  year: string
  /** 분류 — 전체 / 전용 / 공용 / 확인필요 (기존 화면 그대로) */
  category: MdbCategory
  /** 하위폴더 전체보기 */
  recursive: boolean
  sort: 'updatedAt' | 'title' | 'equipmentType' | 'docType' | 'year'
  dir: 'asc' | 'desc'
  limit: number
}

const SEARCH_KEY = 'tdms.mdb.search'
const CART_KEY = 'tdms.mdb.cart'

export function defaultSearch(): MdbSearchState {
  return {
    folder: null, keyword: '', searchTarget: 'title', equipmentType: '', docType: '',
    projectId: '', year: '', category: '', recursive: true, sort: 'updatedAt', dir: 'desc', limit: 200,
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, v: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(v)) } catch { /* 저장 공간이 없으면 기억만 못 한다 */ }
}

export function loadSearch(): MdbSearchState {
  return { ...defaultSearch(), ...(read<Partial<MdbSearchState>>(SEARCH_KEY) ?? {}) }
}

export function saveSearch(s: MdbSearchState): void {
  write(SEARCH_KEY, s)
}

/** 분류 → 서버 조건 (공용·전용은 is_shared, 확인필요는 needs_check) */
function categoryParams(c: MdbCategory): { shared?: boolean; needsCheck?: boolean } {
  if (c === '공용') return { shared: true }
  if (c === '전용') return { shared: false }
  if (c === '확인필요') return { needsCheck: true }
  return {}
}

/** 목록·넘겨보기·전체 엑셀이 함께 쓰는 서버 조건 */
export function toServerFilters(s: MdbSearchState) {
  return {
    sort: s.sort,
    dir: s.dir,
    folderId: s.folder?.id,
    recursive: s.recursive,
    q: s.keyword.trim() || undefined,
    searchTarget: s.searchTarget,
    equipmentType: s.equipmentType || undefined,
    docType: s.docType || undefined,
    projectId: s.projectId || undefined,
    year: s.year || undefined,
    ...categoryParams(s.category),
  }
}

// ── 다운대기함 ──────────────────────────────────────────────────────────

export function loadCart(): MdbCartItem[] {
  return read<MdbCartItem[]>(CART_KEY) ?? []
}

export function saveCart(items: MdbCartItem[]): void {
  write(CART_KEY, items)
}
