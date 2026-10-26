// 도면관리시스템이 덧붙인 "스탬프" 도구 — 원래 PDF.js에는 없다 (2026-09-04 CM 지시).
//
// 하는 일: 현장에서 종이 도면에 찍던 고무도장("Blind List 확인")을 화면에서 찍는다.
// CM이 준 도장 사진의 보라색 부분(칸과 인쇄된 글자)만 옮겨 그린 것이고, 검은색으로 적힌 값은
// 출력한 뒤 손으로 적는 자리이므로 비워 둔다.
//
// 쓰는 법: [스탬프] 버튼을 켜고 자료 위를 끌면 그 자리에 도장이 찍힌다.
// 색·두께·채우기는 고르지 않고 **어떤 스탬프를 찍을지만** 고른다(2026-09-04 CM 지시) —
// 도장은 언제 찍어도 같은 모양이어야 하기 때문이다. 그 값들은 아래 STAMP_STYLE에 정해 두었다.
// 찍은 도장은 눌러서 고르고, 끌어서 옮기고, 모서리를 잡아 크기를 바꾸고, Delete로 지우고,
// Ctrl+Z로 되돌릴 수 있다(PDF.js가 원래 갖고 있는 "이미지 주석"으로 만들기 때문이다).
//
// 왜 이미지로 만드나: 칸(선)은 도형처럼 선으로 그릴 수 있지만 안에 든 한글 글자는 선으로 그릴 수
// 없다. 그래서 도장 전체를 그림 한 장으로 그려 넣는다. 인쇄했을 때 흐리지 않도록 화면에 보이는
// 크기의 네 배로 그린다(STAMP_SUPERSAMPLE) — 저장한 PDF에도 그 해상도 그대로 들어간다.
//
// 스탬프를 빼려면 dms-viewer.js의 USE_STAMP_TOOL을 false로 두면 된다.

import {
  registerCustomTool, setCustomTool, clearCustomTool, customTool, editor, watchUiManager, panelPin,
} from "./dms-state.js";

const { AnnotationEditorType } = globalThis.pdfjsLib;
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// 도장 모양 — CM이 준 도장 사진을 그대로 옮긴 것 (2026-09-04 새 도장으로 다시 그림)
// ---------------------------------------------------------------------------
//
// 아래 숫자는 도장 하나를 가로 1000 · 세로 472로 놓고 잰 자리다. 실제로 찍을 때는 끌어 놓은
// 크기에 맞춰 통째로 늘어난다(가로세로 비율은 항상 그대로 지킨다).
//
// 표는 **셋이 살짝 떨어져** 있고(CM이 준 사진 그대로), 이름이 인쇄된 칸은 연보라로 칠해져 있다.
// 값을 손으로 적는 칸(작업 위치 값·개소 앞의 개수·서명·특기사항)은 흰 칸으로 비워 둔다.
//
//   ┌──────────┬──────────────────────────────────────────┐
//   │ 작업 위치 │                                          │  ← 표 ①
//   └──────────┴──────────────────────────────────────────┘
//   ┌───────────────────────────┬──────────────────────────┐
//   │      현장 체크 사항        │        감독자 확인        │  ← 표 ②
//   ├───────┬──────┬────────────┼──────────┬───────────────┤
//   │ Blind │ 신규 │      개소  │  시공사   │               │
//   │ 체결  ├──────┼────────────┼──────────┼───────────────┤  ← 오른쪽 끝은 서명 자리
//   │       │ 기존 │      개소  │ 공사감독  │               │
//   ├───────┴──────┼────────────┼──────────┼───────────────┤
//   │Valve Close관리│      개소  │  운영팀   │               │
//   └──────────────┴────────────┴──────────┴───────────────┘
//   ┌──────────────────────────────────────────────────────┐
//   │ 특기사항 :                                            │  ← 표 ③
//   └──────────────────────────────────────────────────────┘

const STAMP_W = 1000;
const STAMP_H = 472;
export const STAMP_ASPECT = STAMP_W / STAMP_H;

// 세로줄 자리
const X0 = 0;    // 왼쪽 끝
const XA = 306;  // "작업 위치" 칸의 오른쪽 — 표 ①에서만 쓴다
const X1 = 180;  // Blind 체결 | 신규
const X2 = 319;  // 신규 | 개소
const X3 = 527;  // 개소 | 시공사   (= 현장 체크 사항 | 감독자 확인)
const X4 = 714;  // 시공사 | 서명 자리
const X5 = 1000; // 오른쪽 끝

