// 반입 · 검수 화면.
//  - 반입 등록: [반입 Zip] (반출목록.xlsx+폴더구조 zip) / [반입 자료] (zip 없이, 자료검색으로 대상 선택 후 업로드)
//  - 기존 수정본/신규 등록은 "폴더·자료 편집" 화면으로 이관되어 여기서는 뺐음(2026-07-22)
//  - 검수 대기 / 확인 필요 목록, 자료검색·경로재선택 공용 팝업

const importState = {
  outstanding: [],            // 반입 미완료 목록 (반입 자료 공사·업체 드롭다운 구성용)
  selPair: { vendor: null, projectId: null, projectName: null },
  selectedDists: [],          // 반입 자료: 자료검색에서 체크한 반출 건 [{distribution_id, drawing_no}]
};

// 검수대기·확인필요 원본 목록(필터 적용 전). 검색조건(구분·공사·업체·기간·자료명)은
// 이미 한 번에 다 불러온 이 목록을 화면에서만 걸러 보여준다(재조회 없음).
let reviewGroupsRaw = [];
let renderedReviewGroups = [];  // 지금 화면에 그려진(필터 통과한) 검수대기 행 — 일괄 승인/반려 대상 조회용

const REASON_LABELS = {
  FILENAME_MISMATCH: { text: "자료명 불일치", cls: "badge-danger" },
  PATH_MISMATCH: { text: "경로 불일치", cls: "badge-danger" },
  ORIGINAL_MISSING: { text: "원본 누락", cls: "badge-danger" },
  PDF_MISSING: { text: "사본 누락", cls: "badge-danger" },
  ALREADY_IMPORTED: { text: "기 반입 완료", cls: "badge-success" },
  NOT_DISTRIBUTED: { text: "반출 대상 아님", cls: "badge-warning" },
  DUPLICATE_FILE: { text: "같은 형식 파일 중복", cls: "badge-danger" },
  REV_MISMATCH: { text: "표기 불일치", cls: "badge-warning" },
  REV_TAG_MISSING: { text: "리비전 표기 없음", cls: "badge-warning" },
  REV_TAG_MALFORMED: { text: "리비전 표기 형식 오류", cls: "badge-warning" },
};

function reasonBadges(codes) {
  return codes
    .map((c) => {
      const r = REASON_LABELS[c] || { text: c, cls: "badge-neutral" };
      return `<span class="badge ${r.cls}">${escapeHtml(r.text)}</span>`;
    })
    .join(" ");
}

function extsLabel(list) {
  return list && list.length ? escapeHtml(list.join(", ")) : naCell();
}

function show(id) {
  document.getElementById(id).classList.remove("hidden");
}

function showResult(boxId, cls, text) {
  const box = document.getElementById(boxId);
  box.className = `result-box ${cls}`;
  box.textContent = text;
}

// ===========================================================================
// 자료검색 / 경로 재선택 공용 팝업
// ===========================================================================
const pickerState = {
  mode: "MULTI", vendor: null, projectId: null,
  items: [], view: "ALL", checked: new Set(), onConfirm: null,
};

const PICKER_STATUS = {
  INCOMPLETE: { text: "반입미완료", cls: "badge-warning" },
  REVIEWING: { text: "검수대기", cls: "badge-info" },
  DONE: { text: "반입완료", cls: "badge-success" },
};

function pickerStatusBadge(s) {
  const m = PICKER_STATUS[s] || { text: s, cls: "badge-neutral" };
  return `<span class="badge ${m.cls}">${escapeHtml(m.text)}</span>`;
}

async function openPicker({ vendor, projectId, mode, title, sub, dateFrom, dateTo, onConfirm }) {
  Object.assign(pickerState, {
    mode, vendor, projectId, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null, view: "ALL", checked: new Set(), onConfirm,
  });
  document.getElementById("picker-title").textContent = title || "업체별 반출·반입자료 현황";
  document.getElementById("picker-sub").textContent = sub || "";
  document.querySelectorAll(".picker-tab-group button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === "ALL")
  );
  const url = `/distributions/for-import?vendor=${encodeURIComponent(vendor)}${
    projectId ? `&project_id=${projectId}` : ""
  }${dateFrom ? `&date_from=${encodeURIComponent(dateFrom)}` : ""}${
    dateTo ? `&date_to=${encodeURIComponent(dateTo)}` : ""
  }`;
  pickerState.items = await (await fetch(url)).json();
  renderPicker();
  updatePickerCount();
  document.getElementById("picker-modal").classList.remove("hidden");
}

function pickerFiltered() {
  if (pickerState.view === "ALL") return pickerState.items;
  return pickerState.items.filter((it) => it.status === pickerState.view);
}

function updatePickerSelectAll(items) {
  const headerCb = document.getElementById("picker-select-all");
  if (pickerState.mode === "SINGLE") {
    headerCb.classList.add("hidden");
    return;
  }
  headerCb.classList.remove("hidden");
  const checkable = items.filter((it) => it.status === "INCOMPLETE");
  headerCb.disabled = checkable.length === 0;
  headerCb.checked = checkable.length > 0 && checkable.every((it) => pickerState.checked.has(it.distribution_id));
}

function renderPicker() {
  const tbody = document.getElementById("picker-tbody");
  const items = pickerFiltered();
  tbody.innerHTML = "";
  if (!items.length) {
    updatePickerSelectAll(items);
    tbody.innerHTML = '<tr><td colspan="11" class="empty">해당 자료가 없습니다.</td></tr>';
    return;
  }
  items.forEach((it, i) => {
    const checkable = it.status === "INCOMPLETE";
    const checked = pickerState.checked.has(it.distribution_id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td class="tc"><input type="checkbox" data-did="${it.distribution_id}" ${checked ? "checked" : ""} ${checkable ? "" : "disabled"} /></td>
      <td>${escapeHtml(it.display_name)}</td>
      <td>${textOrNa(it.category)}</td>
      <td class="muted">${textOrNa(it.source_path)}</td>
      <td class="tc">${it.rev_at_distribution}</td>
      <td class="tc">${yn(it.has_dwg)}</td>
      <td class="tc">${yn(it.has_xlsx)}</td>
      <td class="tc">${yn(it.has_etc)}</td>
      <td class="tc">${yn(it.has_pdf)}</td>
      <td class="tc">${pickerStatusBadge(it.status)}</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const did = Number(cb.dataset.did);
      if (pickerState.mode === "SINGLE") {
        pickerState.checked = new Set();
        if (cb.checked) pickerState.checked.add(did);
        renderPicker();
      } else if (cb.checked) {
        pickerState.checked.add(did);
      } else {
        pickerState.checked.delete(did);
      }
      updatePickerCount();
      updatePickerSelectAll(items);
    });
  });
  updatePickerSelectAll(items);
}

