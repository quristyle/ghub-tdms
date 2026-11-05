// MDB 조회 화면 — MDB 관리(mdb-editor.js)와 같은 검색·폴더트리·결과표 구성을 조회 전용으로 쓴다.
// 편집 기능은 없고, 대신 "다운로드"(폴더 다운/자료 다운/다운대기함) 기능이 있다. MDB는 반출(대여)
// 개념이 아니라 단순 다운로드라 별도 기록·수정용/참조용 구분이 없다(CM 확정) — 체크한 자료를
// 폴더 구조 그대로 zip으로 내려받는다.
//
// 검색칸 좌측 드롭박스(검색대상)로 자료명/Tag No를 고른다. Tag No를 고르고 검색하면 기존처럼
// "이(가) 포함된 Tag No N건" 팝업이 뜨고, 고른 Tag No가 붙은 자료만 결과표에 뜬다.

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// 소속공사(최상위 폴더)명 앞의 "2013. 08. - " 같은 연도.월 표기를 떼고 공사명만 남긴다.
function shortProjectLabel(name) {
  const stripped = String(name || "").replace(/^\d{4}\.\s*\d{1,2}\.\s*-\s*/, "").trim();
  return stripped || name || "-";
}

// DWG/XLSX/ETC/PDF 네 칸에 이 자료가 가진 형식마다 Y를 찍는다. 자료 1건이 원본과 PDF 사본을
// 함께 가질 수 있으므로(2026-08-17) 두 칸에 Y가 들어갈 수 있다. 서버의 mdb.py ext_flags와 같은 규칙.
function extCell(item, kind) {
  const exts = (item.exts || []).map((e) => String(e || "").toLowerCase());
  const matches =
    kind === "dwg" ? exts.includes("dwg") :
    kind === "xlsx" ? exts.some((e) => e === "xlsx" || e === "xls") :
    kind === "pdf" ? exts.includes("pdf") :
    exts.some((e) => !["dwg", "xlsx", "xls", "pdf"].includes(e));
  return matches ? "Y" : ".";
}

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
const state = {
  page: 1,
  pageSize: 50,
  total: 0,
  lastItems: [],
  lastStartNo: 1,

  treeFolders: [],
  treeRoot: null,
  expanded: new Set(),
  selectedFolder: null,   // { kind:'root' } | { kind:'folder', path, docCount }

  tag: "",                // 검색대상=Tag No로 고른 Tag No (없으면 자료명 검색 모드)

  selected: new Set(),    // 다운대기함에 담긴 자료 id
  staged: new Set(),      // 결과표 체크박스로 표시만 해둔 것

  projects: [],
  equipmentTypes: [],   // 검색 드롭다운 후보 (숨기지 않은 설비유형 이름들)
  docTypes: [],         // 검색 드롭다운 후보 (숨기지 않은 자료유형 이름들)

  sort: "",          // 표 헤더를 눌러 정한 정렬 기준 열(빈값이면 기본 = 자료명순)
  sortDir: "asc",    // asc(오름차순) / desc(내림차순)

  navFiltersKey: null,    // 미리보기 이전/다음이 검색조건 전체를 넘나들게 하는 가벼운 목록의 기준
  navListPromise: null,
};

// ---------------------------------------------------------------------------
// 필터 → 쿼리 문자열
// ---------------------------------------------------------------------------
function currentFilters() {
  const target = document.getElementById("search-target").value;
  const raw = document.getElementById("q").value.trim();
  return {
    // 검색대상이 자료명이면 q로, Tag No면 tag로 보낸다(tag는 고른 Tag No, 아래 검색 흐름 참조).
    // 전체면 q_any로 — 자료명·경로와 Tag No 어느 쪽에 걸려도 찾는다(둘 다 부분일치).
    q: target === "FILE" ? raw : "",
    tag: target === "TAG" ? state.tag : "",
    q_any: target === "ALL" ? raw : "",
    category: document.getElementById("category").value,
    equipment_type: document.getElementById("equipment_type").value,
    doc_type: document.getElementById("doc_type").value,
    project_id: document.getElementById("project_id").value,
    holding: document.getElementById("holding").value,
    recursive: document.getElementById("recursive_folder").checked,
    folder_path: state.selectedFolder && state.selectedFolder.kind === "folder" ? state.selectedFolder.path : "",
    // 정렬은 화면의 50건이 아니라 조회 결과 전체가 기준이라 서버로 같이 보낸다(TDB 조회와 동일).
    sort: state.sort,
    dir: state.sortDir,
  };
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === null || value === undefined) continue;
    usp.set(key, value);
  }
  return usp.toString();
}

