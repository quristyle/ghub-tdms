import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
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
 */

export interface StoredBlob {
  sha256: Buffer
  byteSize: number
  /** 이미 같은 내용이 있어서 새로 쓰지 않았는가 */
  deduped: boolean
}

export async function storeStream(source: Readable, maxBytes: number): Promise<StoredBlob> {
  const tmpDir = join(config.storageRoot, 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `up-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  const hash = createHash('sha256')
  let byteSize = 0

  source.on('data', (chunk: Buffer) => {
    byteSize += chunk.length
    if (byteSize > maxBytes) source.destroy(new Error('PAYLOAD_TOO_LARGE'))
    hash.update(chunk)
  })

  try {
    await pipeline(source, createWriteStream(tmpPath))
  } catch (e) {
    await unlink(tmpPath).catch(() => {})
    throw e
  }

  const sha256 = hash.digest()
  const finalPath = blobAbsPath(sha256)

  try {
    await stat(finalPath)
    // 이미 있다 — 내용이 같으므로 임시 파일을 버린다
    await unlink(tmpPath).catch(() => {})
    return { sha256, byteSize, deduped: true }
  } catch {
    await mkdir(dirname(finalPath), { recursive: true })
    await rename(tmpPath, finalPath)
    return { sha256, byteSize, deduped: false }
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
