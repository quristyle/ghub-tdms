"""
tdms_project_kickoff_이순열.pptx  →  TDMS_Kickoff_이순열.html

PPT 의 글자와 자리를 읽어 손으로 고치기 쉬운 HTML 발표본을 만든다.
장마다 <section> 하나이고, 안쪽은 제목 · 핵심 메시지 · 본문(불릿/카드/표) 뿐이다.
HTML 을 직접 고쳐 나갈 것이므로, 다시 만들면 손댄 내용이 덮인다는 점만 주의.

  python3 build-html.py
"""
import html
import re
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu

D = Path('/home/quri/ghub-tdms/docs/발표자료')
DECK = D / 'tdms_project_kickoff_이순열.pptx'
OUT = D / 'TDMS_Kickoff_이순열.html'

SKIP = ('PROJECT KICK-OFF', '도면관리 시스템(TDMS) 구축  |', '발표자 가이드는')
E = lambda t: html.escape(t)


def shapes_of(slide):
    out = []
    for sh in slide.shapes:
        if not sh.has_text_frame:
            continue
        txt = [p.text.strip() for p in sh.text_frame.paragraphs if p.text.strip()]
        if not txt:
            continue
        joined = '\n'.join(txt)
        if joined.startswith(SKIP) or re.fullmatch(r'\d{2}', joined) or joined in '›→':
            continue
        out.append({'x': Emu(sh.left).inches, 'y': Emu(sh.top).inches,
                    'w': Emu(sh.width).inches, 'h': Emu(sh.height).inches,
                    'lines': txt})
    return sorted(out, key=lambda s: (round(s['y'], 1), s['x']))


def split(items):
    """제목 · 핵심 메시지 · 나머지"""
    title = key = None
    rest = []
    for it in items:
        t = it['lines'][0]
        if t.startswith('핵심 메시지'):
            key = t.split('|', 1)[1].strip() if '|' in t else t
        elif title is None and it['y'] < 1.3:
            title = '\n'.join(it['lines'])
        else:
            rest.append(it)
    return title, key, rest


def cluster(items, tol=0.45):
    """x 가 가까운 것끼리 묶어 카드로 본다"""
    cols = {}
    for it in items:
        k = next((c for c in cols if abs(c - it['x']) < tol), it['x'])
        cols.setdefault(k, []).append(it)
    return [sorted(v, key=lambda s: s['y']) for _, v in sorted(cols.items())]


def render_flow(rest):
    wide = [i for i in rest if i['w'] > 8]
    chips = cluster([i for i in rest if i['w'] <= 8])
    blocks = []
    for col in chips:
        lines = [l for it in col for l in it['lines']]
        sub = ''.join(f'<span>{E(l)}</span>' for l in lines[1:])
        blocks.append(f'<li><b>{E(lines[0])}</b>{sub}</li>')
    body = f'<ol class="flow" style="--n:{len(blocks)}">{"".join(blocks)}</ol>'
    for i in wide:
        body += f'<p class="foot">{E(" ".join(i["lines"]))}</p>'
    return body


def render_bullets(rest):
    left = [i for i in rest if i['x'] < 8.2 and i['lines'][0].startswith('•')]
    disc = [i for i in rest if i['x'] >= 8.2]
    wide = [i for i in rest if i['w'] > 8 and i not in left]
    chips = [i for i in rest if i not in left and i not in disc and i not in wide]
    out = ''
    if chips:                                  # 흐름 칩(이슈 → 브랜치 → …)
        out += render_flow(chips)
    inner = []
    if left:
        lis = ''.join(f'<li>{E(l.lstrip("• ").strip())}</li>'
                      for i in left for l in i['lines'])
        inner.append(f'<ul class="bullets">{lis}</ul>')
    if disc:
        items = [l for i in disc for l in i['lines'] if not l.startswith('DISCUSSION')]
        lis = ''.join(f'<li>{E(l.lstrip("• ").strip())}</li>' for l in items)
        inner.append(f'<aside class="disc"><h4>논의 포인트</h4><ul>{lis}</ul></aside>')
    if inner:
        out += f'<div class="split">{"".join(inner)}</div>'
    for i in wide:
        out += f'<p class="foot">{E(" ".join(i["lines"]))}</p>'
    return out


