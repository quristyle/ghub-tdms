// 도구들이 지금 어떤 색·두께·크기로 그리는지, 그리고 우리가 덧붙인 도구 중 무엇이 켜져 있는지를
// 한곳에 모아 둔 값 — 원래 PDF.js에는 없다 (2026-09-02).
//
// dms-tools.js가 도구모음 칸을 만들면서 toolState를 채우고, dms-shapes.js가 Shift로 곧은 선을
// 그을 때 그 값을 읽어 같은 색·같은 두께로 긋는다. 두 파일이 각자 값을 들고 있으면 어긋나므로
// 여기 하나만 둔다.

// 강조 표시(형광펜)를 처음 켰을 때의 두께 (2026-09-04 CM 지시).
// PDF.js가 들고 있는 값은 12라서, 도구를 켤 때 이 값으로 바꿔 준다(dms-tools.js 참고).
// 그래서 "지금 두께"(toolState)와 따로 둔다 — toolState는 쓰는 동안 계속 바뀌는 값이다.
export const HIGHLIGHT_DEFAULT_THICKNESS = 5;

export const toolState = {
  // 그리기(펜) — lineType은 선 모양(실선·점선·파선·구름, 2026-09-04 CM 지시)
  ink: { color: "#e02020", thickness: 1, opacity: 1, lineType: "solid" },
  highlight: { color: "#ffe03d", thickness: HIGHLIGHT_DEFAULT_THICKNESS, opacity: 1 }, // 형광펜(첫 색은 dms-colors.js의 맨 앞과 같아야 한다)
  text: { color: "#e02020", size: 10, background: null },   // 텍스트 (background=null이면 배경 안 칠함)
};

// 그려 둔 강조 표시 띠의 두께를 나중에 바꾸는 일은 dms-shapes.js가 하고, 두께 막대는
// dms-tools.js가 갖고 있다. 두 파일이 서로를 곧바로 부르면 서로를 물게 되므로(순환) 여기에
// 자리만 두고, dms-shapes.js가 붙을 때 채운다 (2026-09-04 CM 지시).
// 도형·지우개가 setCustomTool로 서로를 부르는 것과 같은 방식이다.
export const highlightBandHooks = { restyleThickness: null };

// [Text 선택]이 꺼져 있는지 — 자료에 적힌 글자를 마우스로 못 고르게 막아 둔 상태다.
// 도구모음의 그 스위치(dms-tools.js)가 값을 넣고, 형광펜을 손으로 그을 때(dms-shapes.js)
// 읽는다 — 켜져 있으면 글자를 따라 칠하는 것이 그 도구의 일이라 PDF.js에 맡기고,
// 꺼져 있으면 우리가 지나온 자리 그대로 칠한다 (2026-09-04 CM 지시).
export const textSelect = { locked: true };

// 그려 둔 표시를 골랐을 때 그 옆에 뜨는 작은 도구모음(dms-edit-toolbar.js)이 [채움 전환]
// 버튼을 만들지 정할 때 쓴다. 실제 판단·전환은 도형 도구(dms-shapes.js)가 하는데, 두 파일이
// 서로를 곧바로 부르면 서로를 물게 되므로(순환) 여기에 자리만 두고 도형 도구가 붙을 때 채운다.
export const shapeToolbarHooks = { canToggleFill: null, toggleFill: null };

// 그려 둔 펜 선의 "선 타입"(실선·점선·파선·구름)을 나중에 바꾸는 일은 dms-shapes.js가 하고,
// 그것을 고르는 칸은 dms-tools.js가 갖고 있다. 두 파일이 서로를 곧바로 부르면 서로를 물게
// 되므로(순환) 여기에 자리만 두고 dms-shapes.js가 붙을 때 채운다 (2026-09-05 CM 지시).
export const inkLineTypeHooks = { restyleLineType: null };

// Ctrl+끌기 복사(dms-copy.js)가 도형 도구(dms-shapes.js)에게 물어보는 자리 (2026-09-07 CM 지시).
// 우리가 만든 표시(도형·형광펜 띠·펜 선)는 "무엇으로 만들었는지"(모양·점 목록·선 타입)를 알고
// 있어서, 그 값으로 다시 만들면 복사본도 원본과 똑같이 회전·채움 전환·두께 변경까지 된다.
// 모르는 표시(문구·도장 등)는 recipeFor가 null을 돌려주고, 그때는 dms-copy.js가 PDF.js의
// 복사·붙여넣기 방식으로 베낀다. 여기에 자리만 두는 이유는 위 hooks들과 같다(서로 물지 않게).
export const copyHooks = { recipeFor: null, duplicate: null };