// ---------------------------------------------------------------------------
// 화면 이동 후 돌아와도 검색조건·선택폴더가 유지되도록 sessionStorage에 저장/복원
// (TDB 조회 script.js와 같은 방식). 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다.
// project_id·equipment_type 드롭다운은 loadFilterMeta()가 옵션을 채운 뒤라야 값이 먹으므로,
// restoreState()는 init()에서 그 다음에 부른다.
// ---------------------------------------------------------------------------
const STATE_KEY = "dms_mdb_state";

function saveState() {
  const sf = state.selectedFolder;
  const target = document.getElementById("search-target").value;
  const snapshot = {
    q: target === "TAG" ? "" : document.getElementById("q").value.trim(),
    searchTarget: target,
    tag: state.tag,
    category: document.getElementById("category").value,
    equipment_type: document.getElementById("equipment_type").value,
    doc_type: document.getElementById("doc_type").value,
    project_id: document.getElementById("project_id").value,
    holding: document.getElementById("holding").value,
    recursive: document.getElementById("recursive_folder").checked,
    sort: state.sort,
    dir: state.sortDir,
    page: state.page,
    selected: [...state.selected],
    staged: [...state.staged],
    expanded: [...state.expanded],
    folderKind: sf ? sf.kind : null,
    folderPath: sf && sf.kind === "folder" ? sf.path : null,
  };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
}

function restoreState() {
  const raw = sessionStorage.getItem(STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    document.getElementById("search-target").value = s.searchTarget || "ALL";
    updateSearchTargetUI();
    document.getElementById("q").value = s.q || (s.searchTarget === "TAG" ? s.tag || "" : "");
    state.tag = s.tag || "";
    document.getElementById("category").value = s.category || "";
    document.getElementById("equipment_type").value = s.equipment_type || "";
    document.getElementById("doc_type").value = s.doc_type || "";
    document.getElementById("project_id").value = s.project_id || "";
    document.getElementById("holding").value = s.holding || "";
    document.getElementById("recursive_folder").checked = !!s.recursive;
    state.sort = s.sort || "";
    state.sortDir = s.dir || "asc";
    state.page = s.page || 1;
    state.selected = new Set(s.selected || []);
    state.staged = new Set(s.staged || []);
    state.expanded = new Set(s.expanded || []);
    if (s.folderKind === "root") {
      state.selectedFolder = { kind: "root" };
    } else if (s.folderKind === "folder" && s.folderPath) {
      // docCount는 loadTree()가 실제 트리를 받으면 다시 채워준다
      state.selectedFolder = { kind: "folder", path: s.folderPath, docCount: 0 };
    } else {
      state.selectedFolder = null;
    }
  } catch (e) {
    /* 무시 */
  }
}

// ---------------------------------------------------------------------------
// 폴더 트리 — /mdb-editor/tree(폴더 목록)만 조립한다(자료는 결과표에서만).
// MDB 관리와 같은 방식(폴더만, 자료는 트리에 안 넣음).
// ---------------------------------------------------------------------------
function buildTree(folders) {
  const root = { name: "", path: "", children: new Map(), docCount: 0 };
  folders.forEach((f) => {
    const parts = f.path.split("\\").filter(Boolean);
    let node = root;
    const acc = [];
    for (const part of parts) {
      acc.push(part);
      const full = acc.join("\\");
      if (!node.children.has(full)) {
        node.children.set(full, { name: part, path: full, children: new Map(), docCount: 0 });
      }
      node = node.children.get(full);
      node.docCount += f.file_count;
    }
  });
  return root;
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => naturalCompare(a.name, b.name));
}

// 트리(중첩 Map) 안에서 경로로 노드를 찾는다(복원된 선택 폴더가 실제로 있는지 확인·docCount 채우기용).
function findTreeNode(root, path) {
  for (const child of root.children.values()) {
    if (child.path === path) return child;
    const found = findTreeNode(child, path);
    if (found) return found;
  }
  return null;
}

