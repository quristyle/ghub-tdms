// G.Hub 도면관리시스템이 이 뷰어(PDF.js)를 쓰려고 덧붙인 파일이다 — 원래 PDF.js에는 없다.
// 원본 파일 중 고친 것은 viewer.html 한 줄(이 파일을 부르는 <script> 태그)과
// build/pdf.worker.mjs의 [DMS 수정] 두 줄(저장 파일의 겹침 방식)뿐이므로, 나중에 PDF.js를 새 버전으로
// 올릴 때는 이 파일들을 그대로 두고 그 세 줄만 다시 넣으면 된다.
//
// 하는 일.
//  ① [저장] 파일명 — 손대지 않고 저장하면 `자료명.pdf`, 그리기·형광펜으로 고친 뒤 저장하면
//     `자료명(Markup).pdf`가 되게 한다(2026-09-02 CM 지시). 자료명 자체는 서버가 함께 내려주는
//     파일명을 PDF.js가 이미 쓰고 있어 손댈 것이 없고, 고친 것이 있을 때만 뒤에 (Markup)을 붙인다.
//  ② [파일 열기] 버튼 감추기 — 이 화면은 정해진 자료 1건을 보여주는 미리보기라, 여기서 다른 파일을
//     열면 지금 보는 것이 그 자료인 줄 알게 되어 위험하다.
//  ③ 쪽 이름 감추기 — 쪽 번호 칸에 `1` 대신
//     `[1] 0-1 TT01-10-04-002_(20251223)-모형` 같은 긴 이름이 뜨던 것을 번호만 보이게 한다
//     (2026-09-03 CM 지시). 그 이름은 우리가 넣은 것이 아니라 자료(PDF) 안에 들어 있는
//     "쪽 이름"으로, AutoCAD가 도면을 PDF로 내보낼 때 배치도 이름을 적어 둔 값이다.
//     화면에서 안 쓸 뿐 자료는 손대지 않으므로 저장한 PDF에는 그 이름이 그대로 남는다.
//  ④ 알림창 빌려 쓰기 — 미리보기는 언제나 우리 화면 안의 작은 창(iframe)으로 열리므로,
//     바깥 화면이 쓰는 알림창을 그대로 빌려 쓴다. 그래야 미리보기에서 나는 알림도 시스템의
//     다른 알림과 같은 모양이 된다(2026-09-03 CM 지시). 저장하지 않은 표시를 두고 화면을
//     떠나려 할 때 바깥 화면이 물어볼 수 있게 하는 창구(window.dmsMarkup)도 여기서 연다.
//  ⑤ 도구모음 손보기 (dms-tools.js) — 화면 회전 버튼을 쪽 번호 옆으로 꺼내고, 형광펜·펜·텍스트의
//     색 고르는 칸을 도형 도구와 같은 모양으로 바꾸고, 텍스트에 글자 크기 숫자와 배경 칠하기를 더하고,
//     [도구창 고정]으로 도구창이 창 밖을 눌러도 닫히지 않게 한다.
//  ⑥ 도형 도구 (dms-shapes.js) / ⑦ 지우개 도구 (dms-eraser.js)
//  ⑧ 표시를 골랐을 때 그 옆에 뜨는 작은 도구모음에 [채움 전환]·[회전]·[이동] 더하기 (dms-edit-toolbar.js)
//  ⑨ 보관 목록 (dms-favorite.js) — 도구모음 오른쪽 끝 [»] 안의 [보관하기]·[다른 이름으로 보관]으로
//     지금 그려 둔 편집 내용을 함께 저장하고, 저장해 둔 것을 열면 그대로 되살려 이어서 그릴 수 있게 한다.
//  ⑩ Ctrl+끌기 복사 · 끌어서 여러 개 고르기 (dms-copy.js) — Ctrl을 누르고 그려 둔 표시를 끌면
//     복사되고(Shift까지 누르면 수평·수직으로만), 여러 개를 골라 뒀으면 전부 복사된다.
//     [선택]으로 빈 자리를 끌면 고무줄 네모로 여러 개를 한 번에 고를 수 있다.
//  ⑪ 회전 (dms-rotate.js) — 그려 둔 표시(그리기·도형·텍스트·강조 표시·스탬프·이미지)를 돌린다.
//     표시 옆 작은 도구모음의 [회전]과, 도구모음의 [회전](손 도구와 이동 사이) 두 곳에서 쓴다.
//  ⑫ 화면을 90도 돌렸을 때 그려 둔 선·도형·형광펜이 엉뚱한 자리에 보이던 것 바로잡기
//     (2026-09-18 CM 지시) — PDF.js 자체의 순서 문제라 도구 스위치와 상관없이 늘 적용한다.
//     자세한 까닭은 아래 keepDrawingsInPlaceOnRotation 설명에 있다.
//  ⑬ 돌아간 채 놓인 도장(그림)을 되살릴 때의 두 가지 어긋남 바로잡기 (2026-09-18) —
//     화면을 90도 돌린 채 찍은 스탬프가 찌그러지지 않게, 그리고 다운로드해 둔 PDF 안의 도장을
//     다시 열어 그리기 도구를 켰을 때 뒤집히거나 눕지 않게 한다. 까닭은 keepRotatedStampsRight 설명에.
//
// 우리가 덧붙인 파일들
//   dms-viewer.js   : 여기 (모든 것을 불러 붙이는 자리)
//   dms-tools.js    : 도구모음 손보기        dms-tools.css   : 그 모양
//   dms-colors.js   : 색 고르는 칸 (네 도구가 함께 쓴다)
//   dms-state.js    : 지금 색·두께·켜진 도구를 모아 둔 값
//   dms-geometry.js : 도형 모양 계산
//   dms-link.js     : 채움과 테두리를 한 몸으로 묶기
//   dms-shapes.js   : 도형 도구             dms-shapes.css  : 그 모양
//   dms-eraser.js   : 지우개 도구
//   dms-stamp.js    : 스탬프 도구(Blind List 확인 도장)
//   dms-edit-toolbar.js : 표시 옆 작은 도구모음에 더한 버튼([채움 전환]·[회전]·[이동])
//   dms-favorite.js : 보관 목록 — 그려 둔 편집 내용을 보관하고 되살리기
//   dms-copy.js     : Ctrl+끌기 복사 · 끌어서 여러 개 고르기
//   dms-rotate.js   : 그려 둔 표시 돌리기

