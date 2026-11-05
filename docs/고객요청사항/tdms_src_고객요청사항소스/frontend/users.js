// 재직/퇴직/삭제 (2026-08-11 CM 결정) — "삭제"도 D-6에 따라 겉보기만 삭제고 실제로는
// 비활성화다. 화면엔 셋을 구분해 보여주되, 로그인 가능 여부(is_active)는 재직일 때만 true.
const EMPLOYMENT_STATUS_LABEL = {
  ACTIVE: { text: "재직", cls: "badge-success" },
  RETIRED: { text: "퇴직", cls: "badge-warning" },
  DELETED: { text: "삭제", cls: "badge-danger" },
};

let users = [];
let me = null;
let groups = [];

function openModal(html, extraClass) {
  document.getElementById("modal-root").innerHTML =
    `<div class="modal-overlay"><div class="modal-box${extraClass ? " " + extraClass : ""}">${html}</div></div>`;
}
function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

// 권한 드롭다운 항목 = 권한 관리 팝업에서 만든 그룹 그대로(2026-08-13 CM 확정 — "관리자"/
// "사용자" 두 개뿐이라 그 이상 만들지 않는다). "관리자"라는 이름의 그룹에 배정하면 실제
// 최고관리자 권한(role=ADMIN, 새로 생기는 화면·기능도 항상 자동으로 전부 열림)을 주고,
// 그 외 그룹은 전부 조회전용(role=VIEWER)에 해당 그룹의 권한 트리를 적용한다.
const ADMIN_GROUP_NAME = "관리자";

function roleField(id, selectedGroupId) {
  const options = groups
    .map((g) => `<option value="${g.id}" ${String(selectedGroupId) === String(g.id) ? "selected" : ""}>${escapeHtml(g.name)}</option>`)
    .join("");
  return `<select id="${id}">${options}</select>`;
}

// 사용자의 현재 role·group_id -> 드롭다운에 표시할 group_id.
// role=ADMIN인데 그룹이 없는(예전 데이터) 경우 "관리자" 그룹을 대신 보여준다.
function roleFieldValue(u) {
  if (u && u.group_id) return u.group_id;
  const adminGroup = groups.find((g) => g.name === ADMIN_GROUP_NAME);
  if (u && u.role === "ADMIN" && adminGroup) return adminGroup.id;
  return adminGroup ? adminGroup.id : groups[0]?.id;
}

// 신규 사용자 추가 시 기본값 — 관리자가 아닌 그룹(=최소 권한)을 우선 고른다.
function defaultNewUserGroupId() {
  const nonAdmin = groups.find((g) => g.name !== ADMIN_GROUP_NAME);
  return nonAdmin ? nonAdmin.id : groups[0]?.id;
}

// 권한 드롭다운 선택값(group_id) -> { role, group_id }
function parseRoleFieldValue(value) {
  const groupId = Number(value);
  const group = groups.find((g) => g.id === groupId);
  const role = group && group.name === ADMIN_GROUP_NAME ? "ADMIN" : "VIEWER";
  return { role, group_id: groupId };
}

// ---- 권한·상태 다중선택 드롭다운 필터 (전체 체크와 개별 항목은 서로 배타적) ----
const selectedRoles = new Set();
const selectedStatuses = new Set();

function renderRoleList() {
  const list = document.getElementById("role-list");
  const allChecked = selectedRoles.size === 0;
  list.innerHTML = [
    `<label class="dropdown-item dropdown-item-ms">
       <input type="checkbox" class="role-cb" value="ALL" ${allChecked ? "checked" : ""} />
       <span class="dropdown-item-label">전체</span>
     </label>`,
    ...groups.map(
      (g) => `
       <label class="dropdown-item dropdown-item-ms">
         <input type="checkbox" class="role-cb" value="${g.id}" ${selectedRoles.has(String(g.id)) ? "checked" : ""} />
         <span class="dropdown-item-label">${escapeHtml(g.name)}</span>
       </label>`
    ),
  ].join("");

  list.querySelectorAll(".role-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.value === "ALL") {
        if (cb.checked) selectedRoles.clear();
      } else {
        if (cb.checked) selectedRoles.add(String(cb.value));
        else selectedRoles.delete(String(cb.value));
      }
      renderRoleList();
      renderRoleToggle();
      render();
    });
  });
}

function renderRoleToggle() {
  const toggle = document.getElementById("role-toggle");
  if (selectedRoles.size === 0) {
    toggle.textContent = "전체";
  } else if (selectedRoles.size <= 2) {
    toggle.textContent = [...selectedRoles]
      .map((id) => groups.find((g) => String(g.id) === id)?.name)
      .filter(Boolean)
      .join(", ");
  } else {
    toggle.textContent = `${selectedRoles.size}개 선택`;
  }
}

