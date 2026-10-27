export type SortDir = 'asc' | 'desc'

export interface SortableColumn<T> {
  key: string
  label?: string
  sortable?: boolean
  render?: (row: T) => string
}

/**
 * 컬럼의 정렬 가능 여부를 판단한다.
 * 기본값은 true 이며, 명시적으로 sortable: false 가 지정된 경우에만 정렬이 비활성화된다.
 */
export function isSortable<T>(col: SortableColumn<T>): boolean {
  return col.sortable !== false
}

/**
 * 행과 컬럼으로부터 표시할 글자값을 추출한다.
 */
export function getCellValue<T>(row: T, col: SortableColumn<T>): string {
  if (col.render) return col.render(row)
  const v = (row as Record<string, unknown>)[col.key]
  return v === null || v === undefined ? '' : String(v)
}

/**
 * 두 행을 지정된 컬럼 및 정렬 방향에 따라 비교한다.
 *
 * 1. 빈 값(null, undefined, '')은 항상 맨 뒤로(NULLS LAST) 보낸다.
 * 2. 숫자형은 수치 크기로 비교한다.
 * 3. 불리언형은 false -> true 순으로 비교한다.
 * 4. 문자열은 한국어 로케일 자연 정렬(numeric: true)을 적용한다.
 * 5. 값이 같으면 id 순으로 안정적으로 정렬한다.
 */
export function compareRows<T extends { id?: number }>(
  a: T,
  b: T,
  col: SortableColumn<T>,
  dir: SortDir,
): number {
  const rawA = (a as Record<string, unknown>)[col.key]
  const rawB = (b as Record<string, unknown>)[col.key]

  let valA: unknown = rawA
  let valB: unknown = rawB

  if ((valA === undefined || valA === null) && col.render) {
    valA = getCellValue(a, col)
  }
  if ((valB === undefined || valB === null) && col.render) {
    valB = getCellValue(b, col)
  }

  const emptyA = valA === null || valA === undefined || valA === ''
  const emptyB = valB === null || valB === undefined || valB === ''

  if (emptyA && emptyB) return 0
  if (emptyA) return 1
  if (emptyB) return -1

  let cmp = 0
  if (typeof valA === 'number' && typeof valB === 'number') {
    cmp = valA - valB
  } else if (typeof valA === 'boolean' && typeof valB === 'boolean') {
    cmp = valA === valB ? 0 : valA ? 1 : -1
  } else {
    const strA = typeof valA === 'string' ? valA : getCellValue(a, col)
    const strB = typeof valB === 'string' ? valB : getCellValue(b, col)
    const numA = Number(strA)
    const numB = Number(strB)
    if (strA.trim() !== '' && strB.trim() !== '' && !Number.isNaN(numA) && !Number.isNaN(numB)) {
      cmp = numA - numB
    } else {
      cmp = strA.localeCompare(strB, 'ko-KR', { numeric: true, sensitivity: 'base' })
    }
  }

  const res = dir === 'desc' ? -cmp : cmp
  return res !== 0 ? res : ((a.id ?? 0) - (b.id ?? 0))
}
