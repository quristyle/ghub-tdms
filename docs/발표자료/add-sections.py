"""
tdms_project_kickoff_이순열.pptx — 템플릿 틀을 유지한 채 장을 더한다.

더하는 장 (기존 장을 복제해 만들므로 서식·색이 그대로다)
  02 목차
  05 고쳐야 할 3가지              (TDMS_Kickoff_20261124.pptx 4쪽)
  06 보안 점검 — 보완 과제 25건    (같은 자료 5쪽)
  07 개발 방향성 3원칙             (같은 자료 6쪽)
  17 주차별 일정표                 (같은 자료 13쪽, 9주로 고쳐 담음)

재실행하면 이미 있는 장은 다시 만들지 않고 내용만 다시 채운다.
쪽번호는 마지막에 전부 다시 매긴다.

  python3 fill-template.py      # 템플릿 → 20장 내용
  python3 add-sections.py       # 위 5장 추가 + 쪽번호 재부여
"""
import copy
import re
import subprocess
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

D = Path('/home/quri/ghub-tdms/docs/발표자료')
DECK = D / 'tdms_project_kickoff_이순열.pptx'
BG = D / 'bg.jpeg'          # 표지 배경 사진
ADD_SLIDE = Path('/home/quri/.config/Claude/local-agent-mode-sessions/skills-plugin/'
                 '7710af1b-794d-4ef5-afc5-06250aeef761/dc0e4c7f-dd5e-45c8-ac6d-5d991ab0fcdc/'
                 'skills/pptx/scripts/add_slide.py')

FONT = 'Aptos'
NAVY, BODY, MUTED = '12233E', '222F3E', '5A6C82'
BLUE, TEAL, GREEN, ORANGE = '2369BE', '1EAABE', '2C9170', 'DE8F30'
PANEL, CARD, LINE, SOFTBAR = 'EDF4FB', 'F7F9FC', 'DCE3EB', 'B9C6D6'

C = lambda h: RGBColor.from_string(h)

# 복제 원본: 3 = 불릿+논의 포인트 장, 12 = 카드 4장 장
NEW = [   # (새 장 제목, 복제할 장의 제목, 이 장 뒤에)
    ('표지', 'PROJECT', 'PROJECT'),
    ('목차', '추진 배경 및 현황', '도면관리 시스템 구축'),
    ('고쳐야 할 3가지', '9주 추진 일정 및 마일스톤', '추진 배경 및 현황'),
    ('보안 점검 — 보완 과제 25건', '9주 추진 일정 및 마일스톤', '고쳐야 할 3가지'),
    ('개발 방향성 3원칙', '9주 추진 일정 및 마일스톤', '보안 점검 — 보완 과제 25건'),
    ('성능 — 측정으로 지키는 개선', '9주 추진 일정 및 마일스톤', '개발 방향성 3원칙'),
    ('사전 구축 단계별 현황', '프로젝트 조직 및 R&R', '사전 준비분 및 활용 범위'),
    ('남은 일 — 이행 · 검증 · 전환', '9주 추진 일정 및 마일스톤', '사전 구축 단계별 현황'),
    ('아키텍처 구성도', '추진 배경 및 현황', '목표 시스템 아키텍처'),
    ('주차별 일정표', '추진 배경 및 현황', '9주 추진 일정 및 마일스톤'),
    ('질의응답', 'PROJECT', '프로젝트 성공 기준 및 다음 액션'),
]

# ── 목차 ────────────────────────────────────────────────────────────
TOC = [
    [('착수', None), (None, '02  목차'), (None, '03  Kick-off에서 합의할 사항'),
     ('배경과 진단', None), (None, '04  추진 배경 및 현황'), (None, '05  고쳐야 할 3가지'),
     (None, '06  보안 점검 — 보완 과제 25건')],
    [('개선 방향', None), (None, '07  개발 방향성 3원칙'), (None, '08  성능 — 측정으로 지키는 개선'),
     (None, '09  프로젝트 목표 및 성공 기준'),
     ('범위와 기능', None), (None, '10  개발 범위 및 경계'), (None, '11  주요 사용자 및 업무 기능'),
     (None, '12  요구사항 정의 및 변경 관리'), (None, '13  사전 준비분 및 활용 범위'),
     (None, '14  사전 구축 단계별 현황'), (None, '15  남은 일 — 이행 · 검증 · 전환')],
    [('설계', None), (None, '16  목표 시스템 아키텍처'), (None, '17  아키텍처 구성도'),
     (None, '18  기술 스택 및 적용 원칙'), (None, '19  데이터 및 API 설계 원칙'),
     ('일정과 실행', None), (None, '20  9주 추진 일정 및 마일스톤'), (None, '21  주차별 일정표'),
     (None, '22  단계별 산출물 및 승인 게이트'), (None, '23  프로젝트 조직 및 R&R')],
    [('품질과 운영', None), (None, '24  개발 협업 및 형상관리'), (None, '25  테스트 및 품질 전략'),
     (None, '26  Docker 기반 배포 및 운영 전환'), (None, '27  보안 · 리스크 및 대응 계획'),
     (None, '28  커뮤니케이션 및 의사결정 체계'),
     ('마무리', None), (None, '29  프로젝트 성공 기준 및 다음 액션'), (None, '30  질의응답 (Q & A)')],
]