// 가로줄 자리 — 표 셋 사이는 살짝 띄운다
const T1 = [0, 58];                  // 표 ① 작업 위치
const T2 = [71, 137, 203, 269, 335]; // 표 ② 머리줄 + 세 줄
const T3 = [348, 472];               // 표 ③ 특기사항

// 이름이 인쇄된 칸의 연보라 바탕
const CELL_FILL = "#f4e6f4";

// 표마다 바깥 테두리 [왼쪽, 위, 오른쪽, 아래]
const STAMP_TABLES = [
  [X0, T1[0], X5, T1[1]],
  [X0, T2[0], X5, T2[4]],
  [X0, T3[0], X5, T3[1]],
];

// 표 안을 나누는 선 [x1, y1, x2, y2]
const STAMP_LINES = [
  // 표 ①
  [XA, T1[0], XA, T1[1]],
  // 표 ② 가로줄 — T2[2]는 왼쪽 "Blind 체결" 칸을 가로지르지 않는다(두 줄에 걸친 칸)
  [X0, T2[1], X5, T2[1]],
  [X1, T2[2], X5, T2[2]],
  [X0, T2[3], X5, T2[3]],
  // 표 ② 세로줄
  [X3, T2[0], X3, T2[1]],
  [X1, T2[1], X1, T2[3]], // Valve Close 관리는 왼쪽 두 칸이 붙어 있어 T2[3]에서 멈춘다
  [X2, T2[1], X2, T2[4]],
  [X3, T2[1], X3, T2[4]],
  [X4, T2[1], X4, T2[4]],
];

// 칸 하나 — box는 [왼쪽, 위, 오른쪽, 아래]
//   fill   : true면 연보라로 칠한다(이름이 인쇄된 칸)
//   align  : 안 적으면 가운데. "개소"는 앞에 개수를 손으로 적으므로 오른쪽에 붙인다
//   valign : 안 적으면 가운데. "특기사항 :"만 칸 위쪽에 붙인다(아래는 적는 자리)
//   lines  : 두 줄로 적을 때
//   size   : 글자 크기(위 도장 좌표 기준). 칸에 안 들어가면 fitFontSize가 줄인다
const STAMP_CELLS = [
  { box: [X0, T1[0], XA, T1[1]], fill: true, text: "작업 위치", size: 30 },
  { box: [X0, T2[0], X3, T2[1]], fill: true, text: "현장 체크 사항", size: 30 },
  { box: [X3, T2[0], X5, T2[1]], fill: true, text: "감독자 확인", size: 30 },
  { box: [X0, T2[1], X1, T2[3]], fill: true, lines: ["Blind", "체결"], size: 26 },
  { box: [X1, T2[1], X2, T2[2]], fill: true, text: "신규", size: 26 },
  { box: [X1, T2[2], X2, T2[3]], fill: true, text: "기존", size: 26 },
  { box: [X0, T2[3], X2, T2[4]], fill: true, text: "Valve Close 관리", size: 26 },
  { box: [X2, T2[1], X3, T2[2]], text: "개소", size: 26, align: "right" },
  { box: [X2, T2[2], X3, T2[3]], text: "개소", size: 26, align: "right" },
  { box: [X2, T2[3], X3, T2[4]], text: "개소", size: 26, align: "right" },
  { box: [X3, T2[1], X4, T2[2]], fill: true, text: "시공사", size: 26 },
  { box: [X3, T2[2], X4, T2[3]], fill: true, text: "공사감독", size: 26 },
  { box: [X3, T2[3], X4, T2[4]], fill: true, text: "운영팀", size: 26 },
  { box: [X0, T3[0], X5, T3[1]], text: "특기사항 :", size: 26, align: "left", valign: "top" },
];

const STAMP_FONT = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo","Noto Sans KR",sans-serif';
const TEXT_PADDING = 22; // 칸 좌우 여백 (위 도장 좌표 기준)

// 화면에 보이는 크기의 몇 배로 그려 넣을지. 인쇄했을 때 선·글자가 흐리지 않아야 하므로 넉넉히
// 잡되(4배 ≒ 288dpi), 아주 크게 찍었을 때 그림이 지나치게 커지지 않도록 한계도 둔다.
const STAMP_SUPERSAMPLE = 4;
const STAMP_MAX_PIXELS = 2400;

