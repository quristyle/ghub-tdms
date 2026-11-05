/**
 * MDB "자료 1건" 규칙과 원본·사본(DWG·PDF) 폴더 규칙 — DB 를 건드리지 않는 순수 함수만 둔다.
 *
 * 기존 mdb_group.py · utils.py · mdb_types.py · mdb_utils.py 의 규칙을 그대로 옮겼다.
 *   · 자료 1건 = 같은 폴더 + 같은 자료명(확장자만 뗀 이름, **대소문자까지 정확히**)
 *   · 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 **둘 다** 있을 때만 그 둘을 짝 폴더로 본다
 *   · 설비유형·자료유형은 "Pump/Strainer" 처럼 슬래시로 이어 붙인 문자열 하나로 저장한다
 */

export const SEPARATOR = '/'
export const DWG_FOLDER = 'DWG'
export const PDF_FOLDER = 'PDF'

export function isPairingName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'dwg' || n === 'pdf'
}

/** 파일명 → 확장자 (소문자, 점 없이). 없으면 '' */
export function fileExtOf(filename: string): string {
  const base = filename.split('/').pop() ?? filename
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/**
 * 파일명에서 실제 확장자만 정확히 떼어낸 자료명.
 * 마지막 점 뒤를 무조건 떼면 "10. Inspection & Test Procedure" 같은 이름이 잘린다.
 */
export function docName(filename: string, ext: string): string {
  const suffix = ext ? `.${ext}`.toLowerCase() : ''
  return suffix && filename.toLowerCase().endsWith(suffix) ? filename.slice(0, -suffix.length) : filename
}

/**
 * 폴더 경로("/" 구분) 목록에서 짝 폴더로 볼 자리만 고른다.
 * 상위/DWG + 상위/PDF 가 둘 다 있을 때만 짝이다. 한쪽만 있으면 보통 폴더.
 */
export function pairingFolderPaths(folders: Iterable<string>): Set<string> {
  const list = [...folders].filter(Boolean)
  const byParent = new Map<string, Set<string>>()
  for (const f of list) {
    const parts = f.split('/')
    const last = parts.at(-1)!
    if (!isPairingName(last)) continue
    const parent = parts.slice(0, -1).join('/')
    if (!byParent.has(parent)) byParent.set(parent, new Set())
    byParent.get(parent)!.add(last.toLowerCase())
  }
  const out = new Set<string>()
  for (const f of list) {
    const parts = f.split('/')
    if (!isPairingName(parts.at(-1)!)) continue
    if ((byParent.get(parts.slice(0, -1).join('/'))?.size ?? 0) === 2) out.add(f)
  }
  return out
}

/** 경로를 (상위 경로, 짝 폴더 이름) 으로 나눈다. 짝 폴더가 아니면 그대로. */
export function splitPairingFolder(folder: string, pairPaths: Set<string>): [string, string | null] {
  if (!folder || !pairPaths.has(folder)) return [folder, null]
  const parts = folder.split('/')
  return [parts.slice(0, -1).join('/'), parts.at(-1)!]
}

/**
 * 이미 있는 자료에 새 형식을 붙일 때 그 파일이 들어갈 DWG/PDF 폴더 이름.
 *   · 같은 확장자가 쓰던 폴더가 있으면 그대로
 *   · 이 자료가 짝 폴더를 아예 안 쓰면 null
 *   · 쓰는데 처음 보는 형식이면 PDF 는 PDF, 나머지는 DWG
 */
export function pairingFolderForExt(
  existing: { fileExt: string; pairingFolder: string | null }[], ext: string,
): string | null {
  for (const e of existing) if (e.fileExt === ext && e.pairingFolder) return e.pairingFolder
  if (!existing.some((e) => e.pairingFolder)) return null
  return ext === 'pdf' ? PDF_FOLDER : DWG_FOLDER
}

// ── 업로드 묶기 ─────────────────────────────────────────────────────────

export interface UploadEntry<T> {
  /** 대상 폴더 기준 상대 경로 ("/" 구분, 짝 폴더 조각은 뗀 것). 최상위면 '' */
  folder: string
  pairing: string | null
  filename: string
  ext: string
  data: T
}

/** (폴더, 자료명) 별로 모은다. 열쇠는 "폴더\u0000자료명". */
export function bucketUploads<T>(entries: UploadEntry<T>[]): Map<string, UploadEntry<T>[]> {
  const out = new Map<string, UploadEntry<T>[]>()
  for (const e of entries) {
    const key = `${e.folder}\u0000${docName(e.filename, e.ext)}`
    if (!out.has(key)) out.set(key, [])
    out.get(key)!.push(e)
  }
  return out
}

export function splitBucketKey(key: string): { folder: string; name: string } {
  const i = key.indexOf('\u0000')
  return { folder: key.slice(0, i), name: key.slice(i + 1) }
}

/** 자료 하나에 같은 형식이 2개 이상인 것 — CM 확인이 먼저 필요하다 */
export function duplicateGroups<T>(buckets: Map<string, UploadEntry<T>[]>) {
  const found: { folder: string; stem: string; exts: string[] }[] = []
  for (const [key, items] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const count = new Map<string, number>()
    for (const it of items) count.set(it.ext, (count.get(it.ext) ?? 0) + 1)
    const dup = [...count.entries()].filter(([, n]) => n > 1).map(([e]) => e).sort()
    if (dup.length) {
      const { folder, name } = splitBucketKey(key)
      found.push({ folder, stem: name, exts: dup })
    }
  }
  return found
}

// ── 경로 검사 (Zip) ─────────────────────────────────────────────────────

/** 저장할 필요가 없는 운영체제 찌꺼기 */
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i

/** 실행 파일 등 받지 않는 형식 */
export const BLOCKED_EXT = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'dll', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'hta', 'sh', 'lnk', 'reg', 'jar',
])

