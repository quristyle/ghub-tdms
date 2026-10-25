import { describe, expect, it } from 'vitest'
import {
  INTERNAL_VENDOR, approveOutcome, branchApprovalBlocked, determineRevBranch,
  type ExistingFile, nextLetter, type OpenDistribution, rejectLetter, revLabel,
} from '../revision.js'

const f = (rev: number, branch: string | null, reviewStatus: ExistingFile['reviewStatus']): ExistingFile =>
  ({ rev, branch, reviewStatus })
const dist = (vendorName: string, returned = false, purpose: OpenDistribution['purpose'] = 'MODIFY'): OpenDistribution =>
  ({ vendorName, purpose, returned })

describe('determineRevBranch — 업로드 시점의 rev·branch', () => {
  it('아무것도 없으면 현재 Rev + 1, 분기 없음', () => {
    const d = determineRevBranch(2, [], [], '대한엔지니어링')
    expect(d).toMatchObject({ rev: 3, branch: null, backfillToA: false })
  })

  it('사내 통합본은 언제나 분기 없이 다음 정수', () => {
    // 중복반출이 걸려 있어도 사내 통합본은 그 자체가 정식 리비전이다
    const d = determineRevBranch(2, [], [dist('A사'), dist('B사')], INTERNAL_VENDOR)
    expect(d).toMatchObject({ rev: 3, branch: null })
  })

  it('반려는 정수를 소모하지 않는다 — 다음 시도도 같은 정수를 향한다', () => {
    const files = [f(3, 'a', 'REJECTED'), f(3, 'b', 'REJECTED')]
    const d = determineRevBranch(2, files, [], '대한엔지니어링')
    expect(d.rev).toBe(3)
    // 반려는 끝난 시도라 다음 글자 배정에 영향을 주지 않는다
    expect(d.branch).toBeNull()
  })

  it('통합된(MERGED) 시도도 열린 것으로 치지 않는다', () => {
    const d = determineRevBranch(2, [f(3, 'a', 'MERGED')], [], '대한엔지니어링')
    expect(d.branch).toBeNull()
  })

  it('진행 중인 분기가 있으면 다음 글자를 붙인다', () => {
    const d = determineRevBranch(2, [f(3, 'a', 'PENDING')], [], 'B사')
    expect(d).toMatchObject({ rev: 3, branch: 'b', backfillToA: false })
  })

  it('승인된 분기본도 열린 것으로 친다 (아직 통합 전이므로)', () => {
    const d = determineRevBranch(2, [f(3, 'a', 'APPROVED')], [], 'B사')
    expect(d.branch).toBe('b')
  })

  it('글자 없이 대기 중이던 시도와 겹치면 먼저 것을 a 로 소급하고 이번 것을 b 로 한다', () => {
    const d = determineRevBranch(2, [f(3, null, 'PENDING')], [], 'B사')
    expect(d).toMatchObject({ rev: 3, branch: 'b', backfillToA: true })
  })

  it('서로 다른 업체로 미반납 수정용 반출이 2건이면 분기 a 로 시작한다', () => {
    const d = determineRevBranch(2, [], [dist('A사'), dist('B사')], 'A사')
    expect(d).toMatchObject({ rev: 3, branch: 'a' })
  })

  it('같은 업체로 2건이면 중복반출이 아니다', () => {
    const d = determineRevBranch(2, [], [dist('A사'), dist('A사')], 'A사')
    expect(d.branch).toBeNull()
  })

  it('이미 반납된 반출은 중복반출로 치지 않는다', () => {
    const d = determineRevBranch(2, [], [dist('A사', true), dist('B사')], 'B사')
    expect(d.branch).toBeNull()
  })

  it('참조용 반출은 중복반출로 치지 않는다 (수정용만 센다)', () => {
    const d = determineRevBranch(
      2, [], [dist('A사', false, 'REFERENCE'), dist('B사', false, 'REFERENCE')], 'A사',
    )
    expect(d.branch).toBeNull()
  })
})

describe('nextLetter', () => {
  it('a → b → c', () => {
    expect(nextLetter('a')).toBe('b')
    expect(nextLetter('b')).toBe('c')
  })
  it('z 를 넘기면 za 로 이어 간다', () => {
    expect(nextLetter('z')).toBe('za')
    expect(nextLetter('za')).toBe('zb')
  })
})

describe('rejectLetter — 반려할 때 붙이는 글자', () => {
  it('이미 글자가 있으면 그대로 쓴다', () => {
    expect(rejectLetter({ rev: 3, branch: 'b' }, [])).toBe('b')
  })

  it('글자가 없으면 그 rev 에서 반려된 수 다음 글자를 매긴다', () => {
    expect(rejectLetter({ rev: 3, branch: null }, [])).toBe('a')
    expect(rejectLetter({ rev: 3, branch: null }, [f(3, 'a', 'REJECTED')])).toBe('b')
    expect(
      rejectLetter({ rev: 3, branch: null }, [f(3, 'a', 'REJECTED'), f(3, 'b', 'REJECTED')]),
    ).toBe('c')
  })

  it('다른 rev 의 반려는 세지 않는다', () => {
    expect(rejectLetter({ rev: 3, branch: null }, [f(2, 'a', 'REJECTED')])).toBe('a')
  })

  it('같은 글자가 파일 여러 개(DWG+PDF)에 붙어 있어도 한 번만 센다', () => {
    const files = [f(3, 'a', 'REJECTED'), f(3, 'a', 'REJECTED')]
    expect(rejectLetter({ rev: 3, branch: null }, files)).toBe('b')
  })
})

