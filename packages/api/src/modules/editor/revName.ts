/**
 * TDB 자료명·파일명 끝의 리비전 꼬리(`_Rev00`) 규칙 — 기존 rev_naming.py 를 옮긴 것.
 *
 *   도면번호(DB drawing_no)  TT01-10-65-057          ← 꼬리는 여기 넣지 않는다
 *   파일 이름                TT01-10-65-057_Rev00.dwg
 *
 * 관리 화면(자료 교체·신규 등록·Zip 등록)에서 CM 이 올리는 파일은 꼬리가 없어도 된다 —
 * 시스템이 붙인다. 꼬리를 붙였다면 정확한 형식(`_Rev` + 두 자리 이상 숫자)에
 * 그 작업의 Rev 번호여야 한다. P&ID·PFD 폴더 하위는 이 규칙 밖이다(파일 이름 그대로).
 */

const EXCLUDED_FOLDER_MARKERS = ['(P&ID)', '(PFD)']

const STRICT_TAIL_RE = /^(.+)_Rev([0-9]+)$/
const LOOSE_TAIL_RE = /[\s_\-.(]+(?:revision|rev|r)[\s_\-.]*([0-9]{1,3})(?![0-9]).{0,12}$/i
const REMAINDER_TAIL_RE = /^[\s_\-.(]*(?:revision|rev|r)[\s_\-.]*[0-9]{1,3}(?![0-9]).{0,12}$/i

const TAIL_RULE_TEXT = "'_Rev' + 두 자리 숫자, 뒤에 아무것도 붙이지 않음"

/** 이 경로(사람이 읽는 폴더 경로)의 자료에 꼬리 규칙을 적용하는지. P&ID·PFD 하위면 false. */
export function appliesTo(folderPath: string | null): boolean {
  const upper = (folderPath ?? '').toUpperCase()
  return !EXCLUDED_FOLDER_MARKERS.some((m) => upper.includes(m))
}

export function revSuffix(rev: number, branch: string | null = null): string {
  return `_Rev${String(rev).padStart(2, '0')}${branch ?? ''}`
}

/** 정상 형식(`이름_Rev01`)이면 [이름, 번호]. `_Rev1`·`_Rev001` 처럼 자리 수가 다르면 null. */
export function parseRevName(stem: string): [string, number] | null {
  const m = STRICT_TAIL_RE.exec(stem)
  if (!m) return null
  const num = Number(m[2])
  if (m[2] !== String(num).padStart(2, '0')) return null
  return [m[1]!, num]
}

export function hasRevTail(name: string): boolean {
  return parseRevName(name) !== null || LOOSE_TAIL_RE.test(name)
}

/** 리비전 표기로 보이는 꼬리를 뗀 이름(형식이 틀렸어도). 꼬리가 없으면 null. */
export function guessBase(stem: string): string | null {
  const parsed = parseRevName(stem)
  if (parsed) return parsed[0]
  const m = LOOSE_TAIL_RE.exec(stem)
  if (m && m.index > 0) return stem.slice(0, m.index)
  return null
}

/** 올린 파일 이름에서 정상 꼬리를 뗀 이름 — 어느 자료 것인지 찾을 때 쓴다 */
export function uploadBaseName(stem: string): string {
  return parseRevName(stem)?.[0] ?? stem
}

/** 파일명 → [확장자 뗀 이름, 소문자 확장자] */
export function splitName(filename: string): [string, string] {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return [base, '']
  return [base.slice(0, dot), base.slice(dot + 1).toLowerCase()]
}

type Verdict = 'OK' | 'MISSING' | 'MALFORMED' | 'MISMATCH' | 'OTHER'

function checkIncomingName(stem: string, drawingNo: string, expectedRev: number): Verdict {
  const baseLower = drawingNo.toLowerCase()
  if (stem.toLowerCase() === baseLower) return 'MISSING'
  const parsed = parseRevName(stem)
  if (parsed && parsed[0].toLowerCase() === baseLower) {
    return parsed[1] === expectedRev ? 'OK' : 'MISMATCH'
  }
  if (stem.toLowerCase().startsWith(baseLower) && REMAINDER_TAIL_RE.test(stem.slice(baseLower.length))) {
    return 'MALFORMED'
  }
  return 'OTHER'
}

/** 이 자료(drawingNo)에 올린 파일 이름의 꼬리가 잘못됐으면 그 설명, 괜찮으면 null (자료 교체) */
export function uploadTailProblem(
  stem: string, drawingNo: string, folderPath: string | null, targetRev: number,
): string | null {
  if (!appliesTo(folderPath)) return null
  const verdict = checkIncomingName(stem, drawingNo, targetRev)
  const expected = `${drawingNo}${revSuffix(targetRev)}`
  if (verdict === 'MALFORMED') {
    return `'${stem}' — 리비전 표기 형식이 다릅니다(${TAIL_RULE_TEXT}). `
      + `'${expected}'로 고치거나 표기 없이 '${drawingNo}'로 올려 주세요.`
  }
  if (verdict === 'MISMATCH') {
    return `'${stem}' — 리비전 번호가 다릅니다. 이 작업은 Rev${String(targetRev).padStart(2, '0')}이므로 `
      + `'${expected}'로 고치거나 표기 없이 '${drawingNo}'로 올려 주세요.`
  }
  return null
}

/** 사람이 새로 적는 자료명(자료명 변경)에 리비전 표기가 붙어 있으면 그 설명 — 꼬리는 시스템이 붙인다 */
export function newNameTailProblem(name: string, folderPath: string | null): string | null {
  if (!appliesTo(folderPath) || !hasRevTail(name)) return null
  const base = guessBase(name) ?? name
  return "자료명 끝에 리비전 표기를 적지 않습니다 — 시스템이 '_Rev00'처럼 자동으로 붙입니다. "
    + `'${base}'처럼 표기 없이 적어 주세요.`
}

/** 새 자료를 만들 파일(신규 등록·Zip 등록)의 [자료명, 문제 설명] */
export function newUploadName(
  stem: string, folderPath: string | null, targetRev: number,
): [string, string | null] {
  if (!appliesTo(folderPath)) return [stem, null]
  const parsed = parseRevName(stem)
  if (parsed) {
    const [base, num] = parsed
    if (num !== targetRev) {
      return [base, `'${stem}' — 리비전 번호가 다릅니다. 이번 등록은 Rev${String(targetRev).padStart(2, '0')}이므로 `
        + `'${base}${revSuffix(targetRev)}'로 고치거나 표기 없이 '${base}'로 올려 주세요.`]
    }
    return [base, null]
  }
  if (hasRevTail(stem)) {
    const base = guessBase(stem) ?? stem
    return [stem, `'${stem}' — 리비전 표기 형식이 다릅니다(${TAIL_RULE_TEXT}). `
      + `'${base}${revSuffix(targetRev)}'로 고치거나 표기 없이 '${base}'로 올려 주세요.`]
  }
  return [stem, null]
}

/** 신규 등록·Zip 등록에서 파일 이름으로 정하는 자료명 — 정상 꼬리는 뗀다 */
export function registrationName(stem: string, folderPath: string | null): string {
  return appliesTo(folderPath) ? uploadBaseName(stem) : stem
}

/** 같은 확장자가 2개 이상인 것 (정상은 이름당 원본 1개 + PDF 1개) */
export function duplicateExts(exts: string[]): string[] {
  const n = new Map<string, number>()
  for (const e of exts) n.set(e, (n.get(e) ?? 0) + 1)
  return [...n].filter(([, c]) => c > 1).map(([e]) => e).sort()
}

/** 저장할 때 붙이는 사람이 읽는 파일 이름 (imports/service.ts 와 같은 규칙) */
export function displayName(drawingNo: string, rev: number, ext: string, folderPath: string | null): string {
  return appliesTo(folderPath) ? `${drawingNo}${revSuffix(rev)}.${ext}` : `${drawingNo}.${ext}`
}
