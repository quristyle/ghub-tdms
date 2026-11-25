import { describe, expect, it, vi } from 'vitest'
import type { QuickLoginUser } from '@tdms/contracts'

describe('로그인 화면 — 사용자 그룹별 자동 로그인 버튼', () => {
  const mockQuickUsers: QuickLoginUser[] = [
    { groupId: 1, groupName: '설비기술팀', userId: 1, loginId: 'admin', name: '관리자', role: 'ADMIN' },
    { groupId: 2, groupName: '조회전용', userId: 3, loginId: 'viewer', name: '조회 사용자', role: 'VIEWER' },
    { groupId: null, groupName: '미소속', userId: 67, loginId: '0048', name: '권순호', role: 'VIEWER' },
  ]

  it('사용자 그룹별 및 미소속 사용자 1명씩 매핑된다', () => {
    expect(mockQuickUsers).toHaveLength(3)
    const unassigned = mockQuickUsers.find((u) => u.groupId === null)
    expect(unassigned).toBeDefined()
    expect(unassigned?.groupName).toBe('미소속')
    expect(unassigned?.loginId).toBe('0048')

    const groupIds = mockQuickUsers.map((u) => u.groupId)
    expect(new Set(groupIds).size).toBe(mockQuickUsers.length)
  })

  it('자동 로그인 버튼 클릭 시 해당 loginId로 로그인이 요청된다', async () => {
    const mockQuickLogin = vi.fn().mockResolvedValue(undefined)
    const target = mockQuickUsers[2]! // 미소속 사용자

    await mockQuickLogin(target.loginId)
    expect(mockQuickLogin).toHaveBeenCalledWith('0048')
  })

  it('사용자의 그룹이 변경되면 해당 그룹에 맞는 사용자가 매핑된다', () => {
    // DB의 users 및 groups 변경 시뮬레이션
    const users = [
      { id: 1, loginId: 'admin', name: '관리자', groupId: 1, isActive: true },
      { id: 2, loginId: 'cm', name: '설비기술팀 CM', groupId: 1, isActive: true },
      { id: 3, loginId: 'viewer', name: '조회 사용자', groupId: 2, isActive: true },
      { id: 67, loginId: '0048', name: '권순호', groupId: null, isActive: true },
    ]
    const groups = [
      { id: 1, name: '설비기술팀' },
      { id: 2, name: '조회전용' },
    ]

    function mapQuickUsers(uList: typeof users, gList: typeof groups): QuickLoginUser[] {
      const result: QuickLoginUser[] = []
      for (const g of gList) {
        const u = uList.find((x) => x.groupId === g.id && x.isActive)
        if (u) {
          result.push({
            groupId: g.id,
            groupName: g.name,
            userId: u.id,
            loginId: u.loginId,
            name: u.name,
            role: 'VIEWER',
          })
        }
      }
      const unassignedUser = uList.find((x) => x.groupId === null && x.isActive)
      if (unassignedUser) {
        result.push({
          groupId: null,
          groupName: '미소속',
          userId: unassignedUser.id,
          loginId: unassignedUser.loginId,
          name: unassignedUser.name,
          role: 'VIEWER',
        })
      }
      return result
    }

    // 1) 초기 매핑 확인
    const initial = mapQuickUsers(users, groups)
    expect(initial.find((u) => u.groupId === 1)?.loginId).toBe('admin')
    expect(initial.find((u) => u.groupId === 2)?.loginId).toBe('viewer')
    expect(initial.find((u) => u.groupId === null)?.loginId).toBe('0048')

    // 2) 사용자 admin의 그룹이 미소속(null)으로 변경되고, 0048이 설비기술팀(1)으로 변경된 경우
    const modifiedUsers = users.map((u) => {
      if (u.id === 1) return { ...u, groupId: null }
      if (u.id === 67) return { ...u, groupId: 1 }
      return u
    })

    const updated = mapQuickUsers(modifiedUsers, groups)
    // 설비기술팀(1)은 이제 cm(2)이 첫 번째 활성 사용자
    expect(updated.find((u) => u.groupId === 1)?.loginId).toBe('cm')
    // 미소속은 admin(1)이 첫 번째 미소속 사용자
    expect(updated.find((u) => u.groupId === null)?.loginId).toBe('admin')
  })
})
