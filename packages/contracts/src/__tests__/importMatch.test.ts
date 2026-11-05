import { describe, expect, it } from 'vitest'
import {
  buildIssueDetail, checkIncomingName, detectWrapperPrefix, diagnoseImport, diagnoseIssue,
  duplicateExtGroups, type ExpectedDrawing, fileExtOf, fileStem, guessBase, importRunMessage,
  type IncomingEntry, isManifestName, nameKeys, newNameTailProblem, normalizeFolder,
  pairingFolderPaths, parseManifestRows, parseRevName, revTailReasons, safeZipSegment,
  splitZipPath, strayDetail,
} from '../importMatch.js'

const exp = (o: Partial<ExpectedDrawing> & { documentId: number; drawingNo: string }): ExpectedDrawing => ({
  folderPath: '5. DRAWINGS/5.1 PIPING',
  distributionId: o.documentId * 10,
  vendorId: 1,
  vendorName: '대한엔지니어링',
  projectId: null,
  revAtDistribution: 0,
  currentRev: 0,
  distributedExts: ['dwg', 'pdf'],
  alreadyReturned: false,
  ...o,
})
const inc = (filename: string, folder: string | null = '5. DRAWINGS/5.1 PIPING'): IncomingEntry => ({
  folder, filename, ext: fileExtOf(filename),
})

describe('파일 이름', () => {
  it('stem·확장자는 Python Path 와 같다', () => {
    expect(fileStem('a/b/T-1_Rev01.dwg')).toBe('T-1_Rev01')
    expect(fileStem('a.b.pdf')).toBe('a.b')
    expect(fileStem('.bashrc')).toBe('.bashrc')
    expect(fileExtOf('X.PDF')).toBe('pdf')
    expect(fileExtOf('noext')).toBe('')
  })
})

describe('리비전 꼬리 (rev_naming)', () => {
  it('정상 형식은 _Rev + 두 자리 이상, 대소문자까지 정확히', () => {
    expect(parseRevName('T-1_Rev01')).toEqual({ base: 'T-1', num: 1 })
    expect(parseRevName('T-1_Rev100')).toEqual({ base: 'T-1', num: 100 })
    expect(parseRevName('T-1_Rev1')).toBeNull()
    expect(parseRevName('T-1_Rev001')).toBeNull()
    expect(parseRevName('T-1_REV01')).toBeNull()
  })

  it('형식이 틀린 꼬리도 떼어 본다', () => {
    expect(guessBase('T-1_R01')).toBe('T-1')
    expect(guessBase('T-1 rev1(완료)')).toBe('T-1')
    expect(guessBase('T-1')).toBeNull()
    // 도면번호 일부인 것은 꼬리가 아니다
    expect(guessBase('11022pdr01')).toBeNull()
  })

  it('반입 이름 판정', () => {
    expect(checkIncomingName('T-1_Rev01', 'T-1', 1).verdict).toBe('OK')
    expect(checkIncomingName('t-1_Rev01', 'T-1', 1).verdict).toBe('OK')
    expect(checkIncomingName('T-1', 'T-1', 1).verdict).toBe('MISSING')
    expect(checkIncomingName('T-1_Rev00', 'T-1', 1)).toEqual({ verdict: 'MISMATCH', number: 0 })
    expect(checkIncomingName('T-1_REV01', 'T-1', 1).verdict).toBe('MALFORMED')
    expect(checkIncomingName('T-1_Rev1', 'T-1', 1).verdict).toBe('MALFORMED')
    // 같은 글자로 시작하는 다른 자료
    expect(checkIncomingName('T-10_Rev01', 'T-1', 1).verdict).toBe('OTHER')
  })

  it('견줄 이름은 그대로 → 정상 꼬리 뗀 것 → 틀린 꼬리 뗀 것', () => {
    expect(nameKeys('T-1_Rev01.dwg')).toEqual(['t-1_rev01', 't-1'])
    expect(nameKeys('T-1_R01.dwg')).toEqual(['t-1_r01', 't-1'])
    expect(nameKeys('T-1.dwg')).toEqual(['t-1'])
  })

  it('리비전 표기 사유', () => {
    expect(revTailReasons(['T-1_Rev01.dwg', 'T-1_Rev01.pdf'], 'T-1', 1)).toEqual({ nameOk: true, reasons: [] })
    expect(revTailReasons(['T-1.dwg', 'T-1_R1.pdf'], 'T-1', 1))
      .toEqual({ nameOk: true, reasons: ['REV_TAG_MISSING', 'REV_TAG_MALFORMED'] })
    expect(revTailReasons(['T-1_Rev00.dwg'], 'T-1', 1)).toEqual({ nameOk: true, reasons: ['REV_MISMATCH'] })
    expect(revTailReasons(['X-9_Rev01.dwg'], 'T-1', 1).nameOk).toBe(false)
  })

  it('신규 자료명에 꼬리를 적으면 막는다', () => {
    expect(newNameTailProblem('T-1')).toBeNull()
    expect(newNameTailProblem('T-1_Rev00')).toContain("'T-1'")
  })
})

