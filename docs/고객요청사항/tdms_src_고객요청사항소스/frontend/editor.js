// TDB 관리 화면 — TDB 조회의 검색·폴더 트리·결과 표 구성을 그대로 쓰고, 그 아래에
// 폴더명·자료명 확인 카드와 폴더 편집·자료 편집·Zip 폴더 업로드 3단을 얹었다.
// 서버 데이터: 폴더 트리는 /editor/tree(폴더 목록 + placeholder), 결과 표는 /documents.

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showResult(boxId, cls, text) {
  const box = document.getElementById(boxId);
  box.className = `result-box ${cls}`;
  box.textContent = text;
}

// "검색대상" 드롭다운의 P&ID/PDF는 검색 범위가 아니라 자주 찾는 폴더 바로가기다 — 골라도
// 실제 검색대상 값은 그대로 "자료명"으로 되돌리고, 그 폴더를 트리에서 선택한 것처럼 동작한다.
const SHORTCUT_FOLDERS = {
  SHORTCUT_PID: "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)",
  SHORTCUT_PDF: "3. PROCESS & FACILITIES DESCRIPTION\\3.2 Process Flow Diagram (PFD)",
};

function folderDisplayName(path) {
  const parts = path.split("\\");
  return parts[parts.length - 1];
}

function firstNum(name) {
  const m = String(name).match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

function fileStem(filename) {
  return filename.replace(/\.[^./\\]+$/, "");
}

// ---------------------------------------------------------------------------
// 원본/PDF 한쪽만 있는 자료 확인 팝업 — 신규추가·Zip 등록 공용.
// items: [{ stem, ext, file }]. file은 신규추가처럼 브라우저가 이미 실제 파일을 들고
// 있을 때만 넣는다(그 자리에서 미리보기 가능) — Zip 등록은 아직 압축을 풀기 전이라 file이
// 없고, 이 경우 미리보기는 "등록 후 확인 가능"으로 안내만 한다.
// 반환값: 등록 진행이면 true, 취소면 false.
// ---------------------------------------------------------------------------
function extBucketCols(ext) {
  const e = (ext || "").toLowerCase();
  return {
    dwg: e === "dwg",
    xlsx: e === "xlsx" || e === "xls",
    etc: !["dwg", "xlsx", "xls", "pdf"].includes(e),
    pdf: e === "pdf",
  };
}

function ensurePartialModal() {
  let root = document.getElementById("partial-modal");
  if (root) return root;
  root = document.createElement("div");
  root.id = "partial-modal";
  root.className = "modal-overlay hidden";
  root.innerHTML = `
    <div class="picker-box partial-box">
      <div class="picker-head"><span id="partial-title"></span></div>
      <div class="picker-tabs">
        <span></span>
        <button id="partial-export-btn" class="cart-btn" type="button">엑셀 내보내기</button>
      </div>
      <div class="picker-scroll">
        <table id="partial-table">
          <colgroup>
            <col style="width:54px" />
            <col />
            <col style="width:70px" />
            <col style="width:70px" />
            <col style="width:70px" />
            <col style="width:70px" />
          </colgroup>
          <thead>
            <tr><th>No</th><th>자료명</th><th>DWG</th><th>XLSX</th><th>ETC</th><th>PDF</th></tr>
          </thead>
          <tbody id="partial-tbody"></tbody>
        </table>
      </div>
      <div class="picker-actions">
        <button id="partial-cancel" type="button">취소</button>
        <button id="partial-confirm" class="primary" type="button">등록 진행</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  makeSortable(document.getElementById("partial-table"));
  return root;
}

async function exportPartialFiles(title, items) {
  const res = await fetch("/editor/partial-files/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, items: items.map((it) => ({ stem: it.stem, ext: it.ext })) }),
  });
  if (!res.ok) { await showAlert("엑셀 내보내기에 실패했습니다."); return; }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = match ? decodeURIComponent(match[1]) : `${title}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showPartialFilesConfirm(title, items) {
  const root = ensurePartialModal();
  document.getElementById("partial-title").textContent = `${title} (${items.length}건)`;

  const tbody = document.getElementById("partial-tbody");
  tbody.innerHTML = items.map((it, i) => {
    const cols = extBucketCols(it.ext);
    return `
      <tr>
        <td class="col-no">${i + 1}</td>
        <td>${esc(it.stem)}</td>
        <td class="tc">${yn(cols.dwg)}</td>
        <td class="tc">${yn(cols.xlsx)}</td>
        <td class="tc">${yn(cols.etc)}</td>
        <td class="tc">${yn(cols.pdf)}</td>
      </tr>`;
  }).join("");

  document.getElementById("partial-export-btn").onclick = () => exportPartialFiles("원본·사본 확인", items);

  root.classList.remove("hidden");
  // 열려서 실제 폭이 잡힌 뒤에 계산해야 "자료명" 열(너비 미지정)이 나머지 폭을 정확히 받는다
  // (숨은 상태에서 계산하면 표 폭이 0으로 읽혀 이 열이 최소폭으로 굳어버린다).
  makeColumnsResizable(document.getElementById("partial-table"));

  return new Promise((resolve) => {
    const cancelBtn = document.getElementById("partial-cancel");
    const confirmBtn = document.getElementById("partial-confirm");
    function finish(result) {
      root.classList.add("hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    }
    function onCancel() { finish(false); }
    function onConfirm() { finish(true); }
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

// ---------------------------------------------------------------------------
// 원본·사본(DWG·PDF) 폴더 생성 — 초기 자료 적재 등으로 DWG 폴더·PDF 폴더가 따로따로
// 등록돼 아직 하나로 합쳐지지 않은 폴더를 찾아, CM이 고른 것만 병합한다.
// ---------------------------------------------------------------------------
function ensurePairMergeModal() {
  let root = document.getElementById("pair-merge-modal");
  if (root) return root;
  root = document.createElement("div");
  root.id = "pair-merge-modal";
  root.className = "modal-overlay hidden";
  root.innerHTML = `
    <div class="picker-box pair-merge-box">
      <div class="picker-head"><span id="pm-title">DWG·PDF 폴더 병합</span></div>
      <div class="picker-tabs">
        <span></span>
        <button id="pm-export-btn" class="cart-btn" type="button">엑셀 내보내기</button>
      </div>
      <div class="picker-scroll">
        <table id="pm-table">
          <colgroup>
            <col style="width:56px" />
            <col style="width:44px" />
            <col />
            <col style="width:110px" />
            <col style="width:110px" />
            <col style="width:150px" />
            <col style="width:170px" />
          </colgroup>
          <thead>
            <tr>
              <th>No</th>
              <th class="col-check"><input type="checkbox" id="pm-select-all" /></th>
              <th>병합 대상 폴더 경로</th>
              <th>DWG 자료</th>
              <th>PDF 자료</th>
              <th>합칠 수 있는 자료</th>
              <th>대소문자만 다름</th>
            </tr>
          </thead>
          <tbody id="pm-tbody"></tbody>
        </table>
      </div>
      <div class="picker-actions">
        <button id="pm-cancel" type="button">취소</button>
        <button id="pm-confirm" class="primary" type="button">선택 폴더 합치기</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  return root;
}

function closePairMergeModal() {
  const root = document.getElementById("pair-merge-modal");
  if (root) root.classList.add("hidden");
}

// 대소문자만 달라서 못 합치는 자료 — 합쳐주지 않고 알리기만 한다. 어느 쪽 표기가 맞는지는
// CM이 정할 문제이고, [자료명 변경]으로 한쪽을 고치면 그때부터 합칠 수 있다.
function caseMismatchCell(c) {
  if (!c.case_mismatch_count) return "-";
  const list = (c.case_mismatch_names || []).join("\n");
  return `<span title="${esc(list)}\n\n대소문자가 달라 합쳐지지 않습니다. 자료명을 서로 같게 고치면 합칠 수 있습니다.">${c.case_mismatch_count}건</span>`;
}

async function openPairFolderMergeModal() {
  const res = await fetch("/editor/pair-folders/candidates");
  if (!res.ok) {
    await showAlert("목록을 불러오지 못했습니다: " + (await safeErrText(res)));
    return;
  }
  const data = await res.json();
  const candidates = data.candidates || [];
  if (!candidates.length) {
    await showAlert("DWG·PDF 폴더가 나란히 있지만 아직 합쳐지지 않은 폴더가 없습니다.");
    return;
  }

  const root = ensurePairMergeModal();
  const tbody = document.getElementById("pm-tbody");
  tbody.innerHTML = candidates.map((c, i) => `
    <tr>
      <td class="col-no">${i + 1}</td>
      <td class="tc"><input type="checkbox" class="pm-row-check" data-path="${esc(c.path)}" /></td>
      <td class="col-path">${esc(c.path.replaceAll("\\", " / ") || "(최상위)")}</td>
      <td class="tc">${c.dwg_count}</td>
      <td class="tc">${c.pdf_count}</td>
      <td class="tc">${c.mergeable_count}</td>
      <td class="tc">${caseMismatchCell(c)}</td>
    </tr>`).join("");

  const selectAll = document.getElementById("pm-select-all");
  selectAll.checked = false;
  selectAll.onchange = () => {
    tbody.querySelectorAll(".pm-row-check").forEach((cb) => { cb.checked = selectAll.checked; });
  };

  document.getElementById("pm-export-btn").onclick = () => exportPairFolderCandidates();

  root.classList.remove("hidden");
  // 열려서 실제 폭이 잡힌 뒤에 계산해야 "폴더" 열(너비 미지정)이 나머지 폭을 정확히 받는다.
  makeColumnsResizable(document.getElementById("pm-table"));

  return new Promise((resolve) => {
    const cancelBtn = document.getElementById("pm-cancel");
    const confirmBtn = document.getElementById("pm-confirm");
    function finish() {
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve();
    }
    function onCancel() { closePairMergeModal(); finish(); }
    async function onConfirm() {
      const paths = [...tbody.querySelectorAll(".pm-row-check:checked")].map((cb) => cb.dataset.path);
      if (!paths.length) {
        await showAlert("합칠 폴더를 하나 이상 선택하세요.");
        return;
      }
      const ok = await showConfirm(
        `선택한 폴더 ${paths.length}건의 DWG·PDF 자료를 합칩니다.\n` +
        "합쳐진 자료는 DWG·PDF 폴더가 화면에서 감춰지고 1건으로 보이며, 저장 위치와 반출 폴더에는 그대로 남습니다.\n\n계속하시겠습니까?",
      );
      if (!ok) return;
      const mres = await fetch("/editor/pair-folders/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!mres.ok) {
        await showAlert("병합 중 문제가 발생했습니다: " + (await safeErrText(mres)));
        return;
      }
      const mdata = await mres.json();
      closePairMergeModal();
      finish();
      await loadTree();
      await loadDocuments();
      let msg = `자료 ${mdata.merged}건을 합쳤습니다.`;
      if (mdata.skipped && mdata.skipped.length) {
        msg += `\n\n다음 ${mdata.skipped.length}건은 합치지 못했습니다:\n`;
        msg += mdata.skipped.map((s) => `${s.path.replaceAll("\\", " / ")} / ${s.drawing_no} — ${s.reason}`).join("\n");
      }
      await showAlert(msg);
    }
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

async function exportPairFolderCandidates() {
  const res = await fetch("/editor/pair-folders/candidates/export");
  if (!res.ok) { await showAlert("엑셀 내보내기에 실패했습니다."); return; }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = match ? decodeURIComponent(match[1]) : "DWG_PDF_폴더_병합.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
const state = {
  // 결과 표
  page: 1,
  pageSize: 50,
  total: 0,
  lastItems: [],
  lastStartNo: 1,

  // 폴더 트리
  treeFolders: [],       // /editor/tree의 folders (경로 + 자료 수 + placeholder 여부)
  treeRoot: null,        // 조립한 트리 루트
  expanded: new Set(),   // 펼쳐진 폴더 경로들

  // 선택 상태 — 폴더는 트리에서 1개, 자료는 결과 표에서 여러 개(체크박스, TDB 조회 화면과 같은 방식)
  //   폴더: { kind:'root' } | { kind:'folder', path, docCount, isPlaceholder }
  //   자료: 자료 id의 Set. 페이지를 넘겨도 유지된다(TDB 조회의 반출대기 체크와 같은 방식).
  selectedFolder: null,
  selectedDocIds: new Set(),

  sort: "",          // 표 헤더를 눌러 정한 정렬 기준 열(빈값이면 기본 = 자료명순)
  sortDir: "asc",    // asc(오름차순) / desc(내림차순)

  navFiltersKey: null,  // 아래 navListPromise가 지금 어떤 검색조건 기준인지(같으면 재사용, 다르면 새로 받음)
  navListPromise: null, // 미리보기/상세보기 "이전·다음"이 페이지(50건)가 아니라 검색조건 전체를 넘나들게 해주는 가벼운 목록
};

const selectedIso = new Set();
const ISO_OPTIONS = [
  { value: "PROCESS", label: "Process" },
  { value: "STEAM", label: "Steam Tracing" },
];

// ---------------------------------------------------------------------------
// Isometric 다중선택 드롭다운 — TDB 조회 화면과 같은 동작
// ---------------------------------------------------------------------------
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
      loadTree();
      search();
    });
  });
}

function renderIsoToggle() {
  const toggle = document.getElementById("iso-toggle");
  if (selectedIso.size === 0) toggle.textContent = "선택 안 함";
  else if (selectedIso.has("PROCESS") && selectedIso.has("STEAM")) toggle.textContent = "전체";
  else toggle.textContent = [...selectedIso].map((v) => ISO_OPTIONS.find((o) => o.value === v)?.label ?? v).join(", ");
}

document.getElementById("iso-toggle").addEventListener("click", () => {
  document.getElementById("iso-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("iso-dropdown").contains(e.target)) {
    document.getElementById("iso-list").classList.add("hidden");
  }
});

// ---------------------------------------------------------------------------
// 필터 → 쿼리 문자열
// ---------------------------------------------------------------------------
// "숨김 폴더 보기" — 평소 감춰두는 DWG·PDF 폴더를 트리에 드러내고, 자료도 파일이 실제로
// 들어있는 폴더 밑에서 찾는다(real_path). 원본이 DWG 폴더, 사본이 PDF 폴더에 나뉘어 있으면
// 같은 자료가 두 폴더 모두에서 보인다.
function showHiddenFolders() {
  return document.getElementById("show_hidden_folders").checked;
}

function currentFilters() {
  return {
    q: document.getElementById("q").value.trim(),
    kind_scope: document.getElementById("kind_scope").value,
    status: document.getElementById("status").value,
    holding: document.getElementById("holding").value,
    iso: [...selectedIso],
    recursive: document.getElementById("recursive_folder").checked,
    real_path: showHiddenFolders(),
    path: state.selectedFolder && state.selectedFolder.kind === "folder" ? state.selectedFolder.path : "",
    // 정렬은 화면의 50건이 아니라 조회 결과 전체가 기준이라 서버로 같이 보낸다(TDB 조회와 동일).
    sort: state.sort,
    dir: state.sortDir,
  };
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) usp.append(key, v);
    else usp.set(key, value);
  }
  return usp.toString();
}

// ---------------------------------------------------------------------------
// 화면 이동 후 돌아와도 검색조건·선택폴더가 유지되도록 sessionStorage에 저장/복원
// (TDB 조회 script.js와 같은 방식). 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다.
// ---------------------------------------------------------------------------
const STATE_KEY = "dms_editor_state";

function saveState() {
  const sf = state.selectedFolder;
  const snapshot = {
    ...currentFilters(),
    page: state.page,
    selectedDocIds: [...state.selectedDocIds],
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
    document.getElementById("q").value = s.q || "";
    document.getElementById("kind_scope").value = s.kind_scope || "FILE";
    document.getElementById("status").value = s.status || "";
    document.getElementById("holding").value = s.holding || "";
    selectedIso.clear();
    (s.iso || []).forEach((v) => selectedIso.add(v));
    renderIsoList();
    renderIsoToggle();
    document.getElementById("recursive_folder").checked = !!s.recursive;
    document.getElementById("show_hidden_folders").checked = !!s.real_path;
    state.sort = s.sort || "";
    state.sortDir = s.dir || "asc";
    state.page = s.page || 1;
    state.selectedDocIds = new Set(s.selectedDocIds || []);
    state.expanded = new Set(s.expanded || []);
    if (s.folderKind === "root") {
      state.selectedFolder = { kind: "root" };
    } else if (s.folderKind === "folder" && s.folderPath) {
      // docCount·isPlaceholder는 loadTree()가 실제 트리를 받으면 다시 채워준다
      state.selectedFolder = { kind: "folder", path: s.folderPath, docCount: 0, isPlaceholder: false };
    } else {
      state.selectedFolder = null;
    }
  } catch (e) {
    /* 무시 */
  }
}

// ---------------------------------------------------------------------------
// 폴더 트리 — /editor/tree 응답의 folders(자료가 있는 경로 + placeholder)를 조립. 자료(파일)는
// 트리에 안 넣는다(결과 표에서만 보여준다).
// ---------------------------------------------------------------------------
function buildTree(folders) {
  const root = { name: "", path: "", children: new Map(), docCount: 0, isPlaceholder: false, isPair: false };
  folders.forEach((f) => {
    const parts = f.path.split("\\").filter(Boolean);
    let node = root;
    const acc = [];
    for (const part of parts) {
      acc.push(part);
      const full = acc.join("\\");
      if (!node.children.has(full)) {
        node.children.set(full, { name: part, path: full, children: new Map(), docCount: 0, isPlaceholder: false, isPair: false });
      }
      node = node.children.get(full);
      node.docCount += f.doc_count;
    }
    if (f.is_placeholder) node.isPlaceholder = true;
    if (f.is_pair) node.isPair = true;  // 평소엔 안 보이는 DWG·PDF 폴더
    if (f.split_count) node.splitCount = f.split_count;  // 고치면 두 건으로 나뉠 자료 수(경고용)
  });
  return root;
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => naturalCompare(a.name, b.name));
}

// 트리(중첩 Map) 안에서 경로로 노드를 찾는다. docCount는 여기서 하위 폴더까지 합산된 값이라
// buildTree() 결과에서 찾아야 클릭으로 고를 때와 같은 숫자가 나온다(원본 folders 배열의
// doc_count는 그 폴더 하나만의 건수라 다르다).
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
  const prevScrollTop = container.scrollTop;
  container.innerHTML = "";
  if (!state.treeRoot) return;
  sortedChildren(state.treeRoot).forEach((n) => renderTreeNode(n, container, 0));
  container.scrollTop = prevScrollTop;
}

// 트리를 직접 클릭한 것과 똑같이 특정 폴더를 선택 상태로 만든다 (검색대상 P&ID/PDF 바로가기용).
function selectFolderByPath(path) {
  const node = state.treeRoot ? findTreeNode(state.treeRoot, path) : null;
  state.selectedFolder = node
    ? { kind: "folder", path: node.path, docCount: node.docCount, isPlaceholder: node.isPlaceholder, isPair: node.isPair, splitCount: node.splitCount }
    : { kind: "folder", path, docCount: 0, isPlaceholder: true, isPair: false };
  const parts = path.split("\\").filter(Boolean);
  const acc = [];
  for (const part of parts) {
    acc.push(part);
    state.expanded.add(acc.join("\\"));
  }
  state.page = 1;
  renderTree();
  renderPanels();
  loadDocuments();
  // 트리가 길면 지금 화면 밖일 수 있어, 선택된 폴더가 보이는 위치로 스크롤한다.
  document.querySelector("#folder-tree .tree-node.active")?.scrollIntoView({ block: "center" });
}

function renderTreeNode(node, container, depth) {
  const hasKids = node.children.size > 0;
  const isOpen = state.expanded.has(node.path);
  const isSelected = state.selectedFolder && state.selectedFolder.kind === "folder" && state.selectedFolder.path === node.path;

  const row = document.createElement("div");
  row.className = "tree-node" + (isSelected ? " active" : "") + (node.isPair ? " pair-folder" : "");
  row.dataset.depth = Math.min(depth, 3);
  row.style.paddingLeft = `${8 + depth * 14}px`;
  if (node.isPair) row.title = "평소에는 트리에 안 보이는 폴더입니다 (원본·사본이 나뉘어 담긴 자리)";
  row.innerHTML = `
    <span class="tree-toggle">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span>
    <span class="tree-icon">📁</span>
    <span class="tree-label">${esc(node.name)}</span>
    <span class="tree-count">(${node.docCount})</span>`;

  // 접기/펼치기만 한 경우엔 결과 표를 다시 부르지 않으므로(=saveState를 타지 않으므로)
  // 여기서 직접 저장해야 다른 화면에 갔다 돌아왔을 때 펼쳐둔 모양이 그대로 남는다.
  row.querySelector(".tree-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!hasKids) return;
    if (isOpen) state.expanded.delete(node.path);
    else state.expanded.add(node.path);
    renderTree();
    saveState();
  });
  row.addEventListener("click", () => {
    state.selectedFolder = { kind: "folder", path: node.path, docCount: node.docCount, isPlaceholder: node.isPlaceholder, isPair: node.isPair, splitCount: node.splitCount };
    state.expanded.add(node.path);
    state.page = 1;
    renderTree();
    renderPanels();
    loadDocuments();
  });
  // 폴더명을 더블클릭하면 세모 버튼과 똑같이 접기/펼치기만 토글(선택은 그대로 유지)
  row.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (!hasKids) return;
    if (isOpen) state.expanded.delete(node.path);
    else state.expanded.add(node.path);
    renderTree();
    saveState();
  });

  container.appendChild(row);

  if (hasKids && isOpen) {
    for (const child of sortedChildren(node)) renderTreeNode(child, container, depth + 1);
  }
}

async function loadTree() {
  const res = await fetch(`/editor/tree?show_hidden=${showHiddenFolders() ? "true" : "false"}`);
  const data = await res.json();
  state.treeFolders = data.folders;
  state.treeRoot = buildTree(state.treeFolders);
  // 디폴트(펼친 폴더 없음)는 최상위 폴더 이름만 보이고 전부 접힌 상태다(2026-08-16 CM 확정).
  // 기존 선택(복원된 선택 포함)이 사라진 폴더면 해제, 남아있으면 최신 docCount로 갱신
  if (state.selectedFolder && state.selectedFolder.kind === "folder") {
    const node = findTreeNode(state.treeRoot, state.selectedFolder.path);
    if (node) {
      state.selectedFolder = { kind: "folder", path: node.path, docCount: node.docCount, isPlaceholder: node.isPlaceholder, isPair: node.isPair, splitCount: node.splitCount };
    } else if (!pathIsPrefixOfAny(state.selectedFolder.path, state.treeFolders)) {
      state.selectedFolder = null;
    }
  }
  renderTree();
  updateSelectedFolderName();
  renderPanels();
  refreshTrashCount();
  refreshRetiredCount("tdb");
}

function pathIsPrefixOfAny(path, folders) {
  const prefix = path + "\\";
  return folders.some((f) => f.path === path || f.path.startsWith(prefix));
}

// "폴더" 헤더 클릭 → 폴더 선택을 '최상위'로. 결과 표는 필터 없이 전체를 보여주고,
// 폴더 편집 패널은 최상위 전용 모드(새 폴더 추가만)가 된다.
document.getElementById("tree-collapse-all").addEventListener("click", () => {
  state.selectedFolder = { kind: "root" };
  state.expanded.clear();
  state.page = 1;
  renderTree();
  renderPanels();
  loadDocuments();
});

// ---------------------------------------------------------------------------
// 결과 표 — TDB 조회 화면과 같은 컬럼·표시 규칙
// ---------------------------------------------------------------------------
function pathAfterCategory(doc) {
  if (!doc.source_path) return "";
  let rest = doc.source_path;
  if (doc.category && rest.startsWith(doc.category)) {
    rest = rest.slice(doc.category.length).replace(/^\\+/, "");
  }
  return rest.replaceAll("\\", " / ");
}

// searchIconSvg·previewBtnHtml·openDocPreview(이전/다음 포함)는 ui.js 공용 함수를 쓴다.

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
  // 지금 저장돼 있는 이전/다음 목록은 다른 조건의 것일 수 있으므로 무효로 두고, 이 검색조건의
  // 전체 목록이 (이미 받아둔 것이면 곧바로) 저장되게 한다 — ui.js 공용 저장소.
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
  // 여기 페이지 50건은 그게 아직 안 왔을 때만 쓰는 임시 목록이다(ui.js가 전체를 덮지 않게 막는다).
  saveDetailNavPageList(items.map((d) => d.id));

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">조건에 맞는 자료가 없습니다.</td></tr>';
    updateDocSelectAllState();
    return;
  }

  items.forEach((doc, i) => {
    const tr = document.createElement("tr");
    if (doc.is_isometric) tr.classList.add("iso-row");
    const isSelected = state.selectedDocIds.has(doc.id);
    const previewBtn = previewBtnHtml(doc.current_pdf_file_id, tdbHasOriginal(doc));
    tr.innerHTML = `
      <td class="col-no">${startNo + i}</td>
      <td><input type="checkbox" class="row-check" data-id="${doc.id}" ${isSelected ? "checked" : ""} /></td>
      <td>${previewBtn} <a href="detail.html?id=${doc.id}&from=editor">${esc(doc.display_name)}</a></td>
      <td class="muted">${esc(doc.category ?? "")}</td>
      <td class="muted path-jump" title="${esc(pathAfterCategory(doc))}">${esc(pathAfterCategory(doc))}</td>
      <td>${revLabel(doc)}</td>
      <td>${statusBadge(doc.status)}</td>
      <td>${yn(doc.has_dwg)}</td>
      <td>${yn(doc.has_xlsx)}</td>
      <td>${yn(doc.has_etc)}</td>
      <td>${yn(doc.has_pdf)}</td>
      <td class="muted tc">${(doc.updated_at ?? "").slice(0, 16).replace("T", " ")}</td>`;
    tr.querySelector(".path-jump").addEventListener("click", () => {
      if (doc.source_path) selectFolderByPath(doc.source_path);
    });
    tbody.appendChild(tr);
  });

  // 체크박스는 TDB 조회 화면과 같은 다중 선택 방식 — 여러 자료를 함께 체크해 위치 이동·
  // 교체·삭제에 한 번에 적용할 수 있다(자료명 변경만 1개 선택했을 때로 제한).
  tbody.querySelectorAll(".row-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) state.selectedDocIds.add(id);
      else state.selectedDocIds.delete(id);
      updateDocSelectAllState();
      updateTotalCountText();
      renderPanels();
      saveState();
    });
  });

  wireFullPreviewButtons(tbody, items);
  // 자료명을 눌러 여는 상세보기도 미리보기와 같이 검색조건 전체를 넘나든다(ui.js).
  wireDetailLinksFullNav(tbody, () => state.navListPromise);
  updateDocSelectAllState();
}

function updateDocSelectAllState() {
  const selectAll = document.getElementById("doc-select-all");
  if (!selectAll) return;
  const rowChecks = [...document.querySelectorAll("#doc-tbody .row-check")];
  selectAll.checked = rowChecks.length > 0 && rowChecks.every((cb) => cb.checked);
  selectAll.disabled = rowChecks.length === 0;
}

document.getElementById("doc-select-all").addEventListener("change", (e) => {
  document.querySelectorAll("#doc-tbody .row-check").forEach((cb) => {
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.id);
    if (e.target.checked) state.selectedDocIds.add(id);
    else state.selectedDocIds.delete(id);
  });
  updateTotalCountText();
  renderPanels();
  saveState();
});

// 지금 페이지에 실제로 렌더된 자료 중 선택된 것들 (다른 페이지의 선택은 id만 알고 상세 데이터가 없다)
function selectedDocsOnPage() {
  return state.lastItems.filter((d) => state.selectedDocIds.has(d.id));
}

async function loadDocuments() {
  const filters = currentFilters();
  ensureNavList(filters);
  const params = { ...filters, page: state.page, page_size: state.pageSize };
  saveState();
  const res = await fetch(`/documents?${buildQueryString(params)}`);
  const data = await res.json();
  state.total = data.total;
  state.lastItems = data.items;
  state.lastStartNo = (state.page - 1) * state.pageSize + 1;

  renderTable(state.lastItems, state.lastStartNo);
  renderStatusBar();
  renderPagination();
  renderPanels();
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
  const suffix = state.selectedDocIds.size > 0 ? ` (선택 ${state.selectedDocIds.size}건)` : "";
  document.getElementById("total-count").textContent = `전체 ${state.total}건${suffix}`;
}

// "선택 초기화" — 결과 표에서 체크해둔 자료를 한 번에 전부 푸다(다른 페이지에서
// 체크해둔 것까지). 폴더 선택·검색 조건은 건드리지 않는다 (2026-08-28 CM 요청).
function clearDocSelection() {
  state.selectedDocIds.clear();
  document.querySelectorAll("#doc-tbody .row-check").forEach((cb) => { cb.checked = false; });
  updateDocSelectAllState();
  updateTotalCountText();
  renderPanels();
  saveState();
}

function renderStatusBar() {
  updateTotalCountText();
  updateSelectedFolderName();
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

function search() {
  state.page = 1;
  loadDocuments();
}

document.getElementById("search-btn").addEventListener("click", search);
document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
["status", "holding"].forEach((id) => {
  document.getElementById(id).addEventListener("change", search);
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
document.getElementById("recursive_folder").addEventListener("change", search);
// 숨김 폴더 보기를 켜고 끄면 폴더 트리 자체가 달라지므로 트리부터 다시 받는다. 고른 폴더가
// 새 트리에 없으면(예: 체크를 끄면서 DWG 폴더가 사라지면) loadTree가 선택을 알아서 해제한다.
document.getElementById("show_hidden_folders").addEventListener("change", async () => {
  state.page = 1;
  await loadTree();
  await loadDocuments();
});
document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("q").value = "";
  document.getElementById("kind_scope").value = "FILE";
  document.getElementById("status").value = "";
  document.getElementById("holding").value = "";
  selectedIso.clear();
  renderIsoList(); renderIsoToggle();
  document.getElementById("recursive_folder").checked = false;
  document.getElementById("show_hidden_folders").checked = false;
  state.selectedFolder = null;
  state.selectedDocIds.clear();
  state.sort = "";
  state.sortDir = "asc";
  showSortedColumn("", "asc");
  renderTree(); renderPanels();
  loadTree();
  search();
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

// 자료 편집 패널 안 [미리보기] 버튼 — 위 결과표에서 고른 자료의 현재 PDF를 크게 본다(PDF가
// 없어도 눌러서 "PDF 없음"을 볼 수 있다). ui.js 공용 미리보기 팝업을 쓰므로, 결과표 페이지(50건)가
// 아니라 검색조건 전체(navListPromise) 안에서 이전/다음도 된다.
async function previewSelectedDoc() {
  if (state.selectedDocIds.size !== 1) return;
  const id = [...state.selectedDocIds][0];
  const d = state.lastItems.find((x) => x.id === id);
  if (!d) return;
  const navList = (await state.navListPromise).map(toNavPreviewItem);
  const index = navList.findIndex((it) => it.id === d.id);
  openDocPreview(navList, index === -1 ? 0 : index);
}

// ---------------------------------------------------------------------------
// 반출(CHECKED_OUT) 중 편집 차단 — 모든 편집은 반입이 완료되어야 가능
// ---------------------------------------------------------------------------
function folderHasCheckedOut(path) {
  // 폴더 안의 반출 여부는 결과 표 데이터로 완벽히 알 수 없으므로 서버에 물어 확인한다.
  // DWG·PDF 폴더는 자료 소속 폴더가 아니라 파일이 놓인 자리라 real_path로 물어야 걸린다.
  const qs = buildQueryString({
    path, recursive: true, real_path: showHiddenFolders(), status: "CHECKED_OUT", page: 1, page_size: 1,
  });
  return fetch(`/documents?${qs}`).then((r) => r.json()).then((d) => d.total > 0);
}

async function blockIfFolderCheckedOut(path) {
  if (!(await folderHasCheckedOut(path))) return false;
  await showAlert("이 폴더 안에 반출(수정용) 중인 자료가 있어 지금은 편집할 수 없습니다.\n반입이 완료된 뒤 다시 시도하세요.");
  return true;
}

async function blockIfDocCheckedOut(doc) {
  if (doc.status !== "CHECKED_OUT") return false;
  await showAlert("이 자료는 현재 반출(수정용) 중이라 편집할 수 없습니다.\n반입이 완료된 뒤 다시 시도하세요.");
  return true;
}

// ---------------------------------------------------------------------------
// 폴더명·자료명 확인 카드 + 편집 패널
// ---------------------------------------------------------------------------
function renderFolderInfoCard() {
  const el = document.getElementById("folder-info-card");
  const s = state.selectedFolder;
  if (!s) {
    el.innerHTML = `<span class="info-card-label">폴더명</span><span class="info-card-empty">왼쪽에서 폴더를 선택하면 표시됩니다</span>`;
    return;
  }
  if (s.kind === "root") {
    el.innerHTML = `<span class="info-card-label">폴더명</span><span class="info-card-value"><span class="tree-icon">📁</span><b>최상위</b></span>`;
    return;
  }
  // 숨김 폴더 보기를 켜면 트리 숫자가 자료 수가 아니라 파일 수라, 여기 문구도 맞춰 바꾼다
  // (안 그러면 "전체 2건"이라고 써놓고 표에는 자료 1건만 나와 어긋나 보인다).
  const countLabel = showHiddenFolders() ? `파일 ${s.docCount}개` : `전체 ${s.docCount}건`;
  const pairTag = s.isPair ? `<span class="info-card-meta">평소 트리에 안 보이는 폴더</span>` : "";
  el.innerHTML = `
    <span class="info-card-label">폴더명</span>
    <span class="info-card-value"><span class="tree-icon">📁</span><b>${esc(folderDisplayName(s.path))}</b></span>
    <span class="info-card-count">${countLabel}</span>${pairTag}`;
}

function renderDocInfoCard() {
  const el = document.getElementById("doc-info-card");
  const n = state.selectedDocIds.size;
  if (n === 0) {
    el.innerHTML = `<span class="info-card-label">자료명</span><span class="info-card-empty">아래 결과 표에서 자료를 체크하면 표시됩니다</span>`;
    return;
  }
  // 체크해둔 자료를 한 번에 푸는 버튼. 글자 높이에 맞춰둔 크기라 카드 높이는 그대로다.
  const clearBtn = `<button type="button" class="clear-selection-btn" data-clear-selection title="체크해둔 자료를 모두 해제합니다">선택 초기화</button>`;
  if (n === 1) {
    const id = [...state.selectedDocIds][0];
    const d = state.lastItems.find((x) => x.id === id);
    if (d) {
      const previewBtn = `<button type="button" class="preview-icon-btn${d.current_pdf_file_id ? "" : " is-empty"}" data-preview-selected title="${d.current_pdf_file_id ? "미리보기" : "PDF 없음"}">${searchIconSvg}</button>`;
      el.innerHTML = `
        <span class="info-card-label">자료명</span>
        <span class="info-card-value">${previewBtn}<b>${esc(d.display_name)}</b>${clearBtn}</span>
        <span class="info-card-meta">현재 Rev ${revLabel(d)}</span>
        <span class="info-card-meta">상태 ${statusBadge(d.status)}</span>
        <span class="info-card-meta">원본 ${d.has_dwg ? "보유" : "미보유"} / 사본(PDF) ${d.has_pdf ? "보유" : "미보유"}</span>`;
      return;
    }
  }
  el.innerHTML = `<span class="info-card-label">자료명</span><span class="info-card-value"><b>선택 ${n}건</b>${clearBtn}</span>`;
}

// 폴더 편집·자료 편집 패널은 선택 여부와 무관하게 항상 버튼 전체를 펼쳐 보여주고, 지금
// 고른 것에 적용할 수 없는 버튼만 흐리게(disabled) 처리한다 — 패널 자체가 접혔다 펴졌다
// 하지 않는다.
function renderPanels() {
  renderFolderInfoCard();
  renderDocInfoCard();

  const fp = document.getElementById("folder-panel");
  const dp = document.getElementById("doc-panel");
  const s = state.selectedFolder;
  const isFolder = !!(s && s.kind === "folder");
  const canModifyFolder = isFolder; // 이름 변경·위치 이동·삭제는 실제 폴더를 골랐을 때만 의미가 있다(최상위 자체는 대상 아님)

  // renderPanels()는 선택이 바뀔 때마다 innerHTML을 통째로 새로 그리므로, auth-guard.js가
  // 페이지 로드 시 한 번만 적용하는 [data-perm] 처리가 유지되지 않는다 — 여기서 직접
  // window.__tdmsPerms를 본다. 권한이 없어도 버튼 자체는 계속 보여주고 흐리게(disabled)만
  // 처리한다(2026-08-13 CM 확정 — 자기한테 없는 기능을 알아야 권한을 요청할 수 있다).
  const perms = window.__tdmsPerms || new Set();
  const canFolder = perms.has("screen.tdb_editor.folder");
  const canDoc = perms.has("screen.tdb_editor.document");

  // Zip 폴더 업로드 블록과 같은 방식으로, 권한이 없으면 제목까지 포함해 블록 전체를
  // 흐리게 표시한다(2026-08-13 CM 확정).
  document.getElementById("folder-edit-block").classList.toggle("perm-disabled", !canFolder);
  document.getElementById("doc-edit-block").classList.toggle("perm-disabled", !canDoc);

  fp.innerHTML = `
    <div class="edit-actions">
      <button type="button" id="folder-rename-btn" ${canFolder && canModifyFolder ? "" : "disabled"}>폴더명 변경</button>
      <button type="button" id="folder-move-btn" ${canFolder && canModifyFolder ? "" : "disabled"}>폴더 위치 이동</button>
      <div class="edit-actions-row">
        <button type="button" id="folder-add-btn" ${canFolder && isFolder ? "" : "disabled"}>폴더 추가</button>
        <button type="button" id="pair-merge-btn" ${canFolder ? "" : "disabled"}>DWG·PDF 폴더 병합</button>
      </div>
      <button type="button" id="folder-delete-btn" ${canFolder && canModifyFolder ? "" : "disabled"}>폴더 삭제</button>
    </div>`;
  if (canFolder) {
    document.getElementById("folder-rename-btn").addEventListener("click", renameFolder);
    document.getElementById("folder-move-btn").addEventListener("click", () => openMoveModal(true));
    document.getElementById("folder-add-btn").addEventListener("click", openAddFolderModal);
    document.getElementById("pair-merge-btn").addEventListener("click", openPairFolderMergeModal);
    document.getElementById("folder-delete-btn").addEventListener("click", deleteFolder);
  }

  // 자료 교체는 지금 고른 자료가 있어야만 되고, 신규 추가는 왼쪽 트리에서 폴더를 골라야만
  // 된다(그 폴더가 등록 위치가 되므로) — 원래 "자료 편집" 제목 줄에 있던 [＋ 신규추가]를
  // 이 자리(자료 교체 옆 반 칸)로 옮겼다. 자료명 변경만 1개를 선택했을 때로 제한되고,
  // 나머지(위치 이동·교체·삭제)는 여러 건을 함께 선택해도 된다 — 버튼은 그대로 켜두고
  // renameDoc() 안에서 2개 이상이면 알림으로 안내한다.
  const hasDoc = state.selectedDocIds.size > 0;
  dp.innerHTML = `
    <div class="edit-actions">
      <button type="button" id="doc-rename-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료명 변경</button>
      <button type="button" id="doc-move-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료 위치 이동</button>
      <div class="edit-actions-row">
        <button type="button" id="doc-replace-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료 교체</button>
        <button type="button" id="doc-register-btn" ${canDoc && isFolder ? "" : "disabled"}>신규 추가</button>
      </div>
      <button type="button" id="doc-delete-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료 삭제</button>
    </div>`;
  if (canDoc) {
    document.getElementById("doc-rename-btn").addEventListener("click", renameDoc);
    document.getElementById("doc-move-btn").addEventListener("click", () => openMoveModal(false));
    document.getElementById("doc-replace-btn").addEventListener("click", replaceDoc);
    document.getElementById("doc-register-btn").addEventListener("click", openRegisterModal);
    document.getElementById("doc-delete-btn").addEventListener("click", deleteDoc);
  }
}

// ---------------------------------------------------------------------------
// 폴더 편집 동작
// ---------------------------------------------------------------------------
// DWG·PDF 폴더를 고치기 전에 뜨는 경고 — 승인해야 편집 화면이 열린다 (2026-08-17 CM 확정).
// 이 폴더는 원본과 사본을 한 자료로 묶어주는 자리라, 한쪽만 이름이 바뀌거나 다른 데로 가면
// 묶음이 성립하지 않는다. 그래서 고치는 순간 병합이 풀리고 자료가 두 건으로 나뉜다.
async function confirmPairFolderEdit(s, actionPhrase) {
  if (!s || !s.isPair) return true;
  const n = s.splitCount || 0;
  const lines = [
    `"${folderDisplayName(s.path)}" 폴더는 원본과 사본을 한 자료로 묶어주는 자리입니다.`,
    "",
    `${actionPhrase} 이 묶음이 풀립니다.`,
    n > 0
      ? `· 합쳐져 있던 자료 ${n}건이 다시 두 건으로 나뉩니다 (원본 따로, 사본 따로).`
      : "· 이 폴더는 보통 폴더가 됩니다.",
    "· 리비전 이력과 반출 이력은 원래 자료에 그대로 남습니다.",
    "· 이 폴더는 숨김이 풀려 평소에도 트리에 보이게 됩니다.",
    "",
    "계속하시겠습니까?",
  ];
  return showConfirm(lines.join("\n"));
}

async function renameFolder() {
  const s = state.selectedFolder;
  if (!s || s.kind !== "folder") return;
  if (await blockIfFolderCheckedOut(s.path)) return;
  if (!(await confirmPairFolderEdit(s, "폴더 이름을 바꾸면"))) return;

  const oldName = folderDisplayName(s.path);
  const oldNum = firstNum(oldName);
  const hasSubfolders = state.treeFolders.some((f) => f.path.startsWith(s.path + "\\"));

  openModal(`
    <p class="modal-title">폴더명 변경</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">변경 대상</span><b>${esc(oldName)}</b></div>
    </div>
    <input type="text" id="rf-input" placeholder="변경 이름" />
    <div id="rf-cascade" class="hidden" style="margin-top:12px;">
      <label class="checkbox-line" style="display:flex; gap:7px; align-items:flex-start; font-size:12.5px; color:var(--text);">
        <input type="checkbox" id="rf-cascade-cb" checked style="margin-top:2px;" />
        <span>하위 폴더 번호도 함께 바꾸기
          <span class="tree-count">(예: 5 → 7 이면 5.1 → 7.1, 5.1.1 → 7.1.1)</span></span>
      </label>
    </div>
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="rf-confirm">확인</button>
    </div>`);

  const inp = document.getElementById("rf-input");
  const cascadeRow = document.getElementById("rf-cascade");
  function update() {
    const nn = firstNum(inp.value);
    const show = hasSubfolders && oldNum && nn && nn !== oldNum;
    cascadeRow.classList.toggle("hidden", !show);
  }
  inp.addEventListener("input", update);
  setTimeout(() => inp.focus(), 30);

  document.getElementById("rf-confirm").addEventListener("click", async () => {
    const newName = inp.value.trim();
    if (!newName) return;
    const cascadeShown = !cascadeRow.classList.contains("hidden");
    const cascade = cascadeShown && document.getElementById("rf-cascade-cb").checked;
    const parentParts = s.path.split("\\"); parentParts.pop();
    const newPath = parentParts.length ? parentParts.join("\\") + "\\" + newName : newName;
    closeModal();
    await callReparent(s.path, newPath, cascade, "폴더명을 변경하였습니다.");
  });
}

async function callReparent(oldPath, newPath, cascade, message) {
  const res = await fetch("/editor/folders/reparent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath, cascade_numbering: cascade }),
  });
  if (!res.ok) {
    await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
    return;
  }
  const data = await res.json();
  state.selectedFolder = { kind: "folder", path: data.new_path, docCount: 0, isPlaceholder: false };
  await loadTree();
  await loadDocuments();
  await showAlert(message);
}

// 새 폴더 추가는 버튼 하나뿐이고, 어디에 추가할지는 모달 안 라디오("최상위에 추가" /
// "선택 폴더 하위에 추가")로 고른다. 왼쪽 트리에서 폴더를 골라둔 상태면 "선택 폴더 하위에
// 추가"가 기본 선택, 아무것도 안 골랐으면 그 옵션 자체가 비활성화되고 "최상위에 추가"만 된다.
function openAddFolderModal() {
  const s = state.selectedFolder;
  const hasSelected = !!(s && s.kind === "folder");
  const selectedPath = hasSelected ? s.path : "";
  const selectedLabel = hasSelected ? selectedPath.replaceAll("\\", " / ") : "";

  openModal(`
    <p class="modal-title">폴더 추가</p>
    <div class="tp-modes">
      <label><input type="radio" name="af-scope" value="root" ${hasSelected ? "" : "checked"} /> 최상위에 추가</label>
      <label><input type="radio" name="af-scope" value="child" ${hasSelected ? "checked" : "disabled"} /> 선택 폴더 하위에 추가</label>
    </div>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">추가 위치</span><b id="af-target-label">${hasSelected ? esc(selectedLabel) : "최상위"}</b></div>
    </div>
    <input type="text" id="af-input" placeholder="새 폴더명" />
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="af-confirm">추가</button>
    </div>`);

  function currentParentPath() {
    const scope = document.querySelector('input[name="af-scope"]:checked').value;
    return scope === "child" ? selectedPath : "";
  }
  function updateTargetLabel() {
    const parentPath = currentParentPath();
    document.getElementById("af-target-label").textContent = parentPath ? parentPath.replaceAll("\\", " / ") : "최상위";
  }
  document.querySelectorAll('input[name="af-scope"]').forEach((r) => r.addEventListener("change", updateTargetLabel));

  const inp = document.getElementById("af-input");
  setTimeout(() => inp.focus(), 30);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("af-confirm").click(); });

  document.getElementById("af-confirm").addEventListener("click", async () => {
    const name = inp.value.trim();
    if (!name) return;
    const parentPath = currentParentPath();
    if (parentPath) {
      if (await blockIfFolderCheckedOut(parentPath)) return;
    }
    const path = parentPath ? parentPath + "\\" + name : name;
    const res = await fetch("/editor/folders/placeholder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
      return;
    }
    closeModal();
    if (parentPath) state.expanded.add(parentPath);
    await loadTree();
  });
}

async function deleteFolder() {
  const s = state.selectedFolder;
  if (!s || s.kind !== "folder") return;
  if (await blockIfFolderCheckedOut(s.path)) return;
  if (!(await confirmPairFolderEdit(s, "폴더를 삭제하면"))) return;
  const pairWarn = s.isPair
    ? `<p class="warn-text" style="margin-top:10px;">병합이 풀린 뒤, <b>이 폴더 안 파일만</b> 삭제 보관함으로 갑니다.
         반대쪽 폴더의 파일과 리비전·반출 이력은 원래 자료에 그대로 남습니다.</p>`
    : "";
  openModal(`
    <p class="modal-title">폴더 삭제</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">삭제 대상</span><b>${esc(folderDisplayName(s.path))}</b></div>
    </div>
    ${pairWarn}
    <input type="text" id="df-reason" placeholder="사유 (선택 입력)" />
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="df-confirm">삭제 보관함으로 이동</button>
    </div>`);
  document.getElementById("df-confirm").addEventListener("click", async () => {
    const reason = document.getElementById("df-reason").value.trim();
    const res = await fetch("/editor/folders/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: s.path, reason: reason || null }),
    });
    if (!res.ok) {
      await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
      return;
    }
    closeModal();
    state.selectedFolder = null;
    await loadTree();
    await loadDocuments();
    await showAlert("폴더를 삭제하였습니다.");
  });
}

// ---------------------------------------------------------------------------
// 자료 편집 동작
// ---------------------------------------------------------------------------
async function renameDoc() {
  if (state.selectedDocIds.size > 1) {
    await showAlert("자료명 변경은 자료를 1개만 선택했을 때 할 수 있습니다.");
    return;
  }
  const id = [...state.selectedDocIds][0];
  const d = state.lastItems.find((x) => x.id === id);
  if (!d) return;
  if (await blockIfDocCheckedOut(d)) return;
  openModal(`
    <p class="modal-title">자료명 변경</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">변경 대상</span><b>${esc(d.display_name)}</b></div>
    </div>
    <input type="text" id="rn-input" placeholder="변경 이름" />
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="rn-confirm">확인</button>
    </div>`);
  const inp = document.getElementById("rn-input");
  setTimeout(() => inp.focus(), 30);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("rn-confirm").click(); });

  document.getElementById("rn-confirm").addEventListener("click", async () => {
    const name = inp.value.trim();
    if (!name) return;
    const res = await fetch(`/editor/documents/${d.id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    if (!res.ok) {
      await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
      return;
    }
    closeModal();
    await loadDocuments();
    await showAlert("자료명을 변경하였습니다.");
  });
}

async function deleteDoc() {
  const ids = [...state.selectedDocIds];
  if (ids.length === 0) return;
  const docsOnPage = selectedDocsOnPage();
  for (const d of docsOnPage) {
    if (await blockIfDocCheckedOut(d)) return;
  }
  const label = ids.length === 1
    ? esc(docsOnPage.find((d) => d.id === ids[0])?.display_name ?? "선택 자료 1건")
    : `선택 자료 ${ids.length}건`;
  // 보내는 곳이 둘이다 — 삭제(오류라 없어야 할 자료)와 폐기(그때는 맞았지만 최신본에서
  // 빠진 자료). 폐기한 자료는 트리에서만 사라지고 폐기 보관함에 이력으로 남는다.
  openModal(`
    <p class="modal-title">자료 삭제</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">삭제 대상</span><b>${label}</b></div>
    </div>
    <input type="text" id="dd-reason" placeholder="사유 (선택 입력)" />
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="archive-choice-btn" id="dd-retire">폐기 보관함으로 이동</button>
      <button type="button" class="primary archive-choice-btn" id="dd-confirm">삭제 보관함으로 이동</button>
    </div>`, "wide");

  async function send(url, doneMessage) {
    const reason = document.getElementById("dd-reason").value.trim();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: ids, reason: reason || null }),
    });
    if (!res.ok) {
      await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
      return;
    }
    closeModal();
    state.selectedDocIds.clear();
    await loadTree();
    await loadDocuments();
    await showAlert(doneMessage);
  }

  document.getElementById("dd-confirm").addEventListener("click", () => send(
    "/editor/documents/archive-bulk",
    ids.length > 1 ? `자료 ${ids.length}건을 삭제하였습니다.` : "자료를 삭제하였습니다.",
  ));
  document.getElementById("dd-retire").addEventListener("click", () => send(
    "/editor/documents/retire-bulk",
    ids.length > 1
      ? `자료 ${ids.length}건을 폐기 보관함으로 옮겼습니다.`
      : "자료를 폐기 보관함으로 옮겼습니다.",
  ));
}

// 자료 교체 팝업 — Rev 유지(기본)/Rev 변경을 고를 수 있다. 자료를 여러 건 선택했으면
// 첨부한 파일을 파일명(확장자 제외)으로 묶어 같은 이름의 선택 자료에 각각 매칭한다.
async function replaceDoc() {
  const ids = [...state.selectedDocIds];
  if (ids.length === 0) return;
  const docsOnPage = selectedDocsOnPage();
  for (const d of docsOnPage) {
    if (await blockIfDocCheckedOut(d)) return;
  }
  const single = ids.length === 1 ? docsOnPage.find((d) => d.id === ids[0]) : null;

  const targetLine = single
    ? `<div class="kv-line"><span class="kv-label">교체 대상</span><b>${esc(single.display_name)}</b></div>`
    : `<div class="kv-line"><span class="kv-label">교체 대상</span><b>${ids.length}건 선택됨</b></div>`;

  openModal(`
    <p class="modal-title">자료 교체</p>
    <div class="edit-target">
      ${targetLine}
    </div>
    <div class="tp-modes" style="margin-bottom:10px;">
      <label><input type="radio" name="rep-rev-mode" value="keep" checked /> Rev 유지</label>
      <label><input type="radio" name="rep-rev-mode" value="bump" /> Rev 변경</label>
    </div>
    <input type="file" id="rep-files" multiple />
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="rep-confirm">교체</button>
    </div>`);
  attachDropZone("rep-files");

  document.getElementById("rep-confirm").addEventListener("click", async () => {
    const input = document.getElementById("rep-files");
    const files = [...input.files];
    if (!files.length) { await showAlert("파일을 선택하세요."); return; }
    const keepRev = document.querySelector('input[name="rep-rev-mode"]:checked').value === "keep";

    if (single) {
      await replaceSingleDoc(single, files, keepRev);
    } else {
      await replaceMultipleDocs(ids, files, keepRev);
    }
  });
}

async function replaceSingleDoc(d, files, keepRev) {
  const stems = new Set(files.map((f) => fileStem(f.name)));
  if (stems.size > 1) {
    await showAlert(`첨부한 파일들의 이름이 서로 다릅니다 (${[...stems].join(", ")}).\n원본과 PDF는 이름이 같아야 교체할 수 있습니다.`);
    return;
  }
  const hasPdf = files.some((f) => /\.pdf$/i.test(f.name));
  const hasOriginal = files.some((f) => !/\.pdf$/i.test(f.name));
  if (!(hasPdf && hasOriginal)) {
    const missing = hasPdf ? "원본" : "PDF";
    const ok = await showConfirm(`${missing}이(가) 빠진 채 ${hasPdf ? "PDF" : "원본"}만으로 교체하게 됩니다.\n교체 후 이 자료의 현재 리비전에는 ${missing}이(가) 없는 상태가 됩니다. 계속하시겠습니까?`);
    if (!ok) return;
  }
  let confirmDuplicates = false;
  while (true) {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("keep_rev", keepRev ? "true" : "false");
    fd.append("confirm_duplicates", confirmDuplicates ? "true" : "false");
    const res = await fetch(`/editor/documents/${d.id}/replace`, { method: "POST", body: fd });
    if (!res.ok) { await showAlert("교체할 수 없습니다: " + (await safeErrText(res))); return; }
    const data = await res.json();
    if (data.needs_confirmation) {
      const ok = await showConfirm(`같은 형식(${data.duplicate_exts.join(", ")})의 파일이 2개 이상 첨부되었습니다.\n정상은 이름당 원본 1개+PDF 1개뿐입니다. 첨부한 파일을 다시 확인해주세요.\n\n그래도 이대로 계속 교체하시겠습니까?`);
      if (!ok) return;
      confirmDuplicates = true;
      continue;
    }
    closeModal();
    await loadDocuments();
    await loadTree();
    await showAlert(data.message);
    return;
  }
}

async function replaceMultipleDocs(ids, files, keepRev) {
  let confirmDuplicates = false;
  let confirmMismatch = false;
  let confirmPartial = false;
  while (true) {
    const fd = new FormData();
    ids.forEach((id) => fd.append("document_ids", id));
    fd.append("keep_rev", keepRev ? "true" : "false");
    fd.append("confirm_duplicates", confirmDuplicates ? "true" : "false");
    fd.append("confirm_mismatch", confirmMismatch ? "true" : "false");
    fd.append("confirm_partial", confirmPartial ? "true" : "false");
    files.forEach((f) => fd.append("files", f));
    const res = await fetch(`/editor/documents/replace-bulk`, { method: "POST", body: fd });
    if (!res.ok) { await showAlert("교체할 수 없습니다: " + (await safeErrText(res))); return; }
    const data = await res.json();
    if (data.needs_confirmation) {
      if (data.duplicate_exts && data.duplicate_exts.length) {
        const ok = await showConfirm(`같은 형식(${data.duplicate_exts.join(", ")})의 파일이 2개 이상 첨부된 자료가 있습니다.\n정상은 이름당 원본 1개+PDF 1개뿐입니다. 첨부한 파일을 다시 확인해주세요.\n\n그래도 이대로 계속 교체하시겠습니까?`);
        if (!ok) return;
        confirmDuplicates = true;
        continue;
      }
      if (data.mismatch && (data.mismatch.unmatched_docs.length || data.mismatch.unmatched_files.length)) {
        const lines = [];
        if (data.mismatch.unmatched_docs.length) {
          lines.push(`- 선택했지만 첨부 파일 중 이름이 같은 것이 없는 자료: ${data.mismatch.unmatched_docs.join(", ")}`);
        }
        if (data.mismatch.unmatched_files.length) {
          lines.push(`- 첨부했지만 선택한 자료 중 이름이 같은 것이 없는 파일: ${data.mismatch.unmatched_files.join(", ")}`);
        }
        const ok = await showConfirm(`자료명과 첨부한 파일 이름이 서로 맞지 않는 항목이 있습니다.\n${lines.join("\n")}\n\n이름이 일치하는 자료만 교체하고 나머지는 건너뛰시겠습니까?`);
        if (!ok) return;
        confirmMismatch = true;
        continue;
      }
      if (data.partial && data.partial.length) {
        const ok = await showPartialFilesConfirm("다음 자료는 원본과 사본(PDF) 중 한쪽만 첨부되었습니다.", data.partial);
        if (!ok) return;
        confirmPartial = true;
        continue;
      }
    }
    closeModal();
    state.selectedDocIds.clear();
    await loadDocuments();
    await loadTree();
    await showAlert(data.message);
    return;
  }
}

// ---------------------------------------------------------------------------
// 위치 이동 — 폴더/자료 공용 폴더 선택 팝업
// ---------------------------------------------------------------------------
// 이동할 위치로 고를 수 있는 폴더 목록. DWG·PDF 폴더(와 그 안)는 뺀다 — 그 자리는 이미
// 어떤 자료의 원본·사본이 놓인 칸이라, 다른 폴더나 자료를 거기로 밀어 넣으면 겹친다.
function allFolderPaths() {
  const pairPaths = state.treeFolders.filter((f) => f.is_pair).map((f) => f.path);
  const insidePair = (p) => pairPaths.some((pp) => p === pp || p.startsWith(pp + "\\"));
  return state.treeFolders.map((f) => f.path).filter((p) => !insidePair(p)).sort(naturalCompare);
}

const tpValues = {};

// 이동할 위치는 기존 폴더 트리에서 고르는 것 하나뿐이다("새 폴더로" 옵션은 없다 — 새 폴더가
// 필요하면 폴더 추가 기능을 먼저 쓴다).
function folderPickerHTML(prefix, excludePath) {
  tpValues[`${prefix}-sel`] = "";
  const excludeAttr = excludePath ? ` data-tp-exclude="${esc(excludePath)}"` : "";
  return `
    <div class="tp-picked" id="${prefix}-picked">
      <span class="tp-picked-label">선택 위치</span>
      <span id="${prefix}-sel-label" class="tp-picked-value is-empty">(폴더를 선택하세요)</span>
      <button type="button" class="small" id="${prefix}-pick-btn" data-tp-pick="${prefix}"${excludeAttr}>폴더 선택</button>
    </div>`;
}

// ownNameToAppend: 폴더 이동일 때만 넘긴다 — 고른 위치는 "그 폴더의 새 상위 폴더"이므로
// 고른 경로 뒤에 자기 이름을 붙여야 "그 안으로 들어가는" 경로가 된다(자료는 이름이 없으니 그대로 씀).
function resolveMoveTarget(prefix, ownNameToAppend) {
  const parent = tpValues[`${prefix}-sel`] || "";
  return ownNameToAppend ? (parent ? parent + "\\" + ownNameToAppend : ownNameToAppend) : parent;
}

const tpPickerState = { root: null, expanded: new Set(), selectedPath: "", target: null };

function buildFolderOnlyTree(excludePath) {
  const root = { path: "", name: "", children: new Map() };
  const paths = allFolderPaths().filter((p) => !excludePath || (p !== excludePath && !p.startsWith(excludePath + "\\")));
  for (const path of paths) {
    const parts = path.split("\\").filter(Boolean);
    let node = root; const acc = [];
    for (const part of parts) {
      acc.push(part);
      const full = acc.join("\\");
      if (!node.children.has(full)) node.children.set(full, { path: full, name: part, children: new Map() });
      node = node.children.get(full);
    }
  }
  return root;
}

function tpSortedChildren(node) {
  return [...node.children.values()].sort((a, b) => naturalCompare(a.name, b.name));
}

function folderDocCount(path) {
  const prefix = path + "\\";
  let sum = 0;
  for (const f of state.treeFolders) if (f.path === path || f.path.startsWith(prefix)) sum += f.doc_count;
  return sum;
}

function openTpPicker(prefix, kind, excludePath) {
  tpPickerState.root = buildFolderOnlyTree(excludePath);
  tpPickerState.selectedPath = tpValues[`${prefix}-${kind}`] || "";
  tpPickerState.target = { prefix, kind };
  tpPickerState.expanded = new Set();
  (function expandAncestors(path) {
    if (!path) return;
    const parts = path.split("\\").filter(Boolean); const acc = [];
    for (const part of parts.slice(0, -1)) { acc.push(part); tpPickerState.expanded.add(acc.join("\\")); }
  })(tpPickerState.selectedPath);

  const root = document.getElementById("picker-modal-root");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box folder-picker-box">
        <p class="modal-title">폴더 선택</p>
        <div class="folder-picker-current">선택됨: <b id="tpp-current">${esc(tpPickerState.selectedPath || "(최상위)")}</b></div>
        <div class="folder-picker-scroll" id="tpp-tree"></div>
        <div class="modal-actions">
          <button type="button" id="tpp-cancel">취소</button>
          <button type="button" class="primary" id="tpp-confirm">이 위치로 선택</button>
        </div>
      </div>
    </div>`;
  renderTpPickerTree();
  document.getElementById("tpp-cancel").addEventListener("click", closeTpPicker);
  document.getElementById("tpp-confirm").addEventListener("click", () => {
    tpValues[`${prefix}-${kind}`] = tpPickerState.selectedPath;
    const label = document.getElementById(`${prefix}-${kind}-label`);
    label.textContent = tpPickerState.selectedPath || "(최상위)";
    label.classList.remove("is-empty");
    closeTpPicker();
  });
}

function closeTpPicker() { document.getElementById("picker-modal-root").innerHTML = ""; }

function renderTpNode(node, container, depth) {
  const hasKids = node.children.size > 0;
  const isOpen = tpPickerState.expanded.has(node.path);
  const row = document.createElement("div");
  row.className = "tp-tree-row" + (tpPickerState.selectedPath === node.path ? " selected" : "");
  row.dataset.depth = Math.min(depth, 3);
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.innerHTML = `
    <span class="tp-tree-caret${hasKids ? (isOpen ? " open" : "") : " leaf"}">▸</span>
    <span class="tp-tree-icon">📁</span>
    <span class="tp-tree-label">${esc(node.name)}</span>
    <span class="tree-count">(${folderDocCount(node.path)})</span>`;
  row.querySelector(".tp-tree-caret").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!hasKids) return;
    if (isOpen) tpPickerState.expanded.delete(node.path);
    else tpPickerState.expanded.add(node.path);
    renderTpPickerTree();
  });
  row.addEventListener("click", () => {
    tpPickerState.selectedPath = node.path;
    document.getElementById("tpp-current").textContent = node.path;
    renderTpPickerTree();
  });
  // 폴더명을 더블클릭하면 TDB 조회·TDB 관리 트리와 같은 방식으로 접기/펼치기만 토글(선택은 그대로 유지)
  row.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (!hasKids) return;
    if (isOpen) tpPickerState.expanded.delete(node.path);
    else tpPickerState.expanded.add(node.path);
    renderTpPickerTree();
  });
  container.appendChild(row);
  if (hasKids && isOpen) for (const child of tpSortedChildren(node)) renderTpNode(child, container, depth + 1);
}

function renderTpPickerTree() {
  const container = document.getElementById("tpp-tree");
  container.innerHTML = "";
  const rootRow = document.createElement("div");
  rootRow.className = "tp-tree-row" + (tpPickerState.selectedPath === "" ? " selected" : "");
  rootRow.innerHTML = `<span class="tp-tree-caret leaf"></span><span class="tp-tree-icon">📁</span><span class="tp-tree-label">(최상위)</span>`;
  rootRow.addEventListener("click", () => {
    tpPickerState.selectedPath = "";
    document.getElementById("tpp-current").textContent = "(최상위)";
    renderTpPickerTree();
  });
  container.appendChild(rootRow);
  for (const child of tpSortedChildren(tpPickerState.root)) renderTpNode(child, container, 0);
}

async function openMoveModal(isFolder) {
  const docIds = isFolder ? [] : [...state.selectedDocIds];
  if (isFolder) {
    if (await blockIfFolderCheckedOut(state.selectedFolder.path)) return;
  } else {
    if (docIds.length === 0) return;
    for (const d of selectedDocsOnPage()) {
      if (await blockIfDocCheckedOut(d)) return;
    }
  }
  if (isFolder && !(await confirmPairFolderEdit(state.selectedFolder, "폴더를 옮기면"))) return;
  const title = isFolder ? "폴더 위치 이동" : "자료 위치 이동";
  const path = isFolder ? state.selectedFolder.path : null;
  const singleDocName = docIds.length === 1 ? selectedDocsOnPage().find((d) => d.id === docIds[0])?.display_name : null;
  const displayName = isFolder ? folderDisplayName(path) : (singleDocName ?? `자료 ${docIds.length}건`);
  const docCount = isFolder ? state.selectedFolder.docCount : null;
  const isPair = isFolder && state.selectedFolder.isPair;
  // DWG·PDF 폴더를 옮기면 병합이 풀려 그 안 파일만 새 위치로 따라간다(반대쪽은 제자리).
  // 자세한 경고는 이 화면이 열리기 전에 confirmPairFolderEdit가 이미 보여주고 승인받았다.
  const warn = isFolder
    ? (isPair
        ? `<p class="warn-text" style="margin-top:10px;">병합이 풀린 뒤, <b>이 폴더 안 파일만</b> 새 위치로 옮겨집니다.
             반대쪽 폴더의 파일은 지금 자리에 그대로 남습니다.</p>`
        : `<p class="warn-text" style="margin-top:10px;">이 폴더의 하위 자료 ${docCount}건이 모두 함께 이동합니다.</p>`)
    : (docIds.length > 1
        ? `<p class="warn-text" style="margin-top:10px;">선택한 자료 ${docIds.length}건이 모두 이 위치로 이동합니다.</p>`
        : "");
  const excludePath = isFolder ? path : null;

  openModal(`
    <p class="modal-title">${title}</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">이동 대상</span><b>${esc(displayName)}</b></div>
    </div>
    <div class="tp-modes">
      <label><input type="radio" name="mv-scope" value="root" checked /> 최상위로 이동</label>
      <label><input type="radio" name="mv-scope" value="pick" /> 위치 선택</label>
    </div>
    ${folderPickerHTML("mv", excludePath)}
    ${warn}
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="mv-confirm">여기로 이동</button>
    </div>`);

  // "최상위로 이동"을 고르면 아래 폴더 선택 칸은 흐리게 비활성화된다(고를 필요가 없으므로).
  const pickedBox = document.getElementById("mv-picked");
  const pickBtn = document.getElementById("mv-pick-btn");
  function updateScope() {
    const scope = document.querySelector('input[name="mv-scope"]:checked').value;
    const isPick = scope === "pick";
    pickedBox.classList.toggle("is-disabled", !isPick);
    pickBtn.disabled = !isPick;
  }
  document.querySelectorAll('input[name="mv-scope"]').forEach((r) => r.addEventListener("change", updateScope));
  updateScope();

  document.getElementById("mv-confirm").addEventListener("click", async () => {
    const scope = document.querySelector('input[name="mv-scope"]:checked').value;
    const ownName = isFolder ? folderDisplayName(path) : null;
    const newPath = scope === "root" ? (ownName || "") : resolveMoveTarget("mv", ownName);
    if (isFolder && newPath === path) { closeModal(); return; }
    closeModal();
    if (isFolder) await callReparent(path, newPath, false, "폴더 위치를 이동하였습니다.");
    else await callMoveDocuments(docIds, newPath);
  });
}

async function callMoveDocuments(docIds, newPath) {
  const res = await fetch(`/editor/documents/move-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: docIds, new_path: newPath || "" }),
  });
  if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
  state.selectedDocIds.clear();
  await loadTree();
  await loadDocuments();
  await showAlert(docIds.length > 1 ? `자료 ${docIds.length}건의 위치를 이동하였습니다.` : "자료 위치를 이동하였습니다.");
}