// 경로 재선택(SINGLE)은 어차피 하나만 고르므로 건수를 보여줄 필요가 없다.
function updatePickerCount() {
  const el = document.getElementById("picker-count");
  el.classList.toggle("hidden", pickerState.mode === "SINGLE");
  el.textContent = `선택 ${pickerState.checked.size}건`;
}

document.getElementById("picker-select-all").addEventListener("change", (e) => {
  const checkable = pickerFiltered().filter((it) => it.status === "INCOMPLETE");
  for (const it of checkable) {
    if (e.target.checked) pickerState.checked.add(it.distribution_id);
    else pickerState.checked.delete(it.distribution_id);
  }
  renderPicker();
  updatePickerCount();
});

document.querySelectorAll(".picker-tab-group button").forEach((b) =>
  b.addEventListener("click", () => {
    pickerState.view = b.dataset.view;
    document.querySelectorAll(".picker-tab-group button").forEach((x) =>
      x.classList.toggle("active", x === b)
    );
    renderPicker();
  })
);
document.getElementById("picker-close").addEventListener("click", () =>
  document.getElementById("picker-modal").classList.add("hidden")
);
document.getElementById("picker-export-btn").addEventListener("click", () => {
  // 지금 화면에 보이는 것(업체·공사·기간·상태탭) 그대로 내보낸다
  window.location = `/distributions/for-import/export?vendor=${encodeURIComponent(pickerState.vendor)}${
    pickerState.projectId ? `&project_id=${pickerState.projectId}` : ""
  }${pickerState.dateFrom ? `&date_from=${encodeURIComponent(pickerState.dateFrom)}` : ""}${
    pickerState.dateTo ? `&date_to=${encodeURIComponent(pickerState.dateTo)}` : ""
  }&status=${pickerState.view}`;
});
document.getElementById("picker-confirm").addEventListener("click", () => {
  const selected = pickerState.items.filter((it) => pickerState.checked.has(it.distribution_id));
  document.getElementById("picker-modal").classList.add("hidden");
  if (pickerState.onConfirm) pickerState.onConfirm(selected);
});

// ===========================================================================
// 반입 Zip
// ===========================================================================
document.getElementById("zip-submit").addEventListener("click", async () => {
  const fi = document.getElementById("zip-file");
  if (!fi.files.length) {
    showResult("zip-result", "err", "반입 zip 파일을 선택해주세요.");
    show("zip-result");
    return;
  }
  const fd = new FormData();
  fd.append("zip_file", fi.files[0]);
  showResult("zip-result", "ok", "업로드 중... (파일이 많으면 시간이 걸립니다)");
  show("zip-result");

  const res = await fetch("/documents/revisions/bulk", { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json();
    showResult("zip-result", "err", err.detail || "업로드 실패");
    return;
  }
  const data = await res.json();
  showResult("zip-result", data.issues.length ? "warn" : "ok", data.message);
  fi.value = "";
  fi.dispatchEvent(new Event("change"));  // 끌어놓기 칸 안내문 초기화
  await loadOutstandingForBulk();
  loadPendingReview();
  loadImportIssues();
});

// ===========================================================================
// 반입 자료 (zip 없이)
// ===========================================================================
async function loadOutstandingForBulk() {
  importState.outstanding = await (await fetch("/distributions/outstanding")).json();
  populateSelFilters();
}

// 공사·업체를 별개 드롭다운 2개로 나눠서, 한쪽을 고르면 다른 쪽 목록이 그 조합에 있는
// 것만 남도록 서로 좁혀준다("__none__" = 공사 없음 그룹).
function projectOptionValue(projectId) {
  return projectId == null ? "__none__" : String(projectId);
}

function uniqueVendors(projectFilterValue) {
  const map = new Map();
  for (const it of importState.outstanding) {
    if (projectFilterValue && projectOptionValue(it.project_id) !== projectFilterValue) continue;
    if (!map.has(it.vendor)) map.set(it.vendor, { vendor: it.vendor, count: 0 });
    map.get(it.vendor).count += 1;
  }
  return [...map.values()].sort((a, b) => a.vendor.localeCompare(b.vendor, "ko"));
}

function uniqueProjects(vendorFilterValue) {
  const map = new Map();
  for (const it of importState.outstanding) {
    if (vendorFilterValue && it.vendor !== vendorFilterValue) continue;
    const key = projectOptionValue(it.project_id);
    if (!map.has(key)) map.set(key, { projectId: it.project_id, projectName: it.project_name, count: 0 });
    map.get(key).count += 1;
  }
  return [...map.values()].sort((a, b) => (a.projectName ?? "").localeCompare(b.projectName ?? "", "ko"));
}

function populateSelFilters() {
  const projSel = document.getElementById("sel-project");
  const vendSel = document.getElementById("sel-vendor");
  const prevProj = projSel.value;
  const prevVend = vendSel.value;

  const vendors = uniqueVendors(prevProj);
  vendSel.innerHTML = '<option value="">업체 선택</option>';
  for (const v of vendors) {
    const opt = document.createElement("option");
    opt.value = v.vendor;
    opt.textContent = `${v.vendor} (반입 미완료 ${v.count}건)`;
    vendSel.appendChild(opt);
  }
  vendSel.value = vendors.some((v) => v.vendor === prevVend) ? prevVend : "";

  const projects = uniqueProjects(vendSel.value);
  projSel.innerHTML = '<option value="">공사 선택</option>';
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = projectOptionValue(p.projectId);
    opt.textContent = `${p.projectName ?? "공사 없음"} (반입 미완료 ${p.count}건)`;
    projSel.appendChild(opt);
  }
  projSel.value = projects.some((p) => projectOptionValue(p.projectId) === prevProj) ? prevProj : "";

  updateSelPairFromInputs();
}

