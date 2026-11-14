// MDB 관리 화면 — TDB 관리(editor.js)와 같은 레이아웃·패턴을 mdb_files 대상으로 쓴다.
// mdb_files.source_path는 파일명까지 포함한 전체 경로라 "폴더"는 그 경로에서 파일명을
// 뗀 부분으로 매번 다시 조립한다. MDB는 리비전·반출 개념이 없어(도면과 다른 체계) 그와
// 관련된 TDB 전용 로직(Rev, 상태 배지, 반출중 편집차단, Isometric)은 없다.
// 서버 데이터: 폴더 트리는 /mdb-editor/tree(폴더 목록 + placeholder, 폴더만 씀 — 자료 목록은
// 무시하고 결과 표는 /mdb/list로 따로 불러온다), 결과 표는 /mdb/list.

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

function folderDisplayName(path) {
  const parts = path.split("\\");
  return parts[parts.length - 1];
}

function firstNum(name) {
  const m = String(name).match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// DWG·PDF 폴더 병합 — 원본은 DWG 폴더, 사본은 PDF 폴더에 따로 들어와 각각 별개 자료로
// 등록돼 버린 것을 나중에라도 한 자료로 합친다 (TDB 관리와 같은 화면·같은 자리).
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

// 대소문자만 달라서 못 합치는 자료 — 합쳐주지 않고 알리기만 한다 (TDB 관리와 같은 규칙).
function caseMismatchCell(c) {
  if (!c.case_mismatch_count) return "-";
  const list = (c.case_mismatch_names || []).join("\n");
  return `<span title="${esc(list)}\n\n대소문자가 달라 합쳐지지 않습니다. 자료명을 서로 같게 고치면 합칠 수 있습니다.">${c.case_mismatch_count}건</span>`;
}

async function openPairFolderMergeModal() {
  const res = await fetch("/mdb-editor/pair-folders/candidates");
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
        "합쳐진 자료는 DWG·PDF 폴더가 화면에서 감춰지고 1건으로 보이며, 저장 위치와 다운로드 zip에는 그대로 남습니다.\n\n계속하시겠습니까?",
      );
      if (!ok) return;
      const mres = await fetch("/mdb-editor/pair-folders/merge", {
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
        msg += mdata.skipped.map((s) => `${s.path.replaceAll("\\", " / ")} / ${s.name} — ${s.reason}`).join("\n");
      }
      await showAlert(msg);
    }
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

async function exportPairFolderCandidates() {
  const res = await fetch("/mdb-editor/pair-folders/candidates/export");
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

// 소속공사(최상위 폴더)명 앞의 "2013. 08. - " 같은 연도.월 표기를 떼고 공사명만 남긴다 (mdb.js와 동일)
function shortProjectLabel(name) {
  const stripped = String(name || "").replace(/^\d{4}\.\s*\d{1,2}\.\s*-\s*/, "").trim();
  return stripped || name || "-";
}

// DWG/XLSX/ETC/PDF 네 칸에 이 자료가 가진 형식마다 Y를 찍는다 (mdb.js와 동일).
// 자료 1건이 원본과 PDF 사본을 함께 가질 수 있어 두 칸에 Y가 들어갈 수 있다(2026-08-17).
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

  selectedFolder: null, // { kind:'root' } | { kind:'folder', path, docCount, isPlaceholder }
  selectedDocIds: new Set(), // 결과 표에서 체크한 자료 id들 (TDB 관리와 같은 다중 선택 방식)

  tag: "",              // 검색대상=Tag No로 고른 Tag No (없으면 자료명 검색 모드)

  // 설비유형·자료유형 마스터 목록은 mdb-types.js가 들고 있다(typeListCache) — 자료 상세보기와 공용
  projects: [],         // /mdb/meta의 projects

  sort: "",          // 표 헤더를 눌러 정한 정렬 기준 열(빈값이면 기본 = 자료명순)
  sortDir: "asc",    // asc(오름차순) / desc(내림차순)

  navFiltersKey: null,  // 아래 navListPromise가 지금 어떤 검색조건 기준인지(같으면 재사용, 다르면 새로 받음)
  navListPromise: null, // 미리보기 "이전·다음"이 페이지(50건)가 아니라 검색조건 전체를 넘나들게 해주는 가벼운 목록
};

// ---------------------------------------------------------------------------
// 필터 → 쿼리 문자열
// ---------------------------------------------------------------------------
function currentFilters() {
  const target = document.getElementById("search-target").value;
  const raw = document.getElementById("q").value.trim();
  return {
    // 검색대상이 자료명이면 q로, Tag No면 tag로(아래 handleSearchClick에서 고른 Tag No를 state.tag에
    // 담는다), 전체면 q_any로 — 자료명·경로와 Tag No 어느 쪽에 걸려도 찾는다(둘 다 부분일치).
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
    // 정렬은 화면의 50건이 아니라 조회 결과 전체가 기준이라 서버로 같이 보낸다(TDB 관리와 동일).
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
// (TDB 관리 editor.js와 같은 방식). 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다.
// project_id·equipment_type 드롭다운은 loadFilterMeta()가 옵션을 채운 뒤라야 값이 먹으므로,
// restoreState()는 init()에서 그 다음에 부른다.
// ---------------------------------------------------------------------------
const STATE_KEY = "dms_mdb_editor_state";

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
    show_hidden: showHiddenFolders(),
    sort: state.sort,
    dir: state.sortDir,
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
    document.getElementById("show_hidden_folders").checked = !!s.show_hidden;
    state.sort = s.sort || "";
    state.sortDir = s.dir || "asc";
    state.page = s.page || 1;
    state.selectedDocIds = new Set(s.selectedDocIds || []);
    state.expanded = new Set(s.expanded || []);
    if (s.folderKind === "root") {
      state.selectedFolder = { kind: "root" };
    } else if (s.folderKind === "folder" && s.folderPath) {
      // docCount·isPlaceholder·isPair는 loadTree()가 실제 트리를 받으면 다시 채워준다
      state.selectedFolder = { kind: "folder", path: s.folderPath, docCount: 0, isPlaceholder: false, isPair: false, splitCount: 0 };
    } else {
      state.selectedFolder = null;
    }
  } catch (e) {
    /* 무시 */
  }
}

// ---------------------------------------------------------------------------
// 폴더 트리 — /mdb-editor/tree 응답의 folders(자료가 있는 경로 + placeholder)만 조립한다.
// 자료(파일)는 트리에 안 넣는다(결과 표에서만 보여준다) — TDB 관리와 같은 방식.
// ---------------------------------------------------------------------------
function buildTree(folders) {
  const root = { name: "", path: "", children: new Map(), docCount: 0, isPlaceholder: false };
  folders.forEach((f) => {
    const parts = f.path.split("\\").filter(Boolean);
    let node = root;
    const acc = [];
    for (const part of parts) {
      acc.push(part);
      const full = acc.join("\\");
      if (!node.children.has(full)) {
        node.children.set(full, { name: part, path: full, children: new Map(), docCount: 0, isPlaceholder: false });
      }
      node = node.children.get(full);
      node.docCount += f.file_count;
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
  // 트리를 통째로 다시 그리므로 스크롤 위치가 맨 위로 돌아간다 — 그리기 전에 기억해 뒀다가
  // 되돌려서, 폴더를 눌러도 보고 있던 자리에 그대로 있게 한다.
  const prevScrollTop = container.scrollTop;
  container.innerHTML = "";
  if (!state.treeRoot) return;
  sortedChildren(state.treeRoot).forEach((n) => renderTreeNode(n, container, 0));
  container.scrollTop = prevScrollTop;
}

// 트리를 직접 클릭한 것과 똑같이 특정 폴더를 선택 상태로 만든다(결과표 "경로" 칸 클릭 등에서 쓴다).
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
  // 숨김 폴더 보기로 드러난 DWG·PDF 폴더는 폴더 아이콘을 회색으로 흐리게 해 구분한다
  // (TDB 관리와 같은 표시 — editor.css의 .tree-node.pair-folder 규칙을 같이 쓴다).
  row.className = "tree-node" + (isSelected ? " active" : "") + (node.isPair ? " pair-folder" : "");
  row.dataset.depth = Math.min(depth, 3);
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.innerHTML = `
    <span class="tree-toggle">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span>
    <span class="tree-icon">📁</span>
    <span class="tree-label">${esc(node.name)}</span>
    <span class="tree-count">(${node.docCount})</span>`;
  if (node.isPair) row.title = "평소에는 트리에 안 보이는 폴더입니다 (원본·사본이 나뉘어 담긴 자리)";

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
    state.selectedFolder = {
      kind: "folder", path: node.path, docCount: node.docCount,
      isPlaceholder: node.isPlaceholder, isPair: node.isPair, splitCount: node.splitCount,
    };
    state.expanded.add(node.path);
    state.page = 1;
    renderTree();
    renderPanels();
    loadDocuments();
  });
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

// "숨김 폴더 보기" — 평소 감춰두는 DWG·PDF 폴더를 트리에 드러낸다. 켜면 괄호 숫자가
// 자료 수가 아니라 파일 수가 된다(원본+사본 한 쌍이 2로 세어짐) — TDB 관리와 같은 규칙.
function showHiddenFolders() {
  const el = document.getElementById("show_hidden_folders");
  return !!(el && el.checked);
}

async function loadTree() {
  const res = await fetch(`/mdb-editor/tree?show_hidden=${showHiddenFolders() ? "true" : "false"}`);
  const data = await res.json();
  state.treeFolders = data.folders;
  state.treeRoot = buildTree(state.treeFolders);
  // 디폴트(펼친 폴더 없음)는 최상위 폴더 이름만 보이고 전부 접힌 상태다(2026-08-16 CM 확정).
  if (state.selectedFolder && state.selectedFolder.kind === "folder") {
    const node = findTreeNode(state.treeRoot, state.selectedFolder.path);
    if (node) {
      state.selectedFolder = {
        kind: "folder", path: node.path, docCount: node.docCount,
        isPlaceholder: node.isPlaceholder, isPair: node.isPair, splitCount: node.splitCount,
      };
    } else if (!pathIsPrefixOfAny(state.selectedFolder.path, state.treeFolders)) {
      state.selectedFolder = null;
    }
  }
  renderTree();
  updateSelectedFolderName();
  renderPanels();
  refreshTrashCount();
  refreshRetiredCount("mdb");
}

function pathIsPrefixOfAny(path, folders) {
  const prefix = path + "\\";
  return folders.some((f) => f.path === path || f.path.startsWith(prefix));
}

document.getElementById("tree-collapse-all").addEventListener("click", () => {
  state.selectedFolder = { kind: "root" };
  state.expanded.clear();
  state.page = 1;
  renderTree();
  renderPanels();
  loadDocuments();
});

// ---------------------------------------------------------------------------
// 결과 표 — MDB 조회 화면(mdb.js)과 같은 컬럼 구성 + TDB 관리와 같은 위치(No/체크/자료명 …
// DWG·XLSX·ETC·PDF/최종수정). 미리보기(돋보기)는 ui.js 공용 함수를 쓴다.
// ---------------------------------------------------------------------------
// 미리보기는 자료가 가진 PDF 사본을 연다(원본이 대표인 자료도 짝 PDF가 있으면 열린다).
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

// 이 검색조건에 맞는 자료 전체(50건 페이지 제한 없이)를 가볍게 받아둔다 — 미리보기의
// "이전·다음"이 지금 페이지 안에서만 움직이지 않고 검색조건 전체를 넘나들 수 있게 하기 위함.
function filtersKey(filters) {
  return JSON.stringify(filters);
}

function ensureNavList(filters) {
  const key = filtersKey(filters);
  if (state.navFiltersKey !== key || !state.navListPromise) {
    state.navFiltersKey = key;
    state.navListPromise = fetch(`/mdb/nav?${buildQueryString(filters)}`).then((r) => r.json());
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
  return {
    id: n.id,
    drawingNo: n.name,
    path: n.source_path,
    pdfFileId: n.pdf_file_id || null,
    previewUrl: n.pdf_file_id ? `/mdb/files/${n.pdf_file_id}/view` : null,
    source: mdbSource(n.id),
  };
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
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">조건에 맞는 자료가 없습니다.</td></tr>';
    return;
  }

  // 상세보기 화면의 이전/다음 이동 — 원칙은 "검색조건 전체"(ensureNavList가 받아 저장한다)이고,
  // 여기 페이지 50건은 그게 아직 안 왔을 때만 쓰는 임시 목록이다(ui.js가 전체를 덮지 않게 막는다).
  saveDetailNavPageList(items.map((d) => d.id));

  items.forEach((doc, i) => {
    const tr = document.createElement("tr");
    const isSelected = state.selectedDocIds.has(doc.id);
    const previewBtn = previewBtnHtml(doc.pdf_file_id || null, doc.has_original);
    tr.innerHTML = `
      <td class="col-no">${startNo + i}</td>
      <td><input type="checkbox" class="row-check" data-id="${doc.id}" ${isSelected ? "checked" : ""} /></td>
      <td>${previewBtn} <a href="mdb-detail.html?id=${doc.id}&from=mdb-editor">${esc(doc.name)}</a></td>
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

  // 체크박스는 TDB 관리와 같은 다중 선택 방식 — 여러 자료를 함께 체크해 위치 이동·삭제에
  // 한 번에 적용할 수 있다(자료명·정보 변경은 설비유형만 일괄, 자료 교체는 1개 선택시로 제한).
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
  const res = await fetch(`/mdb/list?${buildQueryString(params)}`);
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

// 검색대상(자료명/Tag No)에 따라 동작이 다르다. Tag No면 조각을 포함하는 실제 Tag No 후보를
// 찾아 정확히 하나면 바로 검색, 여러 개면 골라잡는 팝업을 띄운다(MDB 조회와 같은 동작).
async function handleSearchClick() {
  const target = document.getElementById("search-target").value;
  if (target === "FILE" || target === "ALL") {
    state.tag = "";
    search();
    return;
  }
  const raw = document.getElementById("q").value.trim();
  if (!raw) { state.tag = ""; search(); return; }
  const candidates = await (await fetch(`/mdb/tags/suggest?q=${encodeURIComponent(raw)}`)).json();
  const exact = candidates.find((c) => c.tag_no.toUpperCase() === raw.toUpperCase());
  if (exact) {
    document.getElementById("q").value = exact.tag_no;
    state.tag = exact.tag_no; search(); return;
  }
  if (candidates.length <= 1) {
    if (candidates.length === 1) document.getElementById("q").value = candidates[0].tag_no;
    state.tag = candidates.length === 1 ? candidates[0].tag_no : raw;  // 적은 그대로
    search(); return;
  }
  openTagPicker(raw, candidates);
}

function openTagPicker(query, candidates) {
  const rows = candidates
    .map((c) => `<tr class="mdb-pick-row" data-tag="${esc(c.tag_no)}"><td>${esc(c.tag_no)}</td><td>${c.count}건</td></tr>`)
    .join("");
  openModal(`
    <p class="modal-title">"${esc(query)}"이(가) 포함된 Tag No ${candidates.length}건 — 찾는 설비를 선택하세요</p>
    <div class="table-scroll" style="max-height:50vh;">
      <table class="mdb-pick-table">
        <thead><tr><th>Tag No</th><th>자료 수</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
    </div>`, "mdb-pick");
  document.querySelectorAll(".mdb-pick-row").forEach((row) => {
    row.addEventListener("click", () => {
      document.getElementById("q").value = row.dataset.tag;
      state.tag = row.dataset.tag;
      closeModal();
      search();
    });
  });
}

function updateSearchTargetUI() {
  const target = document.getElementById("search-target").value;
  document.getElementById("q").placeholder =
    target === "TAG" ? "Tag No 검색 (예: P1201A)"
    : target === "ALL" ? "자료명 또는 Tag No 검색"
    : "자료명 검색";
}

document.getElementById("search-btn").addEventListener("click", handleSearchClick);
document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearchClick(); });
document.getElementById("search-target").addEventListener("change", () => {
  updateSearchTargetUI();
});
["category", "equipment_type", "doc_type", "project_id", "holding"].forEach((id) => {
  document.getElementById(id).addEventListener("change", search);
});
document.getElementById("recursive_folder").addEventListener("change", search);

// 숨김 폴더 보기를 켜고 끄면 폴더 트리 자체가 달라지므로 트리부터 다시 받는다(TDB 관리와 같은 처리).
document.getElementById("show_hidden_folders").addEventListener("change", async () => {
  state.page = 1;
  state.selectedDocIds.clear();
  await loadTree();
  await loadDocuments();
  saveState();
});

document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("q").value = "";
  document.getElementById("search-target").value = "ALL";
  updateSearchTargetUI();
  document.getElementById("category").value = "";
  document.getElementById("equipment_type").value = "";
  document.getElementById("doc_type").value = "";
  document.getElementById("project_id").value = "";
  document.getElementById("holding").value = "";
  document.getElementById("recursive_folder").checked = false;
  document.getElementById("show_hidden_folders").checked = false;
  state.selectedFolder = null;
  state.selectedDocIds.clear();
  state.tag = "";
  state.sort = "";
  state.sortDir = "asc";
  showSortedColumn("", "asc");
  updateSearchTargetUI();
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

// ---------------------------------------------------------------------------
// 자료명 옆 돋보기(PDF 미리보기) — ui.js 공용 팝업(이전/다음 포함)을 쓴다.
// ---------------------------------------------------------------------------
// 자료 편집 패널 안 [미리보기] 버튼 — 결과표 페이지(50건)가 아니라 검색조건 전체(navListPromise)
// 안에서 이전/다음도 된다(PDF가 없어도 눌러서 "PDF 없음"을 볼 수 있다).
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
  // (표에 나오는 자료 수와 어긋나 보이지 않게 — TDB 관리와 같은 규칙).
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
      const previewBtn = `<button type="button" class="preview-icon-btn${d.pdf_file_id ? "" : " is-empty"}" data-preview-selected title="${d.pdf_file_id ? "미리보기" : "PDF 없음"}">${searchIconSvg}</button>`;
      el.innerHTML = `
        <span class="info-card-label">자료명</span>
        <span class="info-card-value">${previewBtn}<b>${esc(d.name)}</b>${clearBtn}</span>
        <span class="info-card-meta">분류 ${esc(d.category)}</span>
        <span class="info-card-meta">설비유형 ${esc(d.equipment_type || "-")}</span>
        <span class="info-card-meta">소속공사 ${esc(shortProjectLabel(d.project_name))}</span>`;
      return;
    }
  }
  el.innerHTML = `<span class="info-card-label">자료명</span><span class="info-card-value"><b>선택 ${n}건</b>${clearBtn}</span>`;
}

function renderPanels() {
  renderFolderInfoCard();
  renderDocInfoCard();

  const fp = document.getElementById("folder-panel");
  const dp = document.getElementById("doc-panel");
  const s = state.selectedFolder;
  const isFolder = !!(s && s.kind === "folder");
  const canModifyFolder = isFolder;

  // renderPanels()는 선택이 바뀔 때마다 innerHTML을 통째로 새로 그리므로, auth-guard.js가
  // 페이지 로드 시 한 번만 적용하는 [data-perm] 처리가 유지되지 않는다 — 여기서 직접
  // window.__tdmsPerms를 본다. 권한이 없어도 버튼 자체는 계속 보여주고 흐리게(disabled)만
  // 처리한다(2026-08-13 CM 확정 — 자기한테 없는 기능을 알아야 권한을 요청할 수 있다).
  // MDB는 폴더 체계가 Tag No라 트리 라벨은 "폴더 편집"이지만 리프 키는 screen.mdb_editor.tag.
  const perms = window.__tdmsPerms || new Set();
  const canFolder = perms.has("screen.mdb_editor.tag");
  const canDoc = perms.has("screen.mdb_editor.document");

  // Zip 폴더 업로드 블록과 같은 방식으로, 권한이 없으면 제목까지 포함해 블록 전체를
  // 흐리게 표시한다(2026-08-13 CM 확정).
  document.getElementById("folder-edit-block").classList.toggle("perm-disabled", !canFolder);
  document.getElementById("doc-edit-block").classList.toggle("perm-disabled", !canDoc);

  // 숨은 DWG·PDF 폴더도 다른 폴더와 똑같이 이름 변경·위치 이동·삭제할 수 있다(2026-08-17 CM 확정).
  // 다만 고치는 순간 원본·사본 묶음이 풀리므로, 누르면 먼저 경고 팝업으로 승인을 받는다
  // (confirmPairFolderEdit). 새 자료를 넣는 위치로는 여전히 쓸 수 없다.
  const isPairFolder = isFolder && !!(state.selectedFolder && state.selectedFolder.isPair);
  const pairNote = isPairFolder
    ? `<p class="modal-hint-text">이 폴더를 고치면 원본·사본 묶음이 풀립니다. 새 자료를 넣는 위치로는 쓸 수 없습니다.</p>`
    : "";
  fp.innerHTML = `
    <div class="edit-actions">
      <button type="button" id="folder-rename-btn" ${canFolder && canModifyFolder ? "" : "disabled"}>폴더명 변경</button>
      <button type="button" id="folder-move-btn" ${canFolder && canModifyFolder ? "" : "disabled"}>폴더 위치 이동</button>
      <div class="edit-actions-row">
        <button type="button" id="folder-add-btn" ${canFolder && isFolder && !isPairFolder ? "" : "disabled"}>폴더 추가</button>
        <button type="button" id="pair-merge-btn" ${canFolder ? "" : "disabled"}>DWG·PDF 폴더 병합</button>
      </div>
      <button type="button" id="folder-delete-btn" ${canFolder && canModifyFolder ? "" : "disabled"}>폴더 삭제</button>
    </div>${pairNote}`;
  if (canFolder) {
    document.getElementById("folder-rename-btn").addEventListener("click", renameFolder);
    document.getElementById("folder-move-btn").addEventListener("click", () => openMoveModal(true));
    document.getElementById("folder-add-btn").addEventListener("click", openAddFolderModal);
    document.getElementById("pair-merge-btn").addEventListener("click", openPairFolderMergeModal);
    document.getElementById("folder-delete-btn").addEventListener("click", deleteFolder);
  }

  // 자료명·정보 변경·위치 이동·삭제는 여러 건을 함께 선택해도 된다(정보 변경은 설비유형만
  // 일괄 적용). 자료 교체는 설비유형·Tag No 등을 일괄로 못 바꾸므로 1개를 선택했을 때만 된다
  // (2026-08-17 CM 확정).
  const selCount = state.selectedDocIds.size;
  const hasDoc = selCount > 0;
  const canReplace = selCount === 1;
  dp.innerHTML = `
    <div class="edit-actions">
      <div class="edit-actions-row">
        <button type="button" id="doc-rename-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료명·정보 변경</button>
        <button type="button" id="doc-unclassified-btn" ${canDoc ? "" : "disabled"}>Tag No·유형 미분류 관리</button>
      </div>
      <button type="button" id="doc-move-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료 위치 이동</button>
      <div class="edit-actions-row">
        <button type="button" id="doc-replace-btn" ${canDoc && canReplace ? "" : "disabled"} title="${canReplace ? "" : "자료를 1개만 선택했을 때 교체할 수 있습니다"}">자료 교체</button>
        <button type="button" id="doc-register-btn" ${canDoc && isFolder ? "" : "disabled"}>신규 추가</button>
      </div>
      <div class="edit-actions-row">
        <button type="button" id="doc-delete-btn" ${canDoc && hasDoc ? "" : "disabled"}>자료 삭제</button>
        <button type="button" id="doc-history-btn" ${canDoc ? "" : "disabled"}>Tag No 이력관리</button>
      </div>
    </div>`;
  if (canDoc) {
    document.getElementById("doc-rename-btn").addEventListener("click", editSelectedDocInfo);
    // 폴더 선택 여부와 무관하게 항상 켜져 있다 — 미분류 자료는 폴더 어디에나 흩어져 있을 수 있어서.
    document.getElementById("doc-unclassified-btn").addEventListener("click", openUnclassifiedManager);
    document.getElementById("doc-move-btn").addEventListener("click", () => openMoveModal(false));
    if (canReplace) document.getElementById("doc-replace-btn").addEventListener("click", replaceDoc);
    document.getElementById("doc-register-btn").addEventListener("click", openRegisterModal);
    document.getElementById("doc-delete-btn").addEventListener("click", deleteDoc);
    // 자료를 고르지 않아도 항상 켜져 있다 — 대상은 표에서 체크한 자료가 아니라 Tag No이므로.
    document.getElementById("doc-history-btn").addEventListener("click", openTagHistoryManager);
  }
}

// ---------------------------------------------------------------------------
// 폴더 편집 동작 — TDB 관리와 같은 흐름, /mdb-editor/* 엔드포인트만 다르다.
// ---------------------------------------------------------------------------
// DWG·PDF 폴더를 고치기 전에 뜨는 경고 — 승인해야 편집 화면이 열린다 (2026-08-17 CM 확정).
// 이 폴더는 원본과 사본을 한 자료로 묶어주는 자리라, 한쪽만 이름이 바뀌거나 다른 데로 가면
// 묶음이 성립하지 않는다. 그래서 고치는 순간 병합이 풀리고 자료가 두 건으로 나뉜다.
// (TDB 관리 editor.js의 같은 이름 함수와 같은 규칙 — MDB는 리비전·반출 이력이 없어 그 줄만 빠진다)
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
    "· 이 폴더는 숨김이 풀려 평소에도 트리에 보이게 됩니다.",
    "",
    "계속하시겠습니까?",
  ];
  return showConfirm(lines.join("\n"));
}

async function renameFolder() {
  const s = state.selectedFolder;
  if (!s || s.kind !== "folder") return;
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
  inp.value = oldName;  // 기존 이름에서 몇 글자만 고치는 경우가 대부분이라 미리 채운다
  setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 30);

  document.getElementById("rf-confirm").addEventListener("click", async () => {
    const newName = inp.value.trim();
    if (!newName) return;
    const cascadeShown = !cascadeRow.classList.contains("hidden");
    const cascade = cascadeShown && document.getElementById("rf-cascade-cb").checked;
    const parentParts = s.path.split("\\"); parentParts.pop();
    const newPath = parentParts.length ? parentParts.join("\\") + "\\" + newName : newName;
    closeModal();
    await callReparent(s.path, newPath, cascade);
  });
}

async function callReparent(oldPath, newPath, cascade) {
  const res = await fetch("/mdb-editor/folders/reparent", {
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
  await showAlert(`이름/위치를 바꿨습니다. (영향받은 자료 ${data.affected_files}건)`);
}

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
    const path = parentPath ? parentPath + "\\" + name : name;
    const res = await fetch("/mdb-editor/folders/placeholder", {
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
  if (!(await confirmPairFolderEdit(s, "폴더를 삭제하면"))) return;
  const pairWarn = s.isPair
    ? `<p class="warn-text" style="margin-top:10px;">병합이 풀린 뒤, <b>이 폴더 안 파일만</b> 삭제 보관함으로 갑니다.
         반대쪽 폴더의 파일은 원래 자리에 그대로 남습니다.</p>`
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
    const res = await fetch("/mdb-editor/folders/archive", {
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
  });
}

// ---------------------------------------------------------------------------
// 자료 편집 동작
// ---------------------------------------------------------------------------

// 설비유형·자료유형을 고르는 칸(마스터 목록 + 체크박스 드롭다운)은 MDB 자료 상세보기에서도
// 같이 쓰므로 frontend/mdb-types.js로 옮겼다 (2026-08-29). 이 화면에서 쓰는 것들:
//   TYPE_LISTS · TYPE_SEPARATOR · splitTypes · loadTypeList(s) · fillTypeFilterSelect · createTypeCheckDropdown
// 목록 편집 팝업(openTypeListManager)은 MDB 관리에만 있으므로 이 파일에 그대로 남는다.

// 자료를 1개만 선택했으면 자료명·Tag No·설비유형·자료유형·Note를 모두 고칠 수 있는
// editDocInfo를, 여러 건을 함께 선택했으면 설비유형·자료유형만 일괄 지정하는 editBulkTypes를
// 연다 (위치·이름·Tag No·Note는 자료마다 달라 한 번에 못 바꾼다 — 2026-08-17 CM 확정).
function editSelectedDocInfo() {
  const ids = [...state.selectedDocIds];
  if (ids.length === 0) return;
  if (ids.length === 1) {
    const d = state.lastItems.find((x) => x.id === ids[0]);
    if (d) editDocInfo(d);
    return;
  }
  editBulkTypes(ids);
}

// "자료명·정보 변경" — 파일명·Tag No·설비유형·자료유형·Note를 한 화면에서 고친다(원래 MDB
// 조회에서 자료를 클릭하면 뜨던 정보 편집창의 기능을 이 화면으로 옮긴 것). 소속공사·연도는
// 폴더 위치로 정해지므로 참고용으로만 보여준다.
// 설비유형·자료유형은 체크박스로 여러 개를 고를 수 있고 슬래시로 이어 붙는다("Pump/Strainer"),
// Note는 자유롭게 적어두는 칸으로 자료 상세보기에 그대로 보인다 (둘 다 2026-08-28 CM 확정).
//
// doc: 결과 표에서 고른 자료 1건.
async function editDocInfo(doc) {
  const d = doc;
  if (!d) return;
  const item = await (await fetch(`/mdb/files/${d.id}`)).json();
  let tags = [...item.tags];
  // 지금 고치는 중인 Tag No의 자리(-1이면 새로 추가하는 중). 이미 들어있는 Tag No를
  // 누르면 그 값이 입력칸으로 올라오고, 고쳐서 Enter를 누르면 새 Tag No가 추가되는 게
  // 아니라 그 자리 값이 바뀜다 (2026-08-28 CM 확정).
  let editingIndex = -1;
  await loadTypeLists();

  function renderChips() {
    document.getElementById("di-chip-area").innerHTML = tags
      .map((t, i) => `<span class="mdb-chip is-clickable${i === editingIndex ? " is-editing" : ""}" data-idx="${i}" title="누르면 아래 입력칸에서 고칠 수 있습니다">${esc(t)}<button type="button" data-rm="${i}" title="지우기">×</button></span>`)
      .join("");
    document.querySelectorAll("#di-chip-area [data-rm]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();  // 지우기(×)는 칩 클릭(고치기)으로 번지지 않게 한다
        const i = Number(b.dataset.rm);
        tags.splice(i, 1);
        // 고치는 중이던 것을 지우면 고치기를 그만두고, 그 앞을 지우면 자리가 하나씩 당겨진다.
        if (editingIndex === i) { cancelEditTag(); return; }
        if (editingIndex > i) editingIndex -= 1;
        renderChips();
      });
    });
    document.querySelectorAll("#di-chip-area [data-idx]").forEach((chip) => {
      chip.addEventListener("click", () => startEditTag(Number(chip.dataset.idx)));
    });
  }

  openModal(`
    <p class="modal-title">자료명·정보 변경</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">변경 대상</span><b>${esc(item.name)}</b></div>
      ${item.files && item.files.length > 1
        ? `<div class="kv-line"><span class="kv-label">딸린 파일</span><b>${esc(item.exts.join(", ").toUpperCase())} — 이름을 바꾸면 함께 바뀝니다</b></div>`
        : ""}
    </div>
    <input type="text" id="di-name" placeholder="변경 이름 (확장자 없이)" />

    <label class="field-label">Tag No</label>
    <div class="mdb-chip-area" id="di-chip-area"></div>
    <div class="di-equip-row">
      <input type="text" id="di-new-tag" placeholder="Tag No 입력 후 Enter (쉼표·슬래시로 여러 개, 예: TM1303A/B/C, MOV1351/1416/1417)" />
      <button type="button" id="di-tag-add">입력</button>
    </div>

    <label class="field-label">설비유형</label>
    <div class="di-equip-row">
      <div class="hideable-dropdown type-dropdown" id="di-equip-dd">
        <button type="button" class="dropdown-toggle"></button>
        <div class="dropdown-list hidden"></div>
      </div>
      <button type="button" class="small" id="di-equip-manage-btn" title="설비유형 목록 편집">✎</button>
    </div>

    <label class="field-label">자료유형</label>
    <div class="di-equip-row">
      <div class="hideable-dropdown type-dropdown" id="di-doctype-dd">
        <button type="button" class="dropdown-toggle"></button>
        <div class="dropdown-list hidden"></div>
      </div>
      <button type="button" class="small" id="di-doctype-manage-btn" title="자료유형 목록 편집">✎</button>
    </div>

    <label class="field-label">Note</label>
    <textarea id="di-note" class="di-note" placeholder="자유롭게 적어주세요 (자료 상세보기에 그대로 보입니다)"></textarea>

    <div class="edit-target" style="margin-top:12px;">
      <div class="kv-line"><span class="kv-label">소속공사</span><b>${esc(shortProjectLabel(item.project_name))}</b></div>
      <div class="kv-line"><span class="kv-label">공사연도</span><b>${item.year ?? "-"}</b></div>
    </div>

    <div class="modal-actions">
      <button type="button" id="di-cancel">취소</button>
      <button type="button" class="primary" id="di-save">저장</button>
    </div>`, "doc-info");
  document.getElementById("di-cancel").addEventListener("click", async () => {
    closeModal();
    await loadDocuments();
  });

  renderChips();
  const typeHint = "오른쪽 ✎ 버튼으로 추가하세요.";
  const equipDropdown = createTypeCheckDropdown("di-equip-dd", "equipment", item.equipment_type, { emptyHint: typeHint });
  const docTypeDropdown = createTypeCheckDropdown("di-doctype-dd", "doc", item.doc_type, { emptyHint: typeHint });
  const noteInput = document.getElementById("di-note");
  noteInput.value = item.note || "";

  const nameInput = document.getElementById("di-name");
  nameInput.value = item.name || "";  // 기존 이름에서 몇 글자만 고치는 경우가 대부분이라 미리 채운다
  setTimeout(() => { nameInput.focus(); nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length); }, 30);

  const newTagInput = document.getElementById("di-new-tag");
  const tagAddBtn = document.getElementById("di-tag-add");

  // 적은 그대로 저장한다(대문자로 자동으로 바꾸지 않음 — 2026-08-28 CM 확정).
  // 다만 대소문자만 다른 것은 같은 설비로 보고 중복으로 막는다(P1201C ↔ p1201c).
  function sameTagIndex(v, exceptIndex) {
    const key = v.toUpperCase();
    return tags.findIndex((t, i) => i !== exceptIndex && t.toUpperCase() === key);
  }

  // 입력칸이 "추가" 상태인지 "고치는 중"인지를 버튼 글자·안내문구로 알려준다.
  function updateTagInputMode() {
    const editing = editingIndex >= 0;
    tagAddBtn.textContent = editing ? "수정" : "입력";
    newTagInput.placeholder = editing
      ? "고친 뒤 Enter (Esc를 누르면 고치기 취소)"
      : "Tag No 입력 후 Enter (쉼표·슬래시로 여러 개, 예: TM1303A/B/C, MOV1351/1416/1417)";
  }

  function startEditTag(i) {
    editingIndex = i;
    newTagInput.value = tags[i];
    renderChips();
    updateTagInputMode();
    newTagInput.focus();
    newTagInput.select();
  }

  function cancelEditTag() {
    editingIndex = -1;
    newTagInput.value = "";
    renderChips();
    updateTagInputMode();
  }

  // 추가했거나 고쳤으면 true, 중복이라 하나도 못 넣었으면 false.
  // 쉼표로 여러 개를 한 번에 적으면(예: "TM1101, TM1102, T1103") 각각 나눠서 등록하고,
  // 슬래시가 있으면 그 안에서 한 번 더 나눈다(예: "TM1303A/B/C"·"MOV1351/1416/1417" → 각 3개).
  // 나누는 규칙은 두 화면이 똑같이 움직이도록 mdb-types.js의 expandSlashTag 한 곳에만 있다.
  // 고치는 중이었다면 맨 처음 값이 그 자리를 대신하고 나머지는 새로 추가된다.
  async function applyTagFromInput() {
    const parts = newTagInput.value.split(",").map((s) => s.trim()).filter(Boolean)
      .flatMap((s) => expandSlashTag(s));
    if (parts.length === 0) { cancelEditTag(); return true; }

    const startIndex = editingIndex;
    const seen = new Set();
    const toAdd = [];
    const dups = [];
    for (const v of parts) {
      const key = v.toUpperCase();
      if (seen.has(key) || sameTagIndex(v, startIndex) !== -1) { dups.push(v); continue; }
      seen.add(key);
      toAdd.push(v);
    }
    if (toAdd.length === 0) {
      await showAlert(`이미 들어있는 Tag No입니다: ${dups.join(", ")}`);
      return false;
    }

    const added = startIndex < 0;
    if (added) tags.push(...toAdd);
    else { tags[startIndex] = toAdd[0]; tags.push(...toAdd.slice(1)); }
    cancelEditTag();
    // Tag No가 많아 칸이 스크롤되는 상태에서는 방금 넣은 것이 맨 아래에 붙어 안 보이므로,
    // 추가했을 때는 칸을 맨 아래로 내려 들어간 것을 보여준다.
    if (added || toAdd.length > 1) {
      const chipArea = document.getElementById("di-chip-area");
      chipArea.scrollTop = chipArea.scrollHeight;
    }
    if (dups.length) await showAlert(`이미 들어있어 제외된 Tag No: ${dups.join(", ")}`);
    return true;
  }

  newTagInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editingIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      cancelEditTag();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    applyTagFromInput();
  });
  tagAddBtn.addEventListener("click", applyTagFromInput);
  updateTagInputMode();

  document.getElementById("di-equip-manage-btn")
    .addEventListener("click", () => openTypeListManager("equipment", equipDropdown));
  document.getElementById("di-doctype-manage-btn")
    .addEventListener("click", () => openTypeListManager("doc", docTypeDropdown));

  document.getElementById("di-save").addEventListener("click", async () => {
    // Enter를 안 누르고 바로 [저장]을 눌러도 입력칸에 적어둔 Tag No가 사라지지 않도록
    // 먼저 반영한다. 중복이라 못 넣으면 저장하지 않고 멈췐 고칠 기회를 준다.
    if (newTagInput.value.trim() && !(await applyTagFromInput())) return;
    // 기존 이름을 미리 채워 두므로, 안 고쳤으면 이름 변경 없음(null)으로 보낸다
    const typedName = nameInput.value.trim();
    const filename = typedName === String(item.name).trim() ? "" : typedName;
    const res = await fetch(`/mdb-editor/files/${d.id}/update-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: filename || null,
        // 여러 개를 고르면 "Pump/Strainer"처럼 슬래시로 이어진 문자열로 간다(하나도 없으면 null)
        equipment_type: equipDropdown.getValue() || null,
        doc_type: docTypeDropdown.getValue() || null,
        note: noteInput.value.trim() || null,
        tags,
      }),
    });
    if (!res.ok) {
      await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
      return;
    }
    const saved = await res.json();
    closeModal();
    await loadDocuments();
    // Tag No를 새로 달았고 그 Tag No에 "앞으로 자동 적용" 이력이 걸려 있으면 서버가 그 자리에서
    // 함께 넣는다 — 무엇이 들어갔는지 알려준다(2026-09-01 CM 확정, mdb-tag-history.js 공용).
    await showAutoAppliedAlert(saved);
  });
}

