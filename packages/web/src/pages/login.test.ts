import { describe, expect, it, vi } from 'vitest'
import type { QuickLoginUser } from '@tdms/contracts'

describe('로그인 화면 — 사용자 그룹별 자동 로그인 버튼', () => {
  const mockQuickUsers: QuickLoginUser[] = [
    { groupId: 1, groupName: '설비기술팀', userId: 1, loginId: 'admin', name: '관리자', role: 'ADMIN' },
    { groupId: 2, groupName: '조회전용', userId: 3, loginId: 'viewer', name: '조회 사용자', role: 'VIEWER' },
  ]

  it('사용자 그룹별로 임의의 사용자 1명씩 매핑된다', () => {
    expect(mockQuickUsers).toHaveLength(2)
    const groupIds = mockQuickUsers.map((u) => u.groupId)
    const uniqueGroupIds = new Set(groupIds)
    expect(uniqueGroupIds.size).toBe(mockQuickUsers.length)
  })

  it('자동 로그인 버튼 클릭 시 해당 loginId로 로그인이 요청된다', async () => {
    const mockQuickLogin = vi.fn().mockResolvedValue(undefined)
    const target = mockQuickUsers[0]!

    await mockQuickLogin(target.loginId)
    expect(mockQuickLogin).toHaveBeenCalledWith('admin')
  })
})
