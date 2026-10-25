// 미리보기에서 그린 편집 내용을 보관하고 다시 되살리는 부분 (2026-09-05 CM 지시).
// G.Hub 도면관리시스템이 덧붙인 파일이다 — 원래 PDF.js에는 없다.
//
// 하는 일 셋.
//  ① 도구모음 오른쪽 끝 [»] 안에 [보관하기]·[다른 이름으로 보관] 두 버튼을 붙인다.
//     누르면 바깥 화면(우리 시스템 화면)의 보관 팝업이 열리고, 지금 그려 둔 편집 내용이 함께 보관된다.
//  ② 그려 둔 편집 내용을 모아 준다(window.dmsMarkup.collect) — 바깥 화면이 이걸 불러 서버로 보낸다.
//  ③ 주소에 fav 번호가 붙어 있으면 자료를 연 뒤 보관해 뒀던 편집 내용을 받아 그대로 되살린다.
//
// ## 두 버튼이 켜지고 꺼지는 규칙 (CM 지시)
//   · 그 자료를 아직 한 번도 보관한 적이 없다  → [보관하기]만 켜진다(처음 보관).
//     [다른 이름으로 보관]은 덮어쓸 원본이 없으므로 흐리게 잠근다.
//   · 이미 보관해 둔 것이 있고 편집한 것이 있다 → 둘 다 켜진다.
//     [보관하기]는 그 자리에 덮어쓰고, [다른 이름으로 보관]은 한 벌 더 보관한다.
//   · 이미 보관해 둔 것이 있는데 편집한 것이 없다 → 둘 다 잠근다.
//     똑같은 것이 두 벌 생기기만 하므로(중복 보관 금지).
// 버튼에 마우스를 올리면 왜 잠겼는지가 글로 뜬다.
//
// ## 편집 내용을 어떻게 보관하고 되살리는가
// PDF.js는 그려 둔 표시 하나하나를 "직렬화"할 수 있고(editor.serialize), 그 값을 그대로
// 편집 레이어에 되돌려 넣으면(layer.deserialize) 편집기가 다시 만들어진다 — PDF.js 자신이
// 복사·붙여넣기에 쓰는 길이라 우리가 새로 만든 것이 아니다. 그래서 되살아난 표시는 처음부터
// 그린 것과 똑같이 옮기고 지우고 색·두께를 바꿀 수 있다.
//
// 담는 값에는 Float32Array가 섞여 있어(선의 좌표) 그대로는 JSON이 되지 않는다. 그 자리만
// { __f32: [...] }로 감쌌다가 되살릴 때 도로 풀어 준다(pack/unpack).
//
// ## 되살린 표시의 한계 — 도형은 "그리기 주석"으로 돌아온다
// 우리가 만든 도형(사각형·밸브·스탬프 등)은 PDF.js의 그리기(잉크) 주석으로 만들어 넣은
// 것이라(D-72 ②), 되살리면 그 모양 그대로 보이고 옮기고 지울 수 있지만 "무슨 도형이었는지"는
// 남지 않는다. 그래서 [채움 전환]·회전처럼 도형인 것을 알아야 하는 것만 안 된다.
// 화면을 새로 고치면 그 전에 그린 도형도 같아지는 것(D-73 ⑧)과 같은 한계다.

const SAVE_BUTTON_ID = "dmsSaveFavoriteButton";
const SAVE_AS_BUTTON_ID = "dmsSaveAsFavoriteButton";

// JSON으로 담을 수 없는 값(Float32Array 등)을 감싼다.
function packMarkupValue(v) {
  if (ArrayBuffer.isView(v)) return { __f32: Array.from(v) };
  if (Array.isArray(v)) return v.map(packMarkupValue);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = packMarkupValue(v[k]);
    return o;
  }
  // NaN·Infinity는 JSON에 없는 값이라 null이 된다 — 선 좌표의 첫 조각이 NaN인 경우가 있어
  // 되살릴 때 그대로 NaN으로 돌려놓는다(unpack의 __f32 쪽에서 처리된다).
  return typeof v === "number" && !Number.isFinite(v) ? null : v;
}

