/**
 * 도면관리 시스템(TDMS) 구축 — 프로젝트 Kick-off (20장)
 *
 * 구성은 software_project_kickoff_20slides.pptx / _speaker_notes.docx 를 따르고,
 * 내용은 TDMS 실제 분석·설계·현황으로 채웠다.
 * 수행 기간 2026-11-17 ~ 2027-01-15 (9주).  로고는 레이아웃(마스터)에만 올린다.
 */
const path = require('path')
const pptxgen = require('pptxgenjs')
const SKILL = '/home/quri/.config/Claude/local-agent-mode-sessions/skills-plugin/7710af1b-794d-4ef5-afc5-06250aeef761/dc0e4c7f-dd5e-45c8-ac6d-5d991ab0fcdc/skills/pptx'
const { applyTheme } = require(path.join(SKILL, 'scripts/apply_theme.js'))

const REPO = '/home/quri/ghub-tdms'
const LOGO = path.join(REPO, 'docs/발표자료/assets/logo.png')
const BG = path.join(REPO, 'docs/발표자료/bg.jpeg')
const OUT = path.join(REPO, 'docs/발표자료/TDMS_Project_Kickoff_20261124.pptx')

/* 팔레트 — 참고 자료의 네이비·블루 계열을 TDMS 쪽으로 조였다 */
const NAVY = '12304B', NAVY2 = '1B4A72', BLUE = '2A6FA8', CYAN = '2E9BB5'
const PANEL = 'EDF3F9', PANEL_LN = 'CFDEEC'
const INK = '17202B', BODY = '45505C', MUTED = '78848F', LINE = 'DCE3EA'
const WHITE = 'FFFFFF', SOFT = 'F7F9FB'
const WARN = 'A2552B', WARNSOFT = 'FBF1EA', WARNLN = 'E8D3C2'
const OK = '1F6B4F', OKSOFT = 'EAF3EF', OKLN = 'C9DDD4'

const THEME = {
  name: 'TDMS Project Kickoff',
  headFontFace: '맑은 고딕', bodyFontFace: '맑은 고딕',
  colors: { dk1: INK, lt1: WHITE, dk2: BODY, lt2: SOFT,
    accent1: NAVY, accent2: BLUE, accent3: CYAN, accent4: MUTED, accent5: LINE, accent6: PANEL,
    hlink: BLUE, folHlink: MUTED },
}

const pres = new pptxgen()
pres.layout = 'LAYOUT_WIDE'
pres.theme = { headFontFace: '맑은 고딕', bodyFontFace: '맑은 고딕' }
pres.author = '진네트웍스'
pres.company = '진네트웍스'
pres.title = '도면관리 시스템(TDMS) 구축 프로젝트 Kick-off'
pres.subject = '2026.11.17 ~ 2027.01.15 (9주)'

const M = 0.72
const W = 13.333 - M * 2
const FOOT_Y = 6.98
const BODY_Y = 2.48
const LEFT_W = 7.45
const DISC_X = M + 7.95
const DISC_W = 13.333 - DISC_X - M
const FOOT_TXT = '도면관리 시스템(TDMS) 구축   |   Vue 3 · Fastify(Node 22) · PostgreSQL 16 · Python 워커 · Docker'

const R = pres.ShapeType.roundRect
const RECT = pres.ShapeType.rect

/* ── 레이아웃 ─────────────────────────────────────────────── */
pres.defineSlideMaster({
  title: 'CONTENT',
  background: { color: WHITE },
  objects: [
    { image: { x: M, y: FOOT_Y, w: 0.2, h: 0.2, path: LOGO, altText: '진네트웍스 로고' } },
    { text: { text: FOOT_TXT, options: { x: M + 0.28, y: FOOT_Y, w: 9.4, h: 0.2, fontSize: 8.5,
        color: MUTED, valign: 'middle', isTextBox: true, margin: 0 } } },
    { placeholder: { options: { name: 'eyebrow', type: 'body', x: M, y: 0.34, w: 8, h: 0.24,
        fontSize: 10, bold: true, color: BLUE, charSpacing: 2, valign: 'middle', margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.60, w: W, h: 0.62,
        fontSize: 27, bold: true, color: NAVY, align: 'left', valign: 'middle', margin: 0 }, text: '' } },
    { rect: { x: M, y: 1.34, w: W, h: 0.012, fill: { color: LINE }, line: { color: LINE } } },
  ],
  slideNumber: { x: 12.3, y: FOOT_Y, w: 0.4, h: 0.2, fontSize: 9, bold: true, color: BLUE, align: 'right' },
})

pres.defineSlideMaster({
  title: 'COVER',
  background: { path: BG },
  objects: [
    // 배경 사진 위에 어둡게 한 겹 — 글자가 읽히게 한다
    { rect: { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: NAVY, transparency: 30 }, line: { color: NAVY, transparency: 100 } } },
    { rect: { x: 0.80, y: 0.78, w: 0.98, h: 0.98, fill: { color: WHITE }, line: { color: WHITE }, rectRadius: 0.12 } },
    { image: { x: 0.87, y: 0.85, w: 0.84, h: 0.84, path: LOGO, altText: '진네트웍스 로고' } },
  ],
})

/* ── helper ──────────────────────────────────────────────── */
function head(s, eyebrow, title) {
  s.addText(eyebrow, { placeholder: 'eyebrow' })
  s.addText(title, { placeholder: 'title' })
}

function keyMsg(s, msg) {
  s.addShape(R, { x: M, y: 1.56, w: W, h: 0.60, fill: { color: PANEL },
    line: { color: PANEL_LN, width: 1 }, rectRadius: 0.05, objectName: 'keymsg' })
  s.addText([
    { text: '핵심 메시지', options: { bold: true, color: NAVY } },
    { text: '   |   ', options: { color: PANEL_LN } },
    { text: msg, options: { bold: true, color: NAVY2 } },
  ], { x: M + 0.26, y: 1.56, w: W - 0.52, h: 0.60, fontSize: 12.5, valign: 'middle', isTextBox: true, margin: 0 })
}

function bullets(s, items, o = {}) {
  s.addText(items.map((t, i) => ({
    text: typeof t === 'string' ? t : t.text,
    options: { bullet: { indent: 14 }, breakLine: i < items.length - 1,
      bold: typeof t === 'object' && t.bold, color: (typeof t === 'object' && t.color) || BODY,
      paraSpaceAfter: o.gap === undefined ? 10 : o.gap },
  })), {
    x: o.x === undefined ? M + 0.08 : o.x, y: o.y === undefined ? BODY_Y : o.y,
    w: o.w === undefined ? LEFT_W : o.w, h: o.h === undefined ? 3.9 : o.h,
    fontSize: o.fontSize || 12.5, color: BODY, valign: 'top', isTextBox: true, margin: 0,
    lineSpacingMultiple: 1.25,
  })
}

function discussion(s, items, o = {}) {
  const y = o.y === undefined ? BODY_Y : o.y
  const h = o.h === undefined ? 3.1 : o.h
  s.addShape(R, { x: DISC_X, y, w: DISC_W, h, fill: { color: SOFT },
    line: { color: LINE, width: 1 }, rectRadius: 0.06, objectName: 'discussion' })
  s.addText('DISCUSSION POINTS', { x: DISC_X + 0.26, y: y + 0.20, w: DISC_W - 0.52, h: 0.26,
    fontSize: 10, bold: true, color: BLUE, charSpacing: 1, valign: 'middle', isTextBox: true, margin: 0 })
  s.addText(items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 },
    breakLine: i < items.length - 1, paraSpaceAfter: 8 } })), {
    x: DISC_X + 0.26, y: y + 0.58, w: DISC_W - 0.52, h: h - 0.78,
    fontSize: 11, color: BODY, valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 })
}