describe('짝 폴더 (DWG·PDF)', () => {
  it('DWG·PDF 가 둘 다 있을 때만 짝이다', () => {
    expect(pairingFolderPaths(['a/dwg', 'a/pdf', 'b/dwg'])).toEqual(new Set(['a/dwg', 'a/pdf']))
    expect(pairingFolderPaths(['a/x/dwg', 'a/pdf'])).toEqual(new Set())
  })

  it('짝 폴더면 마지막 조각을 벗긴다', () => {
    const pair = new Set(['a/dwg', 'a/pdf'])
    expect(normalizeFolder('A\\DWG', pair)).toBe('a')
    expect(normalizeFolder('/b/DWG/', pair)).toBe('b/dwg')
  })

  it('Zip 안 이름 조각은 반출 Zip 과 같은 규칙으로 다듬는다', () => {
    expect(safeZipSegment(' a/b\\c ')).toBe('a_b_c')
    expect(safeZipSegment('..')).toBe('_')
  })
})

describe('Zip 경로', () => {
  it('반출목록 이름', () => {
    expect(isManifestName('반출목록.xlsx')).toBe(true)
    expect(isManifestName('x/TDB 반출목록_20260101.xlsx')).toBe(true)
    expect(isManifestName('목록.xlsx')).toBe(false)
  })

  it('겹껍질 폴더를 찾아 벗긴다', () => {
    expect(detectWrapperPrefix(['반출목록.xlsx'])).toBe('')
    expect(detectWrapperPrefix(['반출_A사/반출목록.xlsx'])).toBe('반출_A사')
    expect(splitZipPath('반출_A사/5. DRAWINGS/T-1.dwg', '반출_A사')).toEqual({ folder: '5. DRAWINGS', filename: 'T-1.dwg' })
    expect(splitZipPath('T-1.dwg', '')).toEqual({ folder: '', filename: 'T-1.dwg' })
  })

  it('반출목록 행 — 문서ID 가 없거나 숫자가 아니면 건너뛴다', () => {
    const rows = [
      ['문서ID', '자료명', '내용', '반출Rev', '폴더', '업체'],
      [2001, 'T-1', '', 'Rev00', 'a', '대한엔지니어링'],
      ['2002', 'T-2', '', 'Rev00', 'a', ' '],
      [null, 'x'],
      ['abc', 'y'],
    ]
    expect(parseManifestRows(rows)).toEqual([
      { documentId: 2001, vendorName: '대한엔지니어링' },
      { documentId: 2002, vendorName: null },
    ])
    expect(parseManifestRows([['자료명'], ['x']])).toEqual([])
  })
})