// ---------------------------------------------------------------------------
// 도장 그리기
// ---------------------------------------------------------------------------

function fitFontSize(ctx, text, maxWidth, base, weight) {
  let size = base;
  ctx.font = `${weight}${size}px ${STAMP_FONT}`;
  while (size > 8 && ctx.measureText(text).width > maxWidth) {
    size -= 1;
    ctx.font = `${weight}${size}px ${STAMP_FONT}`;
  }
  return size;
}

/**
 * 도장을 캔버스에 그린다.
 *   widthPx  : 그릴 그림의 가로 픽셀 수 (세로는 가로세로 비율로 정해진다)
 *   thickness: 선 굵기 — 도장 좌표(가로 1000) 기준으로 환산해 넘긴다
 */
function drawStamp(widthPx, { stroke, thickness, fill, fillOpacity }) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(widthPx));
  canvas.height = Math.max(2, Math.round(widthPx / STAMP_ASPECT));
  const ctx = canvas.getContext("2d");
  ctx.scale(canvas.width / STAMP_W, canvas.height / STAMP_H);

  // 도장 바탕 — 밑에 도면 선이 비쳐 글자가 안 읽히는 것을 막으려고 흰색을 깔아 둔다
  // (표 셋 사이의 틈도 이 색이라 표가 떨어져 보인다).
  if (fill) {
    ctx.globalAlpha = fillOpacity;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, STAMP_W, STAMP_H);
    ctx.globalAlpha = 1;
  }

  // 이름이 인쇄된 칸의 연보라 바탕 — 선보다 먼저 칠해야 칸 선이 그 위에 또렷하게 남는다.
  ctx.fillStyle = CELL_FILL;
  for (const cell of STAMP_CELLS) {
    if (!cell.fill) continue;
    const [x0, y0, x1, y1] = cell.box;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = thickness;
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";

  // 도장 가장자리에 딱 붙은 선은 선 굵기의 절반만큼 안으로 들여 그린다(안 그러면 잘려 나간다).
  const m = thickness / 2;
  const inX = (x) => Math.min(STAMP_W - m, Math.max(m, x));
  const inY = (y) => Math.min(STAMP_H - m, Math.max(m, y));

  for (const [x0, y0, x1, y1] of STAMP_TABLES) {
    ctx.strokeRect(inX(x0), inY(y0), inX(x1) - inX(x0), inY(y1) - inY(y0));
  }
  for (const [x0, y0, x1, y1] of STAMP_LINES) {
    ctx.beginPath();
    ctx.moveTo(inX(x0), inY(y0));
    ctx.lineTo(inX(x1), inY(y1));
    ctx.stroke();
  }

  ctx.fillStyle = stroke;
  ctx.textBaseline = "middle";
  for (const cell of STAMP_CELLS) {
    const lines = cell.lines || (cell.text ? [cell.text] : []);
    if (lines.length === 0) continue;
    const [x0, y0, x1, y1] = cell.box;
    const weight = "bold ";
    const maxWidth = x1 - x0 - TEXT_PADDING * 2;
    // 두 줄이면 둘 다 들어가는 크기로 맞춘다
    let size = cell.size;
    for (const line of lines) size = fitFontSize(ctx, line, maxWidth, size, weight);
    ctx.font = `${weight}${size}px ${STAMP_FONT}`;
    ctx.textAlign = cell.align || "center";
    const x = cell.align === "left" ? x0 + TEXT_PADDING
      : cell.align === "right" ? x1 - TEXT_PADDING
      : (x0 + x1) / 2;
    const step = size * 1.25;
    const first = cell.valign === "top"
      ? y0 + TEXT_PADDING + step / 2
      : (y0 + y1) / 2 - (step * (lines.length - 1)) / 2;
    lines.forEach((line, i) => ctx.fillText(line, x, first + i * step));
  }
  return canvas;
}

