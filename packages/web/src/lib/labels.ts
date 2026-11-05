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

/** 반입 확인 필요 사유 — 계약의 REASON_LABELS(@tdms/contracts/importMatch)와 같은 글자 */
export const IMPORT_REASON_LABEL: Record<string, string> = {
  FILENAME_MISMATCH: '자료명 불일치',
  PATH_MISMATCH: '경로 불일치',
  ORIGINAL_MISSING: '원본 누락',
  PDF_MISSING: '사본 누락',
  ALREADY_IMPORTED: '기 반입 완료',
  NOT_DISTRIBUTED: '반출 대상 아님',
  DUPLICATE_FILE: '같은 형식 파일 중복',
  REV_MISMATCH: '표기 불일치',
  REV_TAG_MISSING: '리비전 표기 없음',
  REV_TAG_MALFORMED: '리비전 표기 형식 오류',
  REGISTER_FAILED: '등록 실패',
}
