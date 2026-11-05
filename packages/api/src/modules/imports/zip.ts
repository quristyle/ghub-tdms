import { open, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline, Readable, Transform } from 'node:stream'
import { createInflateRaw, crc32 } from 'node:zlib'

/**
 * 최소 Zip 읽기 — 중앙 디렉터리를 읽고 항목 하나씩 스트림으로 푼다.
 *
 * 반입 Zip 은 업체가 보내는 파일이라 믿을 수 없다. 압축 폭탄·경로 조작을 여기서 막는다.
 *   · 항목 수, 전체 풀린 크기, 항목별 크기·압축률 상한 (기존 시스템 S-13)
 *   · 중앙 디렉터리가 적은 크기보다 실제로 더 풀리면 끊는다 (적힌 크기를 믿지 않는다)
 *   · 절대 경로·드라이브 문자·`..`·NUL 이 든 이름이 하나라도 있으면 Zip 전체를 거부한다
 *   · 암호화 항목, stored/deflate 외 압축 방식은 받지 않는다
 *
 * 풀린 내용은 디스크 경로로 쓰지 않는다 — blob(sha256)으로만 들어가므로 이름이 저장 위치를
 * 정하지 않는다. 경로 검사는 폴더 비교·표시용 이름을 깨끗하게 지키기 위한 것이다.
 *
 * 의존성을 늘리지 않으려고 직접 읽는다. 쓰기는 하지 않는다(반출 Zip 은 워커가 만든다).
 */

export const ZIP_LIMITS = {
  maxEntries: 20_000,
  /** 풀린 전체 크기 */
  maxTotalBytes: 20 * 1024 ** 3,
  /** 항목 하나 */
  maxEntryBytes: 4 * 1024 ** 3,
  /** 압축률 — 이 크기를 넘는 항목만 본다(작은 텍스트는 원래 많이 줄어든다) */
  maxRatio: 200,
  ratioFloorBytes: 10 * 1024 ** 2,
  /** 중앙 디렉터리 */
  maxDirectoryBytes: 64 * 1024 ** 2,
} as const

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  /** '/' 구분 경로 */
  name: string
  isDir: boolean
  method: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** 바이트를 임의 위치에서 읽는 창구 — 파일·메모리 둘 다 */
export interface ZipSource {
  size: number
  read(position: number, length: number): Promise<Buffer>
  stream(start: number, length: number): Readable
  close(): Promise<void>
}

export async function fileSource(path: string): Promise<ZipSource> {
  const fh: FileHandle = await open(path, 'r')
  const { size } = await fh.stat()
  return {
    size,
    async read(position, length) {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, position)
      return buf.subarray(0, bytesRead)
    },
    stream(start, length) {
      if (length === 0) return Readable.from([])
      return createReadStream(path, { start, end: start + length - 1 })
    },
    close: () => fh.close(),
  }
}

export function bufferSource(buf: Buffer): ZipSource {
  return {
    size: buf.length,
    read: async (p, l) => buf.subarray(p, p + l),
    stream: (s, l) => Readable.from(l === 0 ? [] : [buf.subarray(s, s + l)]),
    close: async () => {},
  }
}

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const cp949 = (() => {
  try {
    return new TextDecoder('euc-kr')
  } catch {
    return null   // ICU 가 빠진 Node 빌드
  }
})()

/**
 * 항목 이름 해석. 윈도우 탐색기('압축(zip) 폴더로 보내기')·반디집 일부 설정은 UTF-8 표시
 * 없이 CP949 로 적는다. 표시가 있으면 UTF-8, Info-ZIP 유니코드 경로가 있으면 그것,
 * 아니면 UTF-8 로 읽어 보고 깨지면 CP949 로 읽는다.
 */
function decodeName(raw: Buffer, flags: number, extra: Buffer): string {
  if (flags & 0x0800) return raw.toString('utf8')
  const up = findExtra(extra, 0x7075)
  if (up && up.length > 5 && up[0] === 1) return up.subarray(5).toString('utf8')
  try {
    return utf8Strict.decode(raw)
  } catch {
    return cp949 ? cp949.decode(raw) : raw.toString('latin1')
  }
}

