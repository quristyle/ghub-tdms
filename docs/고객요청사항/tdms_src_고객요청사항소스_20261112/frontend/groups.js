// 권한 관리 화면 — 그룹 CRUD + 소속 사용자 이동 + 권한 트리(Y/N, 상위→하위 적용)

let groups = [];
let totalUserCount = 0; // "전체 사용자" 가상 항목의 인원수 표시용
let selectedGroupId = null;
let permTree = [];
let leafKeysByNode = {}; // node.key -> [leaf key, ...] (자기 자신 포함, 리프면 [자기 key])
let allowedLeaves = new Set(); // 지금 선택된 그룹의 저장된 허용 leaf 키
let workingLeaves = new Set(); // 화면에서 편집 중인 상태(저장 전)
let dirty = false;
let collapsedKeys = new Set(); // 접힌 상위 노드 key (폴더트리처럼 접기/펼치기, 그룹 바꿔도 유지)
let membersRaw = []; // 현재 인원 패널에 표시 중인 목록 (정규화된 형태: id/username/name/group_id/group_name)
let membersMode = null; // "group" | "all"

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await showAlert(body.detail || "요청을 처리하지 못했습니다");
    throw new Error(body.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- 트리 평탄화: 노드 key -> 그 아래 leaf key 목록 ----
// 화면(최상위) 노드는 기본으로 접어둔다 — 화면이 9개나 되고 화면마다 세부 항목이 많아서,
// 펼쳐볼 화면만 눌러서 열어보는 폴더트리 방식이 한눈에 보기 편하다(CM 요청).
function indexTree(nodes, depth = 0) {
  for (const node of nodes) {
    if (node.children && node.children.length) {
      if (depth === 0) collapsedKeys.add(node.key);
      indexTree(node.children, depth + 1);
      leafKeysByNode[node.key] = node.children.flatMap((c) => leafKeysByNode[c.key]);
    } else {
      leafKeysByNode[node.key] = [node.key];
    }
  }
}

function nodeState(nodeKey) {
  const leaves = leafKeysByNode[nodeKey] || [];
  if (leaves.length === 0) return "N";
  const allowedCount = leaves.filter((k) => workingLeaves.has(k)).length;
  if (allowedCount === 0) return "N";
  if (allowedCount === leaves.length) return "Y";
  return "MIXED";
}

function setDirty(value) {
  dirty = value;
  document.getElementById("save-perm-btn").disabled = !value;
  document.getElementById("perm-dirty-note").classList.toggle("hidden", !value);
}

function applyNodeValue(nodeKey, value) {
  const leaves = leafKeysByNode[nodeKey] || [];
  leaves.forEach((k) => {
    if (value === "Y") workingLeaves.add(k);
    else workingLeaves.delete(k);
  });
  setDirty(true);
  renderTree();
}

// depth 0(화면)는 트리선 없이 그대로, depth 1부터 상하위를 보여주는 L자 안내선을 그린다.
// guides: 조상 노드들이 "마지막 형제였는지" 여부(앞쪽 depth부터 순서대로) — 마지막이 아니면
// 그 칸에 세로선이 계속 이어져야(형제가 더 있으니) 하고, 마지막이었으면 빈 칸으로 둔다.
function renderTreeNode(node, depth, guides, isLast) {
  const state = nodeState(node.key);
  const hasChildren = !!(node.children && node.children.length);
  const collapsed = hasChildren && collapsedKeys.has(node.key);
  const mixedDot = state === "MIXED" ? '<span class="perm-mixed-dot" title="일부만 허용됨"></span>' : "";

  const indent = depth > 0
    ? `<span class="perm-tree-indent">${guides
        .map((g) => `<span class="perm-guide${g ? " has-line" : ""}"></span>`)
        .join("")}<span class="perm-elbow${isLast ? " is-last" : ""}"></span></span>`
    : "";
  const toggle = hasChildren
    ? `<span class="perm-tree-toggle" data-toggle="${node.key}">${collapsed ? "▸" : "▾"}</span>`
    : `<span class="perm-tree-toggle"></span>`;

  const descHtml = node.desc
    ? `<span class="perm-tree-desc">${escapeHtml(node.desc)}</span>`
    : "";

  const html = [`
    <div class="perm-tree-node" data-depth="${depth}" data-key="${node.key}"${hasChildren ? ' data-has-children="true"' : ""}>
      ${indent}${toggle}
      <span class="perm-tree-label-wrap">
        <span class="perm-tree-label" title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</span>
        ${descHtml}
      </span>
      ${mixedDot}
      <div class="yn-toggle" data-key="${node.key}">
        <button type="button" class="yn-btn yn-y ${state === "Y" ? "active" : ""}" data-value="Y">Y</button>
        <button type="button" class="yn-btn yn-n ${state === "N" ? "active" : ""}" data-value="N">N</button>
      </div>
    </div>`];
  if (hasChildren && !collapsed) {
    const childGuides = depth > 0 ? [...guides, !isLast] : guides;
    html.push(
      ...node.children.map((c, i) => renderTreeNode(c, depth + 1, childGuides, i === node.children.length - 1))
    );
  }
  return html.join("");
}

function renderTree() {
  const box = document.getElementById("perm-tree");
  const title = document.getElementById("tree-title");
  const group = groups.find((g) => g.id === selectedGroupId);
  if (!group) {
    title.textContent = selectedGroupId === "ALL" ? "전체 인원" : "그룹을 선택하세요";
    box.innerHTML = selectedGroupId === "ALL"
      ? '<p class="page-desc">사용자를 그룹에서 선택하면 해당 그룹의 권한이 여기 보입니다.</p>'
      : "";
    return;
  }
  title.textContent = `${group.name} 그룹 권한`;
  box.innerHTML = permTree.map((n, i) => renderTreeNode(n, 0, [], i === permTree.length - 1)).join("");
  box.querySelectorAll(".yn-toggle").forEach((toggle) => {
    toggle.querySelectorAll(".yn-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        applyNodeValue(toggle.dataset.key, btn.dataset.value);
      });
    });
  });
  box.querySelectorAll('.perm-tree-node[data-has-children="true"]').forEach((row) => {
    row.addEventListener("click", () => toggleCollapse(row.dataset.key));
  });
}