// "자료명·정보 변경"을 자료 여러 건에 함께 적용할 때 — 파일명·Tag No·Note는 자료마다 달라
// 일괄로 못 바꾸므로 흐리게 막고, 설비유형·자료유형만 골라 선택한 자료 전부에 같은 값을
// 적용한다 (2026-08-17 CM 확정, 2026-08-28 자료유형 추가).
async function editBulkTypes(ids) {
  await loadTypeLists();
  openModal(`
    <p class="modal-title">자료명·정보 변경</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">변경 대상</span><b>${ids.length}건 선택됨</b></div>
    </div>
    <p class="modal-hint-text">여러 건을 선택하면 설비유형·자료유형만 한 번에 바꿀 수 있습니다. 자료명·Tag No·Note는 자료마다 달라 1개씩 선택했을 때만 바꿀 수 있습니다.</p>

    <input type="text" id="di-name" placeholder="변경 이름" disabled />

    <label class="field-label">Tag No</label>
    <div class="mdb-chip-area" id="di-chip-area"></div>
    <input type="text" id="di-new-tag" placeholder="Tag No 추가 후 Enter" disabled />

    <label class="field-label">설비유형</label>
    <div class="di-equip-row">
      <div class="hideable-dropdown type-dropdown" id="di-equip-dd">
        <button type="button" class="dropdown-toggle"></button>
        <div class="dropdown-list hidden"></div>
      </div>
      <button type="button" class="small" id="di-equip-manage-btn" title="설비유형 목록 편집">✎</button>
    </div>

    <label class="field-label">자료유형</label>
    <div class="di-equip-row">
      <div class="hideable-dropdown type-dropdown" id="di-doctype-dd">
        <button type="button" class="dropdown-toggle"></button>
        <div class="dropdown-list hidden"></div>
      </div>
      <button type="button" class="small" id="di-doctype-manage-btn" title="자료유형 목록 편집">✎</button>
    </div>

    <label class="field-label">Note</label>
    <textarea id="di-note" class="di-note" placeholder="자료마다 달라 여러 건을 한 번에 바꿀 수 없습니다" disabled></textarea>

    <div class="modal-actions">
      <button type="button" id="di-cancel">취소</button>
      <button type="button" class="primary" id="di-save">저장</button>
    </div>`, "doc-info");

  document.getElementById("di-cancel").addEventListener("click", closeModal);
  const typeHint = "오른쪽 ✎ 버튼으로 추가하세요.";
  const equipDropdown = createTypeCheckDropdown("di-equip-dd", "equipment", "", { emptyHint: typeHint });
  const docTypeDropdown = createTypeCheckDropdown("di-doctype-dd", "doc", "", { emptyHint: typeHint });

  document.getElementById("di-equip-manage-btn")
    .addEventListener("click", () => openTypeListManager("equipment", equipDropdown));
  document.getElementById("di-doctype-manage-btn")
    .addEventListener("click", () => openTypeListManager("doc", docTypeDropdown));

  document.getElementById("di-save").addEventListener("click", async () => {
    const res = await fetch("/mdb-editor/files/update-equipment-type-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_ids: ids,
        equipment_type: equipDropdown.getValue() || null,
        doc_type: docTypeDropdown.getValue() || null,
      }),
    });
    if (!res.ok) {
      await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res)));
      return;
    }
    closeModal();
    await loadDocuments();
    await showAlert(`${ids.length}건의 설비유형·자료유형을 변경하였습니다.`);
  });
}

