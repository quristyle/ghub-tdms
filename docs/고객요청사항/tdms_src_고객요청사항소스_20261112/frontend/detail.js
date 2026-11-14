function getDocId() {
  return new URLSearchParams(window.location.search).get("id");
}

function set(id, value) {
  document.getElementById(id).textContent = value ?? "—";
}

function setHtml(id, html) {
  document.getElementById(id).innerHTML = html;
}

function formatRevLabel(rev, branch) {
  return branch ? `${rev}-${branch}` : `${rev}`;
}

// "보유" 칸: 원본(dwg/xlsx/etc 중 실제 있는 종류)과 사본(pdf) 보유 여부를 한 줄로 보여준다.
function holdingLabel(doc) {
  let original;
  if (doc.has_dwg) original = "원본(DWG) 보유";
  else if (doc.has_xlsx) original = "원본(XLSX) 보유";
  else if (doc.has_etc) original = "원본(ETC) 보유";
  else original = "원본 미보유";

  const copy = doc.has_pdf ? "사본(PDF) 보유" : "사본 미보유";
  return `${original} / ${copy}`;
}

// searchIconSvg·previewBtnHtml·openDocPreview(이전/다음 포함)는 ui.js 공용 함수를 쓴다.
// 비고 칸(noteEditCellHtml/wireNoteEdits)은 ui.js로 옮겼다 — TDB 관리 삭제 보관함 화면도
// 같은 UX를 쓰게 되어 공용 헬퍼로 뺐다.

// 미리보기 틀 — 이전/다음으로 넘어갈 때 "원본 우선"을 이어 가려고 들고 있는다(setupDetailNav).
let detailPreview = null;

function renderPdfArea(doc) {
  const area = document.getElementById("pdf-area");
  const params = new URLSearchParams(window.location.search);

  // 사본·원본을 한 틀에서 바꿔 본다(D-102, ui.js mountDocPreview). 사본이 없으면 원본을 보여준다.
  // 보관 목록에서 열었으면(주소에 fav 번호가 있으면) 보관해 둔 편집 내용까지 되살려 연다.
  // 구 리비전 PDF를 대신 보여주면 구본을 최신본으로 오인할 수 있어 절대 표시하지 않는다 —
  // 원본도 지금(현재본) 원본만 보여준다.
  detailPreview = mountDocPreview(area, {
    source: tdbSource(doc.id),
    pdfUrl: doc.current_pdf_file_id ? `/files/${doc.current_pdf_file_id}/view` : null,
    name: doc.display_name,
    favId: params.get("fav"),
    preferOriginal: params.get("pv") === "o",
    // 이전/다음으로 넘어왔으면 그때 쓰던 도구(손 도구 등)를 그대로 켠 채 연다(setupDetailNav).
    tool: params.get("tool"),
    emptyHtml: `<div class="no-pdf-notice"><b>PDF를 보유하고 있지 않습니다.</b></div>`,
  });
}

// Revision 이력은 파일마다가 아니라 세트(같은 rev로 함께 올라온 원본+PDF)마다 한 줄이다 —
// 세트는 늘 함께 움직이므로 나눠 보여줄 의미가 없다(2026-09-27 CM 지시). 묶는 규칙은 서버
// (app/revision_sets.py)에 있고, 자료명은 확장자를 뗀 이름이다. 돋보기를 누르면 그 세트의
// 사본(PDF)·원본을 미리보기 창에서 바꿔 본다. 비고도 세트 단위로 저장된다.
// [승인만 보기] 토글이 쓰는 원본 목록·문서. 토글을 켜고 끌 때 다시 그리기 위해 기억해 둔다.
let revSetsAll = [];
let revDoc = null;

function renderRevisions(sets, doc) {
  revSetsAll = sets;
  revDoc = doc;
  renderRevTable();
}

