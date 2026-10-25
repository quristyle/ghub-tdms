import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { FastifyReply } from 'fastify'
import { config } from './config.js'

/**
 * 파일 전송.
 *
 * 운영(nginx 뒤)에서는 앱이 바이트를 전혀 만지지 않는다 — 권한 검사와 감사 기록만 하고
 * X-Accel-Redirect 헤더를 던지면 nginx 가 커널 sendfile 로 직송한다.
 * 6.5GB Zip 반출 중에도 Node 이벤트 루프가 비어 있다.
 *
 * 개발(nginx 없음)에서는 같은 함수가 직접 스트리밍으로 떨어진다.
 */

export function blobRelPath(sha256: Buffer): string {
  const hex = sha256.toString('hex')
  return `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`
}

export function blobAbsPath(sha256: Buffer): string {
  return join(config.storageRoot, 'blobs', blobRelPath(sha256))
}

/** RFC 5987 — 한글 파일명이 깨지지 않게 두 벌로 적는다. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export interface SendBlobOptions {
  sha256: Buffer
  filename: string
  contentType: string
  inline?: boolean
  byteSize?: number
}

export function sendBlob(reply: FastifyReply, o: SendBlobOptions): FastifyReply {
  reply
    .header('Content-Type', o.contentType)
    .header('Content-Disposition', contentDisposition(o.filename, o.inline))
    .header('X-Content-Type-Options', 'nosniff')

  if (config.useXAccel) {
    // nginx: location /_blob/ { internal; alias /srv/tdms/blobs/; sendfile on; }
    return reply.header('X-Accel-Redirect', `/_blob/${blobRelPath(o.sha256)}`).send()
  }

  if (o.byteSize !== undefined) reply.header('Content-Length', String(o.byteSize))
  return reply.send(createReadStream(blobAbsPath(o.sha256)))
}

export const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  dwg: 'application/acad',
  dxf: 'image/vnd.dxf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
}

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase().replace(/^\./, '')] ?? 'application/octet-stream'
}