function renderTree() {
  const container = document.getElementById("folder-tree");
  container.innerHTML = "";
  if (!state.treeRoot) return;
  sortedChildren(state.treeRoot).forEach((n) => renderTreeNode(n, container, 0));
}

// 트리를 직접 클릭한 것과 똑같이 특정 폴더를 선택 상태로 만든다(결과표 "경로" 칸 클릭 등에서 쓴다).
function selectFolderByPath(path) {
  const node = state.treeRoot ? findTreeNode(state.treeRoot, path) : null;
  state.selectedFolder = { kind: "folder", path, docCount: node ? node.docCount : 0 };
  const parts = path.split("\\").filter(Boolean);
  const acc = [];
  for (const part of parts) {
    acc.push(part);
    state.expanded.add(acc.join("\\"));
  }
  state.page = 1;
  renderTree();
  loadDocuments();
  // 트리가 길면 지금 화면 밖일 수 있어, 선택된 폴더가 보이는 위치로 스크롤한다.
  document.querySelector("#folder-tree .tree-node.active")?.scrollIntoView({ block: "center" });
}

function renderTreeNode(node, container, depth) {
  const hasKids = node.children.size > 0;
  const isOpen = state.expanded.has(node.path);
  const isSelected = state.selectedFolder && state.selectedFolder.kind === "folder" && state.selectedFolder.path === node.path;

  const row = document.createElement("div");
  row.className = "tree-node" + (isSelected ? " active" : "");
  row.dataset.depth = Math.min(depth, 3);
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.innerHTML = `
    <span class="tree-toggle">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span>
    <span class="tree-icon">📁</span>
    <span class="tree-label">${esc(node.name)}</span>
    <span class="tree-count">(${node.docCount})</span>`;

  row.querySelector(".tree-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!hasKids) return;
    if (isOpen) state.expanded.delete(node.path);
    else state.expanded.add(node.path);
    renderTree();
  });
  row.addEventListener("click", () => {
    state.selectedFolder = { kind: "folder", path: node.path, docCount: node.docCount };
    state.expanded.add(node.path);
    state.page = 1;
    renderTree();
    loadDocuments();
  });
  row.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (!hasKids) return;
    if (isOpen) state.expanded.delete(node.path);
    else state.expanded.add(node.path);
    renderTree();
  });

  container.appendChild(row);
  if (hasKids && isOpen) {
    for (const child of sortedChildren(node)) renderTreeNode(child, container, depth + 1);
  }
}

async function loadTree() {
  const data = await fetchJson("/mdb-editor/tree");
  state.treeFolders = data.folders;
  state.treeRoot = buildTree(state.treeFolders);
  // 디폴트(펼친 폴더 없음)는 최상위 폴더 이름만 보이고 전부 접힌 상태다(2026-08-16 CM 확정).
  // 기존 선택(복원된 선택 포함)이 사라진 폴더면 해제, 남아있으면 최신 docCount로 갱신
  if (state.selectedFolder && state.selectedFolder.kind === "folder") {
    const node = findTreeNode(state.treeRoot, state.selectedFolder.path);
    state.selectedFolder = node ? { kind: "folder", path: node.path, docCount: node.docCount } : null;
  }
  renderTree();
}

document.getElementById("tree-collapse-all").addEventListener("click", () => {
  state.selectedFolder = null;
  state.expanded.clear();
  state.page = 1;
  renderTree();
  updateSelectedFolderName();
  loadDocuments();
});

// ---------------------------------------------------------------------------
// 결과 표
// ---------------------------------------------------------------------------
// 미리보기는 자료가 가진 PDF 사본을 연다. 원본(엑셀 등)이 대표인 자료도 짝인 PDF가 있으면
// 열 수 있으므로 pdf_file_id를 그대로 쓴다(2026-08-17).
function toMdbPreviewItem(doc) {
  return {
    id: doc.id,
    drawingNo: doc.name,
    path: doc.source_path,
    pdfFileId: doc.pdf_file_id || null,
    previewUrl: doc.pdf_file_id ? `/mdb/files/${doc.pdf_file_id}/view` : null,
    source: mdbSource(doc.id),
  };
}

