// 도면관리시스템이 덧붙인 "Ctrl+끌기 복사"와 "끌어서 여러 개 고르기" — 원래 PDF.js에는 없다
// (2026-09-07 CM 지시).
//
// ① Ctrl 누르고 그려 둔 표시를 끌면 복사된다 — 도형뿐 아니라 강조 표시·그리기·문구·도장까지
//    모든 표시에 된다(예전에는 우리가 만든 도형만 복사됐다). 원래 것은 제자리에 그대로 있고
//    손을 뗀 자리에 하나 더 생긴다(PPT와 같다).
// ② Shift까지 같이 누르면 수평 또는 수직으로만 옮겨져 복사된다(더 많이 움직인 쪽을 따른다).
// ③ 여러 개를 골라 둔 상태에서 그중 하나를 Ctrl로 끌면 골라 둔 것이 **전부** 복사된다.
//    복사한 것들은 되돌리기 한 칸으로 묶여 Ctrl+Z 한 번에 전부 없어지고, 복사한 뒤에는
//    그 복사본들이 골라진 채로 남아 이어서 옮길 수 있다.
// ④ [선택]으로 빈 자리를 끌면 고무줄 네모가 나오고, 그 네모에 닿은 표시가 전부 골라진다.
//
// 복사하는 방법은 둘로 갈린다.
//   · 우리가 만든 표시(도형·형광펜 띠·펜 선)는 dms-shapes.js에게 "무엇으로 만들었는지"를
//     물어(copyHooks) 그 값으로 다시 만든다 — 그래야 복사본도 회전·채움 전환·두께 변경·
//     선 타입 변경이 원본과 똑같이 된다.
//   · 그 밖의 표시(문구·도장 등)는 PDF.js가 복사·붙여넣기에 쓰는 길(serialize → deserialize)로
//     그대로 베낀 뒤 옮긴 만큼 민다. PDF.js 안쪽 코드는 한 줄도 고치지 않는다.
//
// 되돌리는 스위치는 dms-viewer.js의 USE_COPY_TOOL이다. false로 두면 Ctrl+끌기는 예전처럼
// "여러 개 고르기 켬/끔"이 되고 고무줄 선택도 생기지 않는다.

import { customTool, editor, textSelect, copyHooks, watchUiManager } from "./dms-state.js";
import { backgroundsOf, isBackground } from "./dms-link.js";

const { AnnotationEditorType } = globalThis.pdfjsLib;

// PDF.js의 커서 도구 번호 — 0=고르기(선택·이동), 1=손 도구
const CURSOR_SELECT = 0;

// 이만큼은 끌어야 "옮겼다"고 본다(픽셀). 그 전에는 그냥 누른 것으로 친다.
const MOVE_THRESHOLD = 4;

let app = null;
let currentMode = AnnotationEditorType.NONE;
let cursorTool = CURSOR_SELECT;

// PDF.js의 편집 총괄 — 자료를 열 때마다 새로 만들어지므로 쓸 때마다 가져온다(dms-state.js).
const uiManager = () => editor.uiManager;

let copyDrag = null; // Ctrl+끌기 복사 중  { pressed, targets, x0, y0, moved, ghost }
let bandDrag = null; // 고무줄로 고르는 중 { x0, y0, x1, y1, moved, box }

// ---------------------------------------------------------------------------
// 자잘한 도구들
// ---------------------------------------------------------------------------

const viewerBox = () => document.getElementById("viewerContainer");

/** 화면 좌표(clientX·clientY)를 뷰어 안쪽 자리로 바꾼다 — 스크롤을 따라가는 자리다 */
function toViewerPoint(clientX, clientY) {
  const box = viewerBox();
  const base = box.getBoundingClientRect();
  return [clientX - base.left + box.scrollLeft, clientY - base.top + box.scrollTop];
}

/** 그 칸(div)이 나타내는 표시. 채움 조각처럼 혼자 다루면 안 되는 것은 걸러낸다 */
function editorFromDiv(div) {
  const found = uiManager()?.getEditor?.(div?.id);
  return found && !isBackground(found) ? found : null;
}

/** 지금 마우스 밑에 있는 표시 */
function editorFromEvent(e) {
  const div = e.target?.closest?.(".annotationEditorLayer > *");
  return div ? editorFromDiv(div) : null;
}

/** 지금 자료에 그려져 있는 표시 전부 */
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