function updateSelPairFromInputs() {
  const projVal = document.getElementById("sel-project").value;
  const vendVal = document.getElementById("sel-vendor").value;
  let projectId = null;
  let projectName = null;
  if (projVal && projVal !== "__none__") {
    const it = importState.outstanding.find((x) => projectOptionValue(x.project_id) === projVal);
    projectId = it ? it.project_id : null;
    projectName = it ? it.project_name : null;
  }
  importState.selPair = { vendor: vendVal || null, projectId, projectName };
}

function resetSelFilters() {
  document.getElementById("sel-project").value = "";
  document.getElementById("sel-vendor").value = "";
  document.getElementById("sel-date-from").value = "";
  document.getElementById("sel-date-to").value = "";
  populateSelFilters();
  saveSelState();
}

// ---------------------------------------------------------------------------
// "반입 자료(개별)" 검색조건 — 다른 화면 갔다 돌아와도 유지되도록 sessionStorage에 저장/복원
// (TDB 조회 등 다른 화면과 같은 방식). 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다.
// 공사·업체 드롭다운은 populateSelFilters()가 옵션을 채운 뒤라야 값이 먹는다.
// ---------------------------------------------------------------------------
const SEL_STATE_KEY = "dms_import_sel_state";

function saveSelState() {
  const snapshot = {
    project: document.getElementById("sel-project").value,
    vendor: document.getElementById("sel-vendor").value,
    dateFrom: document.getElementById("sel-date-from").value,
    dateTo: document.getElementById("sel-date-to").value,
    selectedDists: importState.selectedDists,
  };
  sessionStorage.setItem(SEL_STATE_KEY, JSON.stringify(snapshot));
}

function restoreSelState() {
  const raw = sessionStorage.getItem(SEL_STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    document.getElementById("sel-project").value = s.project || "";
    populateSelFilters(); // 공사 기준으로 업체 옵션을 좁힘
    document.getElementById("sel-vendor").value = s.vendor || "";
    populateSelFilters(); // 업체 기준으로 공사 옵션을 좁히되, 두 값 다 유지되게 다시 한 번
    document.getElementById("sel-date-from").value = s.dateFrom || "";
    document.getElementById("sel-date-to").value = s.dateTo || "";
    importState.selectedDists = s.selectedDists || [];
    updateSelCount();
  } catch (e) {
    /* 무시 */
  }
}

document.getElementById("sel-project").addEventListener("change", () => {
  importState.selectedDists = [];
  updateSelCount();
  populateSelFilters();
  saveSelState();
});
document.getElementById("sel-vendor").addEventListener("change", () => {
  importState.selectedDists = [];
  updateSelCount();
  populateSelFilters();
  saveSelState();
});
document.getElementById("sel-date-from").addEventListener("change", saveSelState);
document.getElementById("sel-date-to").addEventListener("change", saveSelState);

function updateSelCount() {
  document.getElementById("sel-count").textContent = `선택된 도면: ${importState.selectedDists.length}건`;
  saveSelState();
}

// 반출일시 기준 기간(시작~종료) — 자료검색 결과를 이 범위로 좁힌다.
function selDateRange() {
  const from = document.getElementById("sel-date-from").value;
  const to = document.getElementById("sel-date-to").value;
  return {
    dateFrom: from ? `${from}T00:00:00` : null,
    dateTo: to ? `${to}T23:59:59` : null,
    fromLabel: from, toLabel: to,
  };
}

document.getElementById("sel-search-btn").addEventListener("click", async () => {
  const p = importState.selPair;
  if (!p.vendor) {
    await showAlert("먼저 업체를 선택해주세요.");
    return;
  }
  const { dateFrom, dateTo, fromLabel, toLabel } = selDateRange();
  const periodText = fromLabel || toLabel ? ` · 기간 ${fromLabel || "처음"}~${toLabel || "지금"}` : "";
  openPicker({
    vendor: p.vendor, projectId: p.projectId, mode: "MULTI", title: "업체별 반출·반입자료 현황",
    dateFrom, dateTo,
    sub: `${p.projectName ?? "공사 없음"} · ${p.vendor}${periodText} — 반입할 도면을 체크하세요 (반입미완료만 선택 가능)`,
    onConfirm: (selected) => {
      importState.selectedDists = selected.map((s) => ({
        distribution_id: s.distribution_id, drawing_no: s.drawing_no,
      }));
      updateSelCount();
    },
  });
});