// ---------------------------------------------------------------------------
// Tag No·유형 미분류 관리 — 원래 MDB 조회 화면의 "확인필요 목록"이었던 기능을 이 팝업으로
// 옮겼다. 폴더 선택 여부와 무관하게 항상 열 수 있다(미분류 자료는 어느 폴더에나 있을 수 있어서).
// 표 구성·필터는 예전 확인필요 목록과 같고, 자료명을 누르면 그 자료의 상세보기가 팝업으로
// 떠서(openMdbDetailPopup) 거기서 Tag No·설비유형·자료유형을 고친다 — 고치고 팝업을 닫으면
// 목록에서 자동으로 빠진다(더 이상 미분류가 아니게 되므로). 그래서 표에 [편집] 버튼을 둔
// "조치" 칸은 없앴다(2026-08-30 CM 지시). TDB 관리 삭제 보관함(openTrash)과 같은 모달 뼈대(제목→상태줄→
// 표→닫기)를 그대로 따른다 — 그 사이에 다른 요소를 끼워 넣으면 레이아웃이 깨진다는 걸
// 먼저 겪어봐서, 페이지네이션("더 보기")도 넣지 않고 한 번에 넉넉히(500건) 받아온다.
// ---------------------------------------------------------------------------
const unclassifiedState = { items: [], total: 0 };