/** 가로 칸 카드 n개 */
function cardRow(s, items, o) {
  const n = items.length
  const gap = o.gap === undefined ? 0.22 : o.gap
  const cw = (o.w - gap * (n - 1)) / n
  items.forEach((it, i) => {
    const x = o.x + i * (cw + gap)
    const fill = it.variant === 'navy' ? NAVY : it.variant === 'warn' ? WARNSOFT
      : it.variant === 'ok' ? OKSOFT : it.variant === 'panel' ? PANEL : WHITE
    const ln = it.variant === 'navy' ? NAVY : it.variant === 'warn' ? WARNLN
      : it.variant === 'ok' ? OKLN : it.variant === 'panel' ? PANEL_LN : LINE
    s.addShape(R, { x, y: o.y, w: cw, h: o.h, fill: { color: fill }, line: { color: ln, width: 1 },
      rectRadius: 0.06, objectName: 'card' })
    let cy = o.y + 0.22
    if (it.kicker) {
      s.addText(it.kicker, { x: x + 0.22, y: cy, w: cw - 0.44, h: 0.24, fontSize: 9.5, bold: true,
        color: it.variant === 'navy' ? CYAN : BLUE, charSpacing: 1, valign: 'middle', isTextBox: true, margin: 0 })
      cy += 0.30
    }
    if (it.title) {
      const ln2 = it.title.split('\n').length
      s.addText(it.title, { x: x + 0.22, y: cy, w: cw - 0.44, h: 0.32 * ln2, fontSize: o.titleSize || 14,
        bold: true, color: it.variant === 'navy' ? WHITE : INK, valign: 'top', isTextBox: true,
        margin: 0, lineSpacingMultiple: 1.15 })
      cy += 0.32 * ln2 + 0.10
    }
    if (it.body) {
      s.addText(it.body, { x: x + 0.22, y: cy, w: cw - 0.44, h: o.y + o.h - cy - 0.16,
        fontSize: o.bodySize || 11, color: it.variant === 'navy' ? 'C6D6E4' : BODY,
        valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.3 })
    }
  })
}