// 도형·지우개 등 우리가 덧붙인 도구를 쓸지 — 되돌리는 스위치.
// false로 두면 그 버튼들이 아예 생기지 않고 2026-09-02 오전 상태(도형 없는 뷰어)가 된다.
const USE_SHAPE_TOOL = true;

// 도구모음 손보기(회전 버튼·색 고르는 칸·글자 크기/배경)를 쓸지 — 되돌리는 스위치.
// false로 두면 PDF.js가 원래 갖고 있던 도구모음 그대로가 된다.
const USE_TOOLBAR_EXTRAS = true;

// 스탬프(Blind List 확인 도장) 도구를 쓸지 — 되돌리는 스위치 (2026-09-04 CM 지시).
// false로 두면 [스탬프] 버튼이 아예 생기지 않는다. 이미 찍어 둔 도장은 보통 그림 주석이라
// 그대로 남는다. USE_SHAPE_TOOL이 false면 이 값과 상관없이 스탬프도 생기지 않는다.
const USE_STAMP_TOOL = true;

// 보관 목록([»] 안의 [보관하기]·[다른 이름으로 보관] + 편집 내용 보관·되살리기)을 쓸지 —
// 되돌리는 스위치. false로 두면 그 두 버튼이 생기지 않고, 저장해 둔 편집 내용도 되살리지
// 않는다(자료는 그대로 열린다). 화면 위쪽 [보관] 버튼은 이 스위치와 상관없이 그대로 있다.
const USE_FAVORITE_TOOL = true;

// Ctrl+끌기 복사와 끌어서 여러 개 고르기를 쓸지 — 되돌리는 스위치 (2026-09-07 CM 지시).
// false로 두면 Ctrl+끌기는 예전처럼 "여러 개 고르기 켬/끔"이 되고 고무줄 선택도 생기지 않는다
// (도형만 복사되던 예전 동작으로 돌아가지는 않는다 — 그 코드는 dms-copy.js로 옮겼다).
const USE_COPY_TOOL = true;