function findExtra(extra: Buffer, id: number): Buffer | null {
  let p = 0
  while (p + 4 <= extra.length) {
    const hid = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    if (hid === id) return extra.subarray(p + 4, p + 4 + len)
    p += 4 + len
  }
  return null
}

/** 경로 조작 검사 — 하나라도 걸리면 Zip 전체를 거부한다 */
export function assertSafeName(name: string): void {
  if (!name || name.includes('\0')) throw new ZipError('Zip 안에 이름이 비었거나 깨진 항목이 있습니다.')
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`Zip 안에 절대 경로 항목이 있습니다: ${name}`)
  }
  if (name.split('/').some((seg) => seg === '..')) {
    throw new ZipError(`Zip 안에 상위 폴더로 나가는 경로가 있습니다: ${name}`)
  }
}

async function findEocd(src: ZipSource): Promise<{ buf: Buffer; at: number }> {
  const tail = Math.min(src.size, 22 + 0xffff)
  const start = src.size - tail
  const buf = await src.read(start, tail)
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return { buf: buf.subarray(i), at: start + i }
  }
  throw new ZipError('올바른 Zip 파일이 아닙니다 (끝 표시를 찾지 못했습니다).')
}

export async function readEntries(src: ZipSource): Promise<ZipEntry[]> {
  const { buf: eocd, at: eocdAt } = await findEocd(src)
  let count = eocd.readUInt16LE(10)
  let dirSize = eocd.readUInt32LE(12)
  let dirOffset = eocd.readUInt32LE(16)

  // Zip64 — 항목 수·크기·위치가 꽉 찬 값이면 Zip64 끝 레코드를 본다
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    if (eocdAt < 20) throw new ZipError('Zip64 정보를 찾지 못했습니다.')
    const loc = await src.read(eocdAt - 20, 20)
    if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw new ZipError('Zip64 정보를 찾지 못했습니다.')
    const recAt = Number(loc.readBigUInt64LE(8))
    const rec = await src.read(recAt, 56)
    if (rec.length < 56 || rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new ZipError('Zip64 정보가 깨졌습니다.')
    count = Number(rec.readBigUInt64LE(32))
    dirSize = Number(rec.readBigUInt64LE(40))
    dirOffset = Number(rec.readBigUInt64LE(48))
  }

  if (count > ZIP_LIMITS.maxEntries) {
    throw new ZipError(`Zip 안 항목이 너무 많습니다 (${count.toLocaleString()}개, 상한 ${ZIP_LIMITS.maxEntries.toLocaleString()}개).`)
  }
  if (dirSize > ZIP_LIMITS.maxDirectoryBytes || dirOffset + dirSize > src.size) {
    throw new ZipError('Zip 목록이 올바르지 않습니다.')
  }

  const dir = await src.read(dirOffset, dirSize)
  const entries: ZipEntry[] = []
  let total = 0
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError('Zip 목록이 깨졌습니다.')
    }
    const flags = dir.readUInt16LE(p + 8)
    const method = dir.readUInt16LE(p + 10)
    const crc = dir.readUInt32LE(p + 16)
    let compressedSize = dir.readUInt32LE(p + 20)
    let uncompressedSize = dir.readUInt32LE(p + 24)
    const nameLen = dir.readUInt16LE(p + 28)
    const extraLen = dir.readUInt16LE(p + 30)
    const commentLen = dir.readUInt16LE(p + 32)
    let localHeaderOffset = dir.readUInt32LE(p + 42)
    const rawName = dir.subarray(p + 46, p + 46 + nameLen)
    const extra = dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    p += 46 + nameLen + extraLen + commentLen

    // Zip64 확장 필드 — 꽉 찬 값만 순서대로 들어 있다
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const z64 = findExtra(extra, 0x0001)
      if (!z64) throw new ZipError('Zip64 항목 정보가 없습니다.')
      let q = 0
      const next = () => {
        if (q + 8 > z64.length) throw new ZipError('Zip64 항목 정보가 깨졌습니다.')
        const v = Number(z64.readBigUInt64LE(q))
        q += 8
        return v
      }
      if (uncompressedSize === 0xffffffff) uncompressedSize = next()
      if (compressedSize === 0xffffffff) compressedSize = next()
      if (localHeaderOffset === 0xffffffff) localHeaderOffset = next()
    }

    const name = decodeName(rawName, flags, extra).replace(/\\/g, '/')
    assertSafeName(name)
    const isDir = name.endsWith('/')

    if (!isDir) {
      if (flags & 0x0001) throw new ZipError(`암호가 걸린 항목은 받을 수 없습니다: ${name}`)
      if (method !== 0 && method !== 8) {
        throw new ZipError(`지원하지 않는 압축 방식입니다(${method}): ${name}`)
      }
      if (uncompressedSize > ZIP_LIMITS.maxEntryBytes) {
        throw new ZipError(`Zip 안 파일이 너무 큽니다: ${name}`)
      }
      if (
        uncompressedSize > ZIP_LIMITS.ratioFloorBytes &&
        uncompressedSize / Math.max(1, compressedSize) > ZIP_LIMITS.maxRatio
      ) {
        throw new ZipError(`압축률이 비정상적인 항목이 있어 받을 수 없습니다: ${name}`)
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        throw new ZipError(`Zip 항목 크기가 맞지 않습니다: ${name}`)
      }
      if (localHeaderOffset + compressedSize > src.size) {
        throw new ZipError(`Zip 항목이 잘려 있습니다: ${name}`)
      }
      total += uncompressedSize
      if (total > ZIP_LIMITS.maxTotalBytes) {
        throw new ZipError('Zip 을 풀면 너무 커집니다 — 나눠서 올려 주세요.')
      }
    }

    entries.push({ name, isDir, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset })
  }
  return entries
}