# ── 주차별 일정표 ───────────────────────────────────────────────────
WEEKS = ['11/17', '11/23', '11/30', '12/07', '12/14', '12/21', '12/28', '01/04', '01/11']
ROWS = [
    ('착수 · 현행 분석 · 기준선 확정', 0, 2, NAVY),
    ('설계 확정 · 운영 환경 결정', 1, 2, BLUE),
    ('차이분 구현 · 변환 워커 구성', 2, 3, BLUE),
    ('데이터 이행 설계 · 리허설', 3, 3, NAVY),
    ('통합 · 성능 · 보안 점검', 5, 2, SOFTBAR),
    ('섀도 비교 운영 (2주)', 6, 2, BLUE),
    ('UAT · 사용자 교육', 7, 1, SOFTBAR),
    ('본 이행 → 전환 → 인수 인계', 8, 1, NAVY),
]
MILESTONE = ('마일스톤:  11/27 기준선 승인  →  12/04 설계 · 환경 확정  →  12/11 이행 리허설  →  '
             '12/18 기능 시연  →  12/25 UAT 진입  →  01/08 UAT 승인  →  01/15 인계')

# ── 카드 장 3종 내용 ────────────────────────────────────────────────
CARDS_FIX = [   # 고쳐야 할 3가지
    (ORANGE, '① 폴더가 문자열이다',
     ['이름 한 번 바꾸면 수천 건 수정 + 디스크 이동',
      '중간에 실패하면 DB와 디스크가 어긋난다']),
    (ORANGE, '② 파일명이 메타데이터',
     ['리비전이 오르면 파일 이름이 바뀐다',
      '승인 1건마다 디스크 작업 + 같은 파일이 여러 벌']),
    (ORANGE, '③ 장시간 작업이 동기 실행',
     ['큰 건을 돌리면 화면이 수십 초 멈춘다',
      '그동안 다른 사용자의 조회까지 느려진다']),
]
CARDS_SEC = [   # 보안 점검
    (ORANGE, '높음  7건', ['접근통제 · 업로드 · 가용성', 'AWS·외부 서비스 전 반드시 조치']),
    (BLUE, '중간  13건', ['인증 · 운영 · 데이터', '세션 통제 · 평문 .env · CVE 점검']),
    (TEAL, '낮음  5건', ['경로 · 감사 · 개인정보', '경로 2중 검증 · 감사로그 보존']),
    (GREEN, '양호  20건', ['이미 구현된 통제 — 그대로 승계', 'CSP · CSRF · PBKDF2 · 엑셀수식 차단']),
]
CARDS_PRIN = [  # 개발 방향성 3원칙
    (BLUE, '원칙 1 · 기능을 깎지 않는다',
     ['메뉴 9 · 화면 14 · 권한 36 · API 201 전수 재현', '화면 구성과 용어를 유지해 재교육 부담을 없앤다',
      '범위 축소는 고객사 결정 사항']),
    (TEAL, '원칙 2 · 관리성과 성능이 1순위',
     ['같은 기능을 고치기 쉬운 구조로 다시 짠다', '권한 · 감사는 선언하지 않으면 서버가 뜨지 않는다',
      '성능 기준을 자동 검사에 걸어 느려지면 빌드 실패']),
    (GREEN, '원칙 3 · 동등성은 증명한다',
     ['① API 201개 계약 대조  ② 화면 요소 자동 대조', '③ 신 · 구 서버 응답 비교(섀도 2주)',
      '데이터는 건수와 sha256 전수 일치로 확인']),
]