// 그려 둔 표시를 돌리는 [회전]을 쓸지 — 되돌리는 스위치 (2026-09-18 CM 지시).
// false로 두면 표시 옆 작은 도구모음과 도구모음(손 도구와 이동 사이) 두 곳의 [회전]이 모두 생기지
// 않는다. USE_SHAPE_TOOL이 false면 이 값과 상관없이 생기지 않는다(작은 도구모음이 그쪽에 딸려 있다).
// 이미 돌려 둔 표시는 보통 주석이라 그대로 남는다.
const USE_ROTATE_TOOL = true;

// 도구모음의 [도구창 고정]·[Text 선택]·[Markup 선택] 켬/끔 스위치를 화면에 보여줄지 —
// 되돌리는 스위치 (2026-09-19 CM 지시). false여도 스위치는 눈에만 안 보일 뿐 그대로 있고
// 값은 처음 상태를 지킨다 — 도구창 고정 켬 · Text 선택 끔 · Markup 선택 끔. true로 바꾸면
// 예전처럼 다시 보이고 눌러서 바꿀 수 있다.
const SHOW_MODE_SWITCHES = false;

// 도구모음의 [회전]·[이동] 버튼(손 도구 오른쪽)을 화면에 보여줄지 — 되돌리는 스위치 (2026-09-19 CM 지시).
// 표시를 고르면 어차피 그 표시 옆에 [회전]·[이동]이 뜨기 때문에 숨겼다. 표시 옆 작은 도구모음의
// 버튼은 이 스위치와 상관없이 그대로 있다(USE_ROTATE_TOOL과 별개). true로 바꾸면 다시 보인다.
const SHOW_POINTER_EXTRA_BUTTONS = false;

// 자료(PDF) 안에 들어 있는 "쪽 이름"을 쪽 번호 칸에 쓰지 않을지 — 되돌리는 스위치.
// false로 두면 PDF.js가 원래 하던 대로 번호 대신 그 이름을 보여준다.
const HIDE_PAGE_LABELS = true;

const MARKUP_SUFFIX = "(Markup)"; // frontend/ui.js의 같은 이름 상수와 값이 같아야 한다

// "01. Tank Drawing.pdf" → "01. Tank Drawing(Markup).pdf"
function withMarkupSuffix(filename) {
  const name = String(filename || "");
  const dot = name.toLowerCase().lastIndexOf(".pdf");
  if (dot <= 0) return name + MARKUP_SUFFIX; // 확장자가 없는 이름이면 그냥 뒤에 붙인다
  return name.slice(0, dot) + MARKUP_SUFFIX + name.slice(dot);
}

// 원본(DWG·엑셀 등) 미리보기 창이면 그 형식 이름("DWG"), 아니면 null (주소의 dmsView·dmsLabel — ui.js가 붙인다).
function originalViewLabel() {
  const params = new URLSearchParams(window.location.search);
  return params.get("dmsView") === "original" ? (params.get("dmsLabel") || "") : null;
}

// "T11-116-10.pdf" + "DWG" → "T11-116-10(Dwg_Markup).pdf" (그린 것이 없으면 "T11-116-10(Dwg).pdf")
function withOriginalSuffix(filename, label, changed) {
  const name = String(filename || "");
  const base = name.toLowerCase().endsWith(".pdf") ? name.slice(0, -4) : name;
  const kind = label ? label.charAt(0).toUpperCase() + label.slice(1).toLowerCase() : "원본";
  return `${base}(${kind}${changed ? "_Markup" : ""}).pdf`;
}

// 이 미리보기를 띄운 바깥 화면 — 우리 시스템 화면 안에 있을 때만 돌려준다.
// (미리보기 주소만 따로 열어 본 경우나 다른 주소의 화면 안이면 빌려 쓸 것이 없다.)
function outerAppWindow() {
  try {
    const outer = window.parent;
    return outer && outer !== window && typeof outer.showAlert === "function" ? outer : null;
  } catch (e) {
    return null;
  }
}