/** 단계 흐름 (칩 + › ) */
function flowRow(s, steps, o) {
  const n = steps.length
  const arrowW = 0.28
  const cw = (o.w - arrowW * (n - 1)) / n
  steps.forEach((st, i) => {
    const x = o.x + i * (cw + arrowW)
    s.addShape(R, { x, y: o.y, w: cw, h: o.h, fill: { color: i === o.markIdx ? NAVY : PANEL },
      line: { color: i === o.markIdx ? NAVY : PANEL_LN, width: 1 }, rectRadius: 0.06, objectName: 'step' })
    s.addText(st.t, { x: x + 0.1, y: o.y + 0.16, w: cw - 0.2, h: 0.3, fontSize: 12.5, bold: true,
      color: i === o.markIdx ? WHITE : NAVY, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    s.addText(st.d, { x: x + 0.1, y: o.y + 0.48, w: cw - 0.2, h: o.h - 0.58, fontSize: 10,
      color: i === o.markIdx ? 'C6D6E4' : BODY, align: 'center', valign: 'top', isTextBox: true,
      margin: 0, lineSpacingMultiple: 1.25 })
    if (i < n - 1) s.addText('›', { x: x + cw, y: o.y, w: arrowW, h: o.h, fontSize: 18, bold: true,
      color: BLUE, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  })
}

function footNote(s, text, y) {
  s.addText(text, { x: M, y, w: W, h: 0.3, fontSize: 10.5, color: MUTED,
    align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
}

function content(section, eyebrow, title, msg, note) {
  const s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: section })
  head(s, eyebrow, title)
  keyMsg(s, msg)
  if (note) s.addNotes(note)
  return s
}

/* ── 01 표지 ─────────────────────────────────────────────── */
pres.addSection({ title: '착수' })
{
  const s = pres.addSlide({ masterName: 'COVER', sectionTitle: '착수' })
  s.addText('G.HUB TDMS  ·  기술자료 관리 시스템 재구축', { x: 2.00, y: 1.02, w: 7, h: 0.5,
    fontSize: 11.5, bold: true, color: CYAN, charSpacing: 2, valign: 'middle', isTextBox: true, margin: 0 })
  s.addText('도면관리 시스템 구축\nPROJECT KICK-OFF', { x: 0.80, y: 2.10, w: 8.4, h: 1.8,
    fontSize: 38, bold: true, color: WHITE, valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.12 })
  s.addText('SK가스 G.Hub 사업장 도면(TDB) · 설비 데이터북(MDB) 관리 시스템', { x: 0.80, y: 4.00, w: 8.4, h: 0.4,
    fontSize: 15, color: 'AFC4D6', valign: 'middle', isTextBox: true, margin: 0 })
  const meta = [
    ['수행 기간', '2026. 11. 17. ~ 2027. 01. 15.  (9주)'],
    ['Kick-off', '2026. 11. 24. (화) 11:00~11:40 · 정비동 회의실'],
    ['고객사 · 수행사', '지허브   ·   진네트웍스'],
  ]
  meta.forEach((m, i) => {
    const y = 4.80 + i * 0.52
    s.addText(m[0], { x: 0.80, y, w: 2.2, h: 0.36, fontSize: 10, bold: true, color: '7E99B2',
      charSpacing: 1, valign: 'middle', isTextBox: true, margin: 0 })
    s.addText(m[1], { x: 2.95, y, w: 6.3, h: 0.36, fontSize: 13, bold: true, color: WHITE,
      valign: 'middle', isTextBox: true, margin: 0 })
  })
  s.addText('VUE 3  ·  FASTIFY(NODE 22)  ·  POSTGRESQL 16  ·  PYTHON 워커  ·  DOCKER',
    { x: 0.80, y: 6.65, w: 8.4, h: 0.3, fontSize: 9.5, bold: true, color: '6E89A3', charSpacing: 1,
      valign: 'middle', isTextBox: true, margin: 0 })

  s.addShape(R, { x: 9.52, y: 1.02, w: 3.18, h: 5.12, fill: { color: '09182A', transparency: 22 },
    line: { color: '4E7FA6', width: 1 }, rectRadius: 0.08, objectName: 'deliverycard' })
  s.addText('DELIVERY', { x: 9.75, y: 1.30, w: 3.4, h: 0.3, fontSize: 11, bold: true, color: CYAN,
    charSpacing: 2, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  s.addText('9', { x: 9.75, y: 1.75, w: 3.4, h: 1.0, fontSize: 60, bold: true, color: WHITE,
    align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  s.addText('WEEKS', { x: 9.75, y: 2.75, w: 3.4, h: 0.3, fontSize: 12, bold: true, color: 'AFC4D6',
    charSpacing: 2, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  const phase = [['분석 · 설계', '11/17 ~ 12/04'], ['구현 · 이행', '12/07 ~ 12/25'], ['검증 · 전환', '12/28 ~ 01/15']]
  phase.forEach((p, i) => {
    const y = 3.70 + i * 0.86
    s.addText(p[0], { x: 9.75, y, w: 3.4, h: 0.32, fontSize: 14, bold: true, color: WHITE,
      align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    s.addText(p[1], { x: 9.75, y: y + 0.30, w: 3.4, h: 0.28, fontSize: 11, color: '8FAAC2',
      align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  })
  s.addNotes('표지. 오늘 회의는 소개가 아니라 실행 기준을 맞추는 자리임을 안내합니다. 수행 기간은 2026년 11월 17일 착수, 2027년 1월 15일 완료로 9주입니다.')
}

/* ── 02 합의할 사항 ──────────────────────────────────────── */
{
  const s = content('착수', 'PROJECT KICK-OFF', 'Kick-off에서 합의할 사항',
    '오늘의 목표는 범위 · 일정 · 역할 · 검수 기준을 하나의 기준으로 합의하는 것입니다.',
    '오늘 반드시 합의할 다섯 가지를 먼저 제시합니다. 미결 사항은 담당자와 기한을 지정해 회의록에 남긴다고 안내합니다.')
  bullets(s, [
    { text: '프로젝트 목표와 완료(인수) 기준', bold: true },
    '개발 범위와 제외 범위, 우선순위',
    '9주 일정(2026.11.17 ~ 2027.01.15)과 승인 시점',
    '기술 구성 · 데이터 이행 · 전환 원칙',
    '양사 역할, 보고 · 이슈 처리 방식',
    { text: '사전 준비분(선행 구축)의 활용 범위', bold: true },
  ])
  discussion(s, ['오늘 합의할 내용을 회의록에 확정', '미결 사항은 담당자 · 기한 지정', '회의록은 당일 공유 후 확인 요청'])
  footNote(s, '※ 본 자료의 수치는 기존 시스템 소스 · DB 전수 분석(2026-10-12 전달본, 11-12 갱신본)과 신규 시스템 실측에 근거합니다.', 6.30)
}

/* ── 03 추진 배경 및 현황 ───────────────────────────────── */
pres.addSection({ title: '배경과 목표' })
{
  const s = content('배경과 목표', 'BACKGROUND', '추진 배경 및 현황',
    '현행 시스템은 기능이 모자란 것이 아니라 구조가 업무를 따라가지 못합니다.',
    '현황은 사실 기반으로 정리했습니다. 기존 소스와 DB를 전수 분석한 결과입니다. API 201개 중 순수 조회는 12%뿐이고 나머지는 파일 상태를 옮기는 일입니다.')
  cardRow(s, [
    { kicker: '대상 규모', title: '도면 10,827건', body: '파일 16,400개 / 6.5GB\nMDB 자료 1,200건' },
    { kicker: '시스템 성격', title: '조회 12% : 전이 88%', body: 'API 201개 분류 결과\n워크플로가 중심' },
    { kicker: '구조 제약', title: '폴더가 문자열', body: '이름 변경 = 수천 건 수정\n+ 디스크 이동' },
    { kicker: '보안 점검', title: '보완 과제 25건', body: '높음 7 · 중간 13 · 낮음 5\n양호 통제 20건은 승계' },
  ], { x: M, y: BODY_Y, w: W, h: 1.62 })
  bullets(s, [
    '파일명이 메타데이터를 들고 있어 리비전 승인마다 디스크 작업이 따라붙습니다.',
    '엑셀 · Zip · 백업 · 변환이 요청 스레드에서 동기 실행돼 화면이 수십 초 멈춥니다.',
    '운영은 Windows 단일 서버이며 이중화 · 복구 절차가 없습니다.',
  ], { y: 4.35, w: W, h: 1.5 })
  footNote(s, '※ 현행 분석 결과는 1~2주차에 CM 확인을 거쳐 요구사항 기준선으로 확정합니다.', 6.30)
}

/* ── 04 목표 및 성공 기준 ───────────────────────────────── */
{
  const s = content('배경과 목표', 'OBJECTIVES', '프로젝트 목표 및 성공 기준',
    '완료는 기능 구현이 아니라 동등성 증명 · 검수 승인 · 운영 인계까지입니다.',
    '정량 목표는 임의로 넣지 않았습니다. 성능 수치는 실측 기반이고, 검수 기준은 오늘 합의 대상입니다.')
  bullets(s, [
    { text: '업무 목표 — 기능 100% 보존: 메뉴 9 · 화면 14 · 권한 36 · API 201 전수 재현', bold: true },
    '사용자 목표 — 쓰시던 화면 구성과 용어를 유지해 재교육 부담을 없앤다',
    '기술 목표 — 폴더 트리 · 내용 해시 저장 · 작업 큐로 상태 전이 비용을 제거한다',
    '성능 목표 — 목록 150ms, 폴더 편집 50ms 이하를 자동 검사로 고정한다',
    '운영·보안 목표 — 자동 배포·롤백, 백업 2중, 보안 높음 7건의 구조적 해소',
  ])
  discussion(s, ['완료(인수) 기준을 문서로 고정', '성능 · 검수 목표값 합의', '범위 축소는 고객사 결정 사항'])
  cardRow(s, [
    { variant: 'navy', kicker: '완료 기준 ①', title: '기능 체크리스트 전수 통과' },
    { variant: 'navy', kicker: '완료 기준 ②', title: '데이터 sha256 전수 일치' },
    { variant: 'navy', kicker: '완료 기준 ③', title: '성능 기준 자동 검사 통과' },
    { variant: 'navy', kicker: '완료 기준 ④', title: 'UAT 승인 · 운영 인계 완료' },
  ], { x: M, y: 5.72, w: W, h: 0.86, titleSize: 12.5 })
}

/* ── 05 범위 및 경계 ────────────────────────────────────── */
{
  const s = content('배경과 목표', 'SCOPE', '개발 범위 및 경계',
    '포함과 제외를 함께 정의해 일정 · 비용 · 기대치의 불일치를 예방합니다.',
    '제외 범위는 기존 시스템의 범위를 그대로 승계한 것입니다. AWS 이관과 유출 방지 2·3차는 별도 단계로 두고 오늘은 방향만 정합니다.')
  cardRow(s, [
    { variant: 'ok', kicker: '포함', title: '업무 기능 전체',
      body: 'TDB 조회 · 반입 · 검수 · 관리 · 반출이력\nMDB 조회 · 관리 · Tag 이력\n운영(로그 · 사용자 · 권한 · 백업)\nPDF 뷰어 · 마크업 이식' },
    { variant: 'ok', kicker: '포함', title: '이행과 전환',
      body: '기존 DB · 파일 전량 이행\nsha256 전수 검증 · 리허설\n섀도 비교 2주 · 병행 운영\n운영 전환 · 교육 · 인계' },
    { variant: 'warn', kicker: '제외', title: '기존 범위 그대로',
      body: 'Ocean-H 연동\n웹에서 DWG 직접 열람\n도면 본문 전문검색\nDRM · SSO · 도면 자동 병합' },
    { variant: 'warn', kicker: '제외 · 별도 단계', title: '인프라 · 유출 방지',
      body: 'AWS 이관(요건서 과제)\n유출 방지 2 · 3차(DRM 등)\n→ 오늘은 방향만 결정하고\n   별도 일정 · 비용으로 분리' },
  ], { x: M, y: BODY_Y, w: W, h: 2.72, bodySize: 10.5 })
  bullets(s, [
    { text: '범위 변경은 요청 등록 → 영향 분석(일정 · 비용 · 품질) → 승인 → 기준선 갱신 절차로만 반영합니다.', bold: true },
  ], { y: 5.45, w: W, h: 0.5 })
  footNote(s, '※ 상세 기능 목록은 기능 인벤토리(메뉴 9 · 화면 14 · 권한 36 · API 201)와 화면 요소 체크리스트로 관리합니다.', 6.10)
}

/* ── 06 사용자 및 업무 기능 ─────────────────────────────── */
{
  const s = content('배경과 목표', 'USERS & FUNCTIONS', '주요 사용자 및 업무 기능',
    '사용자 역할과 실제 업무 흐름(반출 → 수정 → 반입 → 검수 → 승인)을 기준으로 기능을 확정합니다.',
    '협력사는 시스템에 접근하지 않습니다. CM이 반출해 전달하고 받아서 검수합니다. 이 흐름이 시스템의 중심입니다.')
  flowRow(s, [
    { t: '반출', d: '업체에 전달\nZip · 반출목록' },
    { t: '수정', d: '업체가 CAD 수정\n(시스템 밖)' },
    { t: '반입', d: '개별 · Zip 대량\n사유 분류' },
    { t: '검수', d: '승인 / 반려\n중복반출은 분기' },
    { t: '승인', d: '리비전 확정\n미반납 해소' },
  ], { x: M, y: BODY_Y, w: W, h: 1.10, markIdx: 3 })
  bullets(s, [
    { text: '사용자 — 설비기술팀 CM 및 사내 수십 명 / 협력사는 시스템 접근 없음', bold: true },
    'TDB — 조회 · 상세 · 미리보기 / 반입 · 검수 / 관리(폴더 · 자료 · 보관함 2종) / 반출이력 · 미입고',
    'MDB — 조회 · 상세 / 관리(설비유형 · 폴더) / Tag 이력 적용 · 되돌리기',
    '운영 — 시스템 로그 · 사용자/그룹 · 권한(리프 36) · 백업 · 도움말',
    '추가분 — 메뉴 관리 · 접속권한 관리 · 스탬프 관리 · 공사/업체 관리',
  ], { y: 3.90, h: 2.4 })
  discussion(s, ['화면별 확인 담당 CM 지정', '기능 우선순위 확인', '추가분 유지 여부 결정'], { y: 3.90, h: 2.4 })
}

/* ── 07 요구사항 정의 및 변경 관리 ──────────────────────── */
pres.addSection({ title: '설계 원칙' })
{
  const s = content('설계 원칙', 'REQUIREMENTS', '요구사항 정의 및 변경 관리',
    '기존 시스템의 기능 인벤토리를 요구사항 기준선으로 삼고, 변경은 승인된 것만 반영합니다.',
    '요구사항을 처음부터 다시 받는 프로젝트가 아닙니다. 기존 기능이 기준선이고, 거기서 더하거나 빼는 것만 합의하면 됩니다.')
  flowRow(s, [
    { t: '기준선', d: '기능 인벤토리\n화면 체크리스트' },
    { t: '확인', d: 'CM 검토\n2주차 승인' },
    { t: '우선순위', d: '필수 / 개선 / 제외' },
    { t: '변경', d: '영향 분석 → 승인' },
    { t: '추적', d: '요구 ↔ 구현 ↔ 테스트' },
  ], { x: M, y: BODY_Y, w: W, h: 1.10 })
  bullets(s, [
    { text: '기준선 — 기존 API 201개 계약 스냅샷과 화면 요소(버튼 · 라벨) 체크리스트', bold: true },
    '승인 — 2주차(11/27)까지 CM 검토로 요구사항 · 범위 기준선을 확정합니다',
    '우선순위 — 필수(기존 동등) / 개선(합의 시 반영) / 제외(별도 단계)',
    '변경 — 요청 등록 → 영향 분석 → 승인 → 기준선 갱신. 구두 합의만으로 범위를 바꾸지 않습니다',
    '추적 — 요구사항 · 구현 · 테스트 케이스를 연결해 누락을 기계적으로 확인합니다',
  ], { y: 3.90, h: 2.4 })
  discussion(s, ['고객사 승인권자 지정', '검토 · 승인 리드타임 합의', '변경 요청 접수 창구 단일화'], { y: 3.90, h: 2.4 })
}

/* ── 08 사전 준비분 ─────────────────────────────────────── */
{
  const s = content('설계 원칙', 'PRE-BUILT BASELINE', '사전 준비분 — 지금 어디까지 되어 있나',
    '착수 전 선행 구축으로 골격은 준비돼 있습니다. 공식 일정은 11/17부터이며 남은 일은 확정 · 이행 · 검증입니다.',
    '중요한 구분입니다. 지금까지 만든 것은 기존 소스와 전달 자료를 바탕으로 미리 준비해 둔 것입니다. 기준선 대조 전 상태이므로, 요구사항이 확정되면 차이분을 반영합니다. 그래서 9주가 개발이 아니라 확정·이행·검증 중심입니다.')
  cardRow(s, [
    { kicker: '화면', title: '14 + 4', body: '구현 완료 · 미완성 0\n추가 4: 메뉴 · 권한 · 스탬프 · 공사' },
    { kicker: '권한', title: '리프 36', body: '전수 동작\n기동 시 자동 검증 통과' },
    { kicker: '검증', title: '138건', body: '업무 흐름 자동 검증 통과\n반입 · 관리 · 반출 · MDB · 운영' },
    { kicker: '성능', title: '52,000건', body: '실데이터 5배로 측정\n전 항목 목표치 이하' },
  ], { x: M, y: BODY_Y, w: W, h: 1.62 })
  bullets(s, [
    'DB 29테이블 · 인덱스 93 적용, 자동 배포 · 롤백 체계 구성(검사 → 빌드 → 배포 → 상태 확인)',
    { text: '※ 사전 준비분은 기준선 대조 전 상태입니다 — 요구사항 확정 후 차이분을 구현에 반영합니다', bold: true, color: WARN },
    '따라서 9주 일정은 신규 개발이 아니라 기준선 확정 · 차이분 구현 · 데이터 이행 · 동등성 검증이 중심입니다',
  ], { y: 4.35, w: W, h: 1.5 })
  footNote(s, '요청하시면 오늘 이 자리에서 실제 화면을 띄워 보여 드립니다.', 6.30)
}

/* ── 09 아키텍처 ────────────────────────────────────────── */
{
  const s = content('설계 원칙', 'ARCHITECTURE', '목표 시스템 아키텍처',
    '프로세스 3종(API · 워커 · DB)과 nginx 파일 직송 구조로 장애 지점과 운영 부담을 줄입니다.',
    '도식은 논리 구조입니다. 미들웨어를 하나도 늘리지 않았습니다. 오래 걸리는 일은 DB 작업 큐에 쌓고 워커가 집어 가며, 진행률이 화면에 실시간으로 흐릅니다.')
  function box(o) {
    s.addShape(R, { x: o.x, y: o.y, w: o.w, h: o.h, rectRadius: 0.06,
      fill: { color: o.fill || WHITE }, line: { color: o.line || LINE, width: 1.2 }, objectName: 'arch' })
    s.addText(o.title, { x: o.x + 0.1, y: o.y + 0.12, w: o.w - 0.2, h: 0.3, fontSize: 12.5, bold: true,
      color: o.titleColor || NAVY, align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
    if (o.lines) s.addText(o.lines.join('\n'), { x: o.x + 0.1, y: o.y + 0.44, w: o.w - 0.2, h: o.h - 0.54,
      fontSize: 9.5, color: o.subColor || BODY, align: 'center', valign: 'top', isTextBox: true,
      margin: 0, lineSpacingMultiple: 1.3 })
  }
  function arrow(x1, y1, x2, y2) {
    s.addShape(pres.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1,
      line: { color: MUTED, width: 1.2, endArrowType: 'triangle' } })
  }
  const topY = 2.45, topH = 1.24
  box({ x: M, y: topY + 0.2, w: 1.5, h: 0.84, title: '브라우저', lines: ['Vue 3 SPA'] })
  box({ x: M + 1.88, y: topY, w: 3.1, h: topH, fill: NAVY, line: NAVY, title: 'nginx', titleColor: WHITE,
    subColor: 'C6D6E4', lines: ['TLS · 접근 IP 제한 · 업로드 제한', '파일은 커널이 직송(앱을 거치지 않음)', 'API 는 유닉스 소켓으로'] })
  box({ x: M + 5.36, y: topY, w: 2.95, h: topH, title: 'API — Fastify / Node 22',
    lines: ['세션 · 선언형 권한 · 감사 기록', '업무 규칙 · SQL', '파일 바이트를 만지지 않는다'] })
  box({ x: M + 8.7, y: topY, w: 3.19, h: topH, fill: SOFT, title: 'blob 저장소',
    lines: ['내용 해시(sha256)로 주소를 삼는다', '불변 · 중복 자동 제거', '읽는 이름은 받는 시점에 만든다'] })
  box({ x: M + 3.9, y: 4.12, w: 4.7, h: 0.92, fill: PANEL, line: PANEL_LN, title: 'PostgreSQL 16',
    lines: ['업무 데이터 · 세션 · 폴더 트리 · 한글 검색', '작업 큐 · 캐시 무효화 방송'] })
  box({ x: M + 3.9, y: 5.32, w: 4.7, h: 0.76, title: '워커 — Python 3.12',
    lines: ['DWG · 오피스 변환 · Zip · 엑셀 · 백업 · 대량 반입'] })
  arrow(M + 1.52, topY + 0.62, M + 1.85, topY + 0.62)
  arrow(M + 5.0, topY + 0.62, M + 5.33, topY + 0.62)
  arrow(M + 8.33, topY + 0.62, M + 8.67, topY + 0.62)
  arrow(M + 6.8, topY + topH + 0.02, M + 6.8, 4.09)
  arrow(M + 5.9, 5.06, M + 5.9, 5.29)
  arrow(M + 6.5, 5.29, M + 6.5, 5.06)
  s.addText('유닉스 소켓', { x: M + 6.9, y: 3.78, w: 1.6, h: 0.24, fontSize: 9, color: MUTED, isTextBox: true, margin: 0 })
  s.addText('작업을 집어 가고 진행률을 적는다', { x: M + 6.65, y: 5.06, w: 2.6, h: 0.24, fontSize: 9, color: MUTED, isTextBox: true, margin: 0 })
  footNote(s, '인증 · 파일 전송 · 백업 · 모니터링의 실제 배치는 운영 환경 확정(3주차) 후 상세 설계에서 고정합니다.', 6.30)
}

/* ── 10 기술 스택 ───────────────────────────────────────── */
{
  const s = content('설계 원칙', 'TECH STACK', '기술 스택 및 적용 원칙',
    '기술 선택보다 일관된 구조 · 코딩 규칙 · 운영 가능성을 우선합니다.',
    '선택 기준은 하나였습니다. 사내 단일 서버에서 10년을 버틸 것. Python 워커를 유지한 이유는 도면 변환 라이브러리에 대체재가 없기 때문입니다.')
  cardRow(s, [
    { kicker: 'FRONTEND', title: 'Vue 3 + Vite', body: '화면 · 컴포넌트 · 라우팅\n컴포넌트 키트 미사용\n화면별 코드 분할' },
    { kicker: 'BACKEND', title: 'Fastify · TypeScript', body: 'REST API · 검증 · 직렬화 컴파일\n모듈 = 기존 라우터와 1:1\n권한 · 감사 선언형' },
    { kicker: 'DATABASE', title: 'PostgreSQL 16', body: '폴더 트리(ltree) · 한글 검색(trgm)\n작업 큐 · 세션\n마이그레이션 번호순 적용' },
    { kicker: 'RUNTIME', title: 'Docker + Python 워커', body: '이미지 · 환경 일관성\nDWG · 오피스 변환\nZip · 엑셀 · 백업' },
  ], { x: M, y: BODY_Y, w: W, h: 2.1, bodySize: 10.5 })
  s.addShape(R, { x: M, y: 4.82, w: W, h: 0.62, fill: { color: PANEL }, line: { color: PANEL_LN, width: 1 }, rectRadius: 0.05 })
  s.addText('적용 원칙 :  버전 고정  ·  계약(타입) 1벌 공유  ·  권한 · 감사 선언 강제  ·  환경별 설정 분리  ·  성능 기준 자동 검사',
    { x: M + 0.2, y: 4.82, w: W - 0.4, h: 0.62, fontSize: 12.5, bold: true, color: NAVY,
      align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
  bullets(s, [
    'PDF 뷰어와 마크업은 기존 자산을 그대로 이식했습니다 — 원본 수정 2곳 외에는 덧붙인 모듈이라 재작성 대상이 아닙니다.',
  ], { y: 5.68, w: W, h: 0.5 })
}

/* ── 11 데이터 및 API 설계 원칙 ─────────────────────────── */
{
  const s = content('설계 원칙', 'DATA & API', '데이터 및 API 설계 원칙',
    '계약(타입) 한 벌을 프런트 · 백엔드가 공유해 재작업과 불일치를 없앱니다.',
    'API 계약과 데이터 모델을 먼저 합의하면 병렬 개발의 재작업이 줄어듭니다. 기존 경로와 호환을 유지하는 것이 전제입니다.')
  bullets(s, [
    { text: '계약 — 스키마 1벌이 입력 검증 · 응답 직렬화 · 화면 타입을 모두 만든다', bold: true },
    'API — 경로 · 상태 코드 · 오류 응답 형식을 통일하고 기존 201개 경로와 호환을 유지',
    '데이터 — 폴더는 테이블(ltree), 목록은 keyset 페이징(OFFSET 금지), 한글 부분검색은 trgm 색인',
    '보안 — 라우트마다 권한 · 감사를 선언하고, 선언이 빠지면 서버가 기동하지 않는다',
    '변경 — 마이그레이션은 번호순으로 앞으로만. 적용된 파일은 수정하지 않는다',
    '파일 — 내용 해시 저장으로 폴더 · 리비전 변경 시 디스크를 건드리지 않는다',
  ])
  discussion(s, ['기존 OpenAPI 스냅샷 제공 요청', '보안 요구사항 추가 여부', '감사 로그 보존 기간 확인'], { h: 2.62 })
  cardRow(s, [
    { variant: 'panel', title: '폴더 이름 변경', body: '수십 초 → 1ms 미만' },
    { variant: 'panel', title: '리비전 승인 · 이동', body: '디스크 작업 0' },
    { variant: 'panel', title: '중간 실패', body: '되감기로 끝 — 정합성 보장' },
  ], { x: M, y: 5.32, w: W, h: 1.04, titleSize: 12.5 })
}

/* ── 12 데이터 이행 계획 ────────────────────────────────── */
pres.addSection({ title: '일정과 실행' })
{
  const s = content('일정과 실행', 'DATA MIGRATION', '데이터 이행 계획',
    '이행은 옮기는 작업이 아니라 ‘같다’는 것을 증명하는 작업입니다.',
    '이 프로젝트에서 가장 위험한 구간입니다. 자료를 언제 받느냐가 전체 일정을 좌우합니다. 검증은 눈 검사로 대체하지 않고 전수 대조합니다.')
  flowRow(s, [
    { t: '1 · 수령', d: 'DB 스냅샷\n파일 원본 6.5GB' },
    { t: '2 · 변환', d: '폴더 문자열 → 트리\nsha256 재배치' },
    { t: '3 · 검증', d: '건수 · 해시 · 경로\n전수 대조' },
    { t: '4 · 리허설', d: '2회 수행\n소요 시간 측정' },
    { t: '5 · 본 이행', d: '업무 외 시간\n실패 시 롤백' },
  ], { x: M, y: BODY_Y, w: W, h: 1.14, markIdx: 2 })
  bullets(s, [
    { text: '검증 기준 — 건수 · sha256 합계 · 폴더 경로 재구성 결과가 원본과 100% 일치해야 전환합니다', bold: true },
    '불일치가 1건이라도 남으면 전환을 보류하고 원인을 정리한 뒤 다시 리허설합니다',
    '기존 DB와 디스크가 어긋난 자료가 있으면 리허설에서 드러납니다 — 정리 범위는 고객사와 협의',
    '이행 중에도 기존 시스템은 그대로 운영됩니다. 쓰기 작업은 전환 시점까지 기존 시스템에서만 수행',
  ], { y: 3.95, h: 2.3 })
  discussion(s, ['자료 전달 창구 · 담당자', '1차 스냅샷 제공 시점(11월 말)', '업무 중단 가능 시간대'], { y: 3.95, h: 2.3 })
}

/* ── 13 9주 일정 ────────────────────────────────────────── */
{
  const s = content('일정과 실행', 'SCHEDULE', '9주 추진 일정 및 마일스톤',
    '2026.11.17 착수 → 2027.01.15 완료. 고객사 검토 · 승인이 제때 이뤄지는 것을 전제로 합니다.',
    '9주입니다. 1·2주차에 기준선을 확정하지 못하면 전체가 밀립니다. 연말 휴무 구간은 섀도 비교에 겹쳐 두어 일정 손실을 줄였습니다.')
  const labelW = 3.35, gx = M + labelW, gw = W - labelW, colW = gw / 9
  const weeks = ['11/17', '11/23', '11/30', '12/07', '12/14', '12/21', '12/28', '01/04', '01/11']
  weeks.forEach((w, i) => s.addText(w, { x: gx + i * colW, y: 2.38, w: colW, h: 0.26, fontSize: 9,
    bold: true, color: i === 0 || i === 8 ? NAVY : MUTED, align: 'center', valign: 'middle', isTextBox: true, margin: 0 }))
  s.addShape(RECT, { x: M, y: 2.66, w: W, h: 0.014, fill: { color: NAVY }, line: { color: NAVY } })
  const rowH = 0.40, top = 2.74
  const rows = [
    { t: '착수 · 현행 분석 · 기준선 확정', bars: [[0, 2, 'navy']] },
    { t: '설계 확정 · 운영 환경 결정', bars: [[1, 2, 'blue']] },
    { t: '차이분 구현 · 변환 워커 구성', bars: [[2, 3, 'blue']] },
    { t: '데이터 이행 설계 · 리허설', bars: [[3, 3, 'navy']] },
    { t: '통합 · 성능 · 보안 점검', bars: [[5, 2, 'soft']] },
    { t: '섀도 비교 운영 (2주)', bars: [[6, 2, 'blue']] },
    { t: 'UAT · 사용자 교육', bars: [[7, 1, 'soft']] },
    { t: '본 이행 → 전환 → 인수 인계', bars: [[8, 1, 'navy']], bold: true },
  ]
  rows.forEach((r, i) => {
    const y = top + i * rowH
    s.addText(r.t, { x: M, y, w: labelW - 0.12, h: rowH, fontSize: 11, bold: !!r.bold,
      color: r.bold ? NAVY : BODY, valign: 'middle', isTextBox: true, margin: 0 })
    r.bars.forEach(([st, len, kind]) => {
      s.addShape(RECT, { x: gx + st * colW + 0.04, y: y + 0.09, w: colW * len - 0.08, h: rowH - 0.18,
        fill: { color: kind === 'navy' ? NAVY : kind === 'blue' ? BLUE : 'AFC4D6' },
        line: { color: kind === 'navy' ? NAVY : kind === 'blue' ? BLUE : 'AFC4D6' }, objectName: 'bar' })
    })
    s.addShape(RECT, { x: M, y: y + rowH - 0.007, w: W, h: 0.007, fill: { color: LINE }, line: { color: LINE } })
  })
  s.addShape(R, { x: M, y: 6.06, w: W, h: 0.56, fill: { color: PANEL }, line: { color: PANEL_LN, width: 1 }, rectRadius: 0.05 })
  s.addText('마일스톤   11/27 기준선 승인  →  12/04 설계 · 환경 확정  →  12/11 이행 리허설  →  12/18 기능 시연  →  12/25 UAT 진입  →  01/08 UAT 승인  →  01/15 인계',
    { x: M + 0.18, y: 6.06, w: W - 0.36, h: 0.56, fontSize: 10.5, bold: true, color: NAVY,
      align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
}

/* ── 14 산출물 및 승인 게이트 ───────────────────────────── */
{
  const s = content('일정과 실행', 'DELIVERABLES', '단계별 산출물 및 승인 게이트',
    '각 단계는 산출물 제출과 검토 · 승인을 거쳐 다음 단계로 넘어갑니다.',
    '산출물마다 작성자·검토자·승인자와 승인 기한을 지정합니다. 기한 내 회신이 없을 때의 처리 규칙도 함께 정합니다.')
  flowRow(s, [
    { t: '분석', d: '~ 11/27' },
    { t: '설계', d: '~ 12/04' },
    { t: '구현 · 이행', d: '~ 12/25' },
    { t: '검증 · UAT', d: '~ 01/08' },
    { t: '전환', d: '~ 01/15' },
  ], { x: M, y: BODY_Y, w: W, h: 0.86 })
  const rows = [
    ['분석', '기능 인벤토리 대조표 · 범위 확정서 · 현행 데이터 점검 결과', '요구사항 · 범위 기준선 승인'],
    ['설계', '화면 체크리스트 · API 계약 스냅샷 · ERD · 운영 환경 구성안', '설계 및 환경 확정 승인'],
    ['구현 · 이행', '차이분 구현 결과 · 변환 워커 · 이행 스크립트 · 리허설 보고', '핵심 기능 시연 · 리허설 결과 승인'],
    ['검증 · UAT', '동등성 대조 결과 · 성능 측정 · 결함 목록 · UAT 시나리오', 'UAT 진입 기준 충족 · UAT 승인'],
    ['전환', '전환 · 롤백 계획 · 운영 매뉴얼 · 교육 자료 · 인수인계서', '최종 검수 및 운영 인계 승인'],
  ]
  s.addTable([
    ['단계', '산출물', '승인 게이트'].map(t => ({ text: t, options: { bold: true, fontSize: 9.5, color: MUTED,
      fill: { color: WHITE }, margin: [0.06, 0.1, 0.06, 0.1],
      border: [{ type: 'none' }, { type: 'none' }, { pt: 1.4, color: NAVY }, { type: 'none' }] } })),
    ...rows.map((r, i) => r.map((c, j) => ({ text: c, options: {
      fontSize: 11, color: j === 0 ? NAVY : BODY, bold: j === 0, valign: 'middle',
      fill: { color: i % 2 ? SOFT : WHITE }, margin: [0.08, 0.1, 0.08, 0.1],
      border: [{ type: 'none' }, { type: 'none' }, { pt: 0.8, color: LINE }, { type: 'none' }] } }))),
  ], { x: M, y: 3.60, w: W, colW: [1.6, 6.3, 3.993], rowH: 0.44, autoPage: false })
  footNote(s, '※ 산출물별 작성자 · 검토자 · 승인자와 승인 기한을 지정합니다. 승인 지연은 그대로 일정 지연으로 반영됩니다.', 6.42)
}

/* ── 15 조직 및 R&R ─────────────────────────────────────── */
{
  const s = content('일정과 실행', 'ORGANIZATION', '프로젝트 조직 및 R&R',
    '업무 결정권자와 기술 실행 책임자를 구분해 의사결정 지연을 줄입니다.',
    '실제 이름과 연락처를 넣어 확정합니다. 특히 고객사 업무 의사결정자와 대체 담당자까지 지정돼야 9주 일정이 유지됩니다.')
  cardRow(s, [
    { variant: 'panel', kicker: '고객사', title: 'Sponsor', body: '방향 · 범위 · 예산 의사결정\n최종 검수 승인' },
    { variant: 'panel', kicker: '고객사', title: '업무 책임자 · CM', body: '요구사항 확인 · 우선순위\n섀도 비교 · UAT 검수' },
    { kicker: '수행사', title: 'PM', body: '일정 · 범위 · 리스크\n주간 보고 · 회의록' },
    { kicker: '수행사', title: 'Tech Lead', body: '아키텍처 · 품질 기준\n기술 의사결정' },
    { kicker: '수행사', title: '개발 · DevOps', body: '차이분 구현 · 이행 스크립트\n배포 · 운영 환경' },
    { kicker: '수행사', title: '검증 담당', body: '동등성 대조 · 성능 측정\n결함 추적' },
  ], { x: M, y: BODY_Y, w: W, h: 1.86, bodySize: 10.5, titleSize: 13 })
  bullets(s, [
    { text: '의사결정 — 범위 · 일정에 영향을 주는 사항은 고객사 Sponsor 승인, 기술 구현 방식은 수행사 Tech Lead 결정', bold: true },
    '대체 담당자 — 휴가 · 부재 시를 대비해 양사 모두 대체 담당자를 지정합니다',
  ], { y: 4.62, w: W, h: 1.0 })
  footNote(s, '※ 실제 담당자 이름 · 연락처는 Kick-off 후 조직도에 반영해 회의록과 함께 공유합니다.', 6.10)
}

/* ── 16 협업 및 형상관리 ────────────────────────────────── */
pres.addSection({ title: '품질과 운영' })
{
  const s = content('품질과 운영', 'COLLABORATION', '개발 협업 및 형상관리',
    '작업 단위 · 코드 리뷰 · 자동 검사를 표준화해 통합 위험을 조기에 발견합니다.',
    '저장소와 브랜치 전략, 이슈 템플릿, 커밋 규칙은 이미 운영 중입니다. 고객사 쪽 접근 권한이 필요한 범위만 정하면 됩니다.')
  flowRow(s, [
    { t: '이슈', d: '요구 · 결함 · 과제\n티켓 등록' },
    { t: '브랜치', d: '기능 단위 개발' },
    { t: '리뷰', d: 'PR 코드 검토' },
    { t: '자동 검사', d: '타입 · 테스트\n번들 · 성능' },
    { t: '배포', d: '승인된 변경만\n자동 배포' },
  ], { x: M, y: BODY_Y, w: W, h: 1.10, markIdx: 3 })
  bullets(s, [
    { text: '품질 게이트 — 타입 검사 · 테스트 · 번들 예산 · 성능 기준을 통과해야 병합됩니다', bold: true },
    '환경 분리 — 개발 / 운영 설정을 분리하고, 비밀값은 저장소 밖에서 관리합니다',
    '릴리스 — 배포 단위에 태그를 붙이고 변경 이력을 남깁니다. 실패 시 직전 버전으로 자동 복귀',
    '이슈 — 요구사항 · 결함 · 기술 과제를 한 곳에서 관리하고 주간 보고에 상태를 싣습니다',
  ], { y: 3.90, h: 2.3 })
  discussion(s, ['고객사 이슈 접수 채널 결정', '저장소 접근 권한 범위', '주간 보고 요일 · 형식'], { y: 3.90, h: 2.3 })
}

/* ── 17 테스트 및 품질 ──────────────────────────────────── */
{
  const s = content('품질과 운영', 'QUALITY', '테스트 및 품질 전략 — 동등성 3중 검증',
    '‘같다’를 말이 아니라 기계적 대조로 증명합니다. 품질은 마지막에 몰아서 확보하지 않습니다.',
    '동등성 검증이 이 프로젝트의 핵심 품질 활동입니다. 섀도 비교는 조회만 양쪽에 보내므로 업무에 영향이 없습니다.')
  cardRow(s, [
    { variant: 'navy', kicker: '검증 ①', title: 'API 계약 대조', body: '기존 201개 엔드포인트의\n경로 · 파라미터 · 응답 형태를\n스냅샷과 기계 대조' },
    { variant: 'navy', kicker: '검증 ②', title: '화면 요소 대조', body: '기존 화면의 버튼 · 라벨\n체크리스트를 자동 대조\n누락을 눈으로 찾지 않는다' },
    { variant: 'navy', kicker: '검증 ③', title: '섀도 비교 2주', body: '신 · 구 서버에 같은 조회를 보내\n응답을 직접 비교\n쓰기는 기존 시스템에서만' },
  ], { x: M, y: BODY_Y, w: W, h: 1.76, bodySize: 10.5 })
  bullets(s, [
    '상시 — 단위 · 통합 · 업무 흐름 자동 검증(138건)과 성능 기준 검사를 배포 때마다 실행합니다',
    'UAT — 1/4~1/8 주간에 CM 시나리오 기반 검수. 시나리오와 합격 기준은 사전에 합의합니다',
    '결함 — 심각도 · 재현 절차 · 담당자 · 목표 조치일로 관리하고 주간 보고에 상태를 싣습니다',
  ], { y: 4.48, h: 1.7 })
  discussion(s, ['UAT 시나리오 · 검수 기준 합의', '참여 CM 1~2명 지정', '결함 심각도 기준 확인'], { y: 4.48, h: 1.7 })
}

/* ── 18 배포 및 운영 전환 ───────────────────────────────── */
{
  const s = content('품질과 운영', 'DEPLOY & CUTOVER', '배포 및 운영 전환',
    '배포는 자동으로, 전환은 되돌릴 수 있게 준비합니다.',
    '컨테이너는 배포 일관성을 돕지만 고가용성과 보안을 자동으로 보장하지는 않습니다. 운영 책임 주체를 함께 정해야 합니다.')
  flowRow(s, [
    { t: '빌드', d: '이미지 생성 · 태그' },
    { t: '이행', d: 'DB 마이그레이션' },
    { t: '배포', d: '무중단 교체' },
    { t: '확인', d: '상태 · 헬스체크' },
    { t: '롤백', d: '실패 시 직전 버전\n자동 복귀' },
  ], { x: M, y: BODY_Y, w: W, h: 1.0, markIdx: 4 })
  bullets(s, [
    { text: '백업 2중 — DB(스냅샷 · 시점 복구)와 파일(blob)을 각각 보관하고 복구 리허설을 수행합니다', bold: true },
    '전환 — 병행 운영 → 전환 → 1~2주 밀착 대응. 기존 시스템으로 즉시 되돌릴 수 있는 상태를 유지합니다',
    '운영 — 로그 · 상태 점검 · 알림을 구성하고 운영 책임자를 지정합니다',
    '인계 — 운영 매뉴얼 · 배포 절차 · 장애 대응 문서를 1/15 인계 시점에 제출합니다',
  ], { y: 3.80, h: 2.4 })
  discussion(s, ['운영 환경(사내 서버 / AWS) 확정', '운영 책임자 · 장애 연락 체계', '전환일 · 되돌리기 판단 기준'], { y: 3.80, h: 2.4 })
}

/* ── 19 리스크 ──────────────────────────────────────────── */
{
  const s = content('품질과 운영', 'RISK', '보안 · 리스크 및 대응 계획',
    '주요 위험을 먼저 드러내고 담당자 · 대응 기한을 지정합니다.',
    '리스크는 가능성·영향도·대응책·담당자·기한으로 관리합니다. 위 두 건은 고객사 결정이 없으면 저희가 손쓸 수 없는 항목입니다.')
  cardRow(s, [
    { variant: 'warn', kicker: '높음', title: '기존 자료 수령 지연', body: '이행 설계 · 리허설이 시작되지 않습니다\n→ 11월 말까지 1차 스냅샷\n→ 창구 · 담당자 오늘 확정' },
    { variant: 'warn', kicker: '높음', title: '운영 환경 미확정', body: '설치 · 보안 작업 착수 불가\n→ 12월 첫 주까지 확정\n→ 사내 Linux 우선 권고' },
    { variant: 'warn', kicker: '중간', title: '기존 데이터 불일치', body: 'DB와 디스크가 어긋난 자료\n→ 리허설에서 조기 발견\n→ 정리 범위 협의' },
  ], { x: M, y: BODY_Y, w: W, h: 1.68, bodySize: 10.5 })
  cardRow(s, [
    { kicker: '중간', title: '연말 휴무 구간', body: '12/28~01/01 가동률 저하\n→ 섀도 비교 구간에 배치해 손실 최소화' },
    { kicker: '중간', title: '도면 유출 위험', body: '대량 다운로드 · 뷰어 저장 · 백업 반출\n→ 1차(워터마크 · 열람이력 · 다운로드 상한) 우선' },
    { kicker: '낮음', title: '변환 엔진 설치 제약', body: 'ODA File Converter 재배포 불가\n→ 운영 서버에 직접 설치 후 연결' },
  ], { x: M, y: 4.32, w: W, h: 1.42, bodySize: 10.5 })
  footNote(s, '※ 리스크는 주간 보고에 상태 · 담당자 · 기한과 함께 싣고, 해소될 때까지 닫지 않습니다.', 6.10)
}

/* ── 20 성공 기준 및 다음 액션 ──────────────────────────── */
pres.addSection({ title: '마무리' })
{
  const s = content('마무리', 'NEXT ACTIONS', '성공 기준 및 다음 액션',
    '성공은 합의된 범위의 구현 · 증명 · 검수 · 인계가 모두 끝난 상태입니다.',
    '마지막으로 오늘 결정된 사항과 미결 사항을 다시 읽고 담당자와 완료일을 확인합니다. Q&A 후 회의록을 배포합니다.')
  const rows = [
    ['1', '기존 DB · 파일 1차 스냅샷 전달', '고객사', '11/27 (금)'],
    ['2', '요구사항 · 범위 기준선 승인', '고객사 · 수행사', '11/27 (금)'],
    ['3', '운영 환경(사내 / AWS) 확정', '고객사', '12/04 (금)'],
    ['4', '검증 참여 CM 지정 (1~2명)', '고객사', '11/27 (금)'],
    ['5', '도면 유출 방지 적용 범위 결정', '고객사', '12/04 (금)'],
    ['6', '인수 기준 · UAT 시나리오 합의', '양사', '12/11 (금)'],
  ]
  s.addTable([
    ['#', '다음 액션', '담당', '기한'].map((t, i) => ({ text: t, options: { bold: true, fontSize: 9.5, color: MUTED,
      fill: { color: WHITE }, align: i === 0 ? 'center' : i === 3 ? 'right' : 'left', margin: [0.06, 0.1, 0.06, 0.1],
      border: [{ type: 'none' }, { type: 'none' }, { pt: 1.4, color: NAVY }, { type: 'none' }] } })),
    ...rows.map((r, i) => r.map((c, j) => ({ text: c, options: {
      fontSize: 11.5, color: j === 1 ? INK : BODY, bold: j === 0 || j === 1,
      align: j === 0 ? 'center' : j === 3 ? 'right' : 'left', valign: 'middle',
      fill: { color: i % 2 ? SOFT : WHITE }, margin: [0.08, 0.1, 0.08, 0.1],
      border: [{ type: 'none' }, { type: 'none' }, { pt: 0.8, color: LINE }, { type: 'none' }] } }))),
  ], { x: M, y: BODY_Y, w: 7.55, colW: [0.45, 4.1, 1.8, 1.2], rowH: 0.46, autoPage: false })

  s.addShape(R, { x: DISC_X, y: BODY_Y, w: DISC_W, h: 3.22, fill: { color: NAVY },
    line: { color: NAVY }, rectRadius: 0.06 })
  s.addText('완료 기준', { x: DISC_X + 0.26, y: BODY_Y + 0.22, w: DISC_W - 0.52, h: 0.3,
    fontSize: 11, bold: true, color: CYAN, charSpacing: 1, valign: 'middle', isTextBox: true, margin: 0 })
  s.addText([
    '기능 체크리스트 전수 통과',
    '도면 · MDB 전량 이행 + sha256 전수 일치',
    '성능 기준 자동 검사 통과',
    '반출 → 반입 → 검수 → 승인 1회전 성공',
    'UAT 승인 및 운영 인계 완료',
  ].map((t, i, a) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < a.length - 1, paraSpaceAfter: 10 } })),
    { x: DISC_X + 0.26, y: BODY_Y + 0.62, w: DISC_W - 0.52, h: 2.4, fontSize: 11.5, color: 'D5E2EC',
      valign: 'top', isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 })

  s.addShape(R, { x: M, y: 6.00, w: W, h: 0.62, fill: { color: PANEL }, line: { color: PANEL_LN, width: 1 }, rectRadius: 0.05 })
  s.addText('2026. 11. 17. 착수  →  2027. 01. 15. 완료      |      기능은 그대로, 구조는 다시, 같다는 것은 증명으로',
    { x: M + 0.2, y: 6.00, w: W - 0.4, h: 0.62, fontSize: 13, bold: true, color: NAVY,
      align: 'center', valign: 'middle', isTextBox: true, margin: 0 })
}

;(async () => {
  await pres.writeFile({ fileName: OUT })
  await applyTheme(OUT, THEME)
  console.log('wrote', OUT)
})()
