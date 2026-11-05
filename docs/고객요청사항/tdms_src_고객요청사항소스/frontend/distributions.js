// searchIconSvg·previewBtnHtml·openDocPreview(이전/다음 포함)는 ui.js 공용 함수를 쓴다.

// 본인이 반출한 건이거나 screen.tdb_distributions.confirm.manual_return 권한이 있어야
// "수정없이 반납처리" 버튼을 보여준다(서버도 똑같이 막는다 — 여기는 화면 표시만 맞추는 것).
function canConfirmManualReturn(distributedById) {
  const perms = window.__tdmsPerms || new Set();
  if (perms.has("screen.tdb_distributions.confirm.manual_return")) return true;
  const me = window.__tdmsMe;
  return !!(me && distributedById === me.id);
}

// ---- 공사·업체 연동 드롭다운 ----
// 실제 수정용 반출 기록에 쓰인 (공사, 업체) 조합만 재료로 쓴다. 공사를 고르면 그 공사에
// 매칭된 업체만, 업체를 고르면 매칭된 공사만 나오게 서로 좁힌다. 직접 타이핑은 없다.
let filterPairs = [];

function fillSelect(sel, values) {
  const prev = sel.value;
  sel.innerHTML = '<option value="">전체</option>';
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  sel.value = values.includes(prev) ? prev : "";
}

function rebuildVendorOptions() {
  const proj = document.getElementById("project").value;
  const vendors = [
    ...new Set(filterPairs.filter((p) => !proj || p.project_name === proj).map((p) => p.vendor)),
  ].sort((a, b) => a.localeCompare(b, "ko"));
  fillSelect(document.getElementById("vendor"), vendors);
}

function rebuildProjectOptions() {
  const vend = document.getElementById("vendor").value;
  const projects = [
    ...new Set(
      filterPairs
        .filter((p) => !vend || p.vendor === vend)
        .map((p) => p.project_name)
        .filter((n) => n)
    ),
  ].sort((a, b) => a.localeCompare(b, "ko"));
  fillSelect(document.getElementById("project"), projects);
}

async function loadFilterOptions() {
  filterPairs = await (await fetch("/distributions/filter-options")).json();
  rebuildProjectOptions();
  rebuildVendorOptions();
}

// ---- 반출자(체크박스 다중선택) ----
// "전체"와 개별 사용자는 서로 배타적이다: 전체를 고르면 개별 선택이 다 풀리고, 개별을 하나라도
// 고르면 전체 선택은 자동으로 풀린다. selectedDistBy가 비어있는 상태 = "전체".
let allUsers = []; // [{id, name}] — 사용자 관리에 등록된 활성 사용자
const selectedDistBy = new Set();

function renderDistByList() {
  const list = document.getElementById("dist-by-list");
  const allChecked = selectedDistBy.size === 0;
  list.innerHTML = [
    `<label class="dropdown-item dropdown-item-ms">
       <input type="checkbox" class="dist-by-cb" value="ALL" ${allChecked ? "checked" : ""} />
       <span class="dropdown-item-label">전체</span>
     </label>`,
    ...allUsers.map(
      (u) => `
       <label class="dropdown-item dropdown-item-ms">
         <input type="checkbox" class="dist-by-cb" value="${u.id}" ${selectedDistBy.has(u.id) ? "checked" : ""} />
         <span class="dropdown-item-label">${escapeHtml(u.name)}</span>
       </label>`
    ),
  ].join("");

  list.querySelectorAll(".dist-by-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.value === "ALL") {
        if (cb.checked) selectedDistBy.clear();
        // 전체를 체크 해제해도 다른 게 하나도 안 골라졌으면 다시 전체로 되돌아간다
        // (아래 renderDistByList가 selectedDistBy.size===0 기준으로 다시 그리므로 자동 처리됨)
      } else {
        const id = Number(cb.value);
        if (cb.checked) selectedDistBy.add(id);
        else selectedDistBy.delete(id);
      }
      renderDistByList();
      renderDistByToggle();
      load();
    });
  });
}