/** 도장 그림 한 장을 만든다(PNG 주소). widthPt는 찍을 가로 크기(PDF 단위) */
function stampImageUrl(widthPt) {
  const widthPx = Math.min(STAMP_MAX_PIXELS, Math.max(400, widthPt * STAMP_SUPERSAMPLE));
  // 선 굵기(PDF 단위)를 도장 좌표(가로 1000)로 환산한다 —
  // 그래야 크게 찍든 작게 찍든 종이에서 같은 굵기로 보인다.
  const thickness = Math.max(0.5, STAMP_STYLE.thickness * (STAMP_W / Math.max(1, widthPt)));
  return drawStamp(widthPx, { ...STAMP_STYLE, thickness }).toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// 도구 모음 UI
// ---------------------------------------------------------------------------

// 도장에 쓰는 값은 정해져 있다 (2026-09-04 CM 지시) — 화면에서 색·두께·채우기를 고르지 않고
// 어떤 스탬프를 찍을지만 고른다. 도장은 언제 찍어도 같은 모양이어야 하기 때문이다.
// 흰 바탕(90%)을 깔아 두는 것은 도장 밑에 도면 선이 비쳐 글자가 안 읽히는 것을 막기 위해서다
// — 비워 두는 것(투명)이 아니라 흰색을 실제로 칠하는 것이고, 100%가 아니라 90%라 도면이
// 아주 옅게는 비친다.
const STAMP_STYLE = {
  stroke: "#7b3fa0", // 도장 색(보라)
  thickness: 1,
  fill: "#ffffff",
  fillOpacity: 0.9,
};

// 도구창의 "스탬프 선택" 버튼에 넣을 도장 그림의 가로 픽셀 (창 너비의 두 배로 그려 선명하게)
const STAMP_THUMB_WIDTH = 352;

const state = { on: false };

let app = null;
let button = null;
let panel = null;
let drag = null;
let justStamped = false; // 방금 찍은 도장 때문에 도구가 바뀐 것인지 (restoreInkMode 참고)
let stampGuard = null;   // 그 표시를 오래 세워 두지 않도록 스스로 내리는 시계
let lastStamp = null;    // 방금 찍은 도장 — 찍자마자 골라 두려고 기억한다

let currentStamp = null;
let stampsList = [];

function getActiveStamp() {
  if (currentStamp) return currentStamp;
  if (stampsList.length > 0) return stampsList[0];
  return {
    id: "blind",
    name: "Blind List 확인",
    category: "표",
    width: STAMP_W,
    height: STAMP_H,
    aspectRatio: STAMP_ASPECT,
    imageUrl: stampImageUrl(300),
    isBuiltinBlind: true,
  };
}

function getActiveStampAspect() {
  const s = getActiveStamp();
  return s.aspectRatio || (s.width && s.height ? s.width / s.height : STAMP_ASPECT);
}

async function loadStamps() {
  try {
    const res = await fetch("/api/stamps", { credentials: "same-origin" });
    if (!res.ok) throw new Error("stamps fetch failed: " + res.status);
    const data = await res.json();
    if (Array.isArray(data.items) && data.items.length > 0) {
      stampsList = data.items.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category || "도장",
        width: item.width || 300,
        height: item.height || 150,
        aspectRatio: (item.width && item.height) ? (item.width / item.height) : (300 / 150),
        imageUrl: item.imageUrl,
        description: item.description,
        isBuiltinBlind: item.name === "Blind List 확인" && !item.imageUrl?.startsWith("data:image/svg"),
      }));
    }
  } catch (err) {
    console.warn("[dms] loadStamps fallback to builtin:", err);
  }

  if (stampsList.length === 0) {
    stampsList = [{
      id: "blind",
      name: "Blind List 확인",
      category: "표",
      width: STAMP_W,
      height: STAMP_H,
      aspectRatio: STAMP_ASPECT,
      imageUrl: stampImageUrl(300),
      isBuiltinBlind: true,
    }];
  }

  if (!currentStamp || !stampsList.some((s) => s.id === currentStamp.id)) {
    currentStamp = stampsList[0];
  }

  renderStampChoices();
}