/**
 * ⑫ 화면을 90도 돌린 뒤에도 그려 둔 표시(선·도형·형광펜)가 제자리에 보이게 한다.
 *
 * 배율이 [쪽 맞춤]처럼 창 크기를 따라가는 상태에서 쪽 번호 옆 회전 버튼으로 90도를 돌리면,
 * 쪽이 가로↔세로로 바뀌면서 배율도 함께 바뀐다. PDF.js는 이때 "배율이 바뀌었다"를 먼저 알리고
 * "각도가 바뀌었다"를 그다음에 알리는데(web/viewer.mjs의 pagesRotation), 배율을 맞추는 그 사이에는
 * 아직 옛 각도를 알고 있어서 그림(SVG)의 자리를 옛 각도로 다시 계산해 버린다. 파란 선택 테두리
 * (표시 칸)는 각도와 상관없이 맞게 놓이므로 둘이 어긋나 보였고, 그림은 원래 그렸던 도면 자리에서
 * 벗어나 있었다(2026-09-18 확인 — 우리가 만든 도형만이 아니라 PDF.js가 직접 그린 선도 같았다).
 * 180도로 돌릴 때는 배율이 안 바뀌어 원래도 맞았다.
 *
 * 그래서 "각도가 바뀌었다"는 알림이 끝난 **뒤에** 그림 자리를 새 각도로 한 번 더 계산해 준다.
 * rotate()는 PDF.js가 원래 화면 회전에 쓰는 함수이고 지금 각도를 다시 넣는 것뿐이라,
 * 이미 맞는 자리는 그대로 남는다. 그림이 없는 표시(문구·도장)는 해당이 없어 건너뛴다.
 */
function keepDrawingsInPlaceOnRotation(app) {
  app.eventBus.on("rotationchanging", () => {
    // 같은 알림을 받는 PDF.js의 편집 총괄이 새 각도를 적어 둔 뒤에 해야 하므로 한 박자 늦춘다
    // (우리 쪽이 먼저 붙어 있어 알림을 먼저 받는다).
    setTimeout(() => {
      const uiManager = app.pdfViewer?._layerProperties?.annotationEditorUIManager;
      if (!uiManager?.getEditors) return;
      for (let pageIndex = 0; pageIndex < app.pagesCount; pageIndex++) {
        for (const drawing of uiManager.getEditors(pageIndex)) {
          if (drawing._drawId == null || !drawing.parent) continue;
          try {
            drawing.rotate();
          } catch (err) {
            console.warn("[dms] redraw after rotation failed:", err);
          }
        }
      }
    }, 0);
  });
}

/**
 * ⑬ 돌아간 채 놓인 도장(그림)을 되살릴 때의 어긋남 두 가지를 바로잡는다 (2026-09-18).
 *
 * PDF.js는 표시를 "되살리는"(deserialize) 한 길로 도장을 다시 만든다 — 우리 스탬프 도구가 도장을
 * 찍을 때, 복사할 때, 보관해 둔 편집 내용을 다시 열 때, [회전]으로 돌릴 때, 그리고 다운로드해 둔 PDF
 * 안에 이미 들어 있는 도장을 그리기 도구를 켜서 고칠 수 있게 바꿀 때 모두 이 길을 쓴다. 이 길에
 * PDF.js 자체의 어긋남이 둘 있었다. 도장이 쪽과 같은 각도(0도)로만 놓이던 동안에는 드러나지 않다가,
 * 스탬프를 "지금 화면에 보이는 각도"로 찍게 되면서(쪽이 180도 돌아간 도면에서는 도장도 180도로
 * 놓인다) 드러났다.
 *
 *  ㉠ 크기 — 90·270도로 놓인 표시는 PDF의 가로·세로를 표시 칸의 세로·가로로 바꿔 읽어야 하는데,
 *     그림(도장)만은 바꾸지 않고 그대로 읽어 칸의 가로·세로가 뒤바뀌고 그림이 찌그러졌다.
 *     그래서 되살린 직후 도장의 크기만 다른 표시와 같은 규칙으로 다시 넣는다.
 *  ㉡ 그림의 방향 — PDF 안에 들어 있던 도장을 편집할 수 있게 바꿀 때 PDF.js는 화면에 그려져 있던
 *     그 도장 그림을 떠다 쓰는데, 그 그림은 "쪽을 돌리기 전" 모습이라 도장이 놓인 각도만큼 돌아가
 *     있다. 그것을 도장 칸에 그대로 넣어, 180도 도면에서는 도장이 뒤집히고 90도면 옆으로 누웠다
 *     (그리기 도구를 켜기 전에는 똑바로 보이다가 켜는 순간 뒤집혔다). 그래서 떠다 쓰기 전에 그 그림을
 *     도장이 놓인 각도만큼 되돌려 똑바로 세운 그림을 넘긴다. 떠다 쓰는 순간은 둘이다 — 되살릴 때
 *     그림이 이미 그려져 있으면 그 자리에서(data.canvas), 아직이면 나중에 그림이 그려지면서(setCanvas).
 *
 * PDF.js 원본은 고치지 않고, 편집 판(AnnotationEditorLayer)의 되살리기 함수를 한 번 감싸기만 한다.
 * 판은 쪽마다 따로 있지만 모두 같은 함수를 쓰므로 한 번 감싸면 전부에 적용된다.
 */
