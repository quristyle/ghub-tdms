/**
 * 반입 진단 — 업체가 돌려보낸 파일을 '반출된 자료 목록'과 대조한다.
 *
 * 기존 시스템 imports.py 의 run_import_engine · build_issue_detail · diagnose_issue 와
 * rev_naming.py · utils.py(짝 폴더) 를 그대로 옮긴 순수 함수다. DB·파일을 만지지 않으므로
 * 전수 테스트 대상이다(__tests__/importMatch.test.ts). API 는 이 결정을 트랜잭션에 묶기만 한다.
 *
 * 기존과 다른 점 하나:
 *   기존은 P&ID·PFD 폴더(`(P&ID)`·`(PFD)` 표시) 하위에 리비전 꼬리를 붙이지 않았다.
 *   새 시스템은 모든 TDB 파일 이름에 꼬리를 붙여 반출한다(files.display_name — 반출 Zip 이
 *   이 이름 그대로 나간다). 업체는 받은 이름에 Rev 만 올려 돌려보내므로 꼬리 규칙을
 *   예외 없이 적용해야 정상 반입이 '자료명 불일치'로 빠지지 않는다.
 */

// ── 사유 코드 ───────────────────────────────────────────────────────────

export const IMPORT_REASONS = [
  'FILENAME_MISMATCH',
  'PATH_MISMATCH',
  'ORIGINAL_MISSING',
  'PDF_MISSING',
  'ALREADY_IMPORTED',
  'NOT_DISTRIBUTED',
  'DUPLICATE_FILE',
  'REV_MISMATCH',
  'REV_TAG_MISSING',
  'REV_TAG_MALFORMED',
  'REGISTER_FAILED',
] as const
export type ImportReason = (typeof IMPORT_REASONS)[number]

/** 확인 필요 사유 코드 → 한글 라벨 */
export const REASON_LABELS: Record<ImportReason, string> = {
  FILENAME_MISMATCH: '자료명 불일치',
  PATH_MISMATCH: '경로 불일치',
  ORIGINAL_MISSING: '원본 누락',
  PDF_MISSING: '사본 누락',
  ALREADY_IMPORTED: '기 반입 완료',
  NOT_DISTRIBUTED: '반출 대상 아님',
  DUPLICATE_FILE: '같은 형식 파일 중복',
  REV_MISMATCH: '표기 불일치',
  REV_TAG_MISSING: '리비전 표기 없음',
  REV_TAG_MALFORMED: '리비전 표기 형식 오류',
  // 새 시스템에서 생긴 사유 — 진단은 통과했는데 등록 중 막힌 경우(파일을 잃지 않게 확인 필요로 보낸다)
  REGISTER_FAILED: '등록 실패',
}

/** 사유별 기본 설명 — 상세 데이터가 없는 항목이라도 [사유상세]가 빈 창으로 뜨지 않게 한다. */
export const GENERIC_REASON_TEXT: Record<ImportReason, string> = {
  FILENAME_MISMATCH: '반출 자료명과 반입 자료명이 서로 다릅니다.',
  PATH_MISMATCH: '반출 경로와 반입 경로가 서로 다릅니다.',
  ORIGINAL_MISSING: '반출 때 함께 나갔던 원본이 이번 반입에 빠져 있습니다.',
  PDF_MISSING: '반출 때 함께 나갔던 PDF(사본)가 이번 반입에 빠져 있습니다.',
  ALREADY_IMPORTED: '이미 반입이 완료된 도면입니다.',
  NOT_DISTRIBUTED: '반출 목록에 자료명이 일치하는 자료가 없습니다.',
  DUPLICATE_FILE: '같은 형식(원본 또는 PDF)의 파일이 2개 이상 섞여 있어 어느 것이 맞는 파일인지 확인이 필요합니다.',
  REV_MISMATCH: '업체가 표기한 리비전 번호가 시스템이 매길 번호와 다릅니다. 실수인지 확인이 필요합니다.',
  REV_TAG_MISSING: '반입 파일 이름에 리비전 표기(_Rev01 등)가 없습니다. 수정한 자료인지 확인이 필요합니다.',
  REV_TAG_MALFORMED: '반입 파일 이름의 리비전 표기 형식이 규칙(_Rev + 두 자리 숫자)과 다릅니다. 확인이 필요합니다.',
  REGISTER_FAILED: '진단은 통과했지만 검수 대기로 등록하지 못했습니다. [재검수]로 다시 시도하세요.',
}

