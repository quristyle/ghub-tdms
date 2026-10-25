import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import type pg from 'pg'
import { config } from './config.js'
import { blobAbsPath } from './files.js'

/**
 * content-addressed 저장소.
 *
 * 파일은 내용(sha256)으로 주소를 삼는다. 같은 내용은 한 번만 저장되고,
 * 리비전 승격·이동·이름 변경이 디스크를 건드리지 않는다.
 *
 * 쓰기 순서가 중요하다:
 *   ① 임시 파일로 받으면서 sha256 계산
 *   ② 최종 자리로 rename (같은 파일시스템이라 원자적)
 *   ③ DB 에 blobs 행 등록
 * ③ 이 실패하면 파일만 남는데, 그건 refcount 0 인 고아라 야간 GC 가 수거한다.
 * 반대 순서로 하면 DB 에는 있는데 파일이 없는 상태가 생겨 복구가 어렵다.
 *
 * ## 해싱을 반드시 파이프라인 안에서 하는 이유
 *
 * 예전에는 `source.on('data')` 로 옆에서 바이트를 세고 해시를 만들었다. 이러면
 * **데이터를 잃는다** — `.on('data')` 는 스트림을 즉시 flowing 모드로 바꾸므로,
 * `pipeline()` 이 붙기 전에 흘러간 청크는 파일에도 해시에도 들어가지 않는다.
 * 작은 파일은 청크가 하나뿐이라 통째로 사라져 **모든 업로드가 0바이트 blob 이 됐다**
 * (빈 입력의 sha256 하나로 전부 중복제거되어 내용이 전멸).
 *
 * 그래서 해싱·크기 검사·앞머리 엿보기를 전부 Transform 하나에 담아 파이프라인 안에 둔다.
 * 스트림에 곁다리 리스너를 붙이지 말 것.
 */

export interface StoredBlob {
  sha256: Buffer
  byteSize: number
  /** 이미 같은 내용이 있어서 새로 쓰지 않았는가 */
  deduped: boolean
  /** 앞머리 바이트 (형식 검사용) */
  head: Buffer
}

export class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`업로드 상한을 넘었습니다 (${limit} bytes)`)
    this.name = 'PayloadTooLargeError'
  }
}

export async function storeStream(source: Readable, maxBytes: number): Promise<StoredBlob> {
  const tmpDir = join(config.storageRoot, 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const tmpPath = join(
    tmpDir,
    `up-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  const hash = createHash('sha256')
  let byteSize = 0
  const headParts: Buffer[] = []
  let headLen = 0

  // 지나가는 바이트를 그대로 흘려보내면서 해시·크기·앞머리를 함께 얻는다
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      byteSize += chunk.length
      if (byteSize > maxBytes) {
        done(new PayloadTooLargeError(maxBytes))
        return
      }
      hash.update(chunk)
      if (headLen < 16) {
        headParts.push(chunk.subarray(0, 16 - headLen))
        headLen += Math.min(chunk.length, 16 - headLen)
      }
      done(null, chunk)
    },
  })

  try {
    await pipeline(source, meter, createWriteStream(tmpPath))
  } catch (e) {
    await unlink(tmpPath).catch(() => {})
    throw e
  }

  const sha256 = hash.digest()
  const head = Buffer.concat(headParts)
  const finalPath = blobAbsPath(sha256)

  try {
    await stat(finalPath)
    // 이미 있다 — 내용이 같으므로 임시 파일을 버린다
    await unlink(tmpPath).catch(() => {})
    return { sha256, byteSize, deduped: true, head }
  } catch {
    await mkdir(dirname(finalPath), { recursive: true })
    await rename(tmpPath, finalPath)
    return { sha256, byteSize, deduped: false, head }
  }
}

/** blobs 행 등록. 같은 sha256 이면 아무 일도 하지 않는다. */
export async function registerBlob(client: pg.PoolClient, b: StoredBlob): Promise<void> {
  await client.query(
    `INSERT INTO blobs (sha256, byte_size) VALUES ($1, $2)
     ON CONFLICT (sha256) DO NOTHING`,
    [b.sha256, b.byteSize],
  )
}

export async function addRef(client: pg.PoolClient, sha256: Buffer, delta: number): Promise<void> {
  await client.query(
    'UPDATE blobs SET refcount = GREATEST(0, refcount + $2) WHERE sha256 = $1',
    [sha256, delta],
  )
}

/** 빈 입력의 sha256 — 업로드가 통째로 비었는지 알아보는 데 쓴다. */
export const EMPTY_SHA256 = createHash('sha256').digest()

export function isEmptyBlob(sha256: Buffer): boolean {
  return sha256.equals(EMPTY_SHA256)
}