/**
 * 항목 하나를 푼 스트림. 적힌 크기보다 더 나오면(압축 폭탄) 끊고, 끝에서 크기·CRC 를 맞춰 본다.
 */
export async function openEntry(src: ZipSource, e: ZipEntry): Promise<Readable> {
  const head = await src.read(e.localHeaderOffset, 30)
  if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) {
    throw new ZipError(`Zip 항목 머리가 깨졌습니다: ${e.name}`)
  }
  const dataAt = e.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  if (dataAt + e.compressedSize > src.size) throw new ZipError(`Zip 항목이 잘려 있습니다: ${e.name}`)

  const raw = src.stream(dataAt, e.compressedSize)
  let produced = 0
  let crc = 0
  const guard = new Transform({
    transform(chunk: Buffer, _enc, done) {
      produced += chunk.length
      if (produced > e.uncompressedSize) {
        done(new ZipError(`적힌 크기보다 더 풀리는 항목이 있습니다(압축 폭탄 의심): ${e.name}`))
        return
      }
      crc = crc32(chunk, crc)
      done(null, chunk)
    },
    flush(done) {
      if (produced !== e.uncompressedSize) {
        done(new ZipError(`Zip 항목 크기가 맞지 않습니다: ${e.name}`))
        return
      }
      if (crc >>> 0 !== e.crc32 >>> 0) {
        done(new ZipError(`Zip 항목이 손상되었습니다(CRC): ${e.name}`))
        return
      }
      done()
    },
  })

  // pipeline 이 앞 단계의 오류를 끝 스트림까지 넘겨 준다 (읽는 쪽이 오류를 받는다)
  const noop = () => {}
  if (e.method === 0) return pipeline(raw, guard, noop)
  return pipeline(raw, createInflateRaw(), guard, noop)
}

/** 작은 항목(반출목록 엑셀 등)을 통째로 읽는다 */
export async function readEntryBuffer(src: ZipSource, e: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (e.uncompressedSize > maxBytes) throw new ZipError(`항목이 너무 큽니다: ${e.name}`)
  const s = await openEntry(src, e)
  const parts: Buffer[] = []
  for await (const chunk of s) parts.push(chunk as Buffer)
  return Buffer.concat(parts)
}
