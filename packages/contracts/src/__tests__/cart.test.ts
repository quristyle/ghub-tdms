import { describe, expect, it } from 'vitest'
import {
  CartAddRequest,
  CartFolderCreateRequest,
  CartFolderUpdateRequest,
  CartItemListQuery,
  CartMoveRequest,
  CartRemoveRequest,
} from '../cart.js'

describe('Cart Contracts', () => {
  describe('CartFolderCreateRequest', () => {
    it('유효한 폴더 이름으로 검증 통과', () => {
      const parsed = CartFolderCreateRequest.parse({ name: '2026-11 배관공사' })
      expect(parsed.name).toBe('2026-11 배관공사')
      expect(parsed.parentId).toBeUndefined()
    })

    it('상위 폴더 ID 지정 지원', () => {
      const parsed = CartFolderCreateRequest.parse({ name: '하위폴더', parentId: 5 })
      expect(parsed.name).toBe('하위폴더')
      expect(parsed.parentId).toBe(5)
    })

    it('빈 이름은 검증 실패', () => {
      const res = CartFolderCreateRequest.safeParse({ name: '' })
      expect(res.success).toBe(false)
    })
  })

  describe('CartFolderUpdateRequest', () => {
    it('이름 변경 검증 통과', () => {
      const parsed = CartFolderUpdateRequest.parse({ name: '수정된 폴더명' })
      expect(parsed.name).toBe('수정된 폴더명')
    })

    it('위치 변경(parentId null) 검증 통과', () => {
      const parsed = CartFolderUpdateRequest.parse({ parentId: null })
      expect(parsed.parentId).toBeNull()
    })
  })

  describe('CartAddRequest', () => {
    it('자료 ID 목록 및 대상 폴더 검증 통과', () => {
      const parsed = CartAddRequest.parse({ documentIds: [101, 102], folderId: 3 })
      expect(parsed.documentIds).toEqual([101, 102])
      expect(parsed.folderId).toBe(3)
    })

    it('빈 자료 목록은 검증 실패', () => {
      const res = CartAddRequest.safeParse({ documentIds: [] })
      expect(res.success).toBe(false)
    })
  })

  describe('CartMoveRequest', () => {
    it('폴더 이동 요청 검증 통과 (대상 폴더 지정)', () => {
      const parsed = CartMoveRequest.parse({ documentIds: [101], targetFolderId: 10 })
      expect(parsed.documentIds).toEqual([101])
      expect(parsed.targetFolderId).toBe(10)
    })

    it('기본 폴더(root)로 이동 시 targetFolderId = null 검증 통과', () => {
      const parsed = CartMoveRequest.parse({ documentIds: [101], targetFolderId: null })
      expect(parsed.targetFolderId).toBeNull()
    })
  })

  describe('CartRemoveRequest', () => {
    it('제외 대상 자료 ID 목록 검증 통과', () => {
      const parsed = CartRemoveRequest.parse({ documentIds: [101, 102] })
      expect(parsed.documentIds).toEqual([101, 102])
    })
  })

  describe('CartItemListQuery', () => {
    it('folderId 가 숫자 문자열일 때 숫자로 파싱', () => {
      const parsed = CartItemListQuery.parse({ folderId: '12' })
      expect(parsed.folderId).toBe(12)
    })

    it('folderId 가 "root" 일 때 "root" 유지', () => {
      const parsed = CartItemListQuery.parse({ folderId: 'root' })
      expect(parsed.folderId).toBe('root')
    })

    it('folderId 가 "all" 일 때 "all" 유지', () => {
      const parsed = CartItemListQuery.parse({ folderId: 'all' })
      expect(parsed.folderId).toBe('all')
    })

    it('folderId 가 없을 때 undefined', () => {
      const parsed = CartItemListQuery.parse({})
      expect(parsed.folderId).toBeUndefined()
    })
  })
})