// ---------------------------------------------------------------------------
// 신규 자료 등록 (자료 편집 섹션의 [+ 신규추가])
// 등록 위치는 팝업 안에서 고르지 않고, 왼쪽 폴더 트리에서 지금 선택한 폴더(Zip 폴더
// 업로드와 같은 규칙 — currentZipTargetPath())를 그대로 쓴다. 아무것도 안 골랐거나
// "폴더" 헤더(최상위)를 골랐으면 최상위로 들어간다. 팝업은 자료교체 팝업처럼 파일
// 업로드만 한다.
// ---------------------------------------------------------------------------
function openRegisterModal() {
  const targetPath = currentZipTargetPath();
  const targetLabel = targetPath ? targetPath.replaceAll("\\", " / ") : "최상위";
  openModal(`
    <p class="modal-title">신규추가</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">추가 위치</span><b>${esc(targetLabel)}</b></div>
    </div>
    <input type="file" id="reg-files" multiple />
    <div class="modal-field-row">
      <label for="reg-rev">Rev 번호</label>
      <input type="number" id="reg-rev" min="0" step="1" placeholder="미입력시 Rev 0" />
    </div>
    <p class="modal-hint-text" id="reg-rev-note" style="display:none"></p>
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="reg-confirm">등록</button>
    </div>`);
  attachDropZone("reg-files");

  const revInput = document.getElementById("reg-rev");
  const revNote = document.getElementById("reg-rev-note");
  // Rev 매칭: 파일을 딱 1개 골랐을 때만, 이 폴더에 같은 이름(다른 형식)의 자료가 이미
  // 있는지 확인해서 있으면 그 Rev로 자동 등록됨을 미리 보여주고 직접 입력을 막는다
  // (2026-08-18 CM 확정 — 원본·사본이 서로 다른 Rev를 가리키면 안 되므로 무조건 기존
  // Rev를 따른다. 파일이 여러 개면 여러 자료가 한꺼번에 섞여 있을 수 있어 이 미리보기는
  // 하지 않고, Rev 번호 입력만으로 새로 만드는 자료들에 일괄 적용한다).
  let revMatch = null; // { current_rev, exts } — 활성화된 경우만 채워짐
  async function refreshRevMatch() {
    const files = [...document.getElementById("reg-files").files];
    revMatch = null;
    revInput.readOnly = false;
    if (files.length === 1) {
      const stem = fileStem(files[0].name);
      const ext = (files[0].name.split(".").pop() || "").toLowerCase();
      const res = await fetch(`/editor/documents/existing-rev?path=${encodeURIComponent(targetPath || "")}&stem=${encodeURIComponent(stem)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.found && !data.exts.includes(ext)) {
          revMatch = data;
        }
      }
    }
    if (revMatch) {
      revInput.value = revMatch.current_rev;
      revInput.readOnly = true;
      revNote.style.display = "";
      revNote.textContent = `Rev 매칭: 이 폴더에 같은 이름의 자료(이미 있는 형식: ${revMatch.exts.join("/").toUpperCase()})가 Rev ${revMatch.current_rev}로 등록되어 있어, 이 자료도 Rev ${revMatch.current_rev}로 자동 등록됩니다.`;
    } else {
      revNote.style.display = "none";
      revNote.textContent = "";
    }
  }
  document.getElementById("reg-files").addEventListener("change", refreshRevMatch);
  const dropZone = document.getElementById("reg-files").nextElementSibling;
  if (dropZone) dropZone.addEventListener("drop", refreshRevMatch);

  document.getElementById("reg-confirm").addEventListener("click", async () => {
    const input = document.getElementById("reg-files");
    const files = [...input.files];
    if (!files.length) { await showAlert("파일을 선택하세요."); return; }

    // Rev 매칭이 활성화된 상태에서 값이 어긋나 있으면(예: 미리보기가 끝나기 전에 직접
    // 입력) 기존 자료의 Rev로 강제로 맞춘다 — 원본·사본이 다른 Rev를 가리키면 안 되므로
    // 사용자가 정한 값이라도 여기서는 성립하지 않는다.
    let rev = revInput.value.trim() === "" ? 0 : parseInt(revInput.value, 10);
    if (Number.isNaN(rev) || rev < 0) rev = 0;
    if (revMatch && rev !== revMatch.current_rev) {
      await showAlert(`이 폴더에 같은 이름의 자료가 이미 Rev ${revMatch.current_rev}로 등록되어 있습니다. 원본과 사본은 같은 Rev여야 하므로, 이 자료도 Rev ${revMatch.current_rev}로 등록합니다.`);
      rev = revMatch.current_rev;
      revInput.value = rev;
    }

    const groups = new Map();
    for (const f of files) {
      const stem = fileStem(f.name);
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!groups.has(stem)) groups.set(stem, new Set());
      groups.get(stem).add(ext);
    }
    const unmatched = [...groups.entries()].filter(([, exts]) => exts.size === 1);
    if (unmatched.length > 0) {
      const items = unmatched.map(([stem, exts]) => {
        const ext = [...exts][0];
        return { stem, ext, file: files.find((f) => fileStem(f.name) === stem && (f.name.split(".").pop() || "").toLowerCase() === ext) };
      });
      const ok = await showPartialFilesConfirm("다음 자료는 원본과 사본(PDF) 중 한쪽만 있습니다.", items);
      if (!ok) return;
    }

    let confirmDuplicates = false;
    while (true) {
      const fd = new FormData();
      fd.append("target_path", targetPath || "");
      files.forEach((f) => fd.append("files", f));
      fd.append("confirm_duplicates", confirmDuplicates ? "true" : "false");
      fd.append("rev", String(rev));
      const res = await fetch("/editor/documents/register", { method: "POST", body: fd });
      if (!res.ok) { await showAlert("등록할 수 없습니다: " + (await safeErrText(res))); return; }
      const data = await res.json();
      if (data.needs_confirmation) {
        const list = data.duplicates.map((d) => `${d.stem} (${d.exts.join(", ")} 중복)`).join("\n");
        const ok = await showConfirm(`같은 이름의 파일이 형식별로 2개 이상 있어 어느 게 맞는 파일인지 알 수 없습니다:\n${list}\n\n해당 자료는 등록하지 않고 건너뛰고, 나머지만 계속 등록하시겠습니까? (건너뛴 자료는 첨부를 정리해 다시 등록해주세요)`);
        if (!ok) return;
        confirmDuplicates = true;
        continue;
      }
      closeModal();
      await loadTree();
      await loadDocuments();
      let msg = `신규 자료 ${data.created_documents}건이 등록되었습니다.`;
      if (data.attached_files) {
        msg += `\n같은 이름의 기존 자료에 파일 ${data.attached_files}개를 추가했습니다.`;
      }
      if (data.already_exists && data.already_exists.length) {
        msg += "\n\n다음 자료는 같은 이름·같은 형식으로 이미 등록돼 있어 올리지 않았습니다";
        msg += " (내용을 바꾸려면 [자료 교체]를 쓰세요):\n";
        msg += alreadyExistsLines(data.already_exists).join("\n");
      }
      if (data.duplicates && data.duplicates.length) {
        msg += `\n(같은 이름 중복으로 건너뛴 자료: ${data.duplicates.map((d) => d.stem).join(", ")})`;
      }
      await showAlert(msg);
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Zip 폴더 업로드 — 넣을 위치는 왼쪽 트리에서 지금 선택한 폴더(폴더명 확인 카드가 보여주는
// 그 폴더)를 그대로 쓴다. 트리에서 아무것도 안 골랐거나 "폴더" 헤더(최상위)를 골랐으면 최상위로 들어간다.
// ---------------------------------------------------------------------------
function currentZipTargetPath() {
  const s = state.selectedFolder;
  return s && s.kind === "folder" ? s.path : "";
}

// 파일 하나(zip 하나)를 등록. 확인이 필요하면 그때그때 물어보고, 취소하면 그 파일만
// 건너뛴 것으로 처리해 다음 파일로 넘어간다. 반환값: { skipped: true } 또는 등록 결과 요약.
async function uploadOneZip(file, targetPath, rev) {
  let confirmPartial = false;
  let confirmUnsafePaths = false;
  let confirmDuplicates = false;
  while (true) {
    const fd = new FormData();
    fd.append("target_path", targetPath);
    fd.append("confirm_partial", confirmPartial ? "true" : "false");
    fd.append("confirm_unsafe_paths", confirmUnsafePaths ? "true" : "false");
    fd.append("confirm_duplicates", confirmDuplicates ? "true" : "false");
    fd.append("rev", String(rev));
    fd.append("zip_file", file);
    const res = await fetch("/editor/zip-register", { method: "POST", body: fd });
    if (!res.ok) {
      return { error: `${file.name}: 처리 중 문제가 발생했습니다: ${await safeErrText(res)}` };
    }
    const data = await res.json();
    if (data.needs_confirmation) {
      // DWG·PDF 폴더는 묻지 않고 규칙대로 자동 판정한다 — 한 폴더 밑에 DWG 폴더와 PDF 폴더가
      // 둘 다 있으면 합치고, 한쪽만 있으면 보통 폴더로 그대로 둔다 (2026-08-21 CM 확정).
      if (data.unsafe_paths && data.unsafe_paths.length && !confirmUnsafePaths) {
        const list = data.unsafe_paths.join("\n");
        const ok = await showConfirm(`[${file.name}] 압축파일 안에 상위 폴더로 빠져나가려는 이름(..)이 있습니다:\n${list}\n\n그 부분은 무시하고(지정한 폴더 밖으로는 절대 나가지 않음) 나머지 폴더 이름만 그대로 사용해서 계속 등록하시겠습니까?`);
        if (!ok) return { skipped: true, name: file.name };
        confirmUnsafePaths = true;
        continue;
      }
      if (data.duplicates && data.duplicates.length && !confirmDuplicates) {
        const list = data.duplicates.map((d) => `${d.folder ? d.folder + " / " : ""}${d.stem} (${d.exts.join(", ")} 중복)`).join("\n");
        const ok = await showConfirm(`[${file.name}] 다음 자료는 같은 이름의 파일이 형식별로 2개 이상 있어 어느 게 맞는 파일인지 알 수 없습니다:\n${list}\n\n이 자료들은 등록하지 않고 건너뛰고, 나머지만 계속 등록하시겠습니까? (건너뛴 자료는 Zip을 정리해 다시 올리거나 [신규추가]로 개별 등록해주세요)`);
        if (!ok) return { skipped: true, name: file.name };
        confirmDuplicates = true;
        continue;
      }
      const items = data.skipped.map((s) => ({ stem: s.stem, ext: s.ext }));
      const ok = await showPartialFilesConfirm(`[${file.name}] 다음 자료는 원본과 사본(PDF) 중 한쪽만 있습니다.`, items);
      if (!ok) return { skipped: true, name: file.name };
      confirmPartial = true;
      continue;
    }
    return {
      name: file.name,
      created: data.created_documents,
      attached: data.attached_files || 0,
      alreadyExists: data.already_exists || [],
      duplicateStems: (data.duplicates || []).map((d) => d.stem),
    };
  }
}

// 이미 같은 이름·같은 형식으로 등록돼 있어 올리지 못한 자료 안내 (덮어쓰지 않는다 —
// 내용을 바꾸려면 [자료 교체]를 써야 한다).
function alreadyExistsLines(items) {
  return items.map((it) => `- ${it.stem} (${it.exts.map((e) => e.toUpperCase()).join(", ")})`);
}

document.getElementById("zip-submit").addEventListener("click", async () => {
  const targetPath = currentZipTargetPath();
  const fileInput = document.getElementById("zip-file");
  const files = [...fileInput.files];
  if (!files.length) { await showAlert("Zip 파일을 선택하세요."); return; }
  const revInput = document.getElementById("zip-rev");
  let rev = revInput.value.trim() === "" ? 0 : parseInt(revInput.value, 10);
  if (Number.isNaN(rev) || rev < 0) rev = 0;
  const btn = document.getElementById("zip-submit");
  btn.disabled = true;
  try {
    const results = [];
    for (const file of files) {
      results.push(await uploadOneZip(file, targetPath, rev));
    }

    const errors = results.filter((r) => r.error);
    const skipped = results.filter((r) => r.skipped);
    const done = results.filter((r) => !r.error && !r.skipped);
    const totalCreated = done.reduce((sum, r) => sum + r.created, 0);

    const totalAttached = done.reduce((sum, r) => sum + r.attached, 0);
    const allAlready = done.flatMap((r) => r.alreadyExists);

    const lines = [];
    if (files.length > 1) {
      lines.push(`Zip ${files.length}개 중 ${done.length}개 처리 완료, 총 ${totalCreated}건 등록되었습니다.`);
      for (const r of done) {
        let line = `- ${r.name}: ${r.created}건 등록`;
        if (r.attached) line += `, 기존 자료에 ${r.attached}개 파일 추가`;
        if (r.duplicateStems.length) line += ` (같은 이름 중복으로 건너뛴 자료: ${r.duplicateStems.join(", ")})`;
        lines.push(line);
      }
    } else if (done.length) {
      let line = `${done[0].created}건 등록되었습니다.`;
      if (done[0].attached) line += ` 기존 자료에 파일 ${done[0].attached}개를 추가했습니다.`;
      if (done[0].duplicateStems.length) line += ` (같은 이름 중복으로 건너뛴 자료: ${done[0].duplicateStems.join(", ")})`;
      lines.push(line);
    }
    if (allAlready.length) {
      lines.push(`다음 자료는 같은 이름·같은 형식으로 이미 등록돼 있어 올리지 않았습니다 (내용을 바꾸려면 [자료 교체]를 쓰세요):`);
      lines.push(...alreadyExistsLines(allAlready));
    }
    if (skipped.length) lines.push(`등록을 취소한 Zip: ${skipped.map((r) => r.name).join(", ")}`);
    if (errors.length) lines.push(...errors.map((r) => r.error));

    const kind = errors.length ? "err" : (skipped.length || allAlready.length) ? "warn" : "ok";
    showResult("zip-result", kind, lines.join("\n") || "등록을 취소했습니다.");

    if (done.length) {
      await loadTree();
      await loadDocuments();
    }
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// 삭제 보관함
// ---------------------------------------------------------------------------
async function refreshTrashCount() {
  // 버튼 옆 괄호 숫자만 필요하므로 목록 전체가 아니라 건수만 받아온다
  // (보관함이 1,000건 넘게 쌓이면서 목록 조회가 화면 전체를 느리게 만들었다).
  const res = await fetch("/editor/trash/count");
  if (!res.ok) return;
  const { count } = await res.json();
  document.getElementById("trash-count").textContent = count ? `(${count})` : "";
}

async function openTrash() {
  // 보관함이 많이 쌓이면 목록을 받는 데 시간이 걸린다. 그동안 버튼이 아무 반응이 없으면
  // 눌리지 않은 것으로 오해하므로(실제로 그런 문의가 있었다) 눌린 즉시 표시를 바꾼다.
  const openBtn = document.getElementById("trash-open-btn");
  const openBtnHtml = openBtn.innerHTML;
  openBtn.disabled = true;
  openBtn.textContent = "불러오는 중…";
  let items;
  try {
    const res = await fetch("/editor/trash");
    if (!res.ok) { await showAlert("삭제 보관함을 불러오지 못했습니다."); return; }
    items = await res.json();
  } finally {
    openBtn.disabled = false;
    openBtn.innerHTML = openBtnHtml;
  }

  // 완전 삭제는 권한 트리로 나누지 않고 관리자(ADMIN)만 쓸 수 있다(2026-08-17 CM 확정).
  const canPurge = window.__tdmsMe?.role === "ADMIN";
  const rows = items.length
    ? items.map((it, idx) => `
        <tr>
          <td class="col-no">${idx + 1}</td>
          <td class="tc" data-sort="off"><input type="checkbox" class="trash-row-check" data-batch="${it.batch_id}" ${canPurge ? "" : "disabled"} /></td>
          <td>${it.kind === "FOLDER" ? "폴더" : "자료"}</td>
          <td>${esc(it.target_label)}</td>
          <td class="muted">${esc(it.original_path || "")}</td>
          <td class="tc" data-sort-value="${it.doc_count}">${it.doc_count}건</td>
          <td class="tc muted">${fmtDateTime(it.archived_at)}</td>
          <td class="tc" data-sort="off">
            <div class="trash-actions">
              <button class="small" type="button" data-restore="${it.batch_id}" ${(window.__tdmsPerms || new Set()).has("screen.tdb_editor.restore") ? "" : "disabled"}>복구</button>
              <a href="/editor/trash/${it.batch_id}/download"><button class="small" type="button">다운로드</button></a>
              <button class="small danger-line" type="button" data-purge="${it.batch_id}" ${canPurge ? "" : "disabled"}>완전 삭제</button>
            </div>
          </td>
          <td data-sort="off">${noteEditCellHtml(it.batch_id, it.reason)}</td>
        </tr>`).join("")
    : `<tr><td colspan="9" class="empty">삭제 보관함이 비어 있습니다.</td></tr>`;

  openModal(
    `<h2 class="trash-modal-title">TDB 삭제 보관함</h2>
     <div class="status-bar">
       <span><b>전체 ${items.length}건</b></span>
       <span class="cart-status">
         <button id="trash-purge-btn" class="cart-btn danger-line" type="button" ${canPurge ? "" : "disabled"}>선택 완전 삭제</button>
         <button id="trash-export-btn" class="cart-btn" type="button">엑셀 내보내기</button>
       </span>
     </div>
     <div class="table-scroll trash-table-scroll">
       <table id="trash-table">
         <colgroup>
           <col style="width:44px" />
           <col style="width:34px" />
           <col style="width:56px" />
           <col style="width:200px" />
           <col />
           <col style="width:64px" />
           <col style="width:140px" />
           <col style="width:210px" />
           <col style="width:180px" />
         </colgroup>
         <thead>
           <tr>
             <th data-sort="off">No</th>
             <th class="col-check" data-sort="off"><input type="checkbox" id="trash-select-all" ${canPurge ? "" : "disabled"} /></th>
             <th>종류</th>
             <th>대상</th>
             <th>기존 경로</th>
             <th>자료 수</th>
             <th>삭제 시각</th>
             <th data-sort="off">조치</th>
             <th data-sort="off">비고</th>
           </tr>
         </thead>
         <tbody>${rows}</tbody>
       </table>
     </div>
     <div class="modal-actions">
       <button type="button" data-close-modal>닫기</button>
     </div>`,
    "trash"
  );

  document.getElementById("trash-export-btn").addEventListener("click", () => {
    window.location = "/editor/trash/export";
  });

  const tbody = document.querySelector("#trash-table tbody");
  wireNoteEdits(tbody, (id) => `/editor/trash/${id}/note`, "common.note_edit.tdb_trash");

  const trashTable = document.getElementById("trash-table");
  // 키에 -v3을 붙인 이유: No 열이 생기면서 열 개수가 8 → 9로 바뀌었다. 저장된 폭은 순서(index)
  // 기준이라 옛 값을 그대로 되살리면 열이 한 칸씩 밀린다.
  const trashColWidths = persistedColumnWidths(trashTable, "editor:trash-table-v3");
  trashColWidths.restore();
  makeColumnsResizable(trashTable, trashColWidths.save);
  // 다른 표(사용자 관리·권한 관리 등)와 같은 클릭 정렬 템플릿 — 화살표 없이 글씨만.
  makeSortable(trashTable);

  const selectAll = document.getElementById("trash-select-all");
  selectAll.addEventListener("change", () => {
    tbody.querySelectorAll(".trash-row-check").forEach((cb) => { cb.checked = selectAll.checked; });
  });

  document.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const batchId = btn.dataset.restore;
      const res2 = await fetch(`/editor/trash/${batchId}/restore`, { method: "POST" });
      if (!res2.ok) { await showAlert("복구에 실패했습니다."); return; }
      closeModal();
      await loadTree();
      await loadDocuments();
      openTrash();
    });
  });

  document.querySelectorAll("[data-purge]").forEach((btn) => {
    btn.addEventListener("click", () => purgeTrash([Number(btn.dataset.purge)], items));
  });
  document.getElementById("trash-purge-btn").addEventListener("click", async () => {
    const ids = [...tbody.querySelectorAll(".trash-row-check:checked")].map((cb) => Number(cb.dataset.batch));
    if (!ids.length) { await showAlert("완전 삭제할 항목을 하나 이상 선택하세요."); return; }
    await purgeTrash(ids, items);
  });
}

// 완전 삭제 확인 — 되돌릴 수 없는 작업이라는 경고만 한 번 확인받는다(2026-08-17 CM 확정,
// 이후 CM 요청으로 문구 재입력 단계는 없앰 — 이 권한 자체가 관리자 전용이라 별도 단계가
// 필요 없다고 판단). TDB·MDB 삭제 보관함이 같은 절차를 쓴다.
async function confirmPurge(batchCount, docCount, extraWarning) {
  return showConfirm(
    `선택한 ${batchCount}건(자료 ${docCount}건)을 완전히 삭제합니다.\n\n` +
    "· 파일이 디스크에서 실제로 지워져 저장 공간이 확보됩니다.\n" +
    "· 삭제 보관함에서 사라지고 다시는 되살릴 수 없습니다.\n" +
    extraWarning +
    "\n계속하시겠습니까?"
  );
}

async function purgeTrash(batchIds, items) {
  const targets = items.filter((it) => batchIds.includes(it.batch_id));
  const docCount = targets.reduce((sum, it) => sum + it.doc_count, 0);
  const ok = await confirmPurge(
    batchIds.length, docCount,
    "· 이 자료의 Revision 이력과 반출 기록도 함께 사라집니다.\n"
  );
  if (!ok) return;

  const res = await fetch("/editor/trash/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batch_ids: batchIds }),
  });
  if (!res.ok) { await showAlert("완전 삭제에 실패했습니다: " + (await safeErrText(res))); return; }
  const data = await res.json();

  closeModal();
  await loadTree();
  await loadDocuments();
  await showAlert(
    `${data.purged_batches}건을 완전히 삭제했습니다.\n` +
    `자료 ${data.purged_documents}건 · 파일 ${data.deleted_files}개\n` +
    `확보한 용량: ${formatFileSize(data.freed_bytes)}`
  );
  openTrash();
}

// ---------------------------------------------------------------------------
// 폐기 보관함 — 팝업 자체는 ui.js(openRetiredPopup)에 있어 조회 화면과 같은 것을 쓴다.
// 이 화면은 "복구할 자리를 다시 고르는 팝업"만 맡는다 — 폴더 트리를 이미 갖고 있기 때문.
// ---------------------------------------------------------------------------
function openRetiredTrash() {
  return openRetiredPopup("tdb", {
    screen: "TDB 관리",
    canEdit: true,
    pickFolder: pickRestoreFolder,
    onChanged: async () => { await loadTree(); await loadDocuments(); },
  });
}

// 폐기 당시 폴더가 없어졌거나(NO_FOLDER) 그 자리에 같은 이름 자료가 이미 있을 때(NAME_TAKEN)
// 새 위치를 고른다. 고른 경로를 돌려주고, 취소하면 null을 돌려준다.
function pickRestoreFolder({ originalPath, reason, names }) {
  const why = reason === "NAME_TAKEN"
    ? "폐기 당시 폴더에 같은 이름의 자료가 이미 있습니다. 되돌릴 위치를 다시 지정해 주세요."
    : "폐기 당시 폴더가 지금은 없습니다. 되돌릴 위치를 지정해 주세요.";
  const target = names.length > 1 ? `${names[0]} 외 ${names.length - 1}건` : (names[0] || "");

  return new Promise((resolve) => {
    tpPickerState.root = buildFolderOnlyTree(null);
    tpPickerState.selectedPath = "";
    tpPickerState.expanded = new Set();

    const layer = pushDialogLayer(`
      <div class="modal-overlay">
        <div class="modal-box folder-picker-box">
          <p class="modal-title">복구 위치 지정</p>
          <div class="edit-target">
            <div class="kv-line"><span class="kv-label">복구 대상</span><b>${esc(target)}</b></div>
            <div class="kv-line"><span class="kv-label">폐기 당시 경로</span><b>${esc(originalPath || "(최상위)")}</b></div>
          </div>
          <p class="warn-text" style="margin-top:10px;">${why}</p>
          <div class="folder-picker-current">선택됨: <b id="tpp-current">(최상위)</b></div>
          <div class="folder-picker-scroll" id="tpp-tree"></div>
          <div class="modal-actions">
            <button type="button" id="rp-cancel">취소</button>
            <button type="button" class="primary" id="rp-confirm">이 위치로 복구</button>
          </div>
        </div>
      </div>`);

    renderTpPickerTree();
    layer.querySelector("#rp-cancel").addEventListener("click", () => {
      popDialogLayer(layer);
      resolve(null);
    });
    layer.querySelector("#rp-confirm").addEventListener("click", () => {
      const picked = tpPickerState.selectedPath;
      popDialogLayer(layer);
      resolve(picked);
    });
  });
}

// ---------------------------------------------------------------------------
// 모달 · 입력창
// ---------------------------------------------------------------------------
function openModal(html, size) {
  // size: "trash" → 삭제 보관함용 큰 모달, "wide" → 폭 640px, 그 외 기본 폭.
  // (PDF 미리보기는 ui.js의 공용 팝업을 쓰므로 여기엔 없다.)
  const cls = size === "trash" ? "trash-modal" : size ? "wide" : "";
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-overlay"><div class="modal-box ${cls}">${html}</div></div>`;
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

// 화면 코드가 그리는 버튼에 onclick 속성으로 명령을 직접 적지 않는다 — 보안 머리글(Content-Security-Policy)이
// 그렇게 적힌 명령을 실행하지 않게 막기 때문이다(2026-09-17 시큐어코딩). 버튼에는 data- 표시만 달고
// 여기서 한 번에 연결한다. 비활성(disabled) 버튼은 눌림 자체가 일어나지 않는다.
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-close-modal], [data-clear-selection], [data-preview-selected], [data-tp-pick]");
  if (!target) return;
  if (target.hasAttribute("data-close-modal")) closeModal();
  else if (target.hasAttribute("data-clear-selection")) clearDocSelection();
  else if (target.hasAttribute("data-preview-selected")) previewSelectedDoc();
  else openTpPicker(target.dataset.tpPick, "sel", target.dataset.tpExclude ?? null);
});

// ---------------------------------------------------------------------------
// 트리 폭 조절 — TDB 조회 화면과 같은 방식(main-layout이 flex라 tree-panel의 flex-basis만 바꾼다)
// ---------------------------------------------------------------------------
function setupTreeResize() {
  const layout = document.querySelector(".main-layout");
  const treePanel = document.querySelector(".main-layout .tree-panel");
  const handle = document.getElementById("tree-resize-handle");
  if (!layout || !treePanel || !handle) return;
  const MIN_WIDTH = 200;
  const MAX_WIDTH = 640;
  const STORAGE_KEY = "dms_editor_tree_width";

  const saved = Number(localStorage.getItem(STORAGE_KEY));
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
      localStorage.setItem(STORAGE_KEY, finalWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
document.getElementById("trash-open-btn").addEventListener("click", openTrash);
document.getElementById("retired-open-btn").addEventListener("click", openRetiredTrash);
// "신규 추가" 버튼은 이제 "자료 편집" 본문 안(자료 교체 옆)에서 매번 새로 그려지므로,
// 그 클릭 연결은 renderPanels() 안에서 한다(여기서는 한 번만 붙일 정적 버튼이 없다).
attachDropZone("zip-file", { multiple: true, hint: "여기로 zip 파일을 끌어다 놓으세요 (여러 개 가능)" });

// Zip 업로드도 신규추가 팝업(openRegisterModal)과 같은 방식으로 Rev를 지정할 수 있게 한다
// (2026-08-18 CM 확정). 파일 선택 줄과 점선 드롭존 사이에 끼워 넣어야 하는데, 드롭존은
// attachDropZone이 input 바로 뒤에 이미 넣어놨으므로, 여기서 다시 한 번 input 뒤에
// insertAdjacentElement("afterend")로 넣으면 드롭존을 한 칸 밀어내 입력칸-Rev줄-드롭존
// 순서가 된다. Rev 입력은 file[type=number]라 label 안에 있어도 클릭이 파일선택으로
// 안 튄다(라벨은 내부의 다른 폼 컨트롤로는 클릭을 전달하지 않음).
(() => {
  const zipFileInput = document.getElementById("zip-file");
  const revRow = document.createElement("div");
  revRow.className = "modal-field-row zip-rev-row";
  revRow.innerHTML = `
    <label for="zip-rev">Rev 번호</label>
    <input type="number" id="zip-rev" min="0" step="1" placeholder="미입력시 Rev 0" />`;
  zipFileInput.insertAdjacentElement("afterend", revRow);
})();

// 표 헤더 너비 조절 — TDB 조회 화면(script.js)과 같은 방식. 표에 행이 아직 없으면 "경로"처럼
// 폭을 안 정한 열의 실제 렌더 폭을 못 읽으므로, 첫 데이터 로드가 끝난 뒤에 건다.
const docColWidths = persistedColumnWidths(document.getElementById("doc-table"), "editor:doc-table");

renderIsoList();
renderIsoToggle();
setupTreeResize();

// 표 헤더를 누르면 화면의 50건만이 아니라 조회 결과 전체가 정렬돼야 하므로(공통 규칙),
// 서버에 정렬 조건을 보내고 1페이지부터 다시 받아온다(TDB 조회 script.js와 동일한 방식).
let showSortedColumn = () => {};

async function init() {
  await window.tdmsReady; // 권한(window.__tdmsPerms)에 따라 폴더·자료 편집 버튼을 다르게 그리므로 먼저 기다린다
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
