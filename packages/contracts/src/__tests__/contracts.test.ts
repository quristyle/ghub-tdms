import { describe, expect, it } from 'vitest'
import { BoolParam, DocumentListQuery } from '../index.js'
import { LEAF_KEYS, LEAF_KEY_SET, PAGE_PERMISSIONS, MENU, leavesUnder } from '../permissions.js'

describe('BoolParam — 쿼리스트링 불리언', () => {
  // z.coerce.boolean() 은 Boolean("false") === true 라서 쓰면 안 된다.
  // 이 함정 때문에 Isometric 토글(전체 도면의 63%를 가르는 필터)이 무력화된 적이 있다.
  it('문자열 "false" 를 false 로 읽는다', () => {
    expect(BoolParam.parse('false')).toBe(false)
    expect(BoolParam.parse('0')).toBe(false)
    expect(BoolParam.parse('no')).toBe(false)
  })

  it('문자열 "true" 를 true 로 읽는다', () => {
    expect(BoolParam.parse('true')).toBe(true)
    expect(BoolParam.parse('1')).toBe(true)
  })

  it('불리언을 그대로 통과시킨다', () => {
    expect(BoolParam.parse(true)).toBe(true)
    expect(BoolParam.parse(false)).toBe(false)
  })
})

describe('DocumentListQuery', () => {
  it('Isometric 은 기본으로 숨긴다 (전체의 63%)', () => {
    expect(DocumentListQuery.parse({}).includeIsometric).toBe(false)
  })

  it('쿼리스트링의 includeIsometric=false 가 제대로 false 가 된다', () => {
    expect(DocumentListQuery.parse({ includeIsometric: 'false' }).includeIsometric).toBe(false)
    expect(DocumentListQuery.parse({ includeIsometric: 'true' }).includeIsometric).toBe(true)
  })

  it('하위 폴더 포함이 기본이다', () => {
    expect(DocumentListQuery.parse({}).recursive).toBe(true)
    expect(DocumentListQuery.parse({ recursive: 'false' }).recursive).toBe(false)
  })

  it('limit 상한을 넘기면 거부한다', () => {
    expect(DocumentListQuery.safeParse({ limit: 100000 }).success).toBe(false)
  })
})

describe('권한 트리', () => {
  it('리프가 정확히 36개다 (기존 permission_tree.py 와 동일)', () => {
    expect(LEAF_KEYS).toHaveLength(36)
  })

  it('리프 키에 중복이 없다', () => {
    expect(LEAF_KEY_SET.size).toBe(LEAF_KEYS.length)
  })

  it('화면 접속 권한 10개가 전부 트리에 있다', () => {
    const pages = Object.values(PAGE_PERMISSIONS)
    expect(pages).toHaveLength(10)
    for (const p of pages) expect(LEAF_KEY_SET.has(p)).toBe(true)
  })

  it('상단 메뉴 9개의 순서와 권한이 기존과 같다', () => {
    expect(MENU.map((m) => m.label)).toEqual([
      'TDB 조회', 'TDB 반입·검수', 'TDB 관리', 'TDB 반출이력',
      'MDB 조회', 'MDB 관리', '시스템 로그', '사용자 관리', '백업 관리',
    ])
    for (const m of MENU) expect(LEAF_KEY_SET.has(m.permission)).toBe(true)
  })

  it('상위 노드를 켜면 하위 리프가 전부 켜진다 (cascade)', () => {
    expect(leavesUnder('screen.tdb_import.review').sort()).toEqual([
      'screen.tdb_import.review.approve',
      'screen.tdb_import.review.reject',
    ])
    expect(leavesUnder('common.note_edit')).toHaveLength(4)
  })

  it('리프 자신을 주면 그 리프만 돌려준다', () => {
    expect(leavesUnder('screen.backup.run')).toEqual(['screen.backup.run'])
  })
})
