import { describe, expect, it } from 'vitest'
import { qk } from '@/lib/queryKeys'
import { queryClient } from '@/lib/queryClient'

describe('Cart User Isolation', () => {
  it('사용자별로 서로 다른 캐시 키(qk.cart)를 생성한다', () => {
    const adminFolderKey = qk.cart.folders(1)
    const viewerFolderKey = qk.cart.folders(3)
    const anonFolderKey = qk.cart.folders(null)

    expect(adminFolderKey).toEqual(['cart', 1, 'folders'])
    expect(viewerFolderKey).toEqual(['cart', 3, 'folders'])
    expect(anonFolderKey).toEqual(['cart', 'anonymous', 'folders'])
    expect(adminFolderKey).not.toEqual(viewerFolderKey)

    const adminItemsKey = qk.cart.items(1, 'all')
    const viewerItemsKey = qk.cart.items(3, 'all')
    expect(adminItemsKey).toEqual(['cart', 1, 'items', 'all'])
    expect(viewerItemsKey).toEqual(['cart', 3, 'items', 'all'])
    expect(adminItemsKey).not.toEqual(viewerItemsKey)
  })

  it('사용자 전환 시 queryClient.clear()로 이전 사용자의 캐시가 완전히 제거된다', () => {
    // 사용자 1(admin)의 대기함 캐시 데이터 세팅
    queryClient.setQueryData(qk.cart.folders(1), { items: [], totalCount: 5, rootCount: 5 })
    queryClient.setQueryData(qk.cart.items(1, 'all'), { items: [{ id: 101 }], total: 1 })

    expect(queryClient.getQueryData(qk.cart.folders(1))).toBeDefined()
    expect(queryClient.getQueryData(qk.cart.items(1, 'all'))).toBeDefined()

    // 로그아웃 / 새 로그인 시 실행되는 queryClient.clear()
    queryClient.clear()

    // 캐시가 비워져 다음 사용자가 이전 사용자의 대기함을 볼 수 없음
    expect(queryClient.getQueryData(qk.cart.folders(1))).toBeUndefined()
    expect(queryClient.getQueryData(qk.cart.items(1, 'all'))).toBeUndefined()
    expect(queryClient.getQueryData(qk.cart.folders(3))).toBeUndefined()
  })
})
