import type { DuplicateGroup, PartialItem } from '@tdms/contracts'
import { duplicateExts, newUploadName, registrationName, splitName } from './revName.js'

/**
 * Zip 폴더 업로드의 계획 — 압축을 풀기 전에 목록(central directory)만 보고 세운다.
 *
 * 기존 editor.py zip_register 의 규칙을 그대로 따른다.
 *  · Zip 안 폴더 구조가 선택한 폴더 아래 폴더가 된다.
 *  · 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 **둘 다** 있으면 짝 폴더로 보고 윗 폴더로 합친다.
 *    한쪽만 있으면 보통 폴더다.
 *  · 같은 폴더·같은 이름(대소문자까지)끼리 자료 1건으로 묶는다. 정상 꼬리(`_Rev00`)는 떼고 묶는다.
 *  · `..` 조각은 버린다 — 지정한 폴더 밖으로 절대 나가지 않는다(확인창은 알리는 용도).
 */

/** 받아들이는 형식. 압축 안의 압축은 받지 않는다. */
export const ZIP_ALLOWED = new Set(['pdf', 'dwg', 'dxf', 'xlsx', 'xls', 'docx', 'pptx'])

/** 압축 폭탄 방지 상한 */
export const ZIP_LIMITS = {
  /** 파일 수 */
  maxEntries: 20_000,
  /** 파일 하나의 풀린 크기 */
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  /** 전체 풀린 크기 */
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  /** 압축률 — 1MB 넘는 파일이 이 배수 이상 부풀면 폭탄으로 본다 */
  maxRatio: 200,
}

export interface ZipEntryInfo {
  /** Zip 안 경로 ("/" 또는 "\" 구분) */
  path: string
  uncompressedSize: number
  compressedSize: number
}

export interface PlannedFile {
  /** 원래 entries 배열의 위치 */
  index: number
  filename: string
  ext: string
}

export interface PlannedGroup {
  /** 정리된 폴더 조각 (선택한 폴더 기준 상대 경로) */
  folder: string[]
  name: string
  files: PlannedFile[]
}

export interface ZipPlan {
  groups: PlannedGroup[]
  unsafePaths: string[]
  duplicates: DuplicateGroup[]
  partial: PartialItem[]
  pairFolders: string[]
  /** 형식이 맞지 않아 건너뛴 파일 */
  ignored: string[]
  totalBytes: number
}

export class ZipLimitError extends Error {}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i

function isPairName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'dwg' || n === 'pdf'
}

/** 압축 폭탄 검사. 넘으면 ZipLimitError. */
export function checkLimits(entries: ZipEntryInfo[]): number {
  if (entries.length > ZIP_LIMITS.maxEntries) {
    throw new ZipLimitError(`압축 안 파일이 너무 많습니다 (${entries.length}개, 상한 ${ZIP_LIMITS.maxEntries}개).`)
  }
  let total = 0
  for (const e of entries) {
    if (e.uncompressedSize > ZIP_LIMITS.maxEntryBytes) {
      throw new ZipLimitError(`압축 안 파일 하나가 너무 큽니다: ${e.path}`)
    }
    if (e.uncompressedSize > 1024 * 1024
        && e.uncompressedSize / Math.max(1, e.compressedSize) > ZIP_LIMITS.maxRatio) {
      throw new ZipLimitError(`압축률이 비정상적으로 높은 파일이 있습니다: ${e.path}`)
    }
    total += e.uncompressedSize
  }
  if (total > ZIP_LIMITS.maxTotalBytes) {
    throw new ZipLimitError('압축을 풀면 용량 상한을 넘습니다.')
  }
  return total
}

/**
 * 계획을 세운다.
 * @param rootPath 선택한 폴더의 사람이 읽는 경로 — P&ID·PFD 판정에 쓴다
 * @param rev      새로 만들 자료의 Rev
 * 돌려주는 tailCheck 는 같은 자리 같은 이름 자료가 이미 있으면 그 Rev 를 기준으로 꼬리를 본다.
 */
