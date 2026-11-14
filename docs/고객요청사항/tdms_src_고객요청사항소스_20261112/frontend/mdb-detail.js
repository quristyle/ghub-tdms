// MDB 자료 상세보기 — TDB 자료 상세보기(detail.js)와 같은 틀(목록으로/이전·다음/미리보기)을 쓰지만,
// MDB 자료는 documents처럼 리비전·반출 이력 개념이 없다. 그래서 Revision 이력·반출 이력 표 없이
// 자료내용 + 미리보기만 보여준다. 이전/다음 목록은 ui.js의 공용 저장소(TDB 조회 등 다른 화면들과
// 같은 키)를 그대로 쓴다 — MDB 조회(mdb.js)가 표를 그릴 때/전체 검색결과가 도착할 때 그 목록으로
// 채워둔다.
//
// 2026-08-29 CM 지시로 이 화면에서 Tag No·설비유형·자료유형을 **팝업 없이 그 자리에서**
// 고칠 수 있게 됐다(Note는 2026-08-30부터 Tag No 이력 팝업에서 고친다 — 아래 editNote). 자료를 하나씩 넘겨보면서 눈에 걸리는 것을 바로 고치는 것이 목적이다.
// 고치려면 권한(그룹) 관리의 "MDB 관리 > 자료 편집"이 Y여야 하고, 없으면 연필(✎) 버튼만
// 흐리게 보인다(내용은 누구나 그대로 본다 — 전 화면 공통 규칙).
// 저장은 MDB 관리의 "자료명·정보 변경"과 같은 주소(POST /mdb-editor/files/{id}/update-info)를
// 쓴다. 그래서 원본과 PDF 사본 양쪽에 같은 값이 저장되는 것도 그 화면과 똑같다.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// mdb.js의 shortProjectLabel과 같은 규칙(소속공사명 앞의 "2013. 08. - " 표기 제거).
function shortProjectLabel(name) {
  const stripped = String(name || "").replace(/^\d{4}\.\s*\d{1,2}\.\s*-\s*/, "").trim();
  return stripped || name || "-";
}

// formatFileSize는 ui.js 공용 함수를 쓴다 (삭제 보관함 완전삭제 안내와 같은 표기)

// 이 화면에서 값을 고치려면 있어야 하는 권한 — MDB 관리의 "자료 편집"과 같은 권한이다.
const EDIT_PERMISSION = "screen.mdb_editor.document";

let currentItem = null;     // 지금 보고 있는 자료(/mdb/files/{id} 응답) — 저장할 때 원래 값의 기준
let canEdit = false;        // 위 권한 보유 여부
let closeOpenEditor = null; // 지금 열려 있는 편집칸을 닫는 함수(한 번에 한 칸만 고친다)
let openEditField = null;   // 지금 고치는 중인 항목 이름(같은 ✎를 다시 누르면 그만두게)

function getFileId() {
  return new URLSearchParams(window.location.search).get("id");
}

// 이 화면이 팝업 안(<iframe>)에 띄워진 것인지 — MDB 관리의 [Tag No·유형 미분류 관리] 표에서
// 자료명을 누르면 이 화면이 그대로 팝업으로 뜬다(2026-08-30 CM 지시). 화면을 따로 만들지 않고
// 같은 화면을 쓰므로, 나중에 이 화면을 고치면 그 팝업도 함께 바뀐다.
function isEmbedded() {
  return new URLSearchParams(window.location.search).get("embed") === "1";
}

function set(id, value) {
  document.getElementById(id).textContent = value ?? "—";
}

