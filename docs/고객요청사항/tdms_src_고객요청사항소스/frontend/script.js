const state = {
  page: 1,
  pageSize: 50,
  total: 0,
  selected: new Set(),   // 반출대기함에 실제로 담긴 도면 (저장된 것만)
  staged: new Set(),     // 목록 화면 체크박스로 표시만 해둔 것 (아직 대기함에 담기지 않음)
  cartDraft: null,       // 반출대기함 모달을 열었을 때의 임시 편집본
  path: "",          // 폴더 트리에서 선택한 경로
  expanded: new Set(), // 펼쳐진 폴더 경로
  sort: "",          // 표 헤더를 눌러 정한 정렬 기준 열(빈값이면 기본 = 자료명순)
  sortDir: "asc",    // asc(오름차순) / desc(내림차순)
  navFiltersKey: null,  // 아래 navListPromise가 지금 어떤 검색조건 기준인지(같으면 재사용, 다르면 새로 받음)
  navListPromise: null, // 미리보기/상세보기 "이전·다음"이 페이지(50건)가 아니라 검색조건 전체를 넘나들게 해주는 가벼운 목록
};

const FILTER_IDS = ["status", "holding"];

// "검색대상" 드롭다운의 P&ID/PDF는 검색 범위가 아니라 자주 찾는 폴더 바로가기다 — 골라도
// 실제 검색대상 값은 그대로 "자료명"으로 되돌리고, 그 폴더를 트리에서 선택한 것처럼 동작한다.
const SHORTCUT_FOLDERS = {
  SHORTCUT_PID: "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)",
  SHORTCUT_PDF: "3. PROCESS & FACILITIES DESCRIPTION\\3.2 Process Flow Diagram (PFD)",
};

// ---- Isometric 다중선택 드롭다운 (Process/Steam Tracing) ----
// 기본값은 아무것도 선택 안 함 = isometric 전부 제외(예전 "Isometric 포함" 미체크와 동일).
// 둘 다 선택하면 사실상 전체이므로 드롭다운 칸에는 "전체"라고 표시한다(체크박스 자체엔 전체가 없음).
const ISO_OPTIONS = [
  { value: "PROCESS", label: "Process" },
  { value: "STEAM", label: "Steam Tracing" },
];
const selectedIso = new Set();

function renderIsoList() {
  const list = document.getElementById("iso-list");
  list.innerHTML = ISO_OPTIONS.map(
    (o) => `
      <label class="dropdown-item dropdown-item-ms">
        <input type="checkbox" class="iso-cb" value="${o.value}" ${selectedIso.has(o.value) ? "checked" : ""} />
        <span class="dropdown-item-label">${o.label}</span>
      </label>`
  ).join("");
  list.querySelectorAll(".iso-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIso.add(cb.value);
      else selectedIso.delete(cb.value);

      renderIsoToggle();
      loadFolders();
      search();
    });
  });
}

function renderIsoToggle() {
  const toggle = document.getElementById("iso-toggle");
  if (selectedIso.size === 0) {
    toggle.textContent = "선택 안 함";
  } else if (selectedIso.has("PROCESS") && selectedIso.has("STEAM")) {
    toggle.textContent = "전체";
  } else {
    toggle.textContent = [...selectedIso].map((v) => ISO_OPTIONS.find((o) => o.value === v)?.label ?? v).join(", ");
  }
}

renderIsoList();
renderIsoToggle();

document.getElementById("iso-toggle").addEventListener("click", () => {
  document.getElementById("iso-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("iso-dropdown").contains(e.target)) {
    document.getElementById("iso-list").classList.add("hidden");
  }
});

// ---- 수정일 다중선택 드롭다운 ----
// 항목(MODIFIED_OPTIONS)은 ui.js에 있다 — 최근수정본 팝업의 수정일 드롭다운과 같은 목록을 쓴다.
// [전체] 체크 규칙(전체↔나머지 자동 해제, 다 풀리면 전체 복귀)도 ui.js가 공통으로 처리한다.
const modifiedDropdown = createCheckDropdown("modified-dropdown", MODIFIED_OPTIONS, () => search());

function currentFilters() {
  return {
    q: document.getElementById("q").value.trim(),
    kind_scope: document.getElementById("kind_scope").value,
    status: document.getElementById("status").value,
    holding: document.getElementById("holding").value,
    iso: [...selectedIso],
    modified: modifiedDropdown.getValues(),
    recursive: document.getElementById("recursive_folder").checked,
    path: state.path,
    // 정렬은 화면의 50건이 아니라 조회 결과 전체가 기준이라 서버로 같이 보낸다.
    // 미리보기 "이전/다음"(nav)과 엑셀 내보내기도 이 조건을 그대로 써서 순서가 어긋나지 않는다.
    sort: state.sort,
    dir: state.sortDir,
  };
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, v);
    } else {
      usp.set(key, value);
    }
  }
  return usp.toString();
}

// 숫자를 숫자로 비교하는 자연 정렬 (5.10이 5.2보다 뒤로 가도록)
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

const STATE_KEY = "dms_list_state";