export function planZip(
  entries: ZipEntryInfo[],
  rootPath: string,
  rev: number,
): ZipPlan & { tailCheck: (existingRev: (g: PlannedGroup) => number | null) => string[] } {
  const totalBytes = checkLimits(entries)
  const ignored: string[] = []
  const unsafe = new Set<string>()

  // ① 경로 정리 — 폴더 조각과 파일 이름으로
  const raw: { index: number; folder: string[]; rawFolder: string; filename: string }[] = []
  entries.forEach((e, index) => {
    const p = e.path.replace(/\\/g, '/')
    if (p.endsWith('/') || JUNK.test(p)) return
    const parts = p.split('/')
    const filename = parts.pop()!
    const rawFolder = parts.join('/')
    if (parts.some((s) => s === '..') || /^[A-Za-z]:/.test(p) || p.startsWith('/')) {
      unsafe.add(rawFolder || p)
    }
    // 절대경로·드라이브 문자·`..`·`.`·빈 조각은 실제 위치에 쓰지 않는다
    const folder = parts.filter((s) => s !== '' && s !== '.' && s !== '..' && !/^[A-Za-z]:$/.test(s))
    if (!filename || filename === '.' || filename === '..') return
    raw.push({ index, folder, rawFolder, filename })
  })

  // ② DWG·PDF 짝 폴더 — 같은 부모 밑에 둘 다 있을 때만
  const pairKinds = new Map<string, Set<string>>()
  for (const r of raw) {
    const last = r.folder[r.folder.length - 1]
    if (last && isPairName(last)) {
      const parent = r.folder.slice(0, -1).join('/')
      if (!pairKinds.has(parent)) pairKinds.set(parent, new Set())
      pairKinds.get(parent)!.add(last.toLowerCase())
    }
  }
  const pairParents = new Set([...pairKinds].filter(([, s]) => s.size === 2).map(([p]) => p))
  const pairFolders = new Set<string>()

  // ③ 같은 폴더·같은 이름으로 묶는다
  const map = new Map<string, PlannedGroup>()
  for (const r of raw) {
    const [stem, ext] = splitName(r.filename)
    if (!ZIP_ALLOWED.has(ext)) { ignored.push([...r.folder, r.filename].join('/')); continue }

    let folder = r.folder
    const last = folder[folder.length - 1]
    if (last && isPairName(last) && pairParents.has(folder.slice(0, -1).join('/'))) {
      pairFolders.add(folder.join('/'))
      folder = folder.slice(0, -1)
    }
    const folderPath = [rootPath, ...folder].join(' › ')
    const name = registrationName(stem, folderPath)
    const key = `${folder.join('/')}\u0000${name}`
    if (!map.has(key)) map.set(key, { folder, name, files: [] })
    map.get(key)!.files.push({ index: r.index, filename: r.filename, ext })
  }

  const all = [...map.values()]
  const duplicates: DuplicateGroup[] = []
  const partial: PartialItem[] = []
  const groups: PlannedGroup[] = []
  for (const g of all) {
    const dups = duplicateExts(g.files.map((f) => f.ext))
    if (dups.length) {
      duplicates.push({ stem: g.name, folder: g.folder.join('/') || null, exts: dups })
      continue
    }
    const exts = new Set(g.files.map((f) => f.ext))
    if (exts.size === 1) partial.push({ stem: g.name, ext: [...exts][0]!, folder: g.folder.join('/') || null })
    groups.push(g)
  }

  const tailCheck = (existingRev: (g: PlannedGroup) => number | null) => {
    const problems: string[] = []
    for (const g of groups) {
      const target = existingRev(g) ?? rev
      const folderPath = [rootPath, ...g.folder].join(' › ')
      for (const f of g.files) {
        const [, problem] = newUploadName(splitName(f.filename)[0], folderPath, target)
        if (problem) problems.push(problem)
      }
    }
    return problems
  }

  return {
    groups, duplicates, partial, ignored, totalBytes, tailCheck,
    unsafePaths: [...unsafe].sort(),
    pairFolders: [...pairFolders].sort(),
  }
}