// 위쪽 다운로드 버튼 — TDB 자료 상세보기처럼 원본과 PDF를 나눠 각각 받는다
// (2026-08-29 CM 지시. 그전에는 둘 다 있으면 [전체 다운로드] zip 하나뿐이었다).
// PDF만 있는 자료는 [PDF 다운로드]만, 원본만 있는 자료는 [원본 다운로드]만 나온다.
function renderDownloadButtons(doc) {
  const files = doc.files || [];
  const originals = files.filter((f) => !f.is_pdf);
  const pdf = files.find((f) => f.is_pdf);
  const btn = (fileId, label) =>
    `<a href="/mdb/files/${fileId}/download"><button type="button">${esc(label)}</button></a>`;

  // 원본은 보통 1개다. 형식이 다른 원본이 둘 이상 붙어 있으면(예: dwg + xls) 어느 것을
  // 받는 버튼인지 알 수 있게 형식을 함께 적는다.
  const html = originals
    .map((f) => btn(f.id, originals.length > 1
      ? `원본 다운로드 (${(f.file_ext || "").toUpperCase()})`
      : "원본 다운로드"))
    .join("") + (pdf ? btn(pdf.id, "PDF 다운로드") : "");

  // (미리보기에서 그린 것을 보관하는 자리는 미리보기 도구모음의 [»] 안 [보관하기]·
  //  [다른 이름으로 보관]이다 — 2026-09-05 CM 지시로 여기 있던 하트는 없앴다.)
  const actions = document.getElementById("detail-actions");
  actions.innerHTML = html;
}

// 미리보기 틀 — 이전/다음으로 넘어갈 때 "원본 우선"을 이어 가려고 들고 있는다.
let detailPreview = null;

function renderPreviewArea(doc) {
  const area = document.getElementById("pdf-area");
  const params = new URLSearchParams(window.location.search);
  // 사본·원본을 한 틀에서 바꿔 본다(D-102, ui.js mountDocPreview). 사본이 없으면 원본을 보여준다.
  // 보관 목록에서 열었으면(주소에 fav 번호가 있으면) 보관해 둔 편집 내용까지 되살려 연다.
  // 같은 자료를 다시 그릴 때(편집 저장 뒤 등)는 보던 틀을 그대로 둔다 — 새로 그리면 그리던 표시가 사라진다.
  if (detailPreview && detailPreview.docId === doc.id) return;
  detailPreview?.destroy();
  detailPreview = mountDocPreview(area, {
    source: mdbSource(doc.id),
    pdfUrl: doc.pdf_file_id ? `/mdb/files/${doc.pdf_file_id}/view` : null,
    name: doc.name,
    favId: params.get("fav"),
    preferOriginal: params.get("pv") === "o",
    // 이전/다음으로 넘어왔으면 그때 쓰던 도구(손 도구 등)를 그대로 켠 채 연다.
    tool: params.get("tool"),
    emptyHtml: `
      <div class="no-pdf-notice">
        <b>이 자료는 PDF가 없습니다.</b>
        우측 상단 다운로드 버튼으로 원본을 확인하세요.
      </div>`,
  });
  detailPreview.docId = doc.id;
}

// "목록으로" 버튼·상단 메뉴 체크 표시 — 들어온 화면(MDB 조회/MDB 관리)으로 되돌아간다.
// detail.js의 BACK_BUTTON_TARGETS와 같은 패턴.
const BACK_BUTTON_TARGETS = {
  "mdb-editor": "mdb-editor.html",
};
function setupBackButton() {
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  const target = BACK_BUTTON_TARGETS[from] || "mdb.html";
  const back = document.getElementById("detail-back");
  // 보관 목록 팝업에서 자료명을 눌러 들어왔으면(favback=1) 돌아갈 주소에 favlist=1을 붙여,
  // 되돌아간 화면에서 그 팝업이 다시 열리게 한다(2026-09-05 CM 요청 — favorites.js가 받는다).
  if (back) back.setAttribute("href", params.get("favback") === "1" ? `${target}?favlist=1` : target);

  document.querySelectorAll(".app-nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === target);
  });
}