// [회전](dms-rotate.js)이 도형 도구(dms-shapes.js)에게 부탁하는 자리 (2026-09-18 CM 지시).
//   pivotFor(editor)            : 우리 도형이면 돌리는 중심(도형 네모의 한가운데, PDF 좌표). 아니면 null
//   rotateOwn(editor, deg, turn) : 우리 표시(도형·형광펜 띠)와 펜 선을 돌린 모습으로 새로 만든다.
//                                 다루지 않는 표시(문구·도장 등)는 null — 그때는 dms-rotate.js가 맡는다.
// 여기에 자리만 두는 이유는 위 hooks들과 같다(서로 물지 않게).
export const rotateHooks = { pivotFor: null, rotateOwn: null };

// 문구(텍스트)의 "글자 배경 칠하기"를 읽고 까는 자리 — dms-tools.js가 채운다 (2026-09-18).
// 문구를 돌리면 새 문구가 만들어지므로, 원래 문구에 깔려 있던 배경을 새 문구에도 다시 깔아야 한다.
export const textBackgroundHooks = { colorOf: null, apply: null };

// 표시를 골랐을 때 그 옆 작은 도구모음(dms-edit-toolbar.js)의 [회전] 버튼이 부르는 자리 —
// dms-rotate.js가 붙을 때 채운다. 비어 있으면(회전을 끈 경우) [회전] 버튼이 생기지 않는다.
export const rotateTool = { canRotate: null, start: null };

// 도구모음의 [회전](손 도구와 이동 사이)이 켜져 있는지 — dms-tools.js가 정하고 dms-rotate.js가 읽는다.
// 켜져 있으면 그려 둔 표시를 잡고 끌 때 옮기지 않고 돌린다.
export const rotateMode = { on: false };

// 도구창(색·두께를 고르는 작은 창)을 계속 열어 둘지 — 도구모음의 [도구창 고정]이 정한다
// (2026-09-04 CM 지시). 켜져 있으면 창 밖을 눌러도 안 닫히고 도구 아이콘을 한 번 더 눌러야
// 닫힌다. 끄면 창 밖을 누르는 순간 창만 닫힌다(도구는 켜진 채). 기본은 켜짐.
// PDF.js가 원래 갖고 있던 도구창(강조 표시·텍스트·그리기·이미지)과 우리가 만든 도구창
// (도형·스탬프)이 같이 보는 값이라 여기 하나만 둔다.
export const panelPin = { on: true };

// 우리가 덧붙인 도구(도형·지우개)는 둘 다 PDF.js의 "그리기" 편집 상태를 빌려 쓰기 때문에,
// 동시에 켜지면 마우스를 서로 가로채 엉뚱하게 움직인다. 그래서 한 번에 하나만 켜지게 한다.
export const customTool = { name: null };

const turnOff = new Map();
const watchers = new Set();

/** 도구를 등록한다. name은 "shape"·"eraser" 같은 이름, off(keepMode)는 그 도구를 끄는 함수 */
export function registerCustomTool(name, off) {
  turnOff.set(name, off);
}

/** 켜진 도구가 바뀔 때마다 알려준다 — 도구모음 버튼의 눌린 표시를 맞추는 데 쓴다 */
export function onCustomToolChange(fn) {
  watchers.add(fn);
}

function notify() {
  for (const fn of watchers) {
    try {
      fn(customTool.name);
    } catch {
      /* 한 곳이 실패해도 도구 전환 자체는 계속되게 한다 */
    }
  }
}

/**
 * 도구를 켠다(끌 때는 null). 켜져 있던 다른 도구는 자동으로 꺼진다.
 * keepMode=false면 끄면서 PDF.js의 편집 상태(그리기)까지 함께 끈다.
 */
export function setCustomTool(name, keepMode = true) {
  const previous = customTool.name;
  customTool.name = name;
  if (previous && previous !== name) turnOff.get(previous)?.(keepMode);
  if (previous !== name) notify();
}

/** 도구가 스스로 꺼졌을 때(다른 도구 버튼을 눌러 편집이 바뀐 경우 등) 표시만 맞춰 준다 */
export function clearCustomTool(name) {
  if (customTool.name !== name) return;
  customTool.name = null;
  notify();
}

// PDF.js에서 편집(주석)을 총괄하는 객체. 자료를 열 때마다 새로 만들어지므로 미리 받아두면 안 되고,
// PDF.js가 만들면서 알려주는 연락(annotationeditoruimanager)을 받아 여기에 담아 둔다.
// 도형·지우개가 되돌리기 목록에 올리거나 표시를 찾을 때 쓴다.
export const editor = { uiManager: null };

export function watchUiManager(app) {
  if (editor.watching) return;
  editor.watching = true;
  app.eventBus.on("annotationeditoruimanager", ({ uiManager }) => {
    editor.uiManager = uiManager;
  });
  // 이미 자료가 열려 있는 상태에서 붙는 경우를 위해 한 번 더 확인한다.
  editor.uiManager ||= app.pdfViewer._layerProperties?.annotationEditorUIManager || null;
}
