import { describe, expect, it } from 'vitest'

interface MockUser {
  id: number
  name: string
  loginId: string
  groupId: number | null
  employmentStatus: 'ACTIVE' | 'RETIRED'
}

function filterGroupUsers(
  users: MockUser[],
  pickedGroup: number | string | null,
  memberFilter: string = '',
) {
  if (pickedGroup === null) return []
  const active = users.filter((u) => u.employmentStatus === 'ACTIVE')
  const matched = pickedGroup === 'unassigned'
    ? active.filter((u) => u.groupId === null || !u.groupId)
    : active.filter((u) => u.groupId === pickedGroup)

  const q = memberFilter.trim().toLowerCase()
  if (!q) return matched
  return matched.filter(
    (u) => u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q),
  )
}

function resolveDropTarget(
  targetGroup: { id: number | string; isUnassigned?: boolean },
  currentUser: MockUser,
) {
  const targetGroupId = targetGroup.isUnassigned ? null : (targetGroup.id as number)
  const isAlreadyInGroup = targetGroup.isUnassigned
    ? (currentUser.groupId === null || !currentUser.groupId)
    : currentUser.groupId === targetGroup.id

  return { targetGroupId, isAlreadyInGroup }
}

describe('접속권한 관리 - 그룹 사용자 탭 및 소속 이동 로직', () => {
  const mockUsers: MockUser[] = [
    { id: 1, name: '홍길동', loginId: 'gdhong', groupId: 10, employmentStatus: 'ACTIVE' },
    { id: 2, name: '이순신', loginId: 'sslee', groupId: 10, employmentStatus: 'ACTIVE' },
    { id: 3, name: '강감찬', loginId: 'gckang', groupId: 20, employmentStatus: 'ACTIVE' },
    { id: 4, name: '김유신', loginId: 'yskim', groupId: null, employmentStatus: 'ACTIVE' },
    { id: 5, name: '퇴직자', loginId: 'retired', groupId: 10, employmentStatus: 'RETIRED' },
    { id: 6, name: '미소속퇴직자', loginId: 'unassigned_ret', groupId: null, employmentStatus: 'RETIRED' },
  ]

  it('일반 그룹 선택 시 해당 그룹의 재직 사용자만 추출된다', () => {
    const list = filterGroupUsers(mockUsers, 10)
    expect(list.map((u) => u.name)).toEqual(['홍길동', '이순신'])
  })

  it('미소속사용자그룹 선택 시 groupId가 없는 재직 사용자만 추출된다', () => {
    const list = filterGroupUsers(mockUsers, 'unassigned')
    expect(list.map((u) => u.name)).toEqual(['김유신'])
  })

  it('그룹 사용자 검색 필터가 정상 동작한다', () => {
    const list = filterGroupUsers(mockUsers, 10, 'sslee')
    expect(list.map((u) => u.name)).toEqual(['이순신'])
  })

  it('드래그 드롭 대상이 동일 그룹인 경우 이동이 스킵된다', () => {
    const userInGroup10 = mockUsers[0]!
    const targetGroup = { id: 10, isUnassigned: false }
    const { isAlreadyInGroup } = resolveDropTarget(targetGroup, userInGroup10)
    expect(isAlreadyInGroup).toBe(true)
  })

  it('일반 그룹 사용자를 다른 그룹으로 드롭하면 대상 그룹 ID가 설정된다', () => {
    const userInGroup10 = mockUsers[0]!
    const targetGroup = { id: 20, isUnassigned: false }
    const { targetGroupId, isAlreadyInGroup } = resolveDropTarget(targetGroup, userInGroup10)
    expect(isAlreadyInGroup).toBe(false)
    expect(targetGroupId).toBe(20)
  })

  it('미소속사용자그룹으로 드롭하면 groupId가 null로 설정된다', () => {
    const userInGroup10 = mockUsers[0]!
    const targetGroup = { id: 'unassigned', isUnassigned: true }
    const { targetGroupId, isAlreadyInGroup } = resolveDropTarget(targetGroup, userInGroup10)
    expect(isAlreadyInGroup).toBe(false)
    expect(targetGroupId).toBeNull()
  })

  it('이미 미소속인 사용자를 미소속사용자그룹으로 드롭하면 이동이 스킵된다', () => {
    const unassignedUser = mockUsers[3]!
    const targetGroup = { id: 'unassigned', isUnassigned: true }
    const { isAlreadyInGroup } = resolveDropTarget(targetGroup, unassignedUser)
    expect(isAlreadyInGroup).toBe(true)
  })
})
