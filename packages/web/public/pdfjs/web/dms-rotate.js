// 도면관리시스템이 덧붙인 "회전" — 원래 PDF.js에는 없다 (2026-09-18 CM 지시).
//
// 그려 둔 표시(그리기·도형·텍스트·강조 표시·스탬프·이미지)를 돌린다. 쓰는 곳은 둘이다.
//   ① 표시를 골랐을 때 그 옆에 뜨는 작은 도구모음의 [회전] (dms-edit-toolbar.js)
//        누른 채 끌면 마우스를 따라 돌아가고, 끌지 않고 한 번 누르면 시계방향으로 90도 돈다.
//   ② 도구모음의 [회전] (손 도구와 이동 사이 — dms-tools.js)
//        켜 두면 그려 둔 표시를 잡고 끌어서 돌린다([이동]으로 잡고 끌면 옮겨지는 것과 같은 자리다).
//        끌지 않고 누르기만 하면 그 표시가 골라지기만 한다.
// 둘 다 — Shift를 누르고 끌면 15도씩 끊어서 돈다(PPT와 같다). 여러 개를 골라 뒀으면 전부가 함께,
// 각자 자기 한가운데를 중심으로 돈다. 되돌리기(Ctrl+Z) 한 번에 돌리기 전으로 돌아간다.
//
// 텍스트(문구)는 90도씩만 돈다 — PDF의 문구 주석에는 90도 단위의 회전만 적을 수 있어서다
// (PDF.js도 저장할 때 그 값만 적는다). 그래서 끄는 동안에도 90도씩 끊어서 보여준다.
//
// 돌리는 방법은 "돌린 모습을 새로 만들어 원래 것과 맞바꾸기"다. PDF 주석에는 "몇 도 돌아가 있다"는
// 값이 따로 없어서, 돌린 모양 그대로의 새 주석을 만든다.
//   · 도형·형광펜 띠·펜 선        : dms-shapes.js가 다시 만든다(rotateHooks)
//   · 강조 표시(PDF.js가 칠한 것) : 칠한 자리를 돌려 다시 칠한다
//   · 텍스트                      : 90도 단위 회전값을 바꿔 다시 만든다(글자 배경도 다시 깐다)
//   · 스탬프·이미지               : 그림을 돌려 다시 그린다. 처음 그림을 기억해 두었다가 늘 거기서
//                                   돌리므로 여러 번 돌려도 흐려지지 않는다.
// 끄는 동안에는 새로 만들지 않고 원래 표시를 그 자리에서 돌려 보여주기만 한다(CSS rotate·translate —
// 가볍다). 손을 떼면 위처럼 새로 만든다. PDF.js 안쪽 코드는 한 줄도 고치지 않았다.
//
// 되돌리는 스위치는 dms-viewer.js의 USE_ROTATE_TOOL이다. false로 두면 [회전] 버튼이 두 곳 모두
// 생기지 않는다.

import {
  editor, rotateHooks, rotateTool, rotateMode, textBackgroundHooks, watchUiManager,
} from "./dms-state.js";
import { backgroundsOf, isBackground } from "./dms-link.js";
import { unionQuads, boundingBox } from "./dms-geometry.js";
import { addEditor, hexToRgb } from "./dms-fill.js";

const { AnnotationEditorType } = globalThis.pdfjsLib;

const SNAP_STEP = 15;        // Shift를 누르고 끌면 이 각도씩 끊어서 돈다(PPT와 같다)
const TEXT_STEP = 90;        // 텍스트는 이 각도 단위로만 돈다
const MOVE_THRESHOLD = 4;    // 이만큼은 움직여야 "끌었다"고 본다(픽셀). 그 전에는 누르기만 한 것이다
const MIN_RADIUS = 12;       // 중심에서 이보다 가까우면 각도가 크게 튀므로 그동안은 각도를 멈춰 둔다(픽셀)
const MAX_IMAGE_SIDE = 4096; // 돌린 그림 한 변의 최대 픽셀 수(너무 크면 무거워진다)
// 글자를 따라 칠한 강조 표시를 비스듬히 돌릴 때 가로로 써는 간격(PDF 단위)과 최대 줄 수 —
// 형광펜 띠를 만들 때와 같은 값이다(dms-shapes.js의 bandQuads).
const HIGHLIGHT_ROW_STEP = 0.5;
const MAX_HIGHLIGHT_ROWS = 1200;

let app = null;
// PDF.js의 편집 총괄 — 자료를 열 때마다 새로 만들어지므로 쓸 때마다 가져온다(dms-state.js).
const uiManager = () => editor.uiManager;

