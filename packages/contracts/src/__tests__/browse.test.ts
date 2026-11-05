import { describe, expect, it } from 'vitest'
import {
  AuditQuery, FavoriteSaveRequest, FavoriteTargetQuery, MdbIdsByFolderQuery, MdbNavQuery,
} from '../index.js'

describe('AuditQuery — 화면·동작 여러 개 고르기', () => {
  it('하나만 오면 배열로 맞춘다', () => {
    expect(AuditQuery.parse({ screen: 'MDB 조회' }).screen).toEqual(['MDB 조회'])
  })
  it('같은 이름 여러 개(?screen=a&screen=b)는 그대로 배열', () => {
    expect(AuditQuery.parse({ action: ['열람', '다운로드'] }).action).toEqual(['열람', '다운로드'])
  })
  it('비어 있으면 거르지 않는다', () => {
    expect(AuditQuery.parse({ screen: '' }).screen).toBeUndefined()
    expect(AuditQuery.parse({}).action).toBeUndefined()
  })
})

describe('MDB 넘겨보기·폴더 다운', () => {
  it('넘겨보기는 목록 조건을 그대로 받고 id·pos 를 더한다', () => {
    const q = MdbNavQuery.parse({ id: '12', recursive: 'false', sort: 'title', dir: 'asc' })
    expect(q).toMatchObject({ id: 12, recursive: false, sort: 'title', dir: 'asc' })
    expect(MdbNavQuery.parse({ pos: '3' }).pos).toBe(3)
  })
  it('폴더 다운은 기본으로 하위폴더까지', () => {
    expect(MdbIdsByFolderQuery.parse({ folderId: '5' })).toEqual({ folderId: 5, recursive: true })
    expect(MdbIdsByFolderQuery.parse({ folderId: '5', recursive: 'false' }).recursive).toBe(false)
  })
})

describe('사용자 보관', () => {
  it('보관 요청의 빈 값은 기본값으로 채운다', () => {
    const b = FavoriteSaveRequest.parse({ docClass: 'MDB', mdbFileId: 3, name: ' 자료 ' })
    expect(b).toMatchObject({ name: '자료', markup: [], originalMarkup: [], overwriteId: null, viewMode: null })
  })
  it('뷰어의 자료 찾기는 PDF·원본 번호 어느 쪽으로도 묻는다', () => {
    expect(FavoriteTargetQuery.parse({ kind: 'TDB', original_file_id: '9' }).original_file_id).toBe(9)
    expect(() => FavoriteTargetQuery.parse({ kind: 'XYZ', pdf_file_id: '1' })).toThrow()
  })
})
