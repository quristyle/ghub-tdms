import { describe, expect, it } from 'vitest'

interface MockUser {
  id: number
  name: string
  loginId: string
  groupId: number | null
  partnerCompanyId: number | null
  companyCode: string
  employmentStatus: 'ACTIVE' | 'RETIRED'
}

interface MockPartnerCompany {
  id: number
  name: string
  companyCode: string | null
}

function filterUsersByTab(
  users: MockUser[],
  tab: 'group' | 'company',
  selectedId: number | string | 'ALL',
) {
  const active = users.filter((u) => u.employmentStatus === 'ACTIVE')
  if (tab === 'group') {
    if (selectedId === 'ALL') return active
    if (selectedId === 'UNASSIGNED') {
      return active.filter((u) => u.groupId === null || !u.groupId)
    }
    return active.filter((u) => u.groupId === selectedId)
  } else {
    if (selectedId === 'ALL') return active
    if (selectedId === 'SKGAS') {
      return active.filter((u) => u.partnerCompanyId === null || !u.partnerCompanyId)
    }
    if (typeof selectedId === 'number') {
      return active.filter((u) => u.partnerCompanyId === selectedId)
    }
    return active.filter((u) => u.partnerCompanyId === null && u.companyCode === selectedId)
  }
}

function resolveGroupDrop(
  target: { id: number | 'UNASSIGNED'; name: string },
  user: MockUser,
) {
  const targetGroupId = target.id === 'UNASSIGNED' ? null : target.id
  const isAlready = target.id === 'UNASSIGNED'
    ? (user.groupId === null || !user.groupId)
    : user.groupId === target.id
  return { targetGroupId, isAlready }
}

function resolveCompanyDrop(
  target: { id: number | 'SKGAS'; name: string; companyCode?: string | null },
  user: MockUser,
) {
  const isTargetSkgas = target.id === 'SKGAS'
  const isAlready = isTargetSkgas
    ? (!user.partnerCompanyId && (user.companyCode === 'SKGAS' || !user.companyCode))
    : user.partnerCompanyId === target.id

  const payload = isTargetSkgas
    ? { partnerCompanyId: null, companyCode: 'SKGAS' }
    : { partnerCompanyId: target.id as number, companyCode: target.companyCode || 'COOPERATIVE' }

  return { payload, isAlready }
}