let gesture = null; // 끄는 중 { items, clickTurn, cx, cy, x0, y0, lastAngle, total, deg, moved }
let busy = false;   // 손을 뗀 뒤 새로 만드는 중 — 그 사이에 또 누르면 받지 않는다

// 스탬프·이미지의 "처음 그림" — 돌린 그림을 또 돌리면 점점 흐려지므로, 처음 그림과 지금까지 돈
// 각도를 적어 두었다가 늘 처음 그림에서 돌려 그린다. 표시 칸의 id로 찾는다.
//   { url, angle, frameW, frameH, boxW, boxH } — frame은 처음 그림의 틀, box는 돌린 뒤의 틀(쪽 크기를 1로 본 값)
const images = new Map();

// ---------------------------------------------------------------------------
// 자잘한 도구들
// ---------------------------------------------------------------------------

const viewerBox = () => document.getElementById("viewerContainer");
const keyOf = (ed) => ed?.div?.id || (ed ? String(ed.id) : "");
const pageViewOf = (ed) => app.pdfViewer.getPageView(ed.pageIndex);
const layerDivOf = (pageView) => pageView?.annotationEditorLayer?.annotationEditorLayer?.div || null;
const isText = (ed) => ed.mode === AnnotationEditorType.FREETEXT;

/** 각도를 -180 ~ 180 사이로 (한 바퀴를 넘게 돌려도 놓이는 자리는 같다) */
function wrapDeg(deg) {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/** 그 표시를 돌릴 수 있는지 — 그리기·강조 표시·텍스트·스탬프(이미지) */
function canRotate(ed) {
  if (!ed?.parent || isBackground(ed)) return false;
  if (ed.isInEditMode?.() || ed.isEmpty?.()) return false; // 글을 적는 중인 문구는 돌리지 않는다
  switch (ed.mode) {
    case AnnotationEditorType.INK:
    case AnnotationEditorType.HIGHLIGHT:
    case AnnotationEditorType.FREETEXT:
    case AnnotationEditorType.STAMP:
      return true;
    default:
      return false;
  }
}

/** 지금 자료에 그려져 있는 표시 전부(채움 조각처럼 혼자 다루면 안 되는 것은 빼고) */
function allEditors() {
  const um = uiManager();
  const out = [];
  if (!um) return out;
  for (let page = 0; page < (app?.pdfViewer?.pagesCount || 0); page++) {
    let list;
    try {
      list = um.getEditors(page);
    } catch {
      continue;
    }
    for (const ed of list || []) if (!isBackground(ed)) out.push(ed);
  }
  return out;
}

/** 무엇을 돌릴지 — 골라 둔 것 중 하나를 잡았으면 골라 둔 것 전부, 아니면 그것 하나만 */
function targetsFor(pressed) {
  const selected = allEditors().filter((ed) => ed.isSelected && canRotate(ed));
  return pressed.isSelected && selected.length > 1 ? selected : [pressed];
}

/**
 * 골라 둔 것을 모두 풀고 넘긴 것들만 골라 둔다 — 돌린 뒤 새로 만든 것이 골라진 채로 남아
 * 곧바로 한 번 더 돌리거나 옮길 수 있게 한다(dms-copy.js의 selectOnly와 같은 방법).
 */
function selectOnly(editors) {
  const um = uiManager();
  if (!um) return;
  try {
    um.commitOrRemove();
    for (const ed of allEditors()) if (ed.isSelected) um.unselect(ed);
    for (const ed of editors) if (ed?.parent && !ed.isSelected) um.toggleSelected(ed);
  } catch {
    /* 고르기가 안 돼도 돌리기 자체는 이미 끝나 있다 */
  }
}

// ---------------------------------------------------------------------------
// 돌리는 중심과 각도
// ---------------------------------------------------------------------------

/**
 * 돌리는 중심(PDF 좌표). 우리 도형은 도형 네모의 한가운데(dms-shapes.js — 도형을 다시 그릴 때도
 * 거기를 중심으로 돌린다), 나머지는 그 표시 칸의 한가운데다.
 */
function pivotOf(ed, pageView) {
  const own = rotateHooks.pivotFor?.(ed);
  if (own) return own;
  const layerDiv = layerDivOf(pageView);
  if (!ed.div || !layerDiv) return null;
  const box = ed.div.getBoundingClientRect();
  const base = layerDiv.getBoundingClientRect();
  return pageView.viewport.convertToPdfPoint(
    (box.left + box.right) / 2 - base.left,
    (box.top + box.bottom) / 2 - base.top,
  );
}

/** PDF 좌표의 점을 화면(브라우저 창) 자리로 바꾼다 */
function clientPoint(pageView, [x, y]) {
  const base = layerDivOf(pageView).getBoundingClientRect();
  const [vx, vy] = pageView.viewport.convertToViewportPoint(x, y);
  return [base.left + vx, base.top + vy];
}

/**
 * PDF 좌표의 점을 pivot 둘레로 deg도 돌려 주는 함수를 만든다.
 * 화면 좌표(아래로 갈수록 y가 커진다)에서 돌리므로 deg가 양수면 화면에서 시계방향이고,
 * 쪽이 돌아가 있거나 확대돼 있어도 화면에서 보이는 대로 돈다.
 */
function makeTurn(pageView, pivot, deg) {
  const { viewport } = pageView;
  const [cx, cy] = viewport.convertToViewportPoint(pivot[0], pivot[1]);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return (x, y) => {
    const [vx, vy] = viewport.convertToViewportPoint(x, y);
    const dx = vx - cx;
    const dy = vy - cy;
    return viewport.convertToPdfPoint(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  };
}

/** 그 표시가 실제로 돌 각도 — 텍스트는 90도 단위로 끊는다 */
function angleFor(item, deg) {
  return item.text ? Math.round(deg / TEXT_STEP) * TEXT_STEP : deg;
}

// ---------------------------------------------------------------------------
// 끄는 동안 돌려 보여주기
// ---------------------------------------------------------------------------
//
// 원래 표시를 그 자리에서 CSS로 돌려 보여준다. 표시 하나는 여러 조각으로 그려져 있다 —
// 그림(SVG)·채움·파란 선택틀은 그림 판(.canvasWrapper)에, 표시 칸(글자·도장·옆 도구모음)은 편집
// 판(.annotationEditorLayer)에 있다. 조각마다 놓인 판이 달라 "돌리는 중심"을 각자의 판 기준으로
// 구해 둔다. CSS의 rotate·translate 속성은 PDF.js가 쓰지 않는 자리라 원래 모양(transform)과 섞이지
// 않고 그 위에 겹쳐진다. 손을 떼면 지우고 새로 만든 것으로 바꾼다.

function svgRootOf(drawId) {
  if (drawId === null || drawId === undefined) return null;
  return document.getElementById(`path_${drawId}`)?.closest("svg") || null;
}

/** 끄는 동안 함께 돌려 보여줄 조각들 — 채움, 그림, 파란 선택틀, 표시 칸(옆 도구모음 포함) */
function partsOf(ed) {
  const parts = [];
  const add = (el) => {
    if (el && !parts.includes(el)) parts.push(el);
  };
  for (const back of backgroundsOf(ed)) add(svgRootOf(back._drawId));
  add(svgRootOf(ed._drawId));
  add(svgRootOf(ed._focusDrawId));
  add(ed.div);
  return parts;
}

function percentOf(value, size) {
  const match = /^(-?[\d.]+)%$/.exec(String(value || "").trim());
  return match ? (parseFloat(match[1]) / 100) * size : null;
}

/**
 * 조각 하나를 돌려 보여줄 준비 — 그 조각이 놓인 판 안에서의 "변형 기준점(transform-origin)"과
 * "돌리는 중심"을 판의 픽셀로 구해 둔다.
 *   편집 판 : 쪽이 돌아가 있으면 판 전체가 CSS로 돌아가 있어, 돌리기 전 쪽 기준(PDF 좌표를 쪽
 *             크기로 나눈 값)으로 자리를 잡는다.
 *   그림 판 : 화면에 보이는 그대로이므로 PDF.js의 화면 좌표(viewport)를 판 크기에 맞춘다.
 */
function frameOf(el, pageView, pivot) {
  const parent = el.parentElement;
  if (!parent) return null;
  const size = getComputedStyle(parent);
  const pw = parseFloat(size.width);
  const ph = parseFloat(size.height);
  const left = percentOf(el.style.left, pw);
  const top = percentOf(el.style.top, ph);
  if (!pw || !ph || left === null || top === null) return null;
  const [ox, oy] = getComputedStyle(el).transformOrigin.split(" ").map((v) => parseFloat(v) || 0);

  const { viewport } = pageView;
  let center;
  if (parent.classList.contains("annotationEditorLayer")) {
    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    center = [((pivot[0] - pageX) / pageWidth) * pw, ((pageY + pageHeight - pivot[1]) / pageHeight) * ph];
  } else {
    const [vx, vy] = viewport.convertToViewportPoint(pivot[0], pivot[1]);
    center = [(vx / viewport.width) * pw, (vy / viewport.height) * ph];
  }
  return { el, origin: [left + ox, top + oy], center };
}

/**
 * 조각들을 deg도 돌려 보여준다. 변형 기준점(origin)을 그대로 둔 채 center 둘레로 돌리려면
 * 돌린 만큼 어긋난 자리를 translate로 되돌려 주면 된다: t = (I - R)(center - origin).
 */
function showTurn(frames, deg) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (const { el, origin, center } of frames || []) {
    const dx = center[0] - origin[0];
    const dy = center[1] - origin[1];
    el.style.translate = `${dx - (dx * cos - dy * sin)}px ${dy - (dx * sin + dy * cos)}px`;
    el.style.rotate = `${deg}deg`;
  }
}

function clearTurn(frames) {
  for (const { el } of frames || []) {
    el.style.translate = "";
    el.style.rotate = "";
  }
}

// ---------------------------------------------------------------------------
// 누르고 끌기
// ---------------------------------------------------------------------------

/**
 * 돌리기를 시작한다 — 작은 도구모음의 [회전]과 도구모음의 [회전](켜 둔 상태에서 표시를 잡을 때)이 부른다.
 *   clickTurn : 끌지 않고 누르기만 했을 때 돌 각도(0이면 고르기만 한다)
 */
function startRotate(pressed, event, { clickTurn = 0 } = {}) {
  if (busy || gesture || !canRotate(pressed)) return false;
  const um = uiManager();
  if (!um) return false;

  // 잡은 표시가 아직 안 골라져 있으면 고른다(Shift면 골라 둔 것에 더한다 — PDF.js와 같다).
  if (!pressed.isSelected) {
    if (event.shiftKey) um.toggleSelected(pressed);
    else um.setSelected(pressed);
  }

  const items = [];
  for (const ed of targetsFor(pressed)) {
    const pageView = pageViewOf(ed);
    const pivot = pageView && layerDivOf(pageView) ? pivotOf(ed, pageView) : null;
    if (pivot) items.push({ ed, pageView, pivot, text: isText(ed), frames: null });
  }
  const main = items.find((item) => item.ed === pressed);
  if (!main) return false;

  // 각도는 잡은 표시의 중심에서 마우스가 몇 도 돌았는지로 잰다.
  const [cx, cy] = clientPoint(main.pageView, main.pivot);
  gesture = {
    items, clickTurn, cx, cy,
    x0: event.clientX, y0: event.clientY,
    lastAngle: Math.atan2(event.clientY - cy, event.clientX - cx),
    total: 0, deg: 0, moved: false,
  };
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", cancelRotate, true);
  // 창 자체가 초점을 잃으면(다른 창으로 넘어가면) 그만둔다. 잡아채는 자리(capture)에 걸면
  // 화면 안 칸이 초점을 잃을 때도 불려 끄는 도중에 그만둬지므로 일부러 걸지 않는다.
  window.addEventListener("blur", cancelRotate);
  return true;
}

function stopListening() {
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", cancelRotate, true);
  window.removeEventListener("blur", cancelRotate);
}

function onPointerMove(e) {
  const g = gesture;
  if (!g) return;
  e.preventDefault();
  if (!g.moved) {
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < MOVE_THRESHOLD) return;
    g.moved = true;
    for (const item of g.items) {
      item.frames = partsOf(item.ed).map((el) => frameOf(el, item.pageView, item.pivot)).filter(Boolean);
    }
    viewerBox()?.classList.add("dmsRotating");
  }

  // 마우스가 중심 둘레를 얼마나 돌았는지 더해 나간다(한 바퀴를 넘겨 돌려도 이어진다).
  const dx = e.clientX - g.cx;
  const dy = e.clientY - g.cy;
  if (Math.hypot(dx, dy) >= MIN_RADIUS) {
    const angle = Math.atan2(dy, dx);
    let step = angle - g.lastAngle;
    if (step > Math.PI) step -= 2 * Math.PI;
    else if (step < -Math.PI) step += 2 * Math.PI;
    g.total += step;
    g.lastAngle = angle;
  }
  const raw = (g.total * 180) / Math.PI;
  g.deg = e.shiftKey ? Math.round(raw / SNAP_STEP) * SNAP_STEP : raw;
  for (const item of g.items) showTurn(item.frames, angleFor(item, g.deg));
}

