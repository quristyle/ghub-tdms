/**
 * TDMS Kick-off 발표자료 (PPTX)
 * HTML 발표자료(docs/발표자료/TDMS_Kickoff_20261124.html)와 같은 내용·같은 꼴.
 * 로고는 레이아웃(마스터 공통부)에 올린다 — 슬라이드마다 다시 넣지 않는다.
 */
const path = require('path')
const pptxgen = require('pptxgenjs')
const SKILL = '/home/quri/.config/Claude/local-agent-mode-sessions/skills-plugin/7710af1b-794d-4ef5-afc5-06250aeef761/dc0e4c7f-dd5e-45c8-ac6d-5d991ab0fcdc/skills/pptx'
const { applyTheme } = require(path.join(SKILL, 'scripts/apply_theme.js'))

const REPO = '/home/quri/ghub-tdms'
const ASSET = path.join(REPO, 'docs/발표자료/assets')
const LOGO = path.join(ASSET, 'logo.png')
const OUT = path.join(REPO, 'docs/발표자료/TDMS_Kickoff_20261124.pptx')

const THEME = {
  name: 'TDMS Kickoff',
  headFontFace: '맑은 고딕',
  bodyFontFace: '맑은 고딕',
  colors: {
    dk1: '17181A', lt1: 'FFFFFF', dk2: '3E3E3A', lt2: 'FBFAF7',
    accent1: '15486E', accent2: '9A4A22', accent3: '1F6B4F',
    accent4: '6F6F68', accent5: 'DEDBD2', accent6: 'EAF0F5',
    hlink: '15486E', folHlink: '6F6F68',
  },
}

const INK = '17181A', WHITE = 'FFFFFF', MUTED = '6F6F68', LINE = 'DEDBD2'
const BLUE = '15486E', BLUESOFT = 'EAF0F5'
const WARN = '9A4A22', WARNSOFT = 'F7EFE9', WARNLINE = 'E2CDBF'
const OK = '1F6B4F', OKSOFT = 'E9F2ED', OKLINE = 'CADCD3'
const BODY = '3E3E3A', PAPER = 'FBFAF7', HI = 'F3F1EA'

const pres = new pptxgen()
pres.layout = 'LAYOUT_WIDE'          // 13.333 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace }
pres.author = '진네트웍스'
pres.company = '진네트웍스'
pres.title = '도면관리 시스템 구축 Kick-off'
pres.subject = '시스템 개발 방향성 설명 및 질의응답'

const M = 0.62                  // 좌우 여백
const W = 13.333 - M * 2        // 본문 폭 = 12.093
const FOOT_Y = 6.93

/* ── 레이아웃(마스터) ─────────────────────────────────────────────
   공통부: 좌하단 로고 아이콘 + 머리말 + 쪽번호. 슬라이드에서는 건드리지 않는다. */
const footerCommon = [
  { image: { x: M, y: FOOT_Y, w: 0.22, h: 0.22, path: LOGO, altText: '진네트웍스 로고' } },
  { text: {
      text: '도면관리 시스템 구축 Kick-off  ·  지허브 × 진네트웍스',
      options: { x: M + 0.3, y: FOOT_Y, w: 7.0, h: 0.22, fontSize: 9, color: '9A998F',
                 align: 'left', valign: 'middle', isTextBox: true, margin: 0 },
  } },
  { text: {
      text: '2026. 11. 24.',
      options: { x: 10.2, y: FOOT_Y, w: 2.1, h: 0.22, fontSize: 9, color: '9A998F',
                 align: 'right', valign: 'middle', isTextBox: true, margin: 0 },
  } },
]

pres.defineSlideMaster({
  title: 'CONTENT',
  background: { color: PAPER },
  objects: [
    ...footerCommon,
    { placeholder: { options: { name: 'eyebrow', type: 'body', x: M, y: 0.40, w: 8.0, h: 0.28,
        fontSize: 10.5, bold: true, color: MUTED, charSpacing: 2, valign: 'middle', margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.70, w: W, h: 0.66,
        fontSize: 30, bold: true, color: INK, align: 'left', valign: 'middle', margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'subtitle', type: 'body', x: M, y: 1.38, w: W, h: 0.36,
        fontSize: 13, color: MUTED, valign: 'middle', margin: 0 }, text: '' } },
  ],
  slideNumber: { x: 12.45, y: FOOT_Y, w: 0.45, h: 0.22, fontSize: 9, color: '9A998F', align: 'right' },
})

pres.defineSlideMaster({
  title: 'DARK',
  background: { color: INK },
  objects: [
    { rect: { x: 0.80, y: 0.80, w: 1.02, h: 1.02, fill: { color: WHITE }, line: { color: WHITE }, rectRadius: 0.1 } },
    { image: { x: 0.87, y: 0.87, w: 0.88, h: 0.88, path: LOGO, altText: '진네트웍스 로고' } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.80, y: 2.05, w: 11.7, h: 1.9,
        fontSize: 40, bold: true, color: WHITE, align: 'left', valign: 'top', margin: 0, lineSpacingMultiple: 1.12 }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.80, y: 4.05, w: 11.0, h: 0.8,
        fontSize: 16, color: 'C9C8C1', valign: 'top', margin: 0, lineSpacingMultiple: 1.3 }, text: '' } },
  ],
})

/* ── 그리기 helper ────────────────────────────────────────────── */
const R = pres.ShapeType.roundRect
const RECT = pres.ShapeType.rect