def render_cards(rest):
    wide = [i for i in rest if i['w'] > 8]
    cards = cluster([i for i in rest if i['w'] <= 8])
    blocks = []
    for col in cards:
        head = col[0]['lines'][0]
        lines = [l for it in col[1:] for l in it['lines']] + col[0]['lines'][1:]
        ps = ''.join(f'<p>{E(l)}</p>' for l in lines)
        blocks.append(f'<article><h3>{E(head)}</h3>{ps}</article>')
    body = f'<div class="cards" style="--n:{len(blocks)}">{"".join(blocks)}</div>'
    for i in wide:
        body += f'<p class="foot">{E(" ".join(i["lines"]))}</p>'
    return body


def render_toc(slide):
    cols = cluster(shapes_of(slide)[1:], tol=1.2)
    out = []
    for col in cols:
        items = []
        for it in col:
            for l in it['lines']:
                if re.match(r'^\d{2}\s', l):
                    no, name = l.split('  ', 1) if '  ' in l else (l[:2], l[2:])
                    items.append(f'<li><i>{E(no.strip())}</i>{E(name.strip())}</li>')
                elif not l.startswith('핵심'):
                    if items:
                        out.append('<ul>' + ''.join(items) + '</ul>')
                        items = []
                    out.append(f'<h4>{E(l)}</h4>')
        if items:
            out.append('<ul>' + ''.join(items) + '</ul>')
    return f'<div class="toc">{"".join(out)}</div>'


def render_gantt(slide):
    weeks, rows, bars, note = [], [], [], []
    for sh in slide.shapes:
        x, y, w = Emu(sh.left).inches, Emu(sh.top).inches, Emu(sh.width).inches
        if sh.has_text_frame and sh.text_frame.text.strip():
            t = sh.text_frame.text.strip()
            if t.startswith(SKIP) or re.fullmatch(r'\d{2}', t) or t.startswith('핵심'):
                continue
            if y < 1.3:
                continue
            if re.fullmatch(r'\d{2}/\d{2}', t):
                weeks.append((x, t))
            elif t.startswith('마일스톤'):
                note.append(t)
            elif x < 3.6 and y > 2.9:
                rows.append((y, t))
        elif not sh.has_text_frame and x > 3.6 and w > 0.5:
            bars.append((Emu(sh.top).inches, x, w))
    weeks.sort()
    rows.sort()
    cw = 9.05 / max(1, len(weeks))
    head = ''.join(f'<th>{E(t)}</th>' for _, t in weeks)
    body = ''
    for y, label in rows:
        bar = next((b for b in bars if abs(b[0] - y) < 0.3), None)
        cells = ''
        for c in range(len(weeks)):
            on = bar and round((bar[1] - 3.70) / cw) <= c < round((bar[1] - 3.70) / cw) + max(1, round(bar[2] / cw))
            cells += f'<td{" class=on" if on else ""}></td>'
        body += f'<tr><th scope="row">{E(label)}</th>{cells}</tr>'
    out = f'<table class="gantt"><thead><tr><th></th>{head}</tr></thead><tbody>{body}</tbody></table>'
    for t in note:
        out += f'<p class="foot">{E(t)}</p>'
    return out


def render_arch(rest):
    items = [i for i in rest if i['y'] > 2.2]
    front = [i for i in items if 2.0 <= i['x'] < 5.9]
    gate = [i for i in items if 5.9 <= i['x'] < 7.6]
    back = [i for i in items if i['x'] >= 7.6]
    user = [i for i in items if i['x'] < 2.0]

    def col(group, cls):
        head = group[0]['lines'][0] if group else ''
        sub = group[1]['lines'][0] if len(group) > 1 else ''
        chips = ''.join(
            '<li><b>{}</b>{}</li>'.format(E(i['lines'][0]),
                                          ''.join(f'<span>{E(l)}</span>' for l in i['lines'][1:]))
            for i in group[2:])
        return (f'<div class="arch-col {cls}"><h3>{E(head)}</h3>'
                f'<p class="sub">{E(sub)}</p><ul>{chips}</ul></div>')

    u = ''.join(f'<p>{E(l)}</p>' for i in user for l in i['lines'])
    g = ''.join(f'<p>{E(l)}</p>' for i in gate for l in i['lines'])
    return ('<div class="arch">'
            f'<div class="arch-user">{u}</div>'
            f'{col(front, "front")}'
            f'<div class="arch-gate">{g}</div>'
            f'{col(back, "back")}'
            '</div>')