// 표 헤더 너비 유지(화면전환에도 유지, 새로고침·초기화는 디폴트로): ui.js의 persistedColumnWidths 사용
const docColWidths = persistedColumnWidths(document.getElementById("doc-table"), "index:doc-table");

// 상세 화면 다녀와도 검색·필터·페이지·선택(장바구니)이 유지되도록 sessionStorage에 저장/복원
function saveState() {
  const snapshot = {
    ...currentFilters(),
    page: state.page,
    selected: [...state.selected],
    staged: [...state.staged],
    expanded: [...state.expanded],
  };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
}

function restoreState() {
  const raw = sessionStorage.getItem(STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    document.getElementById("q").value = s.q || "";
    document.getElementById("kind_scope").value = s.kind_scope || "FILE";
    document.getElementById("status").value = s.status || "";
    document.getElementById("holding").value = s.holding || "";
    selectedIso.clear();
    (s.iso || []).forEach((v) => selectedIso.add(v));
    renderIsoList();
    renderIsoToggle();
    modifiedDropdown.setValues(s.modified || []);
    document.getElementById("recursive_folder").checked = !!s.recursive;
    state.page = s.page || 1;
    state.selected = new Set(s.selected || []);
    state.staged = new Set(s.staged || []);
    state.path = s.path || "";
    state.expanded = new Set(s.expanded || []);
    state.sort = s.sort || "";
    state.sortDir = s.dir || "asc";
  } catch (e) {
    /* 무시 */
  }
}

// ---- 폴더 트리 ----
// 백엔드는 폴더 경로 190개를 평평하게 주고, 여기서 중첩 트리로 조립한다.
function buildTree(folders) {
  const root = { name: "", path: "", children: new Map(), count: 0 };
  for (const { path, doc_count } of folders) {
    const parts = path.split("\\").filter(Boolean);
    let node = root;
    let acc = [];
    for (const part of parts) {
      acc.push(part);
      const full = acc.join("\\");
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, path: full, children: new Map(), count: 0 });
      }
      node = node.children.get(part);
      node.count += doc_count; // 하위 포함 누계
    }
    root.count += doc_count;
  }
  return root;
}

function renderTreeNode(node, container, depth) {
  const sorted = [...node.children.values()].sort((a, b) => naturalCompare(a.name, b.name));
  for (const child of sorted) {
    const hasKids = child.children.size > 0;
    const isOpen = state.expanded.has(child.path);

    const row = document.createElement("div");
    row.className = "tree-node" + (state.path === child.path ? " active" : "");
    row.dataset.depth = Math.min(depth, 3);
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.innerHTML = `
      <span class="tree-toggle">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span>
      <span class="tree-icon">📁</span>
      <span class="tree-label">${escapeHtml(child.name)}</span>
      <span class="tree-count">(${child.count})</span>
    `;

    row.querySelector(".tree-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hasKids) return;
      if (isOpen) state.expanded.delete(child.path);
      else state.expanded.add(child.path);
      renderTree();
    });

    row.addEventListener("click", () => {
      state.path = child.path;
      state.expanded.add(child.path);
      state.page = 1;
      renderTree();
      loadDocuments();
    });

    // 폴더명을 더블클릭하면 세모 버튼과 똑같이 펼치기/접기만 토글한다(선택은 안 바뀜).
    row.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (!hasKids) return;
      if (isOpen) state.expanded.delete(child.path);
      else state.expanded.add(child.path);
      renderTree();
    });

    container.appendChild(row);

    if (hasKids && isOpen) {
      renderTreeNode(child, container, depth + 1);
    }
  }
}

function renderTree() {
  const container = document.getElementById("folder-tree");
  container.innerHTML = "";
  if (state.treeRoot) renderTreeNode(state.treeRoot, container, 0);
}

