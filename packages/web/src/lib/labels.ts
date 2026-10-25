/**
 * 화면 표시용 라벨.
 *
 * 계약(@tdms/contracts)에서 런타임 상수를 가져오면 **Zod 전체가 그 화면 청크로 끌려온다**
 * — 반출이력 화면이 34.8KB gzip(다른 화면의 7배)이 됐던 원인이다.
 * 타입은 `import type` 으로 지워지지만 값은 지워지지 않는다.
 *
 * 라벨은 표현의 문제지 계약이 아니므로 여기 둔다.
 */

export const DISTRIBUTION_STATE_LABEL: Record<string, string> = {
  DONE: '반입완료',
  INCOMPLETE: '반입미완료',
  ISSUE: '확인필요',
  REVIEWING: '검수대기',
}

export const PURPOSE_LABEL: Record<string, string> = {
  MODIFY: '수정용',
  REFERENCE: '참조용',
  ETC: '기타',
}

export const DOC_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '정상',
  PENDING: '검수',
  SUPERSEDED: '구본',
  MERGE_REQUIRED: '병합 필요',
  RETIRED: '폐기',
}

export const REVIEW_STATUS_LABEL: Record<string, string> = {
  PENDING: '검수대기',
  APPROVED: '승인',
  REJECTED: '반려',
  ISSUE: '확인필요',
  MERGED: '통합됨',
}