// 이전/다음 — ui.js의 공용 저장소(dms_detail_nav_ids)를 그대로 쓴다. MDB 조회 화면에서 자료명을
// 눌러 들어왔으면 그 표(또는 검색조건 전체)의 순서를, 직접 URL로 들어왔으면 목록을 알 수 없어
// 두 버튼 다 비활성화한다.
function setupDetailNav(fileId) {
  const firstBtn = document.getElementById("detail-first-btn");
  const prevBtn = document.getElementById("detail-prev-btn");
  const nextBtn = document.getElementById("detail-next-btn");
  const lastBtn = document.getElementById("detail-last-btn");
  const countBox = document.getElementById("detail-nav-pos-input").closest(".detail-nav-count");
  const posInput = document.getElementById("detail-nav-pos-input");
  const totalEl = document.getElementById("detail-nav-total");

  const ids = getDetailNavList();
  const idx = ids.indexOf(Number(fileId));

  if (idx === -1 || ids.length <= 1) {
    firstBtn.disabled = true;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    lastBtn.disabled = true;
    countBox.classList.add("hidden");
    return;
  }

  // 어느 화면에서 들어왔는지(from)를 이전/다음으로 넘어갈 때도 그대로 달고 다닌다 —
  // 안 그러면 한 번 넘긴 뒤 [목록으로]가 MDB 관리가 아니라 MDB 조회로 가버린다.
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
    window.location.href = `mdb-detail.html?id=${ids[i]}${fromQs}${pv}${toolQs}`;
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

// ---------------------------------------------------------------------------
// 자료내용 표시
// ---------------------------------------------------------------------------

function renderInfo(item) {
  currentItem = item;

  set("f-name", item.name);
  // 분류(전용·공용·확인필요)는 Tag No·설비유형이 있는지 보고 시스템이 정하는 값이다. 직접
  // 고르는 칸이 아니라, 아래 Tag No·설비유형을 고쳐 저장하면 서버가 다시 계산해 내려준다.
  set("f-category", item.category);
  // 설비유형·자료유형은 여러 개면 슬래시로 이어진 값 그대로 보여준다("Pump/Strainer")
  set("f-equipment_type", item.equipment_type || "-");
  set("f-doc_type", item.doc_type || "-");
  set("f-year", item.year ?? "-");
  set("f-project", shortProjectLabel(item.project_name));
  set("f-source_path", item.source_path);

  // Tag No가 몇 개 붙어 있는지를 칩 앞에 함께 적는다(2026-09-01 CM 지시) — 칸이 좁아
  // 칩이 여러 줄로 늘어서면 눈으로 세기 어렵기 때문이다. 하나도 없으면 "—"만 두고 개수는 적지 않는다.
  const tagsEl = document.getElementById("f-tags");
  const tags = item.tags || [];
  tagsEl.innerHTML = tags.length
    ? `<span class="mdb-tag-count">총 ${tags.length}개</span>`
      + tags.map((t) => `<span class="mdb-chip">${esc(t)}</span>`).join(" ")
    : "—";

  renderNote(item);
}

// Note — Tag No 이력이 한 줄씩 쌓아 만든 기록이라(D-57), 밑줄로 이어 붙인 문장을 그대로 두면
// "무엇이 어떻게 바뀌었고 언제·어느 공사 일인지"가 눈에 안 들어온다는 CM 지적으로 표로 바꿨다
// (2026-09-01 CM 확정). 줄마다 구분·Tag No·연도·공사명·사유·비고가 같은 자리에 세로로 줄을
// 맞춰 서므로 여러 줄이 쌓여도 비교하기 쉽다. 조각은 서버가 그 줄을 남긴 이력에서 가져와
// 내려준다(note_items — app/mdb_note.py). 내용이 길어도 스크롤 없이 전부 펼친다(2026-08-28 CM 확정).
function renderNote(item) {
  const el = document.getElementById("f-note");
  const items = item.note_items || [];
  // 표를 그릴 때는 적은 줄바꿈을 그대로 살리는 규칙(.detail-note의 pre-wrap)을 꺼야 한다 —
  // 안 그러면 표 앞뒤의 줄바꿈·들여쓰기가 빈 줄로 나와 표가 라벨 아래로 밀린다.
  el.classList.remove("has-note-table");
  if (!items.length) {
    el.textContent = "—";
    return;
  }
  // 이력에서 온 줄이 하나도 없으면(사람이 예전에 적어둔 Note) 표로 만들 조각이 없으므로
  // 예전처럼 적은 글 그대로 보여준다.
  if (!items.some((it) => it.from_history)) {
    el.textContent = item.note;
    return;
  }
  el.classList.add("has-note-table");
  // 표를 그리는 코드(noteTableHtml)는 mdb-tag-history.js에 있다 — Tag No 이력 등록·수정·복사
  // 팝업의 문구 미리보기도 같은 표를 쓰기 때문이다(2026-09-01 CM 지시). 한쪽만 고쳐 적을 때
  // 보는 모양과 저장한 뒤 보는 모양이 달라지는 일이 없도록 한 곳에 둔다.
  el.innerHTML = noteTableHtml(items);
}

// ---------------------------------------------------------------------------
// 그 자리에서 고치기 (2026-08-29 CM 지시)
// ---------------------------------------------------------------------------
// 값 오른쪽 연필(✎)을 누르면 Note 줄 아래에 그 항목의 편집칸("Tag No 편집" 등)이 열리고
// [확인]/[취소]가 나온다. 누르는 즉시 저장하지 않는 것은 실수로 스치듯 고치는 걸 막기 위함으로,
// 표 안 비고 칸(ui.js wireNoteEdits)과 같은 방식이다. 한 번에 한 칸만 고친다 — 다른 ✎를 누르면
// 고치던 칸은 저장하지 않고 되돌아가고, 같은 ✎를 다시 누르면 고치기를 그만둔다.

function wireEditButtons() {
  document.querySelectorAll(".detail-edit-btn").forEach((btn) => {
    if (!canEdit) {
      btn.title = "고치려면 MDB 관리의 자료 편집 권한이 필요합니다";
      window.applyPermDisabled(btn);
      return;
    }
    btn.addEventListener("click", () => startEdit(btn.dataset.edit));
  });
}

// 편집칸을 열고 닫는 공통 처리 — 어느 항목의 ✎를 누르든 편집칸은 항상 같은 자리
// (자료내용 카드 맨 아래, Note 줄 다음)에 열린다. 값 칸은 감추지 않고 그대로 두고, 그 사이를
// 가로줄로 갈라 "위는 지금 적혀 있는 내용, 아래는 고치는 칸"으로 읽히게 한다 (2026-08-29 CM 지시).
// buildHtml: 편집칸 안에 넣을 HTML(반드시 [data-cancel] 버튼을 포함한다)
function openEditor(field, buildHtml) {
  if (closeOpenEditor) closeOpenEditor();

  const cell = document.getElementById(`fld-${field}`);
  const area = document.getElementById("detail-edit-area");
  // 제목은 항목 이름 뒤에 "편집"을 붙인다("Tag No 편집"). 이름은 위에 보이는 라벨을 그대로
  // 가져다 써서, 라벨만 바뀌고 편집칸 제목은 옛 이름으로 남는 일이 없게 한다.
  const label = cell.querySelector(".dt").textContent.trim();

  area.innerHTML = `<div class="detail-edit-title">${esc(label)} 편집</div>
    <div class="detail-edit">${buildHtml()}</div>`;
  area.classList.remove("hidden");
  cell.classList.add("is-editing");
  // 창이 짧으면 방금 열린 편집칸이 화면 아래로 넘어갈 수 있어, 안 보일 때만 살짝 끌어올린다.
  area.scrollIntoView({ block: "nearest" });

  const close = () => {
    area.classList.add("hidden");
    area.innerHTML = "";
    cell.classList.remove("is-editing");
    closeOpenEditor = null;
    openEditField = null;
  };
  closeOpenEditor = close;
  openEditField = field;

  area.querySelector("[data-cancel]").addEventListener("click", close);
  return { box: area, close };
}

// [확인] — 고친 값 하나만 바꿔서 자료 정보를 통째로 저장한다(주소가 값들을 한 번에 받는 방식이라
// 나머지는 지금 화면에 있는 값 그대로 함께 보낸다). 저장하면 서버가 돌려준 값으로 화면을 다시
// 그리므로, Tag No·설비유형을 고쳤을 때 분류도 그 자리에서 같이 바뀐다.
async function saveInfo(patch, okBtn) {
  const body = {
    filename: null, // 자료명은 이 화면에서 안 고친다(MDB 관리의 [자료명·정보 변경]에서 고친다)
    equipment_type: currentItem.equipment_type || null,
    doc_type: currentItem.doc_type || null,
    note: currentItem.note || null,
    tags: currentItem.tags || [],
    ...patch,
  };
  okBtn.disabled = true;
  const res = await fetch(`/mdb-editor/files/${currentItem.id}/update-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  okBtn.disabled = false;
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* 본문이 JSON이 아니면 상태문구 그대로 */ }
    await showAlert("저장하지 못했습니다: " + detail);
    return false;
  }
  const saved = await res.json();
  renderInfo(saved);
  // Tag No를 새로 달았고 그 Tag No에 "앞으로 자동 적용" 이력이 걸려 있으면 서버가 그 자리에서
  // 함께 넣는다 — 무엇이 들어갔는지 알려준다(2026-09-01 CM 확정, mdb-tag-history.js 공용).
  await showAutoAppliedAlert(saved);
  return true;
}

// 서버에 저장돼 있는 지금 자료 내용을 다시 받아 위쪽 자료내용 표시를 맞춘다.
// [확인]으로 저장하는 것과 달리, 유형 이름 바꾸기처럼 편집칸 안에서 곧바로 서버에 반영되는
// 것이 있어서 필요하다 — 이때 화면을 안 맞추면 [취소]로 나갔을 때 옛 이름이 그대로 남는다.
async function reloadCurrentItem() {
  const res = await fetch(`/mdb/files/${currentItem.id}`);
  if (res.ok) renderInfo(await res.json());
}

// 설비유형·자료유형 — MDB 관리의 [자료명·정보 변경] 팝업과 똑같은 체크박스 드롭다운을 쓴다
// (공용 코드는 mdb-types.js). 여러 개를 고르면 슬래시로 이어져 저장된다.
// 드롭다운 아래 입력칸에 적으면 목록에 없는 유형을 그 자리에서 새로 만들어 바로 고를 수 있고,
// 이미 목록에 있는 유형은 항목 오른쪽 ✎로 이름(문구)을 고칠 수 있다
// (2026-08-29 CM 지시 — 그전에는 MDB 관리 화면에서 목록을 먼저 손봐야 했다).
function editType(field) {
  const kind = field === "equipment_type" ? "equipment" : "doc";
  const label = TYPE_LISTS[kind].label;
  const { box, close } = openEditor(field, () => `
    <div class="detail-edit-col">
      <div class="detail-edit-row">
        <div class="hideable-dropdown type-dropdown" id="ed-${field}-dd">
          <button type="button" class="dropdown-toggle"></button>
          <div class="dropdown-list hidden"></div>
        </div>
      </div>
      <div class="detail-edit-row">
        <input type="text" id="ed-${field}-new" placeholder="새 ${label} 입력 후 Enter (목록에 함께 등록됩니다)" />
        <button type="button" class="small" id="ed-${field}-add">추가</button>
        <button type="button" class="small primary" data-ok>확인</button>
        <button type="button" class="small" data-cancel>취소</button>
      </div>
    </div>`);

  const dropdown = createTypeCheckDropdown(`ed-${field}-dd`, kind, currentItem[field], {
    emptyHint: "아래 칸에 적어 새로 만들 수 있습니다.",
    // 목록 항목 오른쪽 ✎ — 이름을 바꾸면 마스터 목록과 함께, 이미 이 유형으로 지정돼 있는
    // 다른 자료들의 값도 서버가 같이 바꾼다(mdb-types.js renameTypeInList).
    onRename: async (oldName, newName) => {
      const result = await renameTypeInList(kind, oldName, newName, dropdown);
      if (result.message) await showAlert(result.message);
      // 지금 보고 있는 자료도 그 유형이면 값이 이미 바뀌었으므로 위쪽 표시를 다시 받아 맞춘다
      if (result.ok) await reloadCurrentItem();
    },
  });
  const newInput = box.querySelector(`#ed-${field}-new`);
  const addBtn = box.querySelector(`#ed-${field}-add`);
  const okBtn = box.querySelector("[data-ok]");

  // 적은 이름으로 유형을 새로 만들어 체크까지 해준다(mdb-types.js addTypeToList).
  // 만들었거나 적은 게 없으면 true, 만들지 못했으면 false — 저장을 멈추고 고칠 기회를 준다.
  async function addTypedName() {
    if (!newInput.value.trim()) return true;
    addBtn.disabled = true;  // 두 번 눌러 같은 유형을 두 번 만들려 하지 않게(saveInfo와 같은 방식)
    const result = await addTypeToList(kind, newInput.value, dropdown);
    addBtn.disabled = false;
    if (result.message) await showAlert(result.message);
    if (!result.ok) return false;
    newInput.value = "";
    return true;
  }

  addBtn.addEventListener("click", addTypedName);
  newInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addTypedName();
  });
  okBtn.addEventListener("click", async () => {
    // Enter를 안 누르고 [확인]을 눌러도 적어둔 유형이 사라지지 않게 먼저 반영한다
    // (Tag No 칸과 같은 방식).
    if (!(await addTypedName())) return;
    if (await saveInfo({ [field]: dropdown.getValue() || null }, okBtn)) close();
  });
}