async function onPointerUp() {
  const g = gesture;
  if (!g) return;
  stopListening();
  gesture = null;
  viewerBox()?.classList.remove("dmsRotating");

  let deg = g.deg;
  if (!g.moved) {
    if (!g.clickTurn) return; // 도구모음의 [회전]으로 누르기만 한 것 — 고르기만 하고 끝
    deg = g.clickTurn;
  }
  await commitRotation(g.items, deg);
}

/** 끄다가 그만둔다(Esc·창 바꾸기 등) — 돌려 보여주던 것만 거두고 아무것도 바꾸지 않는다 */
function cancelRotate() {
  const g = gesture;
  if (!g) return;
  stopListening();
  gesture = null;
  viewerBox()?.classList.remove("dmsRotating");
  for (const item of g.items) clearTurn(item.frames);
}

// ---------------------------------------------------------------------------
// 손을 뗐을 때 — 돌린 모습을 새로 만들어 원래 것과 맞바꾸기
// ---------------------------------------------------------------------------

/** 새로 만드는 동안 표시 하나하나가 되돌리기에 따로 쌓이지 않게 막는다(dms-copy.js와 같은 방법) */
function blockUndo(layers) {
  const restores = [];
  for (const layer of new Set(layers.filter(Boolean))) {
    const original = layer.addUndoableEditor;
    layer.addUndoableEditor = () => {};
    restores.push(() => { layer.addUndoableEditor = original; });
  }
  return () => restores.forEach((restore) => restore());
}