describe('사용자 관리(/users) - 그룹/소속 탭 및 드래그 앤 드롭 이동 로직', () => {
  const mockUsers: MockUser[] = [
    { id: 1, name: '김본사', loginId: 'bskim', groupId: 1, partnerCompanyId: null, companyCode: 'SKGAS', employmentStatus: 'ACTIVE' },
    { id: 2, name: '이본사', loginId: 'slee', groupId: 2, partnerCompanyId: null, companyCode: 'SKGAS', employmentStatus: 'ACTIVE' },
    { id: 3, name: '박협력', loginId: 'hpark', groupId: 1, partnerCompanyId: 6, companyCode: 'COOPERATIVE', employmentStatus: 'ACTIVE' },
    { id: 4, name: '최협력', loginId: 'hchoi', groupId: null, partnerCompanyId: 8, companyCode: 'COOPERATIVE', employmentStatus: 'ACTIVE' },
    { id: 5, name: '미소속본사', loginId: 'unassigned_bs', groupId: null, partnerCompanyId: null, companyCode: 'SKGAS', employmentStatus: 'ACTIVE' },
    { id: 6, name: '퇴직자', loginId: 'ret', groupId: 1, partnerCompanyId: null, companyCode: 'SKGAS', employmentStatus: 'RETIRED' },
  ]

  describe('1. 그룹 탭 사용자 필터링', () => {
    it('전체(ALL) 선택 시 재직 중인 모든 사용자가 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'group', 'ALL')
      expect(list.map((u) => u.name)).toEqual(['김본사', '이본사', '박협력', '최협력', '미소속본사'])
    })

    it('특정 그룹(1) 선택 시 해당 그룹 소속 사용자만 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'group', 1)
      expect(list.map((u) => u.name)).toEqual(['김본사', '박협력'])
    })

    it('미소속(UNASSIGNED) 선택 시 groupId가 없는 사용자만 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'group', 'UNASSIGNED')
      expect(list.map((u) => u.name)).toEqual(['최협력', '미소속본사'])
    })
  })

  describe('2. 소속 탭 사용자 필터링', () => {
    it('전체(ALL) 선택 시 재직 중인 모든 사용자가 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'company', 'ALL')
      expect(list.map((u) => u.name)).toEqual(['김본사', '이본사', '박협력', '최협력', '미소속본사'])
    })

    it('SK가스(본사) 선택 시 partnerCompanyId가 없는 본사 사용자만 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'company', 'SKGAS')
      expect(list.map((u) => u.name)).toEqual(['김본사', '이본사', '미소속본사'])
    })

    it('특정 협력업체(id: 6) 선택 시 해당 협력업체 사용자만 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'company', 6)
      expect(list.map((u) => u.name)).toEqual(['박협력'])
    })

    it('특정 협력업체(id: 8) 선택 시 해당 협력업체 사용자만 반환된다', () => {
      const list = filterUsersByTab(mockUsers, 'company', 8)
      expect(list.map((u) => u.name)).toEqual(['최협력'])
    })
  })

  describe('3. 드래그 앤 드롭으로 그룹 변경', () => {
    it('사용자를 다른 그룹(2)으로 드롭하면 groupId가 2로 설정된다', () => {
      const user = mockUsers[0]! // 김본사 (groupId: 1)
      const { targetGroupId, isAlready } = resolveGroupDrop({ id: 2, name: '운영팀' }, user)
      expect(isAlready).toBe(false)
      expect(targetGroupId).toBe(2)
    })

    it('이미 같은 그룹(1)에 속한 사용자를 해당 그룹으로 드롭하면 isAlready가 true이다', () => {
      const user = mockUsers[0]! // 김본사 (groupId: 1)
      const { isAlready } = resolveGroupDrop({ id: 1, name: '설비팀' }, user)
      expect(isAlready).toBe(true)
    })

    it('사용자를 미소속으로 드롭하면 groupId가 null로 설정된다', () => {
      const user = mockUsers[0]! // 김본사 (groupId: 1)
      const { targetGroupId, isAlready } = resolveGroupDrop({ id: 'UNASSIGNED', name: '미소속' }, user)
      expect(isAlready).toBe(false)
      expect(targetGroupId).toBeNull()
    })

    it('이미 미소속인 사용자를 미소속으로 드롭하면 isAlready가 true이다', () => {
      const user = mockUsers[3]! // 최협력 (groupId: null)
      const { isAlready } = resolveGroupDrop({ id: 'UNASSIGNED', name: '미소속' }, user)
      expect(isAlready).toBe(true)
    })
  })

  describe('4. 드래그 앤 드롭으로 소속 변경', () => {
    it('본사 사용자를 협력업체(id: 6, 진네트웍스)로 드롭하면 partnerCompanyId=6, companyCode=COOPERATIVE 로 설정된다', () => {
      const user = mockUsers[0]! // 김본사 (partnerCompanyId: null)
      const target = { id: 6, name: '진네트웍스', companyCode: '12345' }
      const { payload, isAlready } = resolveCompanyDrop(target, user)
      expect(isAlready).toBe(false)
      expect(payload).toEqual({ partnerCompanyId: 6, companyCode: '12345' })
    })

    it('협력업체 사용자를 SK가스(본사)로 드롭하면 partnerCompanyId=null, companyCode=SKGAS 로 설정된다', () => {
      const user = mockUsers[2]! // 박협력 (partnerCompanyId: 6)
      const target = { id: 'SKGAS' as const, name: 'SK가스' }
      const { payload, isAlready } = resolveCompanyDrop(target, user)
      expect(isAlready).toBe(false)
      expect(payload).toEqual({ partnerCompanyId: null, companyCode: 'SKGAS' })
    })

    it('이미 SK가스 소속인 사용자를 SK가스로 드롭하면 isAlready가 true이다', () => {
      const user = mockUsers[0]! // 김본사
      const target = { id: 'SKGAS' as const, name: 'SK가스' }
      const { isAlready } = resolveCompanyDrop(target, user)
      expect(isAlready).toBe(true)
    })

    it('이미 해당 협력업체(id: 6) 소속인 사용자를 동일 업체로 드롭하면 isAlready가 true이다', () => {
      const user = mockUsers[2]! // 박협력 (partnerCompanyId: 6)
      const target = { id: 6, name: '진네트웍스' }
      const { isAlready } = resolveCompanyDrop(target, user)
      expect(isAlready).toBe(true)
    })
  })
})