function toNavPreviewItem(n) {
  return {
    id: n.id,
    drawingNo: n.name,
    path: n.source_path,
    pdfFileId: n.pdf_file_id || null,
    previewUrl: n.pdf_file_id ? `/mdb/files/${n.pdf_file_id}/view` : null,
    source: mdbSource(n.id),
  };
}

function filtersKey(filters) {
  return JSON.stringify(filters);
}

// 검색조건 전체(50건 페이지 제한 없이)를 가볍게 받아둔다 — 미리보기 이전/다음이 페이지 안에서만
// 움직이지 않고 검색조건 전체를 넘나들 수 있게(TDB 조회와 같은 방식).
function ensureNavList(filters) {
  const key = filtersKey(filters);
  if (state.navFiltersKey !== key || !state.navListPromise) {
    state.navFiltersKey = key;
    state.navListPromise = fetch(`/mdb/nav?${buildQueryString(filters)}`).then((r) => r.json());
  }
  const promise = state.navListPromise;
  // 지금 저장돼 있는 이전/다음 목록은 다른 조건(다운대기함 보기 등)의 것일 수 있으므로 무효로 두고,
  // 이 검색조건의 전체 목록이 (이미 받아둔 것이면 곧바로) 저장되게 한다 — TDB 조회와 같은 방식.
  beginDetailNavFullList();
  // 그 사이 검색조건이 또 바뀌었으면(다른 목록을 받는 중이면) 이 결과는 버린다.
  promise.then((navList) => {
    if (state.navListPromise === promise) saveDetailNavList(navList.map((n) => n.id));
  });
  return promise;
}

function wireFullPreviewButtons(tbody, items) {
  [...tbody.querySelectorAll("[data-preview-btn]")].forEach((btn, i) => {
    const doc = items[i];
    btn.addEventListener("click", async () => {
      const navList = (await state.navListPromise).map(toNavPreviewItem);
      const idx = navList.findIndex((it) => it.id === doc.id);
      openDocPreview(navList, idx === -1 ? 0 : idx);
    });
  });
}

function renderTable(items, startNo) {
  const tbody = document.getElementById("doc-tbody");
  tbody.innerHTML = "";

  // 상세보기 화면의 이전/다음 이동 — 원칙은 "검색조건 전체"(ensureNavList가 받아 저장한다)이고,
  // 여기 페이지 50건은 그게 아직 안 왔을 때만 쓰는 임시 목록이다(TDB 조회와 같은 방식).
  saveDetailNavPageList(items.map((d) => d.id));

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">조건에 맞는 자료가 없습니다.</td></tr>';
    return;
  }

  items.forEach((doc, i) => {
    const tr = document.createElement("tr");
    const checked = state.staged.has(doc.id) ? "checked" : "";
    const previewBtn = previewBtnHtml(doc.pdf_file_id || null, doc.has_original);
    tr.innerHTML = `
      <td class="col-no">${startNo + i}</td>
      <td><input type="checkbox" class="row-check" data-id="${doc.id}" ${checked} /></td>
      <td>${previewBtn} <a href="mdb-detail.html?id=${doc.id}">${esc(doc.name)}</a></td>
      <td class="tc muted">${doc.year ?? "-"}</td>
      <td class="muted">${esc(shortProjectLabel(doc.project_name))}</td>
      <td class="muted path-jump" title="${esc(doc.source_path)}">${esc(doc.source_path)}</td>
      <td class="tc" title="${esc(doc.equipment_type || "-")}">${esc(doc.equipment_type || "-")}</td>
      <td class="tc" title="${esc(doc.doc_type || "-")}">${esc(doc.doc_type || "-")}</td>
      <td class="tc">${extCell(doc, "dwg")}</td>
      <td class="tc">${extCell(doc, "xlsx")}</td>
      <td class="tc">${extCell(doc, "etc")}</td>
      <td class="tc">${extCell(doc, "pdf")}</td>
      <td class="muted tc">${(doc.updated_at ?? "").slice(0, 16).replace("T", " ")}</td>`;
    tr.querySelector(".path-jump").addEventListener("click", () => {
      if (doc.folder) selectFolderByPath(doc.folder);
    });
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".row-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) state.staged.add(id);
      else state.staged.delete(id);
      updateTotalCountText();
      saveState();
    });
  });

  wireFullPreviewButtons(tbody, items);
  // 자료명을 눌러 여는 상세보기도 미리보기와 같이 검색조건 전체를 넘나든다(ui.js).
  wireDetailLinksFullNav(tbody, () => state.navListPromise);
}