export function reasonLabel(code: string): string {
  return (REASON_LABELS as Record<string, string>)[code] ?? code
}

export function reasonText(reasons: readonly string[]): string {
  return reasons.map(reasonLabel).join(', ')
}

export function fallbackDetailText(reasons: readonly string[], drawingNo: string): string {
  const body = reasons
    .map((r) => (GENERIC_REASON_TEXT as Record<string, string>)[r] ?? reasonLabel(r))
    .join(' ')
  return body ? `'${drawingNo}' — ${body}` : '추가 설명이 없습니다.'
}

// ── 파일 이름 ───────────────────────────────────────────────────────────

/** 경로 끝 이름 (Python PurePath.name) */
export function baseName(path: string): string {
  const p = path.replace(/\\/g, '/')
  return p.slice(p.lastIndexOf('/') + 1)
}

/** 확장자를 뗀 이름 (Python Path.stem — '.bashrc'·'a.' 는 그대로) */
export function fileStem(filename: string): string {
  const name = baseName(filename)
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name
}

/** 소문자 확장자, 점 없이 (없으면 '') */
export function fileExtOf(filename: string): string {
  const name = baseName(filename)
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''
}

// ── 리비전 꼬리 (`_Rev00`) — 기존 rev_naming.py ─────────────────────────

/** 꼬리 형식 안내 — 상세 설명 문장에 쓴다 */
export const TAIL_RULE_TEXT = "'_Rev' + 두 자리 숫자, 뒤에 아무것도 붙이지 않음"

