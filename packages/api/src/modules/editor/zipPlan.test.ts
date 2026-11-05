import { describe, expect, it } from 'vitest'
import {
  newUploadName, parseRevName, registrationName, uploadBaseName, uploadTailProblem,
} from './revName.js'
import { planZip, ZipLimitError, type ZipEntryInfo } from './zipPlan.js'

const e = (path: string, size = 100, compressed = 80): ZipEntryInfo =>
  ({ path, uncompressedSize: size, compressedSize: compressed })

describe('리비전 꼬리 규칙 (rev_naming.py)', () => {
  it('정상 꼬리만 읽는다 — 두 자리 숫자', () => {
    expect(parseRevName('A-01_Rev02')).toEqual(['A-01', 2])
    expect(parseRevName('A-01_Rev2')).toBeNull()
    expect(parseRevName('A-01_Rev002')).toBeNull()
    expect(parseRevName('A-01_rev02')).toBeNull()
  })

  it('정상 꼬리는 떼고 묶는다', () => {
    expect(uploadBaseName('A-01_Rev00')).toBe('A-01')
    expect(uploadBaseName('A-01')).toBe('A-01')
  })

  it('P&ID·PFD 폴더는 파일 이름 그대로가 자료명이다', () => {
    expect(registrationName('A-01_Rev00', 'TDB › 공정 (P&ID)')).toBe('A-01_Rev00')
    expect(registrationName('A-01_Rev00', 'TDB › 배관')).toBe('A-01')
  })

  it('신규 등록 — 꼬리 번호가 등록 Rev 와 다르면 문제', () => {
    expect(newUploadName('A-01_Rev01', null, 1)).toEqual(['A-01', null])
    expect(newUploadName('A-01_Rev01', null, 0)[1]).toContain('리비전 번호가 다릅니다')
    expect(newUploadName('A-01_R01', null, 0)[1]).toContain('형식이 다릅니다')
    expect(newUploadName('A-01', null, 3)).toEqual(['A-01', null])
  })

  it('자료 교체 — 꼬리 없거나 맞으면 통과, 형식·번호가 틀리면 문제', () => {
    expect(uploadTailProblem('A-01', 'A-01', null, 2)).toBeNull()
    expect(uploadTailProblem('A-01_Rev02', 'A-01', null, 2)).toBeNull()
    expect(uploadTailProblem('A-01_Rev03', 'A-01', null, 2)).toContain('리비전 번호')
    expect(uploadTailProblem('A-01 rev2', 'A-01', null, 2)).toContain('형식')
  })
})

describe('Zip 폴더 업로드 계획', () => {
  it('폴더 구조를 유지하고 DWG+PDF 를 이름으로 짝짓는다', () => {
    const p = planZip([e('배관/A-01.dwg'), e('배관/A-01.pdf'), e('배관/B-02_Rev00.pdf')], 'TDB', 0)
    expect(p.groups.map((g) => [g.folder.join('/'), g.name, g.files.length])).toEqual([
      ['배관', 'A-01', 2], ['배관', 'B-02', 1],
    ])
    expect(p.partial).toEqual([{ stem: 'B-02', ext: 'pdf', folder: '배관' }])
  })

  it('DWG·PDF 폴더가 나란히 있으면 윗 폴더로 합친다 — 한쪽만 있으면 보통 폴더', () => {
    const p = planZip([e('X/DWG/A.dwg'), e('X/PDF/A.pdf'), e('Y/PDF/B.pdf')], 'TDB', 0)
    expect(p.pairFolders).toEqual(['X/DWG', 'X/PDF'])
    expect(p.groups.map((g) => [g.folder.join('/'), g.name, g.files.length])).toEqual([
      ['X', 'A', 2], ['Y/PDF', 'B', 1],
    ])
  })

  it('".." 조각은 알리고 버린다 — 선택한 폴더 밖으로 나가지 않는다', () => {
    const p = planZip([e('../../etc/A.pdf'), e('/abs/B.pdf'), e('C:\\win\\C.pdf')], 'TDB', 0)
    expect(p.unsafePaths.length).toBe(3)
    for (const g of p.groups) expect(g.folder.every((s) => s !== '..' && s !== '' && !s.includes(':'))).toBe(true)
  })

  it('같은 형식이 2개면 중복으로 빼고, 받지 않는 형식·쓰레기 파일은 건너뛴다', () => {
    const p = planZip([e('A.pdf'), e('A_Rev00.pdf'), e('B.exe'), e('__MACOSX/._A.pdf'), e('Thumbs.db')], 'TDB', 0)
    expect(p.duplicates).toEqual([{ stem: 'A', folder: null, exts: ['pdf'] }])
    expect(p.groups).toEqual([])
    expect(p.ignored).toEqual(['B.exe'])
  })

  it('압축 폭탄을 막는다', () => {
    expect(() => planZip([e('A.pdf', 500 * 1024 * 1024, 1024)], 'TDB', 0)).toThrow(ZipLimitError)
  })

  it('꼬리 검사 — 이미 있는 자료는 그 자료의 Rev 를 기준으로 본다', () => {
    const p = planZip([e('A_Rev03.dwg'), e('A_Rev03.pdf')], 'TDB', 0)
    expect(p.tailCheck(() => null).length).toBe(2)
    expect(p.tailCheck(() => 3)).toEqual([])
  })
})