async function loadDocuments() {
  const filters = currentFilters();
  ensureNavList(filters);
  const params = { ...filters, page: state.page, page_size: state.pageSize };
  saveState();
  const data = await fetchJson(`/mdb/list?${buildQueryString(params)}`);
  state.total = data.total;
  state.lastItems = data.items;
  state.lastStartNo = (state.page - 1) * state.pageSize + 1;
  renderTable(state.lastItems, state.lastStartNo);
  renderStatusBar();
  renderPagination();
}

function updateSelectedFolderName() {
  const el = document.getElementById("selected-folder-name");
  const s = state.selectedFolder;
  if (s && s.kind === "folder") {
    const parts = s.path.split("\\").filter(Boolean);
    el.textContent = `\u{1F4C1} ${parts[parts.length - 1]}`;
  } else {
    el.textContent = "\u{1F4C1} 폴더 전체";
  }
}

// 표에서 체크한 개수(현재 페이지만이 아니라 검색조건 전체 목록에서 체크해둔 것 전부)를
// "전체 N건" 옆에 덧붙여 보여준다.
function updateTotalCountText() {
  const suffix = state.staged.size > 0 ? ` (선택 ${state.staged.size}건)` : "";
  document.getElementById("total-count").textContent = `전체 ${state.total}건${suffix}`;
  // 체크한 게 있을 때만 그 문구 오른쪽에 [선택 초기화]가 나타난다 (2026-08-28 CM 요청).
  // 글자 높이에 맞춰둔 버튼이라 상태줄 높이는 달라지지 않는다.
  document.getElementById("clear-selection-btn").hidden = state.staged.size === 0;
}

// [선택 초기화] — 체크만 모두 푸는 버튼. 이미 대기함에 담아둔 것은 그대로 둔다.
document.getElementById("clear-selection-btn").addEventListener("click", () => {
  clearStaged();
});

function renderStatusBar() {
  updateTotalCountText();
  updateSelectedFolderName();
  document.getElementById("cart-count").textContent = String(state.selected.size);
  saveState();  // 선택이 바뀔 때마다 다운대기함 보존
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  document.getElementById("page-pos-input").value = state.page;
  document.getElementById("page-total").textContent = totalPages;
  document.getElementById("first-page").disabled = state.page <= 1;
  document.getElementById("prev-page").disabled = state.page <= 1;
  document.getElementById("next-page").disabled = state.page >= totalPages;
  document.getElementById("last-page").disabled = state.page >= totalPages;
}

// ---------------------------------------------------------------------------
// 검색 흐름 — 검색대상(자료명/Tag No)에 따라 다르게 동작한다.
// ---------------------------------------------------------------------------
function search() {
  state.page = 1;
  loadDocuments();
}

// Tag No 검색: 입력한 조각을 포함하는 실제 Tag No 후보를 찾아, 정확히 하나면 바로 검색하고
// 여러 개면 골라잡는 팝업을 띄운다(예전 MDB 조회 화면과 같은 동작).
async function handleSearchClick() {
  const target = document.getElementById("search-target").value;
  if (target === "FILE" || target === "ALL") {
    state.tag = "";
    search();
    return;
  }
  // Tag No 검색
  const raw = document.getElementById("q").value.trim();
  if (!raw) {
    state.tag = "";
    search();
    return;
  }
  const candidates = await fetchJson(`/mdb/tags/suggest?q=${encodeURIComponent(raw)}`);
  const exact = candidates.find((c) => c.tag_no.toUpperCase() === raw.toUpperCase());
  if (exact) {
    document.getElementById("q").value = exact.tag_no;
    state.tag = exact.tag_no;
    search();
    return;
  }
  if (candidates.length === 0) {
    // 해당 Tag No가 아예 없음 — 빈 결과를 보여준다
    state.tag = raw;  // 적은 그대로 찾는다(찾기는 원래부터 대·소문자를 가리지 않는다)
    search();
    return;
  }
  if (candidates.length === 1) {
    document.getElementById("q").value = candidates[0].tag_no;
    state.tag = candidates[0].tag_no;
    search();
    return;
  }
  openTagPicker(raw, candidates);
}