/**
 * 그 표시가 화면에 그려져 있는 그림 조각(SVG).
 * 펜·형광펜·도형은 그림이 편집기 칸이 아니라 따로 그려지므로, 베낄 때는 이것을 찾아야 한다
 * (dms-shapes.js의 svgRootOf와 같은 방법 — 찾는 길은 PDF.js가 붙여 둔 `path_<번호>` 뿐이다).
 */
function svgRootOf(markupEditor) {
  const drawId = markupEditor?._drawId;
  if (drawId === null || drawId === undefined) return null;
  return document.getElementById(`path_${drawId}`)?.closest("svg") || null;
}

/** Shift를 누르고 있으면 더 많이 움직인 쪽만 남긴다(수평 또는 수직으로만 옮긴다) */
function constrain(dx, dy, shiftKey) {
  if (!shiftKey) return [dx, dy];
  return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
}

/**
 * 골라 둔 것을 모두 풀고 넘긴 것들만 골라 둔다.
 *
 * PDF.js의 unselectAll을 쓰지 않는 것은, 그리기 도구가 켜져 있는 동안에는 그것이 아무것도
 * 풀지 않고 그냥 돌아가기 때문이다(적다 만 문구를 지키려는 규칙). 그러면 복사한 뒤에도 원본이
 * 골라진 채로 남아, 도구창에서 색을 바꾸면 원본까지 같이 바뀐다. 그래서 하나씩 직접 푼다.
 */
function selectOnly(editors) {
  const um = uiManager();
  if (!um) return;
  try {
    um.commitOrRemove();   // 적다 만 문구가 있으면 먼저 마무리한다(unselectAll이 하던 일)
    for (const ed of allEditors()) if (ed.isSelected) um.unselect(ed);
    for (const ed of editors) um.toggleSelected(ed);
  } catch {
    /* 고르기가 안 돼도 복사·그리기 자체는 이미 끝나 있다 */
  }
}

// ---------------------------------------------------------------------------
// 끄는 동안 보여주는 복사 미리보기(그림자)
// ---------------------------------------------------------------------------
//
// 무엇이 어디로 복사되는지 끄는 내내 보이게 한다. 표시 종류마다 그림이 있는 자리가 달라서
// (선·형광펜·도형은 따로 그려진 SVG, 문구·도장은 편집기 칸 안) 있는 쪽을 베껴 옅게 얹는다.

/** 그 표시를 눈에 보이게 하는 조각들 — 채움까지 함께 베껴야 도형이 제 모습으로 보인다 */
function ghostParts(markupEditor) {
  const parts = [];
  for (const back of backgroundsOf(markupEditor)) {
    const svg = svgRootOf(back);
    if (svg) parts.push(svg);
  }
  const paint = svgRootOf(markupEditor);
  if (paint) parts.push(paint);
  else if (markupEditor.div) parts.push(markupEditor.div);
  return parts;
}

/** 조각 하나를 베낀다(그림칸은 베껴도 그림이 안 따라오므로 원본에서 옮겨 그린다) */
function cloneVisual(el) {
  let clone;
  try {
    clone = el.cloneNode(true);
  } catch {
    return null;
  }
  clone.removeAttribute?.("id");
  clone.classList?.remove("selectedEditor");
  for (const junk of clone.querySelectorAll?.(".editToolbar, .resizers, .altText, .noAltTextBadge") || []) {
    junk.remove();
  }
  const from = el.querySelectorAll?.("canvas") || [];
  const to = clone.querySelectorAll?.("canvas") || [];
  for (let i = 0; i < to.length && i < from.length; i++) {
    try {
      to[i].getContext("2d")?.drawImage(from[i], 0, 0);
    } catch {
      /* 그림을 못 옮기면 자리만 옅게 보인다 — 복사 자체에는 지장이 없다 */
    }
  }
  const { style } = clone;
  if (style) {
    style.position = "absolute";
    style.left = "0";
    style.top = "0";
    style.right = "auto";
    style.bottom = "auto";
    style.width = "100%";
    style.height = "100%";
    style.margin = "0";
  }
  return clone;
}

