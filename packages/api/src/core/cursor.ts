/**
 * keyset 페이징 커서.
 *
 * OFFSET 을 쓰지 않는다 — 뒤 페이지로 갈수록 느려지기 때문이다
 * (기존 시스템의 "끝 페이지" 버튼이 느렸던 원인).
 *
 * 커서는 (정렬키, id) 쌍을 담은 불투명 문자열이다.
 */

export interface Keyset {
  sortValue: string
  id: number
}

export function encodeCursor(k: Keyset): string {
  return Buffer.from(JSON.stringify([k.sortValue, k.id]), 'utf8').toString('base64url')
}

export function decodeCursor(c: string | undefined): Keyset | undefined {
  if (!c) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const [sortValue, id] = parsed as [unknown, unknown]
    if (typeof sortValue !== 'string' || typeof id !== 'number') return undefined
    return { sortValue, id }
  } catch {
    return undefined
  }
}