CARDS_REST = [  # 남은 일 — 원본 12쪽
    (BLUE, '1 · 데이터 이행',
     ['기존 DB · 파일을 새 구조로 — 파일 16,400개 재배치',
      '건수와 sha256 전수 대조  ·  ※ 기존 자료 수령 필요']),
    (TEAL, '2 · 변환 워커',
     ['DWG · 오피스 변환 엔진을 운영 서버에 설치',
      '대량 반입 · Zip · 백업을 실환경에서 검증']),
    (GREEN, '3 · 동등성 검증',
     ['섀도 비교 2주 — 신 · 구 응답 비교(쓰기는 기존만)',
      '업무 영향 없음  ·  ※ CM 확인 참여 필요']),
    (ORANGE, '4 · 전환',
     ['병행 운영 → 전환 → 1~2주 밀착 대응',
      '실패 시 기존 시스템으로 즉시 복귀']),
]

CARDS_PERF = [  # 성능 — 실제 규모의 5배(52,000건)로 측정
    (BLUE, '목록 · 검색', ['기존 2초  →  목표 150ms', '실측 0.07ms']),
    (TEAL, '깊은 페이지 (37,000번째)', ['기존 갈수록 느려짐  →  목표 동일 속도', '실측 2.45ms']),
    (GREEN, '폴더 이름 변경 (하위 38,000)', ['기존 수십 초  →  목표 50ms', '실측 0.89ms']),
    (ORANGE, '한글 검색 · 첫 화면', ['부분일치 검색 1.57ms', '첫 화면 전송량 43KB (목표 150KB)']),
]

STAGES = [   # 사전 구축 단계별 현황 — (단계, 이름, 상태)
    ('단계 0 · 1', '기준선 · 데이터', '완료 — 기능 인벤토리 · 스키마 29표'),
    ('단계 2', '골격 · 권한', '완료 — 계약 · 인증 · 권한 리프 36'),
    ('단계 3', '조회 · PDF 뷰어', '완료 — 목록 · 상세 · 뷰어 이식'),
    ('단계 4 · 5', '반입 · 검수 · 반출', '완료 — 상태 머신 · 분기 리비전'),
    ('단계 6 · 7', 'MDB · 운영', '완료 — Tag 이력 · 로그 · 권한 · 백업'),
    ('단계 8', '이행 · 전환', '이번 9주 — 대조 · 이행 · 검증'),
]

HEAD = {   # 제목 / 핵심 메시지
    '남은 일 — 이행 · 검증 · 전환': '남은 일은 기능 개발이 아니라 옮기고 · 맞는지 증명하고 · 바꿔 다는 작업입니다.',
    '사전 구축 단계별 현황': '단계 0~7 은 착수 전 선행 구축분입니다. 이번 9주는 단계 8(이행 · 전환)에 집중합니다.',
    '목차': '전체 30장을 여섯 묶음으로 봅니다. 오늘 결론이 필요한 것은 마지막 묶음입니다.',
    '성능 — 측정으로 지키는 개선': '말이 아니라 측정으로 보입니다. 실제 규모의 5배(52,000건)로 재고, 그 기준을 자동 검사로 고정했습니다.',
    '아키텍처 구성도': '프로세스 3종(API · 워커 · DB)과 nginx 파일 직송. 미들웨어를 하나도 늘리지 않았습니다.',
    '고쳐야 할 3가지': '기능의 문제가 아니라 구조의 문제입니다. 부분 수정으로는 풀리지 않습니다.',
    '보안 점검 — 보완 과제 25건': '양호 통제 20건은 그대로 승계하고, 높음 7건은 구조에서 해소합니다.',
    '개발 방향성 3원칙': '기능 100% 보존 · 관리성과 성능 1순위 · 동등성은 증명.',
    '주차별 일정표': '2026.11.17 착수 → 2027.01.15 완료. 주차별로 겹치는 구간이 많아 승인 지연이 곧 일정 지연입니다.',
}
BOTTOM = {
    '남은 일 — 이행 · 검증 · 전환': '1번과 3번은 고객사 협조가 있어야 시작된다 — 자료 수령(11/27)과 검증 참여 CM 지정이 일정의 출발점',
    '사전 구축 단계별 현황': '단계 0~7 은 기준선 대조 전 상태 — 요구사항이 확정되면 차이분을 구현에 반영한다',
    '성능 — 측정으로 지키는 개선': '52,000건 적재 기준 · 목록 1페이지가 51ms 걸리던 것도 이 측정에서 드러나 0.2ms(255배)로 고쳤다 — 기준치를 넘기는 코드는 배포되지 않는다',
    '고쳐야 할 3가지': '세 가지 모두 파일을 움직이지 않는 구조(폴더 테이블 · 내용 해시 저장 · 작업 큐)로 풀었다',
    '보안 점검 — 보완 과제 25건': '높음 7건 해소 위치: nginx 접근통제 · 업로드 용량/매직바이트 검증 · 라우트 선언형 권한 · 자동 배포와 롤백',
    '개발 방향성 3원칙': '세 원칙은 문서가 아니라 실행되는 검사로 고정한다 — 어기는 코드는 배포되지 않는다',
}