function buildGhost(editors) {
  const box = viewerBox();
  const ghost = document.createElement("div");
  ghost.className = "dmsCopyGhost";
  for (const markupEditor of editors) {
    for (const el of ghostParts(markupEditor)) {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const [left, top] = toViewerPoint(rect.left, rect.top);
      const item = document.createElement("div");
      item.className = "dmsCopyGhostItem";
      item.style.left = `${left}px`;
      item.style.top = `${top}px`;
      item.style.width = `${rect.width}px`;
      item.style.height = `${rect.height}px`;
      const clone = cloneVisual(el);
      if (clone) item.append(clone);
      ghost.append(item);
    }
  }
  box.append(ghost);
  return ghost;
}

// ---------------------------------------------------------------------------
// ① Ctrl + 끌기 = 복사
// ---------------------------------------------------------------------------

/** 무엇을 복사할지 — 골라 둔 것 중 하나를 끌면 골라 둔 것 전부, 아니면 그것 하나만 */
function copyTargets(pressed) {
  if (!pressed.isSelected) return [pressed];
  const selected = allEditors().filter((ed) => ed.isSelected);
  return selected.length > 1 ? selected : [pressed];
}

function startCopyDrag(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;
  if (customTool.name === "eraser") return false; // 지우개를 쓰는 중에는 복사하지 않는다
  const pressed = editorFromEvent(e);
  if (!pressed?.parent) return false;

  e.preventDefault();
  e.stopPropagation();
  copyDrag = {
    pressed, targets: copyTargets(pressed),
    x0: e.clientX, y0: e.clientY, moved: false, ghost: null,
  };
  window.addEventListener("pointermove", onCopyMove);
  window.addEventListener("pointerup", onCopyUp);
  window.addEventListener("pointercancel", endCopyDrag);
  return true;
}

function onCopyMove(e) {
  if (!copyDrag) return;
  const [dx, dy] = constrain(e.clientX - copyDrag.x0, e.clientY - copyDrag.y0, e.shiftKey);
  if (!copyDrag.moved) {
    if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
    copyDrag.moved = true;
    copyDrag.ghost = buildGhost(copyDrag.targets);
  }
  copyDrag.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
}

async function onCopyUp(e) {
  const drag = copyDrag;
  if (!drag) return;
  const rawX = e.clientX - drag.x0;
  const rawY = e.clientY - drag.y0;
  const [dx, dy] = constrain(rawX, rawY, e.shiftKey);
  // 끄는 도중의 연락(pointermove)이 한 번도 안 올 수도 있으므로(아주 빠르게 끌면 그렇다)
  // 손을 뗀 자리로도 한 번 더 따져 본다.
  const moved = drag.moved || Math.hypot(rawX, rawY) >= MOVE_THRESHOLD;
  endCopyDrag();

  if (!moved) {
    // 끌지 않고 그냥 Ctrl+누르기 — PDF.js가 하던 대로 고르기를 켜고 끈다(여러 개 고르기).
    try {
      uiManager()?.toggleSelected(drag.pressed);
    } catch {
      /* 무시 — 고르기가 안 돼도 다른 동작에는 지장이 없다 */
    }
    return;
  }
  await copyEditors(drag.targets, dx, dy);
}

function endCopyDrag() {
  if (!copyDrag) return;
  copyDrag.ghost?.remove();
  copyDrag = null;
  window.removeEventListener("pointermove", onCopyMove);
  window.removeEventListener("pointerup", onCopyUp);
  window.removeEventListener("pointercancel", endCopyDrag);
}

/** 넘긴 표시들을 dx·dy(화면 픽셀)만큼 옮긴 자리에 하나씩 더 만든다 */
async function copyEditors(sources, dx, dy) {
  const um = uiManager();
  if (!um) return;

  // 만드는 동안에는 표시 하나하나가 되돌리기에 따로 쌓이지 않게 막아 둔다 — 여러 개를
  // 복사했을 때 Ctrl+Z를 여러 번 눌러야 하면 안 되기 때문이다(아래에서 한 번만 등록한다).
  const undoBlocks = [];
  for (const layer of new Set(sources.map((ed) => ed.parent).filter(Boolean))) {
    const original = layer.addUndoableEditor;
    layer.addUndoableEditor = () => {};
    undoBlocks.push(() => { layer.addUndoableEditor = original; });
  }

  const copies = [];
  try {
    for (const src of sources) {
      const made = await copyOne(src, dx, dy);
      if (made) copies.push(made);
    }
  } finally {
    for (const restore of undoBlocks) restore();
  }
  if (copies.length === 0) return;

  // 복사한 것 전체를 되돌리기 한 칸으로 묶는다(이미 만들어 놓았으므로 지금 실행하지는 않는다).
  um.addCommands({
    cmd: () => { for (const ed of copies) if (!ed.parent) um.rebuild(ed); },
    undo: () => { for (const ed of copies) ed.remove(); },
    mustExec: false,
  });

  // 복사한 것을 골라 둔다 — 곧바로 이어서 옮기거나 지울 수 있다(PPT와 같다).
  selectOnly(copies);
}