def render_cover(items):
    big = [i for i in items if i['h'] > 0.5 and i['y'] < 3.6]
    meta = [i for i in items if 4.6 < i['y'] < 6.4]
    eyebrow = next((i['lines'][0] for i in items if i['y'] < 1.4), '')
    sub = next((i['lines'][0] for i in items if 3.6 <= i['y'] < 4.4), '')
    stack = next((i['lines'][0] for i in items if i['y'] >= 6.4), '')
    title = '<br>'.join(E(l) for i in big for l in i['lines'])
    rows = ''
    for i in range(0, len(meta), 2):
        k = meta[i]['lines'][0]
        v = meta[i + 1]['lines'][0] if i + 1 < len(meta) else ''
        rows += f'<div><dt>{E(k)}</dt><dd>{E(v)}</dd></div>'
    return (f'<p class="eyebrow">{E(eyebrow)}</p><h1>{title}</h1>'
            f'<p class="lead">{E(sub)}</p><div class="meta">{rows}</div>'
            f'<p class="stack">{E(stack)}</p>')


FLOW_TITLES = ('사전 구축 단계별 현황',)


def main():
    prs = Presentation(DECK)
    out = []
    for no, slide in enumerate(prs.slides, 1):
        items = shapes_of(slide)
        title, key, rest = split(items)
        cls, body = 'slide', ''
        if no == 1:
            cls += ' cover'
            body = render_cover(items)
            title = None
        elif title and title.startswith('Q & A'):
            cls += ' cover closing'
            body = render_cover(items)
            title = None
        elif title == '목차':
            body = render_toc(slide)
        elif title == '주차별 일정표':
            body = render_gantt(slide)
        elif title == '아키텍처 구성도':
            body = render_arch(rest)
        elif title in FLOW_TITLES:
            body = render_flow(rest)
        elif any(i['lines'][0].startswith('•') for i in rest):
            body = render_bullets(rest)
        elif rest:
            body = render_cards(rest)

        head = f'<h2>{E(title)}</h2>' if title else ''
        keyp = f'<p class="key">{E(key)}</p>' if key else ''
        out.append(f'<section class="{cls}" data-no="{no:02d}">\n'
                   f'  {head}\n  {keyp}\n  {body}\n</section>')

    OUT.write_text(TEMPLATE.replace('<!--SLIDES-->', '\n\n'.join(out)), encoding='utf-8')
    print(f'wrote {OUT}  ({len(out)}장)')