// 트리를 직접 클릭한 것과 똑같이 특정 폴더를 선택 상태로 만든다
// (검색대상 P&ID/PDF 바로가기, 결과표 "경로" 칸 클릭 등에서 공용으로 쓴다).
function selectFolderByPath(path) {
  state.path = path;
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

async function loadFolders() {
  // 폴더별 건수는 Isometric 토글과 무관하게 항상 전체 기준(TDB 관리 화면과 통일).
  const res = await fetch(`/documents/folders`);
  const folders = await res.json();
  state.treeRoot = buildTree(folders);
  // 디폴트(펼친 폴더 없음)는 최상위 폴더 이름만 보이고 전부 접힌 상태다(2026-08-16 CM 확정).
  renderTree();
}

// 트리에서 선택한 폴더 이름을 "전체 N건" 옆에 표시한다. 없으면(전체) 비워둔다.
function updateSelectedFolderName() {
  const el = document.getElementById("selected-folder-name");
  if (!state.path) {
    el.textContent = "\u{1F4C1} 폴더 전체";
    return;
  }
  const parts = state.path.split("\\").filter(Boolean);
  el.textContent = `\u{1F4C1} ${parts[parts.length - 1]}`;
}

// 트리 패널 상단 "폴더" 글씨를 누르면 폴더 선택을 "폴더 전체"로 초기화하고
// 펼쳐둔 하위 폴더도 전부 접어 대분류만 보이게 한다.
document.getElementById("tree-collapse-all").addEventListener("click", () => {
  state.path = null;
  state.expanded.clear();
  state.page = 1;
  renderTree();
  updateSelectedFolderName();
  loadDocuments();
});

// 이 검색조건에 맞는 자료 전체(50건 페이지 제한 없이)를 가볍게 받아둔다 — 미리보기/상세보기의
// "이전·다음"이 지금 페이지 안에서만 움직이지 않고 검색조건 전체를 넘나들 수 있게 하기 위함.
// 페이지만 넘길 때는(검색조건은 그대로) 다시 받지 않고 캐시를 그대로 쓴다.
function filtersKey(filters) {
  return JSON.stringify(filters);
}

function ensureNavList(filters) {
  const key = filtersKey(filters);
  if (state.navFiltersKey !== key || !state.navListPromise) {
    state.navFiltersKey = key;
    state.navListPromise = fetch(`/documents/nav?${buildQueryString(filters)}`).then((r) => r.json());
  }
  const promise = state.navListPromise;
  // 지금 저장돼 있는 이전/다음 목록은 다른 조건(반출대기함 보기 등)의 것일 수 있으므로 무효로 두고,
  // 이 검색조건의 전체 목록이 (이미 받아둔 것이면 곧바로) 저장되게 한다 — ui.js 공용 저장소.
  beginDetailNavFullList();
  // 그 사이 검색조건이 또 바뀌었으면(다른 목록을 받는 중이면) 이 결과는 버린다.
  promise.then((navList) => {
    if (state.navListPromise === promise) saveDetailNavList(navList.map((n) => n.id));
  });
  return promise;
}

function toNavPreviewItem(n) {
  return { id: n.id, drawingNo: n.display_name, path: n.path, pdfFileId: n.current_pdf_file_id, source: tdbSource(n.id) };
}

// 표에 그려진 미리보기 버튼을, "지금 페이지의 50건"이 아니라 검색조건 전체 목록(navListPromise)
// 기준으로 연다. 목록이 아직 안 왔으면(막 검색한 직후) 받아질 때까지 기다렸다가 연다.
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

async function loadDocuments() {
  const filters = currentFilters();

  // "반출대기"는 DB 상태가 아니라 이 화면의 반출대기함(state.selected)을 보여주는 것이라
  // 서버 필터로 못 보내고 여기서 따로 처리한다.
  if (filters.status === "IN_CART") {
    return loadCartOnlyView(filters.q);
  }

  ensureNavList(filters);
  const params = { ...filters, page: state.page, page_size: state.pageSize };
  saveState();
  const res = await fetch(`/documents?${buildQueryString(params)}`);
  const data = await res.json();
  state.total = data.total;
  state.lastItems = data.items;
  state.lastStartNo = (state.page - 1) * state.pageSize + 1;
  renderTable(data.items, state.lastStartNo);
  renderStatusBar();
  renderPagination();
}

// "반출대기" 보기는 담아둔 id만 그대로 가져오는 조회라 서버 정렬을 안 탄다. 대신 여기 목록이
// 곧 전체(페이지 나눔 없음)이므로 같은 기준으로 여기서 정렬하면 결과가 같다.
const CART_SORT_VALUES = {
  drawing_no: (d) => d.display_name ?? "",
  category: (d) => d.category ?? "",
  path: (d) => d.source_path ?? "",
  rev: (d) => d.current_rev ?? 0,
  status: (d) => d.status ?? "",
  dwg: (d) => (d.has_dwg ? 1 : 0),
  xlsx: (d) => (d.has_xlsx ? 1 : 0),
  etc: (d) => (d.has_etc ? 1 : 0),
  pdf: (d) => (d.has_pdf ? 1 : 0),
  updated_at: (d) => d.updated_at ?? "",
};

function sortItemsLocally(items) {
  const pick = CART_SORT_VALUES[state.sort];
  if (!pick) return items;
  const dir = state.sortDir === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    if (typeof va === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "ko") * dir;
  });
}

async function loadCartOnlyView(q) {
  saveState();
  const ids = [...state.selected];
  let items = [];
  if (ids.length > 0) {
    const data = await (await fetch(`/documents?ids=${ids.join(",")}`)).json();
    items = data.items;
  }
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((d) => (d.display_name || "").toLowerCase().includes(needle));
  }
  items = sortItemsLocally(items);
  state.total = items.length;
  state.lastItems = items;
  state.lastStartNo = 1;
  // 반출대기함 보기는 애초에 페이지 제한이 없는(선택한 것 전부 보여주는) 목록이라 검색조건
  // 전체를 따로 받아올 필요가 없다 — 지금 이 items 자체가 이미 "전체"다.
  renderTable(items, 1, false);
  renderStatusBar();
  // 반출대기함만 보여줄 때는 보통 소량이라 페이지 구분 없이 한 번에 보여준다.
  document.getElementById("page-pos-box").classList.add("hidden");
  document.getElementById("first-page").disabled = true;
  document.getElementById("prev-page").disabled = true;
  document.getElementById("next-page").disabled = true;
  document.getElementById("last-page").disabled = true;
}

