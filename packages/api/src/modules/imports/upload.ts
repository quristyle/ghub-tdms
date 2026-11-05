/** 반입으로 받는 파일의 형식 검사 — 업로드 라우트와 Zip 반입이 함께 쓴다. */

/** 업로드 상한. nginx 의 client_max_body_size 와 맞춘다. */
export const MAX_UPLOAD = 2 * 1024 * 1024 * 1024

/** 확장자만 믿지 않는다 — 앞머리 바이트로 한 번 더 본다. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  dwg: (b) => b.subarray(0, 2).toString('latin1') === 'AC',
}

export const ALLOWED = new Set(['pdf', 'dwg', 'dxf', 'xlsx', 'xls', 'docx', 'pptx', 'zip'])

/** Zip 안에서 꺼내 자료로 받을 형식 — Zip 속 Zip 은 받지 않는다 */
export const ALLOWED_IN_ZIP = new Set([...ALLOWED].filter((e) => e !== 'zip'))

/**
 * 올라온 파일이 쓸 만한지 본다. 문제가 있으면 그 설명, 괜찮으면 null.
 *   · 비어 있지 않은가 — 0바이트는 업로드가 끊겼거나 스트림을 잘못 읽은 것이다
 *   · 앞머리 바이트가 확장자와 맞는가 — 확장자만 바꿔 올린 파일을 막는다
 */
export function contentProblem(
  stored: { byteSize: number; head: Buffer }, ext: string, filename: string,
): { code: string; message: string } | null {
  if (stored.byteSize === 0) return { code: 'EMPTY_FILE', message: `내용이 비어 있습니다: ${filename}` }
  const check = MAGIC[ext]
  if (check && !check(stored.head)) {
    return { code: 'CONTENT_MISMATCH', message: `내용이 .${ext} 형식이 아닙니다: ${filename}` }
  }
  return null
}

/** Zip 에 딸려 오는 군더더기 — 조용히 건너뛴다 */
export function isJunkEntry(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  const name = p.slice(p.lastIndexOf('/') + 1)
  return (
    p.startsWith('__MACOSX/') || p.includes('/__MACOSX/') ||
    name === '.DS_Store' || name.toLowerCase() === 'thumbs.db' || name.toLowerCase() === 'desktop.ini' ||
    name.startsWith('~$')
  )
}