function renderStatusList() {
  const list = document.getElementById("status-list");
  const allChecked = selectedStatuses.size === 0;
  list.innerHTML = [
    `<label class="dropdown-item dropdown-item-ms">
       <input type="checkbox" class="status-cb" value="ALL" ${allChecked ? "checked" : ""} />
       <span class="dropdown-item-label">전체</span>
     </label>`,
    ...Object.entries(EMPLOYMENT_STATUS_LABEL).map(
      ([code, item]) => `
       <label class="dropdown-item dropdown-item-ms">
         <input type="checkbox" class="status-cb" value="${code}" ${selectedStatuses.has(code) ? "checked" : ""} />
         <span class="dropdown-item-label">${item.text}</span>
       </label>`
    ),
  ].join("");

  list.querySelectorAll(".status-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.value === "ALL") {
        if (cb.checked) selectedStatuses.clear();
      } else {
        if (cb.checked) selectedStatuses.add(cb.value);
        else selectedStatuses.delete(cb.value);
      }
      renderStatusList();
      renderStatusToggle();
      render();
    });
  });
}

function renderStatusToggle() {
  const toggle = document.getElementById("status-toggle");
  if (selectedStatuses.size === 0) {
    toggle.textContent = "전체";
  } else if (selectedStatuses.size <= 2) {
    toggle.textContent = [...selectedStatuses].map((c) => EMPLOYMENT_STATUS_LABEL[c].text).join(", ");
  } else {
    toggle.textContent = `${selectedStatuses.size}개 선택`;
  }
}

document.getElementById("role-toggle").addEventListener("click", () => {
  document.getElementById("role-list").classList.toggle("hidden");
});
document.getElementById("status-toggle").addEventListener("click", () => {
  document.getElementById("status-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("role-dropdown").contains(e.target)) {
    document.getElementById("role-list").classList.add("hidden");
  }
  if (!document.getElementById("status-dropdown").contains(e.target)) {
    document.getElementById("status-list").classList.add("hidden");
  }
});

// ---------------------------------------------------------------------------
// 화면 이동 후 돌아와도 검색조건이 유지되도록 sessionStorage에 저장/복원 (TDB 조회와 같은 방식).
// 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다. 권한 드롭다운은 groups가 로딩된 뒤라야
// 항목이 있으므로, restoreState()는 init()에서 groups를 받은 다음에 부른다.
// ---------------------------------------------------------------------------
const STATE_KEY = "dms_users_state";

function saveState() {
  const snapshot = {
    q: document.getElementById("q").value,
    roles: [...selectedRoles],
    statuses: [...selectedStatuses],
  };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
}

// 저장된 값이 있으면 복원하고 true를, 없으면(첫 방문) 아무것도 안 하고 false를 돌려준다 —
// 없을 때는 init()이 기존처럼 "재직"만 기본으로 보여주는 처리를 그대로 하도록 하기 위함.
function restoreState() {
  const raw = sessionStorage.getItem(STATE_KEY);
  if (!raw) return false;
  try {
    const s = JSON.parse(raw);
    document.getElementById("q").value = s.q || "";
    selectedRoles.clear();
    (s.roles || []).forEach((v) => selectedRoles.add(v));
    selectedStatuses.clear();
    (s.statuses || []).forEach((v) => selectedStatuses.add(v));
    return true;
  } catch (e) {
    return false;
  }
}

function filteredUsers() {
  const q = document.getElementById("q").value.trim();
  return users.filter((u) => {
    if (selectedRoles.size > 0 && !selectedRoles.has(String(u.group_id))) return false;
    if (selectedStatuses.size > 0 && !selectedStatuses.has(u.employment_status)) return false;
    if (q && !u.name.includes(q)) return false;
    return true;
  });
}