const removeIfPresent = (ed) => {
  if (ed?.parent) ed.remove();
};
const putBack = (ed) => {
  if (ed) uiManager()?.rebuild(ed);
};

async function commitRotation(items, deg) {
  const um = uiManager();
  if (!um) return;
  busy = true;
  const swaps = [];
  const restoreUndo = blockUndo(items.map((item) => item.ed.parent));
  try {
    for (const item of items) {
      const turnBy = wrapDeg(angleFor(item, deg));
      if (Math.abs(turnBy) < 0.01) continue;
      try {
        const swap = await rotateOne(item, turnBy);
        if (swap) swaps.push(swap);
      } catch (err) {
        console.warn("[dms] 표시를 돌리지 못했습니다:", err);
      }
    }
  } finally {
    restoreUndo();
    // 돌려 보여주던 것을 거둔다. 원래 것은 바로 아래에서 지우므로 화면이 튀지 않는다.
    for (const item of items) clearTurn(item.frames);
    busy = false;
  }
  if (swaps.length === 0) return;

  for (const swap of swaps) removeIfPresent(swap.oldRef());
  // 돌린 것 전체를 되돌리기 한 칸으로 묶는다(이미 바꿔 놓았으므로 지금 실행하지는 않는다).
  um.addCommands({
    cmd: () => {
      for (const swap of swaps) {
        removeIfPresent(swap.oldRef());
        putBack(swap.newRef());
      }
    },
    undo: () => {
      for (const swap of swaps) {
        removeIfPresent(swap.newRef());
        putBack(swap.oldRef());
      }
    },
    mustExec: false,
  });
  selectOnly(swaps.map((swap) => swap.newRef()));
}