function renderDistByToggle() {
  const toggle = document.getElementById("dist-by-toggle");
  if (selectedDistBy.size === 0) {
    toggle.textContent = "전체";
    return;
  }
  const names = allUsers.filter((u) => selectedDistBy.has(u.id)).map((u) => u.name);
  toggle.textContent = names.length <= 2 ? names.join(", ") : `${names[0]} 외 ${names.length - 1}명`;
}

async function loadUsers() {
  // /users는 screen.users.access 권한이 있어야 해서, 이름만 필요한 이 드롭다운은
  // 권한 없이도(로그인만 하면) 쓸 수 있는 /users/names를 쓴다.
  const res = await fetch("/users/names");
  if (!res.ok) return;
  allUsers = (await res.json()).filter((u) => u.is_active);

  // screen.tdb_distributions.viewer.other_user 권한이 없으면 본인 것만 조회 가능하다(서버도
  // distributed_by를 본인 id로 강제 고정한다) — 드롭다운도 본인 하나만 보이게 고정해둔다.
  const perms = window.__tdmsPerms || new Set();
  const me = window.__tdmsMe;
  if (!perms.has("screen.tdb_distributions.viewer.other_user") && me) {
    allUsers = allUsers.filter((u) => u.id === me.id);
    selectedDistBy.clear();
    selectedDistBy.add(me.id);
    document.getElementById("dist-by-toggle").disabled = true;
  }

  renderDistByList();
  renderDistByToggle();
}

document.getElementById("dist-by-toggle").addEventListener("click", () => {
  document.getElementById("dist-by-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("dist-by-dropdown").contains(e.target)) {
    document.getElementById("dist-by-list").classList.add("hidden");
  }
});

// 목적이 참조용/기타면 공사·업체는 애초에 대상이 없어도 되므로 드롭다운을 잠근다.
// 목적을 "전체"로 두면 수정용 건 조회를 위해 공사·업체를 계속 쓸 수 있어야 하므로 그대로 둔다.
function updatePurposeFieldStates() {
  const purpose = document.getElementById("purpose").value;
  const lock = purpose === "REFERENCE" || purpose === "OTHER";
  const projectSel = document.getElementById("project");
  const vendorSel = document.getElementById("vendor");
  if (lock) {
    projectSel.value = "";
    vendorSel.value = "";
  } else {
    rebuildProjectOptions();
    rebuildVendorOptions();
  }
  projectSel.disabled = lock;
  vendorSel.disabled = lock;
}

// 상태 드롭다운은 형태에 따라 선택지가 다르다.
//  - 자료: 검수대기 / 확인필요 / 반입완료 / 반입미완료 (개별 자료 상태)
//  - Zip : 반출 / 반입미완료 (Zip 단위 상태 — 하나라도 반입 안 됐으면 반입미완료)
const STATUS_OPTIONS_FILE = [
  ["", "전체"], ["REVIEWING", "검수대기"], ["ISSUE", "확인필요"],
  ["DONE", "반입완료"], ["INCOMPLETE", "반입미완료"],
];
const STATUS_OPTIONS_ZIP = [
  ["", "전체"], ["SHIPPED", "반출"], ["INCOMPLETE", "반입미완료"],
];