function render() {
  saveState();
  const tbody = document.getElementById("users-tbody");
  const list = filteredUsers();
  tbody.innerHTML = list
    .map((u, i) => {
      const status = EMPLOYMENT_STATUS_LABEL[u.employment_status] || EMPLOYMENT_STATUS_LABEL.ACTIVE;
      return `
      <tr>
        <td class="col-no">${i + 1}</td>
        <td class="tc">${escapeHtml(u.username)}</td>
        <td class="tc">${escapeHtml(u.name)}</td>
        <td class="tc">${u.group_name ? escapeHtml(u.group_name) : '<span class="muted">미배정</span>'}</td>
        <td class="tc"><span class="badge ${status.cls}">${status.text}</span></td>
        <td class="tc muted">${fmtDateTime(u.created_at)}</td>
        <td class="tc muted">${fmtDateTime(u.updated_at)}</td>
        <td class="tc muted">${u.last_login_at ? fmtDateTime(u.last_login_at) : naCell()}</td>
        <td class="tc"><button type="button" class="small" data-edit="${u.id}">정보 수정</button></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(Number(btn.dataset.edit)));
  });
}

async function load() {
  users = await fetchJson("/users");
  render();
}

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

// ---- 사용자 추가·수정 팝업 — 마이페이지 팝업과 같은 디자인(제목·라벨·입력칸 배치)을 따른다 ----
function openAddModal() {
  openModal(`
    <p class="modal-title">사용자 추가</p>

    <label class="mypage-field-label" for="add-username">아이디</label>
    <input type="text" id="add-username" />

    <label class="mypage-field-label" for="add-name">이름</label>
    <input type="text" id="add-name" />

    <label class="mypage-field-label" for="add-role">권한</label>
    ${roleField("add-role", defaultNewUserGroupId())}

    <p class="page-desc" style="margin-top:14px">비밀번호는 자동으로 만들어집니다 (ghub+아이디).<br />본인이 첫 로그인 때 새 비밀번호를 정해야 화면을 쓸 수 있습니다.</p>

    <div class="modal-actions">
      <button type="button" id="add-cancel">취소</button>
      <button type="button" class="primary" id="add-save">추가</button>
    </div>`,
    "user-modal-box"
  );

  document.getElementById("add-cancel").addEventListener("click", closeModal);
  document.getElementById("add-save").addEventListener("click", async () => {
    const { role, group_id } = parseRoleFieldValue(document.getElementById("add-role").value);
    const body = {
      username: document.getElementById("add-username").value.trim(),
      name: document.getElementById("add-name").value.trim(),
      role,
    };
    if (!body.username || !body.name) {
      await showAlert("아이디·이름을 모두 입력해 주세요");
      return;
    }
    const created = await fetchJson("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (group_id) {
      await fetchJson(`/users/${created.id}/group`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id }),
      });
    }
    closeModal();
    await load();
    await showAlert(
      `계정이 추가됐습니다. 초기 비밀번호는 "ghub${body.username}" 입니다.
` +
        `이 비밀번호는 첫 로그인 한 번만 쓸 수 있고, 본인이 새 비밀번호를 정해야 다른 화면이 열립니다.`
    );
  });
}

function openEditModal(id) {
  const u = users.find((x) => x.id === id);
  if (!u) return;
  const isSelf = me && me.username === u.username;

  openModal(`
    <p class="modal-title">사용자 정보 수정</p>
    <div class="edit-target">
      <div class="kv-line"><span class="kv-label">아이디</span><b>${escapeHtml(u.username)}</b></div>
    </div>

    <label class="mypage-field-label" for="edit-name">이름</label>
    <input type="text" id="edit-name" value="${escapeHtml(u.name)}" />

    <label class="mypage-field-label" for="edit-role">권한</label>
    ${roleField("edit-role", roleFieldValue(u))}

    <p class="mypage-section-title">계정 상태</p>
    <div class="user-status-toggle" id="edit-status-toggle">
      ${Object.entries(EMPLOYMENT_STATUS_LABEL)
        .map(
          ([code, item]) => `
        <button type="button" class="user-status-btn ${u.employment_status === code ? "active" : ""}"
                data-status="${code}" ${isSelf && code !== "ACTIVE" ? "disabled" : ""}>${item.text}</button>`
        )
        .join("")}
    </div>

    <p class="mypage-section-title">비밀번호</p>
    <button type="button" class="reset-password-btn" id="edit-reset-password">비밀번호 초기화 (ghub${escapeHtml(u.username)}로 되돌리기)</button>

    <div class="modal-actions">
      <button type="button" id="edit-cancel">취소</button>
      <button type="button" class="primary" id="edit-save">저장</button>
    </div>`,
    "user-modal-box"
  );

  let selectedStatus = u.employment_status;
  document.getElementById("edit-status-toggle").querySelectorAll(".user-status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedStatus = btn.dataset.status;
      document.querySelectorAll("#edit-status-toggle .user-status-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  document.getElementById("edit-reset-password").addEventListener("click", async () => {
    const ok = await showConfirm(
      `비밀번호를 "ghub${u.username}"로 초기화할까요?
` +
        `초기화하면 본인이 첫 로그인 때 새 비밀번호를 정해야 다른 화면을 쓸 수 있습니다.`
    );
    if (!ok) return;
    await fetchJson(`/users/${u.id}/reset-password`, { method: "POST" });
    await showAlert(
      `비밀번호가 "ghub${u.username}"로 초기화됐습니다.
` +
        `본인이 첫 로그인 때 새 비밀번호를 정해야 다른 화면이 열립니다.`
    );
  });

  document.getElementById("edit-cancel").addEventListener("click", closeModal);
  document.getElementById("edit-save").addEventListener("click", async () => {
    const name = document.getElementById("edit-name").value.trim();
    if (!name) {
      await showAlert("이름을 입력해 주세요");
      return;
    }
    if (selectedStatus !== "ACTIVE") {
      const label = EMPLOYMENT_STATUS_LABEL[selectedStatus].text;
      const ok = await showConfirm(
        selectedStatus === "DELETED"
          ? `"${u.name}" 계정을 삭제할까요?\n(로그인만 막히고, 기존 반출·리비전 등 기록은 그대로 남습니다)`
          : `"${u.name}" 계정을 퇴직 처리할까요?\n(로그인만 막히고, 기존 기록은 그대로 남습니다)`
      );
      if (!ok) return;
    }
    const { role, group_id: newGroupId } = parseRoleFieldValue(document.getElementById("edit-role").value);
    await fetchJson(`/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        role,
        employment_status: selectedStatus,
      }),
    });
    if (newGroupId !== (u.group_id ?? null)) {
      await fetchJson(`/users/${u.id}/group`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: newGroupId }),
      });
    }
    closeModal();
    await load();
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- 권한 관리 팝업 (groups.html을 iframe으로 띄운다 — 내용이 많아 별도 화면 그대로 크게 연다) ----
function ensurePermModal() {
  let root = document.getElementById("perm-modal");
  if (root) return root;

  root = document.createElement("div");
  root.id = "perm-modal";
  root.className = "modal-overlay hidden";
  root.innerHTML = `
    <div class="modal-box perm-modal-box">
      <iframe id="perm-modal-frame" src="about:blank" title="권한 관리"></iframe>
    </div>`;
  document.body.appendChild(root);

  root.addEventListener("click", (e) => {
    if (e.target === root) closePermModal();
  });
  document.addEventListener("keydown", (e) => {
    if (!root.classList.contains("hidden") && e.key === "Escape") closePermModal();
  });
  // groups.html(embed 모드)의 "닫기" 버튼이 이 메시지를 보내면 팝업을 닫는다
  window.addEventListener("message", (e) => {
    if (e.data === "close-perm-modal") closePermModal();
  });

  return root;
}