describe('approveOutcome — 승인하면 무슨 일이 일어나는가', () => {
  it('정식 리비전은 현재본으로 올라간다', () => {
    expect(approveOutcome({ branch: null }, ['대한엔지니어링'])).toMatchObject({
      promoteToCurrent: true, documentStatus: 'ACTIVE', closeBranchSiblings: false,
    })
  })

  it('분기본은 승인해도 현재본이 되지 않고 "병합 필요" 가 된다', () => {
    // 절대 원칙: 시스템은 CAD 도면을 자동 병합하지 않는다
    expect(approveOutcome({ branch: 'a' }, ['A사'])).toMatchObject({
      promoteToCurrent: false, documentStatus: 'MERGE_REQUIRED',
    })
  })

  it('사내 통합본이 승인되면 열려 있던 분기들을 닫는다', () => {
    expect(approveOutcome({ branch: null }, [INTERNAL_VENDOR])).toMatchObject({
      promoteToCurrent: true, documentStatus: 'ACTIVE', closeBranchSiblings: true,
    })
  })

  it('분기본이면 사내가 올렸더라도 현재본이 되지 않는다', () => {
    expect(approveOutcome({ branch: 'a' }, [INTERNAL_VENDOR]).promoteToCurrent).toBe(false)
  })
})

describe('branchApprovalBlocked — 전부 돌아왔는가', () => {
  it('덜 들어왔으면 막는다', () => {
    expect(branchApprovalBlocked(3, 2)).toMatch(/2\/3/)
  })
  it('전부 들어왔으면 통과', () => {
    expect(branchApprovalBlocked(3, 3)).toBeNull()
  })
  it('반출이 없으면 막지 않는다', () => {
    expect(branchApprovalBlocked(0, 0)).toBeNull()
  })
})

describe('revLabel', () => {
  it('분기가 없으면 Rev3', () => expect(revLabel(3, null)).toBe('Rev3'))
  it('분기가 있으면 Rev3-a', () => expect(revLabel(3, 'a')).toBe('Rev3-a'))
})

describe('시나리오 — A·B 업체 동시 수정 전체 흐름', () => {
  it('중복반출 → 분기 a·b → 각각 승인 → 병합 필요 → 사내 통합본 승인', () => {
    const files: ExistingFile[] = []
    const dists = [dist('A사'), dist('B사')]   // 둘 다 미반납 수정용

    // A사 반입 → 중복반출이므로 분기 a
    const a = determineRevBranch(2, files, dists, 'A사')
    expect(a).toMatchObject({ rev: 3, branch: 'a' })
    files.push(f(a.rev, a.branch, 'PENDING'))

    // B사 반입 → 진행 중인 a 가 있으므로 b
    const b = determineRevBranch(2, files, dists, 'B사')
    expect(b).toMatchObject({ rev: 3, branch: 'b' })
    files.push(f(b.rev, b.branch, 'PENDING'))

    // 각각 승인 → 둘 다 현재본이 되지 않고 문서는 '병합 필요'
    expect(approveOutcome({ branch: 'a' }, ['A사']).documentStatus).toBe('MERGE_REQUIRED')
    expect(approveOutcome({ branch: 'b' }, ['B사']).documentStatus).toBe('MERGE_REQUIRED')
    files.splice(0, files.length, f(3, 'a', 'APPROVED'), f(3, 'b', 'APPROVED'))

    // 사람이 CAD 로 통합한 사내본을 올린다 → 분기 없이 Rev3
    const merged = determineRevBranch(2, files, dists, INTERNAL_VENDOR)
    expect(merged).toMatchObject({ rev: 3, branch: null })

    // 승인하면 현재본이 되고 열려 있던 분기들이 닫힌다
    const outcome = approveOutcome({ branch: null }, [INTERNAL_VENDOR])
    expect(outcome).toMatchObject({
      promoteToCurrent: true, documentStatus: 'ACTIVE', closeBranchSiblings: true,
    })
  })

  it('반려를 반복해도 리비전 정수는 오르지 않는다', () => {
    const files: ExistingFile[] = []
    for (let i = 0; i < 3; i++) {
      const d = determineRevBranch(5, files, [], '대한엔지니어링')
      expect(d.rev).toBe(6)                        // 항상 같은 정수
      const letter = rejectLetter(d, files)
      files.push(f(d.rev, letter, 'REJECTED'))
    }
    expect(files.map((x) => x.branch)).toEqual(['a', 'b', 'c'])

    // 네 번째 시도가 승인되면 비로소 Rev6 이 된다
    const final = determineRevBranch(5, files, [], '대한엔지니어링')
    expect(final).toMatchObject({ rev: 6, branch: null })
    expect(approveOutcome(final, ['대한엔지니어링']).promoteToCurrent).toBe(true)
  })
})