/**
 * 표시 하나를 deg도 돌린 모습으로 새로 만든다(원래 것은 아직 지우지 않는다).
 * 돌려주는 것: { oldRef, newRef } — 원래 것·새것을 찾아가는 길. 되돌리기에서 둘을 맞바꿀 때 쓴다.
 */
async function rotateOne(item, deg) {
  const { ed, pageView, pivot } = item;
  if (!ed.parent) return null;
  const turn = makeTurn(pageView, pivot, deg);
  const own = await rotateHooks.rotateOwn?.(ed, deg, turn);
  if (own) return own;
  switch (ed.mode) {
    case AnnotationEditorType.HIGHLIGHT:
      return rotateHighlight(ed, deg, turn);
    case AnnotationEditorType.FREETEXT:
      return rotateText(item, deg);
    case AnnotationEditorType.STAMP:
      return rotateImage(item, deg);
    default:
      return null;
  }
}

/**
 * 새로 만든 표시의 한가운데를 원래 표시의 한가운데(돌린 중심)에 맞춘다.
 * 문구·도장은 저장값만으로 자리를 잡으면 안쪽 여백·회전값 때문에 조금씩 어긋나므로,
 * 화면에 그려진 칸을 재서 옮긴 만큼 민다(옮기는 일은 PDF.js가 원래 갖고 있는 것을 쓴다).
 */