function renderStampChoices() {
  const container = panel?.querySelector(".dmsStampChoices");
  if (!container) return;
  container.innerHTML = "";

  const active = getActiveStamp();
  for (const stamp of stampsList) {
    const isChosen = active && (active.id === stamp.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dmsStampChoice" + (isChosen ? " chosen" : "");
    btn.dataset.stampId = String(stamp.id);
    btn.title = stamp.description ? `${stamp.name} - ${stamp.description}` : stamp.name;

    const img = document.createElement("img");
    img.className = "dmsStampThumb";
    img.alt = stamp.name;
    img.src = stamp.imageUrl;

    const metaWrap = document.createElement("div");
    metaWrap.className = "dmsStampMeta";

    const nameSpan = document.createElement("span");
    nameSpan.className = "dmsStampName";
    nameSpan.textContent = stamp.name;

    if (stamp.category) {
      const badge = document.createElement("span");
      badge.className = "dmsStampCategoryBadge";
      badge.textContent = stamp.category;
      metaWrap.append(nameSpan, badge);
    } else {
      metaWrap.append(nameSpan);
    }

    btn.append(img, metaWrap);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectStamp(stamp);
    });

    container.append(btn);
  }
}

function selectStamp(stamp) {
  currentStamp = stamp;
  if (!panel) return;
  for (const b of panel.querySelectorAll(".dmsStampChoice")) {
    b.classList.toggle("chosen", b.dataset.stampId === String(stamp.id));
  }
}

function buildUi() {
  const box = document.createElement("div");
  box.id = "dmsStamp";
  box.className = "toolbarButtonWithContainer";
  box.innerHTML = `
    <button id="dmsStampButton" class="toolbarButton" type="button" tabindex="0"
            disabled="disabled" aria-expanded="false" aria-haspopup="true"
            aria-controls="dmsStampParamsToolbar" title="스탬프">
      <span>스탬프</span>
    </button>
    <div class="editorParamsToolbar hidden doorHangerRight" id="dmsStampParamsToolbar">
      <div class="editorParamsToolbarContainer dmsShapePanel">
        <div class="dmsStampChoiceBox">
          <span class="editorParamsLabel">스탬프 선택</span>
          <div class="dmsStampChoices">
          </div>
        </div>
      </div>
    </div>`;

  // 지우개 왼쪽에 둔다 (2026-09-04 CM 지시) — 그리기 · 도형 · 스탬프 · 지우개 순서가 된다.
  const eraser = document.getElementById("dmsEraser");
  if (eraser) eraser.before(box);
  else document.getElementById("dmsShape").after(box);

  button = document.getElementById("dmsStampButton");
  panel = document.getElementById("dmsStampParamsToolbar");

  button.addEventListener("click", () => {
    void loadStamps();
    // 켜져 있으면 아이콘은 창만 열고 닫는다 — 도구는 켜진 채 남는다(2026-09-19 CM 지시).
    // 도구를 끄려면 [선택]·[손 도구]·다른 도구를 누르거나 Esc.
    if (state.on) showPanel(panel.classList.contains("hidden"));
    else activate();
  });

  // 창 밖을 누르면 창만 닫는다(도구는 켜둔 채) — [도구창 고정]이 꺼져 있을 때만이다
  // (2026-09-04 CM 지시. 켜져 있으면 아이콘을 한 번 더 눌러야 닫힌다).
  document.addEventListener("pointerdown", (e) => {
    if (panelPin.on) return;
    if (!state.on || panel.classList.contains("hidden")) return;
    if (e.target.closest("#dmsStamp")) return;
    showPanel(false);
  }, true);
}

function showPanel(show) {
  panel.classList.toggle("hidden", !show);
  button.setAttribute("aria-expanded", String(show));
}

function activate() {
  // 도형·지우개와 같은 이유로 PDF.js의 "그리기" 편집 상태를 빌려 쓴다(dms-shapes.js 설명 참고).
  setCustomTool("stamp");
  app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.INK };
  state.on = true;
  button.classList.add("toggled");
  document.getElementById("viewerContainer").classList.add("dmsStampMode");
  hideInkToolbarLook();
  showPanel(true);
}

// 그리기 도구가 켜진 것처럼 보이는 것만 되돌린다(실제 편집 상태는 그대로 둔다).
function hideInkToolbarLook() {
  const inkButton = document.getElementById("editorInkButton");
  inkButton?.classList.remove("toggled");
  inkButton?.setAttribute("aria-expanded", "false");
  document.getElementById("editorInkParamsToolbar")?.classList.add("hidden");
}

function deactivate({ keepMode = false } = {}) {
  clearCustomTool("stamp");
  state.on = false;
  button.classList.remove("toggled");
  document.getElementById("viewerContainer").classList.remove("dmsStampMode");
  showPanel(false);
  cancelDrag();
  if (!keepMode) app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
}

