// 도면관리시스템이 덧붙인 "도형" 도구 — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
// 사각형·타원·삼각형·밸브(나비넥타이)·블라인드(동그라미+자루)·직선·화살표와
// 글자 도형(LOTO·CLOSE·OPEN·BLIND)을 끌어서 그린다.
//
// 만드는 방법: 새 주석 종류를 만들지 않고 PDF.js가 원래 갖고 있는 주석을 그대로 쓴다.
//   테두리(선) : "그리기(잉크) 주석"  — 손으로 그린 선과 똑같이 다뤄진다
//   채우기(면) : "형광펜 주석"        — 넓게 칠하는 주석이라 도면이 비쳐 보인다
// 그래서 그린 도형은 눌러서 고르고, 끌어서 옮기고, Delete로 지우고, Ctrl+Z로 되돌리고,
// [저장]하면 PDF 안에 함께 저장된다. PDF.js 안쪽 코드는 한 줄도 고치지 않으므로 나중에
// 새 버전으로 올릴 때도 이 파일들만 그대로 옮기면 된다.
//
// 도형 도구를 켜고 그릴 때 (PPT와 같게 맞춘 것들 — CM 지시)
//   Shift 누르고 그리기 : 정사각형·정원·정삼각형, 직선은 15도 단위(수평·수직)
//   Alt + 좌우 화살표   : 그려둔 도형을 15도씩 회전 (Ctrl까지 같이 누르면 1도씩)
//   Ctrl 누르고 끌기    : 그 도형을 복사해서 옮긴 자리에 하나 더 만든다
//                       (도형만이 아니라 모든 표시에 되므로 하는 일은 dms-copy.js로 옮겼고,
//                        여기서는 "이 도형을 어떻게 다시 만드는지"만 알려준다 — 아래 copyHooks)
//   [회전] 아이콘       : 모든 표시를 돌린다(2026-09-18 CM 지시). 하는 일은 dms-rotate.js에 있고,
//                       여기서는 우리가 만든 표시를 돌린 모습으로 다시 만들어 준다 — 아래 rotateHooks
//   Shift 누르고 크기조절: 가로세로 비율을 지킨 채 커진다(동그라미가 안 찌그러진다 — 2026-09-04)
//
// 도형 도구가 꺼져 있고 [강조 표시]나 [그리기]로 그을 때 (2026-09-02·09-03 CM 지시)
//   Shift          : 수평선·수직선만 (한 선)
//   Ctrl           : 한붓그리기 — 곧은 선을 긋고 나면 다음 선이 그 끝에서 마우스를 따라다닌다.
//                    누를 때마다 그 자리까지 선이 확정되고 다시 그 끝에서 이어진다.
//   Shift + Ctrl   : 같은 한붓그리기인데 수평·수직으로만 꺾인다.
//                    (Shift는 방향만 맞추는 것이라, 긋는 도중에 눌렀다 뗐다 해도 선은 안 끊긴다)
//   이어 긋기는 Ctrl에서 손을 떼거나 Esc를 누르면 끝난다.
//   이렇게 그은 강조 표시는 꺾이는 자리가 곡선이 아니라 딱 직각이다(비스듬한 선도 마찬가지 —
//   2026-09-04 CM 지시. 아래 bandQuads 설명).
//
// 도형을 빼려면 dms-viewer.js의 USE_SHAPE_TOOL을 false로 두면 된다.

import { createColorField, PRESET_COLORS } from "./dms-colors.js";
import { attachBackground, clearBackgrounds } from "./dms-link.js";
import {
  toolState, customTool, registerCustomTool, setCustomTool, clearCustomTool, editor, watchUiManager,
  panelPin, highlightBandHooks, textSelect, shapeToolbarHooks, inkLineTypeHooks, copyHooks, rotateHooks,
} from "./dms-state.js";
import {
  buildShape, toSvgPath, snapEnd, straightSubpath, bandPolygons, unionQuads, applyLineType,
  boundingBox, canFill, TEXT_SHAPES, TOGGLE_SHAPES,
} from "./dms-geometry.js";
import { addEditor, addPolygonFill, highlightBorderInset, hexToRgb } from "./dms-fill.js";

const { AnnotationEditorType, AnnotationEditorParamsType } = globalThis.pdfjsLib;
const SVG_NS = "http://www.w3.org/2000/svg";

const SHAPES = [
  { id: "rect", label: "사각형" },
  { id: "ellipse", label: "타원" },
  { id: "triangle", label: "삼각형" },
  { id: "bowtie", label: "밸브" },
  { id: "blind", label: "블라인드" },
  { id: "spectacle", label: "스펙타클 블라인드" },
  { id: "line", label: "직선" },
  { id: "arrow", label: "화살표" },
  { id: "dim", label: "치수선" },
  { id: "star", label: "별" },
  { id: "burst", label: "폭발" },
  { id: "cloud", label: "구름" },
];

const ROTATE_STEP = 15; // Alt + 화살표로 도는 각도 (PPT와 같다)
const ROTATE_FINE = 1;  // Ctrl + Alt + 화살표로 도는 각도

const state = {
  on: false, shape: "rect", stroke: "#e02020", fill: null, fillOpacity: 0.5, thickness: 2,
  // fill은 "지금 칠할 색"(끄면 null), fillColor는 껐다 켜도 기억하는 "마지막으로 고른 색"이다.
  fillColor: null,
};

// 도구창의 칸들 — 골라 둔 도형을 고칠 때도 여기서 값을 읽고 쓴다 (아래 syncPanelFromShape).
const controls = {};
// 도구창을 골라 둔 도형의 값에 맞추는 중. 이때 값이 바뀌는 것은 사용자가 고친 게 아니므로
// 도형에 되돌려 반영하지 않는다(맞추기 → 반영 → 맞추기가 되풀이되는 것을 막는다).
let syncingPanel = false;

// 크기를 조절할 때 가로세로 비율을 아예 고정해 두는 도형.
// 이 도형은 손잡이 넷(모서리)만 나와 늘 같은 비율로 커지므로 동그라미가 절대 안 찌그러진다.
//
// 블라인드는 2026-09-04 CM 지시로 여기서 빠졌다 — 자루 길이만 늘이는 일이 있어 다른 도형처럼
// 손잡이 여덟으로 자유롭게 늘리게 하고, 대신 **Shift를 누른 채 크기를 조절하면** 비율이
// 지켜져 동그라미가 안 찌그러진다(keepRatioIfShift, PPT와 같다).
const ROUND_SHAPES = new Set(["ellipse"]);

let app = null;
// PDF.js의 편집 총괄 — 자료를 열 때마다 새로 만들어지므로 쓸 때마다 가져온다(dms-state.js).
const uiManager = () => editor.uiManager;
let button = null;
let panel = null;
let drag = null;
let currentMode = AnnotationEditorType.NONE;
let lastShapeId = null;

// 이어 긋는 중일 때의 앞선 선 끝점(한붓그리기 — onChainHoverMove 참고).
// 확대·축소나 스크롤이 바뀌어도 자리가 어긋나지 않도록 PDF 좌표로 담아 둔다.
let chainEnd = null; // { pageIndex, point: [x, y] }

// 그려 놓은 도형들 — 회전·복사할 때 "이게 무슨 모양이고 어떤 네모에서 나왔는지"를 알아야 하므로
// 테두리 주석의 id로 찾아볼 수 있게 기억해 둔다. 화면을 새로 고치면 사라지지만, 그때는 이미
// PDF 주석으로 들어가 있으므로 보이고 옮기고 지우는 데는 지장이 없다(회전·복사만 안 된다).
const shapes = new Map();

// ── 지금 골라 둔 우리 도형들 ─────────────────────────────────────────────────
// 골라 둔 도형의 색·두께·채우기를 도구창에서 고칠 때 쓴다(아래 restyleSelectedShapes).
// 예전에는 도형을 고르면 [도형] 버튼을 눌린 것으로도 표시했는데, 그건 PDF.js가 고르는 순간
// 그리기 상태로 바꿔 버려 [그리기]가 눌린 것처럼 보이던 것을 바로잡으려던 것이다. 이제는
// 골라도 도구가 바뀌지 않으므로(dms-tools.js의 keepToolWhenSelecting) 마지막으로 고른
// 도구가 그대로 눌린 채 남는다 (2026-09-06 CM 지시).
const selectedShapeSet = new Set();

// 한붓그리기(Ctrl로 이어 그은 획)를 만드는 중일 때의 상태.
// 낱개 선을 여러 개 그리면 꺾이는 자리에 이음매·틈이 생기므로, 한 획을 점 목록 하나로 모아
// **주석 하나**로 만든다 — 펜은 폴리라인(잉크), 형광펜은 띠 하나가 되어 모서리가 매끄럽게
// 이어지고, 선택·색·두께·되돌리기도 획 전체에 한 번에 걸린다.
// (형광펜을 낱개 띠로 두던 방식은 2026-09-04 CM 보고 — 모서리가 벌어진다 — 로 폐기했다.)
let chainStroke = null; // { kind:"line"|"band", editor, verts:[PDF 점], pageIndex, style }

// ---------------------------------------------------------------------------
// 도구 모음 UI
// ---------------------------------------------------------------------------