/**
 * Zip 안 경로를 검사해 ("/" 구분 폴더 조각들, 파일명) 으로 돌려준다.
 * 절대경로 · 드라이브 문자 · '..' · 제어문자 → 거부(throw). 찌꺼기·폴더 항목 → null.
 */
export function safeZipPath(raw: string): { dirs: string[]; filename: string } | null {
  const p = raw.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`절대 경로가 들어 있습니다: ${raw}`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) throw new Error(`이름에 쓸 수 없는 문자가 있습니다: ${raw}`)
  if (p.endsWith('/')) return null
  if (JUNK.test(p)) return null
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.some((s) => s === '..')) throw new Error(`상위 폴더(..) 경로가 들어 있습니다: ${raw}`)
  if (!parts.length) return null
  for (const s of parts) {
    if (s.length > 255) throw new Error(`이름이 너무 깁니다: ${raw}`)
  }
  const filename = parts.pop()!
  if (filename.startsWith('~$')) return null // 오피스 잠금 파일
  return { dirs: parts.map((s) => s.trim()).filter(Boolean), filename }
}

// ── 공사 · 연도 (최상위 폴더) ──────────────────────────────────────────

/** 최상위 폴더명이 "{연도}. {월}. - {공사명}" 형식이면 앞의 연도 */
export function yearFromTopFolder(name: string): number | null {
  const m = /^(\d{4})\./.exec(name.trim())
  if (!m) return null
  const y = Number(m[1])
  return y >= 1900 && y <= 2200 ? y : null
}

// ── 설비유형·자료유형 (슬래시로 이은 여러 값) ───────────────────────────

export function splitTypes(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(SEPARATOR).map((s) => s.trim()).filter(Boolean)
}

/** 대소문자만 다른 중복은 하나만. sort=true 면 알파벳순(자료유형). 비면 null. */
export function joinTypes(values: Iterable<string>, sort = false): string | null {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    const n = (v ?? '').trim()
    if (!n || seen.has(n.toUpperCase())) continue
    seen.add(n.toUpperCase())
    out.push(n)
  }
  if (sort) out.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()))
  return out.join(SEPARATOR) || null
}

export function normalizeTypes(value: string | null | undefined, sort = false): string | null {
  return joinTypes(splitTypes(value), sort)
}

/** 목록에서 이름을 바꿨을 때 저장값 안의 그 조각만 갈아끼운다 */
export function renameType(
  value: string | null, oldName: string, newName: string, sort = false,
): { value: string | null; changed: boolean } {
  let changed = false
  const parts = splitTypes(value).map((t) => {
    if (t.toUpperCase() === oldName.toUpperCase()) { changed = true; return newName }
    return t
  })
  return changed ? { value: joinTypes(parts, sort), changed } : { value, changed }
}