// ---------------------------------------------------------------------------
// 끌어서 찍기
// ---------------------------------------------------------------------------

function layerForPageElement(pageEl) {
  const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
  const pageView = app.pdfViewer.getPageView(pageIndex);
  const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
  return layer?.div ? { pageView, layer } : null;
}

/** 끌어 놓은 네모 안에 도장을 가로세로 비율 그대로 넣는다(찌그러지지 않게) */
function fitBox(x0, y0, x1, y1) {
  let w = Math.abs(x1 - x0);
  let h = Math.abs(y1 - y0);
  const aspect = getActiveStampAspect();
  if (w / Math.max(h, 1e-6) > aspect) w = h * aspect;
  else h = w / aspect;
  const left = x1 >= x0 ? x0 : x0 - w;
  const top = y1 >= y0 ? y0 : y0 - h;
  return { x0: left, y0: top, x1: left + w, y1: top + h };
}

/**
 * PDF.js가 손으로 긋던 선을 아직 마무리하지 않았으면 여기서 마무리시킨다.
 *
 * 자유 그리기는 마우스를 떼도 "그리는 중"으로 남아 있다가(그 자리에 획을 더 그을 수 있게)
 * 다른 곳을 눌렀을 때 비로소 주석이 되고 되돌리기 목록에도 그때 올라간다. 우리는 그 누름을
 * 가로채므로, 그냥 두면 그 선이 우리가 지금 그리는 것보다 **나중에** 목록에 올라가
 * Ctrl+Z가 방금 그은 것이 아니라 그 전에 긋던 선을 지운다 (2026-09-04 확인).
 *
 * 마무리하는 일은 편집 레이어가 한다(uiManager 쪽 같은 이름 함수는 문구 편집만 다룬다).
 * 그리는 중인 곳은 한 군데뿐이라 화면에 그려져 있는 쪽만 훑어보면 된다.
 */
function commitPendingDrawing() {
  for (const pageEl of document.querySelectorAll(".page")) {
    if (!pageEl.querySelector(".annotationEditorLayer")) continue;
    try {
      if (layerForPageElement(pageEl)?.layer?.commitOrRemove?.()) return;
    } catch {
      /* 마무리할 것이 없으면 그냥 넘어간다 */
    }
  }
}

function onPointerDown(e) {
  if (!state.on || e.button !== 0 || drag) return;
  if (customTool.name !== "stamp") return;
  const pageEl = e.target.closest(".page");
  if (!pageEl) return;
  const found = layerForPageElement(pageEl);
  if (!found) return;

  // 이미 찍어 둔 것 위에서 시작했으면 그건 PDF.js에 맡긴다(고르기·옮기기).
  const layerDiv = pageEl.querySelector(".annotationEditorLayer");
  if (!layerDiv || (layerDiv.contains(e.target) && e.target !== layerDiv)) return;

  e.preventDefault();
  e.stopPropagation();

  commitPendingDrawing();

  const rect = found.layer.div.getBoundingClientRect();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("dmsShapePreview");
  const image = document.createElementNS(SVG_NS, "image");
  image.setAttribute("preserveAspectRatio", "none");
  // 끄는 동안 보여줄 그림은 작게 한 장만 만들어 두고 크기만 늘려 보여준다(매번 다시 그리면 느리다).
  const active = getActiveStamp();
  image.setAttribute("href", active.imageUrl || stampImageUrl(300));
  svg.append(image);
  pageEl.append(svg);
  placePreview(svg, pageEl, rect);

  drag = {
    ...found, rect, svg, image, pageEl,
    x0: e.clientX - rect.left, y0: e.clientY - rect.top,
    x1: e.clientX - rect.left, y1: e.clientY - rect.top,
  };
  document.getElementById("viewerContainer").classList.add("dmsShapeDragging");
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  drawPreview();
}

// 그림판을 주석 자리에 정확히 맞춘다(페이지 칸의 테두리 두께를 빼야 자리가 어긋나지 않는다 —
// dms-shapes.js의 placePreviewSvg와 같은 이유).
function placePreview(svg, pageEl, rect) {
  const pageRect = pageEl.getBoundingClientRect();
  const style = getComputedStyle(pageEl);
  svg.style.left = `${rect.left - pageRect.left - (parseFloat(style.borderLeftWidth) || 0)}px`;
  svg.style.top = `${rect.top - pageRect.top - (parseFloat(style.borderTopWidth) || 0)}px`;
  svg.style.width = `${rect.width}px`;
  svg.style.height = `${rect.height}px`;
}

