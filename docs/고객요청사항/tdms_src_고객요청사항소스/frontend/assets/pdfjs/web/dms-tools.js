// 도면관리시스템이 PDF.js 도구모음에 덧붙인 것들 — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
//   ① 화면 회전 버튼을 "1 / 12"(쪽 번호) 오른쪽으로 꺼내 놓기
//   ② [도구창 고정]·[Text 선택]·[Markup 선택] 켬/끔 · [선택] · [손 도구] · [회전] · [이동]
//      — 강조 표시 왼쪽에 이 순서로 ([회전]은 2026-09-18 CM 지시로 손 도구와 이동 사이에 넣었다.
//        실제로 돌리는 일은 dms-rotate.js가 한다)
//   ③ 형광펜·그리기(펜)·텍스트의 색 고르는 칸을 도형 도구와 같은 모양으로 바꾸기
//   ④ 막대(두께·크기·불투명도) 한 줄을 네 도구가 모두 같은 모양으로 — 라벨 + 막대 + 숫자칸
//   ⑤ 텍스트에 "글자 배경 칠하기" 더하기, 그리기(펜)에 "선 타입"(실선·점선·파선·구름) 더하기
//   ⑥ 도구창을 계속 열어 두기 ([도구창 고정])와 강조 표시 두께의 처음 값(5) 맞추기
//   ⑦ 안 쓰는 것 감추기 — 형광펜의 [모두 보기], 자료에 딸려 온 노란 메모(주석 풍선),
//      [대체 텍스트] 버튼 (모양은 dms-tools.css)
//   ⑧ 표시를 골라도 쓰던 도구가 바뀌지 않게 하기, ⑨ 스페이스바를 누르고 있는 동안 손 도구 (2026-09-19)
//      — [도구창 고정]·[Text 선택]·[Markup 선택]·[회전]·[이동]은 화면에서만 감춘다(dms-viewer.js의 SHOW_* 스위치)
//
// ③④는 칸만 우리 것으로 바꾸고, 실제로 값을 바꾸는 일은 PDF.js에게 그대로 시킨다
// (switchannotationeditorparams 라는 PDF.js의 원래 연락 방법을 쓴다). 그래서 PDF.js 안쪽 코드는
// 한 줄도 고치지 않았고, 나중에 새 버전으로 올려도 이 파일만 그대로 옮기면 된다.

import { createColorField, PRESET_COLORS } from "./dms-colors.js";
import { attachBackground, clearBackgrounds } from "./dms-link.js";
import {
  toolState, customTool, setCustomTool, onCustomToolChange, editor, watchUiManager, panelPin,
  HIGHLIGHT_DEFAULT_THICKNESS, highlightBandHooks, textSelect, inkLineTypeHooks,
  rotateMode, textBackgroundHooks,
} from "./dms-state.js";
import { addPolygonFill } from "./dms-fill.js";
import { LINE_TYPES } from "./dms-geometry.js";

const { AnnotationEditorType, AnnotationEditorParamsType } = globalThis.pdfjsLib;

// PDF.js의 커서 도구 번호 (viewer.mjs의 CursorTool과 같은 값이어야 한다)
const CURSOR_SELECT = 0;
const CURSOR_HAND = 1;

let app = null;
const fields = {};        // 색 고르는 칸들 — PDF.js가 색을 바꿔 알려줄 때 같이 맞춘다
const numbers = {};       // 막대 옆 숫자칸들 — 같은 이유로 함께 맞춘다
let currentMode = AnnotationEditorType.NONE;
let cursorTool = CURSOR_SELECT;
let pendingCursorTool = null;
// 원본(DWG 등) 미리보기 창인지 — 처음 색과 형광펜 칠하는 방식이 다르다(2026-09-20 CM 지시).
let originalView = false;
// 원본 창의 그리기·텍스트 처음 색 — 검은 바탕에서 잘 보이는 주황빛 노랑(CM 지정).
const ORIGINAL_VIEW_PEN_COLOR = "#f2a900";
// 원본 창 형광펜의 진하기 — dms-tools.css의 같은 자리(opacity)와 값이 같아야 저장한 PDF도 화면과 같다.
const ORIGINAL_HIGHLIGHT_OPACITY = 0.45;
let inkColorTouched = false;   // 사용자가 그리기 색을 직접 고른 뒤에는 처음 색으로 되돌리지 않는다
let textColorTouched = false;  // 텍스트 색도 같다
let settingPenDefault = false; // 지금 바꾸는 것이 우리인지(사용자 조작과 구별하려고)
let markupLocked = true;  // true면 그려 둔 표시를 마우스로 못 잡는다([Markup 선택]이 꺼진 상태)
let textLocked = true;    // true면 자료의 글자를 마우스로 못 고른다([Text 선택]이 꺼진 상태)

// ---------------------------------------------------------------------------
// PDF.js에 값 전하기
// ---------------------------------------------------------------------------

/**
 * 값을 골라 둔 표시에도, 다음에 그릴 것의 기본값에도 함께 적용한다.
 *
 * PDF.js는 "고른 표시가 있으면 그것만, 없으면 기본값"으로 갈라 처리한다. 그런데 표시를 하나
 * 그리면 그것이 골라진 채로 남기 때문에, 그 뒤로 색을 아무리 바꿔도 기본값은 그대로였고
 * 다음에 그린 것이 계속 옛 색(노란색)으로 나왔다 — 2026-09-02 CM 보고. 그래서 기본값 쪽은
 * 잠깐 "고른 것이 없다"고 알려 따로 한 번 더 적용한다. 골라 둔 표시는 그대로 남는다.
 */
function setParam(typeName, value) {
  const type = AnnotationEditorParamsType[typeName];
  app.eventBus.dispatch("switchannotationeditorparams", { source: null, type, value });
  setDefaultParam(type, value);
}

function setDefaultParam(type, value) {
  const uiManager = editor.uiManager;
  if (!uiManager) return;
  Object.defineProperty(uiManager, "hasSelection", { get: () => false, configurable: true });
  try {
    uiManager.updateParams(type, value);
  } catch {
    /* 자료가 아직 안 열렸거나 편집 도구가 꺼져 있으면 기본값을 바꿀 자리가 없다 — 넘어간다 */
  } finally {
    delete uiManager.hasSelection; // 원래대로 되돌린다(고른 표시가 있으면 다시 있다고 나온다)
  }
}

// ---------------------------------------------------------------------------
// ① 화면 회전 버튼 (쪽 번호 오른쪽)
// ---------------------------------------------------------------------------

function installRotateButtons() {
  const numPages = document.getElementById("numPages");
  if (!numPages) return;

  const group = document.createElement("div");
  group.className = "toolbarHorizontalGroup dmsRotateGroup";
  group.innerHTML = `
    <button id="dmsRotateCw" class="toolbarButton" type="button" tabindex="0" title="시계방향으로 회전">
      <span>시계방향으로 회전</span>
    </button>
    <button id="dmsRotateCcw" class="toolbarButton" type="button" tabindex="0" title="시계 반대방향으로 회전">
      <span>시계 반대방향으로 회전</span>
    </button>`;
  numPages.after(group);

  // 원래 오른쪽 끝 » 안에 있던 버튼과 같은 일을 한다(그쪽 버튼도 그대로 남는다).
  document.getElementById("dmsRotateCw").addEventListener("click", () => app.rotatePages(90));
  document.getElementById("dmsRotateCcw").addEventListener("click", () => app.rotatePages(-90));
}

// ---------------------------------------------------------------------------
// ② [도구창 고정] · [Text 선택] · [Markup 선택] · [선택] · [손 도구] · [회전] · [이동]
// ---------------------------------------------------------------------------