// 반출대기함에 이미 담긴 도면은 실제 상태와 별개로 "반출대기"로 표시한다(화면 전용 표시, DB 상태 아님).
function statusCell(doc) {
  if (state.selected.has(doc.id)) {
    return '<span class="badge badge-info">반출대기</span>';
  }
  return statusBadge(doc.status);
}

// "경로" 열: 분류(대분류) 다음부터 시작하는 하위 폴더 경로만 보여준다.
function pathAfterCategory(doc) {
  if (!doc.source_path) return "";
  let rest = doc.source_path;
  if (doc.category && rest.startsWith(doc.category)) {
    rest = rest.slice(doc.category.length).replace(/^\\+/, "");
  }
  return rest.replaceAll("\\", " / ");
}

// searchIconSvg·previewBtnHtml·openDocPreview(이전/다음 포함)는 ui.js 공용 함수를 쓴다.

// 목록 표에 그려진 문서들을 미리보기 팝업이 쓰는 { id, drawingNo, path, pdfFileId } 형태로 정규화한다.
function buildPreviewList(items) {
  return items.map((d) => ({
    id: d.id,
    drawingNo: d.display_name,
    path: pathAfterCategory(d),
    pdfFileId: d.current_pdf_file_id,
    source: tdbSource(d.id),
  }));
}

// useFullNav: true면 미리보기/상세보기 이전·다음이 검색조건 전체(navListPromise)를 따라가고,
// false면 이 items 자체가 이미 전체이므로(반출대기함 보기) 그대로 쓴다.
function renderTable(items, startNo = (state.page - 1) * state.pageSize + 1, useFullNav = true) {
  const tbody = document.getElementById("doc-tbody");
  tbody.innerHTML = "";

  // 상세보기 화면의 이전/다음 이동 — 원칙은 "검색조건 전체"(ensureNavList가 받아 저장한다)이고,
  // 여기 페이지 50건은 그게 아직 안 왔을 때만 쓰는 임시 목록이다(saveDetailNavPageList가 알아서
  // 전체 목록을 덮지 않는다). 반출대기함 보기는 이 items 자체가 곧 전부라 그대로 저장한다.
  if (useFullNav) saveDetailNavPageList(items.map((d) => d.id));
  else saveDetailNavList(items.map((d) => d.id));

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">조건에 맞는 도면이 없습니다.</td></tr>';
    return;
  }

  items.forEach((doc, i) => {
    const tr = document.createElement("tr");
    if (doc.is_isometric) tr.classList.add("iso-row");

    const checked = state.staged.has(doc.id) ? "checked" : "";
    const previewBtn = previewBtnHtml(doc.current_pdf_file_id, tdbHasOriginal(doc));
    tr.innerHTML = `
      <td class="col-no">${startNo + i}</td>
      <td><input type="checkbox" class="row-check" data-id="${doc.id}" ${checked} /></td>
      <td>${previewBtn} <a href="detail.html?id=${doc.id}">${escapeHtml(doc.display_name)}</a></td>
      <td class="muted">${escapeHtml(doc.category ?? "")}</td>
      <td class="muted path-jump" title="${escapeHtml(pathAfterCategory(doc))}">${escapeHtml(pathAfterCategory(doc))}</td>
      <td>${revLabel(doc)}</td>
      <td>${statusCell(doc)}</td>
      <td>${yn(doc.has_dwg)}</td>
      <td>${yn(doc.has_xlsx)}</td>
      <td>${yn(doc.has_etc)}</td>
      <td>${yn(doc.has_pdf)}</td>
      <td class="tc ${recentDateClass(doc.updated_at, doc.is_modified) || "muted"}">${fmtDateTime(doc.updated_at)}</td>
    `;
    tr.querySelector(".path-jump").addEventListener("click", () => {
      if (doc.source_path) selectFolderByPath(doc.source_path);
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

  if (useFullNav) {
    wireFullPreviewButtons(tbody, items);
    // 자료명을 눌러 여는 상세보기도 미리보기와 같이 검색조건 전체를 넘나든다(ui.js).
    wireDetailLinksFullNav(tbody, () => state.navListPromise);
  } else {
    wirePreviewButtons(tbody, buildPreviewList(items));
    wireDetailLinks(tbody, items.map((d) => d.id));
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
  saveState();  // 선택이 바뀔 때마다 반출대기함 보존
  // 반출대기함 담기/빼기로 상태 표시("반출대기")가 바뀌므로 이미 그려둔 표도 다시 그린다.
  if (state.lastItems) renderTable(state.lastItems, state.lastStartNo);
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  document.getElementById("page-pos-box").classList.remove("hidden");
  document.getElementById("page-pos-input").value = state.page;
  document.getElementById("page-total").textContent = totalPages;
  document.getElementById("first-page").disabled = state.page <= 1;
  document.getElementById("prev-page").disabled = state.page <= 1;
  document.getElementById("next-page").disabled = state.page >= totalPages;
  document.getElementById("last-page").disabled = state.page >= totalPages;
}

function search() {
  state.page = 1;
  loadDocuments();
}

document.getElementById("search-btn").addEventListener("click", search);
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") search();
});

// 드롭다운은 고르는 즉시 반영 (검색 버튼 다시 누를 필요 없게)
FILTER_IDS.forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    search();
  });
});