function openTagPicker(query, candidates) {
  const rows = candidates
    .map((c) => `<tr class="mdb-pick-row" data-tag="${esc(c.tag_no)}">
        <td>${esc(c.tag_no)}</td><td>${c.count}건</td></tr>`)
    .join("");
  openModal(`
    <p class="mdb-edit-title">"${esc(query)}"이(가) 포함된 Tag No ${candidates.length}건 — 찾는 설비를 선택하세요</p>
    <div class="table-scroll" style="max-height:50vh;">
      <table class="mdb-pick-table">
        <thead><tr><th>Tag No</th><th>자료 수</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button type="button" id="pick-cancel">취소</button>
    </div>`);
  document.getElementById("pick-cancel").addEventListener("click", closeModal);
  document.querySelectorAll(".mdb-pick-row").forEach((row) => {
    row.addEventListener("click", () => {
      document.getElementById("q").value = row.dataset.tag;
      state.tag = row.dataset.tag;
      closeModal();
      search();
    });
  });
}

// 검색대상을 바꾸면 검색칸 placeholder를 맞추고, 이전 검색 상태를 정리한다.
function updateSearchTargetUI() {
  const target = document.getElementById("search-target").value;
  document.getElementById("q").placeholder =
    target === "TAG" ? "Tag No 검색 (예: P1201A)"
    : target === "ALL" ? "자료명 또는 Tag No 검색"
    : "자료명 검색";
}

// ---------------------------------------------------------------------------
// 모달 (Tag No 후보 선택 팝업용)
// ---------------------------------------------------------------------------
function openModal(html) {
  // 이 화면에서 뜨는 팝업은 Tag No 후보 선택 하나뿐이라 그 폭(mdb-pick-box)을 그대로 쓴다.
  document.getElementById("modal-root").innerHTML = `<div class="modal-overlay"><div class="modal-box mdb-pick-box">${html}</div></div>`;
}
function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

// ---------------------------------------------------------------------------
// 다운대기함 (TDB 조회 반출대기함과 같은 방식, 단 다운로드용)
// ---------------------------------------------------------------------------
function clearStaged() {
  state.staged.clear();
  document.querySelectorAll(".row-check").forEach((cb) => (cb.checked = false));
  const selectAll = document.getElementById("select-all");
  if (selectAll) selectAll.checked = false;
  updateTotalCountText();
  saveState();
}

document.getElementById("select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".row-check").forEach((cb) => {
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.id);
    if (e.target.checked) state.staged.add(id);
    else state.staged.delete(id);
  });
  updateTotalCountText();
  saveState();
});

// [자료 다운]: 체크한 자료를 다운대기함에 담는다.
document.getElementById("add-to-cart-btn").addEventListener("click", async () => {
  if (state.staged.size === 0) {
    await showAlert("먼저 목록에서 다운로드할 자료를 체크해주세요.");
    return;
  }
  for (const id of state.staged) state.selected.add(id);
  clearStaged();
  renderStatusBar();
});

// [폴더 다운]: 지금 선택된 폴더(하위 포함)의 자료 전부를 다운대기함에 담는다.
document.getElementById("add-folder-to-cart-btn").addEventListener("click", async () => {
  const s = state.selectedFolder;
  if (!s || s.kind !== "folder") {
    await showAlert("먼저 좌측에서 폴더를 선택해주세요.");
    return;
  }
  const ids = await fetchJson(`/mdb/ids-by-path?${buildQueryString({ folder_path: s.path, recursive: true })}`);
  if (ids.length === 0) {
    await showAlert("이 폴더에는 자료가 없습니다.");
    return;
  }
  const ok = await showConfirm(`이 폴더(하위 폴더 포함)의 자료 ${ids.length}건을 다운대기함에 모두 담으시겠습니까?`);
  if (!ok) return;
  for (const id of ids) state.selected.add(id);
  renderStatusBar();
});

let cartChecked = new Set();

function updateCartSelectAll() {
  const selectAll = document.getElementById("cart-select-all");
  const rowChecks = [...document.querySelectorAll(".cart-row-check")];
  selectAll.checked = rowChecks.length > 0 && rowChecks.every((cb) => cb.checked);
  selectAll.disabled = rowChecks.length === 0;
}