function toggleCollapse(key) {
  if (collapsedKeys.has(key)) collapsedKeys.delete(key);
  else collapsedKeys.add(key);
  renderTree();
}

// ---- 그룹 목록 ----
// 맨 위 "전체 사용자"는 진짜 그룹이 아니라 화면 전용 가상 항목이다(id="ALL") — 그룹을 먼저
// 고르지 않아도 "사용자마다 지금 어느 그룹(권한)에 속해 있는지"를 한눈에 보고 그 자리에서
// 바로 다른 그룹으로 옮길 수 있게 해달라는 CM 요청(2026-08-12)으로 추가했다.
function renderGroupList() {
  const list = document.getElementById("group-list");
  const allRow = `
    <div class="perm-group-row perm-group-row-all ${selectedGroupId === "ALL" ? "selected" : ""}" data-group="ALL">
      <span class="perm-group-row-name">전체 인원</span>
      <span class="perm-group-row-count">${totalUserCount}명</span>
    </div>`;
  if (!groups.length) {
    list.innerHTML = allRow + '<div class="perm-empty-note">그룹이 없습니다. 아래에서 추가해 주세요.</div>';
  } else {
    list.innerHTML = allRow + groups
      .map(
        (g) => `
        <div class="perm-group-row ${g.id === selectedGroupId ? "selected" : ""}" data-group="${g.id}">
          <span class="perm-group-row-name">${escapeHtml(g.name)}</span>
          <span class="perm-group-row-count">${g.member_count}명</span>
          <button type="button" class="perm-group-row-edit" data-edit-group="${g.id}" title="그룹명 수정">✎</button>
        </div>`
      )
      .join("");
  }

  list.querySelectorAll("[data-group]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit-group]")) return;
      const raw = row.dataset.group;
      selectGroup(raw === "ALL" ? "ALL" : Number(raw));
    });
  });
  list.querySelectorAll("[data-edit-group]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.editGroup);
      const g = groups.find((x) => x.id === id);
      const name = await showPrompt("새 그룹명을 입력해 주세요.", g.name);
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed || trimmed === g.name) return;
      await fetchJson(`/groups/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      await loadGroups();
      if (id === selectedGroupId) {
        renderTree();
        await loadMembers();
      }
    });
  });
}

async function selectGroup(id) {
  if (dirty) {
    const proceed = await showConfirm("저장하지 않은 권한 변경사항이 있습니다. 저장하지 않고 다른 그룹으로 이동할까요?");
    if (!proceed) return;
  }
  selectedGroupId = id;
  renderGroupList();
  if (id === "ALL") {
    renderTree();
    await loadAllUsersPanel();
    return;
  }
  await loadGroupPermissions();
  await loadMembers();
}

async function loadGroups() {
  groups = await fetchJson("/groups");
  if (!groups.find((g) => g.id === selectedGroupId)) {
    selectedGroupId = groups.length ? groups[0].id : null;
  }
  renderGroupList();
}

// ---- 구성원 ----
async function loadMembers() {
  const title = document.getElementById("members-title");
  const group = groups.find((g) => g.id === selectedGroupId);
  if (!group) {
    title.textContent = "구성원";
    membersRaw = [];
    membersMode = null;
    renderMembersTable();
    return;
  }
  title.textContent = `${group.name} 그룹 인원 (${group.member_count}명)`;
  const members = await fetchJson(`/groups/${group.id}/members`);
  membersMode = "group";
  membersRaw = members.map((m) => ({
    id: m.id,
    username: m.username,
    name: m.name,
    group_id: group.id,
    group_name: group.name,
  }));
  renderMembersTable();
}

// 사용자 관리 화면(users.html)의 표와 같은 정렬 동작(makeSortable/sortTableRows, ui.js)을
// 그대로 쓴다 — 컬럼 글씨 클릭 정렬, 화살표 없이 색·굵기로만 표시하는 그 템플릿과 통일.
function renderMembersTable() {
  const tbody = document.getElementById("members-tbody");
  if (!membersRaw.length) {
    tbody.innerHTML = membersMode
      ? `<tr><td colspan="4" class="empty">${membersMode === "all" ? "등록된 사용자가 없습니다." : "이 그룹에 속한 사용자가 없습니다."}</td></tr>`
      : "";
    return;
  }

  tbody.innerHTML = membersRaw
    .map((m, i) => {
      const options = groups
        .map((g) => `<option value="${g.id}" ${g.id === m.group_id ? "selected" : ""}>${escapeHtml(g.name)}</option>`)
        .join("");
      return `
      <tr data-member="${m.id}">
        <td class="col-no">${i + 1}</td>
        <td>${escapeHtml(m.username)}</td>
        <td>${escapeHtml(m.name)}</td>
        <td data-sort-value="${escapeHtml(m.group_name || "")}">
          <select class="perm-member-move" data-move="${m.id}">${options}</select>
        </td>
      </tr>`;
    })
    .join("");

  wireMoveSelects(tbody, membersMode === "all" ? loadAllUsersPanel : loadMembers);
}

// ---- 전체 사용자(가상 항목) ----
// 일괄등록 같은 시스템 계정·퇴직자는 로그인 자체가 안 돼 그룹(권한) 배정이 의미 없으므로,
// 사용자 관리 화면의 기본 목록(재직만)과 맞춰 여기서도 재직 계정만 보여준다(2026-08-12 CM 요청).
async function refreshTotalUserCount() {
  const names = await fetchJson("/users/names");
  totalUserCount = names.filter((u) => u.is_active).length;
  renderGroupList();
}

async function loadAllUsersPanel() {
  const title = document.getElementById("members-title");
  const users = (await fetchJson("/users")).filter((u) => u.is_active);
  totalUserCount = users.length;
  title.textContent = `전체 인원 (${users.length}명)`;
  membersMode = "all";
  membersRaw = users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    group_id: u.group_id,
    group_name: u.group_name,
  }));
  renderMembersTable();
}

// 그룹 이동 select들의 공통 동작. afterMove는 이동 뒤 다시 그릴 함수(기본은 지금 그룹 구성원 갱신).
function wireMoveSelects(box, afterMove) {
  box.querySelectorAll("[data-move]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const userId = Number(sel.dataset.move);
      const groupId = Number(sel.value);
      await fetchJson(`/users/${userId}/group`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId }),
      });
      await loadGroups();
      await (afterMove || loadMembers)();
    });
  });
}

// ---- 권한 트리 ----
async function loadGroupPermissions() {
  if (!selectedGroupId) {
    allowedLeaves = new Set();
    workingLeaves = new Set();
    setDirty(false);
    renderTree();
    return;
  }
  const keys = await fetchJson(`/groups/${selectedGroupId}/permissions`);
  allowedLeaves = new Set(keys);
  workingLeaves = new Set(keys);
  setDirty(false);
  renderTree();
}

document.getElementById("save-perm-btn").addEventListener("click", async () => {
  if (!selectedGroupId) return;
  await fetchJson(`/groups/${selectedGroupId}/permissions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowed_keys: [...workingLeaves] }),
  });
  allowedLeaves = new Set(workingLeaves);
  setDirty(false);
  await showAlert("저장했습니다.");
});

