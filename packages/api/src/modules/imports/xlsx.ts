import { bufferSource, readEntries, readEntryBuffer, ZipError } from './zip.js'

/**
 * 반출목록.xlsx 읽기 — 첫 시트의 셀 값만 꺼낸다.
 *
 * 반출목록은 우리 워커(openpyxl)가 만든 단순한 표다(머리글 + 값). 서식·수식·병합은 볼 일이 없어
 * 엑셀 라이브러리를 들이지 않고 시트 XML 에서 값만 읽는다. 업체가 엑셀에서 열어 저장해도
 * 공유 문자열·인라인 문자열·숫자 셋 다 읽으므로 그대로 된다.
 */

// 반출목록은 수천 줄짜리 단순한 표다. 넉넉히 잡되 끝이 있게 한다 —
// 이 파서는 API 프로세스 안에서 돈다(막히면 모든 요청이 멈춘다).
const MAX_PART = 16 * 1024 * 1024
const MAX_ROWS = 200_000
/** 엑셀의 열 한계(XFD). 이보다 큰 참조는 꾸민 파일이다 — 빈 칸을 수십억 개 채우다 메모리가 터진다. */
const MAX_COLS = 16_384

/**
 * <tag ...>body</tag> 또는 <tag .../> 를 차례로 꺼낸다.
 *
 * 정규식 /<row>([\s\S]*?)<\/row>/g 는 닫는 태그가 없는 여는 태그마다 끝까지 다시 훑어
 * 일이 제곱으로 는다(닫는 태그 없는 <row> 수백만 개 = 이벤트 루프 정지). indexOf 로 한 번만 훑고,
 * 닫는 태그를 못 찾으면 거기서 멈춘다.
 */
function* elements(xml: string, tag: string): Generator<{ attrs: string; body: string }> {
  const open = `<${tag}`
  const close = `</${tag}>`
  let pos = 0
  for (;;) {
    const i = xml.indexOf(open, pos)
    if (i < 0) return
    const next = xml.charCodeAt(i + open.length)
    // <c 가 <col·<cols 에, <t 가 <tableParts 에 걸리지 않게 — 이름 바로 뒤는 공백·'>'·'/' 여야 한다
    if (!(next === 32 || next === 9 || next === 10 || next === 13 || next === 62 || next === 47)) {
      pos = i + open.length
      continue
    }
    const gt = xml.indexOf('>', i + open.length)
    if (gt < 0) return
    if (xml.charCodeAt(gt - 1) === 47) {
      yield { attrs: xml.slice(i + open.length, gt - 1), body: '' }
      pos = gt + 1
      continue
    }
    const end = xml.indexOf(close, gt + 1)
    if (end < 0) return
    yield { attrs: xml.slice(i + open.length, gt), body: xml.slice(gt + 1, end) }
    pos = end + close.length
  }
}

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
  for (const t of elements(xml, 't')) out += decodeXml(t.body)
  return out
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  if (letters.length > 3) return MAX_COLS // XFD 를 넘는다 — 아래에서 버린다
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
    for (const si of elements(xml, 'si')) shared.push(textOf(si.body))
  }

  const sheet =
    byName.get('xl/worksheets/sheet1.xml') ??
    entries.filter((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))[0]
  if (!sheet) throw new ZipError('반출목록 엑셀에 시트가 없습니다.')
  const xml = (await readEntryBuffer(src, sheet, MAX_PART)).toString('utf8')

  const rows: (string | number | null)[][] = []
  for (const rm of elements(xml, 'row')) {
    if (rows.length >= MAX_ROWS) throw new ZipError(`반출목록 엑셀이 너무 큽니다 (${MAX_ROWS.toLocaleString()}줄 초과).`)
    const row: (string | number | null)[] = []
    let next = 0
    for (const cm of elements(rm.body, 'c')) {
      const attrs = cm.attrs
      const body = cm.body
      const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1]
      const idx = ref ? colIndex(ref) : next
      if (idx >= MAX_COLS) continue
      next = idx + 1
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const v = elements(body, 'v').next().value?.body
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