function unclassifiedQuery() {
  const params = new URLSearchParams();
  const q = document.getElementById("uc-q").value.trim();
  const category = document.getElementById("uc-category").value;
  const projectId = document.getElementById("uc-project").value;
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (projectId) params.set("project_id", projectId);
  params.set("page", 1);
  params.set("page_size", 500);
  return params.toString();
}

function unclassifiedRow(item, no) {
  const previewBtn = previewBtnHtml(item.pdf_file_id || null, item.has_original);
  // 자료명을 누르면 그 자료의 상세보기가 팝업으로 뜬다(아래 openMdbDetailPopup) — 분류·수정은
  // 거기서 한다. 다른 표의 자료명과 같은 모양(파란 글씨)이 되도록 <a>를 그대로 쓰되, 화면을
  // 옮기지 않고 팝업을 여는 링크라 주소는 비워둔다.
  return `
    <tr>
      <td class="col-no">${no}</td>
      <td>${previewBtn} <a href="#" data-detail="${item.id}">${esc(item.name)}</a></td>
      <td class="tc muted">${item.year ?? "-"}</td>
      <td class="muted">${esc(shortProjectLabel(item.project_name))}</td>
      <td class="muted">${esc(item.source_path)}</td>
      <td class="tc">${extCell(item, "dwg")}</td>
      <td class="tc">${extCell(item, "xlsx")}</td>
      <td class="tc">${extCell(item, "etc")}</td>
      <td class="tc">${extCell(item, "pdf")}</td>
    </tr>`;
}

