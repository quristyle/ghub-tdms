/**
 * 표를 엑셀(.xlsx)로 내려받기 — SheetJS.
 *
 * ## SheetJS 를 **정적으로 묶지 않는다**
 *
 * 이 앱의 첫 진입 번들은 62KB(gzip)다. SheetJS 는 그것만으로 100KB 를 넘는다.
 * 정적으로 import 하면 엑셀을 한 번도 안 누르는 사람까지 매번 그걸 받는다.
 * 그래서 **누르는 순간에만** 동적 import 로 가져온다 —
 *   · 첫 화면 속도는 그대로 (번들이 1바이트도 늘지 않는다)
 *   · 받아 온 청크는 브라우저가 캐시하므로 두 번째부터는 즉시
 * import() 는 Vite 가 알아서 따로 떼어 낸 청크로 만든다.
 */

/** 버튼이 두 번 눌려도 두 번 받지 않는다 — 같은 약속을 돌려준다. */
let loading: Promise<typeof import('xlsx')> | null = null
const sheetjs = () => (loading ??= import('xlsx'))

/**
 * 숫자 칸으로 넣을 값인가.
 * "010-1234-5678" 과 "0038"(사번)은 **넣으면 안 된다** — 앞의 0 이 날아가고
 * 전화번호가 뺄셈으로 읽힌다. 앞자리 0 이나 기호가 섞이면 글자로 둔다.
 */
export function numeric(v: string): boolean {
  if (!/^-?\d+(\.\d+)?$/.test(v)) return false
  if (/^-?0\d/.test(v)) return false
  return Math.abs(Number(v)) < 1e15
}

/** 시트 이름은 31자가 한계이고 못 쓰는 글자가 있다 — 넘기면 엑셀이 파일을 못 연다. */
function safeSheetName(s: string): string {
  const cleaned = s.replace(/[\\/?*[\]:]/g, ' ').trim()
  return (cleaned || 'Sheet1').slice(0, 31)
}

/** 한글은 폭이 두 배다. 열어서 바로 읽히게 칸 너비를 대충 맞춰 준다. */
function widthOf(s: string): number {
  let n = 0
  for (const ch of s) n += /[ᄀ-ᇿ㄰-㆏가-힯]/.test(ch) ? 2 : 1
  return n
}

export interface XlsxSheet {
  sheetName: string
  headers: string[]
  /** 화면에 보이는 그대로의 문자열. 숫자처럼 생긴 것만 숫자 칸이 된다. */
  rows: string[][]
}

/**
 * 파일로 내려받는다. SheetJS 를 받아 오는 동안 잠깐 걸릴 수 있으므로
 * 부르는 쪽에서 진행 표시를 할 수 있게 Promise 를 돌려준다.
 */
export async function downloadXlsx(baseName: string, s: XlsxSheet): Promise<void> {
  const XLSX = await sheetjs()

  const aoa: (string | number)[][] = [
    s.headers,
    ...s.rows.map((r) => r.map((v) => (numeric(v) ? Number(v) : v))),
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  ws['!cols'] = s.headers.map((h, i) => ({
    wch: Math.min(60, Math.max(8, Math.max(widthOf(h), ...s.rows.slice(0, 300).map((r) => widthOf(r[i] ?? ''))) + 2)),
  }))
  // 틀고정(머리글 얼리기)은 넣지 않는다 — SheetJS 커뮤니티 빌드는 쓰기에서
  // '!freeze' 를 무시한다. 실제로 만들어 openpyxl 로 열어 보니 freeze_panes 가
  // None 이었다. 동작하지 않는 설정을 코드에 남기지 않는다.

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(s.sheetName))

  const p2 = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`
  const safe = baseName.replace(/[\\/:*?"<>|]/g, '_').trim() || '목록'

  XLSX.writeFile(wb, `${safe}_${stamp}.xlsx`, { compression: true })
}