document.getElementById("sel-submit").addEventListener("click", async () => {
  if (!importState.selectedDists.length) {
    showResult("sel-result", "err", "자료검색으로 반입할 도면을 먼저 선택해주세요.");
    show("sel-result");
    return;
  }
  const fi = document.getElementById("sel-files");
  if (!fi.files.length) {
    showResult("sel-result", "err", "업로드할 파일을 선택해주세요.");
    show("sel-result");
    return;
  }
  const fd = new FormData();
  fd.append("distribution_ids", importState.selectedDists.map((d) => d.distribution_id).join(","));
  for (const f of fi.files) fd.append("files", f);
  showResult("sel-result", "ok", "업로드 중...");
  show("sel-result");

  const res = await fetch("/documents/revisions/by-selection", { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json();
    showResult("sel-result", "err", err.detail || "업로드 실패");
    return;
  }
  const data = await res.json();
  showResult("sel-result", data.issues.length ? "warn" : "ok", data.message);
  fi.value = "";
  fi.dispatchEvent(new Event("change"));  // 끌어놓기 칸 안내문 초기화
  importState.selectedDists = [];
  updateSelCount();
  await loadOutstandingForBulk();
  resetSelFilters();
  loadPendingReview();
  loadImportIssues();
});

// ===========================================================================
// 검색 (구분·공사·업체·기간·자료명) — 검수대기·확인필요 두 표 공통
// ===========================================================================
function impFilters() {
  return {
    kind: document.getElementById("imp-kind").value,
    project: document.getElementById("imp-project").value,
    vendor: document.getElementById("imp-vendor").value,
    from: document.getElementById("imp-from").value,
    to: document.getElementById("imp-to").value,
    q: document.getElementById("imp-q").value.trim().toLowerCase(),
  };
}

function impItemMatches(item, f) {
  if (f.project && (item.project_name ?? "") !== f.project) return false;
  if (f.vendor && (item.vendor_name ?? "") !== f.vendor) return false;
  if (f.q && !(item.display_name ?? item.drawing_no ?? "").toLowerCase().includes(f.q)) return false;
  if (f.from && (!item.uploaded_at || item.uploaded_at < `${f.from}T00:00:00`)) return false;
  if (f.to && (!item.uploaded_at || item.uploaded_at > `${f.to}T23:59:59`)) return false;
  return true;
}

// 공사·업체 드롭다운은 검수대기+확인필요 두 목록에 실제 등장한 값만 후보로 쓴다(자유 입력 금지).
function populateImpFilterOptions() {
  const projSel = document.getElementById("imp-project");
  const vendSel = document.getElementById("imp-vendor");
  const prevProj = projSel.value;
  const prevVend = vendSel.value;
  const all = [...reviewGroupsRaw, ...currentIssues];
  const projects = [...new Set(all.map((x) => x.project_name).filter((v) => v))].sort((a, b) => a.localeCompare(b, "ko"));
  const vendors = [...new Set(all.map((x) => x.vendor_name).filter((v) => v))].sort((a, b) => a.localeCompare(b, "ko"));
  projSel.innerHTML = '<option value="">전체</option>' + projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  vendSel.innerHTML = '<option value="">전체</option>' + vendors.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  projSel.value = projects.includes(prevProj) ? prevProj : "";
  vendSel.value = vendors.includes(prevVend) ? prevVend : "";
}

// 구분에 따라 표를 보이거나 감춘다. "전체"일 때는 기존 방식대로 확인필요가 0건이면 숨긴다.
// 구분을 직접 골랐을 때는 그 표를 항상 보여준다(0건이어도 "없습니다" 안내를 보여주기 위함).
function applyImpSectionVisibility(kind, issuesCount) {
  const reviewSection = document.getElementById("review-section");
  const issuesSection = document.getElementById("issues-section");
  if (kind === "REVIEW") {
    reviewSection.classList.remove("hidden");
    issuesSection.classList.add("hidden");
  } else if (kind === "ISSUE") {
    reviewSection.classList.add("hidden");
    issuesSection.classList.remove("hidden");
  } else {
    reviewSection.classList.remove("hidden");
    issuesSection.classList.toggle("hidden", issuesCount === 0);
  }
}

document.getElementById("imp-search-btn").addEventListener("click", () => {
  renderReview();
  renderIssues();
});
document.getElementById("imp-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    renderReview();
    renderIssues();
  }
});
document.getElementById("imp-kind").addEventListener("change", () => {
  renderReview();
  renderIssues();
});
document.getElementById("imp-project").addEventListener("change", () => {
  renderReview();
  renderIssues();
});
document.getElementById("imp-vendor").addEventListener("change", () => {
  renderReview();
  renderIssues();
});
document.getElementById("imp-reset-btn").addEventListener("click", () => {
  document.getElementById("imp-kind").value = "";
  document.getElementById("imp-project").value = "";
  document.getElementById("imp-vendor").value = "";
  document.getElementById("imp-from").value = "";
  document.getElementById("imp-to").value = "";
  document.getElementById("imp-q").value = "";
  renderReview();
  renderIssues();
});