function openPermModal() {
  const root = ensurePermModal();
  document.getElementById("perm-modal-frame").src = "groups.html?embed=1";
  root.classList.remove("hidden");
}

function closePermModal() {
  const root = document.getElementById("perm-modal");
  if (!root) return;
  root.classList.add("hidden");
  document.getElementById("perm-modal-frame").src = "about:blank";
  load(); // 그룹 이동 등으로 바뀐 사용자 정보를 다시 불러온다
}

document.getElementById("add-user-btn").addEventListener("click", openAddModal);
document.getElementById("perm-edit-btn").addEventListener("click", openPermModal);
document.getElementById("q").addEventListener("input", render);
document.getElementById("search-btn").addEventListener("click", render);
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") render();
});
document.getElementById("reset-btn").addEventListener("click", () => {
  selectedRoles.clear();
  selectedStatuses.clear();
  document.getElementById("q").value = "";
  renderRoleList();
  renderRoleToggle();
  renderStatusList();
  renderStatusToggle();
  render();
});

(async function init() {
  me = await fetch("/auth/me").then((r) => (r.ok ? r.json() : null));
  groups = await fetchJson("/groups");
  if (!restoreState()) {
    // 일괄등록 시스템 계정·테스트 계정처럼 이미 퇴직 처리된 계정이 기본 목록에 섞여 보이지
    // 않도록, 처음 열었을 때는 "재직"만 보이게 한다(2026-08-12 CM 요청). 상태 드롭다운에서
    // 언제든 "전체"·"퇴직"으로 바꿔 다시 볼 수 있다.
    selectedStatuses.add("ACTIVE");
  }
  renderRoleList();
  renderStatusList();
  renderStatusToggle();
  await load();
  makeColumnsResizable(document.getElementById("users-table"));
  makeSortable(document.getElementById("users-table"));
})();
