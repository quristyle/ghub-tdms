import { ref, shallowRef } from 'vue'

/**
 * 사용자 보관 — 화면 어디서든 같은 팝업을 쓰기 위한 공용 상태 (기존 favorites.js).
 *
 * 보관 버튼은 미리보기(PDF 뷰어, iframe) 도구모음 [»] 안에 있다. 뷰어가 바깥 창의
 * window.openFavoriteSaveDialog(opts) 를 부르면 여기 saveRequest 에 담기고,
 * AppShell 에 붙은 FavoriteSaveDialog 가 그것을 보고 뜬다. 팝업을 뷰어(작은 창) 안이 아니라
 * 바깥에 띄우는 것은 미리보기 크기 안에 갇히지 않게 하려는 것이다.
 */

/** 팝업 제목 — 엑셀 파일명·시트 이름이 이것을 따라간다 */
export const FAV_SAVE_TITLE = '사용자 보관'
export const FAV_LIST_TITLE = '사용자 보관 목록'

/** 뷰어(dms-favorite.js)가 넘기는 보관 위치 한 줄 — 서버 /favorites/resolve/target 그대로 */
export interface FavSlot {
  id: number
  name: string
  kind: 'TDB' | 'MDB'
  has_markup: boolean
  description: string | null
  target_name: string | null
  missing: boolean
  updated_at: string
  pdf_file_id: number | null
  path: string | null
  document_id: number | null
  mdb_file_id: number | null
  view_mode: string | null
  same: boolean
}

/** 뷰어가 openFavoriteSaveDialog 로 넘기는 값 (dms-favorite.js openDialog) */
export interface FavSaveOpts {
  mode: 'save' | 'saveAs'
  target: {
    kind: 'TDB' | 'MDB'
    documentId: number | null
    mdbFileId: number | null
    name: string
    pdfFileId: number | null
  } | null
  saved?: FavSlot[]
  allSaved?: FavSlot[]
  markup?: unknown[]
  originalMarkup?: unknown[]
  viewMode?: 'original' | null
  linkedId?: number | null
  used?: number
  limit?: number
  onSaved?: (favId: number) => void
  onChanged?: () => void
}

export const saveRequest = shallowRef<FavSaveOpts | null>(null)
export const listOpen = ref(false)

/** 미리보기 한 겹 — 목록·보관 팝업의 돋보기가 쓴다 (보던 미리보기는 그대로 둔다) */
export interface FavPreview {
  title: string
  fileUrl: string
  favoriteId: number | null
}
export const asidePreview = shallowRef<FavPreview | null>(null)

/** 건수 배지를 새로 받게 한다 (AppShell 이 이 값을 지켜본다) */
export const countVersion = ref(0)
export const bumpCount = () => { countVersion.value++ }

/**
 * 뷰어에서 넘어온 값은 iframe 쪽 객체라 그 창이 닫히면 못 읽는다.
 * 팝업이 떠 있는 동안 미리보기가 닫힐 수 있으므로 이 창 것으로 복사해 둔다.
 */
function detach<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

export function openFavoriteSaveDialog(opts: FavSaveOpts): void {
  saveRequest.value = {
    ...opts,
    target: detach(opts.target),
    saved: detach(opts.saved ?? []),
    allSaved: detach(opts.allSaved ?? opts.saved ?? []),
    markup: detach(opts.markup ?? []),
    originalMarkup: detach(opts.originalMarkup ?? []),
  }
}

/** [보관하기] 기본 이름 — 언제나 자료명 그대로 (Markup 꼬리를 붙이지 않는다, CM 지시) */
export function favDefaultName(name: string | null | undefined): string {
  return String(name ?? '').trim()
}

/** [다른 이름으로 보관] 처음 이름 — 같은 이름이 있으면 (2),(3)… */
export function favUniqueName(base: string, taken: { name: string }[]): string {
  const set = new Set(taken.map((f) => f.name))
  if (!set.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const c = `${base} (${n})`
    if (!set.has(c)) return c
  }
  return base
}

/** 보관 1건을 미리보기로 열 때의 PDF 주소 */
export function favPreviewUrl(kind: 'TDB' | 'MDB', pdfFileId: number | null): string | null {
  if (pdfFileId === null) return null
  return kind === 'TDB' ? `/api/files/${pdfFileId}/view` : `/api/mdb/files/${pdfFileId}/view`
}