let selectButton = null;
let handButton = null;
let rotateButton = null;
let moveButton = null;
// 마지막으로 고른 커서 버튼 — 어느 것이 눌린 표시인지 정할 때 쓰고, [회전]이면 그려 둔 표시를
// 끌 때 옮기지 않고 돌린다(rotateMode — dms-rotate.js가 읽는다).
let pointerMode = "select";
let lockButton = null;
let textLockButton = null;
let pinButton = null;

// withRotate: [회전] 버튼을 둘지 — dms-viewer.js의 USE_ROTATE_TOOL이 정한다.
// showModeSwitches / showPointerExtras : 숨긴 것은 화면에서만 감출 뿐 요소는 그대로 두어
// (dms-viewer.js의 SHOW_MODE_SWITCHES·SHOW_POINTER_EXTRA_BUTTONS) 값·동작이 예전 그대로이고
// 스위치 하나로 다시 보이게 할 수 있다.
function installCursorTools(withRotate, { showModeSwitches = true, showPointerExtras = true } = {}) {
  const anchor = document.getElementById("editorHighlight");
  if (!anchor) return;

  // [회전]은 손 도구와 이동 사이에 둔다 (2026-09-18 CM 지시).
  const rotateHtml = withRotate ? `
    <button id="dmsRotateTool" class="toolbarButton" type="button" tabindex="0" title="회전">
      <span>회전</span>
    </button>` : "";

  const group = document.createElement("div");
  group.className = "toolbarHorizontalGroup dmsCursorGroup";
  group.innerHTML = `
    <div class="dmsToolbarSwitch">
      <span class="dmsToolbarSwitchLabel" data-short="고정">도구창 고정</span>
      <button id="dmsPanelPin" class="toggle-button" type="button" tabindex="0"
              aria-pressed="true" title="도구창 고정"></button>
    </div>
    <div class="dmsToolbarSwitch">
      <span class="dmsToolbarSwitchLabel" data-short="Text">Text 선택</span>
      <button id="dmsTextSelect" class="toggle-button" type="button" tabindex="0"
              aria-pressed="false" title="Text 선택"></button>
    </div>
    <div class="dmsToolbarSwitch">
      <span class="dmsToolbarSwitchLabel" data-short="Markup">Markup 선택</span>
      <button id="dmsMarkupLock" class="toggle-button" type="button" tabindex="0"
              aria-pressed="false" title="Markup 선택"></button>
    </div>
    <div class="dmsToolbarDivider"></div>
    <button id="dmsSelectTool" class="toolbarButton" type="button" tabindex="0" title="선택">
      <span>선택</span>
    </button>
    <button id="dmsHandTool" class="toolbarButton" type="button" tabindex="0" title="손 도구">
      <span>손 도구</span>
    </button>${rotateHtml}
    <button id="dmsMoveTool" class="toolbarButton" type="button" tabindex="0" title="이동">
      <span>이동</span>
    </button>
    <div class="dmsToolbarDivider"></div>`;
  anchor.before(group);

  selectButton = document.getElementById("dmsSelectTool");
  handButton = document.getElementById("dmsHandTool");
  rotateButton = document.getElementById("dmsRotateTool");
  moveButton = document.getElementById("dmsMoveTool");
  lockButton = document.getElementById("dmsMarkupLock");
  textLockButton = document.getElementById("dmsTextSelect");
  pinButton = document.getElementById("dmsPanelPin");

  // 눈에만 안 보이게 한다 (2026-09-19 CM 지시). 첫 칸막이는 스위치 셋 바로 뒤의 것이다.
  if (!showModeSwitches) {
    for (const el of group.querySelectorAll(".dmsToolbarSwitch")) el.classList.add("dmsHiddenByChoice");
    group.querySelector(".dmsToolbarDivider")?.classList.add("dmsHiddenByChoice");
  }
  if (!showPointerExtras) {
    rotateButton?.classList.add("dmsHiddenByChoice");
    moveButton.classList.add("dmsHiddenByChoice");
  }

  // [선택]은 그리기 도구만 끄고 [Markup 선택]은 건드리지 않는다 (2026-09-04 CM 지시 —
  // 예전에는 [선택]을 누르면 [Markup 선택]이 꺼졌다). 그리기 도구가 꺼져 있으면 그려 둔 표시는
  // 스위치와 상관없이 언제나 잡히므로(dms-tools.css), [선택]으로 도형·문구를 고르고
  // 옮기거나 지울 수 있다.
  // [이동]은 거기에 더해 [Markup 선택]까지 켜 둔다 — 그리기 도구를 다시 켜도 표시를 잡을 수 있게.
  // [회전]은 그리기 도구를 끄고, 그려 둔 표시를 잡고 끌 때 옮기지 않고 돌리게 한다(dms-rotate.js).
  // 그리기 도구가 꺼져 있으면 표시는 언제나 잡히므로 [Markup 선택]은 건드리지 않는다.
  selectButton.addEventListener("click", () => { pointerMode = "select"; useCursorTool(CURSOR_SELECT); });
  rotateButton?.addEventListener("click", () => { pointerMode = "rotate"; useCursorTool(CURSOR_SELECT); });
  moveButton.addEventListener("click", () => { pointerMode = "move"; setMarkupLocked(false); useCursorTool(CURSOR_SELECT); });
  handButton.addEventListener("click", () => { pointerMode = "hand"; useCursorTool(CURSOR_HAND); });
  lockButton.addEventListener("click", () => setMarkupLocked(!markupLocked));
  textLockButton.addEventListener("click", () => setTextLocked(!textLocked));
  pinButton.addEventListener("click", () => setPanelPin(!panelPin.on));

  // [Text 선택]·[Markup 선택]은 처음에 꺼 두고 (2026-09-03 CM 지시),
  // [도구창 고정]은 켜 둔다 (2026-09-04 CM 지시).
  setMarkupLocked(true);
  setTextLocked(true);
  setPanelPin(true);
  refreshCursorButtons();
}

// 도구창(색·두께를 고르는 작은 창)을 계속 열어 둘지 정한다 (2026-09-04 CM 지시).
// 켜면 창 밖을 눌러도 안 닫히고 도구 아이콘을 한 번 더 눌러야 닫히며,
// 끄면 창 밖을 누르는 순간 창만 닫힌다(도구는 켜진 채라 계속 그릴 수 있다).
function setPanelPin(on) {
  panelPin.on = on;
  pinButton.setAttribute("aria-pressed", String(on));
}

// 자료에 적혀 있는 글자를 마우스로 고를 수 있는지 정한다.
// 끄는 이유(CM 설명): 형광펜으로 칠할 때 밑에 있는 글자가 딸려 잡혀서, 칠하려던 자리가 아니라
// 그 글자를 따라 칠해진다. 꺼 두면 글자가 마우스를 받지 않아 원하는 자리에 그대로 칠해진다.
function setTextLocked(locked) {
  textLocked = locked;
  textSelect.locked = locked; // 형광펜을 손으로 그을 때 이 값을 본다(dms-shapes.js)
  textLockButton.setAttribute("aria-pressed", String(!locked));
  document.getElementById("viewerContainer").classList.toggle("dmsTextLocked", locked);
}