// ===========================================================================
// 검수 대기 목록
// ===========================================================================
async function reviewAction(fileId, action) {
  const note = action === "REJECT" ? await showPrompt("반려 사유(선택):") : null;
  if (action === "REJECT" && note === null) return;
  const res = await fetch(`/revisions/${fileId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, note }),
  });
  if (!res.ok) {
    const err = await res.json();
    await showAlert(err.detail || "처리 실패");
    return;
  }
  loadPendingReview();
  loadImportIssues();
}

document.getElementById("review-export-btn").addEventListener("click", () => {
  window.location = "/revisions/pending-review/export";
});

async function loadPendingReview() {
  reviewGroupsRaw = await (await fetch("/revisions/pending-review")).json();
  populateImpFilterOptions();
  renderReview();
}

function renderReview() {
  const f = impFilters();
  const groups = reviewGroupsRaw.filter((g) => impItemMatches(g, f));
  renderedReviewGroups = groups;
  applyImpSectionVisibility(f.kind, currentIssues.filter((it) => impItemMatches(it, f)).length);

  const tbody = document.getElementById("review-tbody");
  tbody.innerHTML = "";
  document.getElementById("review-count").textContent = `검수 대기 (${groups.length})`;
  document.getElementById("review-select-all").checked = false;

  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty">검수 대기 중인 항목이 없습니다.</td></tr>';
    return;
  }

  // 검수 대기 표는 자료 상세보기로 넘기지 않는다(자료명은 텍스트만) — 같은 문서가 분기
  // (a/b 등) 여러 행으로 겹쳐 나올 때 상세보기 이전/다음이 어느 행인지 구분 못 하는 문제가
  // 있었고, 검수는 돋보기 미리보기로 각 행의 실제 파일을 바로 확인하는 것으로 충분하다.
  const previewList = groups.map((g) => {
    const pdf = g.files.find((f) => f.file_ext === "pdf");
    return { id: g.document_id, drawingNo: g.display_name, path: g.source_path, pdfFileId: pdf ? pdf.id : null };
  });

  groups.forEach((g, i) => {
    // 표기 불일치(any_mismatch_warning)는 이제 검수대기에 올라오지 않는다 — 반입 시점에
    // 확인필요로 갈라져 [비교]·[재검수]로 CM이 먼저 확인하게 한다(2026-08-18 CM 확정).
    // 그래서 여기서는 빨간 줄(warning-row)로 표시할 일이 없다.
    const tr = document.createElement("tr");
    const pdf = g.files.find((f) => f.file_ext === "pdf");
    // PDF가 없어 비교할 자료가 없는 경우에도 버튼 자체는 남기고 눌리지 않게만 한다
    // (2026-08-18 CM 확정 — 버튼이 사라지면 "왜 없지"라는 문의가 생긴다).
    const compareBtn = `<button class="small" data-compare-doc="${g.document_id}" data-compare-pdf="${pdf ? pdf.id : ""}" data-drawing="${escapeHtml(g.display_name)}" ${pdf ? "" : "disabled"}>비교</button>`;
    const isDup = g.branch_expected != null;
    // 중복반출은 반입Rev 칸에 진행 상황을 함께 적는다: "1-a(반입누적/총반출)"
    const revLabel = isDup ? `${g.rev_label}(${g.branch_arrived}/${g.branch_expected})` : g.rev_label;
    const dupCell = isDup
      ? `<button class="small" data-dup-doc="${g.document_id}" data-drawing="${escapeHtml(g.display_name)}">Y</button>`
      : `<span class="yn-n">·</span>`;
    const approveDisabled = g.can_approve ? "" : "disabled";
    const perms = window.__tdmsPerms || new Set();
    // 중복반출 통합승인(병합)은 권한.xlsx에 없는 기능이라 항상 열려 있다 — 개별 승인/반려는
    // screen.tdb_import.review.approve/.reject 권한이 없으면 흐리게 비활성화만 한다
    // (2026-08-13 CM 확정 — 자기한테 없는 기능을 알아야 권한을 요청할 수 있다).
    const canApproveThis = g.can_approve && perms.has("screen.tdb_import.review.approve");
    const approveBtn = isDup
      ? `<button class="small primary" data-merge-doc="${g.document_id}" data-drawing="${escapeHtml(g.display_name)}" ${approveDisabled}>승인</button>`
      : `<button class="small primary" data-id="${g.representative_file_id}" data-action="APPROVE" ${canApproveThis ? "" : "disabled"}>승인</button>`;
    const rejectBtn = `<button class="small" data-id="${g.representative_file_id}" data-action="REJECT" ${perms.has("screen.tdb_import.review.reject") ? "" : "disabled"}>반려</button>`;
    // 반출Rev가 비어 있으면 0으로 본다 — 최초 적재된 도면은 전부 rev 0에서 시작하기 때문.
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td class="tc"><input type="checkbox" class="review-row-check" data-doc="${g.document_id}" /></td>
      <td>${textOrNa(g.project_name)}</td>
      <td>${textOrNa(g.vendor_name)}</td>
      <td>${previewBtnHtml(pdf ? pdf.id : null)} ${escapeHtml(g.display_name)}</td>
      <td>${textOrNa(g.category)}</td>
      <td class="muted">${textOrNa(g.source_path)}</td>
      <td class="tc">${g.distributed_rev ?? 0}</td>
      <td class="tc"><b>${revLabel}</b></td>
      <td class="tc">${extsLabel(g.distributed_exts)}</td>
      <td class="tc">${extsLabel(g.imported_exts)}</td>
      <td class="tc">${dupCell}</td>
      <td class="tc muted">${fmtDateTime(g.uploaded_at)}</td>
      <td class="tc">
        ${compareBtn}
        ${approveBtn}
        ${rejectBtn}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("button[data-action]").forEach((btn) =>
    btn.addEventListener("click", () => reviewAction(Number(btn.dataset.id), btn.dataset.action))
  );
  tbody.querySelectorAll("button[data-compare-doc]").forEach((btn) =>
    btn.addEventListener("click", () =>
      openCompare(Number(btn.dataset.compareDoc), Number(btn.dataset.comparePdf), btn.dataset.drawing)
    )
  );
  tbody.querySelectorAll("[data-dup-doc]").forEach((btn) =>
    btn.addEventListener("click", () => openDupModal(Number(btn.dataset.dupDoc), btn.dataset.drawing))
  );
  tbody.querySelectorAll("[data-merge-doc]").forEach((btn) =>
    btn.addEventListener("click", () => openMergeModal(Number(btn.dataset.mergeDoc), btn.dataset.drawing))
  );
  wirePreviewButtons(tbody, previewList);
}

document.getElementById("review-select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".review-row-check").forEach((cb) => { cb.checked = e.target.checked; });
});

// 선택 승인: 중복반출(병합 필요)·권한 없음·아직 승인 불가 건은 제외하고 나머지만 일괄 승인한다.
document.getElementById("review-bulk-approve-btn").addEventListener("click", async () => {
  const checkedDocIds = [...document.querySelectorAll(".review-row-check:checked")].map((cb) => Number(cb.dataset.doc));
  if (!checkedDocIds.length) {
    await showAlert("승인할 항목을 하나 이상 선택하세요.");
    return;
  }
  const perms = window.__tdmsPerms || new Set();
  const targets = renderedReviewGroups.filter((g) => checkedDocIds.includes(g.document_id));
  const approvable = targets.filter(
    (g) => g.branch_expected == null && g.can_approve && perms.has("screen.tdb_import.review.approve")
  );
  const skipped = targets.length - approvable.length;
  if (!approvable.length) {
    await showAlert("선택한 항목 중 바로 승인할 수 있는 건이 없습니다 (중복반출 병합 대상이거나 권한이 없는 항목은 제외됩니다).");
    return;
  }
  const ok = await showConfirm(
    `선택 ${approvable.length}건을 승인합니다.${skipped ? ` (중복반출·권한 없음 등으로 ${skipped}건 제외)` : ""}\n계속하시겠습니까?`
  );
  if (!ok) return;
  let failCount = 0;
  for (const g of approvable) {
    const res = await fetch(`/revisions/${g.representative_file_id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "APPROVE", note: null }),
    });
    if (!res.ok) failCount++;
  }
  await showAlert(`${approvable.length - failCount}건 승인 완료${failCount ? `, ${failCount}건 실패` : ""}`);
  loadPendingReview();
  loadImportIssues();
});