// 정상 형식 — 이름 끝이 정확히 `_Rev` + 숫자. 자리 수가 맞는지는 parseRevName 이 따로 본다.
const STRICT_TAIL_RE = /^(.+)_Rev([0-9]+)$/
// 리비전 표기로 보이는 꼬리(형식이 틀린 것까지). 앞이 구분자여야 하므로 `11022pdr01` 처럼
// 도면번호 일부인 것은 잡지 않는다.
const LOOSE_TAIL_RE = /[\s_\-.(]+(?:revision|rev|r)[\s_\-.]*([0-9]{1,3})(?![0-9]).{0,12}$/i
// 도면번호를 이미 알 때, 도면번호 뒤에 남은 부분이 리비전 표기(변형 포함)인지.
const REMAINDER_TAIL_RE = /^[\s_\-.(]*(?:revision|rev|r)[\s_\-.]*[0-9]{1,3}(?![0-9]).{0,12}$/i

/** `Rev00`, `Rev02a` — 두 자리에 못 미치면 앞에 0을 채운다 */
export function revText(rev: number, branch: string | null = null): string {
  return `Rev${String(rev).padStart(2, '0')}${branch ?? ''}`
}

/** 화면 자료명·파일 이름(확장자 앞) — `도면번호_Rev01` */
export function revName(drawingNo: string, rev: number, branch: string | null = null): string {
  return `${drawingNo}_${revText(rev, branch)}`
}

/** 정상 형식(`이름_Rev01`)이면 {base, num}. `_Rev1`·`_Rev001` 처럼 자리 수가 다르면 null. */
export function parseRevName(stem: string): { base: string; num: number } | null {
  const m = STRICT_TAIL_RE.exec(stem ?? '')
  if (!m) return null
  const num = Number(m[2])
  if (m[2] !== String(num).padStart(2, '0')) return null
  return { base: m[1]!, num }
}

/** 이름 끝에 리비전 표기(정상이든 변형이든)가 붙어 있는지 */
export function hasRevTail(name: string): boolean {
  return parseRevName(name) !== null || LOOSE_TAIL_RE.test(name ?? '')
}

/** 리비전 표기로 보이는 꼬리를 뗀 이름(형식이 틀렸어도). 꼬리가 없으면 null. */
export function guessBase(stem: string): string | null {
  const parsed = parseRevName(stem)
  if (parsed) return parsed.base
  const m = LOOSE_TAIL_RE.exec(stem ?? '')
  if (m && m.index > 0) return stem.slice(0, m.index)
  return null
}

/** 올린 파일 이름에서 정상 꼬리를 뗀 이름 */
export function uploadBaseName(stem: string): string {
  return parseRevName(stem ?? '')?.base ?? (stem ?? '')
}

export type NameVerdict = 'OK' | 'MISSING' | 'MALFORMED' | 'MISMATCH' | 'OTHER'

/**
 * 반입 파일 이름(확장자 뗀 것)을 그 자료의 도면번호·기대 Rev 와 견준다.
 * 도면번호 부분은 대소문자를 가리지 않고, 꼬리(`_Rev`)만 대소문자까지 정확히 본다.
 */
export function checkIncomingName(
  stem: string, drawingNo: string, expectedRev: number,
): { verdict: NameVerdict; number: number | null } {
  const s = stem ?? ''
  const base = (drawingNo ?? '').toLowerCase()
  if (s.toLowerCase() === base) return { verdict: 'MISSING', number: null }
  const parsed = parseRevName(s)
  if (parsed && parsed.base.toLowerCase() === base) {
    return { verdict: parsed.num === expectedRev ? 'OK' : 'MISMATCH', number: parsed.num }
  }
  // 도면번호 뒤에 남은 것이 리비전 표기 모양일 때만 형식 오류다 — 다른 자료 이름이
  // 우연히 같은 글자로 시작하는 것(`T01-10-50-1_Rev01`)은 다른 자료다.
  if (s.toLowerCase().startsWith(base) && REMAINDER_TAIL_RE.test(s.slice(base.length))) {
    return { verdict: 'MALFORMED', number: null }
  }
  return { verdict: 'OTHER', number: null }
}

/**
 * 사람이 새로 적는 자료명(신규 등록)에 리비전 표기가 붙어 있으면 그 설명.
 * 꼬리는 시스템이 붙이므로 적으면 안 된다(그대로 받으면 `이름_Rev00_Rev00` 이 된다).
 */
export function newNameTailProblem(name: string): string | null {
  if (!hasRevTail(name)) return null
  const base = guessBase(name) ?? name
  return `자료명 끝에 리비전 표기를 적지 않습니다 — 시스템이 '_Rev00'처럼 자동으로 붙입니다. '${base}'처럼 표기 없이 적어 주세요.`
}

/**
 * 반입 파일이 어느 반출 자료 것인지 찾을 때 견줄 이름들(소문자).
 * 이름 그대로 → 정상 꼬리를 뗀 것 → 형식이 틀린 꼬리를 뗀 것 순서다.
 */
export function nameKeys(filename: string): string[] {
  const stem = fileStem(filename)
  const keys: string[] = []
  for (const c of [stem, uploadBaseName(stem), guessBase(stem)]) {
    if (c && !keys.includes(c.toLowerCase())) keys.push(c.toLowerCase())
  }
  return keys
}

/**
 * 반입 파일 이름이 (그 자료 것인지, 리비전 표기 사유 목록)을 돌려준다.
 * 반입 파일은 `도면번호_Rev{반출 Rev + 1}` 이어야 정상이다.
 */
export function revTailReasons(
  filenames: readonly string[], drawingNo: string, expectedRev: number,
): { nameOk: boolean; reasons: ImportReason[] } {
  const verdicts = filenames.map((fn) => checkIncomingName(fileStem(fn), drawingNo, expectedRev).verdict)
  const reasons: ImportReason[] = []
  if (verdicts.includes('MISSING')) reasons.push('REV_TAG_MISSING')
  if (verdicts.includes('MALFORMED')) reasons.push('REV_TAG_MALFORMED')
  if (verdicts.includes('MISMATCH')) reasons.push('REV_MISMATCH')
  return { nameOk: verdicts.every((v) => v !== 'OTHER'), reasons }
}

// ── 폴더 (짝 폴더 DWG·PDF) — 기존 utils.py ──────────────────────────────

const PAIRING_NAMES = ['dwg', 'pdf']

/** 폴더 경로를 비교용으로 (구분자·대소문자 통일) */
export function asFolderKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
}

/**
 * 폴더 목록('/' 구분)에서 짝 폴더로 볼 자리만 고른다 —
 * 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 **둘 다** 있을 때만 짝이다(2026-08-21 CM 확정).
 */
export function pairingFolderPaths(folders: Iterable<string>): Set<string> {
  const list = [...folders].filter(Boolean)
  const byParent = new Map<string, Set<string>>()
  for (const f of list) {
    const parts = f.split('/')
    const last = parts[parts.length - 1]!.toLowerCase()
    if (!PAIRING_NAMES.includes(last)) continue
    const parent = parts.slice(0, -1).join('/')
    if (!byParent.has(parent)) byParent.set(parent, new Set())
    byParent.get(parent)!.add(last)
  }
  const out = new Set<string>()
  for (const f of list) {
    const parts = f.split('/')
    if (!PAIRING_NAMES.includes(parts[parts.length - 1]!.toLowerCase())) continue
    if ((byParent.get(parts.slice(0, -1).join('/'))?.size ?? 0) === PAIRING_NAMES.length) out.add(f)
  }
  return out
}

export function folderPairPaths(paths: Iterable<string | null | undefined>): Set<string> {
  return pairingFolderPaths(new Set([...paths].map((p) => asFolderKey(p ?? ''))))
}

/** Zip 안 폴더와 자료 폴더를 같은 꼴로 맞춘다 — 짝 폴더면 마지막 조각을 벗긴다 */
export function normalizeFolder(path: string, pairPaths: ReadonlySet<string>): string {
  const key = asFolderKey(path)
  if (!key || !pairPaths.has(key)) return key
  return key.split('/').slice(0, -1).join('/')
}

/**
 * Zip 안 경로 한 조각 — 반출 Zip(워커 zipbuild._safe)과 같은 규칙으로 다듬는다.
 * 자료 폴더 이름을 이 규칙으로 바꿔야 Zip 안 폴더와 견줄 수 있다.
 */
export function safeZipSegment(name: string): string {
  const cleaned = name.replace(/[\\/]/g, '_').trim().replace(/^\.+/, '')
  return cleaned || '_'
}

/** 같은 확장자가 2개 이상이면 그 확장자 목록 (정상은 원본 1 + PDF 1) */
export function duplicateExtGroups(items: readonly { ext: string }[]): string[] {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.ext, (counts.get(i.ext) ?? 0) + 1)
  return [...counts.entries()].filter(([, c]) => c > 1).map(([e]) => e).sort()
}