function moveCenterTo(made, [x, y]) {
  try {
    const box = made.div.getBoundingClientRect();
    const dx = x - (box.left + box.right) / 2;
    const dy = y - (box.top + box.bottom) / 2;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    made.drag(...made.screenToPageTranslation(dx, dy));
    made.fixAndSetPosition();
  } catch (err) {
    console.warn("[dms] 돌린 표시의 자리를 맞추지 못했습니다:", err);
  }
}

// ── 강조 표시(PDF.js가 칠한 것) ──────────────────────────────────────────────
//
// 우리가 만든 형광펜 띠는 dms-shapes.js가 점 목록으로 돌리고, 여기는 그 밖의 것이다.
//   · 손으로 그은 것([Text 선택]을 켜고 빈 자리를 그은 것) : 지나간 자리를 돌려 그대로 다시 긋는다.
//   · 글자를 따라 칠한 것 : 칠한 네모들을 돌려 다시 칠한다. PDF의 강조 표시는 가로세로로 반듯한
//     네모만 담을 수 있어서, 비스듬히 돌리면 가로로 잘게 썬 네모로 만든다(형광펜 띠와 같은 방법).
// 값은 표시에서 곧바로 읽는다 — PDF.js의 저장값(serialize)은 자료에 원래 들어 있던 강조 표시를
// 고치지 않았으면 비어 있기 때문이다.

async function rotateHighlight(ed, deg, turn) {
  const outlines = ed._drawOutlines;
  const layer = ed.parent;
  if (!outlines || !layer || !ed.color) return null;
  const base = {
    annotationType: AnnotationEditorType.HIGHLIGHT,
    color: hexToRgb(ed.color),
    opacity: ed.opacity ?? 1,
    thickness: ed._drawingOptions?.thickness,
    pageIndex: ed.pageIndex,
    // 회전값은 언제나 0으로 넣는다. PDF.js는 PDF 좌표의 점으로 형광펜을 다시 만들 때 돌리지 않은 쪽
    // 기준으로 모양을 잡는데, 회전값을 함께 넣으면 그만큼 한 번 더 돌려 놓는다 — 자료 안에
    // "쪽이 180도 돌아가 있다"는 값이 든 도면(AutoCAD로 출력한 것에 흔하다)에서 손으로 그은 형광펜이
    // 위아래·좌우가 뒤집힌 자리에 들어갔다(2026-09-18 확인). 글자를 따라 칠한 것은 회전값을 쓰지
    // 않으므로 0이어도 같다(우리 형광펜 띠도 0으로 만든다 — dms-shapes.js).
    rotation: 0,
  };

  let data;
  if (outlines.isFree) {
    const flat = outlines.serialize(ed.getPDFRect(), ed._drawRotation)?.points?.[0];
    if (!flat?.length) return null;
    const turned = [];
    const pairs = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const p = turn(flat[i], flat[i + 1]);
      turned.push(p[0], p[1]);
      pairs.push(p);
    }
    data = { ...base, outlines: { points: [turned] }, rect: boundingBox(pairs) };
  } else {
    const quads = outlines.serializeQuadPoints(ed.pageTranslation, ed.pageDimensions);
    if (!quads?.length) return null;
    const polygons = [];
    for (let i = 0; i + 7 < quads.length; i += 8) {
      const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
      const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
      const x1 = Math.min(...xs);
      const x2 = Math.max(...xs);
      const y1 = Math.min(...ys);
      const y2 = Math.max(...ys);
      polygons.push([[x1, y2], [x2, y2], [x2, y1], [x1, y1], [x1, y2]].map(([x, y]) => turn(x, y)));
    }
    // 90도 단위로 돌리면 네모는 그대로 네모라 자를 자리가 꼭짓점뿐이다(0 = 꼭짓점에서만 자른다).
    let step = 0;
    if (Math.abs(deg % 90) > 1e-6) {
      const ys = polygons.flat().map((p) => p[1]);
      step = Math.max(HIGHLIGHT_ROW_STEP, (Math.max(...ys) - Math.min(...ys)) / MAX_HIGHLIGHT_ROWS);
    }
    const turnedQuads = unionQuads(polygons, step);
    if (turnedQuads.length === 0) return null;
    data = { ...base, quadPoints: turnedQuads, rect: boundingBox(polygons.flat()) };
  }

  const made = await addEditor(layer, data, false);
  return made ? { oldRef: () => ed, newRef: () => made } : null;
}