function drawPreview() {
  const box = fitBox(drag.x0, drag.y0, drag.x1, drag.y1);
  drag.box = box;
  drag.image.setAttribute("x", String(box.x0));
  drag.image.setAttribute("y", String(box.y0));
  drag.image.setAttribute("width", String(Math.max(0, box.x1 - box.x0)));
  drag.image.setAttribute("height", String(Math.max(0, box.y1 - box.y0)));
}

function onPointerMove(e) {
  if (!drag) return;
  drag.x1 = e.clientX - drag.rect.left;
  drag.y1 = e.clientY - drag.rect.top;
  drawPreview();
}

async function onPointerUp() {
  if (!drag) return;
  const { pageView, layer, box } = drag;
  const moved = Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) >= 5;
  cancelDrag();
  if (!moved || !box) return; // 그냥 클릭한 것은 찍지 않는다

  const { viewport } = pageView;
  const [px0, py0] = viewport.convertToPdfPoint(box.x0, box.y0);
  const [px1, py1] = viewport.convertToPdfPoint(box.x1, box.y1);
  // 도장의 가로 크기(PDF 단위)는 화면에서 끈 네모의 윗변 길이로 잰다 — 화면이 90도 돌아가 있으면
  // PDF의 가로·세로가 화면과 뒤바뀌어 있어, 두 점의 PDF 가로 차이로 재면 세로 길이가 된다.
  const [qx, qy] = viewport.convertToPdfPoint(box.x1, box.y0);
  const widthPt = Math.hypot(qx - px0, qy - py0);
  if (widthPt < 1) return;

  const active = getActiveStamp();
  const isSvg = active.imageUrl ? (active.imageUrl.startsWith("data:image/svg") || active.imageUrl.endsWith(".svg")) : false;
  const bitmapUrl = (active.isBuiltinBlind || (!active.imageUrl && active.name === "Blind List 확인"))
    ? stampImageUrl(widthPt)
    : (active.imageUrl || stampImageUrl(widthPt));

  const editorData = {
    annotationType: AnnotationEditorType.STAMP,
    bitmapUrl,
    isSvg,
    rect: [Math.min(px0, px1), Math.min(py0, py1), Math.max(px0, px1), Math.max(py0, py1)],
    pageIndex: pageView.id - 1,
    // 지금 화면에 보이는 각도로 넣어야 도장이 화면에서 똑바로 찍힌다 (2026-09-18 CM 지시).
    // 예전에는 늘 0을 넣어서, 쪽 자체가 180도 돌아간 채 저장된 도면(AutoCAD 출력물에 흔하다 —
    // 비상발전기실_Total 등)에서는 도장이 거꾸로 찍혔다. PDF.js가 [이미지 추가]로 그림을 넣을 때도
    // 이 값(화면의 각도)을 쓴다.
    rotation: viewport.rotation,
  };
  // [도구창 고정]이 꺼져 있으면 도장을 찍는 순간 도구창을 닫는다 (2026-09-04 CM 지시) —
  // 고를 것을 다 골랐으니 창이 자료를 가리지 않게 비켜 준다(도구는 켜진 채라 계속 찍을 수 있다).
  if (!panelPin.on) showPanel(false);

  try {
    const stampEditor = await layer.deserialize(editorData);
    if (stampEditor) {
      justStamped = true;
      lastStamp = stampEditor;
      // 도장이 들어간 뒤 PDF.js가 도구를 [이미지 추가]로 바꾸는 것은 몇 박자 뒤에 일어난다.
      // 그때까지만 이 표시를 세워 두고, 그 사이에 아무 일도 없었으면 스스로 내린다.
      clearTimeout(stampGuard);
      stampGuard = setTimeout(() => { justStamped = false; }, 1000);
      layer.add(stampEditor);
      // 찍자마자 골라 둔다 — 그래야 오른쪽 아래에 [이동]·[휴지통]이 바로 보인다
      // (2026-09-05 CM 지시, 도형을 그렸을 때와 같게). PDF.js가 도구를 바꾸려 들면
      // 아래 restoreInkMode가 되돌리고 다시 골라 준다.
      setTimeout(() => selectWithoutSwitchingTool(stampEditor), 50);
    }
  } catch (err) {
    console.warn("[dms] stamp failed:", err);
    justStamped = false;
  }
}

