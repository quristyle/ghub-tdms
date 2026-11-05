import { describe, expect, it } from 'vitest'
import {
  bucketUploads, docName, duplicateGroups, fileExtOf, normalizeTypes, pairingFolderForExt,
  pairingFolderPaths, renameType, safeZipPath, splitPairingFolder, yearFromTopFolder,
} from './grouping.js'

describe('자료명', () => {
  it('실제 확장자만 뗀다 — 이름 안의 점은 남긴다', () => {
    expect(docName('10. Inspection & Test Procedure', '')).toBe('10. Inspection & Test Procedure')
    expect(docName('NF410-04.xlsx', 'xlsx')).toBe('NF410-04')
    expect(docName('A.PDF', 'pdf')).toBe('A')
    expect(fileExtOf('dir/A.B.Pdf')).toBe('pdf')
    expect(fileExtOf('README')).toBe('')
  })
})

describe('짝 폴더', () => {
  it('DWG·PDF 가 둘 다 있을 때만 짝이다', () => {
    const p = pairingFolderPaths(['a/DWG', 'a/PDF', 'b/DWG', 'c/x/pdf', 'c/dwg'])
    expect([...p].sort()).toEqual(['a/DWG', 'a/PDF'])
    expect(splitPairingFolder('a/DWG', p)).toEqual(['a', 'DWG'])
    expect(splitPairingFolder('b/DWG', p)).toEqual(['b/DWG', null])
  })

  it('최상위의 DWG·PDF 도 짝이다', () => {
    const p = pairingFolderPaths(['DWG', 'PDF'])
    expect(splitPairingFolder('PDF', p)).toEqual(['', 'PDF'])
  })

  it('기존 자료에 붙일 때 폴더를 정한다', () => {
    expect(pairingFolderForExt([{ fileExt: 'xlsx', pairingFolder: null }], 'pdf')).toBeNull()
    expect(pairingFolderForExt([{ fileExt: 'dwg', pairingFolder: 'dwg' }], 'pdf')).toBe('PDF')
    expect(pairingFolderForExt([{ fileExt: 'pdf', pairingFolder: 'Pdf' }], 'pdf')).toBe('Pdf')
  })
})

describe('묶기', () => {
  it('같은 폴더·같은 이름은 한 자료, 같은 형식 2개는 확인 대상', () => {
    const e = (folder: string, filename: string) =>
      ({ folder, pairing: null, filename, ext: fileExtOf(filename), data: null })
    const b = bucketUploads([e('x', 'A.xls'), e('x', 'A.pdf'), e('x', 'a.pdf'), e('y', 'A.pdf')])
    expect(b.size).toBe(3)
    expect(duplicateGroups(b)).toEqual([])
    const d = duplicateGroups(bucketUploads([e('x', 'A.pdf'), e('x', 'A.PDF')]))
    expect(d).toEqual([{ folder: 'x', stem: 'A', exts: ['pdf'] }])
  })
})

describe('Zip 경로 검사', () => {
  it('경로 탈출을 거부한다', () => {
    expect(() => safeZipPath('../etc/passwd')).toThrow()
    expect(() => safeZipPath('a/../../b.pdf')).toThrow()
    expect(() => safeZipPath('/abs/b.pdf')).toThrow()
    expect(() => safeZipPath('C:\\win\\b.pdf')).toThrow()
    expect(() => safeZipPath('a/b\u0001.pdf')).toThrow()
  })

  it('찌꺼기와 폴더 항목은 건너뛴다', () => {
    expect(safeZipPath('a/b/')).toBeNull()
    expect(safeZipPath('__MACOSX/a/._b.pdf')).toBeNull()
    expect(safeZipPath('a/Thumbs.db')).toBeNull()
    expect(safeZipPath('a/~$x.xlsx')).toBeNull()
    expect(safeZipPath('a\\b\\c.pdf')).toEqual({ dirs: ['a', 'b'], filename: 'c.pdf' })
    expect(safeZipPath('./a/c.pdf')).toEqual({ dirs: ['a'], filename: 'c.pdf' })
  })
})

describe('유형 값', () => {
  it('정리 · 이름 변경', () => {
    expect(normalizeTypes(' Pump / pump /Strainer ')).toBe('Pump/Strainer')
    expect(normalizeTypes('Schedule/List', true)).toBe('List/Schedule')
    expect(normalizeTypes('  ')).toBeNull()
    expect(renameType('Pump/Strainer', 'pump', '펌프')).toEqual({ value: '펌프/Strainer', changed: true })
    expect(renameType('Pumpkin', 'Pump', 'X')).toEqual({ value: 'Pumpkin', changed: false })
    expect(renameType('Schedule/List', 'List', 'Zeta', true)).toEqual({ value: 'Schedule/Zeta', changed: true })
  })

  it('최상위 폴더 연도', () => {
    expect(yearFromTopFolder('2016. 03. - 배관확장')).toBe(2016)
    expect(yearFromTopFolder('7. DATA BOOK')).toBeNull()
  })
})