async function copyOne(src, dx, dy) {
  // 우리가 만든 표시(도형·형광펜 띠·펜 선)는 만든 값 그대로 다시 만든다(dms-shapes.js).
  const recipe = copyHooks.recipeFor?.(src) || null;
  if (recipe) {
    try {
      const made = await copyHooks.duplicate(recipe, dx, dy);
      if (made) return made;
    } catch (err) {
      console.warn("[dms] 표시를 만든 값으로 복사하지 못해 그대로 베낍니다:", err);
    }
  }
  return copyByPdfJs(src, dx, dy);
}

/** PDF.js가 복사·붙여넣기에 쓰는 길로 그대로 베낀다 — 문구·도장 등 우리가 만들지 않은 표시 */
async function copyByPdfJs(src, dx, dy) {
  const layer = src.parent;
  if (!layer) return null;

  // 복사·붙여넣기용(true)을 먼저 쓰는 것은 그쪽이 그림(도장)의 실제 이미지까지 담아 주기
  // 때문이고, 그 값이 비면 보관용을 쓴다(dms-favorite.js의 같은 판단).
  let data = null;
  try {
    data = src.serialize(true);
  } catch {
    data = null;
  }
  if (!data || !Object.keys(data).length) {
    try {
      data = src.serialize(false);
    } catch {
      data = null;
    }
  }
  if (!data) return null;

  delete data.id;        // 자료에 원래 있던 주석을 가리키는 값 — 복사본은 언제나 "새로 그린 표시"다
  delete data.popupRef;  // 원본에 딸린 메모 풍선을 가리키는 값 (PDF.js의 clonePage와 같다)
  data.isCopy = true;

  const made = await layer.deserialize(data);
  if (!made) return null;
  // 붙여넣기는 원본과 겹치지 않게 제 크기만큼 오른쪽·아래로 밀어 놓는 규칙이 있는데(_moveAfterPaste),
  // 우리는 끌어 놓은 자리에 정확히 놓아야 하므로 그 밀기를 끈다. PDF.js가 "그 자리에 그대로
  // 베끼는" 경우(clonePage)에 쓰는 표시를 그대로 쓴 것이라, 새로 만든 규칙이 아니다.
  made.isClone = true;
  layer.add(made);
  try {
    // 자리는 원본에 맞춘 뒤 끌어 놓은 만큼 민다. 베낀 값(rect)만으로 자리를 잡으면 표시 종류마다
    // 조금씩 어긋난다 — 문구는 칸 안쪽 여백·글자 크기만큼 위로 올라가 앉는다(getInitialTranslation).
    made.x = src.x;
    made.y = src.y;
    made.fixAndSetPosition();
    // 옮기는 일은 PDF.js가 원래 갖고 있는 것을 그대로 쓴다(쪽이 돌아가 있어도 맞는다).
    made.drag(...made.screenToPageTranslation(dx, dy));
    made.translationDone?.();
  } catch (err) {
    console.warn("[dms] 복사본을 옮기지 못했습니다:", err);
  }
  return made;
}

// ---------------------------------------------------------------------------
// ④ [선택]으로 빈 자리를 끌면 고무줄 네모로 여러 개 고르기
// ---------------------------------------------------------------------------

function startBandDrag(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  if (currentMode !== AnnotationEditorType.NONE || customTool.name) return false; // 그리기 중이면 안 한다
  if (cursorTool !== CURSOR_SELECT) return false;  // 손 도구는 화면을 끄는 도구다
  // [Text 선택]이 켜져 있으면 글자를 끌어 고르는 것이 그 스위치의 일이므로 고무줄은 안 나온다.
  if (!textSelect.locked) return false;
  if (!e.target?.closest?.(".page")) return false;
  if (e.target.closest(".annotationEditorLayer > *")) return false; // 표시 위에서 시작하면 그것을 고르는 것이다
  if (e.target.closest("a, .annotationLayer section")) return false; // 자료에 원래 있던 링크·주석은 그대로 둔다

  e.preventDefault();
  e.stopPropagation();
  bandDrag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false, box: null };
  window.addEventListener("pointermove", onBandMove);
  window.addEventListener("pointerup", onBandUp);
  window.addEventListener("pointercancel", endBandDrag);
  return true;
}