// ── 텍스트(문구) ──────────────────────────────────────────────────────────────
//
// 문구는 회전값(0·90·180·270)만큼 거꾸로 돌려 세워 보여주는 주석이다(쪽을 돌려 볼 때 글자가
// 바로 서 있게 하려는 PDF.js의 방식). 그래서 그 값을 90 줄이면 화면에서 시계방향으로 90도 돈다.
// PDF.js가 복사·붙여넣기에 쓰는 길(serialize → deserialize)로 새 문구를 만들고 회전값과 칸의
// 가로세로만 바꾼다.

async function rotateText(item, deg) {
  const { ed, pageView, pivot } = item;
  const quarter = ((Math.round(deg / TEXT_STEP) % 4) + 4) % 4; // 시계방향으로 90도 몇 번
  if (quarter === 0) return null;
  const layer = ed.parent;
  let data = null;
  try {
    data = ed.serialize(true);
  } catch {
    data = null;
  }
  if (!data?.rect) return null;

  const [x1, y1, x2, y2] = data.rect;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const [w, h] = quarter % 2 ? [y2 - y1, x2 - x1] : [x2 - x1, y2 - y1];
  delete data.id;       // 자료에 원래 있던 주석을 가리키는 값 — 새 문구는 언제나 "새로 적은 표시"다
  delete data.popupRef; // 원래 문구에 딸린 메모 풍선을 가리키는 값(PDF.js의 복사와 같다)
  const made = await layer.deserialize({
    ...data,
    rect: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    rotation: ((((data.rotation || 0) - TEXT_STEP * quarter) % 360) + 360) % 360,
    isCopy: true, // 글자 내용까지 그려 넣게 하는 표시(PDF.js의 복사·붙여넣기와 같은 길)
  });
  if (!made) return null;
  made.isClone = true; // 붙여넣기처럼 제 크기만큼 옆으로 밀어 놓지 않는다(dms-copy.js와 같다)
  layer.add(made);
  moveCenterTo(made, clientPoint(pageView, pivot));

  // 원래 문구에 글자 배경이 깔려 있었으면 새 문구에도 같은 색으로 깐다(dms-tools.js).
  const back = textBackgroundHooks.colorOf?.(ed);
  if (back) await textBackgroundHooks.apply?.(made, back);
  return { oldRef: () => ed, newRef: () => made };
}

// ── 스탬프·이미지 ────────────────────────────────────────────────────────────
//
// 그림 주석은 90도 단위로만 돌릴 수 있어서, 그림 자체를 돌려 다시 그린다. 돌린 그림이 들어갈
// 네모(틀)는 그만큼 커지고, 네모 모서리의 빈 곳은 비워 둔다(투명). 처음 그림과 지금까지 돈 각도를
// 적어 두었다가 늘 처음 그림에서 돌려 그리므로 여러 번 돌려도 흐려지지 않는다.

async function rotateImage(item, deg) {
  const { ed, pageView, pivot } = item;
  const layer = ed.parent;
  const um = uiManager();

  let source = images.get(keyOf(ed));
  if (!source) {
    let data = null;
    try {
      data = ed.serialize(true); // 복사용 — 지금 그림이 통째로 담긴다(bitmapUrl)
    } catch {
      data = null;
    }
    if (!data?.bitmapUrl) return null;
    source = { url: data.bitmapUrl, angle: 0, frameW: ed.width, frameH: ed.height, boxW: ed.width, boxH: ed.height };
  }

  // 돌린 뒤에 크기를 바꿨으면 그만큼 처음 그림의 틀도 키우거나 줄인다.
  const frameW = source.frameW * (source.boxW ? ed.width / source.boxW : 1);
  const frameH = source.frameH * (source.boxH ? ed.height / source.boxH : 1);
  const angle = (((source.angle + deg) % 360) + 360) % 360;

  const [parentWidth, parentHeight] = ed.parentDimensions;
  const fw = frameW * parentWidth; // 처음 그림 틀의 크기(편집 판 픽셀)
  const fh = frameH * parentHeight;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const bw = fw * cos + fh * sin; // 돌린 그림을 감싸는 네모
  const bh = fw * sin + fh * cos;

  const url = await drawTurnedImage(source.url, fw, fh, bw, bh, rad);
  const image = await um.imageManager.getFromUrl(url);
  if (!image?.bitmap) return null;

  const [pageWidth] = ed.pageDimensions;
  const [x1, y1] = ed.getRect(0, 0);
  // 새 그림 칸의 PDF 크기. 표시 칸이 90·270도로 놓여 있으면(화면을 90도 돌린 채 찍은 도장 등)
  // 칸의 가로가 PDF의 세로 방향이라 두 값을 바꿔 넣어야 그림이 찌그러지지 않는다 (2026-09-18 확인).
  const scale = parentWidth / pageWidth; // 편집 판 픽셀 ÷ PDF 단위
  const [spanX, spanY] = ed.rotation % 180 === 0 ? [bw / scale, bh / scale] : [bh / scale, bw / scale];
  // 그림(bitmap)과 그 id를 함께 넘기면 PDF.js가 그림을 기다리지 않고 곧바로 그려 넣는다 —
  // 그래야 되돌리기가 이 자리에서 막힌 채로 끝난다(기다렸다 그리면 그때 따로 쌓인다).
  const made = await layer.deserialize({
    annotationType: AnnotationEditorType.STAMP,
    bitmapId: image.id,
    bitmap: image.bitmap,
    isSvg: false,
    rect: [x1, y1, x1 + spanX, y1 + spanY],
    pageIndex: ed.pageIndex,
    rotation: ed.rotation,
  });
  if (!made) return null;
  layer.add(made);
  moveCenterTo(made, clientPoint(pageView, pivot));
  images.set(keyOf(made), { url: source.url, angle, frameW, frameH, boxW: made.width, boxH: made.height });
  return { oldRef: () => ed, newRef: () => made };
}