// ── 반출목록.xlsx ───────────────────────────────────────────────────────

/** 기존 반출 Zip 은 "TDB 반출목록_시각.xlsx", 새 반출 Zip 은 "반출목록.xlsx" */
export function isManifestName(path: string): boolean {
  const name = baseName(path)
  return (name.startsWith('TDB 반출목록') || name.startsWith('반출목록')) && name.toLowerCase().endsWith('.xlsx')
}

/**
 * 반출 Zip 을 풀었다가 폴더째 다시 압축하면 폴더가 한 겹 더 씌워진다.
 * 정상 반출 Zip 은 반출목록이 언제나 루트에 있으므로, 폴더 안에 있으면 그 폴더가 겹껍질이다.
 */
export function detectWrapperPrefix(manifestNames: readonly string[]): string {
  if (!manifestNames.length) return ''
  const first = [...manifestNames].sort()[0]!.replace(/\\/g, '/')
  const i = first.lastIndexOf('/')
  return i <= 0 ? '' : first.slice(0, i)
}

/** Zip 안 경로 → (폴더, 파일명). 겹껍질은 벗긴다. */
export function splitZipPath(rawPath: string, wrapper: string): { folder: string; filename: string } {
  let p = rawPath.replace(/\\/g, '/')
  if (wrapper && p.startsWith(`${wrapper}/`)) p = p.slice(wrapper.length + 1)
  const i = p.lastIndexOf('/')
  return i < 0 ? { folder: '', filename: p } : { folder: p.slice(0, i), filename: p.slice(i + 1) }
}