document.getElementById("add-group-btn").addEventListener("click", async () => {
  const input = document.getElementById("new-group-name");
  const name = input.value.trim();
  if (!name) return;
  const g = await fetchJson("/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  input.value = "";
  await loadGroups();
  await selectGroup(g.id);
});

document.getElementById("back-to-users-btn").addEventListener("click", () => {
  // 팝업(iframe) 안이면 이 프레임을 users.html로 이동시키지 말고 부모 창에 닫아달라고 알린다.
  if (document.documentElement.classList.contains("embedded")) {
    window.parent.postMessage("close-perm-modal", "*");
    return;
  }
  window.location.href = "users.html";
});

// No 열을 뺀 나머지 폭을 아이디/이름/그룹 3개 열이 똑같이 나눠 갖게 한 뒤,
// 각 컬럼 구분선을 마우스로 드래그해 너비를 조절할 수 있게 한다.
function setupMembersTableColumns() {
  const table = document.getElementById("members-table");
  const cols = [...table.querySelectorAll("colgroup col")];
  const noWidth = parseFloat(cols[0].style.width) || 44;
  const tableWidth = table.getBoundingClientRect().width || 400;
  const eqWidth = Math.max(80, (tableWidth - noWidth) / 3);
  cols[1].style.width = eqWidth + "px";
  cols[2].style.width = eqWidth + "px";
  cols[3].style.width = eqWidth + "px";
  makeColumnsResizable(table);
}

(async function init() {
  makeSortable(document.getElementById("members-table"));
  setupMembersTableColumns();
  const tree = await fetchJson("/groups/permission-tree");
  permTree = tree;
  indexTree(permTree);
  await loadGroups();
  await refreshTotalUserCount();
  if (selectedGroupId) {
    await loadGroupPermissions();
    await loadMembers();
  } else {
    renderTree();
  }
})();