document.getElementById("kind_scope").addEventListener("change", (e) => {
  const shortcutPath = SHORTCUT_FOLDERS[e.target.value];
  if (shortcutPath) {
    e.target.value = "FILE";
    selectFolderByPath(shortcutPath);
    return;
  }
  search();
});

document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("q").value = "";
  document.getElementById("kind_scope").value = "FILE";
  document.getElementById("status").value = "";
  document.getElementById("holding").value = "";
  selectedIso.clear();
  renderIsoList();
  renderIsoToggle();
  modifiedDropdown.reset();
  document.getElementById("recursive_folder").checked = false;
  state.path = "";
  state.sort = "";
  state.sortDir = "asc";
  showSortedColumn("", "asc");
  renderTree();
  loadFolders();
  search();
  docColWidths.reset();
});

document.getElementById("first-page").addEventListener("click", () => {
  if (state.page > 1) {
    state.page = 1;
    loadDocuments();
  }
});

document.getElementById("prev-page").addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadDocuments();
  }
});

document.getElementById("next-page").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < totalPages) {
    state.page += 1;
    loadDocuments();
  }
});

document.getElementById("last-page").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < totalPages) {
    state.page = totalPages;
    loadDocuments();
  }
});

// "N / 전체 M 페이지"의 N을 직접 입력하고 Enter를 치면 그 페이지로 바로 이동한다
// (미리보기 팝업·자료 상세보기와 같은 방식, ui.js의 wireNavPosInput 공용 함수).
wireNavPosInput(
  document.getElementById("page-pos-input"),
  () => Math.max(1, Math.ceil(state.total / state.pageSize)),
  (n) => {
    state.page = n;
    loadDocuments();
  }
);

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

function clearStaged() {
  state.staged.clear();
  document.querySelectorAll(".row-check").forEach((cb) => (cb.checked = false));
  const selectAll = document.getElementById("select-all");
  if (selectAll) selectAll.checked = false;
  updateTotalCountText();
  saveState();
}

// 체크만 해둔 것과 실제 반출대기함(state.selected)은 별개.
// [반출 선택추가]를 눌러야 체크한 도면이 대기함으로 들어간다.
document.getElementById("add-to-cart-btn").addEventListener("click", async () => {
  if (state.staged.size === 0) {
    await showAlert("먼저 목록에서 반출할 도면을 체크해주세요.");
    return;
  }
  for (const id of state.staged) state.selected.add(id);
  clearStaged();
  renderStatusBar();
});

// [반출 폴더추가]: 체크와 무관하게, 지금 선택된 폴더(하위 폴더 포함)의 도면 전부를 대기함에 담는다.
document.getElementById("add-folder-to-cart-btn").addEventListener("click", async () => {
  if (!state.path) {
    await showAlert("먼저 좌측에서 폴더를 선택해주세요.");
    return;
  }
  const ids = await (
    await fetch(`/documents/ids-by-path?${buildQueryString({ path: state.path, iso: [...selectedIso] })}`)
  ).json();
  if (ids.length === 0) {
    await showAlert("이 폴더에는 도면이 없습니다.");
    return;
  }
  const confirmed = await showConfirm(`이 폴더(하위 폴더 포함)의 도면 ${ids.length}건을 반출대기함에 모두 추가하시겠습니까?`);
  if (!confirmed) return;
  for (const id of ids) state.selected.add(id);
  renderStatusBar();
});

// ---- 반출대기함 모달 ----
function cartIsDirty() {
  if (!state.cartDraft) return false;
  if (state.cartDraft.size !== state.selected.size) return true;
  for (const id of state.cartDraft) {
    if (!state.selected.has(id)) return true;
  }
  return false;
}

// 반출대기함 팝업 안에서만 쓰는 삭제용 체크 상태. 대기함을 열 때마다 비운다.
let cartChecked = new Set();

function updateCartSelectAll() {
  const selectAll = document.getElementById("cart-select-all");
  const rowChecks = [...document.querySelectorAll(".cart-row-check")];
  selectAll.checked = rowChecks.length > 0 && rowChecks.every((cb) => cb.checked);
  selectAll.disabled = rowChecks.length === 0;
}