TEMPLATE = '''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>도면관리 시스템(TDMS) 구축 Kick-off</title>
<style>
  :root{
    --navy:#12233E; --ink:#222F3E; --muted:#5A6C82;
    --blue:#2369BE; --teal:#1EAABE; --green:#2C9170; --orange:#DE8F30;
    --panel:#EDF4FB; --card:#F7F9FC; --line:#DCE3EB; --paper:#fff;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:#2a3340;color:var(--ink);overflow:hidden;
    font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif}
  #stage{position:fixed;inset:0;display:grid;place-items:center}
  #deck{width:1280px;height:720px;position:relative;transform-origin:center;
    background:var(--paper);box-shadow:0 18px 60px rgba(0,0,0,.45)}

  .slide{position:absolute;inset:0;display:none;flex-direction:column;padding:52px 58px 58px}
  .slide.on{display:flex}
  .slide::before{content:"PROJECT KICK-OFF";position:absolute;left:58px;top:26px;
    font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--blue)}
  .slide::after{content:attr(data-no);position:absolute;right:58px;bottom:24px;
    font-size:11px;font-weight:700;color:var(--blue)}
  .slide > h2{font-size:34px;font-weight:800;letter-spacing:-.02em;color:var(--navy);
    margin:22px 0 14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  .key{background:var(--panel);border:1px solid #CFDEEC;border-radius:6px;
    margin:0 0 22px;padding:14px 18px;font-size:15px;font-weight:700;color:#1B4A72}
  .key::before{content:"핵심 메시지  |  ";color:var(--navy)}

  .split{display:grid;grid-template-columns:1fr 340px;gap:26px;flex:1;min-height:0}
  .bullets{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}
  .bullets li{position:relative;padding-left:16px;font-size:15.5px;line-height:1.55}
  .bullets li::before{content:"";position:absolute;left:0;top:9px;width:5px;height:5px;
    border-radius:50%;background:var(--blue)}
  .disc{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;height:max-content}
  .disc h4{margin:0 0 12px;font-size:11px;letter-spacing:.1em;color:var(--blue)}
  .disc ul{margin:0;padding-left:16px;font-size:13.5px;line-height:1.6;color:#45535f}
  .disc li{margin-bottom:8px}

  .cards{display:grid;gap:16px;grid-template-columns:repeat(var(--n,3),1fr)}
  .cards article{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--blue);
    border-radius:8px;padding:18px 18px 16px}
  .cards article:nth-child(2){border-left-color:var(--teal)}
  .cards article:nth-child(3){border-left-color:var(--green)}
  .cards article:nth-child(4){border-left-color:var(--orange)}
  .cards h3{margin:0 0 10px;font-size:16px;color:var(--navy)}
  .cards p{margin:0 0 7px;font-size:13px;line-height:1.55;color:#4a5765}

  .flow{display:grid;gap:12px;margin:0 0 20px;padding:0;list-style:none;
    grid-template-columns:repeat(var(--n,5),1fr)}
  .flow li{background:var(--panel);border:1px solid #CFDEEC;border-radius:8px;
    padding:14px 10px;text-align:center}
  .flow b{display:block;font-size:13px;color:var(--blue);margin-bottom:6px}
  .flow span{display:block;font-size:12.5px;color:#45535f;line-height:1.5}
  .flow span:first-of-type{font-size:15px;font-weight:700;color:var(--navy);margin-bottom:4px}

  .toc{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 26px;align-content:start}
  .toc h4{margin:10px 0 8px;font-size:13px;color:var(--blue)}
  .toc ul{margin:0 0 6px;padding:0;list-style:none}
  .toc li{font-size:13px;line-height:1.9;color:#39485a}
  .toc i{display:inline-block;width:26px;font-style:normal;color:var(--muted);font-variant-numeric:tabular-nums}

  .gantt{width:100%;border-collapse:collapse;font-size:12.5px}
  .gantt th{font-weight:700;color:var(--muted);font-size:11.5px;padding:6px 4px;text-align:center}
  .gantt thead th{border-bottom:2px solid var(--navy)}
  .gantt th[scope=row]{text-align:left;width:250px;color:var(--ink);font-weight:600}
  .gantt td{height:26px;border-bottom:1px solid var(--line)}
  .gantt td.on{background:var(--blue);border-radius:2px;box-shadow:inset 0 0 0 1px var(--blue)}
  .gantt tbody tr:last-child td.on{background:var(--navy)}

  .arch{display:grid;grid-template-columns:120px 1fr 110px 1.25fr;gap:14px;align-items:stretch;flex:1}
  .arch-col{background:var(--panel);border:1px solid #C4D6E8;border-radius:10px;padding:16px}
  .arch-col h3{margin:0;font-size:15px;color:var(--navy);text-align:center}
  .arch-col .sub{margin:4px 0 12px;font-size:11.5px;color:var(--muted);text-align:center}
  .arch-col ul{margin:0;padding:0;list-style:none;display:grid;gap:8px}
  .arch-col.front ul{grid-template-columns:1fr 1fr}
  .arch-col.back ul{grid-template-columns:repeat(3,1fr)}
  .arch-col li{background:#fff;border:1px solid var(--line);border-radius:7px;padding:10px 8px;text-align:center}
  .arch-col li b{display:block;font-size:12.5px;color:var(--navy)}
  .arch-col li span{display:block;font-size:11px;color:var(--muted);margin-top:3px}
  .arch-user,.arch-gate{display:flex;flex-direction:column;justify-content:center;gap:4px;text-align:center}
  .arch-user p,.arch-gate p{margin:0;font-size:12px;color:var(--muted)}
  .arch-user p:first-child,.arch-gate p:first-child{font-size:14px;font-weight:700;color:var(--navy)}

  .note,.foot{margin:16px 0 0;font-size:13px;color:var(--muted);line-height:1.6}
  .foot{text-align:center;font-weight:700;color:var(--blue)}

  .cover{background:var(--navy);color:#fff;justify-content:center;padding:0 70px}
  .cover::before,.cover::after{color:#6E89A3}
  .cover .eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;color:#35C9E0;margin:0 0 30px}
  .cover h1{font-size:50px;line-height:1.16;margin:0 0 20px;letter-spacing:-.02em}
  .cover .lead{font-size:17px;color:#B9CEDF;margin:0 0 34px}
  .cover .meta{display:flex;gap:40px;border-top:1px solid #35C9E0;padding-top:22px;max-width:900px}
  .cover .meta dt{font-size:11px;letter-spacing:.1em;color:#7E99B2;margin-bottom:6px}
  .cover .meta dd{margin:0;font-size:15px;font-weight:700}
  .cover .stack{position:absolute;left:70px;bottom:46px;font-size:11px;letter-spacing:.1em;color:#6E89A3}

  #bar{position:fixed;left:0;bottom:0;height:3px;background:var(--blue);width:0;transition:width .2s}
  #hint{position:fixed;right:14px;bottom:12px;font-size:12px;color:#93a3b5;
    background:rgba(0,0,0,.35);padding:5px 10px;border-radius:4px;transition:opacity .4s}
  @media print{
    @page{size:A4 landscape;margin:0}
    body{background:#fff;overflow:visible}
    #stage{position:static;display:block}
    #deck{height:auto;box-shadow:none;transform:none!important}
    .slide{position:relative;display:flex!important;width:1280px;height:720px;
      transform:scale(.855);transform-origin:top left;page-break-after:always}
    #bar,#hint{display:none!important}
  }
</style>
</head>
<body>
<div id="stage"><div id="deck">

<!--SLIDES-->

</div></div>
<div id="bar"></div>
<div id="hint">← → 이동 · F 전체화면 · P 인쇄</div>
<script>
(function(){
  var s=[].slice.call(document.querySelectorAll('.slide')),deck=document.getElementById('deck'),
      bar=document.getElementById('bar'),hint=document.getElementById('hint'),i=0;
  function fit(){var k=Math.min((innerWidth-24)/1280,(innerHeight-24)/720);deck.style.transform='scale('+k+')';}
  function show(n){i=Math.max(0,Math.min(s.length-1,n));
    s.forEach(function(x,k){x.classList.toggle('on',k===i)});
    bar.style.width=(i/(s.length-1)*100)+'%';location.hash='p'+(i+1);}
  addEventListener('resize',fit);
  addEventListener('keydown',function(e){var k=e.key;
    if(k==='ArrowRight'||k==='PageDown'||k===' '){show(i+1);e.preventDefault();}
    else if(k==='ArrowLeft'||k==='PageUp'){show(i-1);e.preventDefault();}
    else if(k==='Home')show(0); else if(k==='End')show(s.length-1);
    else if(k==='f'||k==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();}
    else if(k==='p'||k==='P')print();});
  addEventListener('click',function(e){show(e.clientX<innerWidth*0.25?i-1:i+1)});
  setTimeout(function(){hint.style.opacity=0},5000);
  var m=/p(\\d+)/.exec(location.hash||'');fit();show(m?+m[1]-1:0);
})();
</script>
</body>
</html>
'''

if __name__ == '__main__':
    main()