document.getElementById("review-bulk-reject-btn").addEventListener("click", async () => {
  const checkedDocIds = [...document.querySelectorAll(".review-row-check:checked")].map((cb) => Number(cb.dataset.doc));
  if (!checkedDocIds.length) {
    await showAlert("반려할 항목을 하나 이상 선택하세요.");
    return;
  }
  const perms = window.__tdmsPerms || new Set();
  if (!perms.has("screen.tdb_import.review.reject")) {
    await showAlert("반려 권한이 없습니다.");
    return;
  }
  const targets = renderedReviewGroups.filter((g) => checkedDocIds.includes(g.document_id));
  const note = await showPrompt(`선택 ${targets.length}건의 반려 사유(선택, 전체 동일하게 적용):`);
  if (note === null) return;
  let failCount = 0;
  for (const g of targets) {
    const res = await fetch(`/revisions/${g.representative_file_id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "REJECT", note }),
    });
    if (!res.ok) failCount++;
  }
  await showAlert(`${targets.length - failCount}건 반려 완료${failCount ? `, ${failCount}건 실패` : ""}`);
  loadPendingReview();
  loadImportIssues();
});

// ===========================================================================
// 중복반출 현황 팝업
// ===========================================================================
let dupModalDocumentId = null;

async function openDupModal(documentId, drawingNo) {
  dupModalDocumentId = documentId;
  document.getElementById("dup-title").textContent = `${drawingNo} — 중복반출 현황`;
  const tbody = document.getElementById("dup-tbody");
  tbody.innerHTML = "";
  const rows = await (await fetch(`/documents/${documentId}/duplicate-distributions`)).json();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">중복반출 정보가 없습니다.</td></tr>';
  } else {
    rows.forEach((r, i) => {
      const statusBadge =
        r.status === "PENDING_REVIEW"
          ? '<span class="badge badge-info">검수대기</span>'
          : '<span class="badge badge-warning">반출미완료</span>';
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="col-no">${i + 1}</td>
        <td>${textOrNa(r.project_name)}</td>
        <td>${escapeHtml(r.vendor)}</td>
        <td class="tc muted">${fmtDateTime(r.distributed_at)}</td>
        <td class="tc">${statusBadge}</td>`;
      tbody.appendChild(tr);
    });
  }
  document.getElementById("dup-modal").classList.remove("hidden");
}
document.getElementById("dup-close").addEventListener("click", () =>
  document.getElementById("dup-modal").classList.add("hidden")
);
document.getElementById("dup-export-btn").addEventListener("click", () => {
  if (dupModalDocumentId) window.location = `/documents/${dupModalDocumentId}/duplicate-distributions/export`;
});

// ===========================================================================
// 중복반출 승인: 병합본 첨부
// ===========================================================================
let mergeDocId = null;
function openMergeModal(documentId, drawingNo) {
  mergeDocId = documentId;
  document.getElementById("merge-desc").textContent =
    `대상: ${drawingNo} — 반출 때 있었던 파일 종류를 전부 첨부하세요. ` +
    `파일명은 모두 '${drawingNo}'와 같아야 합니다 (예: ${drawingNo}.dwg, ${drawingNo}.pdf).`;
  const fileInput = document.getElementById("merge-files");
  fileInput.value = "";
  fileInput.dispatchEvent(new Event("change"));
  document.getElementById("merge-modal").classList.remove("hidden");
}
document.getElementById("merge-cancel").addEventListener("click", () =>
  document.getElementById("merge-modal").classList.add("hidden")
);
document.getElementById("merge-confirm").addEventListener("click", async () => {
  const fi = document.getElementById("merge-files");
  if (!fi.files.length) {
    await showAlert("파일을 첨부해주세요.");
    return;
  }
  const fd = new FormData();
  for (const f of fi.files) fd.append("files", f);
  const res = await fetch(`/documents/${mergeDocId}/branch-merge`, { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json();
    await showAlert(err.detail || "승인 실패");
    return;
  }
  const data = await res.json();
  document.getElementById("merge-modal").classList.add("hidden");
  await showAlert(data.message);
  loadPendingReview();
});

// ===========================================================================
// 확인 필요 목록
// ===========================================================================
let currentIssues = [];

document.getElementById("issues-export-btn").addEventListener("click", () => {
  window.location = "/import-issues/export";
});

async function loadImportIssues() {
  currentIssues = await (await fetch("/import-issues")).json();
  populateImpFilterOptions();
  renderIssues();
}

function renderIssues() {
  const f = impFilters();
  const issues = currentIssues.filter((it) => impItemMatches(it, f));
  applyImpSectionVisibility(f.kind, issues.length);

  const tbody = document.getElementById("issues-tbody");
  document.getElementById("issues-count").textContent =
    issues.length ? `확인 필요 (${issues.length})` : "확인 필요 (0)";
  document.getElementById("issues-select-all").checked = false;
  tbody.innerHTML = "";

  if (!issues.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">확인 필요한 항목이 없습니다.</td></tr>';
    return;
  }

  // 검수 대기 표와 마찬가지로, 자료명 클릭 시 이전/다음이 이 표(확인 필요)에 조회된 자료만
  // 따라가도록 한다. 도면이 아직 특정되지 않은 항목(intended_document_id 없음)은 상세보기
  // 링크 자체가 없으므로 목록에서 뺀다.
  const navIds = [...new Set(issues.filter((it) => it.intended_document_id).map((it) => it.intended_document_id))];
  const previewList = issues.map((it) => {
    const pdf = it.files.find((f) => f.file_ext === "pdf");
    return {
      id: it.intended_document_id ?? it.id,
      drawingNo: it.display_name ?? "(미정)",
      path: it.source_path,
      previewUrl: pdf ? `/import-issues/${it.id}/preview` : null,
    };
  });

  issues.forEach((it, i) => {
    const tr = document.createElement("tr");
    tr.classList.add("warning-row");
    const pdf = it.files.find((f) => f.file_ext === "pdf");
    const nameCell = it.intended_document_id
      ? `<a href="detail.html?id=${it.intended_document_id}&from=import">${textOrNa(it.display_name)}</a>`
      : textOrNa(it.display_name);
    const perms = window.__tdmsPerms || new Set();
    // 비교(반출본 ↔ 반입본)는 대상 도면이 정해져 있고 반입된 파일 중 PDF가 있을 때만 의미가
    // 있다 — 검수대기 표의 [비교]와 같은 기능(2026-08-18 CM 확정, 표기 불일치를 여기서
    // 확인하고 [재검수]로 넘기는 흐름의 핵심 버튼). 대상이 없거나 PDF가 없으면 버튼은
    // 남기고 눌리지 않게만 한다(검수대기 표와 같은 원칙).
    const canCompare = !!(it.intended_document_id && pdf);
    const compareBtn = `<button class="small" data-compare-issue="${it.id}" data-compare-issue-doc="${it.intended_document_id ?? ""}" data-drawing="${escapeHtml(it.display_name ?? "")}" ${canCompare ? "" : "disabled"}>비교</button>`;
    const reattachBtn = `<button class="small" data-reattach="${it.id}" ${perms.has("screen.tdb_import.issue.reattach") ? "" : "disabled"}>자료 재첨부</button>`;
    const repathBtn = `<button class="small" data-repath="${it.id}" ${perms.has("screen.tdb_import.issue.repath") ? "" : "disabled"}>경로 재선택</button>`;
    const recheckBtn = `<button class="small primary" data-recheck="${it.id}" ${perms.has("screen.tdb_import.issue.recheck") ? "" : "disabled"}>재검수</button>`;
    const discardBtn = `<button class="small" data-discard="${it.id}" ${perms.has("screen.tdb_import.issue.reject") ? "" : "disabled"}>반려</button>`;
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td class="tc"><input type="checkbox" class="issues-row-check" data-issue="${it.id}" /></td>
      <td>${textOrNa(it.project_name)}</td>
      <td>${escapeHtml(it.vendor_name ?? "")}</td>
      <td>${previewBtnHtml(pdf ? it.id : null)} ${nameCell}</td>
      <td class="tc muted">${fmtDateTime(it.uploaded_at)}</td>
      <td>${reasonBadges(it.reasons)}</td>
      <td class="tc">
        <div class="action-btns">
          <button class="small" data-detail="${it.id}">사유상세</button>
          ${compareBtn}
          ${reattachBtn}
          ${repathBtn}
          ${recheckBtn}
          ${discardBtn}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  wirePreviewButtons(tbody, previewList);
  wireDetailLinks(tbody, navIds);

  tbody.querySelectorAll("[data-detail]").forEach((b) =>
    b.addEventListener("click", () => openDetailModal(Number(b.dataset.detail)))
  );
  tbody.querySelectorAll("[data-compare-issue]").forEach((b) =>
    b.addEventListener("click", () =>
      openCompareForIssue(Number(b.dataset.compareIssueDoc), Number(b.dataset.compareIssue), b.dataset.drawing)
    )
  );
  tbody.querySelectorAll("[data-recheck]").forEach((b) =>
    b.addEventListener("click", () => recheckIssue(Number(b.dataset.recheck)))
  );
  tbody.querySelectorAll("[data-reattach]").forEach((b) =>
    b.addEventListener("click", () => openReattachModal(Number(b.dataset.reattach)))
  );
  tbody.querySelectorAll("[data-repath]").forEach((b) =>
    b.addEventListener("click", () => openRepath(Number(b.dataset.repath)))
  );
  tbody.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", () => discardIssue(Number(b.dataset.discard)))
  );
}

document.getElementById("issues-select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".issues-row-check").forEach((cb) => { cb.checked = e.target.checked; });
});

document.getElementById("issues-bulk-recheck-btn").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".issues-row-check:checked")].map((cb) => Number(cb.dataset.issue));
  if (!ids.length) {
    await showAlert("재검수할 항목을 하나 이상 선택하세요.");
    return;
  }
  const perms = window.__tdmsPerms || new Set();
  if (!perms.has("screen.tdb_import.issue.recheck")) {
    await showAlert("재검수 권한이 없습니다.");
    return;
  }
  const ok = await showConfirm(`선택 ${ids.length}건을 재검수합니다. 계속하시겠습니까?`);
  if (!ok) return;
  let failCount = 0;
  for (const id of ids) {
    const res = await fetch(`/import-issues/${id}/recheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) failCount++;
  }
  await showAlert(`${ids.length - failCount}건 재검수 완료${failCount ? `, ${failCount}건 실패` : ""}`);
  loadPendingReview();
  loadImportIssues();
});

document.getElementById("issues-bulk-reject-btn").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".issues-row-check:checked")].map((cb) => Number(cb.dataset.issue));
  if (!ids.length) {
    await showAlert("반려할 항목을 하나 이상 선택하세요.");
    return;
  }
  const perms = window.__tdmsPerms || new Set();
  if (!perms.has("screen.tdb_import.issue.reject")) {
    await showAlert("반려 권한이 없습니다.");
    return;
  }
  const ok = await showConfirm(`선택 ${ids.length}건을 반려 처리하시겠습니까?`);
  if (!ok) return;
  let failCount = 0;
  for (const id of ids) {
    const res = await fetch(`/import-issues/${id}/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) failCount++;
  }
  await showAlert(`${ids.length - failCount}건 반려 완료${failCount ? `, ${failCount}건 실패` : ""}`);
  loadImportIssues();
});