/**
 * 처음 그림을 rad만큼 돌려 새 그림(PNG 주소)으로 그린다.
 *   fw·fh : 처음 그림 틀의 크기, bw·bh : 돌린 그림을 감싸는 네모의 크기(둘 다 편집 판 픽셀)
 * 처음 그림의 선명도(틀 1픽셀에 그림 몇 픽셀이 들어 있었는지)를 그대로 지킨다 — 스탬프는 인쇄해도
 * 흐리지 않게 화면 크기의 네 배로 그려 두었다(dms-stamp.js).
 */
async function drawTurnedImage(url, fw, fh, bw, bh, rad) {
  const img = new Image();
  img.src = url;
  await img.decode();
  let density = Math.max(img.naturalWidth / fw, img.naturalHeight / fh, 1);
  const longest = Math.max(bw, bh) * density;
  if (longest > MAX_IMAGE_SIDE) density *= MAX_IMAGE_SIDE / longest;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bw * density));
  canvas.height = Math.max(1, Math.round(bh * density));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, (-fw * density) / 2, (-fh * density) / 2, fw * density, fh * density);
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// 도구모음의 [회전]을 켜 두었을 때 — 그려 둔 표시를 잡고 끌면 돌린다
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!rotateMode.on || e.button !== 0 || e.defaultPrevented || gesture || busy) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return; // Ctrl+끌기는 복사(dms-copy.js)가 맡는다
  const target = e.target;
  // 표시 옆 도구모음의 버튼과 크기 조절 손잡이는 원래대로 눌리게 둔다. 손잡이 하나하나(.resizer)만
  // 뺀다 — 골라 둔 표시는 손잡이를 담은 투명한 칸(.resizers)이 몸통 전체를 덮고 있어, 그 칸까지
  // 빼면 골라 둔 표시를 잡았을 때 돌지 않고 옮겨졌다(2026-09-18 확인).
  if (target?.closest?.(".editToolbar, .resizer")) return;
  const div = target?.closest?.(".annotationEditorLayer > *");
  const pressed = div ? uiManager()?.getEditor(div.id) : null;
  if (!pressed || !canRotate(pressed)) return;
  e.preventDefault();
  e.stopPropagation();
  startRotate(pressed, e, { clickTurn: 0 });
}

export function installRotateTool(pdfViewerApplication) {
  app = pdfViewerApplication;
  watchUiManager(app);

  // 표시 옆 작은 도구모음(dms-edit-toolbar.js)의 [회전]이 부를 수 있게 자리를 채운다.
  rotateTool.canRotate = canRotate;
  rotateTool.start = startRotate;

  // 도형 도구·복사(dms-copy.js)보다 나중에 걸어 둔다 — 그쪽이 먼저 보고 가져간 것(preventDefault)은
  // 건드리지 않는다(dms-copy.js와 같은 규칙).
  viewerBox().addEventListener("pointerdown", onPointerDown, true);

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !gesture) return;
    cancelRotate();
    e.preventDefault();
    e.stopPropagation();
  }, true);

  app.eventBus.on("annotationeditormodechanged", () => cancelRotate());
}