/**
 * 반출목록 표(첫 줄 머리글)에서 (문서ID, 업체) 목록을 뽑는다.
 * 업체를 함께 읽는 이유: 같은 자료가 여러 업체로 동시에 나가 있을 때(중복반출)
 * 이 Zip 이 어느 업체 것인지 정확히 골라야 하기 때문이다.
 */
export function parseManifestRows(
  rows: readonly (readonly unknown[])[],
): { documentId: number; vendorName: string | null }[] {
  const header = rows[0]
  if (!header) return []
  const cols = new Map<string, number>()
  header.forEach((h, i) => {
    if (h !== null && h !== undefined) cols.set(String(h).trim(), i)
  })
  const idIdx = cols.get('문서ID')
  const vendorIdx = cols.get('업체')
  if (idIdx === undefined) return []
  const out: { documentId: number; vendorName: string | null }[] = []
  for (const row of rows.slice(1)) {
    const raw = row[idIdx]
    if (raw === null || raw === undefined || raw === '') continue
    const id = Number(String(raw).trim())
    if (!Number.isInteger(id) || id <= 0) continue
    const v = vendorIdx !== undefined ? row[vendorIdx] : null
    const vendor = v === null || v === undefined ? null : String(v).trim() || null
    out.push({ documentId: id, vendorName: vendor })
  }
  return out
}

// ── 진단 ────────────────────────────────────────────────────────────────

/** 반출된(=이번에 돌아와야 하는) 자료 하나. 반입 진단의 기준. */
export interface ExpectedDrawing {
  documentId: number
  drawingNo: string
  /** 반출 Zip 안 폴더 경로('/' 구분). 경로 없이 반출했으면 '' */
  folderPath: string | null
  distributionId: number | null
  vendorId: number | null
  vendorName: string
  projectId: number | null
  revAtDistribution: number
  currentRev: number
  /** 반출 시점에 그 자료가 갖고 있던 파일 확장자 = '반출자료' */
  distributedExts: readonly string[]
  alreadyReturned: boolean
}

/** 반입 파일 하나 — folder 가 null 이면 폴더 정보가 없는 업로드(반입 자료) */
export interface IncomingEntry {
  folder: string | null
  filename: string
  ext: string
}

export interface DiagnosedSet<T extends IncomingEntry> {
  expected: ExpectedDrawing
  files: T[]
  reasons: ImportReason[]
  importedExts: string[]
  missingExts: string[]
}

export interface StrayGroup<T extends IncomingEntry> {
  stem: string
  files: T[]
}

const isPdf = (ext: string) => ext === 'pdf'

function missingReasons(missing: readonly string[]): ImportReason[] {
  const out: ImportReason[] = []
  if (missing.some(isPdf)) out.push('PDF_MISSING')
  if (missing.some((x) => !isPdf(x))) out.push('ORIGINAL_MISSING')
  return out
}

/**
 * 반입 파일들을 '반출된 자료 목록(expected)'과 대조해 진단한다 (기존 run_import_engine).
 *   · 사유가 없는 세트 → 검수 대기로 올린다
 *   · 사유가 있는 세트 → 확인 필요
 *   · 어느 반출 자료와도 안 맞는 파일 → 이름별로 묶어 '반출 대상 아님'
 */