// 도장을 넣으면 PDF.js가 그것을 골라 도구모음을 [이미지 추가]로 바꿔 버린다. 그러면 스탬프
// 도구와 그 창이 꺼져 도장을 하나 찍을 때마다 [스탬프]를 다시 눌러야 했다. 그 도구 바뀜을
// 되돌려 도구와 창이 그대로 켜져 있게 한다 — 도형 도구와 같은 동작이 된다
// (2026-09-04 CM 지시 "도구창은 기본적으로 닫히지 않도록").
function restoreInkMode() {
  setTimeout(() => {
    if (!state.on) return;
    // 새로 넣은 도장이 골라진 채로 남아 있으면, 그리기 상태로 되돌려도 PDF.js가 곧바로
    // 도구모음을 다시 [이미지 추가]로 되돌린다(그 도장에 맞는 도구를 켜 주려는 것이다).
    // 그래서 선택을 먼저 푼다 — 도형을 그렸을 때와 같은 상태가 된다.
    editor.uiManager?.unselectAll?.();
    app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.INK };
    hideInkToolbarLook();
    // 고정이 꺼져 있으면 찍을 때 닫은 창을 다시 열지 않는다(위 onPointerUp 참고).
    if (panelPin.on) showPanel(true);
    // 방금 찍은 도장을 다시 골라 둔다 — 그래야 오른쪽 아래에 [이동]·[휴지통]이 바로 보인다
    // (2026-09-05 CM 지시, 도형을 그렸을 때와 같게).
    selectWithoutSwitchingTool(lastStamp);
    lastStamp = null;
  }, 0);
}

/**
 * 표시를 골라 두되 위쪽 도구모음은 그대로 둔다.
 *
 * 그냥 고르면 PDF.js가 "그 표시에 맞는 도구"로 위쪽 도구모음을 바꿔 버려서(도장이면 [이미지 추가])
 * 스탬프 도구가 꺼진 것처럼 보이고, 그것을 되돌리면 다시 고르기가 풀리는 실랑이가 된다.
 * 도구모음을 바꾸는 일만 잠깐 멈춰 두고 고르면, 고른 표시(=[이동]·[휴지통]이 뜬 상태)와
 * 켜져 있는 스탬프 도구가 둘 다 유지된다.
 */
function selectWithoutSwitchingTool(target) {
  const uiManager = editor.uiManager;
  if (!target?.parent || !uiManager) return;
  const original = uiManager.updateToolbar?.bind(uiManager);
  if (original) uiManager.updateToolbar = () => {};
  try {
    uiManager.setSelected(target);
  } catch (err) {
    console.warn("[dms] stamp select failed:", err);
  } finally {
    if (original) uiManager.updateToolbar = original;
  }
}

function cancelDrag() {
  if (!drag) return;
  drag.svg.remove();
  drag = null;
  document.getElementById("viewerContainer").classList.remove("dmsShapeDragging");
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
}

// ---------------------------------------------------------------------------

export function installStampTool(pdfViewerApplication) {
  app = pdfViewerApplication;
  buildUi();
  void loadStamps();
  watchUiManager(app);
  registerCustomTool("stamp", (keepMode) => deactivate({ keepMode }));

  document.getElementById("viewerContainer")
    .addEventListener("pointerdown", onPointerDown, true);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.on) {
      if (drag) cancelDrag();
      else deactivate();
    }
  }, true);

  app.eventBus.on("documentloaded", () => { button.disabled = false; });
  if (app.pdfDocument) button.disabled = false;

  // 사용자가 다른 도구(강조·텍스트·이미지)를 켜거나 편집을 끄면 스탬프도 함께 꺼진다.
  // 그리기 편집 상태를 빌려 쓰는 동안에는 그리기 창이 열리지 않게 매번 정리한다.
  app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
    if (!state.on) return;
    if (mode === AnnotationEditorType.INK) {
      hideInkToolbarLook();
      return;
    }
    if (justStamped) {
      // 방금 찍은 도장 때문에 바뀐 것이므로 도구를 끄지 않고 그리기 상태로 되돌린다
      justStamped = false;
      clearTimeout(stampGuard);
      restoreInkMode();
      return;
    }
    deactivate({ keepMode: true });
  });
}