async function loadUnclassified() {
  const data = await (await fetch(`/mdb/list?${unclassifiedQuery()}`)).json();
  unclassifiedState.total = data.total;
  unclassifiedState.items = data.items;

  const tbody = document.getElementById("uc-tbody");
  tbody.innerHTML = unclassifiedState.items.length
    ? unclassifiedState.items.map((item, i) => unclassifiedRow(item, i + 1)).join("")
    : '<tr><td colspan="9" class="empty">조건에 맞는 자료가 없습니다.</td></tr>';
  document.getElementById("uc-count").textContent =
    data.total > unclassifiedState.items.length
      ? `전체 ${data.total}건 중 ${unclassifiedState.items.length}건 표시 (검색으로 좁혀보세요)`
      : `전체 ${data.total}건`;

  wirePreviewButtons(tbody, unclassifiedState.items.map(toMdbPreviewItem));
  tbody.querySelectorAll("[data-detail]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const id = Number(link.dataset.detail);
      const item = unclassifiedState.items.find((it) => it.id === id);
      // 팝업을 닫을 때 목록을 다시 받는다 — Tag No나 설비유형을 채웠으면 더 이상 미분류가
      // 아니라 이 목록에서 빠져야 하기 때문이다.
      openMdbDetailPopup(id, item ? item.name : "", { onClose: loadUnclassified });
    });
  });
}

async function openUnclassifiedManager() {
  if (state.projects.length === 0) {
    const meta = await (await fetch("/mdb/meta")).json();
    state.projects = meta.projects;
  }
  const projectOptions = state.projects
    .map((p) => `<option value="${p.id}">${esc(shortProjectLabel(p.name))}</option>`).join("");

  openModal(`
    <h2 class="trash-modal-title">Tag No·유형 미분류 관리</h2>
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div class="field">
            <label for="uc-category">분류</label>
            <select id="uc-category">
              <option value="확인필요">확인필요</option>
              <option value="공용">공용</option>
              <option value="전용">전용</option>
              <option value="">전체</option>
            </select>
          </div>
          <div class="field">
            <label for="uc-project">공사</label>
            <select id="uc-project"><option value="">전체</option>${projectOptions}</select>
          </div>
          <input type="text" id="uc-q" class="filter-search" placeholder="자료명 / 경로" style="margin-left:auto;width:220px" />
          <button type="button" id="uc-search-btn" class="primary" style="width:66px;flex-shrink:0">검색</button>
        </div>
        <div class="filter-actions">
          <button type="button" id="uc-reset-btn">조건 초기화</button>
        </div>
      </div>
    </div>
    <div class="status-bar">
      <span id="uc-count"></span>
      <span class="cart-status">
        <button type="button" id="uc-export-btn" class="cart-btn">엑셀 내보내기</button>
      </span>
    </div>
    <div class="table-scroll">
      <table id="uc-table">
        <colgroup>
          <col style="width:54px" /><col /><col style="width:64px" /><col style="width:150px" />
          <col style="width:230px" /><col style="width:56px" />
          <col style="width:56px" /><col style="width:56px" /><col style="width:56px" />
        </colgroup>
        <thead>
          <tr>
            <th>No</th><th>자료명</th><th>연도</th><th>공사</th><th>경로</th>
            <th>DWG</th><th>XLSX</th><th>ETC</th><th>PDF</th>
          </tr>
        </thead>
        <tbody id="uc-tbody"></tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button type="button" data-close-modal>닫기</button>
    </div>`,
    "mdb-popup"
  );

  document.getElementById("uc-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadUnclassified();
  });
  document.getElementById("uc-search-btn").addEventListener("click", () => loadUnclassified());
  document.getElementById("uc-category").addEventListener("change", () => loadUnclassified());
  document.getElementById("uc-project").addEventListener("change", () => loadUnclassified());
  document.getElementById("uc-reset-btn").addEventListener("click", () => {
    document.getElementById("uc-q").value = "";
    document.getElementById("uc-category").value = "확인필요";
    document.getElementById("uc-project").value = "";
    loadUnclassified();
  });
  document.getElementById("uc-export-btn").addEventListener("click", () => {
    window.location.href = `/mdb/export?${unclassifiedQuery()}&columns=unclassified`;
  });

  await loadUnclassified();
  makeColumnsResizable(document.getElementById("uc-table"));
  makeSortable(document.getElementById("uc-table"));
}

// ---------------------------------------------------------------------------
// MDB 자료 상세보기 팝업 — 미분류 관리 표에서 자료명을 눌렀을 때 (2026-08-30 CM 지시)
//
// 미분류 자료를 정리하는 자리라, 표에서 자료를 고르면 그 자리에서 내용을 보고 Tag No·설비유형·
// 자료유형을 고칠 수 있어야 한다. 그래서 상세보기 화면(mdb-detail.html)을 **그대로** 팝업 안에
// 띄운다 — 비슷한 화면을 하나 더 만들지 않으므로, 나중에 상세보기 화면을 고치면 이 팝업도
// 똑같이 바뀐다. 화면 쪽은 주소에 embed=1이 붙으면 팝업에서 쓸 일이 없는 것(위쪽 메뉴,
// [목록으로], 이전/다음)을 감춘다.
//
// 미분류 관리 팝업을 지우지 않도록 레이어로 쌓고(뒤 팝업은 흐리게 — 전 화면 공통 규칙),
// 닫을 때 onClose로 목록을 다시 받는다.
// ---------------------------------------------------------------------------
function openMdbDetailPopup(fileId, name, { onClose = null } = {}) {
  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box preview-modal mdb-detail-modal">
        <div class="preview-modal-head">
          <div class="preview-modal-titlebox">
            <h2>MDB 자료 상세 보기</h2>
            <div class="preview-title-path" title="${esc(name)}">${esc(name)}</div>
          </div>
          <button type="button" data-close>닫기</button>
        </div>
        <div class="preview-frame-box">
          <iframe src="mdb-detail.html?id=${fileId}&embed=1"></iframe>
        </div>
      </div>
    </div>`);

  layer.querySelector("[data-close]").addEventListener("click", async () => {
    popDialogLayer(layer);
    if (onClose) await onClose();
  });
}

async function deleteDoc() {
  const ids = [...state.selectedDocIds];
  if (ids.length === 0) return;
  const docsOnPage = selectedDocsOnPage();
  const single = ids.length === 1 ? docsOnPage.find((d) => d.id === ids[0]) : null;
  const label = ids.length === 1
    ? esc(single?.name ?? "선택 자료 1건")
    : `선택 자료 ${ids.length}건`;
  // 원본과 사본은 한 자료라 함께 보관함으로 간다 — 파일이 둘 이상이면 그 사실을 알려준다.
  const filesNote = single && single.files && single.files.length > 1
    ? `<div class="kv-line"><span class="kv-label">딸린 파일</span><b>${esc(single.exts.join(", ").toUpperCase())} — 함께 삭제됩니다</b></div>`
    : "";
  // 보내는 곳이 둘이다 — 삭제(오류라 없어야 할 자료)와 폐기(그때는 맞았지만 최신본에서
  // 빠진 자료). TDB 관리와 같은 구성이다.
  openModal(`
    <p class="modal-title">자료 삭제</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">삭제 대상</span><b>${label}</b></div>
      ${filesNote}
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
      body: JSON.stringify({ file_ids: ids, reason: reason || null }),
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
    "/mdb-editor/files/archive-bulk",
    ids.length > 1 ? `자료 ${ids.length}건을 삭제하였습니다.` : "자료를 삭제하였습니다.",
  ));
  document.getElementById("dd-retire").addEventListener("click", () => send(
    "/mdb-editor/files/retire-bulk",
    ids.length > 1
      ? `자료 ${ids.length}건을 폐기 보관함으로 옮겼습니다.`
      : "자료를 폐기 보관함으로 옮겼습니다.",
  ));
}