// 그려 둔 표시를 마우스로 잡을 수 있는지 정한다.
// 끄는 이유(CM 설명): 도형·글자가 빽빽한 자리에서는 새로 그으려고만 하면 옆에 있던 표시가
// 먼저 잡혀서 그릴 수가 없다. 꺼 두면 표시들이 마우스를 받지 않아 그 위에 그대로 그릴 수 있다.
function setMarkupLocked(locked) {
  markupLocked = locked;
  lockButton.setAttribute("aria-pressed", String(!locked));
  document.getElementById("viewerContainer").classList.toggle("dmsMarkupLocked", locked);
  refreshCursorButtons(); // [텍스트 선택 도구]·[이동] 중 어느 쪽이 눌린 표시인지 맞춘다
}

/** 그리기 도구를 모두 끄고 기본 마우스(텍스트 선택) 또는 손 도구로 바꾼다 */
function useCursorTool(tool) {
  pendingCursorTool = tool;
  setCustomTool(null, false); // 도형·지우개가 켜져 있으면 끈다
  if (currentMode !== AnnotationEditorType.NONE) {
    // 편집 도구가 켜져 있는 동안에는 PDF.js가 커서 도구 바꾸기를 막는다. 편집을 먼저 끄고,
    // 꺼졌다는 연락(annotationeditormodechanged)을 받은 뒤에 이어서 바꾼다.
    app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
    return;
  }
  applyPendingCursorTool();
}

function applyPendingCursorTool() {
  if (pendingCursorTool === null) return;
  const tool = pendingCursorTool;
  pendingCursorTool = null;
  app.eventBus.dispatch("switchcursortool", { source: null, tool });
  refreshCursorButtons();
}

function refreshCursorButtons() {
  if (!selectButton) return;
  const drawing = currentMode !== AnnotationEditorType.NONE || !!customTool.name;
  const pointing = !drawing && cursorTool === CURSOR_SELECT;
  // [선택]·[이동]은 둘 다 그리기를 끈 상태라 하는 일이 거의 같으므로, 마지막으로 누른 쪽 하나만
  // 눌린 표시가 된다. [회전]은 끄는 동작 자체가 달라지므로(옮기지 않고 돌린다) [Markup 선택]과
  // 상관없이 켜 둔 동안 눌린 채로 남는다.
  const rotating = !!rotateButton && pointing && pointerMode === "rotate";
  const moving = pointing && pointerMode === "move" && !markupLocked;
  selectButton.classList.toggle("toggled", pointing && !moving && !rotating);
  rotateButton?.classList.toggle("toggled", rotating);
  moveButton.classList.toggle("toggled", moving);
  const hand = !drawing && cursorTool === CURSOR_HAND;
  handButton.classList.toggle("toggled", hand);
  // [손 도구]는 화면만 옮긴다 — 표시가 잡히지 않게 막고(dms-tools.css), 골라져 있던 것도 푼다.
  const container = document.getElementById("viewerContainer");
  if (hand && !container?.classList.contains("dmsHandMode")) {
    try { app.pdfViewer._layerProperties?.annotationEditorUIManager?.unselectAll(); } catch (e) { /* 무시 */ }
  }
  container?.classList.toggle("dmsHandMode", hand);
  rotateMode.on = rotating;
  document.getElementById("viewerContainer")?.classList.toggle("dmsRotateMode", rotating);
}

// ── [저장] → [다운로드] (2026-09-05 CM 지시) ──────────────────────────────
//
// 이 화면에서 그 버튼이 하는 일은 "고친 자료를 내 컴퓨터로 받는 것"이라 다운로드가 맞는 말이다
// (원본 자료를 덮어쓰는 게 아니다). PDF.js 안에 이미 다운로드용 문구가 들어 있어서
// 붙이는 이름표만 그것으로 바꿔 준다 — viewer.html은 손대지 않는다(원본을 한 줄만 고치는 원칙).