// [승인만 보기]가 켜져 있으면(기본) 승인된 리비전만, 끄면 반려·검수대기까지 전부 보여준다.
// 번호(No)는 보이는 줄 기준으로 다시 매기고, 돋보기 미리보기 목록도 보이는 줄에 맞춰 만든다.
function renderRevTable() {
  const tbody = document.getElementById("rev-tbody");
  tbody.innerHTML = "";

  const approvedOnly = document.getElementById("rev-approved-only")?.checked ?? true;
  const sets = approvedOnly
    ? revSetsAll.filter((r) => r.review_status === "APPROVED")
    : revSetsAll;
  const doc = revDoc;

  if (revSetsAll.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Revision 이력이 없습니다.</td></tr>';
    return;
  }
  if (sets.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="empty">표시할 승인 리비전이 없습니다. ' +
      "[승인만 보기]를 끄면 반려·검수대기 이력까지 볼 수 있습니다.</td></tr>";
    return;
  }

  const previewList = sets.map((r) => ({
    id: r.id,
    drawingNo: r.name,
    path: doc.source_path,
    pdfFileId: r.pdf_file_id,
    source: tdbRevSetSource(r.id),
  }));

  sets.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (r.rev_mismatch_warning) tr.classList.add("warning-row");
    const previewBtn = previewBtnHtml(r.pdf_file_id, r.has_original);
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td class="tc"><b>${formatRevLabel(r.rev, r.branch)}</b></td>
      <td>${previewBtn} ${escapeHtml(r.name ?? "")}</td>
      <td>${textOrNa(r.project_name)}</td>
      <td>${textOrNa(r.vendor_name)}</td>
      <td class="tc">${reviewBadge(r.review_status)}</td>
      <td class="muted tc">${fmtDateTime(r.uploaded_at)}</td>
      <td class="tc">${r.is_current ? '<span class="badge badge-success">최신본</span>' : ""}</td>
      <td>${noteEditCellHtml(r.id, r.review_note)}</td>
    `;
    tbody.appendChild(tr);
  });

  wirePreviewButtons(tbody, previewList);
  wireNoteEdits(tbody, (id) => `/files/${id}/note`, "common.note_edit.revision");
}

// 이 표는 이 문서 한 건의 반출 이력만 보여주므로 모든 행의 자료명은 같은 문서다(doc).
// 그래도 다른 표들과 같은 모양(자료명 좌측 돋보기)을 맞추기 위해 열을 둔다.
function renderDistributions(distributions, doc) {
  const tbody = document.getElementById("dist-tbody");
  tbody.innerHTML = "";

  if (distributions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">반출된 적이 없습니다.</td></tr>';
    return;
  }

  const previewBtn = previewBtnHtml(doc.current_pdf_file_id);
  // 이 표의 모든 행이 같은 문서(doc)를 가리키므로 미리보기 목록도 항목 하나뿐이다(이전/다음 비활성).
  const previewList = [{ id: doc.id, drawingNo: doc.display_name, path: doc.source_path, pdfFileId: doc.current_pdf_file_id, source: tdbSource(doc.id) }];

  distributions.forEach((d, i) => {
    const tr = document.createElement("tr");
    const outstanding = d.purpose === "MODIFY" && !d.returned_at;
    if (outstanding) tr.classList.add("warning-row");
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td class="tc">${d.rev_at_distribution}</td>
      <td>${previewBtn} ${escapeHtml(d.display_name)}</td>
      <td>${textOrNa(d.project_name)}</td>
      <td>${escapeHtml(d.vendor)}</td>
      <td class="tc">${purposeBadge(d.purpose, d.purpose_note)}</td>
      <td class="muted tc">${fmtDateTime(d.distributed_at)}</td>
      <td class="muted tc">${d.returned_at ? fmtDateTime(d.returned_at) : '<span class="badge badge-warning">미반입</span>'}</td>
      <td>${noteEditCellHtml(d.id, d.return_note)}</td>
    `;
    tbody.appendChild(tr);
  });

  // 모든 행이 같은 PDF(또는 PDF 없음) 한 건을 가리키므로(wirePreviewButtons를 쓰면 행 수만큼
  // 중복 세어 "1/5"처럼 잘못 표시된다), 버튼마다 같은 단일 항목 목록을 그대로 연다.
  tbody.querySelectorAll("[data-preview-btn]").forEach((btn) => {
    btn.addEventListener("click", () => openDocPreview(previewList, 0));
  });
  wireNoteEdits(tbody, (id) => `/distributions/${id}/note`, "common.note_edit.distribution");
}