// 상세 설명
function openDetailModal(issueId) {
  const it = currentIssues.find((x) => x.id === issueId);
  document.getElementById("detail-text").textContent = it.detail_text || "추가 설명이 없습니다.";
  document.getElementById("detail-modal").classList.remove("hidden");
}
document.getElementById("detail-close").addEventListener("click", () =>
  document.getElementById("detail-modal").classList.add("hidden")
);

// 자료 재첨부
let reattachIssueId = null;
function openReattachModal(issueId) {
  reattachIssueId = issueId;
  const it = currentIssues.find((x) => x.id === issueId);
  document.getElementById("reattach-desc").textContent =
    `대상: ${it.display_name ?? "(미정)"} — 원본과 PDF를 함께 올려주세요. ` +
    `첨부한 뒤 [재검수]를 눌러야 다시 검수됩니다.`;
  const fileInput = document.getElementById("reattach-files");
  fileInput.value = "";
  fileInput.dispatchEvent(new Event("change"));  // 끌어놓기 칸 안내문도 초기 상태로
  document.getElementById("reattach-modal").classList.remove("hidden");
}
document.getElementById("reattach-cancel").addEventListener("click", () =>
  document.getElementById("reattach-modal").classList.add("hidden")
);
document.getElementById("reattach-confirm").addEventListener("click", async () => {
  const fi = document.getElementById("reattach-files");
  if (!fi.files.length) {
    await showAlert("파일을 선택해주세요.");
    return;
  }
  const fd = new FormData();
  for (const f of fi.files) fd.append("files", f);
  const res = await fetch(`/import-issues/${reattachIssueId}/reattach`, { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json();
    await showAlert(err.detail || "재첨부 실패");
    return;
  }
  const data = await res.json();
  document.getElementById("reattach-modal").classList.add("hidden");
  await showAlert(data.message);
  loadImportIssues();
});

// 경로 재선택 (공용 팝업 단일 선택 → 대상 도면만 바꿔둔다. 등록은 [재검수]에서.)
function openRepath(issueId) {
  const it = currentIssues.find((x) => x.id === issueId);
  openPicker({
    vendor: it.vendor_name, projectId: it.project_id, mode: "SINGLE", title: "경로 재선택",
    sub: `${it.project_name ?? "공사 없음"} · ${it.vendor_name} — 이 자료가 실제로 어느 도면인지 하나만 선택하세요`,
    onConfirm: async (selected) => {
      if (!selected.length) {
        await showAlert("도면을 하나 선택해주세요.");
        return;
      }
      const res = await fetch(`/import-issues/${issueId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: selected[0].document_id }),
      });
      if (!res.ok) {
        const err = await res.json();
        await showAlert(err.detail || "처리 실패");
        return;
      }
      const data = await res.json();
      await showAlert(data.message);
      loadImportIssues();
    },
  });
}

// 재검수: 재첨부한 파일 / 다시 고른 도면으로 처음부터 다시 검사한다.
// 깨끗하면 검수 대기로 올라가고, 아직 문제가 있으면 이 항목은 없어지고
// 새 사유의 '확인 필요' 항목이 새로 생긴다.
async function recheckIssue(issueId) {
  const res = await fetch(`/import-issues/${issueId}/recheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json();
    await showAlert(err.detail || "재검수 실패");
    return;
  }
  const data = await res.json();
  await showAlert(data.message);
  loadPendingReview();
  loadImportIssues();
}

async function discardIssue(issueId) {
  const ok = await showConfirm("이 항목을 반려 처리하시겠습니까?");
  if (!ok) return;
  await fetch(`/import-issues/${issueId}/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  loadImportIssues();
}

// ===========================================================================
// 반출본 ↔ 반입본 비교
// ===========================================================================
async function openCompare(documentId, pendingPdfId, drawingNo) {
  const left = document.getElementById("compare-left");
  const right = document.getElementById("compare-right");
  const doc = await (await fetch(`/documents/${documentId}`)).json();
  if (doc.current_pdf_file_id) {
    // 주소 뒤에 자료명을 붙이는 이유는 ui.js previewUrlWithSaveName 참고(마크업 후 저장 파일명).
    const url = previewUrlWithSaveName(`/files/${doc.current_pdf_file_id}/view`, drawingNo);
    left.innerHTML = `<iframe src="${url}"></iframe>`;
  } else {
    left.innerHTML = `<div class="compare-nopdf">이전 승인 리비전에 PDF가 없습니다 (신규이거나 PDF 미보유).</div>`;
  }
  right.innerHTML = `<iframe src="${previewUrlWithSaveName(`/files/${pendingPdfId}/view`, drawingNo)}"></iframe>`;
  document.getElementById("compare-title").textContent = `${drawingNo} — 반출자료·반입자료 비교`;
  document.getElementById("compare-modal").classList.remove("hidden");
}
document.getElementById("compare-close").addEventListener("click", () => {
  document.getElementById("compare-modal").classList.add("hidden");
  document.getElementById("compare-left").innerHTML = "";
  document.getElementById("compare-right").innerHTML = "";
});

// 확인 필요 표의 [비교] — 검수대기와 같은 모달을 쓰되, 아직 정식 File 행이 아니라서
// (승인 전이라 files 테이블에 없음) 반입본은 /import-issues/{id}/preview로 미리본다.
async function openCompareForIssue(documentId, issueId, drawingNo) {
  const left = document.getElementById("compare-left");
  const right = document.getElementById("compare-right");
  const doc = await (await fetch(`/documents/${documentId}`)).json();
  if (doc.current_pdf_file_id) {
    // 주소 뒤에 자료명을 붙이는 이유는 ui.js previewUrlWithSaveName 참고(마크업 후 저장 파일명).
    const url = previewUrlWithSaveName(`/files/${doc.current_pdf_file_id}/view`, drawingNo);
    left.innerHTML = `<iframe src="${url}"></iframe>`;
  } else {
    left.innerHTML = `<div class="compare-nopdf">이전 승인 리비전에 PDF가 없습니다 (신규이거나 PDF 미보유).</div>`;
  }
  right.innerHTML = `<iframe src="${previewUrlWithSaveName(`/import-issues/${issueId}/preview`, drawingNo)}"></iframe>`;
  document.getElementById("compare-title").textContent = `${drawingNo} — 반출자료·반입자료 비교`;
  document.getElementById("compare-modal").classList.remove("hidden");
}

// ===========================================================================
async function init() {
  await window.tdmsReady; // 권한(window.__tdmsPerms)에 따라 승인·반려 등 버튼을 다르게 그리므로 먼저 기다린다
  await loadOutstandingForBulk();
  restoreSelState(); // 공사·업체 옵션이 채워진 뒤라야 저장된 값이 먹는다
  await loadPendingReview();
  await loadImportIssues();
  // [파일 선택] 버튼은 그대로 두고, 끌어다 놓기 칸을 함께 붙인다
  attachDropZone("zip-file", { multiple: false, hint: "여기로 zip 파일을 끌어다 놓으세요" });
  attachDropZone("sel-files");
  attachDropZone("reattach-files");
  attachDropZone("merge-files");

  // 검수대기 표는 자료명 클릭 → 상세보기 → 목록으로 돌아오는 경로가 있어 너비를 유지해준다.
  // 체크박스 열이 추가되며 열 순서가 하나씩 밀렸다 — 옛 저장값을 그대로 되살리면 폭이
  // 엉뚱한 열에 적용되므로 키에 버전을 붙인다(editor.js 삭제 보관함 표와 같은 이유).
  const reviewColWidths = persistedColumnWidths(document.getElementById("review-table"), "import:review-table:v2");
  reviewColWidths.restore();
  makeColumnsResizable(document.getElementById("review-table"), reviewColWidths.save);
  makeColumnsResizable(document.getElementById("issues-table"));
  makeColumnsResizable(document.getElementById("picker-table"));
  makeColumnsResizable(document.getElementById("dup-table"));
  makeSortable(document.getElementById("review-table"));
  makeSortable(document.getElementById("issues-table"));
  makeSortable(document.getElementById("picker-table"));
}

init();