function renameSaveToDownload() {
  const buttons = ["downloadButton", "secondaryDownload"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  for (const button of buttons) {
    button.setAttribute("data-l10n-id", "pdfjs-download-button");
    button.querySelector("span")?.setAttribute("data-l10n-id", "pdfjs-download-button-label");
  }
  // 이름표를 바꾸면 번역이 다시 붙지만, 혹시 안 붙었으면 글자를 직접 적어 준다.
  app.l10n?.translate?.(document.getElementById("toolbarContainer") || document.body);
  setTimeout(() => {
    for (const button of buttons) {
      if (button.title === "저장") button.title = "다운로드";
      const label = button.querySelector("span");
      if (label && label.textContent.trim() === "저장") label.textContent = "다운로드";
    }
  }, 800);
}

// ---------------------------------------------------------------------------
// ③ 색 고르는 칸 바꿔 끼우기
// ---------------------------------------------------------------------------

function installHighlightColors() {
  const slot = document.getElementById("editorHighlightColorPicker");
  if (!slot) return;
  // PDF.js가 만들어 넣는 원래 색 동그라미 줄은 dms-tools.css에서 감춘다(지우지는 않는다 —
  // 자료를 새로 열 때마다 PDF.js가 다시 만들어 넣기 때문이다).
  slot.classList.add("dmsReplaced");
  fields.highlight = createColorField({
    colors: PRESET_COLORS.highlight,
    value: toolState.highlight.color,
    onChange: (color) => {
      if (!color) return;
      if (!settingHighlightDefault) highlightColorTouched = true; // 사용자가 직접 고른 색은 그대로 둔다
      toolState.highlight.color = color;
      setParam("HIGHLIGHT_COLOR", color);
    },
  });
  slot.append(fields.highlight.element);
}

function installInkColors() {
  const input = document.getElementById("editorInkColor");
  const setter = input?.closest(".editorParamsSetter");
  if (!setter) return;
  setter.classList.add("dmsReplaced");

  const slot = document.createElement("div");
  fields.ink = createColorField({
    colors: PRESET_COLORS.pen,
    value: toolState.ink.color,
    onChange: (color) => {
      if (!color) return;
      if (!settingPenDefault) inkColorTouched = true;
      toolState.ink.color = color;
      setParam("INK_COLOR", color);
    },
  });
  slot.append(fields.ink.element);
  setter.after(slot);

  // 투명도 — 브라우저가 색 칸에서 투명도까지 고를 수 있으면 PDF.js가 원래 있던 투명도 막대를
  // 지워버린다. 색 칸을 우리 것으로 바꾸면서 투명도를 못 고치게 되면 안 되므로 여기서 다시 둔다.
  if (!document.getElementById("editorInkOpacity")) {
    const row = document.createElement("div");
    row.className = "editorParamsSetter";
    row.innerHTML = `
      <label for="dmsInkOpacity" class="editorParamsLabel">불투명도</label>
      <input type="range" id="dmsInkOpacity" class="editorParamsSlider"
             value="1" min="0.05" max="1" step="0.05" tabindex="0" />`;
    slot.after(row);
    document.getElementById("dmsInkOpacity").addEventListener("input", function () {
      toolState.ink.opacity = this.valueAsNumber;
      setParam("INK_OPACITY", this.valueAsNumber);
    });
  }

  // 도형·지우개가 켜져 있을 때 [그리기]를 누르면 그 도구만 끄고 그리기가 켜지게 한다.
  // (도형·지우개는 그리기 편집 상태를 빌려 쓰고 있어서, 그냥 두면 PDF.js가 "이미 켜져 있다"고
  //  보고 편집을 통째로 꺼버려 그리기 버튼을 두 번 눌러야 한다.)
  document.getElementById("editorInkButton")?.addEventListener("click", () => {
    if (customTool.name) setCustomTool(null, false);
  }, true);
}

// ── 그리기(펜)의 선 타입 (2026-09-04 CM 지시) ─────────────────────────────
//
// 실선은 지금까지처럼 PDF.js가 그리고, 점선·파선·구름은 우리가 그린다(dms-shapes.js).
// PDF.js가 쓰는 그리기 주석에는 선 모양이라는 값이 아예 없어서, 조각난 선·물결 선을 실제로
// 그렇게 생긴 선으로 만들어 넣는 것이다. 그래야 저장한 PDF에서도 그 모양 그대로 보인다.
// 구름은 도면이 고쳐진 자리에 두르는 Revision 표시로 쓴다(CM 설명).

function installInkLineType() {
  const container = document.querySelector("#editorInkParamsToolbar .editorParamsToolbarContainer");
  if (!container) return;

  const box = document.createElement("div");
  box.className = "dmsLineTypeBox";
  box.innerHTML = `
    <span class="editorParamsLabel">선 타입</span>
    <div class="dmsLineTypeChoices">
      ${LINE_TYPES.map((t) => `
        <button type="button" class="dmsLineTypeChoice" data-line="${t.id}" title="${t.label}"
                aria-label="${t.label}">
          <span class="dmsLineTypeIcon ${t.id}"></span>
        </button>`).join("")}
    </div>`;
  container.prepend(box); // 도형 도구창의 "모양 선택"과 같이 맨 위에 둔다

  const mark = () => {
    for (const choice of box.querySelectorAll(".dmsLineTypeChoice")) {
      choice.classList.toggle("chosen", choice.dataset.line === toolState.ink.lineType);
    }
  };
  box.addEventListener("click", (e) => {
    const choice = e.target.closest(".dmsLineTypeChoice");
    if (!choice) return;
    toolState.ink.lineType = choice.dataset.line;
    mark();
    // 그려 둔 선을 골라 두었으면 그 선도 고른 모양으로 다시 그린다 (2026-09-05 CM 지시).
    // 골라 둔 것이 없으면 아무 일도 안 하고, 그 값은 "다음에 그을 선"의 모양이 된다.
    inkLineTypeHooks.restyleLineType?.(toolState.ink.lineType);
  });
  mark();
}

function installTextColors() {
  const input = document.getElementById("editorFreeTextColor");
  const setter = input?.closest(".editorParamsSetter");
  if (!setter) return;
  setter.classList.add("dmsReplaced");

  const slot = document.createElement("div");
  fields.text = createColorField({
    colors: PRESET_COLORS.pen,
    value: toolState.text.color,
    onChange: (color) => {
      if (!color) return;
      if (!settingPenDefault) textColorTouched = true;
      toolState.text.color = color;
      setParam("FREETEXT_COLOR", color);
    },
  });
  slot.append(fields.text.element);
  setter.after(slot);
}

// ---------------------------------------------------------------------------
// ④ 막대(두께·크기·불투명도) 한 줄을 네 도구가 같은 모양으로
// ---------------------------------------------------------------------------

/**
 * PDF.js가 갖고 있던 막대 한 줄을 "라벨 + 막대 + 숫자칸" 모양으로 다시 짠다.
 * 막대(input) 자체는 지우지 않고 그대로 옮겨 담는다 — PDF.js가 그 칸을 계속 읽고 쓰기 때문이다.
 *   sliderId  : PDF.js가 쓰는 막대의 id
 *   label     : 새로 적을 문구 ("두께 조정" 등)
 *   paramName : 값이 바뀌었을 때 기본값으로도 삼을 항목 이름 (setParam과 같은 이름)
 *   percent   : true면 숫자칸에 백분율로 보여준다 (불투명도 0.55 → 55)
 *   onValue   : 값이 바뀔 때마다 부른다 (toolState에 담아 두는 용도)
 */
function unifySliderRow(sliderId, label, { paramName = null, percent = false, onValue = null } = {}) {
  const slider = document.getElementById(sliderId);
  if (!slider) return null;
  const oldRow = slider.closest("#editorHighlightThickness, .editorParamsSetter");
  if (!oldRow) return null;

  const row = document.createElement("div");
  row.className = "dmsSliderRow";

  const text = document.createElement("label");
  text.className = "editorParamsLabel";
  text.setAttribute("for", sliderId);
  text.textContent = label;

  const number = document.createElement("input");
  number.type = "number";
  number.className = "dmsNumberInput";
  number.setAttribute("aria-label", label);
  const factor = percent ? 100 : 1;
  const decimals = percent ? 0 : (String(slider.step).includes(".") ? 2 : 0);
  number.min = String(Math.round(Number(slider.min) * factor));
  number.max = String(Math.round(Number(slider.max) * factor));
  number.step = percent ? "5" : slider.step;

  // 숫자칸을 막대 값에 맞춰 적는다. 다만 사용자가 그 칸에 직접 적는 중이면 건드리지
  // 않는다 — 적는 도중의 값(예: "100"을 적는 동안의 "1")이 범위를 벗어나 되돌려지면
  // 글자가 섞여 생뚚은 값이 된다.
  const show = () => {
    if (document.activeElement === number) return;
    number.value = (slider.valueAsNumber * factor).toFixed(decimals);
  };
  number.value = (slider.valueAsNumber * factor).toFixed(decimals);

  row.append(text, slider, number); // 막대가 여기로 옮겨 온다
  oldRow.replaceWith(row);          // 남은 껍데기(원래 라벨·꾸밈 동그라미)는 함께 사라진다
  numbers[sliderId] = { number, show };

  // 막대를 움직이면 숫자칸이 따라오고, PDF.js가 원래 하던 일(값 반영)은 그대로 일어난다.
  // 우리 일은 그 뒤에 붙어 "다음에 그릴 것의 기본값"까지 함께 바꾸는 것뿐이다(setParam 설명 참고).
  slider.addEventListener("input", () => {
    show();
    onValue?.(slider.valueAsNumber);
    if (paramName) setDefaultParam(AnnotationEditorParamsType[paramName], slider.valueAsNumber);
  });

  // 숫자칸에 적으면 막대를 그 값으로 옮기고, 막대를 움직인 것과 똑같이 처리되게 한다.
  number.addEventListener("input", () => {
    const raw = Number(number.value);
    if (!Number.isFinite(raw) || number.value === "") return;
    const value = Math.min(Number(slider.max), Math.max(Number(slider.min), raw / factor));
    slider.value = String(value);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });

  return { slider, number, show };
}

function installSliderRows() {
  // 강조 표시 두께는 1~20에서 고르고 기본값은 5다 (2026-09-04 CM 지시 —
  // PDF.js가 원래 두고 있던 값은 8~24, 2026-09-03에는 5~20이었다).
  // 막대의 범위를 먼저 바꿔 놓아야 옆 숫자칸도 같은 범위로 만들어진다.
  const highlightThickness = document.getElementById("editorFreeHighlightThickness");
  if (highlightThickness) {
    highlightThickness.min = "1";
    highlightThickness.max = "20";
    highlightThickness.value = String(toolState.highlight.thickness);
  }
  unifySliderRow("editorFreeHighlightThickness", "두께 조정", {
    paramName: "HIGHLIGHT_THICKNESS",
    onValue: (v) => {
      toolState.highlight.thickness = v;
      if (settingHighlightDefault) return; // 우리가 처음 값(5)을 넣는 중이면 여기까지다
      highlightThicknessTouched = true;
      // 그려 둔 띠를 골라 둔 상태면 그 띠도 이 두께로 다시 만든다 (dms-shapes.js).
      highlightBandHooks.restyleThickness?.(v);
    },
  });
  unifySliderRow("editorInkThickness", "두께 조정", {
    paramName: "INK_THICKNESS",
    onValue: (v) => { toolState.ink.thickness = v; },
  });
  unifySliderRow("editorInkOpacity", "불투명도 조정", {
    paramName: "INK_OPACITY",
    percent: true,
    onValue: (v) => { toolState.ink.opacity = v; },
  });
  unifySliderRow("dmsInkOpacity", "불투명도 조정", { percent: true });
  unifySliderRow("editorFreeTextFontSize", "크기 조정", {
    paramName: "FREETEXT_SIZE",
    onValue: (v) => { toolState.text.size = v; },
  });
}

// PDF.js가 (이미 그려둔 것을 골랐을 때 등) 색·크기를 바꿔 알려주면 우리 칸도 같이 맞춘다.
function followPdfJsChanges() {
  app.eventBus.on("annotationeditorparamschanged", ({ details }) => {
    for (const [type, value] of details) {
      switch (type) {
        case AnnotationEditorParamsType.HIGHLIGHT_COLOR:
          toolState.highlight.color = value;
          fields.highlight?.setValue(value);
          applyHighlightColorDefault(); // PDF.js가 제 기본색을 알려 온 경우 우리 색으로 되돌린다
          break;
        case AnnotationEditorParamsType.INK_COLOR:
          toolState.ink.color = value;
          fields.ink?.setValue(value);
          applyOriginalViewPenColors(); // 원본 창이면 PDF.js가 알려 온 제 기본색을 우리 색으로 되돌린다
          break;
        case AnnotationEditorParamsType.FREETEXT_COLOR:
          toolState.text.color = value;
          fields.text?.setValue(value);
          applyOriginalViewPenColors();
          break;
        case AnnotationEditorParamsType.FREETEXT_SIZE:
          toolState.text.size = value;
          numbers.editorFreeTextFontSize?.show();
          break;
        case AnnotationEditorParamsType.INK_THICKNESS:
          toolState.ink.thickness = value;
          numbers.editorInkThickness?.show();
          break;
        case AnnotationEditorParamsType.INK_OPACITY:
          toolState.ink.opacity = value;
          numbers.editorInkOpacity?.show();
          break;
        case AnnotationEditorParamsType.HIGHLIGHT_THICKNESS:
          toolState.highlight.thickness = value;
          numbers.editorFreeHighlightThickness?.show();
          applyHighlightThicknessDefault(); // PDF.js가 제 기본값(12)을 알려 온 경우 5로 되돌린다
          break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// ⑤ 글자 배경 칠하기 — 글을 다 적었을 때 그 뒤에 색을 깐다
// ---------------------------------------------------------------------------
//
// PDF 주석 하나에는 색을 하나만 넣을 수 있어서 "글자색"과 "배경색"을 한 주석에 같이 저장할 수
// 없다. 그래서 배경은 형광펜 주석으로 따로 만들어 글자 주석 뒤에 붙인다(dms-link.js).
// 글자를 다 적어야(commit) 몇 줄 몇 칸짜리인지 알 수 있으므로 그때 만든다.

function installTextBackground() {
  const container = document.querySelector("#editorFreeTextParamsToolbar .editorParamsToolbarContainer");
  if (!container) return;

  const box = document.createElement("div");
  box.className = "dmsOptionBox";
  box.innerHTML = `
    <label class="dmsCheckLabel">
      <input type="checkbox" id="dmsTextBackOn" tabindex="0" />
      <span class="editorParamsLabel">글자 배경 칠하기</span>
    </label>
    <div class="dmsOptionBody"></div>`;
  container.append(box);

  const backOn = box.querySelector("#dmsTextBackOn");
  const body = box.querySelector(".dmsOptionBody");
  let backColor = PRESET_COLORS.fill[0];
  fields.textBack = createColorField({
    label: "배경 색상 선택",
    colors: PRESET_COLORS.fill,
    value: backColor,
    onChange: (color) => {
      backColor = color || PRESET_COLORS.fill[0];
      if (backOn.checked) toolState.text.background = backColor;
      applyBackgroundToSelectedTexts(); // 골라 둔 문구가 있으면 그 배경도 함께 바뀐다
    },
  });
  body.append(fields.textBack.element);
  body.hidden = true;

  // 체크를 켜고 끄는 일 — 도구창에서 눌렀을 때와 문구를 골라 값을 맞출 때가 같은 자리를 쓴다.
  setBackOn = (checked) => {
    backOn.checked = checked;
    body.hidden = !checked;
    toolState.text.background = checked ? backColor : null;
  };
  setBackColor = (color) => {
    backColor = color || PRESET_COLORS.fill[0];
    fields.textBack.setValue(backColor);
  };
  backOn.addEventListener("change", () => {
    setBackOn(backOn.checked);
    applyBackgroundToSelectedTexts();
  });
}

// ── 이미 적어 둔 문구를 골라서 배경 칠하기 (2026-09-04 CM 지시) ──────────────
//
// 예전에는 이 값이 "다음에 적을 문구"에만 반영돼서, 이미 적어 둔 문구를 골라 배경 칠하기를
// 켜도 아무 일이 없었고 이미 깔아 둔 배경의 색도 바꿀 수 없었다. 이제 문구를 고르면 도구창이
// 그 문구의 값을 보여주고, 값을 바꾸면 그 문구에 바로 반영된다(도형과 같은 방식).

let setBackOn = null;
let setBackColor = null;
let syncingTextPanel = false;
const selectedTexts = new Set();
const TEXT_BACK_COMMAND_TYPE = 9102;

function syncTextPanelFrom(textEditor) {
  if (!setBackOn) return;
  syncingTextPanel = true;
  try {
    const color = textEditor._dmsBackColor || null;
    if (color) setBackColor(color);
    setBackOn(!!color);
  } catch { /* 값 맞추기가 실패해도 고르기 자체는 그대로 된다 */ } finally {
    syncingTextPanel = false;
  }
}

function applyBackgroundToSelectedTexts() {
  if (syncingTextPanel) return;
  const targets = [...selectedTexts].filter((t) => t.parent);
  if (targets.length === 0) return;
  const color = toolState.text.background;
  for (const textEditor of targets) {
    const before = textEditor._dmsBackColor || null;
    if (before === color) continue;
    editor.uiManager?.addCommands({
      cmd: () => { setTextBackground(textEditor._dmsLayer, textEditor, color); },
      undo: () => { setTextBackground(textEditor._dmsLayer, textEditor, before); },
      mustExec: true,
      type: targets.length === 1 ? TEXT_BACK_COMMAND_TYPE : NaN,
      overwriteIfSameType: targets.length === 1,
      keepUndo: true,
    });
  }
}

let layerPatched = false;

function watchNewEditors() {
  app.eventBus.on("annotationeditorlayerrendered", ({ source }) => {
    const layer = source?.annotationEditorLayer?.annotationEditorLayer;
    if (!layer || layerPatched) return;
    layerPatched = true;
    // 새 주석이 들어올 때를 알아채려고 PDF.js가 쓰는 add를 감싼다(원래 하던 일은 그대로 한다).
    const proto = Object.getPrototypeOf(layer);
    const originalAdd = proto.add;
    proto.add = function (editorToAdd) {
      originalAdd.call(this, editorToAdd);
      if (editorToAdd?.constructor?._editorType === AnnotationEditorType.FREETEXT) {
        watchTextEditor(this, editorToAdd);
      }
      if (originalView && editorToAdd?.constructor?._editorType === AnnotationEditorType.HIGHLIGHT) {
        saveOriginalHighlightAsOnScreen(editorToAdd);
      }
    };
  });
}

function watchTextEditor(layer, textEditor) {
  if (textEditor._dmsWatched) return;
  textEditor._dmsWatched = true;
  textEditor._dmsLayer = layer;
  const originalCommit = textEditor.commit.bind(textEditor);
  textEditor.commit = () => {
    originalCommit();
    // 글자 칸의 크기는 글을 다 적은 바로 다음에 정해지므로 한 박자 뒤에 배경을 만든다.
    // 이미 배경이 깔린 문구를 고쳤으면 그 색을 그대로 다시 깔고, 새 문구면 도구창 값을 쓴다.
    const color = textEditor._dmsBackColor ?? toolState.text.background;
    setTimeout(() => setTextBackground(layer, textEditor, color), 0);
  };
  const originalSelect = textEditor.select.bind(textEditor);
  textEditor.select = () => {
    originalSelect();
    selectedTexts.add(textEditor);
    syncTextPanelFrom(textEditor);
  };
  const originalUnselect = textEditor.unselect.bind(textEditor);
  textEditor.unselect = () => {
    originalUnselect();
    selectedTexts.delete(textEditor);
  };
}

/**
 * 문구 하나의 배경을 지금 색으로 다시 깐다. color가 null이면 배경을 없앤다.
 * 값만 넣으면 언제든 같은 결과가 되므로 되돌리기·다시하기에 그대로 쓸 수 있다.
 */
async function setTextBackground(layer, textEditor, color) {
  if (!textEditor?.parent || textEditor.isEmpty?.()) return;
  textEditor._dmsBackColor = color || null;
  if (!color) {
    clearBackgrounds(textEditor);
    return;
  }

  const pageView = app.pdfViewer.getPageView(textEditor.pageIndex);
  if (!pageView) return;

  const [x1, y1, x2, y2] = textEditor.getRect(0, 0);
  const polygon = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
  const back = await addPolygonFill(pageView, layer || textEditor.parent, polygon, { color, undoable: false });
  // 글을 고쳐 칸 크기가 달라졌으면 예전 배경은 attachBackground가 치우고 새것을 깐다.
  if (back) attachBackground(textEditor, back);
}

// ---------------------------------------------------------------------------
// ⑥ 도구창을 계속 열어 두기 ([도구창 고정])
// ---------------------------------------------------------------------------
//
// PDF.js가 원래 갖고 있던 네 도구창(강조 표시·텍스트·그리기·이미지)은 도구가 켜져 있는 동안
// 계속 열려 있고, 우리가 만든 도형·스탬프 창은 창 밖을 누르면 닫히게 만들어 두었었다.
// 이 둘을 [도구창 고정] 하나로 묶는다 (2026-09-04 CM 지시).
//   고정 켬(기본) : 창 밖을 눌러도 안 닫힌다. 도구 아이콘을 한 번 더 눌러야 닫힌다.
//   고정 끔       : 창 밖을 누르면 창만 닫힌다(도구는 켜진 채라 계속 그릴 수 있고,
//                   아이콘을 다시 누르면 도구가 꺼지지 않고 창만 다시 열린다).
// 도형·스탬프 창은 각자 파일에서 같은 값(dms-state.js의 panelPin)을 보고 똑같이 움직인다.

const PDFJS_PANELS = [
  { box: "editorHighlight", button: "editorHighlightButton", panel: "editorHighlightParamsToolbar" },
  { box: "editorFreeText", button: "editorFreeTextButton", panel: "editorFreeTextParamsToolbar" },
  { box: "editorInk", button: "editorInkButton", panel: "editorInkParamsToolbar" },
  { box: "editorStamp", button: "editorStampButton", panel: "editorStampParamsToolbar" },
];

function showPdfPanel(button, panel, show) {
  panel.classList.toggle("hidden", !show);
  button.setAttribute("aria-expanded", String(show));
}

function installPanelPin() {
  const panels = PDFJS_PANELS
    .map(({ box, button, panel }) => ({
      box: document.getElementById(box),
      button: document.getElementById(button),
      panel: document.getElementById(panel),
    }))
    .filter((p) => p.box && p.button && p.panel);

  for (const { button, panel } of panels) {
    // 도구가 켜져 있으면 아이콘은 창만 열고 닫는다 — 도구는 켜진 채 남는다(2026-09-19 CM 지시.
    // 예전에는 창을 닫으려고 아이콘을 누르면 도구까지 꺼져 [선택]으로 돌아갔다). 도구를 끄려면
    // [선택]·[손 도구]·다른 도구를 누르거나 Esc. PDF.js는 이 버튼을 누르면 도구 자체를 껐다 켜므로
    // 그 전에 우리가 가로챈다(capture).
    button.addEventListener("click", (e) => {
      if (customTool.name) return;         // 도형·스탬프가 그리기 상태를 빌려 쓰는 중이면 그대로 둔다
      if (!button.classList.contains("toggled")) return; // 도구가 꺼져 있으면 PDF.js가 켜게 둔다
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showPdfPanel(button, panel, panel.classList.contains("hidden"));
    }, true);
  }

  // 창 밖을 누르면 창만 닫는다 — 고정이 꺼져 있을 때만.
  document.addEventListener("pointerdown", (e) => {
    if (panelPin.on) return;
    for (const { box, button, panel } of panels) {
      if (panel.classList.contains("hidden")) continue;
      if (box.contains(e.target)) continue; // 그 도구의 아이콘·창 안을 누른 것은 그대로 둔다
      showPdfPanel(button, panel, false);
    }
  }, true);
}

// ---------------------------------------------------------------------------
// 강조 표시 두께의 처음 값을 5로 맞추기 (2026-09-04 CM 지시)
// ---------------------------------------------------------------------------
//
// PDF.js는 강조 표시 두께의 기본값으로 12를 들고 있고, 그 도구를 켜거나 그려 둔 표시를 고를
// 때마다 그 값을 알려 와 도구창 막대를 12로 되돌려 놓는다. 그래서 막대의 처음 값만 5로 적어
// 두는 것으로는 안 되고, PDF.js가 알려 올 때마다 다시 5로 바꿔 줘야 한다. 바꾸는 방법은
// 사용자가 막대를 움직인 것과 똑같이 하는 것이다 — 그래야 PDF.js와 우리 숫자칸이 함께 따라온다.
//
// 다만 두 경우에는 손대지 않는다.
//   ① 사용자가 두께를 한 번이라도 직접 고친 뒤   — 그때부터는 고른 값이 그대로 이어져야 한다
//   ② 그려 둔 표시를 골라 둔 동안               — 그 값은 그 표시의 두께이지 "다음에 그릴" 값이 아니다
let highlightThicknessTouched = false; // 사용자가 두께를 직접 고쳤는지
let settingHighlightDefault = false;   // 지금 바꾸는 것이 우리인지(사용자 조작과 구별하려고)
let highlightColorTouched = false;     // 색도 같은 이유로 따로 기억한다

/**
 * 강조 표시의 처음 색을 우리 색으로 맞춘다 (2026-09-04 CM 지시 — 색상 선택 맨 앞의 노랑과 같게).
 * PDF.js는 제 기본색(연한 노랑)을 들고 있다가 도구를 켤 때마다 그 값을 알려 오므로,
 * 두께와 똑같은 방법으로 그때마다 우리 색으로 바꿔 준다(applyHighlightThicknessDefault 설명 참고).
 * 사용자가 색을 직접 고른 뒤나, 그려 둔 표시를 골라 둔 동안에는 손대지 않는다.
 */
function applyHighlightColorDefault() {
  if (highlightColorTouched || settingHighlightDefault) return;
  if (editor.uiManager?.hasSelection) return;
  const want = PRESET_COLORS.highlight[0];
  if (toolState.highlight.color === want) return;
  settingHighlightDefault = true;
  try {
    toolState.highlight.color = want;
    fields.highlight?.setValue(want);
    setParam("HIGHLIGHT_COLOR", want);
  } finally {
    settingHighlightDefault = false;
  }
}

/**
 * 원본(DWG 등) 미리보기 창의 그리기·텍스트 처음 색을 #f2a900으로 맞춘다 (2026-09-20 CM 지시 —
 * 검은 바탕에서는 검은색·빨간색이 잘 안 보인다). 강조 표시 처음 색(applyHighlightColorDefault)과
 * 같은 방법이다: PDF.js가 도구를 켤 때마다 제 기본색을 알려 오므로 그때마다 되돌리되,
 * 사용자가 색을 직접 고른 뒤나 그려 둔 표시를 골라 둔 동안에는 손대지 않는다.
 */
function applyOriginalViewPenColors({ force = false, panelOnly = false } = {}) {
  if (!originalView || settingPenDefault) return;
  if (editor.uiManager?.hasSelection) return;
  settingPenDefault = true;
  try {
    // force: 도구를 켠 순간 — 우리 칸은 이미 #f2a900이어도 PDF.js 쪽 기본값은 아직 제 색일 수 있다.
    // panelOnly: 뷰어를 막 띄운 때 — 자료가 열리기 전이라 PDF.js에 값을 넘길 자리가 없다(넘기면 오류).
    if (!inkColorTouched && (force || toolState.ink.color !== ORIGINAL_VIEW_PEN_COLOR)) {
      toolState.ink.color = ORIGINAL_VIEW_PEN_COLOR;
      fields.ink?.setValue(ORIGINAL_VIEW_PEN_COLOR);
      if (!panelOnly) setParam("INK_COLOR", ORIGINAL_VIEW_PEN_COLOR);
    }
    if (!textColorTouched && (force || toolState.text.color !== ORIGINAL_VIEW_PEN_COLOR)) {
      toolState.text.color = ORIGINAL_VIEW_PEN_COLOR;
      fields.text?.setValue(ORIGINAL_VIEW_PEN_COLOR);
      if (!panelOnly) setParam("FREETEXT_COLOR", ORIGINAL_VIEW_PEN_COLOR);
    }
  } finally {
    settingPenDefault = false;
  }
}

/**
 * 원본 창의 형광펜을 PDF로 저장할 때도 화면과 같게 — "보통" 겹침 + 반투명(2026-09-20 CM 지시).
 * 저장용 직렬화(serialize(false))에만 적용한다. 보관 목록·복사가 쓰는 복사용(serialize(true))에
 * 넣으면 되살릴 때 진하기가 두 번 곱해져 흐려진다. 도형 채우기(_dmsBlendMarked)는 제 진하기를 쓴다.
 */
function saveOriginalHighlightAsOnScreen(highlightEditor) {
  if (highlightEditor._dmsOriginalHighlight) return;
  highlightEditor._dmsOriginalHighlight = true;
  const original = highlightEditor.serialize.bind(highlightEditor);
  highlightEditor.serialize = (isForCopying = false, ...rest) => {
    const data = original(isForCopying, ...rest);
    if (data && !isForCopying && !highlightEditor._dmsBlendMarked) {
      data.blendMode = "Normal";
      data.opacity = ORIGINAL_HIGHLIGHT_OPACITY;
    }
    return data;
  };
}

function applyHighlightThicknessDefault() {
  if (highlightThicknessTouched) return;
  if (editor.uiManager?.hasSelection) return;
  const slider = document.getElementById("editorFreeHighlightThickness");
  if (!slider || slider.valueAsNumber === HIGHLIGHT_DEFAULT_THICKNESS) return;
  settingHighlightDefault = true;
  try {
    slider.value = String(HIGHLIGHT_DEFAULT_THICKNESS);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  } finally {
    settingHighlightDefault = false;
  }
}

// ---------------------------------------------------------------------------
// ⑧ 표시를 골라도 지금 쓰던 도구가 그대로 유지되게 하기 (2026-09-06 CM 지시)
// ---------------------------------------------------------------------------
//
// PDF.js는 그려 둔 표시를 고를 때(setSelected) 도구모음을 그 표시의 종류로 바꿔 버린다
// (updateToolbar → switchannotationeditormode). 그래서 [선택] 상태에서 도형을 한 번 누르거나,
// [이동]으로 옮기거나, [채움 전환]을 누르면 곧바로 [그리기]가 켜져 마우스가 펜으로 바뀌었다
// (2026-09-06 CM 보고). 고르는 것은 "무엇을 만질지"를 정하는 일이지 도구를 바꾸는 일이
// 아니므로, 고르는 동안에는 그 도구 바꾸기만 건너뛴다 — 마지막으로 고른 도구가 그대로 남는다.
// 고르기 자체와 색칸 맞추기 등 나머지는 예전 그대로 한다.
//
// 두 번 눌러 글을 고치는 경우(dblclick)나 붙여넣기는 그대로 둔다 — 그건 사용자가
// 그 도구로 들어가겠다고 한 것이라 성격이 다르다.
function keepToolWhenSelecting(uiManager) {
  if (!uiManager || uiManager._dmsKeepTool) return;
  uiManager._dmsKeepTool = true;

  const originalSetSelected = uiManager.setSelected.bind(uiManager);
  const originalUpdateToolbar = uiManager.updateToolbar.bind(uiManager);
  let selecting = false;

  uiManager.updateToolbar = (options) => {
    if (selecting) return; // 고르는 중이면 도구를 바꾸지 않는다
    originalUpdateToolbar(options);
  };
  uiManager.setSelected = (editorInstance) => {
    selecting = true;
    try {
      originalSetSelected(editorInstance);
    } finally {
      selecting = false;
    }
  };
}

// 도구가 하나도 안 켜져 있을 때(mode NONE)의 Delete·Ctrl+Z·Ctrl+Y.
//
// PDF.js는 도구가 꺼져 있으면 자판 단축키를 아예 받지 않는다(keydown이 mode NONE이면 그냥 넘어간다).
// 예전에는 표시를 고르는 순간 그리기 도구가 켜져서 그 김에 단축키도 먹었는데, 위에서 도구가
// 안 바뀌게 했으므로 그 셋만 여기서 이어 준다 — [선택]으로 골라 둔 표시를 Delete로 지우고
// Ctrl+Z로 되돌릴 수 있어야 하기 때문이다. 글을 적는 칸(쓰기칸·찾기칸)에서는 손대지 않는다.
function installKeysWithoutTool() {
  window.addEventListener("keydown", (e) => {
    if (currentMode !== AnnotationEditorType.NONE) return; // 도구가 켜져 있으면 PDF.js가 맡는다
    const uiManager = editor.uiManager;
    if (!uiManager) return;
    const target = e.target;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && (e.key === "Delete" || e.key === "Backspace")) {
      if (!uiManager.hasSelection) return;
      uiManager.delete();
      e.preventDefault();
      return;
    }
    if (!ctrl) return;
    const key = String(e.key).toLowerCase();
    if (key === "z" && !e.shiftKey) {
      uiManager.undo();
      e.preventDefault();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      uiManager.redo();
      e.preventDefault();
    }
  }, true);
}

// ---------------------------------------------------------------------------
// ⑨ 스페이스바를 누르고 있는 동안은 손 도구 (2026-09-19 CM 지시)
// ---------------------------------------------------------------------------
//
// 어떤 도구가 켜져 있든 스페이스바를 누르고 있으면 [손 도구]가 켜져 화면을 끌어서 옮길 수 있고,
// 스페이스바에서 손을 떼면 그 전에 쓰던 도구가 그대로 다시 켜진다.
//   · 그리기 도구(강조 표시·텍스트·그리기·이미지) → 편집을 껐다가 같은 편집을 다시 켠다
//   · 도형·스탬프·지우개 → 그 도구 버튼을 눌러 다시 켠다(고른 모양·색 등은 그대로다)
//   · [선택] → 커서 도구만 되돌린다
// 글을 적는 칸(글자 입력·숫자칸·문구 표시의 쓰기칸)에서는 스페이스바가 원래 뜻대로 글자 공백이다.

const SPACE_TOOL_BUTTONS = { shape: "dmsShapeButton", eraser: "dmsEraserButton", stamp: "dmsStampButton" };
let spaceHold = null;          // 누르고 있는 동안 그 전 상태를 적어 둔 것. 안 누르고 있으면 null
let spaceSwallowed = false;    // 누름을 우리가 가져갔는지 — 떼는 쪽도 브라우저가 못 쓰게 막는다
let pointerIsDown = false;

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target?.isContentEditable;
}

function releaseSpaceHand() {
  const hold = spaceHold;
  if (!hold) return;
  spaceHold = null;
  document.getElementById("viewerContainer")?.classList.remove("dmsSpaceHand");
  if (hold.wasHand || hold.userSwitched) return; // 원래 손 도구였거나, 누르는 사이 다른 도구를 골랐으면 그대로 둔다

  // 아직 적용 안 된 "손 도구로 바꾸기"가 남아 있으면 없앤다(빨리 눌렀다 뗀 경우). 그대로 두면
  // 나중에 편집이 꺼질 때 뒤늦게 손 도구가 켜진다.
  pendingCursorTool = null;

  if (!hold.drawing) {
    useCursorTool(hold.cursor); // [선택]으로 돌아간다
    return;
  }

  // 편집 도구는 켜기 전의 커서 도구를 기억해 두었다가 끄면 되돌려 놓는다(PDF.js가 그렇게 한다).
  // 그래서 커서 도구를 원래대로 돌려 놓은 다음에 켜야 손 도구가 그 기억에 들어가지 않는다.
  app.eventBus.dispatch("switchcursortool", { source: null, tool: hold.cursor });
  const customButton = hold.custom ? document.getElementById(SPACE_TOOL_BUTTONS[hold.custom]) : null;
  if (customButton) customButton.click();
  else app.pdfViewer.annotationEditorMode = { mode: hold.mode };
}

function installSpaceHand() {
  const container = document.getElementById("viewerContainer");
  if (!container) return;

  // 마우스 단추를 누르고 있는 중(그리는 중·끄는 중)에 도구를 바꾸면 엉망이 되므로 그때는 받지 않는다.
  window.addEventListener("pointerdown", () => { pointerIsDown = true; }, true);
  window.addEventListener("pointerup", () => { pointerIsDown = false; }, true);
  window.addEventListener("pointercancel", () => { pointerIsDown = false; }, true);

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    // 스페이스바가 화면을 아래로 내리거나 눌러 둔 버튼을 눌러 버리지 않게 막는다.
    e.preventDefault();
    e.stopPropagation();
    spaceSwallowed = true;
    if (e.repeat || spaceHold || pointerIsDown || !app?.pdfDocument) return;

    const drawing = currentMode !== AnnotationEditorType.NONE || !!customTool.name;
    spaceHold = {
      drawing,
      mode: currentMode,
      custom: customTool.name,
      cursor: cursorTool,
      wasHand: !drawing && cursorTool === CURSOR_HAND,
      userSwitched: false,
    };
    container.classList.add("dmsSpaceHand");
    if (!spaceHold.wasHand) useCursorTool(CURSOR_HAND);
  }, true);

  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (spaceSwallowed) {
      spaceSwallowed = false;
      e.preventDefault(); // 브라우저는 스페이스바를 뗄 때 눌러 둔 버튼을 누른 것으로 친다
      e.stopPropagation();
    }
    releaseSpaceHand();
  }, true);

  // 창을 벗어나 키를 떼면 keyup을 못 받으므로, 그때도 원래 도구로 돌려 놓는다.
  window.addEventListener("blur", () => { spaceSwallowed = false; releaseSpaceHand(); });
}

