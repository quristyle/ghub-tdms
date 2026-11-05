// 색으로 면을 칠하는 일만 모아 둔 곳 — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
// 도형 채우기(dms-shapes.js)와 글자 배경(dms-tools.js)이 똑같이 칠해져야 하므로 여기 한 곳에만 둔다.
//
// 칠하는 방법: PDF 주석 하나에는 색을 하나만 넣을 수 있어서 PDF.js는 "선 색"과 "채우기 색"을
// 한 주석에 같이 저장하지 못한다. 그래서 채움은 형광펜과 같은 주석으로 따로 만든다. 형광펜이
// 여러 줄짜리 글을 칠할 때 쓰는 "네모 여러 개를 한 면으로 합쳐 칠하기"를 그대로 쓰면 도형 안이
// 고르게 칠해지고, 도면이 비쳐 보이는 것도 형광펜과 같다.

import { fillBoxes, boundingBox } from "./dms-geometry.js";

const { AnnotationEditorType } = globalThis.pdfjsLib;

export function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 주석 하나를 만들어 넣는다.
 * undoable=false면 되돌리기 목록에 따로 쌓지 않고 초점(포커스)도 가져가지 않는다.
 *   ㉠ 채움 조각은 테두리와 한 몸이라 되돌리기에 따로 쌓이면 Ctrl+Z를 두 번 눌러야 하나가 없어진다.
 *   ㉡ 초점을 가져가면 PDF.js가 "형광펜을 고른 것"으로 보고 도구모음이 형광펜으로 바뀐다.
 */
export async function addEditor(layer, data, undoable = true) {
  const editor = await layer.deserialize(data);
  if (!editor) return null;
  if (undoable) {
    layer.add(editor);
    return editor;
  }
  // onceAdded는 되돌려 놓지 않고 아예 비워 둔다 — 나중에 되살아날 때도 되돌리기 목록에
  // 다시 쌓이거나 초점을 가져가면 안 되기 때문이다(그 자리는 앞 조각이 맡는다).
  editor.onceAdded = () => {};
  const originalUndoable = layer.addUndoableEditor;
  layer.addUndoableEditor = () => {};
  try {
    layer.add(editor);
  } finally {
    layer.addUndoableEditor = originalUndoable;
  }
  return editor;
}

/**
 * 채움 조각이 "겹쳐 칠하지 않고 그대로 덮도록" 표시를 달아 둔다 (2026-09-04 CM 지시).
 *
 * 형광펜 주석은 화면에서 겹쳐 칠하는 방식(mix-blend-mode)으로 그려져서, 진하기를 100%로 올려도
 * 밑에 있는 도면이 계속 비쳐 보인다. 도형 채우기는 완전 불투명이 되어야 하므로 이 표시를 달고,
 * 실제로 겹침 방식을 푸는 일은 dms-tools.css의 `.dmsOpaqueFill` 줄이 한다.
 *
 * 표시는 화면에 그려 놓은 그림(draw layer)에 다는 것이라, 그 그림이 다시 만들어질 때마다
 * (되돌리기·되살리기, 쪽을 벗어났다 돌아올 때) 다시 달아 줘야 한다.
 */
function markOpaqueFill(fillEditor) {
  markNormalBlendOnSave(fillEditor);
  const apply = () => {
    try {
      fillEditor.parent?.drawLayer?.updateProperties(fillEditor._drawId, {
        rootClass: { dmsOpaqueFill: true },
      });
    } catch {
      /* 표시를 못 달아도 채움 자체는 그려져 있으므로 넘어간다 */
    }
  };
  apply();
  const originalSetParent = fillEditor.setParent.bind(fillEditor);
  fillEditor.setParent = (parent) => { originalSetParent(parent); apply(); };
  const originalRebuild = fillEditor.rebuild.bind(fillEditor);
  fillEditor.rebuild = () => { originalRebuild(); apply(); };
}

/**
 * 저장한 PDF에서도 이 채움이 "겹쳐 칠하지 않고 그대로 덮도록" 표시를 실어 보낸다
 * (2026-09-04 CM 지시).
 *
 * 화면은 위 markOpaqueFill이 이미 그렇게 만들어 두었지만, 저장 파일에 적히는 겹침 방식은
 * PDF.js 안쪽이 정한다. 그쪽이 이 값을 읽도록 고쳐 두었으므로(build/pdf.worker.mjs의 [DMS 수정])
 * 여기서 값만 실어 보내면 된다. 값이 없으면 그쪽 기본값인 "어두운 쪽 남기기"가 쓰인다.
 */
function markNormalBlendOnSave(fillEditor) {
  if (fillEditor._dmsBlendMarked) return;
  fillEditor._dmsBlendMarked = true;
  const original = fillEditor.serialize.bind(fillEditor);
  fillEditor.serialize = (...args) => {
    const data = original(...args);
    if (data) data.blendMode = "Normal";
    return data;
  };
}

/**
 * PDF.js가 칠하는 주석(형광펜)을 그릴 때 테두리를 바깥으로 얼마나 넓히는지 (PDF 단위).
 *
 * PDF.js는 채움 주석의 테두리를 페이지 크기의 0.001만큼 바깥으로 넓힌다(HighlightOutline.build의
 * borderWidth + 자리 반올림). 그대로 두면 칠한 자리가 도형·글자 윤곽선 밖으로 삐져나오므로,
 * 넓어지는 만큼 먼저 안으로 줄여서 딱 맞게 한다 (2026-09-04 CM 지시). 값(0.001)이 PDF.js 안쪽
 * 상수라, 나중에 PDF.js를 새 버전으로 올릴 때 칠이 다시 삐져나오면 이 값을 맞춰야 한다.
 * 도형·글자 배경 채우기(addPolygonFill)와 직각으로 꺾이는 형광펜 띠(dms-shapes.js)가 함께 쓴다.
 */
export function highlightBorderInset(pageView) {
  const EXPAND = 0.0011; // 0.001(borderWidth) + 0.0001(자리 반올림)
  const [vx0, vy0, vx1, vy1] = pageView.viewport.viewBox;
  return { x: Math.abs(vx1 - vx0) * EXPAND, y: Math.abs(vy1 - vy0) * EXPAND };
}

/**
 * 닫힌 다각형(PDF 좌표) 안을 색으로 채운다.
 * opaqueBlend=true면 겹쳐 칠하지 않고 그대로 덮는다(도형 채우기 — 100%면 완전 불투명).
 * 글자 배경은 예전 그대로 형광펜처럼 비쳐 보이게 둔다.
 */
export async function addPolygonFill(pageView, layer, polygonPdf, { color, opacity = 1, opaqueBlend = false, undoable = true }) {
  const inset = highlightBorderInset(pageView);
  const quadPoints = fillBoxes(polygonPdf, inset.x, inset.y);
  if (quadPoints.length === 0) return null;
  const fillEditor = await addEditor(layer, {
    annotationType: AnnotationEditorType.HIGHLIGHT,
    color: hexToRgb(color),
    opacity,
    quadPoints,
    rect: boundingBox(polygonPdf),
    pageIndex: pageView.id - 1,
    rotation: 0,
  }, undoable);
  if (fillEditor && opaqueBlend) markOpaqueFill(fillEditor);
  return fillEditor;
}
