// 도면관리시스템이 덧붙인 "지우개" 도구 — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
//
// 하는 일: 지우개를 켜고 표시(형광펜·펜 선·글자·도형) 위를 문지르면 그 표시가 지워진다.
// **표시 하나가 통째로 지워진다** — 선의 일부만 잘라내지는 않는다. PDF 주석은 "선 하나"가
// 가장 작은 단위라, 일부만 지우려면 주석을 잘라 다시 만들어야 하고 그러면 되돌리기·저장이
// 얽히기 때문이다. (일부만 지우는 것이 필요하면 CM 지시로 따로 만든다.)
//
// 지운 것은 Ctrl+Z로 되살아난다. 한 번 문지르는 동안 지워진 것은 한 번에 되살아난다.

import { isBackground } from "./dms-link.js";
import {
  registerCustomTool, setCustomTool, clearCustomTool, editor, watchUiManager,
} from "./dms-state.js";

const { AnnotationEditorType } = globalThis.pdfjsLib;

let app = null;
// PDF.js의 편집 총괄 — 자료를 열 때마다 새로 만들어지므로 쓸 때마다 가져온다(dms-state.js).
const uiManager = () => editor.uiManager;
let button = null;
let erasing = null; // 문지르는 중일 때 { removed: [...] }
const state = { on: false };

function buildUi() {
  const box = document.createElement("div");
  box.id = "dmsEraser";
  box.className = "toolbarButtonWithContainer";
  box.innerHTML = `
    <button id="dmsEraserButton" class="toolbarButton" type="button" tabindex="0"
            disabled="disabled" title="지우개">
      <span>지우개</span>
    </button>`;
  document.getElementById("dmsShape").after(box);
  button = document.getElementById("dmsEraserButton");
  button.addEventListener("click", () => (state.on ? deactivate() : activate()));
}

function activate() {
  // 편집 상태가 아니면 PDF.js가 표시들을 잠가버려(pointer-events: none) 마우스가 닿지 않는다.
  // 도형 도구와 같은 이유로 "그리기" 편집 상태를 빌려 쓰고, 그리기 버튼이 눌린 것처럼 보이는
  // 모양만 되돌린다.
  setCustomTool("eraser");
  app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.INK };
  state.on = true;
  button.classList.add("toggled");
  document.getElementById("viewerContainer").classList.add("dmsEraserMode");
  const inkButton = document.getElementById("editorInkButton");
  inkButton?.classList.remove("toggled");
  inkButton?.setAttribute("aria-expanded", "false");
  document.getElementById("editorInkParamsToolbar")?.classList.add("hidden");
}

function deactivate({ keepMode = false } = {}) {
  clearCustomTool("eraser");
  state.on = false;
  button.classList.remove("toggled");
  document.getElementById("viewerContainer").classList.remove("dmsEraserMode");
  clearHint();
  finishStroke();
  if (!keepMode) app.pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
}

// 마우스 밑에 있는 표시를 찾는다(뒤에 깔린 채움 조각은 앞 조각과 한 몸이라 따로 잡지 않는다).
function editorAt(target) {
  const div = target?.closest?.(".annotationEditorLayer > *");
  const editor = div ? uiManager().getEditor(div.id) : null;
  return editor && !isBackground(editor) ? editor : null;
}

let hinted = null;

function showHint(editor) {
  if (hinted === editor) return;
  clearHint();
  hinted = editor;
  hinted?.div?.classList.add("dmsEraseTarget");
}

function clearHint() {
  hinted?.div?.classList.remove("dmsEraseTarget");
  hinted = null;
}

function eraseAt(target) {
  const editor = editorAt(target);
  if (!editor || erasing.removed.includes(editor)) return;
  clearHint();
  erasing.removed.push(editor);
  editor.remove(); // 채움 조각이 붙어 있으면 같이 지워진다 (dms-link.js)
}

function finishStroke() {
  const removed = erasing?.removed || [];
  erasing = null;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  if (removed.length === 0) return;
  // 한 번 문지른 것을 되돌리기 한 번으로 되살린다(이미 지웠으므로 mustExec은 false).
  uiManager().addCommands({
    cmd: () => removed.forEach((editor) => editor.remove()),
    undo: () => removed.forEach((editor) => uiManager().rebuild(editor)),
    mustExec: false,
  });
}

function onPointerDown(e) {
  if (!state.on || e.button !== 0) return;
  if (!e.target.closest(".page")) return;
  e.preventDefault();
  e.stopPropagation();
  erasing = { removed: [] };
  eraseAt(e.target);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function onPointerMove(e) {
  if (!erasing) return;
  eraseAt(document.elementFromPoint(e.clientX, e.clientY));
}

function onPointerUp() {
  finishStroke();
}

// 지우개를 켜고 표시 위에 올려 두면 지워질 것을 미리 흐리게 보여준다.
function onHover(e) {
  if (!state.on || erasing) return;
  showHint(editorAt(e.target));
}

export function installEraserTool(pdfViewerApplication) {
  app = pdfViewerApplication;
  buildUi();
  watchUiManager(app);
  registerCustomTool("eraser", (keepMode) => deactivate({ keepMode }));

  const container = document.getElementById("viewerContainer");
  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onHover, true);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.on) deactivate();
  }, true);

  app.eventBus.on("documentloaded", () => { button.disabled = false; });
  if (app.pdfDocument) button.disabled = false;

  // 다른 도구를 켜면 지우개는 꺼진다(도형 도구와 같은 방식).
  app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
    if (state.on && mode !== AnnotationEditorType.INK) deactivate({ keepMode: true });
  });
}