function card(s, o) {
  const fill = o.variant === 'ink' ? INK
    : o.variant === 'warn' ? WARNSOFT
    : o.variant === 'ok' ? OKSOFT : WHITE
  const border = o.variant === 'ink' ? INK
    : o.variant === 'warn' ? WARNLINE
    : o.variant === 'ok' ? OKLINE : LINE
  s.addShape(R, {
    x: o.x, y: o.y, w: o.w, h: o.h, fill: { color: fill },
    line: { color: border, width: 1 }, rectRadius: 0.06,
    objectName: o.name || 'card',
  })
  const padX = o.padX || 0.26
  let cy = o.y + (o.padY || 0.22)

  if (o.tag) {
    const tagFill = o.variant === 'ink' ? '33332F'
      : o.variant === 'warn' ? 'F0DCCF'
      : o.variant === 'ok' ? 'D8E8E0' : BLUESOFT
    const tagColor = o.variant === 'ink' ? 'E6E5DF'
      : o.variant === 'warn' ? WARN
      : o.variant === 'ok' ? OK : BLUE
    const tw = Math.min(o.w - padX * 2, 0.17 + o.tag.length * 0.13)
    s.addShape(R, { x: o.x + padX, y: cy, w: tw, h: 0.26,
      fill: { color: tagFill }, line: { color: tagFill }, rectRadius: 0.03 })
    s.addText(o.tag, { x: o.x + padX, y: cy, w: tw, h: 0.26, fontSize: 9.5, bold: true,
      color: tagColor, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    cy += 0.40
  }
  if (o.title) {
    const lines = o.title.split('\n').length
    const h = 0.33 * lines
    s.addText(o.title, { x: o.x + padX, y: cy, w: o.w - padX * 2, h,
      fontSize: o.titleSize || 15, bold: true, color: o.variant === 'ink' ? WHITE : INK,
      valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 })
    cy += h + 0.12
  }
  if (o.body) {
    s.addText(o.body, { x: o.x + padX, y: cy, w: o.w - padX * 2, h: o.y + o.h - cy - 0.18,
      fontSize: o.bodySize || 11.5, color: o.variant === 'ink' ? 'C9C8C1' : BODY,
      valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.35 })
  }
}

function stat(s, o) {
  const fill = o.variant === 'warn' ? WARNSOFT : o.variant === 'ok' ? OKSOFT : WHITE
  const border = o.variant === 'warn' ? WARNLINE : o.variant === 'ok' ? OKLINE : LINE
  s.addShape(R, { x: o.x, y: o.y, w: o.w, h: o.h, fill: { color: fill },
    line: { color: border, width: 1 }, rectRadius: 0.06, objectName: 'stat' })
  s.addText(o.value, { x: o.x + 0.24, y: o.y + 0.16, w: o.w - 0.48, h: 0.56,
    fontSize: o.valueSize || 30, bold: true, color: o.color || INK,
    valign: 'middle', isTextBox: true, margin: 0 })
  s.addText(o.label, { x: o.x + 0.24, y: o.y + 0.76, w: o.w - 0.48, h: o.h - 0.92,
    fontSize: 10.5, color: MUTED, valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 })
}

function table(s, o) {
  const head = o.head.map(t => ({ text: t.label, options: {
    bold: true, fontSize: 9.5, color: MUTED, fill: { color: PAPER },
    align: t.align || 'left', valign: 'middle', margin: [0.06, 0.1, 0.06, 0.1],
    border: [{ type: 'none' }, { type: 'none' }, { pt: 1.4, color: INK }, { type: 'none' }],
  } }))
  const rows = o.rows.map(r => r.cells.map((c, i) => ({
    text: typeof c === 'string' ? c : c.text,
    options: Object.assign({
      fontSize: o.fontSize || 11.5,
      color: (typeof c === 'object' && c.color) || BODY,
      bold: (typeof c === 'object' && c.bold) || false,
      align: o.head[i].align || 'left',
      valign: 'middle',
      fill: { color: r.hi ? HI : WHITE },
      margin: [0.07, 0.1, 0.07, 0.1],
      border: [{ type: 'none' }, { type: 'none' }, { pt: 0.8, color: LINE }, { type: 'none' }],
    }),
  })))
  s.addTable([head, ...rows], {
    x: o.x, y: o.y, w: o.w, colW: o.colW, rowH: o.rowH || 0.42,
    autoPage: false, objectName: 'table',
  })
}

function note(s, text, y) {
  s.addShape(RECT, { x: M, y, w: 0.035, h: 0.5, fill: { color: LINE }, line: { color: LINE } })
  s.addText(text, { x: M + 0.16, y, w: W - 0.2, h: 0.5, fontSize: 10.5, color: MUTED,
    valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.3 })
}

function content(sectionTitle, eyebrow, title, subtitle, noteText) {
  const s = pres.addSlide({ masterName: 'CONTENT', sectionTitle })
  s.addText(eyebrow, { placeholder: 'eyebrow' })
  s.addText(title, { placeholder: 'title' })
  if (subtitle) s.addText(subtitle, { placeholder: 'subtitle' })
  if (noteText) s.addNotes(noteText)
  return s
}

/* ── 1. 표지 ─────────────────────────────────────────────────── */
pres.addSection({ title: '표지' })
{
  const s = pres.addSlide({ masterName: 'DARK', sectionTitle: '표지' })
  s.addText('G.HUB TDMS', { x: 2.00, y: 1.08, w: 5, h: 0.5, fontSize: 12, bold: true,
    color: 'B9B8B2', charSpacing: 5, valign: 'middle', isTextBox: true, margin: 0 })
  s.addText('도면관리 시스템 구축\nKick-off Meeting', { placeholder: 'title' })
  s.addText('시스템 개발 방향성 설명 및 질의응답', { placeholder: 'body' })
  const meta = [
    ['일시', '2026. 11. 24. (화) 11:00~11:40'],
    ['장소', '정비동 회의실'],
    ['참석', '지허브 · 진네트웍스'],
    ['개발 착수', '2026. 11. 13.'],
  ]
  meta.forEach((m, i) => {
    const x = 0.80 + i * 3.05
    s.addText(m[0], { x, y: 5.60, w: 2.8, h: 0.26, fontSize: 9.5, color: '8D8C86',
      charSpacing: 2, bold: true, isTextBox: true, margin: 0 })
    s.addText(m[1], { x, y: 5.88, w: 2.8, h: 0.42, fontSize: 13, bold: true, color: WHITE,
      isTextBox: true, margin: 0 })
  })
  s.addNotes('오늘 40분의 목적 두 가지 — 어떤 방향으로 만들고 있는지 보여 드리는 것, 그리고 결정 6건을 확정하는 것입니다.')
}

/* ── 2. 오늘 다룰 것 ─────────────────────────────────────────── */
pres.addSection({ title: '현황 진단' })
{
  const s = content('현황 진단', '01   AGENDA', '오늘 다룰 것', '40분 — 발표 32분 · 질의응답 8분',
    '발표 32분, 질의응답 8분. 궁금한 것은 중간에 말씀하셔도 됩니다.')
  table(s, {
    x: M, y: 2.05, w: W, rowH: 0.62,
    colW: [0.7, 3.0, 6.6, 1.793],
    head: [{ label: '' }, { label: '내용' }, { label: '다루는 것' }, { label: '시간', align: 'right' }],
    rows: [
      { cells: [{ text: '1', bold: true, color: INK }, { text: '현황 진단', bold: true, color: INK },
                '기존 시스템의 성격 · 고쳐야 할 3가지 · 보안 점검', '7분'] },
      { cells: [{ text: '2', bold: true, color: INK }, { text: '개발 방향성', bold: true, color: INK },
                '3원칙 · 승계하는 업무 규칙 · 아키텍처', '10분'] },
      { cells: [{ text: '3', bold: true, color: INK }, { text: '진행 현황', bold: true, color: INK },
                '선행 구축 결과 · 실측 성능', '8분'] },
      { hi: true, cells: [{ text: '4', bold: true, color: INK }, { text: '남은 일과 결정 사항', bold: true, color: INK },
                { text: '전환 일정(안) · 오늘 정해 주실 6건', bold: true, color: INK }, { text: '15분', bold: true, color: INK }] },
    ],
  })
  note(s, '수치는 기존 시스템 소스·DB 전수 분석(2026-10-12 전달본, 11-12 갱신본)과 신규 시스템 실측에 근거합니다.', 5.30)
}

/* ── 3. 조회가 아니라 워크플로 ───────────────────────────────── */
{
  const s = content('현황 진단', '02   현황 진단', '조회 시스템이 아니라 워크플로 엔진',
    '기존 API 201개를 성격별로 분류한 결과 — 순수 조회는 12%뿐입니다',
    '대상의 크기는 크지 않습니다. 중요한 것은 성격입니다. 기존 API 201개 중 순수 조회는 12%뿐이고 88%가 파일을 옮기고 리비전을 올리는 일입니다.')
  const sw = (W - 0.3 * 3) / 4
  const stats = [
    { v: '10,827', k: '도면(TDB)\n파일 16,400개 / 6.5GB' },
    { v: '1,200', k: 'MDB 자료\n설비 데이터북' },
    { v: '201', k: 'API 엔드포인트\n화면 14 · 권한 36' },
    { v: '수십 명', k: '사용자\n설비기술팀 CM 및 사내' },
  ]
  stats.forEach((o, i) => stat(s, { x: M + i * (sw + 0.3), y: 1.95, w: sw, h: 1.42,
    value: o.v, label: o.k, valueSize: i === 3 ? 24 : 30 }))

  const barY = 3.62, barH = 0.46
  s.addShape(RECT, { x: M, y: barY, w: W * 0.12, h: barH, fill: { color: BLUE }, line: { color: BLUE } })
  s.addText('조회 12%', { x: M, y: barY, w: W * 0.12, h: barH, fontSize: 10.5, bold: true,
    color: WHITE, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  s.addShape(RECT, { x: M + W * 0.12, y: barY, w: W * 0.88, h: barH, fill: { color: INK }, line: { color: INK } })
  s.addText('파일 상태 전이 · 워크플로 88%  (반출 · 반입 · 검수 · 리비전 · 보관)',
    { x: M + W * 0.12, y: barY, w: W * 0.88, h: barH, fontSize: 11, bold: true,
      color: WHITE, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })

  const cw = (W - 0.3) / 2
  card(s, { x: M, y: 4.40, w: cw, h: 1.70, variant: 'ink', tag: '그래서',
    body: '성능 설계의 중심은 목록을 빨리 그리는 것이 아니라 파일시스템과 DB의 정합성을 지키면서 상태 전이를 싸게 만드는 것입니다.' })
  card(s, { x: M + cw + 0.3, y: 4.40, w: cw, h: 1.70, tag: '두 도메인',
    body: 'TDB(도면) — 리비전·반출·검수·분기를 가지는 살아 있는 자료\nMDB(데이터북) — Tag 이력만 있는 고정 기록. 신규는 둘을 분리했습니다.' })
}

/* ── 4. 고쳐야 할 3가지 ─────────────────────────────────────── */
{
  const s = content('현황 진단', '03   현황 진단', '고쳐야 할 3가지',
    '기능의 문제가 아니라 구조의 문제 — 부분 수정으로는 풀리지 않습니다',
    '셋 다 기능이 없다는 문제가 아니라 구조가 그렇다는 문제입니다. 부분 수정으로는 풀리지 않습니다.')
  const cw = (W - 0.3 * 2) / 3
  const items = [
    { tag: '① 폴더', title: '폴더가 테이블이 아니라\n문자열이다',
      body: '이름 한 번 바꾸면 수천 건 문자열 수정 + 디스크 파일 이동이 함께 일어납니다.\n\n중간에 실패하면 DB와 디스크가 어긋납니다.' },
    { tag: '② 저장', title: '파일명이 메타데이터를\n들고 있다',
      body: '{도면번호}_Rev00.pdf — 리비전이 오르면 파일 이름이 바뀝니다.\n\n승인 1건마다 디스크 작업이 따라붙고, 같은 파일이 여러 벌 쌓입니다.' },
    { tag: '③ 장시간 작업', title: '엑셀 · Zip · 백업 · 변환이\n동기 실행된다',
      body: '큰 건을 돌리면 화면이 수십 초 멈춥니다.\n\n그동안 다른 사용자의 조회까지 함께 느려집니다.' },
  ]
  items.forEach((o, i) => card(s, Object.assign({ x: M + i * (cw + 0.3), y: 1.95, w: cw, h: 3.50,
    variant: 'warn', titleSize: 16, bodySize: 12 }, o)))
}

/* ── 5. 보안 ─────────────────────────────────────────────────── */
{
  const s = content('현황 진단', '04   현황 진단', '보안 점검 — 보완 과제 25건',
    '양호 통제 20건은 그대로 승계 · 높음 7건은 구조에서 해소합니다',
    '전달해 주신 소스로 수행한 점검 결과입니다. 양호 통제 20건은 그대로 승계하고, 높음 7건은 애플리케이션이 아니라 구조에서 해소했습니다.')
  const sw = (W - 0.3 * 3) / 4
  const stats = [
    { v: '7', k: '높음\n접근통제 · 업로드 · 가용성', variant: 'warn', color: WARN },
    { v: '13', k: '중간\n인증 · 운영 · 데이터' },
    { v: '5', k: '낮음\n경로 · 감사 · 개인정보' },
    { v: '20', k: '양호\n이미 구현된 통제 — 승계', variant: 'ok', color: OK },
  ]
  stats.forEach((o, i) => stat(s, { x: M + i * (sw + 0.3), y: 1.95, w: sw, h: 1.40,
    value: o.v, label: o.k, variant: o.variant, color: o.color }))
  table(s, {
    x: M, y: 3.62, w: W, rowH: 0.52,
    colW: [1.9, 5.2, 4.993],
    head: [{ label: '높음 항목' }, { label: '현상' }, { label: '신규 시스템의 해소 위치' }],
    rows: [
      { cells: ['IP 접근통제', '프록시 뒤에서 허용목록이 무력화', { text: 'nginx 계층으로 이동', color: OK, bold: true }] },
      { cells: ['업로드', '용량 제한 없음 · 형식 검증 부족', { text: '용량 제한 + 매직바이트 검증', color: OK, bold: true }] },
      { cells: ['열람 범위', '로그인만 하면 전 도면 열람 가능', { text: '라우트 선언형 권한 + 기동 시 전수 검증', color: OK, bold: true }] },
      { cells: ['가용성', '이중화·복구 절차 부재', { text: '자동 배포·자동 롤백 + 백업 2중', color: OK, bold: true }] },
    ],
  })
}

/* ── 6. 3원칙 ───────────────────────────────────────────────── */
pres.addSection({ title: '개발 방향성' })
{
  const s = content('개발 방향성', '05   개발 방향성', '개발 방향성 — 3원칙',
    '기능 100% 보존 · 관리성과 성능 1순위 · 동등성은 증명',
    '세 문장으로 줄이면 — 기능은 깎지 않는다, 관리성과 성능을 1순위로 다시 짠다, 같다는 것은 증명한다.')
  const cw = (W - 0.3 * 2) / 3
  const items = [
    { tag: '원칙 1', title: '기능을 깎지 않는다',
      body: '메뉴 9 · 화면 14 · 권한 36 · API 201을 전수 목록으로 고정하고 그대로 재현합니다.\n\n쓰시던 화면 구성과 용어를 그대로 두어 재교육 부담이 없습니다. 범위 축소는 CM 결정 사항입니다.' },
    { tag: '원칙 2', title: '관리성과 성능이 1순위',
      body: '같은 기능을 고치기 쉬운 구조로 다시 짭니다 — 타입 1벌 공유, 권한·감사는 선언하지 않으면 서버가 뜨지 않습니다.\n\n성능 기준을 자동 검사에 걸어 느려지면 빌드가 실패합니다.' },
    { tag: '원칙 3', title: '동등성은 증명한다',
      body: '① API 201개 계약 대조\n② 화면 요소 자동 대조\n③ 신·구 서버 응답 비교(섀도 2주)\n\n데이터 이행은 건수와 sha256 전수 일치로 확인합니다. 눈 검사로 대체하지 않습니다.' },
  ]
  items.forEach((o, i) => card(s, Object.assign({ x: M + i * (cw + 0.3), y: 1.95, w: cw, h: 3.50,
    variant: 'ink', titleSize: 16, bodySize: 12 }, o)))
}

/* ── 7. 바꾸지 않는 것 ──────────────────────────────────────── */
{
  const s = content('개발 방향성', '06   개발 방향성', '바꾸지 않는 것 — 업무 규칙',
    'CM이 확정해 둔 규칙은 설계 문서가 아니라 실행되는 테스트로 고정했습니다',
    '가장 걱정하실 부분입니다. 업무 규칙은 하나도 바꾸지 않았습니다. 특히 자동 병합을 하지 않는 것 — 사람이 CAD로 합친 것만 정식 리비전이 됩니다.')
  table(s, {
    x: M, y: 1.95, w: W, rowH: 0.62, fontSize: 11.5,
    colW: [3.9, 8.193],
    head: [{ label: '규칙' }, { label: '신규 시스템에서' }],
    rows: [
      { cells: [{ text: '삭제 기능이 없다', bold: true, color: INK }, '보관함(삭제·폐기)으로 옮기고 복구 가능 — 어떤 경우에도 줄을 지우지 않습니다'] },
      { hi: true, cells: [{ text: '도면을 자동 병합하지 않는다', bold: true, color: INK }, 'A·B 업체 동시 수정은 분기로 각각 보관 + ‘병합 필요’ — 사람이 CAD로 합친 것만 정식 Rev'] },
      { cells: [{ text: '리비전은 승인돼야 오른다', bold: true, color: INK }, '반려는 정수를 소모하지 않고 글자(a·b·c)로 이력에 남습니다'] },
      { cells: [{ text: '감사 로그는 고칠 수 없다', bold: true, color: INK }, '애플리케이션이 아니라 DB 권한 수준에서 수정·삭제를 차단합니다'] },
      { cells: [{ text: '‘최신’ 폴더는 그대로 남는다', bold: true, color: INK }, '야간 배치가 하드링크로 재구성 — 탐색기에서 그대로 복사해 가실 수 있습니다'] },
      { cells: [{ text: '중복 반출을 막지 않는다', bold: true, color: INK }, '경고만 합니다 — 막으면 분기 흐름이 성립하지 않습니다'] },
    ],
  })
}

/* ── 8. 아키텍처 ────────────────────────────────────────────── */
{
  const s = content('개발 방향성', '07   개발 방향성', '아키텍처 — 프로세스 3종, 미들웨어 0개',
    'Ubuntu 24.04 · PostgreSQL 16 · Fastify(Node 22) · Vue 3 · Python 워커 — 장애 지점이 셋뿐입니다',
    '프로세스는 세 종류뿐입니다. Redis도 메시지 브로커도 쓰지 않습니다. 오래 걸리는 일은 DB에 쌓고 워커가 집어 가며, 진행률이 화면에 흐릅니다.')

  function box(o) {
    s.addShape(R, { x: o.x, y: o.y, w: o.w, h: o.h, rectRadius: 0.06,
      fill: { color: o.fill || WHITE }, line: { color: o.line || LINE, width: 1.2 }, objectName: 'arch' })
    s.addText(o.title, { x: o.x + 0.1, y: o.y + 0.12, w: o.w - 0.2, h: 0.3, fontSize: 12.5, bold: true,
      color: o.titleColor || INK, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    if (o.lines) {
      s.addText(o.lines.map((t, i) => ({ text: t, options: { breakLine: i < o.lines.length - 1,
        color: (o.hl === i) ? 'F0C694' : (o.subColor || MUTED) } })),
        { x: o.x + 0.1, y: o.y + 0.44, w: o.w - 0.2, h: o.h - 0.54, fontSize: 9.5,
          align: 'center', valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.35 })
    }
  }
  function arrow(x1, y1, x2, y2) {
    s.addShape(pres.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1,
      line: { color: MUTED, width: 1.2, endArrowType: 'triangle' } })
  }

  const topY = 1.92, topH = 1.28
  box({ x: M, y: topY + 0.22, w: 1.55, h: 0.84, title: '브라우저', lines: ['Vue 3 SPA'] })
  box({ x: M + 1.95, y: topY, w: 3.25, h: topH, fill: INK, line: INK, title: 'nginx', titleColor: WHITE,
    subColor: 'C9C8C1', hl: 1, lines: ['TLS · 접근 IP 제한 · 업로드 제한', '파일은 커널이 직송 — 앱을 거치지 않음', 'API 는 유닉스 소켓으로'] })
  box({ x: M + 5.6, y: topY, w: 3.0, h: topH, title: 'API — Fastify / Node 22',
    lines: ['세션 · 선언형 권한 · 감사 기록', '업무 규칙 · SQL', '파일 바이트를 만지지 않는다'] })
  box({ x: M + 9.0, y: topY, w: 3.09, h: topH, fill: 'F6F4EE', title: 'blob 저장소',
    lines: ['내용 해시(sha256)로 주소를 삼는다', '불변 · 중복 자동 제거', '읽는 이름은 받는 시점에 만든다'] })

  box({ x: M + 4.0, y: 3.62, w: 4.8, h: 0.98, fill: BLUESOFT, line: 'BCD0DE', title: 'PostgreSQL 16',
    lines: ['업무 데이터 · 세션 · 폴더 트리 · 한글 검색', '작업 큐 · 캐시 무효화 방송'] })
  box({ x: M + 4.0, y: 4.92, w: 4.8, h: 0.78, title: '워커 — Python 3.12',
    lines: ['DWG·오피스 변환 · Zip · 엑셀 · 백업 · 대량 반입'] })

  arrow(M + 1.58, topY + 0.64, M + 1.92, topY + 0.64)
  arrow(M + 5.23, topY + 0.64, M + 5.57, topY + 0.64)
  arrow(M + 8.63, topY + 0.64, M + 8.97, topY + 0.64)
  arrow(M + 7.1, topY + topH + 0.02, M + 7.1, 3.59)
  arrow(M + 6.1, 4.62, M + 6.1, 4.89)
  arrow(M + 6.7, 4.89, M + 6.7, 4.62)
  s.addText('유닉스 소켓', { x: M + 7.2, y: 3.26, w: 1.6, h: 0.26, fontSize: 9, color: '8D8C86', isTextBox: true, margin: 0 })
  s.addText('작업을 집어 가고 진행률을 적는다', { x: M + 6.9, y: 4.62, w: 2.6, h: 0.26, fontSize: 9, color: '8D8C86', isTextBox: true, margin: 0 })

  note(s, '오래 걸리는 일 — 요청 즉시 작업번호를 돌려주고(화면이 멈추지 않음) → 워커가 처리 → 진행률 실시간 표시 → 받기.\n엑셀·Zip·백업·변환 전부 같은 길입니다. PDF 뷰어와 마크업 기능은 기존 자산을 그대로 이식했습니다.', 5.95)
}

/* ── 9. 파일을 움직이지 않는다 ──────────────────────────────── */
{
  const s = content('개발 방향성', '08   개발 방향성', '핵심은 하나 — 파일을 움직이지 않는다',
    '폴더를 바꾸든 리비전을 올리든 디스크는 그대로. DB 트랜잭션만 돕니다',
    '앞의 세 문제가 어떻게 풀렸는지입니다. 디스크를 건드리지 않으니 중간에 실패해도 어긋남이 없습니다.')
  table(s, {
    x: M, y: 1.95, w: W, rowH: 0.64,
    colW: [3.4, 4.3, 4.393],
    head: [{ label: '작업' }, { label: '기존 (경로 기반)' }, { label: '신규 (내용 해시 기반)' }],
    rows: [
      { cells: [{ text: '폴더 이름 변경 (하위 500건)', bold: true, color: INK },
                { text: '문자열 500건 수정 + 디스크 이동 500건', color: WARN },
                { text: '줄 1개 수정 — 수십 초 → 1ms 미만', color: OK, bold: true }] },
      { cells: [{ text: '리비전 승인 · 자료 이동', bold: true, color: INK },
                { text: '디스크 rename·이동 + DB 수정', color: WARN },
                { text: 'DB 수정만 — 디스크 작업 0', color: OK, bold: true }] },
      { cells: [{ text: '같은 파일 중복', bold: true, color: INK },
                { text: '그대로 중복 저장', color: WARN },
                { text: '내용이 같으면 한 벌만 저장', color: OK, bold: true }] },
      { hi: true, cells: [{ text: '작업 중간 실패', bold: true, color: INK },
                { text: 'DB와 디스크가 어긋남 — 수동 복구', color: WARN },
                { text: '되감기로 끝 — 정합성 보장', color: OK, bold: true }] },
      { cells: [{ text: '엑셀 · Zip · 백업', bold: true, color: INK },
                { text: '화면이 멈춘 채 대기', color: WARN },
                { text: '즉시 응답 + 진행률 표시', color: OK, bold: true }] },
    ],
  })
  note(s, '‘최신’ 폴더는 그대로 유지됩니다. 야간 배치가 하드링크로 트리를 다시 만들어 두므로 디스크를 추가로 쓰지 않습니다.', 6.05)
}

/* ── 10. 성능 ───────────────────────────────────────────────── */
pres.addSection({ title: '진행 현황' })
{
  const s = content('진행 현황', '09   진행 현황', '성능 — 실제 규모의 5배로 측정',
    '도면 52,000건을 적재해 측정한 결과 · 전 항목이 목표치 아래입니다',
    '말로만 빠르다고 하면 의미가 없어 실제 규모의 5배인 5만 2천 건으로 쟀습니다. 이 수치는 자동 검사에 기준으로 걸려 있어 느려지면 빌드가 실패합니다.')
  const tw = 7.1
  table(s, {
    x: M, y: 1.95, w: tw, rowH: 0.56,
    colW: [3.0, 1.35, 1.25, 1.5],
    head: [{ label: '항목' }, { label: '기존', align: 'right' }, { label: '목표', align: 'right' }, { label: '실측', align: 'right' }],
    rows: [
      { cells: ['목록 · 검색', { text: '2초', color: WARN }, '150ms', { text: '0.07ms', color: OK, bold: true }] },
      { cells: ['깊은 페이지 (37,000번째)', { text: '느려짐', color: WARN }, '동일', { text: '2.45ms', color: OK, bold: true }] },
      { cells: ['한글 부분일치 검색', { text: '—', color: WARN }, '150ms', { text: '1.57ms', color: OK, bold: true }] },
      { hi: true, cells: ['폴더 이름 변경 (하위 38,000)', { text: '수십 초', color: WARN }, '50ms', { text: '0.89ms', color: OK, bold: true }] },
      { cells: ['첫 화면 전송량', { text: '—', color: WARN }, '150KB', { text: '43KB', color: OK, bold: true }] },
    ],
  })
  const cx = M + tw + 0.35, cw = W - tw - 0.35
  card(s, { x: cx, y: 1.95, w: cw, h: 1.95, variant: 'ok', tag: '측정하다 찾아낸 것', bodySize: 11.5,
    body: '목록 1페이지에서 인덱스가 쓰이지 않아 51ms 가 걸리던 것을 발견해 바로잡았습니다 → 0.2ms (255배).\n소량 데이터로는 드러나지 않는 종류입니다.' })
  card(s, { x: cx, y: 4.08, w: cw, h: 1.95, variant: 'ink', tag: '성능을 지키는 방법', bodySize: 11.5,
    body: '기준치를 자동 검사에 걸어 두어 기준을 넘기는 코드는 배포되지 않습니다.\n1년 뒤에도 같은 속도를 유지하기 위한 장치입니다.' })
}

/* ── 11. 진행 현황 ──────────────────────────────────────────── */
{
  const s = content('진행 현황', '10   진행 현황', '8단계 중 7단계 완료',
    '착수(2026-11-13) 전 선행 구축분 포함 · 화면 14개가 모두 실제 동작으로 채워졌습니다',
    '11월 13일 착수 전에 기존 소스와 전달 자료로 선행 작업을 진행해 두었습니다. 요청하시면 지금 실제 화면을 띄워 보여 드리겠습니다.')
  const phases = [
    ['단계 0', '기준선'], ['단계 1', '데이터 모델'], ['단계 2', '골격·권한'], ['단계 3', '조회·뷰어'],
    ['단계 4', '반입·검수'], ['단계 5', '반출이력'], ['단계 6', 'MDB'], ['단계 7', '운영·관리'],
    ['단계 8', '이행·전환'],
  ]
  const pw = (W - 0.14 * 8) / 9
  phases.forEach((p, i) => {
    const now = i === 8
    const x = M + i * (pw + 0.14)
    s.addShape(R, { x, y: 1.95, w: pw, h: 1.05, rectRadius: 0.05,
      fill: { color: now ? INK : OKSOFT }, line: { color: now ? INK : OKLINE, width: 1 }, objectName: 'phase' })
    s.addText(p[0], { x: x + 0.06, y: 2.03, w: pw - 0.12, h: 0.22, fontSize: 8.5,
      color: now ? '9B9A94' : MUTED, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    s.addText(p[1], { x: x + 0.06, y: 2.25, w: pw - 0.12, h: 0.34, fontSize: 11, bold: true,
      color: now ? WHITE : INK, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    s.addText(now ? '진행 예정' : '완료', { x: x + 0.06, y: 2.60, w: pw - 0.12, h: 0.26, fontSize: 9, bold: true,
      color: now ? 'F0C694' : OK, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  })
  const sw = (W - 0.3 * 3) / 4
  const stats = [
    { v: '14 +4', k: '화면 구현 완료 · 미완성 0' },
    { v: '36', k: '권한 리프 전수 동작' },
    { v: '138', k: '업무 흐름 자동 검증 통과' },
    { v: '11', k: '전환 전에 찾아 고친 결함' },
  ]
  stats.forEach((o, i) => stat(s, { x: M + i * (sw + 0.3), y: 3.30, w: sw, h: 1.30, value: o.v, label: o.k }))
  note(s, '소스를 올리면 검사 → 빌드 → 배포 → 상태 확인이 자동으로 돌고, 실패하면 직전 버전으로 되돌아갑니다.\n요청하시면 이 자리에서 실제 화면을 띄워 보여 드립니다.', 4.95)
}

/* ── 12. 남은 일 ────────────────────────────────────────────── */
pres.addSection({ title: '남은 일과 결정' })
{
  const s = content('남은 일과 결정', '11   남은 일', '남은 일 — 옮기고, 맞는지 증명하고, 바꿔 단다',
    '기능 개발이 아니라 전환 작업입니다',
    '남은 것은 전환입니다. 네 덩어리인데 1번과 3번은 지허브 협조가 있어야 시작됩니다.')
  const cw = (W - 0.3 * 3) / 4
  const items = [
    { tag: '1 · 데이터 이행', title: '기존 DB·파일을\n새 구조로',
      body: '폴더 문자열을 트리로 분해 · 파일 16,400개 재배치\n\n검증 — 건수와 sha256 전수 대조. 리허설로 소요 시간을 먼저 잽니다.' , flag: '※ 기존 자료 수령 필요' },
    { tag: '2 · 변환 워커', title: 'DWG·오피스\n미리보기',
      body: '변환 엔진을 운영 서버에 설치하고 대량 반입·Zip·백업을 실환경에서 검증합니다.' },
    { tag: '3 · 동등성 검증', title: '섀도 비교 2주',
      body: '신·구 서버에 같은 조회를 보내 응답을 비교합니다. 쓰기는 기존 시스템에서만 — 업무에 영향이 없습니다.', flag: '※ CM 확인 참여 필요' },
    { tag: '4 · 전환', title: '병행 운영 →\n전환 → 안정화',
      body: '교육(화면이 같아 짧게) · 전환일 확정 · 전환 후 밀착 대응.\n\n실패 시 기존 시스템으로 즉시 되돌릴 수 있는 상태를 유지합니다.' },
  ]
  items.forEach((o, i) => {
    const x = M + i * (cw + 0.3)
    card(s, { x, y: 1.95, w: cw, h: 3.75, tag: o.tag, title: o.title, body: o.body, titleSize: 14, bodySize: 11 })
    if (o.flag) s.addText(o.flag, { x: x + 0.26, y: 5.22, w: cw - 0.52, h: 0.3, fontSize: 10.5,
      bold: true, color: WARN, isTextBox: true, margin: 0 })
  })
}

/* ── 13. 일정 ───────────────────────────────────────────────── */
{
  const s = content('남은 일과 결정', '12   일정', '일정(안) — 오늘 협의로 확정',
    'Kick-off(11/24) 기준 8주 · 자료 수령과 환경 확정 시점에 따라 조정됩니다',
    '일정은 안입니다. 전제 두 가지 — 11월 말 자료 수령, 12월 첫 주 환경 확정. 이 둘이 밀리면 전체가 같은 만큼 밀립니다.')
  const labelW = 3.5, gx = M + labelW, gw = W - labelW, colW = gw / 8
  const weeks = ['11/24', '12/01', '12/08', '12/15', '12/22', '12/29', '01/05', '01/12']
  const rowH = 0.42, top = 2.30
  weeks.forEach((w, i) => s.addText(w, { x: gx + i * colW, y: 1.98, w: colW, h: 0.26, fontSize: 9,
    color: MUTED, align: 'center', valign: 'middle', isTextBox: true, margin: 0 }))
  s.addShape(RECT, { x: M, y: 2.26, w: W, h: 0.016, fill: { color: INK }, line: { color: INK } })

  const rows = [
    { t: '기존 DB·파일 수령 / 환경 확정', bars: [[0, 2, 'blue']] },
    { t: '데이터 이행 설계 · 리허설', bars: [[1, 2, 'ink']] },
    { t: '변환 워커 · 백업 실환경 검증', bars: [[2, 2, 'ink']] },
    { t: '기준선 대조 · 성능 검사', bars: [[2, 2, 'soft']] },
    { t: '섀도 비교 운영 (2주)', bars: [[4, 3, 'ink']] },
    { t: 'CM 확인 · 사용자 교육', bars: [[6, 2, 'soft']] },
    { t: '본 이행 → 전환 → 안정화', bars: [[7, 1, 'blue']], bold: true },
  ]
  rows.forEach((r, i) => {
    const y = top + i * rowH
    s.addText(r.t, { x: M, y, w: labelW - 0.12, h: rowH, fontSize: 11, bold: !!r.bold,
      color: r.bold ? INK : BODY, valign: 'middle', isTextBox: true, margin: 0 })
    r.bars.forEach(([start, len, kind]) => {
      s.addShape(RECT, { x: gx + start * colW + 0.04, y: y + 0.10, w: colW * len - 0.08, h: rowH - 0.20,
        fill: { color: kind === 'blue' ? BLUE : kind === 'soft' ? 'C8C6BA' : INK },
        line: { color: kind === 'blue' ? BLUE : kind === 'soft' ? 'C8C6BA' : INK }, objectName: 'bar' })
    })
    s.addShape(RECT, { x: M, y: y + rowH - 0.008, w: W, h: 0.008, fill: { color: LINE }, line: { color: LINE } })
  })

  const cw = (W - 0.3) / 2
  card(s, { x: M, y: 5.32, w: cw, h: 1.28, variant: 'warn', tag: '전제 1', bodySize: 11,
    body: '11월 말까지 기존 DB 스냅샷과 파일 원본을 받아야 이행 설계를 시작할 수 있습니다.' })
  card(s, { x: M + cw + 0.3, y: 5.32, w: cw, h: 1.28, variant: 'warn', tag: '전제 2', bodySize: 11,
    body: '12월 첫 주까지 운영 환경(사내 서버 / AWS)이 확정되어야 설치·보안 작업이 시작됩니다.' })
}

/* ── 14. 협의·결정 ──────────────────────────────────────────── */
{
  const s = content('남은 일과 결정', '13   협의·결정', '오늘 정해 주셔야 할 것 — 6건',
    '①④는 오늘 방향 확정 요청 · 나머지는 12월 첫 주까지',
    '오늘의 핵심입니다. 1번과 4번은 방향만이라도 오늘 정해 주시면 다음 주가 굴러갑니다.')
  table(s, {
    x: M, y: 1.95, w: W, rowH: 0.66, fontSize: 11,
    colW: [0.5, 4.0, 7.593],
    head: [{ label: '#', align: 'center' }, { label: '항목' }, { label: '저희 권고 · 요청' }],
    rows: [
      { hi: true, cells: [{ text: '1', bold: true, color: BLUE }, { text: '운영 환경 — 사내 서버 / AWS 이관', bold: true, color: INK },
          '먼저 사내 Linux 서버로 전환, AWS 이관은 안정화 후 별도 단계 (AWS 운영비 참고: 월 약 66만 원)'] },
      { cells: [{ text: '2', bold: true, color: BLUE }, { text: 'DB 구성 — 현 서버 / RDS', bold: true, color: INK },
          '①의 결정을 따릅니다. 사내 전환이면 현 PostgreSQL 16 유지 + 백업 2중화'] },
      { cells: [{ text: '3', bold: true, color: BLUE }, { text: '도면 유출 방지 범위', bold: true, color: INK },
          '1차 우선 — 워터마크 · 열람 이력 · 다운로드 상한 (비용 대비 효과 최대)'] },
      { hi: true, cells: [{ text: '4', bold: true, color: BLUE }, { text: '기존 데이터 제공 — 창구와 시점', bold: true, color: INK },
          '11월 말까지 1차 스냅샷 · 본 이행은 업무 외 시간에 수행'] },
      { cells: [{ text: '5', bold: true, color: BLUE }, { text: '검증 참여 — CM 인원·기간', bold: true, color: INK },
          '담당 CM 1~2명, 섀도 비교 2주 동안 주 2회 각 1시간 수준'] },
      { cells: [{ text: '6', bold: true, color: BLUE }, { text: '인수 기준 합의', bold: true, color: INK },
          '기능 체크리스트 전수 + 성능 기준 통과 + sha256 전수 일치 + 업무 흐름 1회전 성공'] },
    ],
  })
}

/* ── 15. 맺음 ───────────────────────────────────────────────── */
pres.addSection({ title: '맺음' })
{
  const s = pres.addSlide({ masterName: 'DARK', sectionTitle: '맺음' })
  s.addText('Q & A', { x: 2.00, y: 1.08, w: 5, h: 0.5, fontSize: 12, bold: true,
    color: 'B9B8B2', charSpacing: 5, valign: 'middle', isTextBox: true, margin: 0 })
  s.addText('기능은 그대로, 구조는 다시,\n같다는 것은 증명으로.', { placeholder: 'title' })
  s.addText('쓰시던 화면과 업무 규칙은 바꾸지 않습니다. 느리고 위험하던 자리만 구조를 바꿨습니다.', { placeholder: 'body' })
  const meta = [
    ['오늘 요청', '결정 6건 · 자료 수령 일정'],
    ['다음 주', '데이터 이행 설계 착수'],
    ['회의록', '당일 공유 · 결정 사항 확인 요청'],
  ]
  meta.forEach((m, i) => {
    const x = 0.80 + i * 3.9
    s.addText(m[0], { x, y: 5.60, w: 3.6, h: 0.26, fontSize: 9.5, color: '8D8C86',
      charSpacing: 2, bold: true, isTextBox: true, margin: 0 })
    s.addText(m[1], { x, y: 5.88, w: 3.6, h: 0.42, fontSize: 13, bold: true, color: WHITE,
      isTextBox: true, margin: 0 })
  })
  s.addNotes('정리하면 — 기능은 그대로, 구조는 다시, 같다는 것은 증명으로. 결정 6건과 자료 수령 일정만 주시면 다음 주부터 이행에 들어갑니다.')
}

;(async () => {
  await pres.writeFile({ fileName: OUT })
  await applyTheme(OUT, THEME)
  console.log('wrote', OUT)
})()
