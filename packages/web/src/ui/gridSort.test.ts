import { describe, expect, it } from 'vitest'
import { compareRows, getCellValue, isSortable, type SortableColumn } from './gridSort'

interface TestItem {
  id: number
  name: string
  sortOrder: number
  category?: string
  width?: number
  height?: number
  isEnabled: boolean
  updatedAt: string
  emptyField?: string | null
}

describe('gridSort - 공통 그리드 정렬 유틸리티', () => {
  describe('isSortable (기본 정렬 가능 여부)', () => {
    it('sortable 속성이 명시되지 않은 경우 기본값으로 true 여야 한다', () => {
      const col: SortableColumn<TestItem> = { key: 'name', label: '스탬프 이름' }
      expect(isSortable(col)).toBe(true)
    })

    it('sortable 속성이 true 인 경우 true 여야 한다', () => {
      const col: SortableColumn<TestItem> = { key: 'sortOrder', label: '순서', sortable: true }
      expect(isSortable(col)).toBe(true)
    })

    it('sortable: false 로 명시된 경우 false 여야 한다', () => {
      const col: SortableColumn<TestItem> = { key: 'act', label: '관리', sortable: false }
      expect(isSortable(col)).toBe(false)
    })
  })

  describe('getCellValue (셀 값 추출)', () => {
    it('render 함수가 제공된 경우 render 결과값을 반환한다', () => {
      const col: SortableColumn<TestItem> = {
        key: 'size',
        render: (r) => `${r.width} × ${r.height}`,
      }
      const item: TestItem = {
        id: 1,
        name: '도장',
        sortOrder: 1,
        width: 100,
        height: 80,
        isEnabled: true,
        updatedAt: '2026-10-27',
      }
      expect(getCellValue(item, col)).toBe('100 × 80')
    })

    it('render 가 없으면 row 의 해당 키 값을 문자열로 반환한다', () => {
      const col: SortableColumn<TestItem> = { key: 'name' }
      const item: TestItem = {
        id: 1,
        name: '승인스탬프',
        sortOrder: 1,
        isEnabled: true,
        updatedAt: '2026-10-27',
      }
      expect(getCellValue(item, col)).toBe('승인스탬프')
    })

    it('값이 null 또는 undefined 인 경우 빈 문자열을 반환한다', () => {
      const col: SortableColumn<TestItem> = { key: 'emptyField' }
      const item: TestItem = {
        id: 1,
        name: '테스트',
        sortOrder: 1,
        isEnabled: true,
        updatedAt: '2026-10-27',
        emptyField: null,
      }
      expect(getCellValue(item, col)).toBe('')
    })
  })

  describe('compareRows (행 간 정렬 비교)', () => {
    const items: TestItem[] = [
      { id: 1, name: '접수도장', sortOrder: 3, category: '도장', width: 120, height: 80, isEnabled: true, updatedAt: '2026-10-20T10:00:00' },
      { id: 2, name: '결재인', sortOrder: 1, category: '도장', width: 80, height: 80, isEnabled: false, updatedAt: '2026-10-22T10:00:00' },
      { id: 3, name: '승인표', sortOrder: 10, category: '표', width: 200, height: 100, isEnabled: true, updatedAt: '2026-10-25T10:00:00' },
      { id: 4, name: '검토도장', sortOrder: 2, category: '도장', width: 80, height: 60, isEnabled: false, updatedAt: '2026-10-21T10:00:00', emptyField: null },
      { id: 5, name: '배포확인표', sortOrder: 5, category: '표', width: 150, height: 90, isEnabled: true, updatedAt: '2026-10-24T10:00:00', emptyField: '존재' },
    ]

    it('숫자형 컬럼(sortOrder) 오름차순 및 내림차순 정렬이 정상 동작한다', () => {
      const col: SortableColumn<TestItem> = { key: 'sortOrder', label: '순서' }

      const asc = [...items].sort((a, b) => compareRows(a, b, col, 'asc'))
      expect(asc.map((i) => i.sortOrder)).toEqual([1, 2, 3, 5, 10])

      const desc = [...items].sort((a, b) => compareRows(a, b, col, 'desc'))
      expect(desc.map((i) => i.sortOrder)).toEqual([10, 5, 3, 2, 1])
    })

    it('문자열 컬럼(name) 한글 오름차순 및 내림차순 정렬이 정상 동작한다', () => {
      const col: SortableColumn<TestItem> = { key: 'name', label: '이름' }

      const asc = [...items].sort((a, b) => compareRows(a, b, col, 'asc'))
      expect(asc.map((i) => i.name)).toEqual(['검토도장', '결재인', '배포확인표', '승인표', '접수도장'])

      const desc = [...items].sort((a, b) => compareRows(a, b, col, 'desc'))
      expect(desc.map((i) => i.name)).toEqual(['접수도장', '승인표', '배포확인표', '결재인', '검토도장'])
    })

    it('불리언 컬럼(isEnabled) 상태 정렬이 정상 동작한다', () => {
      const col: SortableColumn<TestItem> = { key: 'isEnabled', label: '상태' }

      const asc = [...items].sort((a, b) => compareRows(a, b, col, 'asc'))
      expect(asc.map((i) => i.isEnabled)).toEqual([false, false, true, true, true])

      const desc = [...items].sort((a, b) => compareRows(a, b, col, 'desc'))
      expect(desc.map((i) => i.isEnabled)).toEqual([true, true, true, false, false])
    })

    it('날짜 문자열 컬럼(updatedAt) 정렬이 정상 동작한다', () => {
      const col: SortableColumn<TestItem> = { key: 'updatedAt', label: '최종수정' }

      const asc = [...items].sort((a, b) => compareRows(a, b, col, 'asc'))
      expect(asc.map((i) => i.id)).toEqual([1, 4, 2, 5, 3])

      const desc = [...items].sort((a, b) => compareRows(a, b, col, 'desc'))
      expect(desc.map((i) => i.id)).toEqual([3, 5, 2, 4, 1])
    })

    it('render 기반 계산 컬럼(size W×H)도 올바르게 정렬된다', () => {
      const col: SortableColumn<TestItem> = {
        key: 'size',
        label: '크기',
        render: (r) => `${r.width} × ${r.height}`,
      }

      const asc = [...items].sort((a, b) => compareRows(a, b, col, 'asc'))
      expect(asc.map((i) => `${i.width} × ${i.height}`)).toEqual([
        '80 × 60',
        '80 × 80',
        '120 × 80',
        '150 × 90',
        '200 × 100',
      ])
    })

    it('null/undefined/빈값은 항상 마지막(NULLS LAST)으로 배치된다', () => {
      const col: SortableColumn<TestItem> = { key: 'emptyField', label: '비고' }

      const asc = [...items].sort((a, b) => compareRows(a, b, col, 'asc'))
      // emptyField 가 있는 item 5 가 먼저 오고 나머지는 null/undefined 이므로 뒤로 배치
      expect(asc[0]!.id).toBe(5)

      const desc = [...items].sort((a, b) => compareRows(a, b, col, 'desc'))
      expect(desc[0]!.id).toBe(5)
    })
  })
})