function rebuildStatusOptions(isZip) {
  const sel = document.getElementById("status");
  const options = isZip ? STATUS_OPTIONS_ZIP : STATUS_OPTIONS_FILE;
  sel.innerHTML = "";
  for (const [value, label] of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = "";
}

function updateExportKindFieldStates() {
  const isZip = document.getElementById("export-kind").value === "ZIP";
  rebuildStatusOptions(isZip);
  document.getElementById("q").placeholder = isZip ? "Zip 파일명 검색" : "자료명 검색";
}

function buildQuery() {
  const usp = new URLSearchParams();
  const set = (key, val) => {
    if (val) usp.set(key, val);
  };
  set("q", document.getElementById("q").value.trim());
  set("vendor", document.getElementById("vendor").value.trim());
  set("project", document.getElementById("project").value.trim());
  set("purpose", document.getElementById("purpose").value);
  set("status", document.getElementById("status").value);
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;
  if (from) usp.set("date_from", `${from}T00:00:00`);
  if (to) usp.set("date_to", `${to}T23:59:59`);
  for (const id of selectedDistBy) usp.append("distributed_by", id);
  return usp.toString();
}

// ---------------------------------------------------------------------------
// 화면 이동 후 돌아와도 검색조건이 유지되도록 sessionStorage에 저장/복원 (TDB 조회와 같은 방식).
// 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다. project/vendor/status는 서로 다른 옵션이
// 물려있는 드롭다운이라, restoreState()는 그 옵션들을 다시 채우는 함수(rebuildVendorOptions 등)를
// 값 설정 사이사이에 같이 불러 순서를 맞춘다.
// ---------------------------------------------------------------------------
const STATE_KEY = "dms_distributions_state";

function saveState() {
  const snapshot = {
    q: document.getElementById("q").value,
    exportKind: document.getElementById("export-kind").value,
    purpose: document.getElementById("purpose").value,
    project: document.getElementById("project").value,
    vendor: document.getElementById("vendor").value,
    status: document.getElementById("status").value,
    from: document.getElementById("from").value,
    to: document.getElementById("to").value,
    distBy: [...selectedDistBy],
  };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
}

// 저장된 값이 있으면 그 값으로, 없으면(첫 방문) 기본값으로 export-kind/purpose에 딸린
// status·project·vendor 옵션 목록을 채운다 — 항상 호출해야 하는 초기화라 raw 유무와 무관하게 끝까지 돈다.
function restoreState() {
  const raw = sessionStorage.getItem(STATE_KEY);
  let s = null;
  if (raw) {
    try {
      s = JSON.parse(raw);
    } catch (e) {
      s = null;
    }
  }
  document.getElementById("export-kind").value = (s && s.exportKind) || "FILE";
  updateExportKindFieldStates(); // status 옵션 목록을 export-kind 기준으로 다시 채움
  document.getElementById("status").value = (s && s.status) || "";
  document.getElementById("purpose").value = (s && s.purpose) || "";
  updatePurposeFieldStates(); // 참조용/기타면 project·vendor를 잠그고, 아니면 옵션을 다시 채움
  if (s && !document.getElementById("project").disabled) {
    document.getElementById("project").value = s.project || "";
    rebuildVendorOptions(); // 고른 공사에 맞게 업체 옵션을 좁힘
    document.getElementById("vendor").value = s.vendor || "";
    rebuildProjectOptions(); // 고른 업체에 맞게 공사 옵션을 좁히되, 지금 값은 유지
  }
  if (!s) return;
  document.getElementById("q").value = s.q || "";
  document.getElementById("from").value = s.from || "";
  document.getElementById("to").value = s.to || "";
  // 다른 사용자 조회 권한이 없으면 본인 것만 강제 고정돼 있으므로(loadUsers) 건드리지 않는다
  if (!document.getElementById("dist-by-toggle").disabled) {
    selectedDistBy.clear();
    (s.distBy || []).forEach((id) => selectedDistBy.add(id));
    renderDistByList();
    renderDistByToggle();
  }
}

// 개별 자료 상태(자료 모드 · Zip 현황 팝업 공용)
const MATERIAL_STATUS_LABEL = {
  INCOMPLETE: { text: "반입미완료", cls: "badge-warning" },
  ISSUE: { text: "확인필요", cls: "badge-danger" },
  REVIEWING: { text: "검수대기", cls: "badge-info" },
  DONE: { text: "반입완료", cls: "badge-success" },
};

function statusCell(code) {
  const item = MATERIAL_STATUS_LABEL[code];
  if (item) return `<span class="badge ${item.cls}">${item.text}</span>`;
  return '<span class="badge badge-neutral">반입대상 아님</span>';
}

function zipStatusCell(code) {
  if (code === "INCOMPLETE") return '<span class="badge badge-warning">반입미완료</span>';
  return '<span class="badge badge-neutral">반출</span>';
}

// 참조용·기타 반출은 업체를 특정하지 않아 서버가 "해당없음"으로 채운다 — 다른 결측값과
// 같은 모양(yn-n 점)으로 보이게 한다.
function vendorCell(vendor) {
  return vendor === "해당없음" ? naCell() : escapeHtml(vendor);
}

// ---- 자료 모드: 개별 반출 건의 '수정없이 반납처리' ----
async function returnDistribution(distributionId) {
  const ok = await showConfirm("이 건을 '수정 없이 반입 처리'하시겠습니까?\n(업체가 수정 없이 그대로 돌려준 경우에만 쓰세요)");
  if (!ok) return;

  const res = await fetch(`/distributions/${distributionId}/return`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    await showAlert("처리 중 오류가 발생했습니다.");
    return;
  }
  load();
}

// ---- 다건 선택 '선택 반납처리' ----
// 체크된 행 중 반입미완료가 아닌 것(=대상 아님)이 섞여 있으면 실행하지 않고 알림만 띄운다.
let currentRows = [];
const selectedDistKeys = new Set();

function rowKey(r) {
  return r.kind === "FILE" ? `f-${r.id}` : `z-${r.name}`;
}

function isReturnable(r) {
  if (r.kind === "FILE") return r.status === "INCOMPLETE" && canConfirmManualReturn(r.distributed_by);
  return r.status === "INCOMPLETE" && canConfirmManualReturn(r.distributed_by);
}

async function bulkReturn() {
  const rows = currentRows.filter((r) => selectedDistKeys.has(rowKey(r)));
  if (rows.length === 0) {
    await showAlert("선택된 항목이 없습니다.");
    return;
  }
  if (rows.some((r) => !isReturnable(r))) {
    await showAlert("선택한 항목 중 '수정없이 반납처리' 대상이 아닌 자료가 포함되어 있습니다.");
    return;
  }

  const ok = await showConfirm(
    `선택한 ${rows.length}건을 '수정 없이 반입 처리'하시겠습니까?\n(업체가 수정 없이 그대로 돌려준 경우에만 쓰세요)`
  );
  if (!ok) return;

  const zipNames = new Set();
  for (const r of rows) {
    if (r.kind === "FILE") {
      await fetch(`/distributions/${r.id}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } else if (!zipNames.has(r.name)) {
      zipNames.add(r.name);
      await fetch("/distributions/zip-return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zip_filename: r.name }),
      });
    }
  }
  selectedDistKeys.clear();
  load();
}

document.getElementById("bulk-return-btn").addEventListener("click", bulkReturn);
document.getElementById("dist-select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".dist-row-check").forEach((cb) => {
    cb.checked = e.target.checked;
    if (e.target.checked) selectedDistKeys.add(cb.dataset.key);
    else selectedDistKeys.delete(cb.dataset.key);
  });
});

// ---- Zip 모드: Zip 단위 '수정없이 반납처리' (섞이면 서버가 막고 사유를 준다) ----
async function returnZip(zipFilename) {
  const ok = await showConfirm(
    "이 Zip에 담긴 수정용 자료를 모두 '수정 없이 반입 처리'하시겠습니까?\n(업체가 수정 없이 그대로 돌려준 경우에만 쓰세요)"
  );
  if (!ok) return;

  const res = await fetch("/distributions/zip-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ zip_filename: zipFilename }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await showAlert(err?.detail || "처리 중 오류가 발생했습니다.");
    return;
  }
  load();
}

// openZipStatusPopup(Zip 현황 팝업)은 시스템 로그 화면과 공용이라 ui.js로 옮겼다.

// ---- 행 데이터 로딩 ----
// "자료" 모드: 반출된 개별 도면 한 건 = 한 행.
async function loadFileRows() {
  const rows = await (await fetch(`/distributions?${buildQuery()}`)).json();
  return rows.map((r) => ({
    kind: "FILE",
    id: r.id,
    document_id: r.document_id,
    name: r.display_name,
    source_path: r.source_path,
    current_pdf_file_id: r.current_pdf_file_id,
    project_name: r.project_name,
    vendor: r.vendor,
    purpose: r.purpose,
    purpose_note: r.purpose_note,
    rev_at_distribution: r.rev_at_distribution,
    distributed_at: r.distributed_at,
    distributed_by: r.distributed_by,
    distributed_by_name: r.distributed_by_name,
    returned_at: r.returned_at,
    status: r.status,
    return_note: r.return_note,
  }));
}

// "Zip" 모드: 반출하기 한 번에 생성된 zip 파일 하나 = 한 행. 반입 개념이 없는 칸은 공란.
async function loadZipRows() {
  const rows = await (await fetch(`/distributions/zip-exports?${buildQuery()}`)).json();
  return rows.map((r) => ({
    kind: "ZIP",
    name: r.zip_filename,
    project_name: r.project_name,
    vendor: r.vendor,
    purpose: r.purpose,
    purpose_note: r.purpose_note,
    distributed_at: r.distributed_at,
    distributed_by: r.distributed_by,
    distributed_by_name: r.distributed_by_name,
    status: r.status, // SHIPPED / INCOMPLETE
  }));
}

async function load() {
  saveState();
  const isZip = document.getElementById("export-kind").value === "ZIP";
  const rows = isZip ? await loadZipRows() : await loadFileRows();

  document.getElementById("total-count").textContent = `총 ${rows.length}건`;

  currentRows = rows;
  selectedDistKeys.clear();
  document.getElementById("dist-select-all").checked = false;

  const tbody = document.getElementById("dist-tbody");
  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">조회 결과가 없습니다.</td></tr>';
    return;
  }

  // 이 목록(자료 모드)의 순서를 상세보기 화면의 이전/다음 이동에 쓴다. 같은 자료가 여러 번
  // 반출됐으면 중복 없이 처음 나온 위치만 남긴다.
  if (rows[0].kind === "FILE") {
    saveDetailNavList([...new Set(rows.map((r) => r.document_id))]);
  }

  // ZIP 행은 미리보기 버튼 자체가 없으므로(위 렌더링 참고) FILE 행만 넣어야 버튼 순서와 맞는다.
  const previewList = rows
    .filter((r) => r.kind === "FILE")
    .map((r) => ({ id: r.id, drawingNo: r.name, path: r.source_path, pdfFileId: r.current_pdf_file_id, source: tdbSource(r.document_id) }));

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");

    if (r.kind === "FILE") {
      const outstanding = r.status === "INCOMPLETE" || r.status === "ISSUE";
      if (outstanding) tr.classList.add("warning-row");
      const canManualReturn = canConfirmManualReturn(r.distributed_by);
      const confirmCell =
        r.status === "INCOMPLETE"
          ? `<button class="small" data-return="${r.id}" ${canManualReturn ? "" : "disabled"}>수정없이 반납처리</button>`
          : "";
      const previewBtn = previewBtnHtml(r.current_pdf_file_id);
      tr.innerHTML = `
        <td class="col-no">${i + 1}</td>
        <td><input type="checkbox" class="dist-row-check" data-key="${escapeHtml(rowKey(r))}" /></td>
        <td>${previewBtn} <a href="detail.html?id=${r.document_id}&from=distributions">${escapeHtml(r.name)}</a></td>
        <td>${textOrNa(r.project_name)}</td>
        <td>${vendorCell(r.vendor)}</td>
        <td class="tc">${purposeBadge(r.purpose, r.purpose_note)}</td>
        <td class="tc">${r.rev_at_distribution}</td>
        <td class="muted tc">${fmtDateTime(r.distributed_at)}</td>
        <td class="muted tc">${fmtDateTime(r.returned_at)}</td>
        <td class="tc">${statusCell(r.status)}</td>
        <td class="tc" data-sort-value="${r.status === "INCOMPLETE" ? 1 : 0}">${confirmCell}</td>
        <td class="muted">${escapeHtml(r.distributed_by_name ?? "")}</td>
        <td class="muted">${escapeHtml(r.return_note ?? "")}</td>
      `;
    } else {
      const outstanding = r.status === "INCOMPLETE";
      if (outstanding) tr.classList.add("warning-row");
      const zipName = escapeHtml(r.name);
      const canManualReturn = canConfirmManualReturn(r.distributed_by);
      const confirmCell = `
        <button class="small" data-zip-download="${zipName}">Zip 다운</button>
        <button class="small" data-zip-status="${zipName}">상세 현황</button>
        ${outstanding ? `<button class="small" data-zip-return="${zipName}" ${canManualReturn ? "" : "disabled"}>수정없이 반납처리</button>` : ""}`;
      tr.innerHTML = `
        <td class="col-no">${i + 1}</td>
        <td><input type="checkbox" class="dist-row-check" data-key="${escapeHtml(rowKey(r))}" /></td>
        <td>${zipName}</td>
        <td>${textOrNa(r.project_name)}</td>
        <td>${vendorCell(r.vendor)}</td>
        <td class="tc">${purposeBadge(r.purpose, r.purpose_note)}</td>
        <td class="tc"></td>
        <td class="muted tc">${fmtDateTime(r.distributed_at)}</td>
        <td></td>
        <td class="tc">${zipStatusCell(r.status)}</td>
        <td class="tc" data-sort-value="${outstanding ? 1 : 0}">${confirmCell}</td>
        <td class="muted">${escapeHtml(r.distributed_by_name ?? "")}</td>
        <td></td>
      `;
    }
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".dist-row-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      if (e.target.checked) selectedDistKeys.add(cb.dataset.key);
      else selectedDistKeys.delete(cb.dataset.key);
      document.getElementById("dist-select-all").checked =
        [...tbody.querySelectorAll(".dist-row-check")].every((x) => x.checked);
    });
  });

  wirePreviewButtons(tbody, previewList);
  tbody.querySelectorAll("[data-return]").forEach((btn) => {
    btn.addEventListener("click", () => returnDistribution(Number(btn.dataset.return)));
  });
  wireZipButtons(tbody, "distributions");
  tbody.querySelectorAll("[data-zip-return]").forEach((btn) => {
    btn.addEventListener("click", () => returnZip(btn.dataset.zipReturn));
  });
}

// ---- 이벤트 연결 ----
document.getElementById("search-btn").addEventListener("click", load);
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") load();
});

document.getElementById("project").addEventListener("change", () => {
  rebuildVendorOptions();
  load();
});
document.getElementById("vendor").addEventListener("change", () => {
  rebuildProjectOptions();
  load();
});
document.getElementById("purpose").addEventListener("change", () => {
  updatePurposeFieldStates();
  load();
});
document.getElementById("status").addEventListener("change", load);
document.getElementById("export-kind").addEventListener("change", () => {
  updateExportKindFieldStates();
  load();
});

document.getElementById("reset-btn").addEventListener("click", () => {
  ["q", "from", "to"].forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("purpose").value = "";
  document.getElementById("export-kind").value = "FILE";
  document.getElementById("project").value = "";
  document.getElementById("vendor").value = "";
  selectedDistBy.clear();
  renderDistByList();
  renderDistByToggle();
  updatePurposeFieldStates();
  updateExportKindFieldStates();
  rebuildProjectOptions();
  rebuildVendorOptions();
  load();
  distColWidths.reset();
});

// 지금 조회한 결과를 그대로 엑셀로 내보낸다(자료 모드는 '반출목록', Zip 모드는 zip 파일 목록).
document.getElementById("export-btn").addEventListener("click", () => {
  const isZip = document.getElementById("export-kind").value === "ZIP";
  const path = isZip ? "/distributions/zip-exports/export" : "/distributions/export";
  window.location.href = `${path}?${buildQuery()}`;
});

// 표 헤더 너비 유지(화면전환에도 유지, 새로고침·초기화는 디폴트로)
const distColWidths = persistedColumnWidths(document.getElementById("dist-table"), "distributions:dist-table:v4");

async function init() {
  await window.tdmsReady; // 권한(window.__tdmsPerms)에 따라 목록·버튼을 다르게 그리므로 먼저 기다린다
  await Promise.all([loadFilterOptions(), loadUsers()]);
  restoreState(); // 저장된 조건이 있으면 그 값으로, 없으면 기본값으로 옵션 목록까지 다 채워준다
  await load();
  distColWidths.restore();
  makeColumnsResizable(document.getElementById("dist-table"), distColWidths.save);
  makeSortable(document.getElementById("dist-table"));
}

init();
