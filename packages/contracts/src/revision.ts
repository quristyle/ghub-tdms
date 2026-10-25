/**
 * 리비전 상태 머신 — 반입·검수의 심장.
 *
 * DB 도 파일시스템도 모르는 순수 함수로 둔다. 이 규칙이 틀리면 리비전 이력이 꼬이고
 * 되돌릴 방법이 없으므로, 전수 테스트가 가능한 형태여야 한다.
 *
 * 기존 시스템(routers/imports.py determine_rev_branch / review_revision)의 규칙을
 * 그대로 옮긴 것이다. CM 확정 사항:
 *
 *   ① 리비전 정수는 **승인돼야만** 오른다. 반려가 몇 번이든 정수는 그대로다.
 *   ② 반려된 시도는 반려되는 순간 글자(a, b, c…)가 붙어 이력에 남는다.
 *   ③ 중복반출(서로 다른 업체로 미반납 수정용 반출 2건 이상)이면 분기(a)로 시작한다.
 *   ④ 분기본은 승인해도 현재본이 되지 않는다 — 사람이 CAD 로 통합한 것만 정식 Rev 가 된다.
 *   ⑤ 어떤 경우에도 행을 지우지 않는다 (D-6).
 */

/** 사내 통합본을 올릴 때 쓰는 업체명. 이 이름이면 분기를 만들지 않는다. */
export const INTERNAL_VENDOR = '사내'

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ISSUE' | 'MERGED'

export interface ExistingFile {
  rev: number
  branch: string | null
  reviewStatus: ReviewStatus
}

export interface OpenDistribution {
  vendorName: string
  purpose: 'MODIFY' | 'REFERENCE' | 'ETC'
  returned: boolean
}

export interface RevBranchDecision {
  rev: number
  branch: string | null
  /** 이번 결정 때문에 글자를 소급해 붙여야 하는 기존 시도들 (rev·branch=null 인 것) */
  backfillToA: boolean
  reason: string
}

/**
 * 업로드 시점의 rev·branch 를 정한다.
 *
 * 목표 rev 는 항상 '현재 승인된 rev + 1' 하나뿐이다.
 */
export function determineRevBranch(
  currentRev: number,
  files: readonly ExistingFile[],
  distributions: readonly OpenDistribution[],
  vendorName: string,
): RevBranchDecision {
  const rev = currentRev + 1

  // 사내 통합본은 그 자체가 정식 리비전이 된다 — 분기를 만들지 않는다
  if (vendorName === INTERNAL_VENDOR) {
    return { rev, branch: null, backfillToA: false, reason: '사내 통합본' }
  }

  // 이 rev 를 향해 아직 결론이 나지 않은 시도들.
  // 반려·통합된 것은 이미 끝난 시도라 다음 글자 배정에 영향을 주지 않는다.
  const open = files.filter(
    (f) => f.rev === rev && f.reviewStatus !== 'MERGED' && f.reviewStatus !== 'REJECTED',
  )

  if (open.length > 0) {
    const letters = open
      .map((f) => f.branch)
      .filter((b): b is string => b !== null)
      .sort()

    const last = letters.at(-1)
    if (last !== undefined) {
      return {
        rev,
        branch: nextLetter(last),
        backfillToA: false,
        reason: '진행 중인 분기가 있어 다음 글자를 붙임',
      }
    }

    // 먼저 있던 시도가 글자 없이 대기 중이었는데 또 겹쳐 들어왔다.
    // 이제 둘을 구분해야 하므로 먼저 것을 'a' 로 소급하고 이번 것을 'b' 로 한다.
    return {
      rev,
      branch: 'b',
      backfillToA: true,
      reason: '대기 중이던 시도와 겹쳐 들어와 구분이 필요함',
    }
  }

  // 진짜 중복반출: 서로 다른 업체로 나간 미반납 '수정용' 반출이 2건 이상
  const vendors = new Set(
    distributions.filter((d) => d.purpose === 'MODIFY' && !d.returned).map((d) => d.vendorName),
  )
  if (vendors.size >= 2) {
    return { rev, branch: 'a', backfillToA: false, reason: '중복반출 — 분기 시작' }
  }

  return { rev, branch: null, backfillToA: false, reason: '단독 반입' }
}

/** a → b → c … z 다음은 za, zb … (실제로는 두 업체를 넘기는 일이 드물다) */
export function nextLetter(letter: string): string {
  const last = letter.at(-1)!
  if (last < 'z') return letter.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1)
  return letter + 'a'
}

/**
 * 반려할 때 붙일 글자.
 *
 * 이미 글자가 있으면 그대로 쓰고, 없으면(단순 재시도였으면) 그 rev 에서
 * 이미 반려된 글자 수 다음 것을 매긴다.
 */
export function rejectLetter(
  target: { rev: number; branch: string | null },
  files: readonly ExistingFile[],
): string {
  if (target.branch !== null) return target.branch
  const used = new Set(
    files
      .filter((f) => f.rev === target.rev && f.branch !== null && f.reviewStatus === 'REJECTED')
      .map((f) => f.branch as string),
  )
  return String.fromCharCode('a'.charCodeAt(0) + used.size)
}

export interface ApproveOutcome {
  /** 이번 세트를 현재본으로 올릴 것인가 */
  promoteToCurrent: boolean
  /** 문서가 가질 상태 */
  documentStatus: 'ACTIVE' | 'MERGE_REQUIRED'
  /** 열려 있는 분기 형제들을 MERGED 로 닫을 것인가 */
  closeBranchSiblings: boolean
  reason: string
}

/**
 * 승인했을 때 무슨 일이 일어나는가.
 *
 * 분기본은 승인해도 현재본이 되지 않는다 — 시스템은 CAD 도면을 자동 병합하지 못하므로
 * 사람이 통합한 것만 정식 Rev 가 된다(절대 원칙).
 */
export function approveOutcome(
  target: { branch: string | null },
  vendorNames: readonly string[],
): ApproveOutcome {
  const isInternal = vendorNames.includes(INTERNAL_VENDOR)

  if (target.branch !== null) {
    return {
      promoteToCurrent: false,
      documentStatus: 'MERGE_REQUIRED',
      closeBranchSiblings: false,
      reason: '분기본 — 사람이 CAD 로 통합해야 정식 Rev 가 된다',
    }
  }

  return {
    promoteToCurrent: true,
    documentStatus: 'ACTIVE',
    // 사내 통합본이 승인되면 그 전에 받아 둔 분기본들은 할 일이 끝났다
    closeBranchSiblings: isInternal,
    reason: isInternal ? '사내 통합본 승인 — 분기 정리' : '정식 리비전 승인',
  }
}

/** 화면에 보이는 리비전 표기: Rev3 / Rev3-a */
export function revLabel(rev: number, branch: string | null): string {
  return `Rev${rev}${branch ? `-${branch}` : ''}`
}

/**
 * 분기본 승인 전 확인: 반출된 것이 전부 돌아왔는가.
 * 전부 돌아오기 전에 통합을 시작하면 빠뜨리는 수정이 생긴다.
 */
export function branchApprovalBlocked(expected: number, arrived: number): string | null {
  if (expected > 0 && arrived < expected) {
    return `아직 반출된 도면이 모두 반입되지 않았습니다 (${arrived}/${expected}). 전부 반입된 후에 승인할 수 있습니다.`
  }
  return null
}