// "목록으로" 버튼은 들어온 화면으로 되돌아간다. 각 화면이 detail.html?...&from=xxx 로
// 링크를 걸어두면 그 화면으로, from이 없거나 목록에 없는 값이면(TDB 조회 등) 기본값(TDB 조회)으로.
const BACK_BUTTON_TARGETS = {
  distributions: "distributions.html",
  audit: "audit.html",
  editor: "editor.html",
  import: "import.html",
};
function setupBackButton() {
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  const target = BACK_BUTTON_TARGETS[from] || "index.html";
  const back = document.getElementById("detail-back");
  // 보관 목록 팝업에서 자료명을 눌러 들어왔으면(favback=1) 돌아갈 주소에 favlist=1을 붙여,
  // 되돌아간 화면에서 그 팝업이 다시 열리게 한다(2026-09-05 CM 요청 — favorites.js가 받는다).
  if (back) back.setAttribute("href", params.get("favback") === "1" ? `${target}?favlist=1` : target);

  // 상단 메뉴는 들어온 화면이 눌려 있어야 한다(어디서 왔든 무조건 "TDB 조회"가 눌려 있던 버그 수정).
  document.querySelectorAll(".app-nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === target);
  });
}

// 이전/다음 — 방금 다녀온 목록(TDB 조회·TDB 관리·TDB 반출이력)의 순서를 그대로 따라간다.
// 목록을 거치지 않고 이 화면에 바로 왔으면(직접 URL 접근, 새로고침 등) 순서를 알 수 없어
// 두 버튼 다 비활성화한다. PDF가 없는 자료도 여기서는 그대로 이동 대상이다(상세보기는
// "PDF 없음" 안내로 대신 보여주면 되니 건너뛸 필요가 없다).
function setupDetailNav(docId) {
  const firstBtn = document.getElementById("detail-first-btn");
  const prevBtn = document.getElementById("detail-prev-btn");
  const nextBtn = document.getElementById("detail-next-btn");
  const lastBtn = document.getElementById("detail-last-btn");
  const countBox = document.getElementById("detail-nav-pos-input").closest(".detail-nav-count");
  const posInput = document.getElementById("detail-nav-pos-input");
  const totalEl = document.getElementById("detail-nav-total");

  const ids = getDetailNavList();
  // 같은 문서 id가 목록에 두 번 이상 나올 수 있어(중복반출로 분기 a/b 등 여러 행이 같은
  // 문서를 가리키는 경우) id만으로는 "지금 몇 번째 행"인지 알 수 없다. 링크 클릭 시 실어
  // 보낸 navpos가 그 문서 id와 실제로 맞아떨어지면 그걸 우선 쓰고, 아니면(직접 접근 등)
  // id로 처음 찾은 위치를 쓴다.
  const navposParam = new URLSearchParams(window.location.search).get("navpos");
  const navpos = navposParam !== null ? Number(navposParam) : NaN;
  const idx = !Number.isNaN(navpos) && ids[navpos] === Number(docId) ? navpos : ids.indexOf(Number(docId));

  if (idx === -1 || ids.length <= 1) {
    firstBtn.disabled = true;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    lastBtn.disabled = true;
    countBox.classList.add("hidden");
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  const fromQs = (from ? `&from=${from}` : "")
    // 보관 목록 팝업에서 들어왔다는 표시도 그대로 달고 다닌다 — 안 그러면 한 번 넘긴 뒤
    // [목록으로]가 그 팝업을 다시 열어주지 않는다(from을 달고 다니는 것과 같은 이유).
    + (params.get("favback") === "1" ? "&favback=1" : "");
  const goTo = async (i) => {
    if (!(await confirmLeaveWithMarkup())) return; // 미리보기에 저장 안 한 표시가 있으면 물어본다
    // 원본으로 바꿔 보던 중이면 다음 자료도 원본부터 보여준다(원본이 없는 자료는 사본).
    const pv = detailPreview?.preferOriginal ? "&pv=o" : "";
    // 미리보기에서 켜 둔 도구(손 도구 등)도 다음 자료로 그대로 이어 간다 (2026-10-15 CM 지시).
    const tool = detailPreview?.currentTool?.();
    const toolQs = tool ? `&tool=${encodeURIComponent(tool)}` : "";
    window.location.href = `detail.html?id=${ids[i]}${fromQs}&navpos=${i}${pv}${toolQs}`;
  };

  countBox.classList.remove("hidden");
  posInput.value = idx + 1;
  totalEl.textContent = ids.length;
  firstBtn.disabled = idx <= 0;
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= ids.length - 1;
  lastBtn.disabled = idx >= ids.length - 1;

  firstBtn.onclick = () => goTo(0);
  prevBtn.onclick = () => goTo(idx - 1);
  nextBtn.onclick = () => goTo(idx + 1);
  lastBtn.onclick = () => goTo(ids.length - 1);
  wireNavPosInput(posInput, () => ids.length, (n) => goTo(n - 1));
}

async function load() {
  await window.tdmsReady; // 권한(window.__tdmsPerms)에 따라 비고 작성 버튼을 다르게 그리므로 먼저 기다린다
  setupBackButton();
  const id = getDocId();
  if (!id) {
    document.querySelector(".page").innerHTML =
      '<div class="card card-pad empty">잘못된 접근입니다. 목록에서 도면을 선택해주세요.</div>';
    return;
  }

  const res = await fetch(`/documents/${id}`);
  if (!res.ok) {
    document.querySelector(".page").innerHTML =
      '<div class="card card-pad empty">문서를 찾을 수 없습니다.</div>';
    return;
  }
  const doc = await res.json();

  setupDetailNav(id);
  set("f-drawing_no", doc.display_name);
  set("f-source_path", doc.source_path);
  setHtml("f-current_rev", revLabel(doc));
  setHtml("f-status", statusBadge(doc.status));
  set("f-holding", holdingLabel(doc));

  // 상단 우측 다운로드 버튼. (미리보기에서 그린 것을 보관하는 자리는 미리보기 도구모음의
  //  [»] 안 [보관하기]·[다른 이름으로 보관]이다 — 2026-09-05 CM 지시로 여기 있던 하트는 없앴다.)
  const actions = document.getElementById("detail-actions");
  actions.innerHTML = "";
  if (doc.current_original_file_id) {
    actions.innerHTML += `<a href="/files/${doc.current_original_file_id}/download"><button type="button">원본 다운로드</button></a>`;
  }
  if (doc.current_pdf_file_id) {
    actions.innerHTML += `<a href="/files/${doc.current_pdf_file_id}/download"><button type="button">PDF 다운로드</button></a>`;
  }

  // 과거 Rev 폴더(P&ID·PFD)의 자료면 "최신 버전이 아닙니다" 안내창을 띄운다
  // (2026-09-29 CM 지시 — 규칙·안내창은 ui.js의 noticeIfOutdatedRev 한 곳에 있다).
  noticeIfOutdatedRev(doc.source_path);

  renderPdfArea(doc);
  renderRevisions(doc.revision_sets, doc);
  renderDistributions(doc.distributions, doc);
  makeColumnsResizable(document.getElementById("rev-table"));
  makeColumnsResizable(document.getElementById("detail-dist-table"));
  makeSortable(document.getElementById("rev-table"));
  makeSortable(document.getElementById("detail-dist-table"));

  document.getElementById("rev-approved-only").addEventListener("change", renderRevTable);
  document.getElementById("rev-export-btn").addEventListener("click", () => {
    window.location = `/documents/${id}/revisions/export`;
  });
  document.getElementById("detail-dist-export-btn").addEventListener("click", () => {
    window.location = `/documents/${id}/distributions/export`;
  });
}

load();
