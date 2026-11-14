// 그려 둔 표시를 골랐을 때 그 옆에 뜨는 작은 도구모음에 버튼을 더한다 (2026-09-04 CM 지시).
// 원래 PDF.js가 거기 두는 것은 [지우기](휴지통) 하나뿐이다.
//
//   [채움 전환] [회전] [이동] [휴지통]
//
//   이동      : 누른 채 끌면 그 표시가 따라 움직인다. 선이나 도형을 그린 직후에는 그리기 도구가
//               켜져 있어 표시를 바로 끌 수 없는데(끌면 새로 그려진다), 이 버튼으로 잡으면
//               도구를 끄지 않고 그 자리에서 옮길 수 있다.
//   회전      : 누른 채 끌면 마우스를 따라 돌아가고, 끌지 않고 한 번 누르면 시계방향으로 90도
//               돈다(2026-09-18 CM 지시). 모든 표시에 생긴다. 돌리는 일은 dms-rotate.js가 한다.
//   채움 전환 : 블라인드·스펙타클 블라인드·밸브를 칠했다 비웠다 한다(도형 도구가 맡는다).
//               그 셋이 아니면 이 버튼은 안 생긴다.
//
// 버튼 크기는 PDF.js가 휴지통에 쓰는 class(basic)를 그대로 써서 넷이 똑같다.
//
// 옮기는 일은 PDF.js가 원래 갖고 있는 것(setUpDragSession · dragSelectedEditors ·
// endDragSession)을 그대로 부르므로 되돌리기도 PDF.js가 챙기고, 도형에 딸린 채움도 함께 따라온다.
// PDF.js 안쪽 코드는 고치지 않고, 주석 하나를 만드는 자리(addEditToolbar)만 감싼다.

import { shapeToolbarHooks, rotateTool } from "./dms-state.js";

/**
 * 표시(주석) 하나가 처음 만들어질 때, 그 종류의 원형(prototype)에 한 번만 걸어 둔다.
 * 이렇게 해 두면 형광펜·글자·도형·도장 등 모든 종류가 같이 걸린다.
 */
function patchEditorPrototype(editorInstance) {
  let proto = Object.getPrototypeOf(editorInstance);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "addEditToolbar")) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto || proto._dmsToolbarPatched) return;
  proto._dmsToolbarPatched = true;

  const original = proto.addEditToolbar;
  proto.addEditToolbar = async function () {
    const toolbar = await original.call(this);
    try {
      if (toolbar) addOurButtons(this, toolbar);
    } catch (err) {
      console.warn("[dms] edit toolbar buttons failed:", err);
    }
    return toolbar;
  };
}

function addOurButtons(editorInstance, toolbar) {
  const buttons = toolbar.div?.querySelector(".buttons");
  const deleteButton = buttons?.querySelector(".deleteButton");
  if (!buttons || !deleteButton) return;
  // 이미 붙여 둔 도구모음이면 다시 붙이지 않는다(PDF.js는 한 번 만든 도구모음을 다시 쓴다).
  if (buttons.querySelector(".dmsMoveButton, .dmsRotateButton, .dmsToggleFillButton")) return;

  // 옮길 수 없는 종류(글자를 따라 칠한 형광펜 등)에는 이동 버튼을 두지 않는다 — 눌러도 할 일이 없다.
  const moveButton = editorInstance._isDraggable !== false ? makeMoveButton(editorInstance) : null;
  if (moveButton) deleteButton.before(moveButton);
  // [회전]은 이동 버튼 왼쪽에 둔다(이동이 없으면 휴지통 왼쪽) — 2026-09-18 CM 지시.
  const rotateButton = rotateTool.canRotate?.(editorInstance) ? makeRotateButton(editorInstance) : null;
  if (rotateButton) (moveButton || deleteButton).before(rotateButton);
  // [채움 전환]은 회전 버튼 왼쪽에 둔다(회전·이동이 없으면 그다음 버튼 왼쪽).
  if (shapeToolbarHooks.canToggleFill?.(editorInstance)) {
    (rotateButton || moveButton || deleteButton).before(makeToggleButton(editorInstance));
  }
}

function makeButton(className, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.tabIndex = 0;
  button.className = `basic ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function makeToggleButton(editorInstance) {
  const button = makeButton("dmsToggleFillButton", "채움 전환");
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    shapeToolbarHooks.toggleFill?.(editorInstance);
  });
  return button;
}

// 누른 채 끌면 돌아가고, 끌지 않고 누르기만 하면 시계방향으로 90도 돈다(dms-rotate.js).
function makeRotateButton(editorInstance) {
  const button = makeButton("dmsRotateButton", "회전");
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    rotateTool.start?.(editorInstance, e, { clickTurn: 90 });
  });
  return button;
}

function makeMoveButton(editorInstance) {
  const button = makeButton("dmsMoveButton", "이동");
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    startMove(editorInstance, e);
  });
  return button;
}

/** 이동 버튼을 누른 채 끄는 동안 그 표시를 따라 움직인다 */
function startMove(editorInstance, event) {
  const uiManager = editorInstance._uiManager;
  if (!uiManager) return;
  // 끌기는 "골라 둔 표시"를 옮기는 것이므로, 아직 안 골라져 있으면 먼저 고른다.
  if (!editorInstance.isSelected) uiManager.setSelected(editorInstance);
  uiManager.setUpDragSession();

  let prevX = event.clientX;
  let prevY = event.clientY;

  const onMove = (e) => {
    const [tx, ty] = editorInstance.screenToPageTranslation(e.clientX - prevX, e.clientY - prevY);
    prevX = e.clientX;
    prevY = e.clientY;
    uiManager.dragSelectedEditors(tx, ty);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("blur", onUp, true);
    uiManager.endDragSession(); // 옮긴 만큼이 되돌리기 목록에 한 번 쌓인다
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("blur", onUp, true);
}

export function installEditToolbarExtras(app) {
  // 표시가 하나 만들어질 때를 알아채려고 PDF.js가 쓰는 add를 감싼다(원래 하던 일은 그대로 한다).
  app.eventBus.on("annotationeditorlayerrendered", ({ source }) => {
    const layer = source?.annotationEditorLayer?.annotationEditorLayer;
    if (!layer) return;
    const proto = Object.getPrototypeOf(layer);
    if (proto._dmsAddPatched) return;
    proto._dmsAddPatched = true;
    const originalAdd = proto.add;
    proto.add = function (editorToAdd) {
      originalAdd.call(this, editorToAdd);
      try {
        if (editorToAdd) patchEditorPrototype(editorToAdd);
      } catch {
        /* 버튼을 못 붙여도 표시를 넣는 일 자체는 그대로 된다 */
      }
    };
  });
}