async function renderCartTbody() {
  const tbody = document.getElementById("cart-tbody");
  const ids = [...state.cartDraft];

  if (ids.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">반출대기함이 비어있습니다.</td></tr>';
    updateCartSelectAll();
    return;
  }

  const data = await (await fetch(`/documents?ids=${ids.join(",")}`)).json();
  tbody.innerHTML = "";
  const previewList = buildPreviewList(data.items);
  data.items.forEach((doc, i) => {
    const tr = document.createElement("tr");
    const checked = cartChecked.has(doc.id) ? "checked" : "";
    const previewBtn = previewBtnHtml(doc.current_pdf_file_id, tdbHasOriginal(doc));
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td><input type="checkbox" class="cart-row-check" data-id="${doc.id}" ${checked} /></td>
      <td>${previewBtn} ${escapeHtml(doc.display_name)}</td>
      <td class="muted">${escapeHtml(doc.category ?? "")}</td>
      <td class="muted">${escapeHtml(pathAfterCategory(doc))}</td>
    `;
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

let cartTableResizableInit = false;

document.getElementById("cart-open-btn").addEventListener("click", async () => {
  state.cartDraft = new Set(state.selected);
  cartChecked = new Set();
  await renderCartTbody();
  document.getElementById("cart-modal").classList.remove("hidden");
  if (!cartTableResizableInit) {
    makeColumnsResizable(document.getElementById("cart-table"));
    makeSortable(document.getElementById("cart-table"));
    cartTableResizableInit = true;
  }
});

function closeCartModal() {
  document.getElementById("cart-modal").classList.add("hidden");
  state.cartDraft = null;
}

// 네이티브 confirm()은 브라우저 주소가 찍혀 나와서 자체 대화상자로 대체.
// [저장하고 닫기] / [저장 안 함] / [취소] 세 갈래.
function askSaveBeforeClose() {
  return new Promise((resolve) => {
    const dialog = document.getElementById("unsaved-dialog");
    const saveBtn = document.getElementById("unsaved-save-btn");
    const discardBtn = document.getElementById("unsaved-discard-btn");
    const cancelBtn = document.getElementById("unsaved-cancel-btn");

    function cleanup(result) {
      dialog.classList.add("hidden");
      saveBtn.removeEventListener("click", onSave);
      discardBtn.removeEventListener("click", onDiscard);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onSave() { cleanup("save"); }
    function onDiscard() { cleanup("discard"); }
    function onCancel() { cleanup("cancel"); }

    saveBtn.addEventListener("click", onSave);
    discardBtn.addEventListener("click", onDiscard);
    cancelBtn.addEventListener("click", onCancel);
    dialog.classList.remove("hidden");
  });
}

document.getElementById("cart-close-btn").addEventListener("click", async () => {
  if (!cartIsDirty()) {
    closeCartModal();
    return;
  }
  const choice = await askSaveBeforeClose();
  if (choice === "save") {
    state.selected = new Set(state.cartDraft);
    renderStatusBar();
    closeCartModal();
  } else if (choice === "discard") {
    closeCartModal();
  }
  // "cancel"이면 대기함 창을 계속 열어둔다.
});

document.getElementById("cart-delete-btn").addEventListener("click", () => {
  if (cartChecked.size === 0) return;
  for (const id of cartChecked) state.cartDraft.delete(id);
  cartChecked.clear();
  renderCartTbody();
});

document.getElementById("cart-export-btn").addEventListener("click", () => {
  const ids = [...state.cartDraft];
  if (ids.length === 0) return;
  window.location = `/documents/export?ids=${ids.join(",")}&columns=cart`;
});

document.getElementById("cart-save-btn").addEventListener("click", () => {
  state.selected = new Set(state.cartDraft);
  renderStatusBar();
  closeCartModal();
});

document.getElementById("cart-distribute-btn").addEventListener("click", () => {
  state.selected = new Set(state.cartDraft);
  renderStatusBar();
  closeCartModal();
  openDistributeModal();
});

document.getElementById("export-btn").addEventListener("click", () => {
  const qs = buildQueryString(currentFilters());
  window.location.href = `/documents/export?${qs}`;
});

let allProjects = []; // [{id, name, created_at, ...}] — 기간 필터 전 원본

async function loadProjects() {
  const res = await fetch("/projects");
  if (!res.ok) return; // VIEWER는 반출 기능이 없어 이 API도 막혀있다 — 조용히 넘어간다
  allProjects = await res.json();
  applyProjectDateFilter();
}

// "공사" 드롭다운을 등록일(공사 등록기간) 기준으로 좁힌다. 공사가 많아지면 스크롤로 찾기
// 번거로우므로, 대략 언제 등록했는지만 알아도 후보를 줄일 수 있게 하는 검색 보조 기능.
function applyProjectDateFilter() {
  const from = document.getElementById("dist-project-date-from").value;
  const to = document.getElementById("dist-project-date-to").value;
  const filtered = allProjects.filter((p) => {
    const created = (p.created_at || "").slice(0, 10);
    if (from && created < from) return false;
    if (to && created > to) return false;
    return true;
  });

  const prevValue = projectDropdown.getValue();
  projectDropdown.setOptions(filtered.map((p) => ({ value: p.id, label: p.name })));
  // 지금 골라둔 공사가 기간 필터에 걸러지면 선택을 지워서 화면 표시와 실제 값이 어긋나지 않게 한다.
  if (prevValue && filtered.some((p) => String(p.id) === String(prevValue))) {
    projectDropdown.setValue(prevValue);
  } else if (prevValue) {
    projectDropdown.setValue("");
  }
}

document.getElementById("dist-project-date-from").addEventListener("change", applyProjectDateFilter);
document.getElementById("dist-project-date-to").addEventListener("change", applyProjectDateFilter);

// 공사를 뭘 고르든 등록된 업체 전체를 보여준다(공사별로 좁히지 않음). 새 업체는 아래 입력창+추가 버튼으로.
async function loadDistVendors() {
  const vendors = await (await fetch("/vendors")).json();
  const prevValue = vendorDropdown.getValue();
  vendorDropdown.setOptions(vendors.map((v) => ({ value: v, label: v })));
  if (vendors.includes(prevValue)) vendorDropdown.setValue(prevValue);
}

// 공사는 반출·리비전 기록의 FK로 계속 쓰이므로 이 드롭다운에서는 숨기기(X) 기능을 두지 않는다.
const projectDropdown = createHideableDropdown("dist-project-dropdown", {
  onSelect: () => loadDistVendors(),
  // 공사명을 바꾸면 documents/files/distributions가 전부 공사를 id로 참조하므로,
  // 과거에 그 공사로 반출·등록됐던 기록들의 표시 이름도 자동으로 같이 바뀐다.
  onEdit: async (id, newName) => {
    const res = await fetch(`/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) {
      await showAlert("공사명 수정 중 오류가 발생했습니다.");
      return;
    }
    const prevValue = projectDropdown.getValue();
    await loadProjects();
    if (String(prevValue) === String(id)) projectDropdown.setValue(id);
  },
});