async function renderCartTbody() {
  const tbody = document.getElementById("cart-tbody");
  const ids = [...state.selected];
  if (ids.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">다운대기함이 비어있습니다.</td></tr>';
    updateCartSelectAll();
    return;
  }
  const data = await fetchJson(`/mdb/list?ids=${ids.join(",")}`);
  tbody.innerHTML = "";
  const previewList = data.items.map(toMdbPreviewItem);
  data.items.forEach((doc, i) => {
    const tr = document.createElement("tr");
    const checked = cartChecked.has(doc.id) ? "checked" : "";
    const previewBtn = previewBtnHtml(doc.pdf_file_id || null, doc.has_original);
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td><input type="checkbox" class="cart-row-check" data-id="${doc.id}" ${checked} /></td>
      <td>${previewBtn} ${esc(doc.name)}</td>
      <td class="muted">${esc(doc.source_path)}</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".cart-row-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) cartChecked.add(id);
      else cartChecked.delete(id);
      updateCartSelectAll();
    });
  });
  wirePreviewButtons(tbody, previewList);
  updateCartSelectAll();
}

document.getElementById("cart-select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".cart-row-check").forEach((cb) => {
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.id);
    if (e.target.checked) cartChecked.add(id);
    else cartChecked.delete(id);
  });
});

document.getElementById("cart-open-btn").addEventListener("click", async () => {
  cartChecked = new Set();
  await renderCartTbody();
  document.getElementById("cart-modal").classList.remove("hidden");
});

document.getElementById("cart-close-btn").addEventListener("click", () => {
  document.getElementById("cart-modal").classList.add("hidden");
});

document.getElementById("cart-delete-btn").addEventListener("click", () => {
  if (cartChecked.size === 0) return;
  for (const id of cartChecked) state.selected.delete(id);
  cartChecked.clear();
  renderStatusBar();
  renderCartTbody();
});

document.getElementById("cart-export-btn").addEventListener("click", () => {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  window.location.href = `/mdb/export?ids=${ids.join(",")}&columns=cart`;
});

// [이 목록으로 다운하기]: 다운대기함 자료를 zip으로 내려받는다(수정용/참조용 등
// 추가 팝업 없음, 기록도 없음 — CM 확정).
// [폴더 경로 유지]를 끄면 폴더 구조 없이 자료와 엑셀 목록이 Zip 바로 밑에 평평하게
// 들어간다 — 압축을 풀면 Zip 이름과 같은 폴더 하나에 전부 모인다(2026-08-28 CM 확정).
// 엑셀 목록 내용은 켜든 끓든 같다.
document.getElementById("cart-download-btn").addEventListener("click", async () => {
  const ids = [...state.selected];
  if (ids.length === 0) {
    await showAlert("다운대기함이 비어있습니다.");
    return;
  }
  const keepPaths = document.getElementById("cart-keep-paths").checked;
  window.location.href = `/mdb/download-zip?ids=${ids.join(",")}&keep_paths=${keepPaths ? 1 : 0}`;
});

// ---------------------------------------------------------------------------
// 이벤트 연결
// ---------------------------------------------------------------------------
document.getElementById("search-btn").addEventListener("click", handleSearchClick);
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearchClick();
});
document.getElementById("search-target").addEventListener("change", () => {
  updateSearchTargetUI();
});
["category", "equipment_type", "doc_type", "project_id", "holding"].forEach((id) => {
  document.getElementById(id).addEventListener("change", search);
});
document.getElementById("recursive_folder").addEventListener("change", search);
document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("q").value = "";
  document.getElementById("search-target").value = "ALL";
  document.getElementById("category").value = "";
  document.getElementById("equipment_type").value = "";
  document.getElementById("doc_type").value = "";
  document.getElementById("project_id").value = "";
  document.getElementById("holding").value = "";
  document.getElementById("recursive_folder").checked = false;
  state.selectedFolder = null;
  state.tag = "";
  state.sort = "";
  state.sortDir = "asc";
  showSortedColumn("", "asc");
  updateSearchTargetUI();
  renderTree();
  loadTree();
  search();
  docColWidths.reset();
});
document.getElementById("first-page").addEventListener("click", () => {
  if (state.page > 1) { state.page = 1; loadDocuments(); }
});
document.getElementById("prev-page").addEventListener("click", () => {
  if (state.page > 1) { state.page -= 1; loadDocuments(); }
});
document.getElementById("next-page").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < totalPages) { state.page += 1; loadDocuments(); }
});
document.getElementById("last-page").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < totalPages) { state.page = totalPages; loadDocuments(); }
});

