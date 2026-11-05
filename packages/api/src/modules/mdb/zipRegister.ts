import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { config } from '../../core/config.js'
import { PayloadTooLargeError, registerBlob, storeStream } from '../../core/blob.js'
import { tx } from '../../core/db.js'
import * as jobs from '../jobs/service.js'
import {
  BLOCKED_EXT, fileExtOf, pairingFolderPaths, safeZipPath, splitPairingFolder,
} from './grouping.js'
import { checkDuplicates, storeEntries, unusableReason, type RegisterEntry } from './register.js'

/**
 * MDB Zip 폴더 업로드 (기존 mdb_editor.py /mdb-editor/zip-register).
 *
 * Zip 안 폴더 구조를 그대로 선택한 폴더 아래 MDB 폴더로 만들고, 파일은 mdb_files 로 넣는다.
 *   · 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 **둘 다** 있으면 그 둘은 짝 폴더 —
 *     폴더를 만들지 않고 상위 폴더의 자료 1건으로 합친다 (pairing_folder 에 이름을 남긴다)
 *   · 같은 이름·같은 형식이 2개 이상이면 아무것도 넣지 않고 먼저 확인을 받는다
 *
 * 중앙 디렉터리(이름 목록)만 읽는 사전 점검은 요청 안에서 하고, 실제 압축 풀기·저장은
 * 202 로 답한 뒤 API 프로세스 안에서 한다 (jobs.createRunning — 워커는 집지 않는다).
 *
 * Zip 폭탄 · 경로 탈출 방어:
 *   · 항목 수 · 항목 하나 크기 · 풀었을 때 전체 크기 · 압축률 상한
 *   · 절대경로 · 드라이브 문자 · '..' · 제어문자 경로는 Zip 전체를 거부
 *   · 선언된 크기와 실제로 풀린 크기가 다르면 거부 (yauzl validateEntrySizes)
 *   · 파일은 디스크 경로가 아니라 content-addressed blob 으로만 저장한다 — Zip 안 이름이
 *     디스크 경로가 되는 일이 없다
 */

export const MAX_ZIP_UPLOAD = 2 * 1024 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024
/** 압축률 상한 — 이보다 심하게 줄어든 큰 항목은 폭탄으로 본다 */
const MAX_RATIO = 200
const RATIO_MIN_BYTES = 10 * 1024 * 1024
const MAX_DEPTH = 32

export class ZipRejected extends Error {}