function unpackMarkupValue(v) {
  if (v && typeof v === "object" && Array.isArray(v.__f32)) {
    return new Float32Array(v.__f32.map((n) => (n === null ? NaN : n)));
  }
  if (Array.isArray(v)) return v.map(unpackMarkupValue);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = unpackMarkupValue(v[k]);
    return o;
  }
  return v;
}

// 그려 둔 표시 하나를 담을 수 있는 값으로. 복사·붙여넣기용(serialize(true))을 먼저 쓰는 것은
// 그쪽이 그림(도장)의 실제 이미지까지 담아 주기 때문이고, 그 값이 비면 보관용을 쓴다
// (형광펜은 복사용을 만들지 않는다).
function serializeEditor(editor) {
  let data = null;
  try { data = editor.serialize(true); } catch (e) { data = null; }
  if (!data || !Object.keys(data).length) {
    try { data = editor.serialize(false); } catch (e) { data = null; }
  }
  return data ? packMarkupValue(data) : null;
}

function collectMarkup(app) {
  const uiManager = app.pdfViewer?._layerProperties?.annotationEditorUIManager;
  if (!uiManager) return [];
  // 적다 만 문구가 있으면 먼저 마무리한다 — 그래야 그 글자까지 담긴다.
  try { uiManager.endCurrentEditing?.(); } catch (e) { /* 편집 중이 아니면 넘어간다 */ }

  const out = [];
  for (let page = 0; page < app.pagesCount; page++) {
    let editors = [];
    try { editors = [...uiManager.getEditors(page)]; } catch (e) { editors = []; }
    for (const editor of editors) {
      if (editor.deleted) continue;
      const data = serializeEditor(editor);
      if (!data) continue;
      // 어느 쪽에 그린 것인지는 되살릴 때 꼭 필요하다(값이 비어 있는 경우가 있어 여기서 채운다).
      if (data.pageIndex === undefined || data.pageIndex === null) data.pageIndex = page;
      out.push(data);
    }
  }
  return out;
}

// 보관해 둔 편집 내용을 그대로 되돌려 놓는다. 쪽이 아직 그려지지 않았으면 그 쪽이 나타날 때까지 기다린다.
async function restoreMarkup(app, markup) {
  if (!markup || !markup.length) return 0;

  // 표시를 넣으려면 편집 상태여야 한다(편집 레이어가 있어야 하므로). 그리기 모드로 잠깐 들어갔다가
  // 다 넣고 나서 원래대로 끈다 — 사용자가 보기에는 평소처럼 열린 화면 그대로다.
  const prevMode = app.pdfViewer.annotationEditorMode;
  app.eventBus.dispatch("switchannotationeditormode", { source: null, mode: 15 /* INK */ });
  await new Promise((r) => setTimeout(r, 300));

  let restored = 0;
  for (const raw of markup) {
    const data = unpackMarkupValue(raw);
    const pageIndex = Number(data.pageIndex) || 0;
    // 기존 PDF 주석을 가리키는 값은 지운다 — 보관해 둔 것은 언제나 "새로 그리는 표시"다.
    delete data.id;
    data.isCopy = true;

    const layer = await editorLayerFor(app, pageIndex);
    if (!layer) continue;
    try {
      const editor = await layer.deserialize(data);
      if (editor) { layer.add(editor); restored++; }
    } catch (e) {
      console.warn("[DMS] 보관해 둔 편집 내용 하나를 되살리지 못했습니다", e);
    }
  }

  try { app.pdfViewer._layerProperties.annotationEditorUIManager?.unselectAll(); } catch (e) { /* 무시 */ }
  app.eventBus.dispatch("switchannotationeditormode", { source: null, mode: prevMode ?? 0 });
  return restored;
}