export function diagnoseImport<T extends IncomingEntry>(
  expected: readonly ExpectedDrawing[],
  incoming: readonly T[],
  matchByPath: boolean,
): { sets: DiagnosedSet<T>[]; strays: StrayGroup<T>[] } {
  // 업체가 보낸 Zip 안에서 DWG 폴더와 PDF 폴더가 나란히 있는 자리만 짝 폴더로 본다
  const pairPaths = folderPairPaths(incoming.map((i) => i.folder))

  const byDrawing = new Map<string, ExpectedDrawing[]>()
  const byFolder = new Map<string, ExpectedDrawing[]>()
  const byFolderDrawing = new Map<string, ExpectedDrawing>()
  const fdKey = (folder: string, name: string) => `${folder}\u0000${name}`

  for (const e of expected) {
    const k = e.drawingNo.toLowerCase()
    if (!byDrawing.has(k)) byDrawing.set(k, [])
    byDrawing.get(k)!.push(e)
    if (matchByPath) {
      const nf = normalizeFolder(e.folderPath ?? '', pairPaths)
      if (!byFolder.has(nf)) byFolder.set(nf, [])
      byFolder.get(nf)!.push(e)
      byFolderDrawing.set(fdKey(nf, k), e)
    }
  }

  const assigned = new Map<number, { exp: ExpectedDrawing; files: T[]; flags: Set<ImportReason> }>()
  const stray: T[] = []

  for (const inc of incoming) {
    const keys = nameKeys(inc.filename)
    let target: ExpectedDrawing | null = null
    let flag: ImportReason | null = null

    if (matchByPath) {
      const nf = normalizeFolder(inc.folder ?? '', pairPaths)
      const folderKey = keys.find((k) => byFolderDrawing.has(fdKey(nf, k)))
      const nameKey = keys.find((k) => byDrawing.has(k))
      if (folderKey !== undefined) {
        target = byFolderDrawing.get(fdKey(nf, folderKey))!
      } else if (nameKey !== undefined) {
        target = byDrawing.get(nameKey)![0]!
        flag = 'PATH_MISMATCH'
      } else if (byFolder.get(nf)?.length === 1) {
        // 폴더는 맞는데 이름이 다름 + 그 폴더에 걸린 반출 자료가 하나뿐 → 그 자료로 본다.
        // 둘 이상이면 어느 것인지 판단할 수 없으므로 배정하지 않는다(2026-08-18 오배정 사고).
        target = byFolder.get(nf)![0]!
        flag = 'FILENAME_MISMATCH'
      }
    } else {
      // 폴더 정보 없음 → 이름으로만
      const nameKey = keys.find((k) => byDrawing.has(k))
      if (nameKey !== undefined) target = byDrawing.get(nameKey)![0]!
    }

    if (!target) {
      stray.push(inc)
      continue
    }
    let slot = assigned.get(target.documentId)
    if (!slot) {
      slot = { exp: target, files: [], flags: new Set() }
      assigned.set(target.documentId, slot)
    }
    slot.files.push(inc)
    if (flag) slot.flags.add(flag)
  }

  const sets: DiagnosedSet<T>[] = []
  for (const { exp: e, files, flags } of assigned.values()) {
    const imported = new Set(files.map((f) => f.ext))
    const reasons: ImportReason[] = []
    if (e.alreadyReturned) reasons.push('ALREADY_IMPORTED')
    if (flags.has('PATH_MISMATCH')) reasons.push('PATH_MISMATCH')

    const tail = revTailReasons(files.map((f) => f.filename), e.drawingNo, e.revAtDistribution + 1)
    if (flags.has('FILENAME_MISMATCH') || !tail.nameOk) reasons.push('FILENAME_MISMATCH')

    const missing = [...new Set(e.distributedExts)].filter((x) => !imported.has(x)).sort()
    reasons.push(...missingReasons(missing))

    // 정상은 원본 1개 + PDF 1개다. 같은 확장자가 둘 이상이면 어느 것이 맞는지 판단할 수 없다.
    if (duplicateExtGroups(files).length) reasons.push('DUPLICATE_FILE')

    // 표기 불일치·꼬리 없음·형식 오류는 확인 필요로 보내 [비교]로 확인한 뒤 [재검수]로
    // 통과시키게 한다(2026-08-18, 2026-10-01 CM). 이름이 아예 다른 자료면 꼬리를 따지는 게 뜻이 없다.
    if (!reasons.includes('FILENAME_MISMATCH')) reasons.push(...tail.reasons)

    sets.push({ expected: e, files, reasons, importedExts: [...imported].sort(), missingExts: missing })
  }

  const strayGroups = new Map<string, T[]>()
  for (const inc of stray) {
    const stem = fileStem(inc.filename)
    if (!strayGroups.has(stem)) strayGroups.set(stem, [])
    strayGroups.get(stem)!.push(inc)
  }
  const strays = [...strayGroups.entries()].map(([stem, files]) => ({ stem, files }))

  return { sets, strays }
}