/** 요청 본문을 임시 파일로 받는다 (상한 초과 시 PayloadTooLargeError) */
export async function saveTemp(source: Readable, maxBytes: number): Promise<string> {
  const dir = join(config.storageRoot, 'tmp')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `mdbzip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
  let n = 0
  const limit = new Transform({
    transform(chunk: Buffer, _e, done) {
      n += chunk.length
      if (n > maxBytes) { done(new PayloadTooLargeError(maxBytes)); return }
      done(null, chunk)
    },
  })
  try {
    await pipeline(source, limit, createWriteStream(path))
  } catch (e) {
    await unlink(path).catch(() => {})
    throw e
  }
  return path
}

// ── Zip 읽기 ────────────────────────────────────────────────────────────

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const cp949 = new TextDecoder('euc-kr')

/**
 * 항목 이름 디코딩. 한국어 Windows 탐색기로 만든 Zip 은 UTF-8 표시 없이 CP949 로 이름을
 * 적는다 — yauzl 기본(CP437) 으로 읽으면 한글이 깨진다.
 *   ① Info-ZIP Unicode Path 확장필드(0x7075)가 있으면 그것
 *   ② UTF-8 표시(bit 11)가 있거나 UTF-8 로 올바르게 읽히면 UTF-8
 *   ③ 아니면 CP949
 */
function decodeName(entry: yauzl.Entry): string {
  for (const f of entry.extraFields ?? []) {
    if (f.id === 0x7075 && f.data.length > 5 && f.data[0] === 1) {
      try { return utf8Strict.decode(f.data.subarray(5)) } catch { /* 다음 방법 */ }
    }
  }
  const raw = entry.fileName as unknown as Buffer
  if (typeof raw === 'string') return raw
  if (entry.generalPurposeBitFlag & 0x800) return raw.toString('utf8')
  try { return utf8Strict.decode(raw) } catch { return cp949.decode(raw) }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: true, decodeStrings: false, validateEntrySizes: true },
      (err, zf) => (err || !zf ? reject(err ?? new Error('Zip 을 열 수 없습니다')) : resolve(zf)),
    )
  })
}

interface ZipItem {
  entry: yauzl.Entry
  dirs: string[]
  filename: string
  ext: string
}

/**
 * 중앙 디렉터리만 훑어 쓸 항목을 고른다 (압축은 풀지 않는다).
 * 폭탄·경로 탈출이면 ZipRejected. 받지 않는 항목은 skipped 에 사유를 남긴다.
 */
export async function scanZip(path: string): Promise<{ items: ZipItem[]; skipped: string[] }> {
  let zf: yauzl.ZipFile
  try {
    zf = await openZip(path)
  } catch {
    throw new ZipRejected('올바른 Zip 파일이 아닙니다.')
  }
  if (zf.entryCount > MAX_ENTRIES) {
    zf.close()
    throw new ZipRejected(`Zip 안 항목이 너무 많습니다 (${zf.entryCount}개, 상한 ${MAX_ENTRIES}개).`)
  }

  const items: ZipItem[] = []
  const skipped: string[] = []
  let total = 0

  await new Promise<void>((resolve, reject) => {
    const bail = (e: Error) => { zf.close(); reject(e) }
    zf.on('error', (e: Error) => reject(new ZipRejected(`Zip 을 읽지 못했습니다: ${e.message}`)))
    zf.on('end', () => resolve())
    zf.on('entry', (entry: yauzl.Entry) => {
      const name = decodeName(entry)
      let parsed: ReturnType<typeof safeZipPath>
      try {
        parsed = safeZipPath(name)
      } catch (e) {
        bail(new ZipRejected((e as Error).message))
        return
      }
      if (parsed) {
        const ext = fileExtOf(parsed.filename)
        const size = entry.uncompressedSize
        if (parsed.dirs.length > MAX_DEPTH) {
          bail(new ZipRejected(`폴더가 너무 깊습니다: ${name}`)); return
        }
        if (size > MAX_ENTRY_BYTES) {
          bail(new ZipRejected(`파일 하나가 너무 큽니다: ${name}`)); return
        }
        if (size > RATIO_MIN_BYTES && size / Math.max(1, entry.compressedSize) > MAX_RATIO) {
          bail(new ZipRejected(`압축률이 비정상적으로 높습니다(Zip 폭탄 의심): ${name}`)); return
        }
        total += size
        if (total > MAX_TOTAL_BYTES) {
          bail(new ZipRejected('풀었을 때 전체 크기가 상한을 넘습니다.')); return
        }
        if (entry.generalPurposeBitFlag & 0x1) skipped.push(`${name} (암호가 걸린 파일)`)
        else if (BLOCKED_EXT.has(ext)) skipped.push(`${name} (받지 않는 형식 .${ext})`)
        else items.push({ entry, dirs: parsed.dirs, filename: parsed.filename, ext })
      }
      zf.readEntry()
    })
    zf.readEntry()
  })
  return { items, skipped }
}

/** 짝 폴더(DWG+PDF) 를 떼어내고 대상 폴더 기준 (폴더, 짝 이름) 으로 바꾼다 */
export function placeItems(items: { dirs: string[] }[]) {
  const pairPaths = pairingFolderPaths(items.map((i) => i.dirs.join('/')))
  return items.map((i) => {
    const [folder, pairing] = splitPairingFolder(i.dirs.join('/'), pairPaths)
    return { folder, pairing }
  })
}

export function preflight(items: ZipItem[]) {
  const placed = placeItems(items)
  return checkDuplicates(items.map((it, i) => ({ folder: placed[i]!.folder, filename: it.filename, ext: it.ext })))
}

/** 압축을 풀며 하나씩 blob 으로 저장한다. 고른 항목만 연다. */
export async function extractAll(
  path: string,
  wanted: Set<string>,
  onFile: (key: string, stream: Readable, size: number) => Promise<void>,
): Promise<void> {
  const zf = await openZip(path)
  await new Promise<void>((resolve, reject) => {
    zf.on('error', reject)
    zf.on('end', () => resolve())
    zf.on('entry', (entry: yauzl.Entry) => {
      const key = `${entry.relativeOffsetOfLocalHeader}`
      if (!wanted.has(key)) { zf.readEntry(); return }
      zf.openReadStream(entry, (err, stream) => {
        if (err || !stream) { zf.close(); reject(err ?? new Error('항목을 열 수 없습니다')); return }
        onFile(key, stream, entry.uncompressedSize)
          .then(() => zf.readEntry())
          .catch((e: unknown) => { stream.destroy(); zf.close(); reject(e) })
      })
    })
    zf.readEntry()
  })
}

/**
 * 202 로 답한 뒤 돈다. 결과·오류는 jobs 표에 남는다 — 여기서 throw 하지 않는다.
 * 끝나면 임시 Zip 을 지운다.
 */
export async function runZipJob(v: {
  jobId: number
  path: string
  items: ZipItem[]
  scanSkipped: string[]
  targetFolderId: number | null
  userId: number
}): Promise<void> {
  // 오래 걸리는 압축 풀기 동안에도 heartbeat 가 끊기지 않게 한다 (좀비 오인 방지)
  let lastNote = '압축을 푸는 중'
  let lastPct = 1
  const beat = setInterval(() => { void jobs.progress(v.jobId, lastPct, lastNote).catch(() => {}) }, 30_000)
  const report = async (pct: number, note: string) => {
    lastPct = pct; lastNote = note
    await jobs.progress(v.jobId, pct, note)
  }

  try {
    const placed = placeItems(v.items)
    const byKey = new Map(v.items.map((it, i) => [`${it.entry.relativeOffsetOfLocalHeader}`, { it, at: placed[i]! }]))
    const entries: RegisterEntry[] = []
    const skipped = [...v.scanSkipped]
    let done = 0

    await report(1, `압축을 푸는 중 (0/${v.items.length})`)
    await extractAll(v.path, new Set(byKey.keys()), async (key, stream, size) => {
      const { it, at } = byKey.get(key)!
      const shown = [...it.dirs, it.filename].join('/')
      const stored = await storeStream(stream, size + 1)
      const bad = unusableReason(stored, it.ext)
      if (bad) {
        skipped.push(`${shown} (${bad})`)
      } else {
        await tx((c) => registerBlob(c, stored))
        entries.push({
          folder: at.folder, pairing: at.pairing, filename: it.filename, ext: it.ext,
          data: { sha256: stored.sha256, byteSize: stored.byteSize },
        })
      }
      done += 1
      if (done % 10 === 0 || done === v.items.length) {
        await report(1 + Math.floor((done / v.items.length) * 79), `압축을 푸는 중 (${done}/${v.items.length})`)
      }
    })

    await report(80, '자료를 등록하는 중')
    const out = await storeEntries(v.targetFolderId, entries, v.userId, (i, n) =>
      report(80 + Math.floor((i / n) * 19), `자료를 등록하는 중 (${i}/${n})`),
    )
    const all = [...skipped, ...out.skipped]
    const note =
      `${out.created}건 등록` +
      (out.attached ? `, 기존 자료에 ${out.attached}개 채움` : '') +
      (out.foldersCreated ? `, 폴더 ${out.foldersCreated}개 생성` : '') +
      (all.length ? `, ${all.length}건 건너뜀` : '')
    await jobs.progress(v.jobId, 100, note)
    await jobs.finish(v.jobId, { ...out, skipped: all.slice(0, 500) })
  } catch (e) {
    await jobs.fail(v.jobId, e instanceof Error ? e.message : '알 수 없는 오류').catch(() => {})
  } finally {
    clearInterval(beat)
    await unlink(v.path).catch(() => {})
  }
}