// Tag No — MDB 관리의 [자료명·정보 변경] 팝업과 같은 방식. 이미 들어있는 것을 누르면 아래
// 입력칸으로 올라와 그 자리 값을 고칠 수 있고, ×를 누르면 지운다. 적은 그대로 저장하되
// 대소문자만 다른 것은 같은 설비로 보고 중복을 막는다(2026-08-28 CM 확정).
function editTags() {
  let tags = [...(currentItem.tags || [])];
  let editingIndex = -1; // -1이면 새로 추가하는 중

  const { box, close } = openEditor("tags", () => `
    <div class="detail-edit-col">
      <div class="mdb-chip-area" id="ed-tag-chips"></div>
      <div class="detail-edit-row">
        <input type="text" id="ed-tag-input" placeholder="Tag No 입력 후 Enter (쉼표·슬래시로 여러 개, 예: TM1303A/B/C, MOV1351/1416/1417)" />
        <button type="button" class="small" id="ed-tag-add">입력</button>
        <button type="button" class="small primary" data-ok>확인</button>
        <button type="button" class="small" data-cancel>취소</button>
      </div>
    </div>`);

  const chipArea = box.querySelector("#ed-tag-chips");
  const input = box.querySelector("#ed-tag-input");
  const addBtn = box.querySelector("#ed-tag-add");
  const okBtn = box.querySelector("[data-ok]");

  function renderChips() {
    chipArea.innerHTML = tags.length
      ? tags.map((t, i) => `<span class="mdb-chip is-clickable${i === editingIndex ? " is-editing" : ""}" data-idx="${i}" title="누르면 아래 입력칸에서 고칠 수 있습니다">${esc(t)}<button type="button" data-rm="${i}" title="지우기">×</button></span>`).join("")
      : '<span class="detail-edit-hint">아직 적어둔 Tag No가 없습니다.</span>';
    chipArea.querySelectorAll("[data-rm]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation(); // 지우기(×)는 칩 클릭(고치기)으로 번지지 않게 한다
        const i = Number(b.dataset.rm);
        tags.splice(i, 1);
        // 고치는 중이던 것을 지우면 고치기를 그만두고, 그 앞을 지우면 자리가 하나씩 당겨진다.
        if (editingIndex === i) { cancelEditTag(); return; }
        if (editingIndex > i) editingIndex -= 1;
        renderChips();
      });
    });
    chipArea.querySelectorAll("[data-idx]").forEach((chip) => {
      chip.addEventListener("click", () => startEditTag(Number(chip.dataset.idx)));
    });
  }

  function sameTagIndex(v, exceptIndex) {
    const key = v.toUpperCase();
    return tags.findIndex((t, i) => i !== exceptIndex && t.toUpperCase() === key);
  }

  // 입력칸이 "추가" 상태인지 "고치는 중"인지를 버튼 글자·안내문구로 알려준다.
  function updateTagInputMode() {
    const editing = editingIndex >= 0;
    addBtn.textContent = editing ? "수정" : "입력";
    input.placeholder = editing
      ? "고친 뒤 Enter (Esc를 누르면 고치기 취소)"
      : "Tag No 입력 후 Enter (쉼표·슬래시로 여러 개, 예: TM1303A/B/C, MOV1351/1416/1417)";
  }

  function startEditTag(i) {
    editingIndex = i;
    input.value = tags[i];
    renderChips();
    updateTagInputMode();
    input.focus();
    input.select();
  }

  function cancelEditTag() {
    editingIndex = -1;
    input.value = "";
    renderChips();
    updateTagInputMode();
  }

  // 넣었거나 고쳤으면 true, 중복이라 하나도 못 넣었으면 false.
  // 쉼표로 여러 개를 한 번에 적으면(예: "TM1101, TM1102, T1103") 각각 나눠서 등록하고,
  // 슬래시가 있으면 그 안에서 한 번 더 나눈다(예: "TM1303A/B/C"·"MOV1351/1416/1417" → 각 3개).
  // 나누는 규칙은 두 화면이 똑같이 움직이도록 mdb-types.js의 expandSlashTag 한 곳에만 있다.
  // 고치는 중이었다면 맨 처음 값이 그 자리를 대신하고 나머지는 새로 추가된다.
  async function applyTagFromInput() {
    const parts = input.value.split(",").map((s) => s.trim()).filter(Boolean)
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
    if (added || toAdd.length > 1) chipArea.scrollTop = chipArea.scrollHeight;
    if (dups.length) await showAlert(`이미 들어있어 제외된 Tag No: ${dups.join(", ")}`);
    return true;
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editingIndex >= 0) {
      e.preventDefault();
      cancelEditTag();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    applyTagFromInput();
  });
  addBtn.addEventListener("click", applyTagFromInput);
  okBtn.addEventListener("click", async () => {
    // Enter를 안 누르고 [확인]을 눌러도 입력칸에 적어둔 Tag No가 사라지지 않게 먼저 반영한다.
    if (input.value.trim() && !(await applyTagFromInput())) return;
    if (await saveInfo({ tags }, okBtn)) close();
  });

  renderChips();
  updateTagInputMode();
  input.focus();
}