describe('diagnoseImport — 반입 진단', () => {
  const T1 = exp({ documentId: 1, drawingNo: 'T-1' })
  const T2 = exp({ documentId: 2, drawingNo: 'T-2' })

  it('깨끗한 세트는 사유가 없다', () => {
    const { sets, strays } = diagnoseImport([T1], [inc('T-1_Rev01.dwg'), inc('T-1_Rev01.pdf')], true)
    expect(strays).toEqual([])
    expect(sets).toHaveLength(1)
    expect(sets[0]!.reasons).toEqual([])
    expect(sets[0]!.files).toHaveLength(2)
  })

  it('짝 폴더(DWG·PDF)로 나눠 보내도 한 세트로 본다', () => {
    const { sets } = diagnoseImport([T1], [
      inc('T-1_Rev01.dwg', '5. DRAWINGS/5.1 PIPING/DWG'),
      inc('T-1_Rev01.pdf', '5. DRAWINGS/5.1 PIPING/PDF'),
    ], true)
    expect(sets[0]!.reasons).toEqual([])
  })

  it('이름은 맞는데 폴더가 다르면 경로 불일치', () => {
    const { sets } = diagnoseImport([T1], [inc('T-1_Rev01.dwg', 'x'), inc('T-1_Rev01.pdf', 'x')], true)
    expect(sets[0]!.reasons).toEqual(['PATH_MISMATCH'])
  })

  it('폴더에 반출 자료가 하나뿐이면 이름이 달라도 그 자료로 보고 자료명 불일치', () => {
    const { sets } = diagnoseImport([T1], [inc('엉뚱.dwg'), inc('엉뚱.pdf')], true)
    expect(sets[0]!.expected.documentId).toBe(1)
    // 이름이 다른 자료면 꼬리 사유는 붙이지 않는다
    expect(sets[0]!.reasons).toEqual(['FILENAME_MISMATCH'])
  })

  it('폴더에 반출 자료가 둘 이상이면 이름이 다른 파일은 배정하지 않는다', () => {
    const { sets, strays } = diagnoseImport([T1, T2], [inc('엉뚱.dwg'), inc('엉뚱.pdf')], true)
    expect(sets).toEqual([])
    expect(strays).toEqual([{ stem: '엉뚱', files: [inc('엉뚱.dwg'), inc('엉뚱.pdf')] }])
  })

  it('원본·사본 누락, 같은 형식 중복', () => {
    expect(diagnoseImport([T1], [inc('T-1_Rev01.dwg')], true).sets[0]!.reasons).toEqual(['PDF_MISSING'])
    expect(diagnoseImport([T1], [inc('T-1_Rev01.pdf')], true).sets[0]!.reasons).toEqual(['ORIGINAL_MISSING'])
    const dup = diagnoseImport([T1], [inc('T-1_Rev01.dwg'), inc('T-1_Rev01.pdf'), inc('t-1_Rev01.pdf')], true)
    expect(dup.sets[0]!.reasons).toEqual(['DUPLICATE_FILE'])
  })

  it('반출 Rev 그대로 돌아오면 표기 불일치, 꼬리가 없으면 표기 없음', () => {
    expect(diagnoseImport([T1], [inc('T-1_Rev00.dwg'), inc('T-1_Rev00.pdf')], true).sets[0]!.reasons)
      .toEqual(['REV_MISMATCH'])
    expect(diagnoseImport([T1], [inc('T-1.dwg'), inc('T-1.pdf')], true).sets[0]!.reasons)
      .toEqual(['REV_TAG_MISSING'])
  })

  it('이미 반입된 반출 건이면 기 반입 완료', () => {
    const done = exp({ documentId: 1, drawingNo: 'T-1', alreadyReturned: true })
    expect(diagnoseImport([done], [inc('T-1_Rev01.dwg'), inc('T-1_Rev01.pdf')], true).sets[0]!.reasons)
      .toEqual(['ALREADY_IMPORTED'])
  })

  it('폴더 정보 없이(반입 자료) 이름으로만 배정한다', () => {
    const { sets, strays } = diagnoseImport([T1, T2], [
      inc('T-1_Rev01.dwg', null), inc('T-1_Rev01.pdf', null), inc('Z-9.pdf', null),
    ], false)
    expect(sets).toHaveLength(1)
    expect(sets[0]!.reasons).toEqual([])
    expect(strays.map((s) => s.stem)).toEqual(['Z-9'])
  })

  it('경로를 비우고 반출한 자료는 Zip 루트와 견준다', () => {
    const flat = exp({ documentId: 1, drawingNo: 'T-1', folderPath: '' })
    expect(diagnoseImport([flat], [inc('T-1_Rev01.dwg', ''), inc('T-1_Rev01.pdf', '')], true).sets[0]!.reasons)
      .toEqual([])
  })
})