// ---------------------------------------------------------------------------
// 폐기 보관함 — 팝업 자체는 ui.js(openRetiredPopup)에 있어 MDB 조회 화면과 같은 것을 쓴다.
// 이 화면은 "복구할 자리를 다시 고르는 팝업"만 맡는다 (TDB 관리와 같은 구성).
// ---------------------------------------------------------------------------
function openRetiredTrash() {
  return openRetiredPopup("mdb", {
    screen: "MDB 관리",
    canEdit: true,
    pickFolder: pickRestoreFolder,
    onChanged: async () => { await loadTree(); await loadDocuments(); },
  });
}

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

// 교체는 renderPanels가 정확히 1개를 선택했을 때만 버튼을 연결하므로 여기서도 그 전제를 그대로 쓴다.
async function replaceDoc() {
  if (state.selectedDocIds.size !== 1) return;
  const id = [...state.selectedDocIds][0];
  const d = state.lastItems.find((x) => x.id === id);
  if (!d) return;
  openModal(`
    <p class="modal-title">자료 교체</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">교체 대상</span><b>${esc(d.name)}</b></div>
      <div class="kv-line"><span class="kv-label">가진 형식</span><b>${esc((d.exts || []).join(", ").toUpperCase() || "-")}</b></div>
    </div>
    <p class="modal-hint-text">내용(파일)만 바뀌고 이름·Tag No·설비유형 등 다른 정보는 그대로 유지됩니다.
      올린 파일과 <b>형식이 같은 쪽</b>이 바뀝니다(엑셀을 올리면 엑셀만, PDF를 올리면 PDF만).
      이 자료에 없는 형식을 올리면 새로 붙습니다.</p>
    <input type="file" id="rep-file" />
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="rep-confirm">교체</button>
    </div>`);
  attachDropZone("rep-file", { multiple: false });

  document.getElementById("rep-confirm").addEventListener("click", async () => {
    const input = document.getElementById("rep-file");
    if (!input.files.length) { await showAlert("파일을 선택하세요."); return; }
    const fd = new FormData();
    fd.append("file", input.files[0]);
    const res = await fetch(`/mdb-editor/files/${d.id}/replace`, { method: "POST", body: fd });
    if (!res.ok) { await showAlert("교체할 수 없습니다: " + (await safeErrText(res))); return; }
    const data = await res.json();
    closeModal();
    await loadDocuments();
    await loadTree();
    await showAlert(data.message);
  });
}

// ---------------------------------------------------------------------------
// 위치 이동 — 폴더/자료 공용 폴더 선택 팝업 (TDB 관리와 같은 방식: 라디오로 최상위/위치선택)
// ---------------------------------------------------------------------------
function allFolderPaths() {
  return state.treeFolders.map((f) => f.path).sort(naturalCompare);
}

const tpValues = {};

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
  for (const f of state.treeFolders) if (f.path === path || f.path.startsWith(prefix)) sum += f.file_count;
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
  if (!isFolder && docIds.length === 0) return;
  if (isFolder && !(await confirmPairFolderEdit(state.selectedFolder, "폴더를 옮기면"))) return;
  const title = isFolder ? "폴더 위치 이동" : "자료 위치 이동";
  const path = isFolder ? state.selectedFolder.path : null;
  const singleDocName = !isFolder && docIds.length === 1
    ? state.lastItems.find((d) => d.id === docIds[0])?.name
    : null;
  const displayName = isFolder ? folderDisplayName(path) : (singleDocName ?? `자료 ${docIds.length}건`);
  const docCount = isFolder ? state.selectedFolder.docCount : null;
  const isPair = isFolder && state.selectedFolder.isPair;
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
    if (isFolder) await callReparent(path, newPath, false);
    else await callMoveDocuments(docIds, newPath);
  });
}

async function callMoveDocuments(docIds, newPath) {
  const res = await fetch(`/mdb-editor/files/move-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids: docIds, new_folder: newPath || "" }),
  });
  if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
  state.selectedDocIds.clear();
  await loadTree();
  await loadDocuments();
  await showAlert(docIds.length > 1 ? `자료 ${docIds.length}건의 위치를 이동하였습니다.` : "자료 위치를 옮겼습니다.");
}

// ---------------------------------------------------------------------------
// 신규 자료 등록 — MDB는 원본+PDF 세트 개념이 없어 파일 하나하나가 그대로 자료 1건이 된다.
// 등록 위치는 왼쪽 트리에서 지금 선택한 폴더를 그대로 쓴다(TDB 관리와 같은 규칙).
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
    <div class="modal-actions">
      <button type="button" data-close-modal>취소</button>
      <button type="button" class="primary" id="reg-confirm">등록</button>
    </div>`);
  attachDropZone("reg-files");

  document.getElementById("reg-confirm").addEventListener("click", async () => {
    const input = document.getElementById("reg-files");
    const files = [...input.files];
    if (!files.length) { await showAlert("파일을 선택하세요."); return; }

    let confirmDuplicates = false;
    while (true) {
      const fd = new FormData();
      fd.append("target_path", targetPath || "");
      files.forEach((f) => fd.append("files", f));
      fd.append("confirm_duplicates", confirmDuplicates ? "true" : "false");
      const res = await fetch("/mdb-editor/register", { method: "POST", body: fd });
      if (!res.ok) { await showAlert("등록할 수 없습니다: " + (await safeErrText(res))); return; }
      const data = await res.json();
      if (data.needs_confirmation) {
        const list = data.duplicates.map((d) => `${d.stem} (${d.exts.join(", ").toUpperCase()})`).join("\n");
        const ok = await showConfirm(`같은 이름·같은 형식의 파일이 2개 이상 선택되었습니다:\n${list}\n\n정상은 한 자료에 형식마다 1개씩입니다. 첨부한 파일을 다시 확인해주세요.\n\n그래도 이대로 계속 등록하시겠습니까?`);
        if (!ok) return;
        confirmDuplicates = true;
        continue;
      }
      closeModal();
      await loadTree();
      await loadDocuments();
      await showAlert(registerResultMessage(data));
      return;
    }
  });
}

