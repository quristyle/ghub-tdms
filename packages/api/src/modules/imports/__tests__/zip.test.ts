import { describe, expect, it } from 'vitest'
import { crc32, deflateRawSync } from 'node:zlib'
import { bufferSource, openEntry, readEntries, readEntryBuffer, ZipError } from '../zip.js'
import { readFirstSheet } from '../xlsx.js'

/** 시험용 Zip 만들기 — 이름은 UTF-8 표시를 켜거나(기본) 끈 채로 적는다 */
function makeZip(
  items: { name: string | Buffer; data: Buffer; deflate?: boolean; utf8?: boolean; lieSize?: number }[],
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const it of items) {
    const name = typeof it.name === 'string' ? Buffer.from(it.name, 'utf8') : it.name
    const body = it.deflate ? deflateRawSync(it.data) : it.data
    const flags = it.utf8 === false ? 0 : 0x0800
    const method = it.deflate ? 8 : 0
    const crc = crc32(it.data)
    const size = it.lieSize ?? it.data.length

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(size, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(flags, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(size, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

async function drain(s: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of s) parts.push(c as Buffer)
  return Buffer.concat(parts)
}

describe('Zip 읽기', () => {
  it('stored·deflate 항목을 푼다', async () => {
    const big = Buffer.from('도면'.repeat(1000))
    const src = bufferSource(makeZip([
      { name: '5. DRAWINGS/', data: Buffer.alloc(0) },
      { name: '5. DRAWINGS/T-1_Rev01.pdf', data: Buffer.from('%PDF-1.4 x') },
      { name: '5. DRAWINGS/T-1_Rev01.dwg', data: big, deflate: true },
    ]))
    const entries = await readEntries(src)
    expect(entries.map((e) => [e.name, e.isDir])).toEqual([
      ['5. DRAWINGS/', true],
      ['5. DRAWINGS/T-1_Rev01.pdf', false],
      ['5. DRAWINGS/T-1_Rev01.dwg', false],
    ])
    expect((await drain(await openEntry(src, entries[1]!))).toString()).toBe('%PDF-1.4 x')
    expect((await drain(await openEntry(src, entries[2]!))).equals(big)).toBe(true)
  })

  it('UTF-8 표시 없는 한글 이름은 CP949 로 읽는다', async () => {
    const cp949 = Buffer.from([0xb5, 0xb5, 0xb8, 0xe9, 0x2e, 0x70, 0x64, 0x66]) // "도면.pdf"
    const entries = await readEntries(bufferSource(makeZip([{ name: cp949, data: Buffer.from('%PDF-'), utf8: false }])))
    expect(entries[0]!.name).toBe('도면.pdf')
  })

  it('상위 폴더로 나가는 경로·절대 경로가 있으면 Zip 전체를 거부한다', async () => {
    await expect(readEntries(bufferSource(makeZip([{ name: 'a/../../x.pdf', data: Buffer.from('x') }]))))
      .rejects.toBeInstanceOf(ZipError)
    await expect(readEntries(bufferSource(makeZip([{ name: '/etc/x.pdf', data: Buffer.from('x') }]))))
      .rejects.toBeInstanceOf(ZipError)
    await expect(readEntries(bufferSource(makeZip([{ name: 'C:\\x.pdf', data: Buffer.from('x') }]))))
      .rejects.toBeInstanceOf(ZipError)
  })

  it('적힌 크기보다 더 풀리면 끊는다 (압축 폭탄)', async () => {
    const data = Buffer.alloc(100_000)
    const src = bufferSource(makeZip([{ name: 'bomb.dwg', data, deflate: true, lieSize: 1000 }]))
    const [e] = await readEntries(src)
    await expect(drain(await openEntry(src, e!))).rejects.toThrow(/압축 폭탄/)
  })

  it('압축률이 비정상이면 목록 단계에서 거부한다', async () => {
    const data = Buffer.alloc(50 * 1024 * 1024)
    await expect(readEntries(bufferSource(makeZip([{ name: 'z.dwg', data, deflate: true }]))))
      .rejects.toThrow(/압축률/)
  })

  it('Zip 이 아니면 거부한다', async () => {
    await expect(readEntries(bufferSource(Buffer.from('not a zip at all')))).rejects.toBeInstanceOf(ZipError)
  })

  it('작은 항목을 통째로 읽는다', async () => {
    const src = bufferSource(makeZip([{ name: 'a.txt', data: Buffer.from('hello'), deflate: true }]))
    const [e] = await readEntries(src)
    expect((await readEntryBuffer(src, e!, 100)).toString()).toBe('hello')
    await expect(readEntryBuffer(src, e!, 2)).rejects.toBeInstanceOf(ZipError)
  })
})

describe('반출목록.xlsx 읽기', () => {
  it('공유 문자열·숫자·인라인 문자열·빈 칸', async () => {
    const shared = '<sst><si><t>문서ID</t></si><si><t>업체</t></si><si><r><t>대한</t></r><r><t>엔지니어링</t></r></si><si><t>A&amp;B</t></si></sst>'
    const sheet =
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>2001</v></c><c r="B2" t="s"><v>2</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>2002</t></is></c><c r="C3" t="s"><v>3</v></c></row>' +
      '<row r="4"><c r="A4" s="1"/></row>' +
      '</sheetData></worksheet>'
    const xlsx = makeZip([
      { name: 'xl/sharedStrings.xml', data: Buffer.from(shared), deflate: true },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet), deflate: true },
    ])
    expect(await readFirstSheet(xlsx)).toEqual([
      ['문서ID', '업체'],
      [2001, '대한엔지니어링'],
      ['2002', null, 'A&B'],
      [null],
    ])
  })
})