function bandRect(drag) {
  return {
    left: Math.min(drag.x0, drag.x1), right: Math.max(drag.x0, drag.x1),
    top: Math.min(drag.y0, drag.y1), bottom: Math.max(drag.y0, drag.y1),
  };
}

function onBandMove(e) {
  if (!bandDrag) return;
  bandDrag.x1 = e.clientX;
  bandDrag.y1 = e.clientY;
  const rect = bandRect(bandDrag);
  if (!bandDrag.moved) {
    if (rect.right - rect.left < MOVE_THRESHOLD && rect.bottom - rect.top < MOVE_THRESHOLD) return;
    bandDrag.moved = true;
    bandDrag.box = document.createElement("div");
    bandDrag.box.className = "dmsSelectBox";
    viewerBox().append(bandDrag.box);
  }
  const [left, top] = toViewerPoint(rect.left, rect.top);
  bandDrag.box.style.left = `${left}px`;
  bandDrag.box.style.top = `${top}px`;
  bandDrag.box.style.width = `${rect.right - rect.left}px`;
  bandDrag.box.style.height = `${rect.bottom - rect.top}px`;
}

function onBandUp(e) {
  const drag = bandDrag;
  if (!drag) return;
  // 끄는 도중의 연락이 한 번도 안 올 수도 있으므로 손을 뗀 자리를 넣어 다시 따져 본다.
  drag.x1 = e.clientX;
  drag.y1 = e.clientY;
  const rect = bandRect(drag);
  const moved = drag.moved
    || rect.right - rect.left >= MOVE_THRESHOLD || rect.bottom - rect.top >= MOVE_THRESHOLD;
  endBandDrag();
  // 끌지 않고 빈 자리를 그냥 누르면 골라 둔 것을 푼다.
  selectOnly(moved ? editorsInRect(rect) : []);
}

function endBandDrag() {
  if (!bandDrag) return;
  bandDrag.box?.remove();
  bandDrag = null;
  window.removeEventListener("pointermove", onBandMove);
  window.removeEventListener("pointerup", onBandUp);
  window.removeEventListener("pointercancel", endBandDrag);
}

/** 그 네모에 조금이라도 닿은 표시들 (화면에 그려져 있는 쪽만 본다) */
function editorsInRect(rect) {
  const out = [];
  for (const div of document.querySelectorAll(".annotationEditorLayer > *")) {
    const found = editorFromDiv(div);
    if (!found) continue;
    const box = div.getBoundingClientRect();
    if (box.right < rect.left || box.left > rect.right) continue;
    if (box.bottom < rect.top || box.top > rect.bottom) continue;
    out.push(found);
  }
  return out;
}

// ---------------------------------------------------------------------------

function onPointerDown(e) {
  // 왼쪽 단추만, 그리고 다른 도구가 이미 가져간 것(preventDefault)은 건드리지 않는다 —
  // 한붓그리기로 이어 긋는 중에 Ctrl을 누르고 표시 위에서 시작하는 경우가 그렇다.
  if (e.button !== 0 || e.defaultPrevented || copyDrag || bandDrag) return;
  if (startCopyDrag(e)) return;
  startBandDrag(e);
}

export function installCopyTool(pdfViewerApplication) {
  app = pdfViewerApplication;
  watchUiManager(app);

  // 도형 도구(dms-shapes.js)보다 나중에 걸어 둔다 — 그쪽이 먼저 보고 그릴 것이 있으면
  // 가져가고(preventDefault), 남는 것만 여기서 복사·고르기로 다룬다.
  viewerBox().addEventListener("pointerdown", onPointerDown, true);

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    endCopyDrag();
    endBandDrag();
  }, true);

  app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
    currentMode = mode;
    endCopyDrag();
    endBandDrag();
  });
  app.eventBus.on("cursortoolchanged", ({ tool, disabled }) => {
    // 편집 도구를 켜면 PDF.js가 커서 도구를 잠시 되돌린다(disabled=true) — 사용자가 고른 것이
    // 아니므로 기억해 두지 않는다(dms-tools.js의 같은 판단).
    if (!disabled) cursorTool = tool;
  });
}