// 업체는 이 드롭다운에서 삭제(숨기기) 기능을 두지 않는다 — 이름 수정만 가능.
const vendorDropdown = createHideableDropdown("dist-vendor-dropdown", {
  onSelect: () => {},
  // 업체는 마스터 테이블 없이 과거 기록에 이름 문자열로 박혀있으므로, 바꾸면 그 이름이 쓰인
  // 모든 반출·리비전 기록의 업체명도 서버에서 한꺼번에 바꿔치기된다.
  onEdit: async (oldName, newName) => {
    const res = await fetch("/vendors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      await showAlert(err?.detail || "업체명 수정 중 오류가 발생했습니다.");
      return;
    }
    const prevValue = vendorDropdown.getValue();
    await loadDistVendors();
    if (prevValue === oldName) vendorDropdown.setValue(newName);
  },
});

async function openDistributeModal() {
  if (state.selected.size === 0) {
    await showAlert("반출할 도면을 먼저 선택해주세요.");
    return;
  }
  document.getElementById("distribute-warning").classList.add("hidden");
  document.getElementById("dist-project-date-from").value = "";
  document.getElementById("dist-project-date-to").value = "";
  projectDropdown.setValue("");
  vendorDropdown.setValue("");
  // 수정용 권한이 없으면 그 라디오가 흐리게 비활성화돼 있으므로(data-perm), 기본 선택도
  // 참조용으로 잡는다 — 안 그러면 고를 수 없는 수정용이 체크된 채로 남는다.
  const canModify = (window.__tdmsPerms || new Set()).has("screen.tdb_list.distribute.modify");
  document.querySelector(`input[name="purpose"][value="${canModify ? "MODIFY" : "REFERENCE"}"]`).checked = true;
  document.getElementById("purpose-other-note").value = "";
  document.getElementById("dist-keep-paths").checked = true;  // 항상 켜진 상태로 시작
  updateDistPurposeFieldStates();
  await loadProjects();
  await loadDistVendors();
  document.getElementById("distribute-modal").classList.remove("hidden");
}

// 반출 목적이 "수정용"일 때만 공사·업체를 고를 수 있다(참조용·기타는 대상이 불명확해도 되므로).
// 사유 입력칸은 목적과 상관없이 항상 쓸 수 있다.
function updateDistPurposeFieldStates() {
  const purpose = document.querySelector('input[name="purpose"]:checked').value;
  const isModify = purpose === "MODIFY";

  if (!isModify) {
    projectDropdown.setValue("");
    vendorDropdown.setValue("");
    document.getElementById("dist-project-date-from").value = "";
    document.getElementById("dist-project-date-to").value = "";
  }
  // 수정용은 업체가 받은 폴더 구조 그대로 작업해 돌려줘야 하므로 [폴더 경로 유지]를 켠 채로
  // 잠근다(회색). 참조용·기타는 풀 수 있고, 풀면 자료와 엑셀 목록이 한 폴더에 모여 나간다.
  const keepPaths = document.getElementById("dist-keep-paths");
  if (isModify) keepPaths.checked = true;
  keepPaths.disabled = isModify;
  document.getElementById("dist-keep-paths-label").classList.toggle("is-locked", isModify);

  document.getElementById("dist-project-date-from").disabled = !isModify;
  document.getElementById("dist-project-date-to").disabled = !isModify;
  document.querySelector("#dist-project-dropdown .dropdown-toggle").disabled = !isModify;
  document.getElementById("new-project-name").disabled = !isModify;
  document.getElementById("add-project-btn").disabled = !isModify;
  document.querySelector("#dist-vendor-dropdown .dropdown-toggle").disabled = !isModify;
  document.getElementById("new-vendor-name").disabled = !isModify;
  document.getElementById("add-vendor-btn").disabled = !isModify;
}

document.querySelectorAll('input[name="purpose"]').forEach((radio) => {
  radio.addEventListener("change", updateDistPurposeFieldStates);
});

document.getElementById("distribute-cancel-btn").addEventListener("click", () => {
  document.getElementById("distribute-modal").classList.add("hidden");
});