describe('상세 설명', () => {
  it('사유별 문장을 잇는다', () => {
    const e = exp({ documentId: 1, drawingNo: 'T-1' })
    const files = [inc('T-1_Rev00.dwg', 'x')]
    const d = buildIssueDetail(e, files, ['PATH_MISMATCH', 'PDF_MISSING', 'REV_MISMATCH'], ['dwg'], ['pdf'])
    expect(d.text).toContain("반입 경로는 'x'")
    expect(d.text).toContain('PDF가 빠져 있습니다')
    expect(d.text).toContain("'T-1_Rev01'이어야")
    expect(d.missingExts).toEqual(['pdf'])
  })

  it('반출 대상 아님', () => {
    expect(strayDetail('Z-9', ['pdf', 'dwg', 'pdf']).importedExts).toEqual(['dwg', 'pdf'])
  })

  it('실행 안내', () => {
    expect(importRunMessage(0, 0)).toBe('처리할 파일이 없습니다.')
    expect(importRunMessage(2, 1)).toContain('1건은 확인이 필요해')
  })

  it('같은 형식 중복', () => {
    expect(duplicateExtGroups([{ ext: 'pdf' }, { ext: 'pdf' }, { ext: 'dwg' }])).toEqual(['pdf'])
  })
})

describe('diagnoseIssue — 재검수', () => {
  const target = { drawingNo: 'T-1', folderPath: '5. DRAWINGS/5.1 PIPING' }

  it('대상 자료가 없으면 반출 대상 아님', () => {
    expect(diagnoseIssue(null, null, 0, [], [inc('T-1.pdf')]).reasons).toEqual(['NOT_DISTRIBUTED'])
  })

  it('표기 사유는 다시 보지 않는다 — [재검수]를 누른 것이 확인이다', () => {
    const r = diagnoseIssue(target, { revAtDistribution: 0, returned: false }, 0, ['dwg', 'pdf'],
      [inc('T-1_Rev00.dwg'), inc('T-1_Rev00.pdf')])
    expect(r.reasons).toEqual([])
  })

  it('경로·누락·기 반입은 다시 본다', () => {
    const r = diagnoseIssue(target, { revAtDistribution: 0, returned: true }, 0, ['dwg', 'pdf'],
      [inc('T-1_Rev01.dwg', 'x')])
    expect(r.reasons).toEqual(['PATH_MISMATCH', 'ALREADY_IMPORTED', 'PDF_MISSING'])
  })

  it('재첨부한 파일(폴더 없음)은 경로를 보지 않는다', () => {
    const r = diagnoseIssue(target, { revAtDistribution: 0, returned: false }, 0, ['dwg', 'pdf'],
      [inc('T-1_Rev01.dwg', null), inc('T-1_Rev01.pdf', null)])
    expect(r.reasons).toEqual([])
  })

  it('다른 자료 이름이면 자료명 불일치', () => {
    const r = diagnoseIssue(target, null, 3, [], [inc('X-1.pdf', null)])
    expect(r.reasons).toEqual(['FILENAME_MISMATCH'])
  })
})