// ---------------------------------------------------------------------------

/**
 * options.rotate : 도구모음에 [회전](그려 둔 표시 돌리기)을 둘지 — dms-viewer.js의 USE_ROTATE_TOOL
 * options.showModeSwitches : [도구창 고정]·[Text 선택]·[Markup 선택]을 보여줄지 — SHOW_MODE_SWITCHES
 * options.showPointerExtras : [회전]·[이동] 버튼을 보여줄지 — SHOW_POINTER_EXTRA_BUTTONS
 */
export function installToolbarExtras(pdfViewerApplication, options = {}) {
  app = pdfViewerApplication;
  originalView = !!options.originalView;
  watchUiManager(app);

  installRotateButtons();
  installCursorTools(!!options.rotate, {
    showModeSwitches: options.showModeSwitches !== false,
    showPointerExtras: options.showPointerExtras !== false,
  });
  renameSaveToDownload();
  installHighlightColors();
  installInkColors();
  installInkLineType();
  installTextColors();
  installSliderRows();
  installTextBackground();
  installPanelPin();
  followPdfJsChanges();
  watchNewEditors();
  applyOriginalViewPenColors({ panelOnly: true }); // 원본 창이면 도구를 켜기 전부터 색 칸이 #f2a900

  // [회전](dms-rotate.js)이 문구를 돌린 뒤 원래 깔려 있던 글자 배경을 새 문구에도 깔 수 있게 한다.
  textBackgroundHooks.colorOf = (textEditor) => textEditor?._dmsBackColor || null;
  textBackgroundHooks.apply = (textEditor, color) =>
    setTextBackground(textEditor._dmsLayer || textEditor.parent, textEditor, color);

  onCustomToolChange(refreshCursorButtons);

  // 표시를 골라도 도구가 바뀌지 않게 한다. 편집 총괄(uiManager)은 자료를 열 때마다 새로
  // 만들어지므로 만들어질 때마다 걸고, 이미 만들어져 있으면 지금 걸어 둔다.
  app.eventBus.on("annotationeditoruimanager", ({ uiManager }) => keepToolWhenSelecting(uiManager));
  keepToolWhenSelecting(editor.uiManager);
  installKeysWithoutTool();
  installSpaceHand();

  app.eventBus.on("cursortoolchanged", ({ tool, disabled }) => {
    // 편집 도구를 켜면 PDF.js가 커서 도구를 잠시 "텍스트 선택"으로 되돌린다(disabled=true).
    // 그건 사용자가 고른 것이 아니므로 기억해 두지 않는다.
    if (!disabled) cursorTool = tool;
    refreshCursorButtons();
  });

  app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
    currentMode = mode;
    // 스페이스바를 누르고 있는 사이에 사용자가 직접 다른 그리기 도구를 골랐으면, 뗐을 때 예전 도구로
    // 되돌리지 않는다(방금 고른 것이 우선이다). 우리가 손 도구로 바꾸는 것은 NONE이라 해당 없다.
    if (spaceHold && mode !== AnnotationEditorType.NONE) spaceHold.userSwitched = true;
    if (mode === AnnotationEditorType.NONE) applyPendingCursorTool();
    if (mode === AnnotationEditorType.HIGHLIGHT) {
      applyHighlightThicknessDefault();
      applyHighlightColorDefault();
    }
    if (mode === AnnotationEditorType.INK || mode === AnnotationEditorType.FREETEXT) {
      applyOriginalViewPenColors({ force: true });
    }
    refreshCursorButtons();
  });
}