/** 확인 필요 항목의 상세 데이터 (import_issues.detail) */
export interface IssueDetail {
  text: string
  expectedDrawingNo?: string
  expectedPath?: string | null
  actualPaths?: string[]
  actualStems: string[]
  distributedExts?: string[]
  importedExts: string[]
  missingExts?: string[]
}

/** 확인 필요 항목의 상세 설명 문장 + 구조 데이터 (기존 build_issue_detail) */
export function buildIssueDetail(
  e: ExpectedDrawing, files: readonly IncomingEntry[], reasons: readonly string[],
  importedExts: readonly string[], missing: readonly string[],
): IssueDetail {
  const parts: string[] = []
  const pairPaths = folderPairPaths(files.map((f) => f.folder))
  const actualPaths = [...new Set(
    files.filter((f) => f.folder !== null).map((f) => normalizeFolder(f.folder!, pairPaths)),
  )].sort()
  const actualStems = [...new Set(files.map((f) => fileStem(f.filename)))].sort()
  const where = e.folderPath || '(경로 없음)'

  if (reasons.includes('ALREADY_IMPORTED')) {
    parts.push(`'${e.drawingNo}'은(는) 이미 반입이 완료된 도면입니다.`)
  }
  if (reasons.includes('PATH_MISMATCH')) {
    parts.push(
      `'${e.drawingNo}'의 반출 경로는 '${where}'인데, 반입 경로는 '${actualPaths.join(', ') || '(경로 없음)'}'(으)로 경로가 일치하지 않습니다.`,
    )
  }
  const sentName = revName(e.drawingNo, e.revAtDistribution)
  if (reasons.includes('FILENAME_MISMATCH')) {
    parts.push(
      `'${where}' 경로의 반출 자료명은 '${sentName}'인데, 반입 자료명은 '${actualStems.join(', ')}'(으)로 자료명이 일치하지 않습니다.`,
    )
  }
  if (reasons.includes('ORIGINAL_MISSING')) {
    const miss = missing.filter((x) => !isPdf(x)).sort()
    parts.push(`'${e.drawingNo}'은(는) 반출 때 원본(${miss.join(', ')})이 함께 나갔는데, 이번 반입에는 원본이 빠져 있습니다.`)
  }
  if (reasons.includes('PDF_MISSING')) {
    parts.push(`'${e.drawingNo}'은(는) 반출 때 PDF(사본)가 함께 나갔는데, 이번 반입에는 PDF가 빠져 있습니다.`)
  }
  if (reasons.includes('DUPLICATE_FILE')) {
    parts.push(`같은 형식(${duplicateExtGroups(files).join(', ')})의 파일이 2개 이상 섞여 있습니다.`)
  }
  const tail = revTailDetailText(e.drawingNo, e.revAtDistribution, e.revAtDistribution + 1, actualStems, reasons)
  if (tail) parts.push(tail)

  return {
    text: parts.join(' '),
    expectedDrawingNo: e.drawingNo,
    expectedPath: e.folderPath,
    actualPaths,
    actualStems,
    distributedExts: [...e.distributedExts].sort(),
    importedExts: [...importedExts].sort(),
    missingExts: [...missing].sort(),
  }
}