// 그 쪽의 편집 레이어. 표시를 얹으려면 이것이 있어야 하는데, PDF.js는 **화면에 보이는 쪽만**
// 그리고 그때 이 레이어를 만든다. 미리보기가 화면 아래에 있어 아직 안 보이는 경우(MDB 자료
// 상세보기가 그렇다)에는 아무리 기다려도 만들어지지 않으므로, 그 쪽을 그려 달라고 직접 청한다.
async function editorLayerFor(app, pageIndex) {
  const layerOf = () =>
    app.pdfViewer.getPageView(pageIndex)?.annotationEditorLayer?.annotationEditorLayer;
  const existing = layerOf();
  if (existing) return existing;

  const pageView = app.pdfViewer.getPageView(pageIndex);
  for (let i = 0; i < 100; i++) {
    // 그려 달라고 청한다(이미 그리는 중이면 아무 일도 일어나지 않는다).
    try { app.pdfViewer.renderingQueue?.renderView?.(pageView); } catch (e) { /* 무시 */ }
    await new Promise((r) => setTimeout(r, 100));
    const layer = layerOf();
    if (layer) return layer;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 지금 보고 있는 것이 어느 자료인가
// ---------------------------------------------------------------------------
// 주소의 file= 값(서버에서 PDF를 받는 주소)만 보고 정한다. 화면이 따로 실어 둔 값은 표마다
// 뜻이 제각각이라(반출이력은 반출 번호, 목록은 자료 번호…) 믿으면 엉뚱한 자료가 보관된다.
// 반입·검수의 확인필요 미리보기(/import-issues/…)는 아직 등록 전 파일이라 여기서 안 걸린다
// — 그런 자료는 보관할 수 없으므로 버튼도 생기지 않는다.
// 원본(DWG·엑셀 등) 미리보기 창이면(/preview/original/…, D-102) 그 원본 파일 번호로 자료를 찾는다.
function previewFileFromUrl() {
  const file = new URLSearchParams(window.location.search).get("file") || "";
  let m = /^\/files\/(\d+)\/view/.exec(file);
  if (m) return { kind: "TDB", pdfFileId: Number(m[1]) };
  m = /^\/mdb\/files\/(\d+)\/view/.exec(file);
  if (m) return { kind: "MDB", pdfFileId: Number(m[1]) };
  m = /^\/preview\/original\/(TDB|MDB)\/(\d+)\/view/.exec(file);
  if (m) return { kind: m[1], originalFileId: Number(m[2]) };
  return null;
}

// 같은 틀의 반대쪽 창(사본 창이면 원본 창, 원본 창이면 사본 창). 보관은 자료(원본+사본) 단위라
// 어느 쪽에서 [보관하기]를 누르든 두 창에 그린 편집 내용을 함께 담는다(D-102). 반대쪽 창을
// 한 번도 열지 않았으면 없다.
function siblingWindow(outerWindow) {
  try {
    return outerWindow?.dmsPreviewSibling?.(window) || null;
  } catch (e) {
    return null;
  }
}

function collectFrom(win) {
  try {
    return win?.dmsMarkup?.collect ? win.dmsMarkup.collect() : [];
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 도구모음 [»] 안의 [보관하기]·[다른 이름으로 보관]
// ---------------------------------------------------------------------------

function makeSecondaryButton(id, label) {
  const btn = document.createElement("button");
  btn.id = id;
  btn.type = "button";
  btn.className = "toolbarButton labeled";
  btn.tabIndex = 0;
  btn.innerHTML = `<span>${label}</span>`;
  return btn;
}

function installSaveButtons(app, outerWindow) {
  // 보관 팝업은 바깥 화면(우리 시스템)이 갖고 있다 — 미리보기 주소만 따로 열어 본 경우에는
  // 보관할 자리가 없으므로 버튼도 만들지 않는다.
  if (!outerWindow || typeof outerWindow.openFavoriteSaveDialog !== "function") return null;
  const source = previewFileFromUrl();
  if (!source) return null;

  const container = document.getElementById("secondaryToolbarButtonContainer");
  if (!container) return null;

  const saveBtn = makeSecondaryButton(SAVE_BUTTON_ID, "보관하기");
  const saveAsBtn = makeSecondaryButton(SAVE_AS_BUTTON_ID, "다른 이름으로 보관");
  const separator = document.createElement("div");
  separator.className = "horizontalToolbarSeparator";
  container.prepend(saveBtn, saveAsBtn, separator);

  // 이 자료를 이미 보관해 둔 것들. [»]를 열 때마다 다시 받아 버튼을 켜고 끈다.
  const state = {
    target: null,                  // { kind, documentId, mdbFileId, name, pdfFileId }
    saved: [],
    allSaved: [],                  // 보관해 둔 것 전부 — 보관 팝업의 "보관 위치" 표에 그대로 쓴다
    used: 0,
    limit: 50,
    // 덮어쓸 자리 — 보관해 둔 것을 열었으면(주소의 fav 번호) 그 자리, 아니면 이번에 보관한 자리.
    linkedId: Number(new URLSearchParams(window.location.search).get("fav")) || null,
  };

  async function reload() {
    try {
      const which = source.originalFileId
        ? `original_file_id=${source.originalFileId}`
        : `pdf_file_id=${source.pdfFileId}`;
      const res = await fetch(`/api/favorites/resolve/target?kind=${source.kind}&${which}`);
      if (!res.ok) { state.target = null; return; }
      const t = await res.json();
      state.target = {
        kind: t.kind, documentId: t.document_id, mdbFileId: t.mdb_file_id,
        name: t.name, pdfFileId: t.pdf_file_id,
      };
      state.saved = t.saved || [];
      state.allSaved = t.all_saved || [];
      state.used = t.used ?? 0;
      state.limit = t.limit ?? 50;
    } catch (e) {
      state.target = null;
    }
  }

  function hasEdits() {
    try {
      if (app._hasChanges && app._hasChanges()) return true;
      return !!siblingWindow(outerWindow)?.dmsMarkup?.hasChanges?.();
    } catch (e) { return false; }
  }

  function applyState() {
    const ready = !!state.target;
    const saved = state.saved.length > 0;
    const edited = hasEdits();

    // 처음 보관이면 [보관하기]만, 이미 보관해 둔 것이 있으면 편집했을 때만 둘 다 켜진다.
    const canSave = ready && (!saved || edited);
    const canSaveAs = ready && saved && edited;

    saveBtn.disabled = !canSave;
    saveAsBtn.disabled = !canSaveAs;
    saveBtn.title = canSave
      ? (saved ? "보관해 둔 자리에 덮어씁니다" : "")
      : (ready ? "이미 보관돼 있고 편집한 내용이 없습니다" : "이 자료는 보관할 수 없습니다");
    saveAsBtn.title = canSaveAs
      ? "이름을 새로 적어 한 벌 더 보관합니다"
      : (!ready ? "이 자료는 보관할 수 없습니다"
        : !saved ? "먼저 [보관하기]로 한 번 보관해야 쓸 수 있습니다"
          : "편집한 내용이 없습니다");
  }

  function openDialog(mode) {
    if (!state.target) return;
    app.secondaryToolbar?.close?.();
    const own = collectFrom(window);
    const other = collectFrom(siblingWindow(outerWindow));
    const onOriginal = !!source.originalFileId;
    outerWindow.openFavoriteSaveDialog({
      mode,
      target: state.target,
      saved: state.saved,
      allSaved: state.allSaved,
      markup: onOriginal ? other : own,           // 사본에 그린 것
      originalMarkup: onOriginal ? own : other,   // 원본 미리보기에 그린 것
      viewMode: source.originalFileId ? "original" : null,
      linkedId: state.linkedId,
      used: state.used,
      limit: state.limit,
      onSaved: (favId) => {
        // 다음 [보관하기]가 방금 보관한 자리를 덮어쓰도록 기억해 둔다.
        state.linkedId = favId;
        reload().then(applyState);
      },
      onChanged: () => {
        // 팝업에서 보관 자리를 지웠을 때 — 이 자료 것을 지웠으면 [다른 이름으로 보관]이 다시
        // 잠겨야 하고, 자리가 비었으면 "새로 보관"도 다시 열려야 하므로 상태를 새로 받는다.
        reload().then(applyState);
      },
    });
  }

  saveBtn.addEventListener("click", () => openDialog("save"));
  saveAsBtn.addEventListener("click", () => openDialog("saveAs"));

  // [»]를 여는 그 순간이 버튼을 보는 순간이므로, 그때 상태를 새로 맞춘다
  // (편집이 늘었는지·그 사이 다른 곳에서 보관했는지가 여기서 반영된다).
  document.getElementById("secondaryToolbarToggleButton")
    ?.addEventListener("click", () => { reload().then(applyState); }, true);

  applyState();
  reload().then(applyState);
  return state;
}

// ---------------------------------------------------------------------------
// 붙이기 — dms-viewer.js가 부른다
// ---------------------------------------------------------------------------

export function installFavoriteTool(app, outerWindow) {
  // 바깥 화면이 "지금 그려 둔 편집 내용"을 물어보는 창구. window.dmsMarkup은 dms-viewer.js가
  // 이미 만들어 둔 것이라 거기에 얹기만 한다(떠날 때 물어보는 hasChanges와 한 자리).
  window.dmsMarkup = window.dmsMarkup || {};
  window.dmsMarkup.collect = () => {
    try { return collectMarkup(app); } catch (e) { console.warn("[DMS]", e); return []; }
  };

  installSaveButtons(app, outerWindow);

  // 주소에 fav 번호가 있으면 보관해 뒀던 편집 내용을 되살린다. 자료(PDF)가 다 그려진 뒤여야 하므로
  // 첫 쪽이 그려졌다는 신호를 기다렸다가 넣는다.
  const favId = new URLSearchParams(window.location.search).get("fav");
  if (!favId) return;

  (async () => {
    try {
      // 첫 쪽이 다 그려질 때까지 기다린다. "그려졌다"는 신호(pagerendered)를 듣는 방법은
      // 쓸 수 없었다 — 이 파일이 붙기 전에 이미 그려져 버리면 그 신호가 다시는 오지 않아
      // 편집 내용이 영영 되살아나지 않는다(실제로 그랬다). 그래서 준비됐는지를 직접 확인한다.
      if (!(await waitForFirstPage(app))) return;
      const res = await fetch(`/api/favorites/${encodeURIComponent(favId)}/markup`);
      if (!res.ok) return;
      const body = await res.json();
      // 원본 미리보기 창이면 원본에 그려 둔 것을, 사본 창이면 사본에 그려 둔 것을 되살린다(D-102).
      const onOriginal = /^\/preview\/original\//.test(new URLSearchParams(window.location.search).get("file") || "");
      const count = await restoreMarkup(app, onOriginal ? body.original_markup : body.markup);
      if (count) console.info(`[DMS] 보관해 둔 편집 내용 ${count}개를 되살렸습니다.`);
    } catch (e) {
      console.warn("[DMS] 보관해 둔 편집 내용을 되살리지 못했습니다", e);
    }
  })();
}

// 자료가 열리고 쪽이 자리를 잡을 때까지 기다린다(최대 20초). 자료가 크면 오래 걸린다.
//
// "다 그려졌는지"(renderingState)를 보지 않는 것은, 쪽이 화면 밖에 있거나 미리보기 창이
// 접혀 있으면 PDF.js가 아직 그리지 않아 그 값이 영영 안 바뀌기 때문이다(실제로 그랬다).
// 표시를 얹는 데 필요한 것은 그림이 아니라 쪽의 크기·자리이므로 여기까지만 기다리면 된다
// (편집 레이어가 만들어지는 것은 editorLayerFor가 따로 기다린다).
async function waitForFirstPage(app) {
  for (let i = 0; i < 200; i++) {
    const pageView = app.pdfViewer?.getPageView?.(0);
    if (app.pdfDocument && pageView && pageView.div && pageView.viewport) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