// Note — 이 화면에서는 글을 자유롭게 고치지 않는다 (2026-08-30 CM 지시).
// 자료의 Note는 Tag No 이력이 한 줄씩 쌓아 만든 것이라(2026-08-30 확정), 여기서 글자만
// 고치면 이력에 적힌 문장과 어긋나 되돌리기가 그 줄을 못 찾는다. 그래서 ✎를 누르면
// MDB 관리 [Tag No 이력관리]의 [수정]과 **같은 팝업**이 뜬다(mdb-tag-history.js 공용 코드 —
// 나중에 MDB 관리에서 그 팝업을 고치면 이 화면에도 그대로 반영된다).
// 이 팝업은 아래 편집칸이 아니라 화면 위에 뜨므로, 열려 있던 편집칸은 먼저 닫는다.
let noteEditorOpening = false; // 팝업이 뜨기 전에 ✎를 두 번 눌러 두 개가 겹쳐 뜨지 않게

async function editNote() {
  if (noteEditorOpening) return;
  if (closeOpenEditor) closeOpenEditor();
  noteEditorOpening = true;
  try {
    await openNoteHistoryEditor(currentItem.note, currentItem.tags, {
      // 이력이 자료의 Tag No·Note를 바꾸므로 지금 보고 있는 자료를 다시 받아 화면을 맞춘다
      onSaved: reloadCurrentItem,
    });
  } finally {
    noteEditorOpening = false;
  }
}