/** 리비전 표기 사유의 상세 설명 한 문장 (해당 사유가 없으면 null) */
export function revTailDetailText(
  drawingNo: string, sentRev: number, expectedRev: number,
  stems: readonly string[], reasons: readonly string[],
): string | null {
  const PROBLEM: Partial<Record<ImportReason, string>> = {
    REV_TAG_MISSING: '리비전 표기가 없습니다',
    REV_TAG_MALFORMED: `리비전 표기 형식이 다릅니다(${TAIL_RULE_TEXT})`,
    REV_MISMATCH: '리비전 번호가 다릅니다(받아 간 Rev 그대로 돌아왔을 수 있습니다)',
  }
  const tail = (['REV_TAG_MISSING', 'REV_TAG_MALFORMED', 'REV_MISMATCH'] as const).filter((r) => reasons.includes(r))
  if (!tail.length) return null
  const sent = revName(drawingNo, sentRev)
  const expected = revName(drawingNo, expectedRev)
  return (
    `'${sent}'(으)로 반출한 자료라 반입 파일 이름은 '${expected}'이어야 하는데, 받은 파일 이름 ` +
    `'${[...new Set(stems)].sort().join(', ')}'은(는) ${tail.map((r) => PROBLEM[r]).join(' / ')}. ` +
    `[비교]로 수정 내용을 확인한 뒤 문제없으면 [재검수]를 눌러 검수 대기로 등록하세요 — ` +
    `승인되면 파일 이름은 시스템이 '${expected}'(으)로 맞춥니다.`
  )
}

/** '반출 대상 아님' 묶음의 상세 */
export function strayDetail(stem: string, exts: readonly string[]): IssueDetail {
  return {
    text:
      `반출 목록에 '${stem}'와(과) 자료명이 일치하는 자료가 없습니다. ` +
      `수정용으로 반출된 적이 없는 파일이라 어느 도면인지 확인이 필요합니다. ` +
      `[경로 재선택]으로 도면을 지정한 뒤 [재검수]를 눌러주세요.`,
    actualStems: [stem],
    importedExts: [...new Set(exts)].sort(),
  }
}

/**
 * 재검수 — 확인 필요 항목을 지금 상태(재첨부한 파일 / 다시 고른 자료) 그대로 다시 검사한다
 * (기존 diagnose_issue). 사유가 비어 있으면 등록해도 좋다는 뜻이다.
 *
 * 표기 불일치·꼬리 없음·형식 오류·같은 형식 중복은 다시 검사하지 않는다 — CM 이 [비교]로
 * 눈으로 보고 [재검수]를 누르는 행위 자체가 그 판단이다(2026-08-18, 2026-10-01 CM 확정).
 */
export function diagnoseIssue(
  target: { drawingNo: string; folderPath: string | null } | null,
  dist: { revAtDistribution: number; returned: boolean } | null,
  currentRev: number,
  distributedExts: readonly string[],
  files: readonly IncomingEntry[],
): { reasons: ImportReason[]; importedExts: string[]; missingExts: string[] } {
  const imported = [...new Set(files.map((f) => f.ext))].sort()
  if (!target) return { reasons: ['NOT_DISTRIBUTED'], importedExts: imported, missingExts: [] }

  const reasons: ImportReason[] = []
  const expectedRev = (dist ? dist.revAtDistribution : currentRev) + 1
  if (!revTailReasons(files.map((f) => f.filename), target.drawingNo, expectedRev).nameOk) {
    reasons.push('FILENAME_MISMATCH')
  }

  // 폴더 정보가 있는 파일(Zip 으로 들어온 것)만 경로를 확인한다 — 재첨부한 파일은 폴더가 없다
  const pairPaths = folderPairPaths(files.map((f) => f.folder))
  const folders = new Set(files.filter((f) => f.folder !== null).map((f) => normalizeFolder(f.folder!, pairPaths)))
  if (folders.size && !folders.has(normalizeFolder(target.folderPath ?? '', pairPaths))) {
    reasons.push('PATH_MISMATCH')
  }

  if (dist?.returned) reasons.push('ALREADY_IMPORTED')

  const missing = [...new Set(distributedExts)].filter((x) => !imported.includes(x)).sort()
  reasons.push(...missingReasons(missing))
  return { reasons, importedExts: imported, missingExts: missing }
}

/** 반입 실행 결과 한 줄 안내 */
export function importRunMessage(matched: number, issues: number): string {
  if (!matched && !issues) return '처리할 파일이 없습니다.'
  let msg = `${matched}건이 검수 대기에 등록되었습니다.`
  if (issues) msg += ` ${issues}건은 확인이 필요해 '확인 필요' 목록에 표시됩니다.`
  return msg
}
