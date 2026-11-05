import type { DocumentNavQuery } from '@tdms/contracts'

/**
 * TDB 조회 → 자료 상세의 넘겨보기 연결.
 *
 * 기존 detail.js 는 "방금 다녀온 목록의 순서" 를 따라 처음·이전·다음·끝으로 움직였다.
 * 목록 화면이 지금 검색조건·정렬을 여기 남기고, 상세 화면이 그 조건 그대로
 * GET /documents/nav 에 "몇 번째인가" 를 묻는다.
 *
 * 탭마다 따로 두려고 sessionStorage 를 쓴다 — 두 탭에서 서로 다른 목록을 보고 있어도
 * 넘겨보기가 섞이지 않는다.
 */

const KEY = 'tdb-list-nav'

/** 상세 주소의 ?from= 값. 이것이 붙어 있을 때만 넘겨보기를 켠다 */
export const NAV_FROM_LIST = 'list'

export type ListNavParams = Omit<DocumentNavQuery, 'id' | 'at'>

export function saveListNav(p: Partial<ListNavParams>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 저장소가 막혀 있으면 넘겨보기만 꺼진다
  }
}

export function readListNav(): Partial<ListNavParams> | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Partial<ListNavParams>) : null
  } catch {
    return null
  }
}
