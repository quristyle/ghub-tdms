import { bufferSource, readEntries, readEntryBuffer, ZipError } from './zip.js'

/**
 * 반출목록.xlsx 읽기 — 첫 시트의 셀 값만 꺼낸다.
 *
 * 반출목록은 우리 워커(openpyxl)가 만든 단순한 표다(머리글 + 값). 서식·수식·병합은 볼 일이 없어
 * 엑셀 라이브러리를 들이지 않고 시트 XML 에서 값만 읽는다. 업체가 엑셀에서 열어 저장해도
 * 공유 문자열·인라인 문자열·숫자 셋 다 읽으므로 그대로 된다.
 */

const MAX_PART = 50 * 1024 * 1024

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, g: string) => {
    if (g === 'amp') return '&'
    if (g === 'lt') return '<'
    if (g === 'gt') return '>'
    if (g === 'quot') return '"'
    if (g === 'apos') return "'"
    const code = g.startsWith('#x') ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

/** <si> 하나 안의 <t> 를 모두 이어 붙인다 (서식 run 이 나뉘어 있어도 한 값) */
function textOf(xml: string): string {
  let out = ''
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1] ?? '')
  return out
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export async function readFirstSheet(data: Buffer): Promise<(string | number | null)[][]> {
  const src = bufferSource(data)
  const entries = await readEntries(src)
  const byName = new Map(entries.map((e) => [e.name, e]))

  const shared: string[] = []
  const ss = byName.get('xl/sharedStrings.xml')
  if (ss) {
    const xml = (await readEntryBuffer(src, ss, MAX_PART)).toString('utf8')
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1] ?? ''))
  }

  const sheet =
    byName.get('xl/worksheets/sheet1.xml') ??
    entries.filter((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))[0]
  if (!sheet) throw new ZipError('반출목록 엑셀에 시트가 없습니다.')
  const xml = (await readEntryBuffer(src, sheet, MAX_PART)).toString('utf8')

  const rows: (string | number | null)[][] = []
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: (string | number | null)[] = []
    let next = 0
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? ''
      const body = cm[2] ?? ''
      const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1]
      const idx = ref ? colIndex(ref) : next
      next = idx + 1
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value: string | number | null = null
      if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? null) : null
      else if (type === 'inlineStr') value = textOf(body)
      else if (type === 'str' || type === 'b' || type === 'e') value = v !== undefined ? decodeXml(v) : null
      else if (v !== undefined) value = Number.isFinite(Number(v)) ? Number(v) : decodeXml(v)
      while (row.length < idx) row.push(null)
      row[idx] = value
    }
    rows.push(row)
  }
  return rows
}