function startEdit(field) {
  // 고치는 중인 항목의 ✎를 다시 누르면 고치기를 그만둔다(적던 것은 저장하지 않는다).
  if (openEditField === field) return closeOpenEditor();
  if (field === "tags") return editTags();
  if (field === "note") return editNote();
  return editType(field); // equipment_type · doc_type
}

// ---------------------------------------------------------------------------

async function load() {
  const id = getFileId();
  if (!id) {
    document.querySelector(".page").innerHTML =
      '<div class="card card-pad empty">잘못된 접근입니다. 목록에서 자료를 선택해주세요.</div>';
    return;
  }

  const res = await fetch(`/mdb/files/${id}`);
  if (!res.ok) {
    document.querySelector(".page").innerHTML =
      '<div class="card card-pad empty">자료를 찾을 수 없습니다.</div>';
    return;
  }
  const doc = await res.json();

  // 팝업 안에 띄운 것(?embed=1)이면 [목록으로]·이전/다음이 갈 곳이 없다 — 걸지 않고,
  // 위쪽 머리말·메뉴와 함께 감춘다(mdb.css의 body.detail-embed).
  if (isEmbedded()) {
    document.body.classList.add("detail-embed");
  } else {
    setupBackButton();
    setupDetailNav(id);
  }
  renderInfo(doc);
  renderDownloadButtons(doc);
  renderPreviewArea(doc);

  // 권한에 따라 연필(✎)을 살리거나 흐리게 한다(auth-guard.js의 /auth/me 응답을 기다린 뒤).
  // 설비유형·자료유형 후보 목록은 고칠 수 있는 사람에게만 필요하므로 그때만 받아온다.
  await window.tdmsReady;
  canEdit = !!(window.__tdmsPerms && window.__tdmsPerms.has(EDIT_PERMISSION));
  if (canEdit) await loadTypeLists();
  wireEditButtons();
}

load();