document.getElementById("add-project-btn").addEventListener("click", async () => {
  const nameInput = document.getElementById("new-project-name");
  const name = nameInput.value.trim();
  if (!name) return;

  const res = await fetch("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await showAlert(err?.detail || "공사 추가 중 오류가 발생했습니다.");
    return;
  }
  const project = await res.json();

  // 방금 만든 공사는 등록기간 필터에 걸려 목록에서 빠질 수 있으니(오늘 날짜가 필터 밖일 때)
  // 필터를 지워서 바로 보이고 선택되게 한다.
  document.getElementById("dist-project-date-from").value = "";
  document.getElementById("dist-project-date-to").value = "";
  await loadProjects();
  projectDropdown.setValue(project.id);
  await loadDistVendors();
  nameInput.value = "";
});

document.getElementById("add-vendor-btn").addEventListener("click", async () => {
  const nameInput = document.getElementById("new-vendor-name");
  const name = nameInput.value.trim();
  if (!name) return;

  const existingOptions = vendorDropdown.getOptions();
  const duplicate = existingOptions.find((o) => o.label.trim().toLowerCase() === name.toLowerCase());
  if (duplicate) {
    await showAlert(`이미 등록된 업체명입니다: ${duplicate.label}`);
    return;
  }

  vendorDropdown.setOptions([...existingOptions, { value: name, label: name }]);
  vendorDropdown.setValue(name);
  nameInput.value = "";
});

document.getElementById("distribute-submit-btn").addEventListener("click", async () => {
  const purpose = document.querySelector('input[name="purpose"]:checked').value;
  const isModify = purpose === "MODIFY";
  const vendor = vendorDropdown.getValue().trim();
  const projectValue = projectDropdown.getValue();
  if (isModify && !projectValue) {
    await showAlert("공사를 선택해주세요.");
    return;
  }
  if (isModify && !vendor) {
    await showAlert("업체를 선택해주세요.");
    return;
  }
  const purposeNote = document.getElementById("purpose-other-note").value.trim();

  const res = await fetch("/distributions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_ids: [...state.selected],
      vendor: isModify ? vendor : "",
      project_id: isModify && projectValue ? Number(projectValue) : null,
      purpose,
      purpose_note: purposeNote || null,
      keep_paths: isModify ? true : document.getElementById("dist-keep-paths").checked,
    }),
  });

  if (!res.ok) {
    await showAlert("반출 처리 중 오류가 발생했습니다.");
    return;
  }

  const data = await res.json();
  const duplicates = data.results.filter((r) => r.duplicate_warning);
  if (duplicates.length > 0) {
    const box = document.getElementById("distribute-warning");
    box.textContent =
      `이미 반출 중(미반입)인 도면이 있습니다: ` +
      duplicates.map((r) => r.display_name).join(", ");
    box.classList.remove("hidden");
  }

  const ids = data.results.map((r) => r.distribution_id).join(",");
  window.location.href = `/distributions/download-zip?ids=${ids}`;

  document.getElementById("distribute-modal").classList.add("hidden");
  state.selected.clear();
  renderStatusBar();
  loadDocuments();
});

// Isometric 드롭다운 변경 시 폴더 트리·목록 갱신은 renderIsoList()의 체크박스 change에서 처리한다.

// "폴더 이하 전체보기" 토글은 트리 건수(항상 하위 포함 누계)엔 영향 없고, 지금 보이는 목록만 바뀐다
document.getElementById("recursive_folder").addEventListener("change", search);

// ---- 폴더 트리 폭 조정 ----
function setupTreeResize() {
  const treePanel = document.querySelector(".tree-panel");
  const handle = document.getElementById("tree-resize-handle");
  if (!treePanel || !handle) return;
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 640;

  const saved = Number(localStorage.getItem("dms_tree_width"));
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
      localStorage.setItem("dms_tree_width", finalWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
setupTreeResize();

// 표 헤더를 누르면 화면의 50건만이 아니라 조회 결과 전체가 정렬돼야 하므로(공통 규칙),
// 서버에 정렬 조건을 보내고 1페이지부터 다시 받아온다. showSortedColumn은 화면을 다녀와서
// 저장해둔 정렬로 다시 그렸을 때 "지금 어느 열로 정렬 중인지" 표시를 되살리는 데 쓴다.
let showSortedColumn = () => {};

// 폐기 보관함 — 관리 화면과 같은 팝업(ui.js)을 쓰되 조회 화면에서는 보기만 된다
// (선택 복구·조치 칸이 없고 비고도 읽기 전용). 일반 사용자도 폐기 이력을 볼 수 있어야
// 한다는 것이 이 버튼이 조회 화면에도 있는 이유다 (2026-08-30 CM 확정).
document.getElementById("retired-open-btn").addEventListener("click", () => {
  openRetiredPopup("tdb", { screen: "TDB 조회" });
});

async function init() {
  restoreState();
  refreshRetiredCount("tdb");
  loadFolders();
  loadProjects();
  await loadDocuments();
  // "경로" 열은 폭을 지정 안 해서(auto) 실제 렌더된 폭을 읽어와야 하는데,
  // 표에 행이 아직 없으면 그 폭이 0으로 읽혀서 리사이즈 계산이 어긋난다. 그래서 로딩 후에 건다.
  // 화면전환(상세보기 다녀오기) 후에도 사용자가 조절한 너비가 유지되도록, resizable 걸기 전에 먼저 복원한다.
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