# ── 도구 ────────────────────────────────────────────────────────────
def titles(prs):
    out = []
    for sl in prs.slides:
        tt = [sh.text_frame.text.strip() for sh in sl.shapes
              if sh.has_text_frame and sh.text_frame.text.strip()]
        out.append(tt[1] if len(tt) > 1 else (tt[0] if tt else ''))
    return out


def drop(shape):
    shape._element.getparent().remove(shape._element)


def set_paragraphs(shape, texts):
    tf = shape.text_frame
    paras = [p for p in tf.paragraphs if p.runs]
    while len(paras) < len(texts):
        last = paras[-1]
        last._p.addnext(copy.deepcopy(last._p))
        paras = [p for p in tf.paragraphs if p.runs]
    for i, p in enumerate(paras):
        p.runs[0].text = texts[i] if i < len(texts) else ''
        for r in p.runs[1:]:
            r.text = ''


def textbox(slide, x, y, w, h, text, size, color, bold=False,
            align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    p = tf.paragraphs[0]
    p.alignment = align
    r = p.add_run()
    r.text = text
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.name = FONT
    r.font.color.rgb = C(color)
    return tb


def bar(slide, x, y, w, h, color, shape=MSO_SHAPE.RECTANGLE, radius=None):
    sp = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    sp.fill.solid()
    sp.fill.fore_color.rgb = C(color)
    sp.line.color.rgb = C(color)
    sp.shadow.inherit = False
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        sp.adjustments[0] = radius
    return sp


def body_shapes(slide):
    """복제본에서 머리글·바닥글을 뺀 본문 도형"""
    keep = ('PROJECT KICK-OFF', '도면관리 시스템(TDMS) 구축  |', '발표자 가이드는', '핵심 메시지')
    out = []
    for sh in list(slide.shapes):
        if not sh.has_text_frame:
            out.append(sh)
            continue
        t = sh.text_frame.text.strip()
        if t.startswith(keep) or re.fullmatch(r'\d{2}', t) or not t:
            if t.startswith('핵심 메시지') or t.startswith(keep[:3]):
                continue
            out.append(sh)
        else:
            out.append(sh)
    return out


# ── 장 만들기 ───────────────────────────────────────────────────────
def build_toc(slide):
    for sh in list(slide.shapes)[8:]:         # 불릿·논의 포인트 상자 제거
        drop(sh)
    xs = [0.80, 3.95, 7.10, 10.00]
    ws = [3.00, 3.00, 2.80, 3.10]
    for col, items in enumerate(TOC):
        y = 2.62
        for head, item in items:
            if head:
                y += 0.10 if y > 2.62 else 0
                textbox(slide, xs[col], y, ws[col], 0.26, head, 12, BLUE, bold=True)
                y += 0.34
            else:
                textbox(slide, xs[col] + 0.12, y, ws[col] - 0.12, 0.26, item, 11, BODY)
                y += 0.30


def build_gantt(slide):
    for sh in list(slide.shapes)[8:]:
        drop(sh)
    gx, gw = 3.70, 9.05
    cw = gw / len(WEEKS)
    for i, wk in enumerate(WEEKS):
        textbox(slide, gx + i * cw, 2.66, cw, 0.24, wk, 9,
                NAVY if i in (0, len(WEEKS) - 1) else MUTED, bold=True, align=PP_ALIGN.CENTER)
    bar(slide, 0.75, 2.94, 12.00, 0.014, NAVY)
    top, rh = 3.02, 0.40
    for n, (label, start, span, color) in enumerate(ROWS):
        y = top + n * rh
        textbox(slide, 0.75, y, 2.85, rh, label, 11,
                NAVY if n == len(ROWS) - 1 else BODY,
                bold=(n == len(ROWS) - 1), anchor=MSO_ANCHOR.MIDDLE)
        bar(slide, gx + start * cw + 0.04, y + 0.09, cw * span - 0.08, rh - 0.18, color)
        sep = bar(slide, 0.75, y + rh - 0.01, 12.00, 0.01, LINE)
        sep.line.fill.background()
    panel = bar(slide, 0.75, 6.42, 12.00, 0.52, PANEL, MSO_SHAPE.ROUNDED_RECTANGLE, 0.10)
    panel.line.color.rgb = C('CFDEEC')
    textbox(slide, 0.95, 6.42, 11.60, 0.52, MILESTONE, 10.5, NAVY, bold=True,
            align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def build_cards(slide, cards, bottom):
    """카드 4장 장을 n장짜리로 고쳐 쓴다 (도형은 그대로 쓰고 자리만 옮긴다)"""
    shapes = list(slide.shapes)
    wide = next((i for i, sh in enumerate(shapes)
                 if i >= 8 and sh.has_text_frame and sh.width > Inches(8)
                 and not sh.text_frame.text.startswith('발표자 가이드')), len(shapes))
    body = shapes[8:wide]
    groups = [body[i:i + 4] for i in range(0, len(body), 4)]
    tail = shapes[wide] if wide < len(shapes) else None
    n = len(cards)
    for g in groups[n:]:                                # 남는 카드는 버린다
        for sh in g:
            drop(sh)
    gap, left, right = 0.30, 0.75, 12.75
    cwid = (right - left - gap * (n - 1)) / n
    for i, (color, title, lines) in enumerate(cards):
        card, side, t_tb, b_tb = groups[i]
        x = left + i * (cwid + gap)
        card.left, card.width = Inches(x), Inches(cwid)
        side.left, side.width = Inches(x), Inches(0.08)
        for tb in (t_tb, b_tb):
            tb.left, tb.width = Inches(x + 0.20), Inches(cwid - 0.40)
        side.fill.solid()
        side.fill.fore_color.rgb = C(color)
        side.line.color.rgb = C(color)
        set_paragraphs(t_tb, [title])
        set_paragraphs(b_tb, lines)
    if tail is not None:
        if bottom:
            set_paragraphs(tail, [bottom])
        else:
            drop(tail)


def build_stage(slide):
    """6칸 칩 장(조직 R&R 복제)을 단계별 현황으로 고쳐 쓴다"""
    shapes = list(slide.shapes)
    groups = [shapes[i:i + 4] for i in (8, 12, 16, 20, 24, 28)]   # 칩 + 3줄
    for (box, l1, l2, l3), (stage, name, state) in zip(groups, STAGES):
        set_paragraphs(l1, [stage])
        set_paragraphs(l2, [name])
        set_paragraphs(l3, [state])
        if stage == '단계 8':                      # 진행 예정만 색을 달리
            box.fill.solid()
            box.fill.fore_color.rgb = C(PANEL)
            box.line.color.rgb = C(BLUE)
    set_paragraphs(shapes[32], [BOTTOM['사전 구축 단계별 현황']])
    set_paragraphs(shapes[33], ['※ 화면 14+4 · 권한 36 · 흐름 검증 138건 · 52,000건 성능 측정은 모두 단계 0~7 의 결과'])


def build_arch(slide):
    """api.jpeg 구도 — 사용자 → 화면(Frontend) → 책임 분리(API 게이트) → 백엔드 → 데이터 흐름"""
    for sh in list(slide.shapes)[8:]:
        drop(sh)

    def panel(x, y, w, h, title, sub):
        sp = bar(slide, x, y, w, h, 'EAF1F8', MSO_SHAPE.ROUNDED_RECTANGLE, 0.03)
        sp.line.color.rgb = C('C4D6E8')
        textbox(slide, x, y + 0.16, w, 0.28, title, 12.5, NAVY, bold=True, align=PP_ALIGN.CENTER)
        textbox(slide, x, y + 0.46, w, 0.24, sub, 9.5, MUTED, align=PP_ALIGN.CENTER)

    def chip(x, y, w, h, text, sub=None, fill='FFFFFF', border=LINE, color=None, dash=False):
        sp = bar(slide, x, y, w, h, fill, MSO_SHAPE.ROUNDED_RECTANGLE, 0.08)
        sp.line.color.rgb = C(border)
        if dash:
            sp.line.dash_style = MSO_LINE.DASH
        if text:
            textbox(slide, x + 0.06, y + (0.10 if sub else 0), w - 0.12,
                    0.26 if sub else h, text, 10.5, color or NAVY, bold=True,
                    align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.TOP if sub else MSO_ANCHOR.MIDDLE)
        if sub:
            textbox(slide, x + 0.06, y + 0.36, w - 0.12, h - 0.42, sub, 9, MUTED,
                    align=PP_ALIGN.CENTER)
        return sp

    def arrow(x1, y1, x2, y2, label=None, lx=None, ly=None):
        ln = slide.shapes.add_connector(2, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
        ln.line.color.rgb = C(BLUE)
        ln.line.width = Pt(1.4)
        el = ln.line._get_or_add_ln()
        el.append(el.makeelement(
            '{http://schemas.openxmlformats.org/drawingml/2006/main}tailEnd',
            {'type': 'triangle', 'w': 'med', 'len': 'med'}))
        if label:
            textbox(slide, lx, ly, 2.2, 0.22, label, 9, MUTED, align=PP_ALIGN.CENTER)

    # 사용자
    user = bar(slide, 0.78, 3.95, 0.86, 0.86, 'FFFFFF', MSO_SHAPE.OVAL)
    user.line.color.rgb = C(BLUE)
    textbox(slide, 0.78, 4.26, 0.86, 0.26, '사용자', 10.5, NAVY, bold=True,
            align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    textbox(slide, 0.40, 4.92, 1.62, 0.22, 'CM · 사내 수십 명', 9, MUTED, align=PP_ALIGN.CENTER)

    # 화면 (Frontend)
    panel(2.10, 2.56, 4.05, 3.95, '화면  ·  Frontend', 'Vue 3 + Vite  |  화면 14 + 4')
    scr = ['TDB 조회 · 상세', 'TDB 반입 · 검수', 'TDB 관리 · 보관함',
           'TDB 반출이력', 'MDB 조회 · 관리', '운영 · 권한 · 백업']
    for i, t in enumerate(scr):
        cx = 2.28 + (i % 2) * 1.90
        cy = 3.30 + (i // 2) * 0.92
        chip(cx, cy, 1.74, 0.72, t)
    textbox(slide, 2.10, 6.08, 4.05, 0.24, 'PDF 뷰어 · 마크업 이식  ·  화면별 코드 분할', 9, MUTED,
            align=PP_ALIGN.CENTER)

    # 책임 분리 — API 게이트
    textbox(slide, 6.25, 2.92, 1.30, 0.44, '책임 분리', 11, BLUE, bold=True, align=PP_ALIGN.CENTER)
    textbox(slide, 6.15, 3.32, 1.50, 0.22, 'nginx 경계', 9, MUTED, align=PP_ALIGN.CENTER)
    chip(6.33, 4.00, 1.14, 0.76, None, fill=NAVY, border=NAVY)
    textbox(slide, 6.29, 4.08, 1.22, 0.60, 'API 게이트', 10.5, 'FFFFFF', bold=True,
            align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    textbox(slide, 6.00, 4.84, 1.80, 0.22, 'TLS · IP 제한 · 업로드 제한', 8.5, MUTED, align=PP_ALIGN.CENTER)

    # 백엔드
    panel(7.65, 2.56, 4.95, 3.95, 'API · 데이터  ·  Backend', 'Fastify(Node 22)  |  업무 규칙과 저장')
    chip(7.90, 3.26, 4.45, 0.56, 'API — Fastify / Node 22  ·  모듈 13 (기존 라우터와 1:1)')
    inner = bar(slide, 7.90, 3.94, 4.45, 0.92, 'FFFFFF', MSO_SHAPE.ROUNDED_RECTANGLE, 0.05)
    inner.line.color.rgb = C('9FB8CE')
    inner.line.dash_style = MSO_LINE.DASH
    for i, (t, sub) in enumerate([('업무 규칙', '상태 머신 · 리비전'),
                                  ('권한 · 감사', '선언 없으면 기동 실패'),
                                  ('작업 큐', '진행률 SSE')]):
        chip(8.02 + i * 1.44, 4.06, 1.32, 0.68, t, sub, fill='F7F9FC')
    for i, (t, sub) in enumerate([('PostgreSQL 16', '폴더 트리 · 한글 검색'),
                                  ('blob 저장소', '내용 해시 · 중복 제거'),
                                  ('워커 Python', 'DWG 변환 · Zip · 백업')]):
        chip(7.90 + i * 1.52, 5.06, 1.40, 0.80, t, sub)
    textbox(slide, 7.65, 6.08, 4.95, 0.24, '파일은 nginx 가 커널에서 직송 — 앱은 바이트를 만지지 않는다', 9,
            MUTED, align=PP_ALIGN.CENTER)

    # 흐름
    arrow(1.68, 4.38, 2.06, 4.38)
    arrow(6.17, 4.38, 6.31, 4.38)
    arrow(7.49, 4.38, 7.63, 4.38)
    arrow(10.10, 6.68, 3.20, 6.68)
    textbox(slide, 5.10, 6.44, 3.10, 0.22, '데이터 흐름 — REST API(JSON)', 9.5, BLUE, bold=True,
            align=PP_ALIGN.CENTER)


def _alpha(shape, pct):
    """도형 채우기를 반투명하게 (python-pptx 가 노출하지 않아 XML 로)"""
    clr = shape.fill.fore_color._xFill.find(
        '{http://schemas.openxmlformats.org/drawingml/2006/main}srgbClr')
    clr.append(clr.makeelement(
        '{http://schemas.openxmlformats.org/drawingml/2006/main}alpha',
        {'val': str(int(pct * 1000))}))


def build_cover(slide):
    """표지 — bg.jpeg 를 깔고, 사진이 비어 있는 왼쪽에 주제를 얹는다"""
    for sh in list(slide.shapes):                     # 전부 지우고 새로 짠다
        drop(sh)

    tree = slide.shapes._spTree
    pic = slide.shapes.add_picture(str(BG), 0, 0, Inches(13.333), Inches(7.5))
    tree.remove(pic._element)
    tree.insert(2, pic._element)                      # 맨 뒤

    veil = bar(slide, 0, 0, 13.333, 7.5, NAVY)        # 글자가 읽히게 한 겹
    veil.line.fill.background()
    _alpha(veil, 52)
    tree.remove(veil._element)
    tree.insert(3, veil._element)

    X, W = 0.85, 6.60                                 # 사진이 비어 있는 왼쪽
    textbox(slide, X, 1.00, W, 0.30, 'G.HUB TDMS  ·  기술자료 관리 시스템 재구축',
            11, '35C9E0', bold=True)
    textbox(slide, X, 1.95, W, 0.80, '도면관리 시스템 구축', 36, 'FFFFFF', bold=True)
    textbox(slide, X, 2.80, W, 0.80, 'PROJECT KICK-OFF', 36, 'FFFFFF', bold=True)
    textbox(slide, X, 3.92, W, 0.34, 'SK가스 G.Hub 사업장 도면(TDB) · 설비 데이터북(MDB) 관리 시스템',
            14, 'B9CEDF')
    rule = bar(slide, X, 4.46, 5.60, 0.02, '35C9E0')
    rule.line.fill.background()

    meta = [('수행 기간', '2026. 11. 17. ~ 2027. 01. 15.  (9주)'),
            ('Kick-off', '2026. 11. 24. (화) 11:00~11:40 · 정비동 회의실'),
            ('고객사 · 수행사', '지허브   ·   진네트웍스')]
    for i, (k, v) in enumerate(meta):
        y = 4.80 + i * 0.52
        textbox(slide, X, y, 1.75, 0.30, k, 9.5, '7E99B2', bold=True, anchor=MSO_ANCHOR.MIDDLE)
        textbox(slide, X + 1.80, y, W - 1.80, 0.30, v, 13, 'FFFFFF', bold=True,
                anchor=MSO_ANCHOR.MIDDLE)

    textbox(slide, X, 6.60, W + 1.2, 0.26,
            'VUE 3 · FASTIFY(NODE 22) · POSTGRESQL 16 · PYTHON 워커 · DOCKER',
            9.5, '6E89A3', bold=True)
    textbox(slide, 12.15, 7.10, 0.60, 0.22, '01', 9, '6E89A3', bold=True, align=PP_ALIGN.RIGHT)


def build_qna(slide):
    """표지를 복제해 질의응답 장으로"""
    shapes = list(slide.shapes)
    set_paragraphs(shapes[3], ['G.HUB TDMS  ·  도면관리 시스템(TDMS) 구축'])
    set_paragraphs(shapes[4], ['Q & A', '질의응답'])
    set_paragraphs(shapes[5], ['오늘 결정 사항과 미결 사항은 회의록으로 공유합니다'])
    set_paragraphs(shapes[7], ['결정 사항  운영 환경 · 자료 전달 창구 · 검증 참여 CM · 인수 기준',
                               '회의록 당일 공유  →  확인 요청  →  다음 주 이행 설계 착수'])
    set_paragraphs(shapes[8], ['2026. 11. 17. 착수  —  2027. 01. 15. 완료  |  도면관리 시스템(TDMS) 구축'])
    set_paragraphs(shapes[9], ['NEXT STEP'])
    set_paragraphs(shapes[10], ['11/27'])
    set_paragraphs(shapes[11], ['자료 1차 전달'])
    set_paragraphs(shapes[12], ['기준선 승인', '운영 환경 확정', 'CM 지정'])


MARK = {'질의응답': 'Q & A', '표지': '도면관리 시스템 구축'}   # 장을 찾아낼 표식(제목과 다를 때만)

BUILD = {
    '표지': build_cover,
    '남은 일 — 이행 · 검증 · 전환': lambda sl: build_cards(sl, CARDS_REST, BOTTOM['남은 일 — 이행 · 검증 · 전환']),
    '목차': build_toc,
    '주차별 일정표': build_gantt,
    '사전 구축 단계별 현황': build_stage,
    '아키텍처 구성도': build_arch,
    '질의응답': build_qna,
    '고쳐야 할 3가지': lambda sl: build_cards(sl, CARDS_FIX, BOTTOM['고쳐야 할 3가지']),
    '보안 점검 — 보완 과제 25건': lambda sl: build_cards(sl, CARDS_SEC, BOTTOM['보안 점검 — 보완 과제 25건']),
    '개발 방향성 3원칙': lambda sl: build_cards(sl, CARDS_PRIN, BOTTOM['개발 방향성 3원칙']),
    '성능 — 측정으로 지키는 개선': lambda sl: build_cards(sl, CARDS_PERF, BOTTOM['성능 — 측정으로 지키는 개선']),
}


def find(ts, needle):
    for i, t in enumerate(ts):
        if t.startswith(needle):
            return i
    raise SystemExit(f'못 찾은 장: {needle}')


def main():
    if not DECK.exists():
        sys.exit(f'없는 파일: {DECK}')

    for title, clone_of, after in NEW:
        prs = Presentation(DECK)
        ts = titles(prs)
        key = MARK.get(title, title)
        if any(key in t for t in ts):
            idx = next(i for i, t in enumerate(ts) if key in t)
            slide = list(prs.slides)[idx]
            shapes = list(slide.shapes)
            if title in HEAD:
                km = next((sh for sh in shapes if sh.has_text_frame
                           and sh.text_frame.text.startswith('핵심 메시지')), None)
                if km is not None:
                    set_paragraphs(km, [f'핵심 메시지  |  {HEAD[title]}'])
            BUILD[title](slide)
            prs.save(DECK)
            print(f'  · {idx + 1:>2}장 「{title}」 내용 갱신')
            continue
        files = [sl.part.partname.split('/')[-1] for sl in prs.slides]
        src_file = files[find(ts, clone_of)]
        after_idx = find(ts, after)
        res = subprocess.run([sys.executable, str(ADD_SLIDE), str(DECK), src_file,
                              '--after', files[after_idx], '-o', str(DECK.with_suffix('.tmp.pptx'))],
                             capture_output=True, text=True)
        if res.returncode:
            sys.exit(res.stdout + res.stderr)
        DECK.with_suffix('.tmp.pptx').replace(DECK)

        prs = Presentation(DECK)                        # 새 장은 anchor 바로 뒤
        slide = list(prs.slides)[after_idx + 1]
        shapes = list(slide.shapes)
        if title == '질의응답':
            set_paragraphs(shapes[4], ['Q & A', '질의응답'])
        elif title != '표지':
            set_paragraphs(shapes[2], [title])
        if title in HEAD:
            km = next((sh for sh in shapes if sh.has_text_frame
                       and sh.text_frame.text.startswith('핵심 메시지')), None)
            if km is not None:
                set_paragraphs(km, [f'핵심 메시지  |  {HEAD[title]}'])
        BUILD[title](slide)
        if title == '표지':                            # 맨 앞으로 옮기고 옛 표지는 뺀다
            lst = prs.slides._sldIdLst
            ids = list(lst)
            new_id = ids[after_idx + 1]
            lst.remove(new_id)
            lst.insert(0, new_id)
            lst.remove(list(lst)[1])
        prs.save(DECK)
        print(f'  + {1 if title == "표지" else after_idx + 2:>2}장 자리에 「{title}」')

    # 쪽번호 다시 매기기
    prs = Presentation(DECK)
    for no, slide in enumerate(prs.slides, 1):
        for sh in slide.shapes:
            if sh.has_text_frame and re.fullmatch(r'\d{2}', sh.text_frame.text.strip()):
                set_paragraphs(sh, [f'{no:02d}'])
    prs.save(DECK)

    ts = titles(Presentation(DECK))
    print(f'saved {DECK} | 전체 {len(ts)}장')
    for i, t in enumerate(ts, 1):
        print(f'  {i:>2} {t[:40]}')


if __name__ == '__main__':
    main()