function buildUi() {
  const box = document.createElement("div");
  box.id = "dmsShape";
  box.className = "toolbarButtonWithContainer";
  box.innerHTML = `
    <button id="dmsShapeButton" class="toolbarButton" type="button" tabindex="0"
            disabled="disabled" aria-expanded="false" aria-haspopup="true"
            aria-controls="dmsShapeParamsToolbar" title="도형">
      <span>도형</span>
    </button>
    <div class="editorParamsToolbar hidden doorHangerRight" id="dmsShapeParamsToolbar">
      <div class="editorParamsToolbarContainer dmsShapePanel">
        <div class="dmsShapeChoiceBox">
          <span class="editorParamsLabel">모양 선택</span>
          <div class="dmsShapeChoices">
            ${SHAPES.map((s) => `<button type="button" class="dmsShapeChoice" data-shape="${s.id}" title="${s.label}"><span class="dmsShapeIcon ${s.id}"></span></button>`).join("")}
          </div>
          <div class="dmsShapeChoices dmsShapeWords">
            ${[...TEXT_SHAPES].map((t) => `<button type="button" class="dmsShapeChoice dmsShapeWord" data-shape="${t}" title="${t}">${t}</button>`).join("")}
          </div>
        </div>
        <div class="dmsStrokeColorSlot"></div>
        <div class="editorParamsSetter dmsThicknessSlot"></div>
        <div class="dmsOptionBox">
          <label class="dmsCheckLabel">
            <input type="checkbox" id="dmsShapeFillOn" tabindex="0" />
            <span class="editorParamsLabel">도형 채우기</span>
          </label>
          <div class="dmsOptionBody">
            <div class="dmsFillColorSlot"></div>
            <div class="dmsSliderRow">
              <label for="dmsShapeFillOpacity" class="editorParamsLabel">불투명도 조정</label>
              <input type="range" id="dmsShapeFillOpacity" class="editorParamsSlider"
                     value="50" min="5" max="100" step="5" tabindex="0" />
              <input type="number" id="dmsShapeFillOpacityNumber" class="dmsNumberInput"
                     value="50" min="5" max="100" step="5" tabindex="0" aria-label="불투명도 조정" />
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // 그리기 도구 바로 오른쪽에 둔다 (성격이 가장 가까운 자리).
  document.getElementById("editorInk").after(box);

  button = document.getElementById("dmsShapeButton");
  panel = document.getElementById("dmsShapeParamsToolbar");

  const strokeField = createColorField({
    label: "색상 선택",
    colors: PRESET_COLORS.pen,
    value: state.stroke,
    onChange: (color) => {
      state.stroke = color || "#000000";
      restyleSelectedShapes("stroke"); // 골라 둔 도형이 있으면 그것도 함께 바뀐다
    },
  });
  controls.strokeField = strokeField;
  panel.querySelector(".dmsStrokeColorSlot").append(strokeField.element);

  // 두께 — 다른 도구(강조 표시·그리기)의 두께 칸과 같은 모양으로 맞춘다(dms-tools.js 참고).
  const thickness = panel.querySelector(".dmsThicknessSlot");
  thickness.className = "dmsSliderRow";
  thickness.innerHTML = `
    <label for="dmsShapeThickness" class="editorParamsLabel">두께 조정</label>
    <input type="range" id="dmsShapeThickness" class="editorParamsSlider"
           value="2" min="1" max="20" step="1" tabindex="0" />
    <input type="number" id="dmsShapeThicknessNumber" class="dmsNumberInput"
           value="2" min="1" max="20" step="1" tabindex="0" aria-label="두께 조정" />`;

  // 도형 채우기 — 글자 배경 칠하기와 같은 방식으로, 켜야 색 칸이 나오고 기본은 꺼짐이다
  // (2026-09-02 CM 지시).
  const fillOn = panel.querySelector("#dmsShapeFillOn");
  const fillBody = fillOn.closest(".dmsOptionBox").querySelector(".dmsOptionBody");
  state.fillColor = PRESET_COLORS.fill[0];
  const fillField = createColorField({
    label: "채우기 색상 선택",
    colors: PRESET_COLORS.fill,
    value: state.fillColor,
    onChange: (color) => {
      state.fillColor = color || PRESET_COLORS.fill[0];
      if (fillOn.checked) state.fill = state.fillColor;
      restyleSelectedShapes("fill");
    },
  });
  controls.fillField = fillField;
  controls.fillOn = fillOn;
  panel.querySelector(".dmsFillColorSlot").append(fillField.element);
  fillBody.hidden = true;
  // 체크를 켜고 끄는 일 — 도구창에서 눌렀을 때와 도형을 골라 값을 맞출 때가 같은 자리를 쓴다.
  controls.setFillOn = (checked) => {
    fillOn.checked = checked;
    fillBody.hidden = !checked;
    state.fill = checked ? state.fillColor : null;
  };
  fillOn.addEventListener("change", () => {
    controls.setFillOn(fillOn.checked);
    restyleSelectedShapes("fill");
  });

  // 채우기 불투명도 — 100%면 도면이 안 비치는 완전 불투명이 된다 (2026-09-04 CM 지시).
  // 완전 불투명이 되려면 겹침 방식(mix-blend-mode)도 함께 풀어야 하는데, 그 일은
  // dms-fill.js가 채움 조각에 표시를 달아 dms-tools.css가 한다.
  const fillOpacity = panel.querySelector("#dmsShapeFillOpacity");
  const fillOpacityNumber = panel.querySelector("#dmsShapeFillOpacityNumber");
  const setFillOpacity = (percent) => {
    const value = Math.min(100, Math.max(5, Math.round(Number(percent) || 0)));
    state.fillOpacity = value / 100;
    fillOpacity.value = String(value);
    if (document.activeElement !== fillOpacityNumber) fillOpacityNumber.value = String(value);
  };
  controls.setFillOpacity = setFillOpacity;
  // 막대를 끄는 동안에는 값이 쉼 없이 바뀌므로, 손을 멈춘 뒤에 한 번만 도형에 반영한다
  // (그래야 되돌리기에도 한 번만 쌓인다).
  const onFillOpacity = (value) => { setFillOpacity(value); restyleSelectedShapes("fill", { delay: true }); };
  fillOpacity.addEventListener("input", () => onFillOpacity(fillOpacity.value));
  fillOpacityNumber.addEventListener("input", () => onFillOpacity(fillOpacityNumber.value));

  const slider = document.getElementById("dmsShapeThickness");
  const number = document.getElementById("dmsShapeThicknessNumber");
  const setThickness = (value) => {
    state.thickness = Math.min(20, Math.max(1, Number(value) || 1));
    slider.value = String(state.thickness);
    // 숫자칸에 직접 적는 중이면 건드리지 않는다(dms-tools.js의 같은 이유).
    if (document.activeElement !== number) number.value = String(state.thickness);
  };
  controls.setThickness = setThickness;
  const onThickness = (value) => { setThickness(value); restyleSelectedShapes("thickness"); };
  slider.addEventListener("input", () => onThickness(slider.value));
  number.addEventListener("input", () => onThickness(number.value));

  button.addEventListener("click", () => {
    // 켜져 있으면 아이콘은 창만 열고 닫는다 — 도구는 켜진 채 남는다(2026-09-19 CM 지시).
    // 도구를 끄려면 [선택]·[손 도구]·다른 도구를 누르거나 Esc.
    if (state.on) showPanel(panel.classList.contains("hidden"));
    else activate();
  });

  for (const choice of panel.querySelectorAll(".dmsShapeChoice")) {
    choice.addEventListener("click", () => {
      state.shape = choice.dataset.shape;
      markChosenShape();
    });
  }
  markChosenShape(); // 고른 모양 표시 + [도형 채우기] 잠금 여부

  // 창 밖을 누르면 창만 닫는다(도구는 켜둔 채) — [도구창 고정]이 꺼져 있을 때만이다
  // (2026-09-04 CM 지시. 켜져 있으면 아이콘을 한 번 더 눌러야 닫힌다).
  document.addEventListener("pointerdown", (e) => {
    if (panelPin.on) return;
    if (!state.on || panel.classList.contains("hidden")) return;
    if (e.target.closest("#dmsShape")) return;
    showPanel(false);
  }, true);
}

function markChosenShape() {
  for (const choice of panel.querySelectorAll(".dmsShapeChoice")) {
    choice.classList.toggle("chosen", choice.dataset.shape === state.shape);
  }
  markFillAvailable();
}

// 블라인드·스펙타클 블라인드·밸브를 고르면 [도형 채우기] 칸을 잠근다 (2026-09-04 CM 지시,
// 밸브는 2026-09-18) — 그려 놓은 뒤 옆에 뜨는 [채움 전환]으로 칠했다 비웠다 하기 때문이다.
function markFillAvailable() {
  const box = controls.fillOn?.closest(".dmsOptionBox");
  if (!box) return;
  const locked = TOGGLE_SHAPES.has(state.shape);
  controls.fillOn.disabled = locked;
  box.classList.toggle("dmsOptionLocked", locked);
}

function showPanel(show) {
  panel.classList.toggle("hidden", !show);
  button.setAttribute("aria-expanded", String(show));
}

function activate() {
  // PDF.js의 "그리기" 편집 상태로 들어간다. 편집 상태가 아니면 PDF.js가 주석을 잠가버려서
  // (pointer-events: none) 그려둔 도형을 고르거나 옮기거나 지울 수 없고 Ctrl+Z도 안 먹는다.
  // 손으로 그리는 동작은 우리가 먼저 가로채므로(onPointerDown) 자유 그리기는 일어나지 않고,
  // 그리기 버튼이 눌린 것처럼 보이지 않게 hideInkToolbarLook()으로 정리한다.
  setCustomTool("shape");
  app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.INK };
  state.on = true;
  button.classList.add("toggled");
  document.getElementById("viewerContainer").classList.add("dmsShapeMode");
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
  clearCustomTool("shape");
  state.on = false;
  button.classList.remove("toggled");
  document.getElementById("viewerContainer").classList.remove("dmsShapeMode");
  showPanel(false);
  cancelDrag();
  if (!keepMode) app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
}

// ---------------------------------------------------------------------------
// 끌어서 그리기
// ---------------------------------------------------------------------------

function layerForPageElement(pageEl) {
  return layerForPageIndex(Number(pageEl.dataset.pageNumber) - 1);
}

function layerForPageIndex(pageIndex) {
  const pageView = app.pdfViewer.getPageView(pageIndex);
  const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
  return layer?.div ? { pageView, layer } : null;
}

// 지금 끌기로 무엇을 그릴지 정한다. 도형 도구가 꺼져 있어도 Shift나 Ctrl을 누른 채 펜·형광펜으로
// 그으면 곧은 선이 되도록(CM 지시) 여기서 함께 판단한다.
//   snap "live" = 그리는 순간의 Shift를 보고 정한다 — 누르고 있으면 수평·수직, 아니면 아무 방향
// Ctrl을 누르고 있는 동안은 앞선 선의 끝에서 계속 이어 그어진다(한붓그리기 — chainEnd 참고).
function drawIntent(event) {
  if (customTool.name && customTool.name !== "shape") return null; // 지우개 등 다른 도구가 켜져 있으면 그리지 않는다
  if (state.on) {
    return {
      kind: state.shape,
      stroke: state.stroke,
      fill: canFill(state.shape) ? state.fill : null,
      fillOpacity: state.fillOpacity,
      thickness: state.thickness,
      opacity: 1,
      snap: "step",
      snapOnShift: true,
    };
  }
  if (currentMode === AnnotationEditorType.INK) {
    const ink = toolState.ink;
    const pen = {
      stroke: ink.color, fill: null, thickness: ink.thickness,
      opacity: ink.opacity, lineType: ink.lineType,
    };
    // 아무 키도 안 누르고 손으로 자유롭게 그을 때 — 선 타입이 실선이면 예전처럼 PDF.js에
    // 맡기고, 점선·파선·구름이면 우리가 그린다(PDF.js의 그리기에는 선 모양이라는 값이 없다).
    if (!event.shiftKey && !event.ctrlKey) {
      if (!ink.lineType || ink.lineType === "solid") return null;
      return { ...pen, kind: "free", snap: null, freehand: true, pointGap: FREE_POINT_GAP };
    }
    return { ...pen, kind: "line", snap: "live" };
  }
  if (currentMode === AnnotationEditorType.HIGHLIGHT) {
    // 형광펜은 선이 아니라 넓게 칠하는 주석이라 따로 만든다(아래 addHighlightBand).
    const hl = toolState.highlight;
    const band = {
      kind: "band", stroke: hl.color, fill: null, thickness: hl.thickness, opacity: hl.opacity,
    };
    if (!event.shiftKey && !event.ctrlKey) {
      // 손으로 자유롭게 그을 때 — 지나온 자리를 그대로 칠한다 (2026-09-04 CM 지시).
      // PDF.js에 맡기면 그은 선을 부드러운 곡선으로 다듬어 버려 그린 모양과 달라진다.
      // 다만 [Text 선택]이 켜져 있으면 맡긴다 — 그때는 자료의 글자를 따라 칠하는 것이
      // 이 도구의 일이기 때문이다(D-77 ③).
      if (!textSelect.locked) return null;
      return { ...band, snap: null, freehand: true, pointGap: BAND_POINT_GAP };
    }
    return { ...band, snap: "live" };
  }
  return null;
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
  if (e.button !== 0 || drag) return;
  const pageEl = e.target.closest(".page");
  if (!pageEl) return;

  const found = layerForPageElement(pageEl);
  if (!found) return;

  // Ctrl을 누른 채 그으면 앞선 선이 끝난 자리에서 이어 긋는다(Shift까지 누르면 수평·수직으로만).
  // 이어 긋는 중에는 어디를 눌러 시작하든 그 자리는 쓰이지 않고 앞선 선의 끝에서 이어지므로,
  // 방금 그은 선 위를 다시 눌러도(그게 가장 자연스럽다) 고르지 않고 그대로 이어 긋는다.
  const start = !state.on && e.ctrlKey ? chainStartOn(found.pageView) : null;

  // Ctrl을 누르고 그려둔 표시를 끌면 그것을 복사한다 — 그 일은 dms-copy.js가 맡는다.
  // 여기서는 이어 긋기(start)만 챙기고, 그 밖에 이미 그려둔 표시 위에서 시작한 것은
  // 아래에서 그냥 넘겨준다(PDF.js의 고르기·옮기기, 또는 dms-copy.js의 복사).
  const intent = drawIntent(e);
  if (!intent) return;

  // Ctrl에서 손을 뗐다가 다시 그으면 이어 긋기가 아니므로 앞선 선의 끝점은 잊는다.
  const chaining = !state.on && e.ctrlKey;
  if (!chaining) chainEnd = null;

  if (!start) {
    // 이미 그려둔 주석 위에서 시작했으면 그건 PDF.js에 맡긴다(고르기·옮기기).
    const layerDiv = pageEl.querySelector(".annotationEditorLayer");
    if (!layerDiv || (layerDiv.contains(e.target) && e.target !== layerDiv)) return;
  }

  e.preventDefault();
  e.stopPropagation();

  commitPendingDrawing();

  clearChainHover(); // 따라다니던 미리보기는 지금부터 끌기 미리보기가 대신한다

  const rect = found.layer.div.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  drag = {
    ...found, ...makePreviewSvg(pageEl, rect), rect, chaining,
    style: intent, lineType: intent.lineType,
    x0: start ? start[0] : x, y0: start ? start[1] : y, x1: x, y1: y,
  };
  if (intent?.freehand) drag.freePoints = [[x, y]];
  document.getElementById("viewerContainer").classList.add("dmsShapeDragging");
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  drawPreview(drag, e.shiftKey);
}

// 페이지 위에 겹쳐 그리는 임시 그림판(미리보기용 SVG)을 만든다.
function makePreviewSvg(pageEl, rect) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("dmsShapePreview");
  // 채움은 여럿일 수 있어(스펙타클 블라인드는 동그라미 둘) 묶음으로 두고 그때그때 채운다.
  const fillGroup = document.createElementNS(SVG_NS, "g");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(fillGroup, path); // 채움이 먼저 = 테두리 밑에 깔린다
  pageEl.append(svg);
  placePreviewSvg(svg, pageEl, rect);
  return { svg, path, fillGroup };
}

// 그림판을 주석 자리에 정확히 맞춘다(확대·축소로 크기가 달라졌을 때도 다시 맞춘다).
//
// 페이지 칸(.page)에는 테두리(약 8.8px)가 있고, 그 안쪽이 얹어 놓는 것들의 자리 기준이 된다.
// 테두리 두께를 빼주지 않으면 미리보기가 그만큼 오른쪽·아래로 밀려 그려지고, 마우스를 떼는
// 순간 실제 표시는 제자리에 들어가므로 다 그린 선이 위로 조금 움직이는 것처럼 보였다
// (2026-09-04 CM 보고 — Shift·Ctrl로 그은 선이 다 그리고 나면 조금 움직인다).
function placePreviewSvg(svg, pageEl, rect) {
  const pageRect = pageEl.getBoundingClientRect();
  const pageStyle = getComputedStyle(pageEl);
  const borderLeft = parseFloat(pageStyle.borderLeftWidth) || 0;
  const borderTop = parseFloat(pageStyle.borderTopWidth) || 0;
  svg.style.left = `${rect.left - pageRect.left - borderLeft}px`;
  svg.style.top = `${rect.top - pageRect.top - borderTop}px`;
  svg.style.width = `${rect.width}px`;
  svg.style.height = `${rect.height}px`;
}

// 이어 긋기의 시작점을 지금 화면의 픽셀 자리로 돌려준다(다른 쪽이면 이어 긋지 않는다).
function chainStartOn(pageView) {
  if (!chainEnd || chainEnd.pageIndex !== pageView.id - 1) return null;
  return pageView.viewport.convertToViewportPoint(chainEnd.point[0], chainEnd.point[1]);
}

// 칠하지 않는 자리도 사실은 흰색으로 칠한다 (2026-09-04 CM 지시) —
// 블라인드 동그라미 안으로 도면 선이 비쳐 보이면 무엇을 뜻하는 표시인지 알아보기 어렵기 때문이다.
const WHITE = "#ffffff";

/**
 * 이 도형을 지금 어디에 무슨 색으로 칠할지 정한다 — [{ points, color, opacity }]
 *
 * 블라인드·스펙타클 블라인드·밸브는 [도형 채우기]를 쓰지 않고 칠할 자리마다 정해진 색이 있다
 * (fillState가 0이냐 1이냐로 갈린다). 그 밖의 도형·글자 도형은 예전처럼 [도형 채우기]에서
 * 고른 색으로 안쪽(글자 도형은 네모 전체)을 칠한다.
 */
function fillPlan(info, built) {
  if (TOGGLE_SHAPES.has(info.kind)) {
    const regions = built.regions || [];
    const on = info.fillState ? 1 : 0;
    return regions.map((points, index) => ({
      points,
      // 칠할 자리가 하나뿐인 블라인드·밸브는 "전환 = 칠함", 둘인 스펙타클은 위·아래가 번갈아 칠해진다.
      color: (regions.length === 1 ? on === 1 : index === on) ? info.stroke : WHITE,
      opacity: 1,
    }));
  }
  if (info.fill && built.outline) {
    return [{ points: built.outline, color: info.fill, opacity: info.fillOpacity ?? 1 }];
  }
  return [];
}

/** 미리보기 묶음에 채움 조각들을 그린다(칸이 모자라거나 남으면 그만큼 만들고 지운다) */
function paintPreviewFills(group, items) {
  while (group.childNodes.length > items.length) group.lastChild.remove();
  while (group.childNodes.length < items.length) {
    const piece = document.createElementNS(SVG_NS, "path");
    piece.setAttribute("stroke", "none");
    group.append(piece);
  }
  items.forEach((item, index) => {
    const piece = group.childNodes[index];
    piece.setAttribute("d", `${polygonPath(item.points)}Z`);
    piece.setAttribute("fill", item.color);
    piece.setAttribute("fill-opacity", String(item.opacity ?? 1));
  });
}

// target은 지금 끌고 있는 것(drag)이거나, 이어 긋기로 마우스를 따라다니는 것(chainHover)이다.
function drawPreview(target, shiftKey) {
  const { style } = target;
  const scale = target.pageView.viewport.scale;

  if (target.freePoints) {
    // 손으로 자유롭게 긋는 중 — 지나온 자리를 그대로 이어 그린다(반듯하게 맞추지 않는다).
    const pts = target.freePoints;
    target.preview = {
      box: null,
      built: { subpaths: pts.length > 1 ? [straightSubpath(pts)] : [], outline: null },
    };
  } else {
    const kind = style.kind === "band" ? "line" : style.kind;
    // 도형 도구는 Shift를 눌렀을 때만 반듯하게 맞추고(정도형·15도), 펜·형광펜의 곧은 선은
    // 그리는 순간의 Shift를 보고 수평·수직(axis)이냐 아무 방향이냐(free)를 정한다.
    let useSnap = style.snap;
    if (useSnap === "live") useSnap = shiftKey ? "axis" : "free";
    else if (style.snapOnShift && !shiftKey) useSnap = null;
    const [ex, ey] = useSnap && useSnap !== "free"
      ? snapEnd(kind, target.x0, target.y0, target.x1, target.y1, useSnap)
      : [target.x1, target.y1];
    const box = { x0: target.x0, y0: target.y0, x1: ex, y1: ey };
    target.preview = { box, built: buildShape(kind, box, style.thickness * scale, 0) };
  }

  const { built } = target.preview;
  const isBand = style.kind === "band";
  const stroke = style.stroke;
  // 미리보기도 실제로 그려질 선 타입(점선·파선·구름) 그대로 보여준다.
  const shown = applyLineType(built.subpaths, target.lineType, style.thickness * scale);
  target.path.setAttribute("d", toSvgPath(shown));
  target.path.setAttribute("stroke", stroke);
  target.path.setAttribute("stroke-width", String(style.thickness * scale));
  // 형광펜은 끄는 동안 살짝 연하게 보여준다 — 다 그리면 제 색으로 진해지는데, 그 차이가 너무
  // 크면 눈에 거슬린다고 해서 0.4에서 0.8로 올렸다 (2026-09-04 CM 지시).
  target.path.setAttribute("stroke-opacity", String(isBand ? BAND_PREVIEW_OPACITY : style.opacity ?? 1));
  // 미리보기도 실제로 칠해질 자리·색·진하기와 같게 보여준다.
  const previewInfo = {
    kind: style.kind, stroke: style.stroke, fill: style.fill,
    fillOpacity: style.fillOpacity, fillState: 0,
  };
  paintPreviewFills(target.fillGroup, fillPlan(previewInfo, built));
}

// ---------------------------------------------------------------------------
// 이어 긋기(한붓그리기) — Ctrl을 누르고 있는 동안 다음 선이 마우스를 따라다닌다
// ---------------------------------------------------------------------------
//
// 앞선 선이 끝난 자리(chainEnd)에서 지금 마우스까지를 미리 그려 보여주고, 그 자리를 누르면
// 그 선이 확정되고 다시 그 끝에서 이어진다. 한 붓으로 긋는 것과 같은 느낌이 되도록 한 것이다
// (2026-09-03 CM 지시 — 마우스를 뗀 뒤에도 선이 이어지는 것이 눈에 보여야 한다).

let chainHover = null;

function clearChainHover() {
  chainHover?.svg.remove();
  chainHover = null;
}

/** 이어 긋기를 끝낸다 — 따라다니던 미리보기를 치우고 시작점도 잊는다 */
function endChaining() {
  chainEnd = null;
  clearChainHover();
  finalizeChainStroke(); // 한붓그리기 한 획을 되돌리기 한 번 단위로 확정한다
}

function onChainHoverMove(e) {
  if (drag || !chainEnd) return;
  if (state.on || !e.ctrlKey) { endChaining(); return; } // Ctrl에서 손을 떼면 이어 긋기 끝

  // 마우스 밑에 있는 쪽을 찾는다(미리보기 그림판은 마우스를 받지 않으므로 걸리지 않는다).
  const under = e.target?.closest ? e.target : document.elementFromPoint(e.clientX, e.clientY);
  const pageEl = under?.closest?.(".page");
  const found = pageEl ? layerForPageElement(pageEl) : null;
  const start = found ? chainStartOn(found.pageView) : null;
  const intent = start ? drawIntent(e) : null;
  if (!intent) { clearChainHover(); return; } // 시작점이 있는 쪽을 벗어나면 잠깐 감춘다

  const rect = found.layer.div.getBoundingClientRect();
  if (!chainHover || chainHover.pageEl !== pageEl) {
    clearChainHover();
    chainHover = { pageEl, ...makePreviewSvg(pageEl, rect) };
  } else {
    placePreviewSvg(chainHover.svg, pageEl, rect);
  }
  Object.assign(chainHover, {
    pageView: found.pageView, layer: found.layer, rect, style: intent,
    x0: start[0], y0: start[1], x1: e.clientX - rect.left, y1: e.clientY - rect.top,
  });
  drawPreview(chainHover, e.shiftKey);
}

function polygonPath(points) {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join("");
}

// 자유 선의 자리를 모을 때 이만큼은 움직여야 한 점으로 친다(픽셀). 너무 촘촘하면 무거워진다.
const FREE_POINT_GAP = 2;
// 형광펜 띠는 폭이 넓어서(두께 5~20) 이 정도 간격은 눈에 띄지 않는다. 점이 적을수록
// 띠를 네모로 만드는 계산(bandQuads)이 가벼워진다.
const BAND_POINT_GAP = 4;
// 형광펜을 끄는 동안 미리 보여줄 때의 진하기 (1이면 다 그린 것과 똑같이 보인다)
const BAND_PREVIEW_OPACITY = 0.8;

function onPointerMove(e) {
  if (!drag) return;
  drag.x1 = e.clientX - drag.rect.left;
  drag.y1 = e.clientY - drag.rect.top;
  if (drag.freePoints) {
    const last = drag.freePoints[drag.freePoints.length - 1];
    const gap = drag.style?.pointGap || FREE_POINT_GAP;
    if (Math.hypot(drag.x1 - last[0], drag.y1 - last[1]) >= gap) {
      drag.freePoints.push([drag.x1, drag.y1]);
    }
  }
  drawPreview(drag, e.shiftKey);
}

async function onPointerUp(e) {
  if (!drag) return;
  const target = drag;
  // 자유 선은 시작점으로 되돌아와 끝날 수 있으므로(동그라미) 지나온 자리로 따진다.
  const moved = target.freePoints
    ? target.freePoints.length > 1
    : Math.hypot(target.x1 - target.x0, target.y1 - target.y0) >= 5;
  cancelDrag();
  if (!moved) return; // 그냥 클릭한 것은 도형으로 치지 않는다

  const { pageView, layer, style, preview, chaining } = target;

  // 먼저 이번 선을 그린다 — 한붓그리기(Ctrl로 잇는 선)는 앞선 선에 이어 붙여 한 주석으로 만든다.
  if (target.freePoints && style.kind === "band") {
    // 손으로 그은 형광펜 — 지나온 자리를 그대로 띠로 만든다(곡선으로 다듬지 않는다).
    const traced = target.freePoints.map((p) => pageView.viewport.convertToPdfPoint(p[0], p[1]));
    await addHighlightBand(pageView, layer, traced, style);
  } else if (target.freePoints) {
    await addFreeStroke(pageView, layer, target.freePoints, style);
  } else if (chaining) {
    await appendChainSegment(pageView, layer, preview.box, style);
  } else if (style.kind === "band") {
    await addHighlightBand(pageView, layer, preview.box, style);
  } else {
    await createShape({
      pageView, layer, kind: style.kind, box: preview.box, angle: 0,
      stroke: style.stroke, fill: style.fill, fillOpacity: style.fillOpacity,
      thickness: style.thickness, opacity: style.opacity ?? 1, lineType: style.lineType,
    });
  }

  // 선을 그린 다음 이어 긋기를 계속할지·끝낼지 정한다. (선을 먼저 그려야 마지막 선이 한붓그리기에서
  // 떨어져 나오지 않는다.) Ctrl에서 손을 뗐으면 한붓그리기 전체를 되돌리기 한 번 단위로 확정한다.
  if (chaining && e?.ctrlKey) {
    const [ex, ey] = pageView.viewport.convertToPdfPoint(preview.box.x1, preview.box.y1);
    chainEnd = { pageIndex: pageView.id - 1, point: [ex, ey] };
  } else if (chaining) {
    endChaining();
  }
}

/**
 * 펜으로 긋던 획을 곧 마무리시킨다(우리가 그리는 중이거나 다른 도구가 켜져 있으면 안 한다).
 * PDF.js가 손 뗀 것을 먼저 처리해야 하므로 한 박자 뒤에 부른다.
 */
function finishPenStrokeSoon() {
  if (drag || state.on || customTool.name) return;
  if (currentMode !== AnnotationEditorType.INK) return;
  setTimeout(() => {
    if (drag || state.on || customTool.name) return;
    if (currentMode !== AnnotationEditorType.INK) return;
    commitPendingDrawing();
  }, 0);
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
// 그린 것을 실제 주석으로 만들어 넣기
// ---------------------------------------------------------------------------

/**
 * 테두리(선)를 "그리기(잉크) 주석"으로 만든다.
 *   undoable=false : 되돌리기에 따로 쌓지 않는다 (한붓그리기의 중간 다시그리기)
 *   pdfCoords=true : 넘긴 좌표가 이미 PDF 좌표다 (화면 픽셀이면 여기서 바꿔 준다)
 */
async function addInkEditor(pageView, layer, subpaths, { color, thickness, opacity },
                            { undoable = true, pdfCoords = false, bboxExtra = null } = {}) {
  const { viewport } = pageView;
  const toPdf = pdfCoords ? (p) => p : ([x, y]) => viewport.convertToPdfPoint(x, y);

  const lines = [];
  const points = [];
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const sub of subpaths) {
    const line = [NaN, NaN, NaN, NaN, ...toPdf(sub.start)];
    for (const g of sub.segs) {
      line.push(...toPdf([g[0], g[1]]), ...toPdf([g[2], g[3]]), ...toPdf([g[4], g[5]]));
    }
    lines.push(new Float32Array(line));

    const flat = [];
    for (const p of sub.points) {
      const [px, py] = toPdf(p);
      flat.push(px, py);
      bbox[0] = Math.min(bbox[0], px);
      bbox[1] = Math.min(bbox[1], py);
      bbox[2] = Math.max(bbox[2], px);
      bbox[3] = Math.max(bbox[3], py);
    }
    points.push(new Float32Array(flat));
  }

  // 그리지는 않지만 테두리 자리(선택 상자)에 넣고 싶은 점들 — 글자 도형이 칠한 네모를
  // 선택 상자와 똑같이 맞출 때 쓴다 (2026-09-05 CM 지시).
  for (const p of bboxExtra || []) {
    const [px, py] = toPdf(p);
    bbox[0] = Math.min(bbox[0], px);
    bbox[1] = Math.min(bbox[1], py);
    bbox[2] = Math.max(bbox[2], px);
    bbox[3] = Math.max(bbox[3], py);
  }

  const inkEditor = await layer.deserialize({
    annotationType: AnnotationEditorType.INK,
    color: hexToRgb(color),
    thickness,
    opacity,
    paths: { lines, points },
    boxes: null,
    pageIndex: pageView.id - 1,
    rect: bbox,
    rotation: 0,
  });
  if (!inkEditor) return null;
  if (undoable) {
    layer.add(inkEditor);
    return inkEditor;
  }
  // 중간 단계는 되돌리기에 쌓지 않는다 — 획을 끝낼 때 finalizeChainStroke가 한 번만 등록한다.
  inkEditor.onceAdded = () => {};
  const origUndoable = layer.addUndoableEditor;
  layer.addUndoableEditor = () => {};
  try {
    layer.add(inkEditor);
  } finally {
    layer.addUndoableEditor = origUndoable;
  }
  // onceAdded를 비웠으므로 PDF.js가 거기서 해 주던 "끌어서 옮길 수 있음" 표시도 우리가 해 준다
  // (안 하면 한붓그리기로 그은 선만 옮길 수 없다 — 2026-09-04 확인).
  inkEditor._isDraggable = true;
  return inkEditor;
}

/**
 * 손으로 자유롭게 그은 선을 고른 선 타입(점선·파선·구름) 모양으로 만들어 넣는다
 * (2026-09-04 CM 지시). 선 타입이 실선일 때는 여기까지 오지 않고 PDF.js가 그대로 그린다.
 */
async function addFreeStroke(pageView, layer, points, style) {
  if (points.length < 2) return null;
  const scale = pageView.viewport.scale;
  const subpaths = applyLineType([straightSubpath(points)], style.lineType, style.thickness * scale);
  const strokeEditor = await addInkEditor(pageView, layer, subpaths, {
    color: style.stroke, thickness: style.thickness, opacity: style.opacity ?? 1,
  });
  // 선 타입을 입히기 전의 자리를 적어 둔다 — 나중에 다른 모양으로 다시 그릴 때 쓴다.
  const toPdf = ([x, y]) => pageView.viewport.convertToPdfPoint(x, y);
  rememberInk(strokeEditor, pageView.id - 1, [points.map(toPdf)], style.lineType);
  strokeEditor?.div?.focus({ preventScroll: true });
  return strokeEditor;
}

/**
 * 형광펜으로 그은 곧은 선 — 한 획이 띠 하나가 된다.
 * 만든 뒤에도 두께를 바꿀 수 있도록 그릴 때 쓴 점 목록을 기억해 둔다(rememberBand).
 * 점이 셋 이상이면 한붓그리기 한 획 전체가 되고, 꺾이는 자리는 곡선이 아니라 딱 직각이다
 * (2026-09-04 CM 지시 — 아래 bandQuads 설명. 낱개 띠를 이어 붙이던 예전 방식은 그 자리가
 * 벌어졌고, PDF.js에 점 목록으로 맡기면 그 자리가 둥글게 다듬어졌다).
 * undoable=false면 되돌리기에 쌓지 않는다 — 이어 긋는 도중의 다시그리기가 그렇다.
 */
async function addHighlightBand(pageView, layer, pointsOrBox, style, undoable = true) {
  const toPdf = ([x, y]) => pageView.viewport.convertToPdfPoint(x, y);
  const corners = Array.isArray(pointsOrBox)
    ? pointsOrBox
    : [toPdf([pointsOrBox.x0, pointsOrBox.y0]), toPdf([pointsOrBox.x1, pointsOrBox.y1])];

  const quads = bandQuads(pageView, corners, style.thickness / 2);
  if (quads.length === 0) return null;

  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < quads.length; i += 8) {
    bbox[0] = Math.min(bbox[0], quads[i]);
    bbox[1] = Math.min(bbox[1], quads[i + 5]);
    bbox[2] = Math.max(bbox[2], quads[i + 2]);
    bbox[3] = Math.max(bbox[3], quads[i + 1]);
  }

  // 만드는 것은 언제나 되돌리기에 안 쌓이게 하고(false), 되돌리기 등록은 아래에서 우리가 한다.
  // PDF.js가 등록해 주는 것은 그 순간의 주석을 직접 가리켜서, 나중에 두께를 고쳐 새 주석으로
  // 갈아 끼우면 되돌리기가 없어진 주석을 가리키게 되기 때문이다(registerBandCreation 참고).
  const bandEditor = await addEditor(layer, {
    annotationType: AnnotationEditorType.HIGHLIGHT,
    color: hexToRgb(style.stroke),
    opacity: style.opacity ?? 1,
    thickness: style.thickness,
    quadPoints: quads,
    rect: bbox,
    pageIndex: pageView.id - 1,
    rotation: 0,
  }, false);
  if (bandEditor) {
    keepThicknessSliderEnabled(bandEditor);
    makeBandLikeShape(bandEditor);
    const info = rememberBand(bandEditor, pageView.id - 1, corners, style);
    if (undoable) registerBandCreation(info);
    bandEditor.div?.focus({ preventScroll: true });
    // 다 그리면 곧바로 골라 둔다 — 그래야 [이동]·[휴지통]이 바로 보인다 (2026-09-05 CM 지시).
    if (undoable) uiManager()?.setSelected(bandEditor);
  }
  return bandEditor;
}

// 비스듬한 획을 가로로 썰 때의 간격(PDF 단위). 가장자리가 이 값의 절반 이상 어긋나지 않는다.
// 잘게 썰수록 매끈하지만 네모 수가 늘어나므로, 길게 그은 획은 아래 MAX_BAND_ROWS로 제한한다.
const BAND_ROW_STEP = 0.5;
const MAX_BAND_ROWS = 1200;

/**
 * 획(PDF 좌표 점 목록)을 겹치지 않는 네모 목록(QuadPoints)으로 만든다.
 *
 * 가로·세로로만 이뤄진 획은 자를 자리가 몇 군데뿐이라 네모 두세 개로 정확히 떨어지고,
 * 비스듬한 선이 섞이면 잘게 썰어 만든다(가장자리 어긋남은 BAND_ROW_STEP의 절반 이하).
 */
function bandQuads(pageView, points, half) {
  const inset = highlightBorderInset(pageView);
  const polys = bandPolygons(points, half, inset.x, inset.y);
  if (polys.length === 0) return [];

  let step = 0; // 0 = 다각형의 y 좌표에서만 자른다(가로·세로만 있는 획은 이게 정확하다)
  if (!isAxisAligned(points)) {
    const ys = polys.flat().map((p) => p[1]);
    const height = Math.max(...ys) - Math.min(...ys);
    step = Math.max(BAND_ROW_STEP, height / MAX_BAND_ROWS);
  }
  return unionQuads(polys, step);
}

// 수직·수평으로만 이뤄진 획인지 본다. Shift로 맞춘 선은 화면 좌표에서 정확히 수평·수직이고
// PDF 좌표로 바꿔도 그대로라(쪽이 돌아가 있으면 가로세로가 서로 바뀔 뿐이다), 아주 작은
// 어긋남만 눈감아 주면 된다. 맞으면 자를 자리를 몇 군데로 줄여 네모 두세 개로 끝낼 수 있다.
const AXIS_EPS = 0.05; // PDF 단위

function isAxisAligned(points) {
  let segments = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i][0] - points[i - 1][0]);
    const dy = Math.abs(points[i][1] - points[i - 1][1]);
    if (dx <= AXIS_EPS && dy <= AXIS_EPS) continue; // 같은 자리에 찍힌 점은 선이 아니다
    if (dx > AXIS_EPS && dy > AXIS_EPS) return false; // 비스듬한 선이 하나라도 있으면 아니다
    segments++;
  }
  return segments > 0;
}

/**
 * 형광펜 띠를 도형과 같이 다룬다 (2026-09-05 CM 지시).
 *   ① 끌어서 옮길 수 있게 한다 — PDF.js는 형광펜을 못 옮기게 막아 두는데(_isDraggable=false),
 *      그러면 표시 옆 도구모음에 [이동] 버튼이 안 생긴다.
 *   ② 그 도구모음을 **오른쪽 아래**에 띄운다 — PDF.js는 형광펜만 칠한 자리 끝에 붙이는데,
 *      도형·선과 자리가 달라 눈에 잘 안 띈다. 자리를 안 정해 주면(null) 도형과 같은 자리에 뜬다.
 */
function makeBandLikeShape(bandEditor) {
  bandEditor._isDraggable = true;
  try {
    Object.defineProperty(bandEditor, "toolbarPosition", { configurable: true, get: () => null });
  } catch {
    /* 자리 지정이 안 되면 PDF.js가 정한 자리에 그대로 뜬다 — 버튼은 어차피 나온다 */
  }
}

/**
 * 띠를 끌어 옮길 때 파란 선택틀·저장될 자리·점 목록도 함께 옮긴다 (2026-09-07 CM 지시).
 *
 * PDF.js는 형광펜을 못 옮기는 것으로 보고 만들어져 있어(makeBandLikeShape ①), 옮기면 칠한
 * 그림만 따라오고 아래 셋은 처음 자리에 그대로 남는다.
 *   ㉠ 파란 선택틀 — 칠한 그림과 따로 그려지는 그림이라(_focusDrawId) 옮길 때 다시 그리지
 *      않는다. 그래서 칠은 따라왔는데 틀만 처음 자리에 남아 있었다(2026-09-07 CM 캡쳐 보고).
 *   ㉡ 저장될 자리(QuadPoints) — 만들 때 잡아 둔 자리를 그대로 내보낸다. 눈에 보이는 그림은
 *      다른 값으로 저장돼 옮긴 자리에 나오지만, 이 값이 어긋난 채로 남으면 그 값을 보고 다시
 *      그리는 프로그램에서 처음 자리에 칠해질 수 있다.
 *   ㉢ 그 획을 그릴 때 쓴 점 목록·칠한 자리 — 두께를 바꾸거나(rebuildBandNow) 지웠다 되살리면
 *      (rebuild) 이 값으로 다시 만드는데, 옮긴 것이 안 들어 있으면 처음 자리로 되돌아간다.
 *
 * 셋 다 "만들 때 잡아 둔 자리"를 쓰므로, 처음 자리를 적어 두었다가 지금까지 옮긴 만큼을
 * 그때그때 더해 준다. 옮긴 만큼은 언제나 처음 자리와 견주어 다시 재므로(더해 나가지 않으므로)
 * 되돌리기·다시하기로 자리가 오갈 때도 어긋나지 않는다.
 */
function followBandWhenMoved(bandEditor) {
  const outline = bandEditor._drawOutlines;
  const focusBox = outline?.focusOutline?.box;
  const mainBox = outline?.box;
  if (!focusBox || !mainBox || bandEditor._dmsBandFollow) return;
  bandEditor._dmsBandFollow = true;

  const key = bandKey(bandEditor);
  const startX = bandEditor.x;
  const startY = bandEditor.y;
  const baseFocusBox = focusBox.slice();
  const baseMainBox = mainBox.slice();
  const basePoints = (bands.get(key)?.points || []).map(([x, y]) => [x, y]);

  const sync = () => {
    const [dx, dy] = movedInDrawSpace(bandEditor, startX, startY);
    // ㉠ 파란 선택틀 — 그림 자리를 옮긴 만큼 밀고 다시 그린다
    focusBox[0] = baseFocusBox[0] + dx;
    focusBox[1] = baseFocusBox[1] + dy;
    const drawLayer = bandEditor.parent?.drawLayer;
    if (drawLayer && bandEditor._focusDrawId != null) {
      const angle = (bandEditor.parentRotation - bandEditor._drawRotation + 360) % 360;
      drawLayer.updateProperties(bandEditor._focusDrawId, outline.getFocusSVGProperties(angle));
    }
    // ㉢ 칠한 자리와 점 목록 — 다시 만들 때 쓰는 값이라 같이 밀어 둔다
    mainBox[0] = baseMainBox[0] + dx;
    mainBox[1] = baseMainBox[1] + dy;
    const info = bands.get(key);
    if (info && basePoints.length) {
      const [px, py] = shiftInPdf([dx, dy], bandEditor.pageDimensions);
      info.points = basePoints.map(([x, y]) => [x + px, y + py]);
    }
  };

  // ㉡ 저장될 자리 — 만들 때 잡아 둔 값에 옮긴 만큼을 더해 내보낸다
  const origQuads = outline.serializeQuadPoints.bind(outline);
  outline.serializeQuadPoints = (pageTranslation, pageDimensions) => {
    const quads = origQuads(pageTranslation, pageDimensions);
    const [px, py] = shiftInPdf(movedInDrawSpace(bandEditor, startX, startY), pageDimensions);
    if (quads && (px || py)) {
      for (let i = 0; i < quads.length; i += 2) {
        quads[i] += px;
        quads[i + 1] += py;
      }
    }
    return quads;
  };

  runAfter(bandEditor, "_onTranslating", sync); // 끄는 동안
  runAfter(bandEditor, "_onTranslated", sync);  // 손을 뗐을 때·되돌렸을 때
}

/**
 * 옮긴 만큼을 "그림 자리"(쪽 크기를 1로 본 값) 기준으로 잰다.
 * 표시가 놓인 자리(x·y)는 쪽이 돌아가 있으면 그림 자리와 가로세로가 뒤바뀌므로 되돌려 준다.
 */
function movedInDrawSpace(editor, startX, startY) {
  const dx = editor.x - startX;
  const dy = editor.y - startY;
  switch (editor._drawRotation) {
    case 90: return [-dy, dx];
    case 180: return [-dx, -dy];
    case 270: return [dy, -dx];
    default: return [dx, dy];
  }
}

/** 그림 자리로 잰 것을 자료(PDF) 자리 단위로 바꾼다 — 세로는 위아래가 뒤집혀 있다 */
function shiftInPdf([dx, dy], [pageWidth, pageHeight]) {
  return [dx * pageWidth, -dy * pageHeight];
}

/** 원래 하던 일을 그대로 한 뒤에 우리 일을 덧붙인다 */
function runAfter(obj, name, after) {
  const orig = obj[name].bind(obj);
  obj[name] = (...args) => {
    const result = orig(...args);
    try {
      after();
    } catch (err) {
      console.warn(`[dms] band follow (${name}) failed:`, err);
    }
    return result;
  };
}

/**
 * 네모로 만든 띠를 골랐을 때도 도구창의 [두께 조정] 막대를 계속 쓸 수 있게 한다.
 *
 * PDF.js는 이 띠를 "글자 위에 칠한 형광펜"과 같은 종류로 보아 그것이 골라져 있는 동안
 * 두께 막대를 회색으로 잠근다. 그러면 방금 그은 것이 골라진 채로 남는 사이 다음에 그을
 * 두께를 정할 수 없다(2026-09-02에 색으로 겪은 것과 같은 상황 — dms-tools.js의 setParam 설명).
 * 그래서 이 띠에 한해 "자유롭게 그은 형광펜"이라고 알려 막대를 살려 둔다.
 * 이 띠를 골라 둔 채 막대를 움직이면 그 띠도 새 두께로 다시 만들어진다
 * (2026-09-04 CM 지시 — 아래 "그려 둔 강조 표시 띠의 두께를 나중에 바꾸기" 참고).
 */
function keepThicknessSliderEnabled(editor) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "propertiesToUpdate");
  if (!desc?.get) return;
  Object.defineProperty(editor, "propertiesToUpdate", {
    configurable: true,
    get() {
      return desc.get.call(this).map(([type, value]) => (
        type === AnnotationEditorParamsType.HIGHLIGHT_FREE ? [type, true] : [type, value]
      ));
    },
  });
}

// ---------------------------------------------------------------------------
// 그려 둔 강조 표시 띠의 두께를 나중에 바꾸기 (2026-09-04 CM 지시)
// ---------------------------------------------------------------------------
//
// 우리가 만드는 직각 띠는 "글자 위에 칠한 형광펜"과 같은 종류(네모를 이어 붙인 면)라,
// PDF.js가 두께 값을 갖고만 있을 뿐 그 값으로 모양을 다시 그리지는 않는다. 그래서 두께를
// 바꿔도 저장 값만 바뀌고 화면은 그대로였다(2026-09-04 오전까지의 한계 — 그때는 "두께는
// 긋기 전에 정한다"고 안내했다).
//
// 이제 그 획을 그릴 때 쓴 점 목록을 기억해 두었다가, 두께를 바꾸면 그 점 목록으로 새 두께의
// 띠를 다시 만들어 갈아 끼운다(도형의 색·채움을 나중에 고치는 것과 같은 방식).
//   · 색은 PDF.js가 그 자리에서 바꿔 주므로 손대지 않고, 다시 만들 때 지금 색을 읽어 이어받는다.
//   · 이 띠는 옮기거나 크기를 바꿀 수 없는 종류다(PDF.js가 손잡이를 안 만든다). 그래서 다시
//     만들 때 자리를 보정할 일이 없다.
//   · 화면을 새로 고치면 점 목록이 사라지므로 그 뒤로는 두께를 못 바꾼다 — 도형의 회전·채움과
//     같은 한계다(어차피 새로고침하면 저장하지 않은 표시 자체가 사라진다).

const bands = new Map();           // 띠 편집기 → 그 띠를 만든 점 목록·모양
const selectedBandSet = new Set(); // 지금 골라 둔 우리 띠
const BAND_THICKNESS_COMMAND_TYPE = 9103; // 되돌리기 목록에서 같은 종류끼리 묶을 때 쓰는 번호
const BAND_RESTYLE_DELAY = 80;     // 막대를 끄는 동안 너무 자주 다시 만들지 않도록 잠깐 기다린다
let bandThicknessTimer = null;
let bandThicknessNewGroup = true;  // 이번 변경을 되돌리기 새 칸으로 쌓을지(고르기가 바뀌면 참)
let bandRebuildChain = Promise.resolve(); // 다시 만들기는 언제나 한 번에 하나씩 차례로

function bandKey(bandEditor) {
  return bandEditor?.div?.id || (bandEditor ? String(bandEditor.id) : "");
}

/** 띠 하나를 만들 때 그 점 목록·모양을 적어 두고, 골랐는지 지켜본다 */
function rememberBand(bandEditor, pageIndex, points, style) {
  const info = {
    editor: bandEditor,
    pageIndex,
    points: points.map((p) => [p[0], p[1]]),
    style: { ...style },
  };
  bands.set(bandKey(bandEditor), info);
  watchBandSelection(bandEditor);
  skipPdfJsThickness(bandEditor);
  followBandWhenMoved(bandEditor);
  return info;
}

/**
 * 이 띠에 대해서는 PDF.js가 두께를 처리하지 않게 비운다.
 *
 * 두께는 우리가 띠를 새로 만들어 반영하는데(rebuildBandNow), PDF.js도 제 나름대로 값을 바꾸면서
 * 되돌리기를 따로 한 칸 쌓는다. 그 칸은 눌러도 화면이 하나도 안 바뀌므로(모양은 우리가 만든
 * 것이라서) 사용자에게는 "Ctrl+Z를 눌렀는데 아무 일도 안 일어나는" 헛걸음이 된다.
 * 그래서 그 처리만 비우고, 두께에 관한 일은 전부 우리가 맡는다.
 */
function skipPdfJsThickness(bandEditor) {
  if (bandEditor._dmsThicknessSkipped) return;
  bandEditor._dmsThicknessSkipped = true;
  const orig = bandEditor.updateParams.bind(bandEditor);
  bandEditor.updateParams = (type, value) => {
    if (type === AnnotationEditorParamsType.HIGHLIGHT_THICKNESS) return;
    orig(type, value);
  };
}

/**
 * 띠 하나를 "그렸다"고 되돌리기 목록에 올린다.
 *
 * PDF.js가 대신 해 주는 것을 쓰지 않는 이유: 그 명령은 등록하는 그 순간의 주석을 직접
 * 가리키는데, 나중에 두께를 고치면 그 주석을 지우고 새것으로 갈아 끼우므로(rebuildBandNow)
 * 되돌리기가 이미 없어진 주석을 가리키게 된다. 그래서 적어 둔 것(info)을 거쳐 "지금 그 자리에
 * 있는 주석"을 가리키게 한다 — 두께를 몇 번을 고쳐도 Ctrl+Z로 그 획을 지울 수 있다.
 */
function registerBandCreation(info) {
  const um = uiManager();
  if (!um || !info) return;
  um.addCommands({
    cmd: () => { if (info.editor && !info.editor.parent) um.rebuild(info.editor); }, // 되살리기
    undo: () => { info.editor?.remove(); },                                          // 지우기
    mustExec: false, // 이미 그려져 있으므로 지금은 실행하지 않는다
  });
}

/** 갈아 끼우거나 지울 때 — 적어 둔 것도 함께 지운다 */
function forgetAndRemoveBand(bandEditor) {
  if (!bandEditor) return;
  bands.delete(bandKey(bandEditor));
  selectedBandSet.delete(bandEditor);
  bandEditor.remove();
}

// 띠를 골랐는지 지켜본다. 원래 동작은 언제나 먼저 그대로 실행하므로, 우리 코드가 실패해도
// 고르기 자체는 멈추지 않는다(도형의 wrapEditorSelect와 같은 방식).
function watchBandSelection(bandEditor) {
  if (bandEditor._dmsBandWatched) return;
  bandEditor._dmsBandWatched = true;
  const origSelect = bandEditor.select.bind(bandEditor);
  const origUnselect = bandEditor.unselect.bind(bandEditor);
  bandEditor.select = () => {
    origSelect();
    try { selectedBandSet.add(bandEditor); } catch { /* 고르기 자체는 이미 됐다 */ }
  };
  bandEditor.unselect = () => {
    origUnselect();
    try {
      selectedBandSet.delete(bandEditor);
      // 골랐다 풀었다 한 뒤의 두께 변경은 앞 변경과 묶지 않고 되돌리기에 새 칸으로 쌓는다.
      bandThicknessNewGroup = true;
    } catch { /* 위와 같은 이유 */ }
  };
}

/** 지금 골라 둔 우리 띠들 */
function selectedBandInfos() {
  const list = [];
  for (const bandEditor of [...selectedBandSet]) {
    if (!bandEditor.parent) {
      selectedBandSet.delete(bandEditor);
      continue;
    }
    const info = bands.get(bandKey(bandEditor));
    if (info) list.push(info);
  }
  return list;
}

/**
 * 도구창에서 두께를 바꿨을 때 골라 둔 띠에 반영한다.
 * 골라 둔 띠가 없으면 아무것도 하지 않는다 — 그때 그 값은 "다음에 그을 획"의 두께다.
 * 막대를 끄는 동안 수십 번 불리므로 손을 멈춘 뒤 한 번만 다시 만든다.
 */
function restyleSelectedBandThickness(thickness) {
  const infos = selectedBandInfos();
  if (infos.length === 0) return false;
  clearTimeout(bandThicknessTimer);
  bandThicknessTimer = setTimeout(() => applyBandThickness(infos, thickness), BAND_RESTYLE_DELAY);
  return true;
}

function applyBandThickness(infos, thickness) {
  const um = uiManager();
  // 막대를 끄는 동안 잇달아 고친 것은 되돌리기 한 칸으로 묶는다. 다만 골라 둔 것이 바뀐 뒤
  // 처음 고치는 것과 여러 개를 한꺼번에 고치는 것은 따로 쌓는다.
  const merge = infos.length === 1 && !bandThicknessNewGroup;
  for (const info of infos) {
    if (!info.editor?.parent) continue;
    const before = info.style.thickness;
    if (before === thickness) continue;
    um?.addCommands({
      cmd: () => { rebuildBand(info, thickness); },
      undo: () => { rebuildBand(info, before); },
      mustExec: true,
      type: infos.length === 1 ? BAND_THICKNESS_COMMAND_TYPE : NaN,
      overwriteIfSameType: merge,
      keepUndo: merge, // 묶을 때는 맨 처음 두께로 돌아가도록 앞 칸의 되돌리기를 이어받는다
    });
  }
  bandThicknessNewGroup = false;
}

// 다시 만들기는 앞의 것이 끝난 뒤에 한다 — 되돌리기를 연달아 눌러도 순서가 엉키지 않게.
function rebuildBand(info, thickness) {
  bandRebuildChain = bandRebuildChain
    .then(() => rebuildBandNow(info, thickness))
    .catch((err) => { console.warn("[dms] band rebuild failed:", err); });
  return bandRebuildChain;
}

/**
 * 띠 하나를 그 점 목록으로 다시 만들어 갈아 끼운다.
 * 값만 넣으면 언제든 같은 결과가 되므로 되돌리기·다시하기에 그대로 쓸 수 있다.
 */
async function rebuildBandNow(info, thickness) {
  const old = info.editor;
  if (!old?.parent) return;
  const found = layerForPageIndex(info.pageIndex);
  if (!found) return;

  const wasSelected = selectedBandSet.has(old);
  const style = {
    ...info.style,
    thickness,
    stroke: old.color || info.style.stroke,
    opacity: old.opacity ?? info.style.opacity ?? 1,
  };
  const next = await addHighlightBand(found.pageView, found.layer, info.points, style, false);
  if (!next) return;

  forgetAndRemoveBand(old);
  info.editor = next;
  info.style = style;
  bands.set(bandKey(next), info); // addHighlightBand이 새로 적어 둔 것을 우리 것으로 바꾼다
  if (wasSelected) uiManager()?.setSelected(next);
}

/** 도형 하나(테두리 + 필요하면 채움)를 만들고, 나중에 회전·복사할 수 있게 기억해 둔다 */
async function createShape({ pageView, layer, kind, box, angle, stroke, fill, fillOpacity = 1,
                             fillState = 0, thickness, opacity, lineType = null }) {
  const scale = pageView.viewport.scale;
  const built = buildShape(kind, box, thickness * scale, angle);
  if (built.subpaths.length === 0) return null;

  const toPdf = ([x, y]) => pageView.viewport.convertToPdfPoint(x, y);

  // 채움을 테두리보다 **먼저** 만든다 — 나중에 만든 것이 위에 그려지므로, 그래야 채움이
  // 테두리 밑에 깔린다(불투명하게 칠해도 테두리가 가려지지 않는다).
  // opaqueBlend=true — 채움은 형광펜처럼 겹쳐 칠하지 않고 위에 그대로 덮는다.
  const fillEditors = [];
  for (const item of fillPlan({ kind, stroke, fill, fillOpacity, fillState }, built)) {
    const back = await addPolygonFill(pageView, layer, item.points.map(toPdf), {
      color: item.color, opacity: item.opacity, opaqueBlend: true, undoable: false,
    });
    if (back) fillEditors.push(back);
  }

  // 채움은 원래 모양 그대로 칠하고(끊기면 안 된다) 테두리만 고른 선 타입으로 바꾼다.
  const strokePaths = applyLineType(built.subpaths, lineType, thickness * scale);
  // 글자 도형은 칠한 네모까지 테두리 자리에 넣어, 자료를 골랐을 때 나오는 상자와 칠한 자리를
  // 똑같이 맞춘다 (2026-09-05 CM 지시 — "선택박스 안에만 칠해지도록").
  const strokeEditor = await addInkEditor(pageView, layer, strokePaths, { color: stroke, thickness, opacity },
    { bboxExtra: TEXT_SHAPES.has(kind) ? built.outline : null });
  if (!strokeEditor) {
    for (const back of fillEditors) back.remove();
    return null;
  }
  if (fillEditors.length > 0) attachBackground(strokeEditor, fillEditors);

  // 크기조절 규칙(비율 고정·Shift) · 고르면 [도형] 버튼 맞추기
  setupShapeEditor(strokeEditor, kind);

  shapes.set(strokeEditor.div?.id || String(strokeEditor.id), {
    kind, angle, stroke, fill, fillOpacity, fillState, lineType,
    style: { thickness, opacity },
    pdfBox: { p0: toPdf([box.x0, box.y0]), p1: toPdf([box.x1, box.y1]) },
    // 만들 때의 테두리 자리(PDF 좌표). 나중에 사용자가 도형을 옮기거나 크기를 바꿨을 때
    // 얼마나 움직였는지를 이 값과 견주어 알아낸다(currentPdfBox 참고).
    rect0: strokeEditor.getRect(0, 0),
    pageIndex: pageView.id - 1,
    strokeEditor,
    fillEditors,
  });
  lastShapeId = strokeEditor.div?.id || String(strokeEditor.id);
  // 방금 만든 도형에 초점을 준다 — 손으로 그린 선을 다 그렸을 때와 같은 상태라
  // Delete(지우기)·Ctrl+Z(되돌리기)·Alt+화살표(회전)가 바로 먹는다.
  strokeEditor.div?.focus({ preventScroll: true });
  return strokeEditor;
}

/**
 * 지금 도형이 놓여 있는 자리(PDF 좌표)를 돌려준다.
 *
 * 그릴 때의 자리만 기억해 두면, 사용자가 도형을 다른 데로 옮긴 뒤 회전시켰을 때 도형이
 * 처음 그린 자리로 되돌아가 버린다(2026-09-02 CM 보고). 그래서 만들 때의 테두리 자리(rect0)와
 * 지금 테두리 자리를 견주어 "얼마나 옮겨졌고 얼마나 커졌는지"를 구해 같은 만큼 밀어 준다.
 */
function currentPdfBox(info) {
  const before = info.rect0;
  const strokeEditor = info.strokeEditor;
  if (!before || !strokeEditor?.parent) return info.pdfBox;
  const now = strokeEditor.getRect(0, 0);
  const width = before[2] - before[0];
  const height = before[3] - before[1];
  const scaleX = width ? (now[2] - now[0]) / width : 1;
  const scaleY = height ? (now[3] - now[1]) / height : 1;
  const move = ([x, y]) => [now[0] + (x - before[0]) * scaleX, now[1] + (y - before[1]) * scaleY];
  return { p0: move(info.pdfBox.p0), p1: move(info.pdfBox.p1) };
}

// 기억해 둔 PDF 좌표를 지금 화면의 픽셀 자리로 되돌린다(확대·축소가 바뀌어도 맞는다).
function viewportBoxOf(info, pageView) {
  const box = currentPdfBox(info);
  const [x0, y0] = pageView.viewport.convertToViewportPoint(box.p0[0], box.p0[1]);
  const [x1, y1] = pageView.viewport.convertToViewportPoint(box.p1[0], box.p1[1]);
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// Ctrl+끌기 복사 — "이 표시를 어떻게 다시 만드는지" 알려주기 (2026-09-07 CM 지시)
// ---------------------------------------------------------------------------
//
// 복사 자체(무엇을 언제 복사할지·끄는 동안의 미리보기·되돌리기)는 dms-copy.js가 맡는다.
// 여기서는 우리가 만든 표시(도형·형광펜 띠·펜 선)에 대해 "무엇으로 만들었는지"를 알려주고
// 옮긴 자리에 그 값으로 다시 만들어 준다. 그래야 복사본도 원본과 똑같이 회전·채움 전환·
// 두께 변경·선 타입 변경이 된다(PDF.js의 복사·붙여넣기로 베끼면 그 값들이 남지 않는다).
// 모르는 표시(문구·도장·PDF.js가 그린 선 등)는 null을 돌려주고, 그때는 dms-copy.js가
// PDF.js의 복사·붙여넣기 방식으로 그대로 베낀다.

function copyRecipeFor(markupEditor) {
  const key = markupEditor?.div?.id || (markupEditor ? String(markupEditor.id) : "");
  if (!key) return null;
  const shape = shapes.get(key);
  if (shape) return { type: "shape", info: shape };
  const band = bands.get(key);
  if (band) return { type: "band", info: band };
  if (inkSources.has(key)) {
    // 색·굵기는 주석에서 읽어 온다 — 그린 뒤에 고쳤을 수 있기 때문이다.
    const ink = inkSourceOf(markupEditor);
    if (ink) return { type: "ink", info: ink };
  }
  return null;
}

/** 화면에서 움직인 만큼(픽셀)을 자료(PDF) 좌표의 이동량으로 바꾼다 — 확대·쪽 회전과 무관하게 맞는다 */
function pdfShift(pageView, dx, dy) {
  const [x0, y0] = pageView.viewport.convertToPdfPoint(0, 0);
  const [x1, y1] = pageView.viewport.convertToPdfPoint(dx, dy);
  return [x1 - x0, y1 - y0];
}

/** 알려 준 값으로 dx·dy(화면 픽셀)만큼 옮긴 자리에 하나 더 만든다 */
async function duplicateFromRecipe(recipe, dx, dy) {
  const found = layerForPageIndex(recipe.info.pageIndex);
  if (!found) return null;
  const { pageView, layer } = found;
  const info = recipe.info;

  if (recipe.type === "shape") {
    const box = viewportBoxOf(info, pageView); // 지금 놓여 있는 자리 그대로
    return createShape({
      pageView, layer, kind: info.kind,
      box: { x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy },
      angle: info.angle, stroke: info.stroke, fill: info.fill, fillOpacity: info.fillOpacity,
      fillState: info.fillState, thickness: info.style.thickness,
      opacity: info.style.opacity, lineType: info.lineType,
    });
  }

  const [px, py] = pdfShift(pageView, dx, dy);
  if (recipe.type === "band") {
    // 색·진하기는 주석에서 읽어 온다(그린 뒤에 고쳤을 수 있다 — rebuildBandNow와 같은 이유).
    const style = {
      ...info.style,
      stroke: info.editor?.color || info.style.stroke,
      opacity: info.editor?.opacity ?? info.style.opacity ?? 1,
    };
    const points = info.points.map(([x, y]) => [x + px, y + py]);
    // 되돌리기는 dms-copy.js가 복사 전체를 한 번에 등록하므로 여기서는 쌓지 않는다.
    return addHighlightBand(pageView, layer, points, style, false);
  }

  const subpathsPdf = info.subpaths.map((pts) => pts.map(([x, y]) => [x + px, y + py]));
  // PDF 좌표에서 만드는 것이라 선 타입 간격도 PDF 단위 굵기를 기준으로 잡는다(한붓그리기와 같다).
  const drawn = applyLineType(subpathsPdf.map(straightSubpath), info.lineType, info.style.thickness);
  const inkEditor = await addInkEditor(pageView, layer, drawn, info.style, { pdfCoords: true });
  rememberInk(inkEditor, info.pageIndex, subpathsPdf, info.lineType);
  return inkEditor;
}

// ---------------------------------------------------------------------------
// [회전] 아이콘으로 돌리기 — 돌린 모습으로 다시 만들어 주기 (2026-09-18 CM 지시)
// ---------------------------------------------------------------------------
//
// 돌리는 일 전체(끄는 동안 보여주기·맞바꾸기·되돌리기·다시 고르기)는 dms-rotate.js가 맡는다.
// 여기서는 "이 표시를 돌린 모습으로 하나 새로 만들어 달라"는 부탁만 들어주고, 원래 것은 지우지
// 않고 그대로 둔다. 원래 것과 새것을 찾아가는 길(oldRef·newRef)을 돌려주면 dms-rotate.js가
// 둘을 맞바꾼다.
//   · 도형      : 모양·네모·각도를 알고 있으므로 각도만 더해 처음부터 다시 그린다(채움도 함께 돈다).
//   · 형광펜 띠 : 그릴 때 쓴 점 목록을 돌려 다시 만든다(꺾인 자리가 그대로 각지다).
//   · 펜 선     : 주석에 담긴 선(베지어)과 점을 그대로 돌린다 — 손으로 그은 선의 부드러운 모양이
//                 조금도 달라지지 않는다. 선 타입을 바꿀 때 쓰는 "지나간 자리"도 같이 돌려 적어 둔다.
// 띠·선은 새것을 기록(bands·inkSources)을 거쳐 찾아간다. 두께·선 타입을 바꾸면 표시가 새것으로
// 갈아 끼워지는데, 그 뒤에 회전을 되돌리면 "지금 그 자리에 있는 것"을 지워야 하기 때문이다.

/** 돌리는 중심 — 우리 도형이면 도형 네모의 한가운데(PDF 좌표), 아니면 null */
function rotationPivotFor(markupEditor) {
  const key = markupEditor?.div?.id || (markupEditor ? String(markupEditor.id) : "");
  const info = shapes.get(key);
  if (!info || info.strokeEditor !== markupEditor) return null;
  const { p0, p1 } = currentPdfBox(info);
  return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
}

/**
 * 표시 하나를 deg도(시계방향) 돌린 모습으로 새로 만든다. 우리가 다루지 않는 표시면 null.
 *   turn(x, y) : PDF 좌표의 점 하나를 돌려 주는 함수(dms-rotate.js가 중심·각도를 담아 넘긴다)
 */
async function rotateOwnMarkup(markupEditor, deg, turn) {
  const key = markupEditor?.div?.id || (markupEditor ? String(markupEditor.id) : "");
  const shape = shapes.get(key);
  if (shape && shape.strokeEditor === markupEditor) return rotateShapeBy(shape, deg);
  const band = bands.get(key);
  if (band && band.editor === markupEditor) return rotateBandBy(band, turn);
  if (markupEditor?.mode === AnnotationEditorType.INK) return rotateInkBy(markupEditor, turn);
  return null;
}

async function rotateShapeBy(info, deg) {
  const found = layerForPageIndex(info.pageIndex);
  if (!found) return null;
  const oldStroke = info.strokeEditor;
  const next = await createShape({
    pageView: found.pageView, layer: found.layer, kind: info.kind,
    box: viewportBoxOf(info, found.pageView), // 지금 놓여 있는 자리·크기 그대로
    angle: (((info.angle + deg) % 360) + 360) % 360,
    stroke: info.stroke, fill: info.fill, fillOpacity: info.fillOpacity, fillState: info.fillState,
    thickness: info.style.thickness, opacity: info.style.opacity, lineType: info.lineType,
  });
  return next ? { oldRef: () => oldStroke, newRef: () => next } : null;
}

async function rotateBandBy(info, turn) {
  const found = layerForPageIndex(info.pageIndex);
  if (!found || !info.editor?.parent) return null;
  const current = info.editor;
  // 색·진하기는 주석에서 읽어 온다(그린 뒤에 고쳤을 수 있다 — rebuildBandNow와 같은 이유).
  const style = {
    ...info.style,
    stroke: current.color || info.style.stroke,
    opacity: current.opacity ?? info.style.opacity ?? 1,
  };
  const points = info.points.map(([x, y]) => turn(x, y));
  const next = await addHighlightBand(found.pageView, found.layer, points, style, false);
  if (!next) return null;
  const nextInfo = bands.get(bandKey(next));
  return { oldRef: () => info.editor, newRef: () => nextInfo?.editor || next };
}

async function rotateInkBy(inkEditor, turn) {
  const layer = inkEditor.parent;
  if (!layer) return null;
  let data = null;
  try {
    data = inkEditor.serialize(true); // 복사용 — 선(베지어)과 점이 PDF 좌표로 담긴다
  } catch {
    data = null;
  }
  if (!data?.paths?.points?.length) return null;

  const turnFlat = (flat) => {
    const out = new Array(flat.length);
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      // 선의 첫머리에는 "여기서 시작"을 뜻하는 빈 값(NaN)이 들어 있다 — 그대로 둔다.
      if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) {
        out[i] = out[i + 1] = NaN;
        continue;
      }
      [out[i], out[i + 1]] = turn(x, y);
    }
    return out;
  };
  const points = data.paths.points.map(turnFlat);
  const lines = data.paths.lines ? data.paths.lines.map(turnFlat) : null;
  const pairs = points.map((flat) => {
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    return pts;
  });

  const next = await addEditor(layer, {
    annotationType: AnnotationEditorType.INK,
    color: data.color,
    thickness: data.thickness,
    opacity: data.opacity,
    paths: lines ? { lines, points } : { points },
    pageIndex: data.pageIndex,
    rect: boundingBox(pairs.flat()),
    rotation: data.rotation,
  }, false);
  if (!next) return null;
  next._isDraggable = true; // onceAdded를 비웠으므로 "끌어서 옮길 수 있음" 표시를 우리가 해 준다

  // 선 타입을 바꿀 때 쓰는 "지나간 자리"도 같이 돌려 새 선에 적어 둔다. 적어 둔 것이 없던 선
  // (PDF.js가 그린 실선)은 돌린 점을 그대로 적는다 — 새 선을 늘 기록으로 찾아가게 하려는 것이다.
  const known = inkSources.get(inkKey(inkEditor));
  const before = known?.editor === inkEditor ? known : null;
  const subpaths = before
    ? before.subpaths.map((pts) => pts.map(([x, y]) => turn(x, y)))
    : pairs.filter((pts) => pts.length > 1);
  rememberInk(next, before?.pageIndex ?? data.pageIndex, subpaths, before?.lineType || "solid");
  const nextInfo = inkSources.get(inkKey(next));
  return {
    oldRef: () => (before ? before.editor : inkEditor),
    newRef: () => nextInfo?.editor || next,
  };
}

// ---------------------------------------------------------------------------
// 회전 (Alt + 좌우 화살표)
// ---------------------------------------------------------------------------

// 지금 고른(초점이 있는) 도형. 초점이 다른 곳에 있으면 마지막으로 그린 도형을 쓴다.
function focusedShape() {
  const div = document.activeElement?.closest?.(".annotationEditorLayer > *");
  const info = div ? shapes.get(div.id) : (lastShapeId && shapes.get(lastShapeId));
  return info && info.strokeEditor?.parent ? info : null;
}

async function rotateFocusedShape(delta) {
  const info = focusedShape();
  return info ? recreateShape(info, { angle: info.angle + delta }) : false;
}

/**
 * 도형 하나를 지금 자리에 **다시 만들어** 갈아 끼운다(바꿀 값만 changes로 넘긴다).
 * 회전(각도 바꾸기)과 채움 전환이 함께 쓴다 — 둘 다 모양을 처음부터 다시 그려야 하고,
 * 그래야 채움이 테두리 밑에 제대로 깔린다. 되돌리기는 한 번에 예전 모습으로 돌아간다.
 */
async function recreateShape(info, changes) {
  const found = layerForPageIndex(info.pageIndex);
  if (!found) return false;

  const oldStroke = info.strokeEditor;
  const oldKey = oldStroke.div?.id || String(oldStroke.id);
  const box = viewportBoxOf(info, found.pageView); // 지금 놓여 있는 자리 그대로

  const newStroke = await createShape({
    pageView: found.pageView, layer: found.layer,
    kind: info.kind, box, angle: info.angle,
    stroke: info.stroke, fill: info.fill, fillOpacity: info.fillOpacity,
    fillState: info.fillState, thickness: info.style.thickness,
    opacity: info.style.opacity, lineType: info.lineType,
    ...changes,
  });
  if (!newStroke) return false;

  const removeOld = () => oldStroke.remove();
  const restoreOld = () => uiManager().rebuild(oldStroke);
  const removeNew = () => newStroke.remove();
  const restoreNew = () => uiManager().rebuild(newStroke);

  const wasSelected = oldStroke.div?.classList.contains("selectedEditor");
  removeOld();
  shapes.delete(oldKey);
  // 고쳐 놓은 도형을 다시 골라 둔다 — 안 그러면 잇달아 고칠 때(선 타입을 두 번 바꾸는 등)
  // 두 번째부터 아무 일도 안 일어난다.
  if (wasSelected) uiManager().setSelected(newStroke);
  // 되돌리기 한 번으로 돌리기 전 모습으로 돌아가게 묶는다(이미 실행했으므로 mustExec은 false).
  uiManager().addCommands({
    cmd: () => { removeOld(); restoreNew(); },
    undo: () => { removeNew(); restoreOld(); },
    mustExec: false,
  });
  return true;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 한붓그리기 — 이어 그은 한 획을 주석 하나로 만든다 (2026-09-04 CM 지시)
// ---------------------------------------------------------------------------
//
// 낱개 선·낱개 띠를 여러 개 만들면 꺾이는 자리에 이음매가 생기고, 형광펜은 폭이 넓어서
// 그 자리가 눈에 띄게 벌어진다(2026-09-04 CM 보고). 그래서 한 획의 점들을 모아 두었다가
// 선이 하나 늘 때마다 그 점 목록으로 주석을 다시 만든다 — 그러면 꺾이는 자리가 매끄럽게
// 이어지고, 선택·색·두께·되돌리기도 획 전체에 한 번에 걸린다.

// 획 하나(PDF 좌표 점 목록)를 주석으로 만든다 — 펜은 폴리라인 잉크, 형광펜은 띠 하나.
// 되돌리기는 획을 끝낼 때 finalizeChainStroke가 한 번만 등록하므로 여기서는 쌓지 않는다.
function addChainStrokeNoUndo(pageView, layer, vertsPdf, style) {
  if (style.kind === "band") return addHighlightBand(pageView, layer, vertsPdf, style, false);
  // PDF 좌표에서 만들므로 선 타입 간격도 PDF 단위 굵기를 기준으로 잡는다.
  const subpaths = applyLineType([straightSubpath(vertsPdf)], style.lineType, style.thickness);
  return addInkEditor(pageView, layer, subpaths, {
    color: style.stroke, thickness: style.thickness, opacity: style.opacity ?? 1,
  }, { undoable: false, pdfCoords: true }).then((inkEditor) => {
    // 선 타입을 입히기 전의 자리를 적어 둔다(위 addFreeStroke와 같은 이유).
    rememberInk(inkEditor, pageView.id - 1, [vertsPdf], style.lineType);
    return inkEditor;
  });
}

// 이번 선을 한붓그리기 획에 이어 붙인다(첫 선이면 새로 시작). 합치기가 어긋나면 예전처럼
// 낱개로라도 남겨 그림이 사라지지 않게 한다.
async function appendChainSegment(pageView, layer, box, style) {
  const toPdf = ([x, y]) => pageView.viewport.convertToPdfPoint(x, y);
  const endPdf = toPdf([box.x1, box.y1]);
  const pageIndex = pageView.id - 1;
  // 쪽이 바뀌었거나 도구가 바뀌었으면(펜↔형광펜) 이어 붙이지 않고 새 획으로 시작한다.
  const sameStroke = chainStroke && chainStroke.pageIndex === pageIndex && chainStroke.kind === style.kind;
  try {
    const verts = sameStroke ? [...chainStroke.verts, endPdf] : [toPdf([box.x0, box.y0]), endPdf];
    const editor = await addChainStrokeNoUndo(pageView, layer, verts, style);
    if (!editor) throw new Error("chain stroke create failed");
    if (sameStroke) forgetAndRemoveBand(chainStroke.editor); // 앞선 모양은 새 것으로 갈아 끼운다
    chainStroke = { kind: style.kind, editor, verts, pageIndex, style };
    editor.div?.focus({ preventScroll: true });
  } catch (err) {
    console.warn("[dms] chain stroke fallback to a single segment:", err);
    chainStroke = null;
    if (style.kind === "band") {
      await addHighlightBand(pageView, layer, box, style);
    } else {
      await createShape({
        pageView, layer, kind: "line", box, angle: 0, stroke: style.stroke, fill: null,
        thickness: style.thickness, opacity: style.opacity ?? 1, lineType: style.lineType,
      });
    }
  }
}

// 한붓그리기 획을 끝낸다 — 그 획(주석 하나)을 되돌리기 한 번 단위로 등록한다.
function finalizeChainStroke() {
  const stroke = chainStroke;
  chainStroke = null;
  const strokeEditor = stroke?.editor;
  if (!strokeEditor?.parent) return;
  const um = uiManager();
  if (!um) return;
  // 띠(형광펜)는 나중에 두께를 고치면 새 주석으로 갈아 끼워지므로, 적어 둔 것을 거쳐
  // "지금 그 자리에 있는 주석"을 가리키게 한다(registerBandCreation과 같은 이유).
  const info = bands.get(bandKey(strokeEditor));
  if (info) {
    registerBandCreation(info);
    return;
  }
  um.addCommands({
    cmd: () => um.rebuild(strokeEditor),  // 다시 실행(되돌리기 취소) = 되살리기
    undo: () => strokeEditor.remove(),    // 되돌리기 = 한붓그리기 전체를 한 번에 지운다
    mustExec: false,                      // 이미 그려져 있으므로 지금은 실행하지 않는다
  });
}

// ---------------------------------------------------------------------------
// 도형 고르기 표시 · 크기조절 규칙(Shift로 비율 지키기)
// ---------------------------------------------------------------------------

// 도형(테두리) 주석 하나가 만들어졌을 때 걸어 두는 것들.
function setupShapeEditor(strokeEditor, kind) {
  // 타원은 비율을 아예 고정(손잡이 넷)해 동그라미가 늘 정원으로 유지되게 하고,
  // 나머지 도형(블라인드 포함)은 손잡이 여덟으로 가로세로를 자유롭게 늘릴 수 있게 한다.
  strokeEditor._willKeepAspectRatio = ROUND_SHAPES.has(kind);
  wrapEditorSelect(strokeEditor);
  wrapResizeKeepRatio(strokeEditor);
}

// 주석의 select/unselect를 감싸, 골랐을 때 ㉠골라 둔 도형 목록에 넣고 ㉡크기조절 손잡이에
// 규칙을 걸고 ㉢도구창을 그 도형의 값에 맞춘다. 원래 동작(origSelect)은 언제나 먼저 그대로
// 실행하므로, 우리 코드가 실패해도 고르기 자체는 멈추지 않는다.
function wrapEditorSelect(editor) {
  if (editor._dmsSelectWrapped) return;
  editor._dmsSelectWrapped = true;
  const origSelect = editor.select.bind(editor);
  const origUnselect = editor.unselect.bind(editor);
  editor.select = () => {
    origSelect();
    try {
      selectedShapeSet.add(editor);
      reflectShapeSelection();
      hookResizers(editor); // 손잡이는 처음 골랐을 때 만들어지므로 그때 붙인다
      // 도구창을 이 도형의 값에 맞춘다 — 그래야 한 칸만 고쳐도 나머지가 딴 값으로 바뀌지 않는다.
      const info = shapes.get(editor.div?.id || String(editor.id));
      if (info) syncPanelFromShape(info);
    } catch { /* 고르기 자체는 이미 됐으니 부가 처리 실패는 넘어간다 */ }
  };
  editor.unselect = () => {
    origUnselect();
    try {
      selectedShapeSet.delete(editor);
      reflectShapeSelection();
    } catch { /* 위와 같은 이유 */ }
  };
}

// ---------------------------------------------------------------------------
// 그려 둔 도형을 골라서 색·두께·채우기 고치기 (2026-09-04 CM 지시)
// ---------------------------------------------------------------------------
//
// 예전에는 도구창 값이 "다음에 그릴 도형"에만 반영돼서, 이미 그려 둔 도형을 골라 색채움을
// 켜도 아무 일이 없었고 이미 칠해 둔 것의 색·진하기도 바꿀 수 없었다(2026-09-04 CM 보고).
// 이제 도형을 고르면 ㉠도구창이 그 도형의 값을 보여주고 ㉡값을 바꾸면 그 도형에 바로 반영된다
// (PPT·한글의 개체 속성과 같은 방식).
//
// 색·두께는 PDF.js가 원래 갖고 있는 방법(updateParams)으로 그 자리에서 바꾸므로 되돌리기도
// PDF.js가 알아서 챙긴다. 채움은 우리가 따로 만들어 붙인 조각이라(dms-link.js) 다시 만들어
// 갈아 끼우고, 되돌리기는 "예전 값으로 다시 칠하기"로 짝을 맞춘다.

const FILL_COMMAND_TYPE = 9101; // 되돌리기 목록에서 같은 종류끼리 묶을 때 쓰는 번호
let fillDelayTimer = null;

/** 지금 골라 둔 우리 도형들 */
function selectedShapeInfos() {
  const list = [];
  for (const ed of selectedShapeSet) {
    if (!ed.parent) continue;
    const info = shapes.get(ed.div?.id || String(ed.id));
    if (info) list.push(info);
  }
  return list;
}

/** 도형을 고르면 도구창을 그 도형의 값에 맞춘다(이때는 도형을 고치지 않는다). */
function syncPanelFromShape(info) {
  syncingPanel = true;
  try {
    controls.strokeField?.setValue(info.stroke);
    state.stroke = info.stroke;
    controls.setThickness?.(info.style.thickness);
    if (info.fill) {
      state.fillColor = info.fill;
      controls.fillField?.setValue(info.fill);
    }
    if (!TOGGLE_SHAPES.has(info.kind)) {
      controls.setFillOpacity?.(Math.round((info.fillOpacity ?? 1) * 100));
      controls.setFillOn?.(!!info.fill);
    }
  } catch { /* 값 맞추기가 실패해도 고르기 자체는 그대로 된다 */ } finally {
    syncingPanel = false;
  }
}

/**
 * 도형 하나의 채움을 지금 값으로 다시 칠한다. fill이 null이면 채움을 없앤다.
 * 값만 넣으면 언제든 같은 결과가 되므로 되돌리기·다시하기에 그대로 쓸 수 있다.
 */
async function applyShapeFill(info, fill, fillOpacity) {
  info.fill = fill;
  info.fillOpacity = fillOpacity;
  await repaintFills(info);
}

/** 지금 값(fill·fillOpacity·fillState)대로 채움 조각을 다시 만들어 갈아 끼운다 */
async function repaintFills(info) {
  const main = info.strokeEditor;
  if (!main?.parent) return;
  // 직선·화살표처럼 채울 안이 없는 모양이면 붙어 있던 채움을 치우고 끝낸다.
  if (!TOGGLE_SHAPES.has(info.kind) && !(info.fill && canFill(info.kind))) {
    clearBackgrounds(main);
    info.fillEditors = [];
    return;
  }

  const found = layerForPageIndex(info.pageIndex);
  if (!found) return;
  const scale = found.pageView.viewport.scale;
  const box = viewportBoxOf(info, found.pageView); // 지금 놓여 있는 자리·크기 그대로 칠한다
  const built = buildShape(info.kind, box, info.style.thickness * scale, info.angle);
  const plan = fillPlan(info, built);
  if (plan.length === 0) {
    clearBackgrounds(main);
    info.fillEditors = [];
    return;
  }

  const toPdf = ([x, y]) => found.pageView.viewport.convertToPdfPoint(x, y);
  const backs = [];
  for (const item of plan) {
    const back = await addPolygonFill(found.pageView, found.layer, item.points.map(toPdf), {
      color: item.color, opacity: item.opacity, opaqueBlend: true, undoable: false,
    });
    if (back) backs.push(back);
  }
  if (backs.length === 0) return;
  // 칠하는 사이에 그 도형이 없어졌으면(되돌리기를 잇달아 누른 경우 등) 방금 만든 채움도
  // 함께 치운다 — 안 그러면 테두리는 없어졌는데 채움만 화면에 남는다.
  if (!main.parent) {
    for (const back of backs) back.remove();
    info.fillEditors = [];
    return;
  }
  attachBackground(main, backs); // 예전 채움은 여기서 치워진다
  for (const back of backs) moveFillBehind(back, main);
  info.fillEditors = backs;
}

/**
 * 나중에 만든 채움을 테두리 **밑으로** 내린다.
 *
 * 표시는 만든 차례대로 쌓이므로(그린 순서대로 SVG가 붙는다), 이미 그려 둔 도형에 채움을
 * 새로 만들면 그것이 테두리 위에 얹혀 선을 가려 버린다. 그림 조각을 테두리 앞으로 옮겨
 * 자리를 바로잡는다. 조각을 찾는 길은 PDF.js가 붙여 둔 `path_<번호>` 뿐이라, 못 찾으면
 * 그냥 넘어간다(그때는 예전처럼 위에 얹힌 채로 보인다).
 */
function svgRootOf(drawEditor) {
  const drawId = drawEditor?._drawId;
  if (drawId === null || drawId === undefined) return null;
  return document.getElementById(`path_${drawId}`)?.closest("svg") || null;
}

function moveFillBehind(back, main) {
  const backSvg = svgRootOf(back);
  const mainSvg = svgRootOf(main);
  if (backSvg && mainSvg && backSvg.parentNode === mainSvg.parentNode) mainSvg.before(backSvg);
}

/**
 * 도구창에서 값을 바꿨을 때 골라 둔 도형에 반영한다.
 *   what  : "stroke" | "thickness" | "fill"
 *   delay : true면 손을 멈춘 뒤에 한 번만 반영한다(막대를 끄는 동안 쓰인다)
 * 골라 둔 도형이 없으면 아무것도 하지 않는다 — 그때 도구창 값은 "다음에 그릴 도형"의 값이다.
 */
function restyleSelectedShapes(what, { delay = false } = {}) {
  if (syncingPanel) return false;
  if (delay) {
    clearTimeout(fillDelayTimer);
    fillDelayTimer = setTimeout(() => restyleSelectedShapes(what), 250);
    return false;
  }
  const infos = selectedShapeInfos();
  if (infos.length === 0) return false;

  for (const info of infos) {
    if (what === "stroke") {
      info.stroke = state.stroke;
      info.strokeEditor.updateParams(AnnotationEditorParamsType.INK_COLOR, state.stroke);
      // 블라인드류는 칠해진 동그라미가 선 색을 따르므로 그 채움도 다시 칠한다.
      if (TOGGLE_SHAPES.has(info.kind)) repaintFills(info);
    } else if (what === "thickness") {
      info.style.thickness = state.thickness;
      info.strokeEditor.updateParams(AnnotationEditorParamsType.INK_THICKNESS, state.thickness);
    } else {
      const oldFill = info.fill;
      const oldOpacity = info.fillOpacity;
      const newFill = state.fill;
      const newOpacity = state.fillOpacity;
      if (oldFill === newFill && oldOpacity === newOpacity) continue;
      uiManager()?.addCommands({
        cmd: () => { applyShapeFill(info, newFill, newOpacity); },
        undo: () => { applyShapeFill(info, oldFill, oldOpacity); },
        mustExec: true,
        // 도형 하나를 잇달아 고칠 때만 되돌리기 한 칸으로 묶는다(여러 개를 골랐으면 따로 쌓는다).
        type: infos.length === 1 ? FILL_COMMAND_TYPE : NaN,
        overwriteIfSameType: infos.length === 1,
        keepUndo: true,
      });
    }
  }
  return true;
}

// [도형] 버튼은 **도형 도구가 실제로 켜져 있을 때만** 눌린 것으로 둔다 (2026-09-06 CM 지시).
// 도형을 골랐다는 것만으로는 아무 버튼도 새로 누르지 않는다 — 고른다고 도구가 바뀌지 않으므로
// 마지막으로 고른 도구([선택]·[강조 표시] 등)가 그대로 눌린 채 남아야 한다.
function reflectShapeSelection() {
  for (const ed of [...selectedShapeSet]) if (!ed.parent) selectedShapeSet.delete(ed);
  if (state.on) {
    button.classList.add("toggled");
    hideInkToolbarLook();
  } else {
    button.classList.remove("toggled");
  }
}

// ---------------------------------------------------------------------------
// 그려 둔 펜 선의 "선 타입"을 나중에 바꾸기 (2026-09-05 CM 지시)
// ---------------------------------------------------------------------------
//
// 그리기 도구창에서 실선·점선·파선·구름을 고르면, 골라 둔 선이 그 모양으로 **다시 그려진다**.
// 점선·파선은 실제로 끊어서 만들고 구름은 물결로 만들기 때문에(dms-geometry.js), 모양을 바꾸려면
// **처음에 지나간 자리**로 다시 만들어야 한다. 그래서 그 자리를 기억해 둔다.
//   · 우리가 그린 선(점선·파선·구름·한붓그리기)은 만들 때 적어 둔다.
//   · PDF.js가 그린 실선은 적어 둔 것이 없으므로, 바꿀 때 그 주석에서 지나간 자리를 읽어 온다.
// 강조 표시 띠의 두께를 나중에 바꾸는 것과 같은 방식이다.

const inkSources = new Map(); // 선 주석 → { editor, pageIndex, subpaths(PDF 좌표 점 목록), lineType }

function inkKey(inkEditor) {
  return inkEditor?.div?.id || (inkEditor ? String(inkEditor.id) : "");
}

/** 우리가 그린 선의 "지나간 자리"를 적어 둔다(선 타입을 입히기 **전**의 자리) */
function rememberInk(inkEditor, pageIndex, subpathsPdf, lineType) {
  if (!inkEditor) return;
  inkSources.set(inkKey(inkEditor), {
    editor: inkEditor, pageIndex,
    subpaths: subpathsPdf.map((pts) => pts.map((p) => [p[0], p[1]])),
    lineType: lineType || "solid",
  });
}

const rgbToHex = (rgb) => `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;

/**
 * 그 선의 지나간 자리·색·굵기 — 적어 둔 것이 없으면 주석에서 읽어 온다(PDF.js가 그린 실선).
 *
 * 적어 둔 것이 있으면 **베끼지 않고 그것을 그대로** 돌려준다(색·굵기만 지금 값으로 맞춘다).
 * 선 타입을 바꾸면 그 기록이 새 선을 가리키도록 고쳐지는데, 베낀 것을 고치면 원래 기록은
 * 옛 선을 가리킨 채 남는다. 그러면 그 선을 돌린 뒤(dms-rotate.js) 선 타입을 바꾸고 되돌렸을 때,
 * 회전의 되돌리기가 이미 없어진 선을 지우려 해 화면에 선이 두 개 남는다 (2026-09-18 확인).
 */
function inkSourceOf(inkEditor) {
  const known = inkSources.get(inkKey(inkEditor));
  const data = inkEditor.serialize?.(false, Object.create(null));
  if (!data || data.annotationType !== AnnotationEditorType.INK) return null;
  const style = {
    color: Array.isArray(data.color) ? rgbToHex(data.color) : toolState.ink.color,
    thickness: data.thickness ?? toolState.ink.thickness,
    opacity: data.opacity ?? 1,
  };
  if (known) {
    known.style = style;
    return known;
  }

  const subpaths = [];
  for (const flat of data.paths?.points || []) {
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    if (pts.length > 1) subpaths.push(pts);
  }
  if (subpaths.length === 0) return null;
  return { editor: inkEditor, pageIndex: data.pageIndex, subpaths, lineType: "solid", style };
}

/** 지금 골라 둔 선 주석들 */
function selectedInkEditors() {
  const um = uiManager();
  const ids = new Set(
    [...document.querySelectorAll(".annotationEditorLayer .inkEditor.selectedEditor")].map((d) => d.id)
  );
  if (!um || ids.size === 0) return [];
  const out = [];
  for (let page = 0; page < (app.pdfViewer.pagesCount || 0); page++) {
    let list;
    try { list = um.getEditors(page); } catch { continue; }
    list?.forEach?.((ed) => { if (ed.div && ids.has(ed.div.id)) out.push(ed); });
  }
  return out;
}

/**
 * 골라 둔 선을 고른 모양(실선·점선·파선·구름)으로 다시 그린다.
 * 골라 둔 것이 없으면 아무 일도 안 한다 — 그때 그 값은 "다음에 그을 선"의 모양이다.
 * 우리 도형(사각형·직선·화살표 등)은 도형을 다시 만드는 쪽이 더 정확하므로 그리로 보낸다.
 */
function restyleSelectedInkLineType(lineType) {
  const editors = selectedInkEditors();
  if (editors.length === 0) return false;
  const um = uiManager();
  let done = false;

  for (const inkEditor of editors) {
    const shapeInfo = shapes.get(inkEditor.div?.id || String(inkEditor.id));
    if (shapeInfo) {
      if ((shapeInfo.lineType || "solid") !== lineType) {
        recreateShape(shapeInfo, { lineType });
        done = true;
      }
      continue;
    }
    const info = inkSourceOf(inkEditor);
    if (!info || info.lineType === lineType) continue;
    const before = info.lineType;
    um?.addCommands({
      cmd: () => { rebuildInk(info, lineType); },
      undo: () => { rebuildInk(info, before); },
      mustExec: true,
    });
    done = true;
  }
  return done;
}

// 다시 만들기는 앞의 것이 끝난 뒤에 한다 — 되돌리기를 연달아 눌러도 순서가 엉키지 않게.
let inkRebuildChain = Promise.resolve();

function rebuildInk(info, lineType) {
  inkRebuildChain = inkRebuildChain
    .then(() => rebuildInkNow(info, lineType))
    .catch((err) => { console.warn("[dms] ink line type rebuild failed:", err); });
  return inkRebuildChain;
}

async function rebuildInkNow(info, lineType) {
  const old = info.editor;
  if (!old?.parent) return;
  const found = layerForPageIndex(info.pageIndex);
  if (!found) return;

  // PDF 좌표에서 만들므로 선 타입 간격도 PDF 단위 굵기를 기준으로 잡는다(한붓그리기와 같다).
  const shaped = applyLineType(info.subpaths.map(straightSubpath), lineType, info.style.thickness);
  const next = await addInkEditor(found.pageView, found.layer, shaped, info.style,
    { undoable: false, pdfCoords: true });
  if (!next) return;
  next._isDraggable = true;

  const wasSelected = old.div?.classList.contains("selectedEditor");
  inkSources.delete(inkKey(old));
  old.remove();
  info.editor = next;
  info.lineType = lineType;
  inkSources.set(inkKey(next), info);
  if (wasSelected) uiManager()?.setSelected(next);
}

// ---------------------------------------------------------------------------
// 채움 전환 — 블라인드·스펙타클 블라인드·밸브를 칠했다 비웠다 (2026-09-04 CM 지시, 밸브는 09-18)
// ---------------------------------------------------------------------------
//
// 그려 둔 도형을 고르면 그 옆 작은 도구모음에 [채움 전환] 버튼이 뜬다(dms-edit-toolbar.js).
// 누르면 블라인드는 동그라미가, 밸브는 세모 둘이 칠해졌다 비워지고, 스펙타클 블라인드는 칠해지는
// 동그라미가 위에서 아래로 옮겨 간다. 칠하는 색은 언제나 그 도형의 선 색이고, 안 칠하는 쪽은 흰색이다.

/** 이 표시가 채움을 전환할 수 있는 우리 도형이면 그 정보를 돌려준다 */
function toggleInfoFor(strokeEditor) {
  if (!strokeEditor) return null;
  const info = shapes.get(strokeEditor.div?.id || String(strokeEditor.id));
  return info && TOGGLE_SHAPES.has(info.kind) && info.strokeEditor === strokeEditor ? info : null;
}

/**
 * 채움을 다음 상태로 넘긴다.
 *
 * 테두리(선)는 그대로 두고 **채움 조각만 다시 칠한다** — 그래야 그 표시를 골라 둔 상태와
 * 그 옆 도구모음이 그대로 있고, 되돌리기도 한 칸으로 깔끔하게 쌓인다(채움 조각은 되돌리기에
 * 따로 쌓이지 않게 만들기 때문이다). 도형의 색·채우기를 나중에 고치는 것과 같은 방식이다.
 */
function toggleShapeFill(strokeEditor) {
  const info = toggleInfoFor(strokeEditor);
  if (!info) return false;
  const before = info.fillState ? 1 : 0;
  const after = before ? 0 : 1;
  uiManager()?.addCommands({
    cmd: () => { info.fillState = after; repaintFills(info); },
    undo: () => { info.fillState = before; repaintFills(info); },
    mustExec: true,
  });
  return true;
}

// --------------------------------------------- Shift 누르고 크기 조절 (2026-09-04 CM 지시)
//
// PDF.js는 모서리 손잡이만 가로세로를 같은 비율로 늘리고, 변 가운데 손잡이는 한쪽만 늘린다.
// 그래서 블라인드처럼 동그라미가 든 도형을 변 손잡이로 늘리면 동그라미가 찌그러졌다.
// PPT와 같게, **Shift를 누른 채 크기를 조절하면 변 손잡이도 비율을 지키게** 한다.
//
// PDF.js 안쪽(#resizerPointermove)은 고칠 수 없으므로, 그쪽이 크기를 정한 바로 다음에 불러 주는
// _onResizing에서 값을 바로잡는다. 붙잡혀 있는 쪽(반대편 변)은 그대로 두고 나머지만 늘린다.

let shiftHeld = false;      // 지금 Shift를 누르고 있는지 (마우스가 움직일 때마다 새로 본다)
let resizeGesture = null;   // { editor, name, x0, y0, w0, h0 } — 크기 조절을 시작한 순간의 자리

// 손잡이를 누른 순간의 자리를 적어 둔다. 손잡이는 주석을 처음 골랐을 때 만들어지므로,
// 고르는 자리(wrapEditorSelect)에서 한 번만 붙인다.
function hookResizers(shapeEditor) {
  if (shapeEditor._dmsResizeHooked) return;
  const resizers = shapeEditor.div?.querySelector(".resizers");
  if (!resizers) return;
  shapeEditor._dmsResizeHooked = true;
  resizers.addEventListener("pointerdown", (e) => {
    const name = e.target?.dataset?.resizerName;
    if (!name) return;
    resizeGesture = {
      editor: shapeEditor, name,
      x0: shapeEditor.x, y0: shapeEditor.y, w0: shapeEditor.width, h0: shapeEditor.height,
    };
  }, true);
}

// 크기가 바뀔 때마다 불리는 자리를 감싼다. 우리 일을 먼저 하고 원래 하던 일(채움 따라 옮기기 등)을
// 그대로 이어서 하므로, 채움도 바로잡은 크기를 따라온다.
function wrapResizeKeepRatio(shapeEditor) {
  if (shapeEditor._dmsResizeWrapped) return;
  shapeEditor._dmsResizeWrapped = true;
  const original = shapeEditor._onResizing.bind(shapeEditor);
  shapeEditor._onResizing = () => {
    try {
      keepRatioIfShift(shapeEditor);
    } catch { /* 바로잡기가 실패해도 크기 조절 자체는 멈추지 않게 한다 */ }
    original();
  };
}

function keepRatioIfShift(shapeEditor) {
  const gesture = resizeGesture;
  if (!shiftHeld || !gesture || gesture.editor !== shapeEditor) return;
  const { name, x0, y0, w0, h0 } = gesture;
  if (!w0 || !h0) return;

  const horizontal = name === "middleLeft" || name === "middleRight";
  const vertical = name === "topMiddle" || name === "bottomMiddle";
  if (!horizontal && !vertical) return; // 모서리 손잡이는 PDF.js가 이미 비율을 지킨다

  // 늘어난 만큼을 그대로 반대 방향에도 적용한다(쪽 밖으로 나가지 않게 한계도 둔다).
  const grown = horizontal ? shapeEditor.width / w0 : shapeEditor.height / h0;
  const ratio = Math.min(grown, 1 / w0, 1 / h0);
  const width = w0 * ratio;
  const height = h0 * ratio;

  // 붙잡혀 있는 쪽 — 반대편 변은 제자리, 그 변의 한가운데를 기준으로 늘어난다.
  const anchorX = name === "middleLeft" ? x0 + w0 : name === "middleRight" ? x0 : x0 + w0 / 2;
  const anchorY = name === "topMiddle" ? y0 + h0 : name === "bottomMiddle" ? y0 : y0 + h0 / 2;

  shapeEditor.width = width;
  shapeEditor.height = height;
  shapeEditor.x = name === "middleLeft" ? anchorX - width
    : name === "middleRight" ? anchorX : anchorX - width / 2;
  shapeEditor.y = name === "topMiddle" ? anchorY - height
    : name === "bottomMiddle" ? anchorY : anchorY - height / 2;
  shapeEditor.setDims();
  shapeEditor.fixAndSetPosition();
}

export function installShapeTool(pdfViewerApplication) {
  app = pdfViewerApplication;
  buildUi();
  watchUiManager(app);
  registerCustomTool("shape", (keepMode) => deactivate({ keepMode }));

  // 강조 표시 두께 막대(dms-tools.js)가 골라 둔 띠를 다시 만들 수 있게 자리를 채운다.
  highlightBandHooks.restyleThickness = restyleSelectedBandThickness;

  // 그리기 도구창의 선 타입 칸(dms-tools.js)이 골라 둔 선을 다시 그릴 수 있게 자리를 채운다.
  inkLineTypeHooks.restyleLineType = restyleSelectedInkLineType;

  // 표시 옆 작은 도구모음(dms-edit-toolbar.js)이 [채움 전환] 버튼을 만들 수 있게 자리를 채운다.
  shapeToolbarHooks.canToggleFill = (strokeEditor) => !!toggleInfoFor(strokeEditor);
  shapeToolbarHooks.toggleFill = toggleShapeFill;

  // Ctrl+끌기 복사(dms-copy.js)가 우리 표시를 원본 그대로 다시 만들 수 있게 자리를 채운다.
  copyHooks.recipeFor = copyRecipeFor;
  copyHooks.duplicate = duplicateFromRecipe;

  // [회전](dms-rotate.js)이 우리 표시를 돌린 모습으로 다시 만들 수 있게 자리를 채운다.
  rotateHooks.pivotFor = rotationPivotFor;
  rotateHooks.rotateOwn = rotateOwnMarkup;

  document.getElementById("viewerContainer")
    .addEventListener("pointerdown", onPointerDown, true);

  // Shift를 누르고 크기를 조절하는지 본다. PDF.js가 크기를 계산하기 **전에** 알아야 하므로
  // 잡아채는 자리(capture)에 먼저 걸어 둔다 — PDF.js는 손잡이를 누른 뒤에 자기 것을 건다.
  window.addEventListener("pointermove", (e) => { shiftHeld = e.shiftKey; }, true);
  window.addEventListener("pointerup", () => { resizeGesture = null; }, true);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      endChaining(); // 이어 긋기 그만두기
      if (state.on) {
        if (drag) cancelDrag();
        else deactivate();
      }
      return;
    }
    // Alt + 좌우 화살표 = 15도씩 회전, Ctrl까지 같이 누르면 1도씩 (PPT와 같다)
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (!focusedShape()) return; // 고른 도형이 없으면 브라우저의 앞으로·뒤로 가기를 막지 않는다
      const step = (e.ctrlKey ? ROTATE_FINE : ROTATE_STEP) * (e.key === "ArrowRight" ? 1 : -1);
      rotateFocusedShape(step);
      e.preventDefault();  // 브라우저의 "앞으로·뒤로 가기"가 같이 일어나지 않게 막는다
      e.stopPropagation();
    }
  }, true);

  // Ctrl에서 손을 떼면 이어 긋기는 끝난다.
  // (Shift는 수평·수직으로 맞출 뿐이라 떼어도 이어 긋기는 계속된다 — 방향만 자유로워진다.)
  window.addEventListener("keyup", (e) => {
    if (chainEnd && e.key === "Control") endChaining();
  }, true);

  // 이어 긋는 중에는 다음 선이 마우스를 따라다닌다(한붓그리기).
  window.addEventListener("pointermove", onChainHoverMove);

  // 펜으로 한 획을 긋고 손을 떼면 그 자리에서 획을 마무리한다 (2026-09-05 CM 지시).
  // PDF.js는 획을 그어도 "그리는 중"으로 붙들고 있다가 다른 곳을 눌러야 주석으로 만드는데,
  // 그 사이에는 ㉠[이동]·[휴지통]이 안 뜨고 ㉡이어 그은 획이 전부 한 주석이라 도구창에서 색을
  // 바꾸면 그 획들이 통째로 바뀌었다. 마무리하면 획 하나가 곧 주석 하나가 되어 방금 그은 것만
  // 골라지고, 색·두께를 바꾸면 그것만 바뀐다.
  window.addEventListener("pointerup", finishPenStrokeSoon);

  // 자료가 열리기 전에는 다른 편집 버튼들처럼 눌리지 않게 둔다.
  app.eventBus.on("documentloaded", () => { button.disabled = false; });
  if (app.pdfDocument) button.disabled = false;

  // 도형 도구는 "그리기" 편집 상태를 빌려 쓴다(activate 참고). 그래서 그 상태가 유지되는 동안은
  // 그리기 버튼만 눌리지 않은 것처럼 정리해주고, 사용자가 다른 도구(강조·텍스트·이미지)를 켜거나
  // 그리기 버튼을 눌러 편집을 끄면 도형 도구도 함께 꺼진다.
  app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
    currentMode = mode;
    endChaining();
    if (state.on) {
      if (mode === AnnotationEditorType.INK) hideInkToolbarLook();
      else deactivate({ keepMode: true });
    }
    // 도구가 바뀌었으니 [도형] 버튼의 눌린 표시를 다시 맞춘다.
    reflectShapeSelection();
  });
}