function keepRotatedStampsRight() {
  const { AnnotationEditorLayer, AnnotationEditorType, AnnotationType } = globalThis.pdfjsLib;
  const proto = AnnotationEditorLayer?.prototype;
  if (!proto?.deserialize || proto.dmsStampsKeptRight) return;
  proto.dmsStampsKeptRight = true;

  // PDF 안에 들어 있던 도장이고 쪽과 다른 각도로 놓였으면 그 각도(90·180·270), 아니면 0
  const savedStampRotation = (data) =>
    data?.container && data?.data?.annotationType === AnnotationType.STAMP
      ? ((data.data.rotation % 360) + 360) % 360
      : 0;

  // 그림을 시계방향으로 rotation만큼 돌린 새 그림판 — 90·270도면 가로·세로가 바뀐다
  const turnedCopy = (canvas, rotation) => {
    const copy = document.createElement("canvas");
    const sideways = rotation % 180 !== 0;
    copy.width = sideways ? canvas.height : canvas.width;
    copy.height = sideways ? canvas.width : canvas.height;
    const ctx = copy.getContext("2d");
    ctx.translate(copy.width / 2, copy.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return copy;
  };

  // ㉠ 크기 — 90·270도로 놓인 도장만
  const fixSize = (made, data) => {
    if (!made || made.mode !== AnnotationEditorType.STAMP || made.rotation % 180 === 0) return;
    // 우리가 넘기는 값은 data.rect, PDF 안에 저장돼 있던 도장을 편집할 때는 data.data.rect다.
    const rect = data?.rect || data?.data?.rect;
    if (!rect) return;
    const [pageWidth, pageHeight] = made.pageDimensions;
    made.width = (rect[3] - rect[1]) / pageWidth;
    made.height = (rect[2] - rect[0]) / pageHeight;
  };

  const original = proto.deserialize;
  proto.deserialize = async function (data) {
    const rotation = savedStampRotation(data);
    // ㉡ 그림이 이미 그려져 있으면 똑바로 세운 사본을 대신 넘긴다. PDF.js는 넘겨받은 그림판을 화면에서
    //    떼어 내므로(원래 자리의 그림이 도장과 겹쳐 보이지 않게), 사본을 넘긴 만큼 원래 것은 우리가 뗀다.
    const drawn = rotation && data.canvas ? data.canvas : null;
    if (drawn) data.canvas = turnedCopy(drawn, rotation);
    const made = await original.call(this, data);
    drawn?.remove();
    try {
      // ㉡ 그림이 아직 안 그려져 있었으면 나중에 그려질 때 넘겨받는 자리에서 똑같이 세운다.
      if (rotation && !drawn && made?.setCanvas) {
        const setCanvas = made.setCanvas;
        made.setCanvas = function (annotationElementId, canvas) {
          const result = setCanvas.call(this, annotationElementId, turnedCopy(canvas, rotation));
          canvas.remove();
          return result;
        };
      }
      fixSize(made, data);
    } catch (err) {
      console.warn("[dms] stamp fix failed:", err);
    }
    return made;
  };
}

function loadStyle(href) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

async function setupForDms() {
  const app = window.PDFViewerApplication;
  if (!app) return;
  await app.initializedPromise;

  // ① 저장 파일명. PDF.js는 손대지 않은 저장(download)과 고친 뒤 저장(save) 둘 다 이 함수를 거치므로
  //    여기 한 곳만 감싸면 두 경우가 모두 처리된다. _hasChanges()는 그리기·형광펜·텍스트 등
  //    편집이 하나라도 있으면 참이다(PDF.js가 제목에 * 를 붙일 때 쓰는 것과 같은 판단).
  //    원본(DWG 등) 미리보기 창은 이름 뒤에 형식을 붙인다 — 그린 것이 있으면 `자료명(Dwg_Markup).pdf`,
  //    없으면 `자료명(Dwg).pdf`(2026-09-20 CM 지시). 사본 PDF를 받은 것과 헷갈리지 않게 하기 위함이다.
  const manager = app.downloadManager;
  const download = manager.download.bind(manager);
  const originalLabel = originalViewLabel();
  manager.download = (data, url, filename) => {
    const changed = !!app._hasChanges?.();
    const name = originalLabel !== null
      ? withOriginalSuffix(filename, originalLabel, changed)
      : (changed ? withMarkupSuffix(filename) : filename);
    return download(data, url, name);
  };

  // ② [파일 열기] 감추기 (도구모음 오른쪽 끝 » 안에 있다)
  document.getElementById("secondaryOpenFile")?.classList.add("hidden");

  // ③ 쪽 이름 감추기. PDF.js는 자료를 열면 _initializePageLabels에서 그 자료의 "쪽 이름"을
  //    읽어 쪽 번호 칸과 미리보기 목록에 넣는다. 그 자리를 아무것도 안 하는 것으로 바꿔 번호만 남긴다.
  //    (PDF.js에 disablePageLabels 설정도 있지만, 브라우저에 저장된 환경설정이 나중에
  //     그 값을 되돌려 놓을 수 있어 확실한 이 방법을 썼다.)
  if (HIDE_PAGE_LABELS) app._initializePageLabels = async () => {};

  // ④ 알림창은 바깥 화면 것을 빌려 쓴다. PDF.js가 쓰는 브라우저 기본 알림창(window.alert)을
  //    시스템 알림창으로 바꿔 끼워, 미리보기에서 나는 알림도 다른 화면과 같은 모양이 되게 한다.
  const nativeAlert = window.alert.bind(window);
  window.alert = (message) => {
    const outer = outerAppWindow();
    if (outer) outer.showAlert(String(message == null ? "" : message));
    else nativeAlert(message);
  };

  //    바깥 화면이 "저장하지 않은 표시가 있는지" 물어보는 창구. 사용자가 떠나기로 하면
  //    allowLeaveOnce()로 알려주고, 그러면 브라우저가 제 모양의 경고창("사이트에서 나갈까요?")을
  //    겹쳐 띄우지 않는다 — PDF.js가 그 경고창을 띄울지 판단할 때 쓰는 _hasChanges를 잠깐 꺼둔다.
  window.dmsMarkup = {
    hasChanges: () => !!(app._hasChanges && app._hasChanges()),
    allowLeaveOnce() {
      const hasChanges = app._hasChanges;
      app._hasChanges = () => false;
      // 실제로 안 떠났으면(화면이 그대로 남아 있으면) 원래대로 돌려놓는다.
      setTimeout(() => { app._hasChanges = hasChanges; }, 3000);
    },
  };

  // ⑫ 화면을 90도 돌린 뒤 그림이 제자리에 보이게 (PDF.js 자체 문제라 스위치와 상관없이 늘 켠다)
  keepDrawingsInPlaceOnRotation(app);
  // ⑬ 돌아간 채 놓인 도장(그림)이 찌그러지거나 뒤집히지 않게 (같은 이유로 늘 켠다)
  keepRotatedStampsRight();

  // dms-tools.css에는 [»] 안 두 버튼(보관하기·다른 이름으로 보관)의 아이콘도 들어 있어
  // 보관 목록만 켜 둔 경우에도 읽어야 한다.
  if (USE_TOOLBAR_EXTRAS || USE_SHAPE_TOOL || USE_FAVORITE_TOOL || USE_COPY_TOOL) {
    loadStyle("dms-tools.css?v=60");
  }

  // ⑭ 사본/원본 전환(D-102). 원본(DWG·엑셀 등) 미리보기 창에서도 편집 도구를 똑같이 쓰되
  //    처음 색·형광펜 칠하는 방식·다운로드 이름이 다르다(2026-09-20 CM 지시 — dms-source-switch.js 설명).
  const { installSourceSwitch } = await import("./dms-source-switch.js?v=60");
  const editTools = USE_SHAPE_TOOL;

  const useRotate = editTools && USE_ROTATE_TOOL;

  // ⑤ 도구모음 손보기 ([회전]을 쓰면 손 도구와 이동 사이에 그 버튼도 둔다)
  if (USE_TOOLBAR_EXTRAS) {
    const { installToolbarExtras } = await import("./dms-tools.js?v=61");
    installToolbarExtras(app, {
      originalView: originalLabel !== null,
      rotate: useRotate,
      showModeSwitches: SHOW_MODE_SWITCHES,
      showPointerExtras: SHOW_POINTER_EXTRA_BUTTONS,
    });
  }

  // ⑭ 사본/원본 전환 버튼 — 화면 회전 버튼 바로 뒤(그 버튼이 위 ⑤에서 생기므로 그다음에 붙인다)
  installSourceSwitch(app);

  // ⑥⑦⑧ 도형·지우개·스탬프 도구
  if (editTools) {
    loadStyle("dms-shapes.css?v=57");
    const { installShapeTool } = await import("./dms-shapes.js?v=59");
    installShapeTool(app);
    const { installEraserTool } = await import("./dms-eraser.js?v=57");
    installEraserTool(app);
    // 표시를 골랐을 때 그 옆에 뜨는 작은 도구모음의 [채움 전환]·[회전]·[이동]
    const { installEditToolbarExtras } = await import("./dms-edit-toolbar.js?v=57");
    installEditToolbarExtras(app);
    // 스탬프는 지우개 왼쪽에 끼워 넣으므로 지우개 다음에 붙인다.
    if (USE_STAMP_TOOL) {
      const { installStampTool } = await import("./dms-stamp.js?v=59");
      installStampTool(app);
    }
  }

  // ⑩ Ctrl+끌기 복사 · 끌어서 여러 개 고르기.
  //    도형 도구보다 **뒤에** 붙인다 — 같은 자리에 걸린 두 손잡이 중 도형 쪽이 먼저 보고
  //    그릴 것이 있으면 가져가고(preventDefault), 남는 것만 여기서 복사·고르기로 다룬다.
  if (USE_COPY_TOOL) {
    const { installCopyTool } = await import("./dms-copy.js?v=57");
    installCopyTool(app);
  }

  // ⑪ 회전 — 복사보다 **뒤에** 붙인다(Ctrl+끌기는 복사가 먼저 가져가고, 남는 것만 여기서 돌린다).
  if (useRotate) {
    const { installRotateTool } = await import("./dms-rotate.js?v=57");
    installRotateTool(app);
  }

  // ⑨ 보관 목록 — [»] 안의 [보관하기]·[다른 이름으로 보관]. 보관 팝업은 바깥 화면이 갖고
  //    있으므로 그 창을 넘겨준다(미리보기 주소만 따로 열어 본 경우에는 버튼이 생기지 않는다).
  if (USE_FAVORITE_TOOL) {
    const { installFavoriteTool } = await import("./dms-favorite.js?v=64");
    installFavoriteTool(app, outerAppWindow());
  }
}

setupForDms();
