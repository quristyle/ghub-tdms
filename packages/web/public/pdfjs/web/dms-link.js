// 도면관리시스템이 덧붙인 "두 조각을 하나처럼 묶기" — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
//
// 왜 필요한가: PDF 주석 하나에는 색을 하나만 넣을 수 있어서, PDF.js는 "테두리 색"과 "채우기 색"을
// 한 주석에 같이 저장하지 못한다. 그래서 색을 채운 도형과 배경을 칠한 글자는 조각 둘로 만든다.
//   뒤 조각(back) : 채움(형광펜과 같은 방식으로 칠한 면)
//   앞 조각(main) : 테두리 선 또는 글자
// 두 조각이 따로 놀지 않도록 여기서 붙여 놓는다. 앞 조각을 옮기거나 크기를 바꾸거나 지우거나
// 되살리면 뒤 조각도 똑같이 따라간다. 뒤 조각은 마우스를 아예 받지 않으므로(아래 pointerEvents)
// 사용자가 실수로 뒤 조각만 집는 일은 없다.
//
// 뒤 조각은 **여럿일 수 있다** (2026-09-04 CM 지시) — 스펙타클 블라인드는 동그라미 둘을 서로 다른
// 색으로 칠하므로 채움 조각이 둘이다. 여럿이어도 다루는 방법은 하나일 때와 똑같다.
//
// 붙이는 코드를 이 파일 한 곳에만 두는 이유는, 도형 채우기(dms-shapes.js)와 글자 배경(dms-tools.js)이
// 같은 규칙으로 움직여야 하기 때문이다.

const boxOf = (editor) => ({ x: editor.x, y: editor.y, width: editor.width, height: editor.height });

/** 앞 조각에 붙어 있는 뒤 조각들 (없으면 빈 배열) */
export function backgroundsOf(editor) {
  return editor?._dmsBacks || [];
}

/** 붙어 있는 뒤 조각을 전부 치운다 (채움을 없앨 때) */
export function clearBackgrounds(main) {
  if (!main) return;
  for (const back of backgroundsOf(main)) back.remove();
  main._dmsBacks = [];
  main._dmsBackBoxes = [];
}

/** 뒤 조각인지 — 지우개·선택 등에서 이것만 따로 다루지 않도록 확인할 때 쓴다 */
export function isBackground(editor) {
  return !!editor?._dmsIsBack;
}

/**
 * 뒤 조각(back)을 앞 조각(main)에 붙인다. 여러 개면 배열로 넘긴다.
 * 붙인 뒤로는 main만 만지면 back들이 알아서 따라온다.
 */
export function attachBackground(main, backOrList) {
  const backs = (Array.isArray(backOrList) ? backOrList : [backOrList]).filter(Boolean);

  // 이미 다른 채움이 붙어 있으면 그것을 치우고 새것으로 갈아 끼운다
  // (글자를 고쳐 칸 크기가 달라졌을 때 배경을 새로 깔기 위해).
  clearBackgrounds(main);
  main._dmsBacks = backs;
  for (const back of backs) {
    back._dmsIsBack = true;
    markAsBackground(back);
  }

  // 붙일 때의 자리·크기를 기억해 둔다. 나중에 앞 조각이 얼마나 움직이고 커졌는지를
  // 이 값과 견주어 계산하므로, 두 조각의 테두리 여백이 서로 달라도 어긋나지 않는다.
  main._dmsMainBox = boxOf(main);
  main._dmsBackBoxes = backs.map(boxOf);

  if (main._dmsLinked) return; // 아래 연결은 자료 하나에 한 번만 걸면 된다
  main._dmsLinked = true;

  wrap(main, "_onTranslating", () => sync(main));
  wrap(main, "_onTranslated", () => sync(main));
  wrap(main, "_onResizing", () => sync(main));
  wrap(main, "_onResized", () => sync(main));
  wrap(main, "remove", () => { for (const back of backgroundsOf(main)) back.remove(); });
  // 되살릴 때는 뒤 조각을 **앞 조각보다 먼저** 되돌려야 채움이 테두리 밑에 깔린다
  // (나중에 그린 것이 위에 보이기 때문). 그래서 이 둘만 원래 일보다 앞서 실행한다.
  wrap(main, "rebuild", () => restore(main), { first: true });
  wrap(main, "onceAdded", () => restore(main), { first: true });
}

// 뒤 조각은 마우스를 받지 않는다 — 누르면 언제나 앞 조각이 잡힌다.
// 안쪽 조각까지 막아야 하므로(겉껍데기만 막으면 PDF.js가 만들어 둔 안쪽이 마우스를 받는다)
// 실제로 막는 일은 dms-tools.css의 .dmsBackPiece가 한다. 되살아날 때 칸이 다시 만들어질 수
// 있어 그때마다 다시 붙여 준다.
function markAsBackground(back) {
  if (!back.div) return;
  back.div.style.pointerEvents = "none";
  back.div.classList.add("dmsBackPiece");
}

// 원래 하던 일은 그대로 하고 우리 일을 앞이나 뒤에 덧붙인다(PDF.js 원본은 건드리지 않는다).
function wrap(editor, name, extra, { first = false } = {}) {
  const original = editor[name].bind(editor);
  editor[name] = (...args) => {
    if (first) run(extra);
    const result = original(...args);
    if (!first) run(extra);
    return result;
  };
}

function run(extra) {
  try {
    extra();
  } catch {
    /* 뒤 조각 맞추기가 실패해도 앞 조각 동작은 멈추지 않게 한다 */
  }
}

// 지워졌던 뒤 조각을 제자리에 되돌린다.
// PDF.js의 editor.rebuild()는 붙어 있는 곳(parent)이 없으면 아무 일도 하지 않으므로,
// 붙일 곳부터 다시 찾아주는 uiManager.rebuild()를 써야 한다.
function restore(main) {
  for (const back of backgroundsOf(main)) {
    if (back.parent) continue;
    back._uiManager?.rebuild(back);
    markAsBackground(back);
  }
  sync(main);
}

function sync(main) {
  const backs = backgroundsOf(main);
  if (backs.length === 0) return;
  const m = main._dmsMainBox;
  const boxes = main._dmsBackBoxes || [];
  const scaleX = m.width ? main.width / m.width : 1;
  const scaleY = m.height ? main.height / m.height : 1;
  backs.forEach((back, i) => {
    const b = boxes[i];
    if (!back?.parent || !b) return;
    back.x = main.x + (b.x - m.x) * scaleX;
    back.y = main.y + (b.y - m.y) * scaleY;
    back.width = b.width * scaleX;
    back.height = b.height * scaleY;
    back.setDims();
    back.fixAndSetPosition();
    back._onResized();
  });
}