// 등록 결과 안내문 — 새로 만든 자료 / 기존 자료에 채워 넣은 파일 / 이미 있어 건너뛴 것을 나눠 알린다.
// (같은 폴더에 같은 자료명이 이미 있으면 자료를 새로 만들지 않고 없는 형식만 붙인다 — 2026-08-17)
function registerResultMessage(data) {
  const parts = [`${data.created_files}건 등록되었습니다.`];
  if (data.attached_files) {
    parts.push(`기존 자료에 파일 ${data.attached_files}개를 채워 넣었습니다.`);
  }
  const skipped = data.skipped_existing || [];
  if (skipped.length) {
    const head = skipped.slice(0, 5).join(", ");
    const more = skipped.length > 5 ? ` 외 ${skipped.length - 5}건` : "";
    parts.push(`이미 있어 건너뛴 것: ${head}${more}`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Zip 폴더 업로드 — 넣을 위치는 왼쪽 트리에서 지금 선택한 폴더를 그대로 쓴다.
// ---------------------------------------------------------------------------
function currentZipTargetPath() {
  const s = state.selectedFolder;
  return s && s.kind === "folder" ? s.path : "";
}

document.getElementById("zip-submit").addEventListener("click", async () => {
  const targetPath = currentZipTargetPath();
  const fileInput = document.getElementById("zip-file");
  if (!fileInput.files.length) { await showAlert("Zip 파일을 선택하세요."); return; }
  const btn = document.getElementById("zip-submit");
  btn.disabled = true;
  try {
    let confirmDuplicates = false;
    while (true) {
      const fd = new FormData();
      fd.append("target_path", targetPath);
      fd.append("confirm_duplicates", confirmDuplicates ? "true" : "false");
      fd.append("zip_file", fileInput.files[0]);
      const res = await fetch("/mdb-editor/zip-register", { method: "POST", body: fd });
      if (!res.ok) { showResult("zip-result", "err", "처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
      const data = await res.json();
      if (data.needs_confirmation) {
        const list = data.duplicates
          .map((d) => `${d.folder ? d.folder + " / " : ""}${d.stem} (${d.exts.join(", ").toUpperCase()})`)
          .join("\n");
        const ok = await showConfirm(`같은 폴더에 같은 이름·같은 형식의 파일이 2개 이상 있습니다:\n${list}\n\n정상은 한 자료에 형식마다 1개씩입니다.\n\n그래도 계속 등록하시겠습니까?`);
        if (!ok) { showResult("zip-result", "warn", "등록을 취소했습니다."); return; }
        confirmDuplicates = true;
        continue;
      }
      showResult("zip-result", "ok", registerResultMessage(data));
      await loadTree();
      await loadDocuments();
      return;
    }
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// 삭제 보관함 — TDB 관리 삭제 보관함과 같은 명칭·구성·기능·표 템플릿
// ---------------------------------------------------------------------------
async function refreshTrashCount() {
  // 버튼 옆 괄호 숫자만 필요하므로 목록 전체가 아니라 건수만 받아온다(TDB 관리와 같은 방식).
  const res = await fetch("/mdb-editor/trash/count");
  if (!res.ok) return;
  const { count } = await res.json();
  document.getElementById("trash-count").textContent = count ? `(${count})` : "";
}

async function openTrash() {
  // 목록을 받는 동안 버튼이 아무 반응이 없으면 눌리지 않은 것으로 오해하므로 표시를 바꾼다
  // (TDB 관리 삭제 보관함과 같은 처리).
  const openBtn = document.getElementById("trash-open-btn");
  const openBtnHtml = openBtn.innerHTML;
  openBtn.disabled = true;
  openBtn.textContent = "불러오는 중…";
  let items;
  try {
    const res = await fetch("/mdb-editor/trash");
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
          <td>${it.kind === "MDB_FOLDER" ? "폴더" : "자료"}</td>
          <td>${esc(it.target_label)}</td>
          <td class="muted">${esc(it.original_path || "")}</td>
          <td class="tc" data-sort-value="${it.file_count}">${it.file_count}건</td>
          <td class="tc muted">${fmtDateTime(it.archived_at)}</td>
          <td class="tc" data-sort="off">
            <div class="trash-actions">
              <button class="small" type="button" data-restore="${it.batch_id}" ${(window.__tdmsPerms || new Set()).has("screen.mdb_editor.restore") ? "" : "disabled"}>복구</button>
              <a href="/mdb-editor/trash/${it.batch_id}/download"><button class="small" type="button">다운로드</button></a>
              <button class="small danger-line" type="button" data-purge="${it.batch_id}" ${canPurge ? "" : "disabled"}>완전 삭제</button>
            </div>
          </td>
          <td data-sort="off">${noteEditCellHtml(it.batch_id, it.reason)}</td>
        </tr>`).join("")
    : `<tr><td colspan="9" class="empty">삭제 보관함이 비어 있습니다.</td></tr>`;

  openModal(
    `<h2 class="trash-modal-title">MDB 삭제 보관함</h2>
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
    window.location = "/mdb-editor/trash/export";
  });

  const tbody = document.querySelector("#trash-table tbody");
  wireNoteEdits(tbody, (id) => `/mdb-editor/trash/${id}/note`, "common.note_edit.mdb_trash");

  const trashTable = document.getElementById("trash-table");
  // 키에 -v3을 붙인 이유: No 열이 생기면서 열 개수가 8 → 9로 바뀌었다(editor.js와 같은 이유).
  const trashColWidths = persistedColumnWidths(trashTable, "mdb-editor:trash-table-v3");
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
      const res2 = await fetch(`/mdb-editor/trash/${batchId}/restore`, { method: "POST" });
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

// 완전 삭제 확인 — TDB 관리 삭제 보관함(editor.js)과 같은 절차. 되돌릴 수 없는 작업이라는
// 경고를 한 번만 확인받는다(2026-08-17 CM 확정, 이후 CM 요청으로 문구 재입력 단계는 없앰 —
// 이 권한 자체가 관리자 전용이라 별도 단계가 필요 없다고 판단).
async function confirmPurge(batchCount, fileCount, extraWarning) {
  return showConfirm(
    `선택한 ${batchCount}건(자료 ${fileCount}건)을 완전히 삭제합니다.\n\n` +
    "· 파일이 디스크에서 실제로 지워져 저장 공간이 확보됩니다.\n" +
    "· 삭제 보관함에서 사라지고 다시는 되살릴 수 없습니다.\n" +
    extraWarning +
    "\n계속하시겠습니까?"
  );
}

async function purgeTrash(batchIds, items) {
  const targets = items.filter((it) => batchIds.includes(it.batch_id));
  const fileCount = targets.reduce((sum, it) => sum + it.file_count, 0);
  const ok = await confirmPurge(
    batchIds.length, fileCount,
    "· 지워지는 것은 시스템이 보관한 사본입니다. CM PC의 원본 MDB 폴더는 그대로 남습니다.\n"
  );
  if (!ok) return;

  const res = await fetch("/mdb-editor/trash/purge", {
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
    `자료 ${data.purged_files}건 · 파일 ${data.deleted_files}개\n` +
    `확보한 용량: ${formatFileSize(data.freed_bytes)}`
  );
  openTrash();
}

// ---------------------------------------------------------------------------
// Tag No 이력관리 — Tag No 변경이력 (2026-08-30 CM 확정, 이름은 2026-08-30 CM 지시로 고침)
//
// 설비 Tag No가 현장에서 바뀌면(P1000A 펌프가 P1700A로 바뀜) 그 설비 자료 수십 건에 새 번호를
// 함께 달아두고, 왜 Tag No가 두 개인지 Note에 남겨야 한다. 자료를 하나씩 찾아 고치는 것은
// 사실상 불가능해서, 여기 이력 한 줄을 등록하면 그 Tag No가 붙은 자료 전부에 같은 처리가
// 한 번에 들어간다. Note는 덮어쓰지 않고 한 줄씩 쌓여 그 자료의 변경 내력이 된다.
//
// 팝업은 세 겹으로 뜬다 — 이력 목록(modal-root) → 새 이력 등록 → 사유 목록 편집.
// 뒤 팝업을 지우지 않고 레이어로 쌓아 흐리게 두는 공통 규칙(ui.js pushDialogLayer)을 그대로 쓴다.
//
// 여기 있는 것은 **이력 목록 팝업**뿐이다. 등록·수정 팝업(openTagHistoryForm)은 MDB 자료
// 상세보기의 Note ✎도 같이 열기 때문에 mdb-tag-history.js로 나가 있다(2026-08-30) — 그 팝업을
// 고치면 두 화면에 똑같이 반영된다. 저장한 뒤 할 일만 afterTagHistorySaved로 넘겨준다.
// ---------------------------------------------------------------------------

// 팝업 제목. 엑셀 파일명이 이 제목을 따라가므로(서버 mdb_tag_history.py의 export가 같은 문구를
// 쓴다), 제목을 바꿀 때는 그쪽도 같이 고쳐야 파일명이 어긋나지 않는다.
const TAG_HISTORY_TITLE = "Tag No 이력관리";

const tagHistoryState = { items: [] };

// ---------------------------------------------------------------------------
// 이력 목록 팝업
// ---------------------------------------------------------------------------

function tagHistoryRow(item, no) {
  const reverted = item.status === "취소됨";
  const revertBtn = reverted
    ? ""
    : `<button type="button" class="small danger-line" data-revert="${item.id}">되돌리기</button>`;
  // "자동" 배지 — 앞으로 이 Tag No가 붙는 자료에도 자동으로 들어가는 이력 (2026-09-01 CM 확정).
  // 칸을 새로 만들지 않고 상태 칸에 함께 보여준다(엑셀 내보내기도 상태 칸에 같이 적는다).
  // 되돌린(취소됨) 이력은 켜져 있어도 발동하지 않으므로 흐리게 표시해 구분한다.
  const autoBadge = item.auto_apply
    ? `<div class="th-auto-badge${reverted ? " is-off" : ""}" title="${reverted
        ? "되돌린 이력이라 지금은 자동으로 들어가지 않습니다. [다시 적용]하면 다시 켜집니다."
        : "앞으로 이 Tag No가 붙는 자료에도 자동으로 들어갑니다"}">자동</div>`
    : "";
  return `
    <tr${reverted ? ' class="th-row-reverted"' : ""}>
      <td class="col-no">${no}</td>
      <td class="muted">${fmtDateTime(item.created_at)}</td>
      <td>${esc(item.action_label)}</td>
      <td><b>${esc(item.base_tag)}</b></td>
      <td>${esc(item.new_tag || "-")}</td>
      <td class="tc muted">${esc(item.note_year || "-")}</td>
      <td class="muted" title="${esc(item.note_project || "")}">${esc(item.note_project || "-")}</td>
      <td class="tc">${item.applied_doc_count}</td>
      <td class="muted" title="${esc(item.note_line || "")}">${esc(item.note_line || "-")}</td>
      <td class="tc"><div>${esc(item.status)}</div>${autoBadge}</td>
      <td class="tc">
        <button type="button" class="small" data-edit="${item.id}">수정</button>
        <button type="button" class="small" data-copy="${item.id}">복사</button>
        <button type="button" class="small" data-apply="${item.id}">다시 적용</button>
        ${revertBtn}
      </td>
    </tr>`;
}

// 검색 조건(연도·공사명·Note 문구)을 주소에 붙일 모양으로 만든다. 목록과 엑셀 내보내기가
// 같은 것을 쓰므로 화면에 보이는 결과와 받아보는 엑셀이 어긋나지 않는다(D-25).
// 팝업이 닫힌 뒤에 불려도 괜찮도록 칸이 없으면 빈 값으로 본다.
function tagHistoryQuery() {
  const val = (id) => (document.getElementById(id) || {}).value || "";
  const params = new URLSearchParams();
  const year = val("th-year");
  const noteProject = val("th-project-name");
  const q = val("th-q").trim();
  if (year) params.set("year", year);
  if (noteProject) params.set("note_project", noteProject);
  if (q) params.set("q", q);
  return params.toString();
}

// 검색줄의 연도·공사명 드롭다운 값을 채운다. 이 둘은 미리 정해둔 목록이 있는 값이 아니라
// 이력을 등록할 때 직접 적는 칸이므로, 실제로 적혀 있는 값만 서버에서 받아 보여준다.
// 목록을 그릴 때마다 다시 받는 이유는 새 이력을 등록하면 거기 적은 연도·공사명을 바로 고를 수
// 있어야 하기 때문이다. 고르고 있던 값은 목록에 없어졌더라도 그대로 남겨둔다 — 조용히
// 사라지면 검색 범위가 저 혼자 "전체"로 넓어진다.
async function fillTagHistoryFilters() {
  const meta = await (await fetch("/mdb-tag-history/meta")).json();
  const fill = (id, values) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const chosen = sel.value;
    const list = chosen && !values.includes(chosen) ? [chosen, ...values] : values;
    sel.innerHTML = '<option value="">전체</option>' +
      list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    sel.value = chosen;
  };
  fill("th-year", meta.years);
  fill("th-project-name", meta.note_projects);
}

async function loadTagHistories() {
  const query = tagHistoryQuery();
  const items = await (await fetch(`/mdb-tag-history?${query}`)).json();
  tagHistoryState.items = items;

  const tbody = document.getElementById("th-tbody");
  if (!tbody) return;  // 그 사이 팝업을 닫았으면 그릴 곳이 없다
  tbody.innerHTML = items.length
    ? items.map((item, i) => tagHistoryRow(item, i + 1)).join("")
    : (query
        ? '<tr><td colspan="11" class="empty">조건에 맞는 이력이 없습니다.</td></tr>'
        : '<tr><td colspan="11" class="empty">등록된 이력이 없습니다. [새 이력 등록]으로 만들어주세요.</td></tr>');
  document.getElementById("th-count").textContent =
    query ? `검색 결과 ${items.length}건` : `전체 ${items.length}건`;

  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => editTagHistory(Number(btn.dataset.edit)));
  });
  tbody.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => copyTagHistory(Number(btn.dataset.copy)));
  });
  tbody.querySelectorAll("[data-apply]").forEach((btn) => {
    btn.addEventListener("click", () => reapplyTagHistory(Number(btn.dataset.apply)));
  });
  tbody.querySelectorAll("[data-revert]").forEach((btn) => {
    btn.addEventListener("click", () => revertTagHistory(Number(btn.dataset.revert)));
  });

  await fillTagHistoryFilters();
}

// 이력을 등록·수정한 뒤 이 화면에서 할 일 — 이력 목록과 결과 표를 다시 그린다
// (자료의 Tag No·Note가 바뀌므로). 팝업 자체는 MDB 자료 상세보기와 같이 쓰는 공용 코드라
// (mdb-tag-history.js) 화면마다 다른 이 뒷정리만 넘겨준다.
async function afterTagHistorySaved() {
  await loadTagHistories();
  await loadDocuments();
}

function editTagHistory(id) {
  const item = tagHistoryState.items.find((it) => it.id === id);
  if (item) openTagHistoryForm(item, { onSaved: afterTagHistorySaved });
}

// [복사] — 그 이력의 값이 그대로 채워진 **새 이력 등록** 창을 연다 (2026-08-31 CM 지시).
// 비슷한 이력을 여러 번 남길 때 같은 값을 매번 다시 적는 것이 번거로워서 만든 것으로,
// 몇 칸만 고쳐 등록하면 된다. 원래 이력은 손대지 않고 새 이력이 하나 더 생긴다.
function copyTagHistory(id) {
  const item = tagHistoryState.items.find((it) => it.id === id);
  if (item) openTagHistoryForm(null, { copyFrom: item, onSaved: afterTagHistorySaved });
}

async function reapplyTagHistory(id) {
  const item = tagHistoryState.items.find((it) => it.id === id);
  if (!item) return;
  const ok = await showConfirm(
    `"${item.base_tag}" 이력을 다시 적용합니다.\n\n` +
    `지금 이 Tag No가 붙어 있는 자료 전부에 같은 처리가 들어갑니다.\n` +
    `이미 처리된 자료는 그대로 둡니다(같은 Tag No·같은 Note 줄은 늘어나지 않습니다).\n\n` +
    "계속하시겠습니까?"
  );
  if (!ok) return;
  const res = await fetch(`/mdb-tag-history/${id}/apply`, { method: "POST" });
  if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
  const data = await res.json();
  await showAlert(tagHistoryResultMessage(data, "적용"));
  await loadTagHistories();
  await loadDocuments();
}

async function revertTagHistory(id) {
  const item = tagHistoryState.items.find((it) => it.id === id);
  if (!item) return;
  const ok = await showConfirm(
    `"${item.base_tag}" 이력을 되돌립니다.\n\n` +
    `이 이력이 넣은 Tag No와 Note 문구를 도로 뺍니다.\n` +
    `직접 적어두신 다른 Note 줄과, 원래부터 붙어 있던 Tag No는 그대로 둡니다.\n\n` +
    "계속하시겠습니까?"
  );
  if (!ok) return;
  const res = await fetch(`/mdb-tag-history/${id}/revert`, { method: "POST" });
  if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
  const data = await res.json();
  await showAlert(tagHistoryResultMessage(data, "되돌리기"));
  await loadTagHistories();
  await loadDocuments();
}

async function openTagHistoryManager() {
  openModal(`
    <h2 class="trash-modal-title">${TAG_HISTORY_TITLE}</h2>
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-fields">
          <div class="field">
            <label for="th-year">연도</label>
            <select id="th-year"><option value="">전체</option></select>
          </div>
          <div class="field">
            <label for="th-project-name">공사명</label>
            <select id="th-project-name"><option value="">전체</option></select>
          </div>
          <input type="text" id="th-q" class="filter-search" placeholder="Note 문구"
                 style="margin-left:auto;width:220px" />
          <button type="button" id="th-search-btn" class="primary"
                  style="width:66px;flex-shrink:0">검색</button>
        </div>
        <div class="filter-actions">
          <button type="button" id="th-reset-btn">조건 초기화</button>
        </div>
      </div>
    </div>
    <div class="status-bar">
      <span id="th-count"></span>
      <span class="cart-status">
        <button type="button" id="th-new-btn" class="primary">새 이력 등록</button>
        <button type="button" id="th-export-btn" class="cart-btn">엑셀 내보내기</button>
      </span>
    </div>
    <div class="table-scroll">
      <table id="th-table">
        <colgroup>
          <col style="width:54px" /><col style="width:128px" /><col style="width:100px" />
          <col style="width:108px" /><col style="width:108px" /><col style="width:64px" />
          <col style="width:120px" /><col style="width:80px" /><col />
          <col style="width:62px" /><col style="width:284px" />
        </colgroup>
        <thead>
          <tr>
            <th data-sort="off">No</th><th>등록일</th><th>구분</th>
            <th>대상 Tag No</th><th>바뀐 Tag No</th><th>연도</th><th>공사명</th>
            <th>적용 자료</th><th>Note 문구</th><th>상태</th><th data-sort="off">조치</th>
          </tr>
        </thead>
        <tbody id="th-tbody"></tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button type="button" data-close-modal>닫기</button>
    </div>`,
    "mdb-popup-wide"
  );

  document.getElementById("th-new-btn").addEventListener("click", () =>
    openTagHistoryForm(null, { onSaved: afterTagHistorySaved }));
  document.getElementById("th-export-btn").addEventListener("click", () => {
    // 지금 화면에 보이는 검색 결과 그대로 내보낸다(D-25)
    window.location.href = `/mdb-tag-history/export?${tagHistoryQuery()}`;
  });

  // Note 문구 칸은 적어 넣은 뒤 [검색]을 눌러야 조회된다(Enter도 같은 동작 — CM 지시).
  // 드롭다운은 고르는 즉시 조회한다(Tag No·유형 미분류 관리 팝업과 같은 방식).
  document.getElementById("th-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadTagHistories();
  });
  document.getElementById("th-search-btn").addEventListener("click", () => loadTagHistories());
  document.getElementById("th-year").addEventListener("change", () => loadTagHistories());
  document.getElementById("th-project-name").addEventListener("change", () => loadTagHistories());
  document.getElementById("th-reset-btn").addEventListener("click", () => {
    document.getElementById("th-q").value = "";
    document.getElementById("th-year").value = "";
    document.getElementById("th-project-name").value = "";
    loadTagHistories();
  });

  await loadTagHistories();
  makeColumnsResizable(document.getElementById("th-table"));
  makeSortable(document.getElementById("th-table"));
}

// ---------------------------------------------------------------------------
// 모달
// ---------------------------------------------------------------------------
function openModal(html, size) {
  // size: "trash" → 삭제 보관함처럼 큰 모달, "mdb-popup" → Tag No·유형 미분류 관리처럼 필터+표가
  // 함께 들어가는 큰 모달(표 안에서만이 아니라 필요하면 팝업 전체가 스크롤된다),
  // "mdb-popup-wide" → 그것보다 조금 더 넓은 것(Tag No 이력관리 — 조치 칸에 버튼이 넷),
  // "doc-info" → 자료명·정보 변경(기본 폭의 1.5배 = 600px, 2026-08-28 CM 지시),
  // "mdb-pick" → Tag No 후보 선택(480px, MDB 조회의 같은 팝업과 폭을 맞춘다),
  // "wide" → 폭 640px, 그 외 기본 폭. (PDF 미리보기는 ui.js의 공용 팝업을 쓰므로 여기엔 없다.)
  const cls =
    size === "trash" ? "trash-modal" :
    size === "mdb-popup" ? "mdb-popup-box" :
    size === "mdb-popup-wide" ? "mdb-popup-box mdb-popup-wide-box" :
    size === "doc-info" ? "doc-info-box" :
    size === "mdb-pick" ? "mdb-pick-box" :
    size ? "wide" : "";
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
// 트리 폭 조절 — TDB 관리와 같은 방식
// ---------------------------------------------------------------------------
function setupTreeResize() {
  const layout = document.querySelector(".main-layout");
  const treePanel = document.querySelector(".main-layout .tree-panel");
  const handle = document.getElementById("tree-resize-handle");
  if (!layout || !treePanel || !handle) return;
  const MIN_WIDTH = 200;
  const MAX_WIDTH = 640;
  const STORAGE_KEY = "dms_mdb_editor_tree_width";

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
attachDropZone("zip-file", { multiple: false, hint: "여기로 zip 파일을 끌어다 놓으세요" });

const docColWidths = persistedColumnWidths(document.getElementById("doc-table"), "mdb-editor:doc-table-v2");

setupTreeResize();

// 표 헤더를 누르면 화면의 50건만이 아니라 조회 결과 전체가 정렬돼야 하므로(공통 규칙),
// 서버에 정렬 조건을 보내고 1페이지부터 다시 받아온다(TDB 관리 editor.js와 동일한 방식).
let showSortedColumn = () => {};

async function loadFilterMeta() {
  const meta = await (await fetch("/mdb/meta")).json();
  state.projects = meta.projects;
  const projSel = document.getElementById("project_id");
  projSel.innerHTML = '<option value="">전체</option>' +
    state.projects.map((p) => `<option value="${p.id}">${esc(shortProjectLabel(p.name))}</option>`).join("");

  await loadTypeLists();
  fillTypeFilterSelect("equipment");
  fillTypeFilterSelect("doc");
}

async function init() {
  await window.tdmsReady; // 권한(window.__tdmsPerms)에 따라 폴더·자료 편집 버튼을 다르게 그리므로 먼저 기다린다
  updateSearchTargetUI();
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