// "N / 전체 M 페이지"의 N을 직접 입력하고 Enter를 치면 그 페이지로 바로 이동한다
// (미리보기 팝업·자료 상세보기와 같은 방식, ui.js의 wireNavPosInput 공용 함수).
wireNavPosInput(
  document.getElementById("page-pos-input"),
  () => Math.max(1, Math.ceil(state.total / state.pageSize)),
  (n) => { state.page = n; loadDocuments(); }
);
document.getElementById("export-btn").addEventListener("click", () => {
  window.location.href = `/mdb/export?${buildQueryString(currentFilters())}`;
});

// ---- 폴더 트리 폭 조정 ----
function setupTreeResize() {
  const treePanel = document.querySelector(".tree-panel");
  const handle = document.getElementById("tree-resize-handle");
  if (!treePanel || !handle) return;
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 640;
  const saved = Number(localStorage.getItem("dms_mdb_tree_width"));
  if (saved) treePanel.style.flex = `0 0 ${saved}px`;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treePanel.getBoundingClientRect().width;
    let finalWidth = startWidth;
    handle.classList.add("resizing");
    function onMove(ev) {
      finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (ev.clientX - startX)));
      treePanel.style.flex = `0 0 ${finalWidth}px`;
    }
    function onUp() {
      handle.classList.remove("resizing");
      localStorage.setItem("dms_mdb_tree_width", finalWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---- 검색 필터 메타(설비유형·자료유형·공사) 채우기 ----
async function loadFilterMeta() {
  const meta = await fetchJson("/mdb/meta");
  state.projects = meta.projects;
  const projSel = document.getElementById("project_id");
  projSel.innerHTML = '<option value="">전체</option>' +
    state.projects.map((p) => `<option value="${p.id}">${esc(shortProjectLabel(p.name))}</option>`).join("");

  // 설비유형·자료유형은 목록(마스터)에서 숨기지 않은 것만 후보로 내려온다.
  // 자료 1건에 유형이 여러 개 붙어 있어도("Pump/Strainer") 여기서는 하나씩 고르고,
  // 고른 유형이 하나라도 붙어 있는 자료가 검색된다(서버 mdb.py filter_groups).
  const fillTypeOptions = (selectId, names) => {
    document.getElementById(selectId).innerHTML = '<option value="">전체</option>' +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  };
  state.equipmentTypes = meta.equipment_types;
  state.docTypes = meta.doc_types;
  fillTypeOptions("equipment_type", meta.equipment_types);
  fillTypeOptions("doc_type", meta.doc_types);
}

const docColWidths = persistedColumnWidths(document.getElementById("doc-table"), "mdb:doc-table-v2");

setupTreeResize();
updateSearchTargetUI();

// 표 헤더를 누르면 화면의 50건만이 아니라 조회 결과 전체가 정렬돼야 하므로(공통 규칙),
// 서버에 정렬 조건을 보내고 1페이지부터 다시 받아온다(TDB 조회 script.js와 동일한 방식).
let showSortedColumn = () => {};

// 폐기 보관함 — TDB 조회와 같은 방식(보기 전용). 팝업은 ui.js에 있어 MDB 관리와 공용이다.
document.getElementById("retired-open-btn").addEventListener("click", () => {
  openRetiredPopup("mdb", { screen: "MDB 조회" });
});

async function init() {
  refreshRetiredCount("mdb");
  await loadFilterMeta(); // project_id·equipment_type 옵션이 채워져야 restoreState()의 값 지정이 먹는다
  restoreState();
  await Promise.all([loadTree(), loadDocuments()]);
  docColWidths.restore();
  makeColumnsResizable(document.getElementById("doc-table"), docColWidths.save);
  showSortedColumn = makeSortable(document.getElementById("doc-table"), (key, dir) => {
    state.sort = key;
    state.sortDir = dir;
    search();
  });
  showSortedColumn(state.sort, state.sortDir);
}
init();
