// Tag No 이력 등록·수정 팝업 — MDB 관리와 MDB 자료 상세보기가 함께 쓴다.
//
// 설비 Tag No가 현장에서 바뀌면(P1000A 펌프가 P1700A로 바뀜) 그 설비 자료 수십 건에 새 번호를
// 함께 달아두고, 왜 Tag No가 두 개인지 Note에 남겨야 한다. 자료를 하나씩 찾아 고치는 것은
// 사실상 불가능해서, 이력 한 줄을 등록하면 그 Tag No가 붙은 자료 전부에 같은 처리가 한 번에
// 들어가게 한 것이 이 기능이다(2026-08-30 CM 확정). Note는 덮어쓰지 않고 한 줄씩 쌓인다.
//
// 원래 MDB 관리(mdb-editor.js) 안에만 있던 코드인데, MDB 자료 상세보기의 Note ✎가 자유롭게
// 글을 고치는 칸 대신 **이 팝업**을 열게 되면서(2026-08-30 CM 지시) 두 화면이 같이 쓰게 됐다.
// 파일 하나로 나눠둔 이유는 mdb-types.js와 같다 — 나중에 이 팝업을 고치면 두 화면에 똑같이
// 반영되어야 하고, 한쪽만 고쳐져 서로 다르게 동작하는 일이 없어야 하기 때문이다.
// 쓰는 화면: MDB 관리(mdb-editor.html) · MDB 자료 상세보기(mdb-detail.html)
//
// 이력 목록 팝업([Tag No 이력관리] 표와 [다시 적용]·[되돌리기])은 MDB 관리에만 있으므로
// mdb-editor.js에 그대로 둔다.

// [적용] 드롭다운 — 값·문구를 서버(mdb_tag_history.py ACTION_LABELS)와 똑같이 맞춘다.
const TAG_HISTORY_ACTIONS = [
  { value: "ADD", label: "Tag No 추가", hint: "" },
  { value: "RENAME", label: "Tag No 변경",
    hint: "대상 Tag No를 빼고 새 Tag No로 바꿔 답니다. 옛 번호로는 더 이상 찾을 수 없습니다." },
  { value: "REMOVE", label: "Tag No 삭제",
    hint: "대상 Tag No를 뺍니다. 다른 Tag No는 그대로 둡니다." },
  { value: "NOTE_ONLY", label: "Note만 작성",
    hint: "Tag No는 그대로 두고 Note 문구만 남깁니다." },
];
const TAG_HISTORY_NEW_TAG_ACTIONS = ["ADD", "RENAME"];
// Note 문구 맨 앞에 붙는 구분. 실제로 시스템에서 하는 작업과 현장에서 일어난 일이 다를 수
// 있어서(예: 시스템에서는 새 Tag No를 "추가"하지만 현장에서 일어난 일은 "변경") 따로 고른다.
const TAG_HISTORY_NOTE_LABELS = ["Tag No 변경", "Tag No 추가", "Tag No 삭제"];
// Tag No가 바뀐 것을 나타내는 화살표. "->"가 아니라 화살표 기호를 쓴다(2026-08-30 CM 지시).
// 서버(mdb_tag_history.py의 NOTE_ARROW)와 반드시 같은 글자여야 미리보기와 실제 Note가 같다.
const NOTE_ARROW = "→";

// 팝업의 "공사명" 드롭다운에 쓸 MDB 폴더트리 최상위 폴더 (2026-09-01 CM 지시).
// 화면마다 따로 받지 않도록 여기 담아둔다(이 파일이 혼자 쓸 수 있어야 MDB 관리와 MDB 자료
// 상세보기 두 화면에서 똑같이 열린다).
//
// 공사 표(projects)를 안 쓴다 — 그 표에는 MDB에 폴더가 없는 도면 쪽 공사도 섞여 있고,
// 반대로 숨김 처리된 공사는 빠져 실제 폴더와 어긋나기 때문이다(예: MDB 폴더가 실제로 있는
// "2017. 06. - LBO T1302 1기 용도 변경 공사"가 숨김이라 고를 수 없었다).
const tagHistoryCache = { folders: [] };

async function ensureTagHistoryFolders() {
  if (tagHistoryCache.folders.length === 0) {
    tagHistoryCache.folders = await (await fetch("/mdb-tag-history/project-folders")).json();
  }
}

// 적용·되돌리기·수정을 마친 뒤 알려주는 문구 (이력 목록 팝업도 같은 문구를 쓴다)

function tagHistoryResultMessage(data, what) {
  return (
    `${what} 완료 — 자료 ${data.doc_count}건\n` +
    `· Tag No가 바뀐 자료 ${data.tag_changed_docs}건\n` +
    `· Note가 바뀐 자료 ${data.note_changed_docs}건`
  );
}

// 줄을 여러 개 적어 이력이 한 번에 여러 건 만들어졌을 때 (2026-09-01 CM 지시).
// 1건이면 예전과 똑같은 문구를 그대로 쓴다.
function tagHistoryMultiResultMessage(results, what) {
  if (results.length === 1) return tagHistoryResultMessage(results[0].data, what);
  const lines = [`${what} 완료 — 이력 ${results.length}건`, ""];
  results.forEach(({ tag, data }) => {
    lines.push(
      `· ${tag} — 자료 ${data.doc_count}건 ` +
      `(Tag No ${data.tag_changed_docs}건 / Note ${data.note_changed_docs}건)`
    );
  });
  return lines.join("\n");
}

// 작업(action)이 Tag No를 어떻게 바꾸는지 한 줄로 — 등록 확인창과 자동 적용 알림이 같이 쓴다.
function tagChangeLine(action, baseTag, newTag) {
  if (action === "ADD") return `Tag No 추가: ${newTag}`;
  if (action === "RENAME") return `Tag No 변경: ${baseTag} ${NOTE_ARROW} ${newTag}`;
  if (action === "REMOVE") return `Tag No 삭제: ${baseTag}`;
  return "";  // Note만 작성 — Tag No는 그대로 둔다
}

// ---------------------------------------------------------------------------
// Note 한 줄을 표로 그리기 — MDB 자료 상세보기의 Note 칸과 이 팝업의 문구 미리보기가 함께 쓴다.
//
// Note는 조각(구분·Tag No·연도·공사명·사유·비고)을 밑줄로 이어 붙인 문장이라 그대로 두면
// 무엇이 어떻게 바뀌었는지 눈에 안 들어온다(2026-09-01 CM 확정). 상세보기에서 이미 표로
// 보여주고 있으므로, **이력 등록·수정·복사 팝업의 미리보기도 같은 표**로 보여준다
// (2026-09-01 CM 지시) — 적으면서 보는 모양과 저장한 뒤 보는 모양이 같아야 하기 때문이다.
//
// 그래서 표를 그리는 코드를 두 화면이 함께 쓰는 이 파일에 둔다. 한쪽만 고쳐 미리보기와 실제
// Note가 다르게 보이는 일이 없어야 한다(mdb-types.js를 나눠둔 것과 같은 판단).
//
// items : 서버가 내려주는 note_items 모양 그대로
//         { text, from_history, label, base_tag, new_tag, year, project, reason, memo }
//         팝업 미리보기는 지금 적고 있는 값으로 이 모양을 하나 만들어 넘긴다.
// ---------------------------------------------------------------------------

const NOTE_TABLE_COLUMNS = ["구분", "Tag No", "연도", "공사명", "사유·비고"];

function noteTableHtml(items) {
  return `
    <div class="note-table-wrap">
      <table class="note-table">
        <thead>
          <tr>${NOTE_TABLE_COLUMNS.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>
        </thead>
        <tbody>${items.map(noteTableRow).join("")}</tbody>
      </table>
    </div>`;
}

// 값이 없는 칸은 다른 표들과 같이 "-"로 채워 칸이 비어 보이지 않게 한다.
function noteTableCell(value) {
  return value ? esc(value) : '<span class="muted">-</span>';
}

function noteTableRow(it) {
  // 이력에서 온 줄이 아니면 나눌 조각이 없다 — 칸을 합쳐 적힌 그대로 한 줄로 보여준다.
  if (!it.from_history) {
    return `<tr class="note-row-raw"><td colspan="${NOTE_TABLE_COLUMNS.length}">${esc(it.text)}</td></tr>`;
  }
  const tag = it.new_tag
    ? `${esc(it.base_tag)} <span class="note-arrow">${NOTE_ARROW}</span> ${esc(it.new_tag)}`
    : esc(it.base_tag || "");
  const reason = [it.reason, it.memo].filter(Boolean).join(" · ");
  return `
    <tr title="${esc(it.text)}">
      <td class="note-label">${noteTableCell(it.label)}</td>
      <td class="note-tag">${tag || '<span class="muted">-</span>'}</td>
      <td class="note-year">${noteTableCell(it.year)}</td>
      <td>${noteTableCell(it.project)}</td>
      <td>${noteTableCell(reason)}</td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// 자료를 저장할 때 자동으로 함께 들어간 Tag No 이력 알리기 (2026-09-01 CM 확정)
//
// "묻지 않고 넣되 무엇이 들어갔는지는 알려준다"가 CM이 고른 방식이다. 자료에 Tag No를 새로
// 달면 그 Tag No에 걸어둔 이력(등록할 때 [앞으로 이 Tag No가 붙는 자료에도 자동으로 적용]을
// 켜둔 것)이 서버에서 그 자리에 들어가고, 무엇이 들어갔는지가 저장 응답에 담겨 온다.
// MDB 관리 [자료명·정보 변경]과 MDB 자료 상세보기의 Tag No ✎가 같이 쓴다.
// ---------------------------------------------------------------------------

async function showAutoAppliedAlert(saved) {
  const list = (saved && saved.auto_applied) || [];
  if (list.length === 0) return;

  const lines = ["저장했습니다.", "", "아래 Tag No 이력이 함께 적용됐습니다.", ""];
  list.forEach((it) => {
    if (it.tag_added) {
      const line = tagChangeLine(it.action, it.base_tag, it.new_tag);
      if (line) lines.push(`· ${line}`);
    }
    if (it.note_added) lines.push(`· Note 한 줄 추가: ${it.note_line}`);
  });
  await showAlert(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 새 이력 등록 / 이력 수정 — 같은 팝업을 쓴다(칸 구성이 똑같아 둘로 나눌 이유가 없다).
// 등록하면 그 자리에서 바로 적용되고, 수정하면 이미 자료에 들어가 있던 예전 내용을 빼고
// 고친 내용으로 다시 넣는다(서버 PATCH /mdb-tag-history/{id}).
// 뒤에 열려 있던 팝업(이력 목록 등)을 지우지 않도록 레이어로 쌓는다(공통 규칙).
//
// editing    : [수정]으로 열었을 때 그 이력 1줄(목록에서 받은 값). 비우면 새 등록.
// onSaved    : 저장한 뒤 할 일 — 화면마다 다르다(MDB 관리는 이력 목록·결과 표를 다시 그리고,
//              MDB 자료 상세보기는 보고 있는 자료를 다시 받아 Note를 새로 그린다).
// prefillTag : 새 등록으로 열 때 대상 Tag No 칸에 미리 채워둘 값.
// copyFrom   : [복사]로 열었을 때 베껴올 이력 1줄(2026-08-31 CM 지시). 칸은 그 이력 그대로
//              채워지지만 **새 이력 등록**이다(editing이 아니다) — 저장하면 원래 이력은 그대로
//              두고 새 이력이 하나 더 생긴다. 비슷한 이력을 여러 번 남길 때 같은 값을 매번
//              다시 적지 않기 위한 것으로, 몇 칸만 고쳐 등록하면 된다.
// ---------------------------------------------------------------------------

async function openTagHistoryForm(editing = null, { onSaved = null, prefillTag = "", copyFrom = null } = {}) {
  await ensureTagHistoryFolders();
  await loadTypeList("reason");

  const actionOptions = TAG_HISTORY_ACTIONS
    .map((a) => `<option value="${a.value}">${esc(a.label)}</option>`).join("");
  const noteLabelOptions = TAG_HISTORY_NOTE_LABELS
    .map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box th-form-box">
        <p class="modal-title">${editing ? "이력 수정" : "새 이력 등록"}</p>

        <label class="checkbox-line th-check-line th-bulk-line">
          <input type="checkbox" id="thf-bulk" />
          <span>적용 내용 일괄 반영</span>
        </label>

        <div class="th-tag-row th-tag-head">
          <span class="field-label">대상 Tag No</span>
          <span class="field-label">적용 내용</span>
          <span></span>
        </div>
        <div id="thf-rows"></div>
        <p id="thf-action-hint" class="modal-hint-text th-action-hint"></p>
        <button type="button" id="thf-add-row" class="th-add-row">행 추가</button>
        <div id="thf-targets" class="th-target-box"></div>

        <div class="th-section">
          <label class="checkbox-line th-check-line">
            <input type="checkbox" id="thf-write-note" checked />
            <span>Note 작성</span>
          </label>

          <div id="thf-note-fields" class="th-note-fields">
            <div class="th-two-col">
              <div>
                <label class="field-label">구분</label>
                <select id="thf-label">${noteLabelOptions}</select>
              </div>
              <div>
                <label class="field-label">공사명</label>
                <select id="thf-project-folder"></select>
              </div>
            </div>

            <label class="field-label">사유</label>
            <div class="di-equip-row">
              <select id="thf-reason"></select>
              <button type="button" class="small" id="thf-reason-manage" title="사유 목록 편집">✎</button>
            </div>

            <label class="field-label">비고 (선택)</label>
            <input type="text" id="thf-memo" placeholder="자유롭게 적어주세요" />

            <label class="field-label">Note에 들어갈 문구</label>
            <div id="thf-preview" class="th-preview"></div>
          </div>
        </div>

        <div class="th-section th-auto-box">
          <label class="checkbox-line th-check-line">
            <input type="checkbox" id="thf-auto" checked />
            <span>해당 Tag No 생성 시 이력 수정 자동 적용</span>
          </label>
        </div>

        <div class="modal-actions">
          <button type="button" id="thf-cancel">취소</button>
          <button type="button" class="primary" id="thf-apply">${editing ? "수정" : "적용"}</button>
        </div>
      </div>
    </div>`);

  const bulkCb = layer.querySelector("#thf-bulk");
  const rowsBox = layer.querySelector("#thf-rows");
  const actionHint = layer.querySelector("#thf-action-hint");
  const targetsBox = layer.querySelector("#thf-targets");
  const writeNoteCb = layer.querySelector("#thf-write-note");
  const noteFields = layer.querySelector("#thf-note-fields");
  const labelSel = layer.querySelector("#thf-label");
  const projectSel = layer.querySelector("#thf-project-folder");
  const reasonSel = layer.querySelector("#thf-reason");
  const memoInput = layer.querySelector("#thf-memo");
  const preview = layer.querySelector("#thf-preview");
  const autoCb = layer.querySelector("#thf-auto");

  // [수정]은 고칠 이력을, [복사]는 베껴올 이력을 칸에 그대로 채운다 — 채우는 방법이 같아
  // 한 곳에서 함께 처리한다. 다른 점은 저장할 때뿐이다(수정은 그 이력을 고치고, 복사는
  // 새 이력을 하나 더 만든다). 대상 Tag No·적용 내용은 아래 첫 줄을 만들 때 채운다.
  const filled = editing || copyFrom;
  if (filled) {
    writeNoteCb.checked = filled.write_note;
    autoCb.checked = !!filled.auto_apply;
    if (filled.note_label) labelSel.value = filled.note_label;
    memoInput.value = filled.note_memo || "";
  }

  // -------------------------------------------------------------------------
  // 대상 Tag No 줄 (2026-09-01 CM 지시)
  //
  // 예전에는 대상 Tag No가 한 칸뿐이라, Tag No를 여러 개 손보려면 팝업을 그만큼 여러 번
  // 열어 같은 Note 문구를 매번 다시 적어야 했다. 이제 [행 추가]로 줄을 늘려 한 번에 적고,
  // **저장하면 대상 Tag No 하나당 이력 1건씩** 따로 만들어져 목록에 각각 한 줄로 들어간다.
  // Note 문구(구분·공사명·사유·비고)는 줄들이 함께 쓴다.
  //
  // 줄을 지우는 버튼은 두지 않았다 — 잘못 늘렸으면 대상 Tag No를 비워두면 되고, 비어 있는
  // 줄은 저장할 때 그냥 넘어간다.
  // -------------------------------------------------------------------------
  const rows = [];

  function rowNeedsNewTag(row) {
    return TAG_HISTORY_NEW_TAG_ACTIONS.includes(row.actionSel.value);
  }

  function updateRowMode(row) {
    row.newTagInput.disabled = !rowNeedsNewTag(row);
    if (row.newTagInput.disabled) row.newTagInput.value = "";
  }

  function makeRow(initial = {}) {
    const el = document.createElement("div");
    el.className = "th-tag-row";
    el.innerHTML = `
      <input type="text" class="thf-tag" placeholder="예: P1000A" />
      <select class="thf-action">${actionOptions}</select>
      <input type="text" class="thf-new-tag" placeholder="새 Tag No 입력" />`;
    rowsBox.appendChild(el);

    const row = {
      el,
      tagInput: el.querySelector(".thf-tag"),
      actionSel: el.querySelector(".thf-action"),
      newTagInput: el.querySelector(".thf-new-tag"),
      targets: null,   // 서버에서 받은 "바뀔 자료" — null이면 아직 안 받아온 것
      loading: false,
      timer: null,
    };
    row.tagInput.value = initial.tag || "";
    if (initial.action) row.actionSel.value = initial.action;
    row.newTagInput.value = initial.newTag || "";
    rows.push(row);
    updateRowMode(row);

    row.tagInput.addEventListener("input", () => { updatePreview(); scheduleTargets(row); });
    row.actionSel.addEventListener("change", () => {
      // 맨 위 줄을 고치면 아래 줄도 함께 바뀐다([적용 내용 일괄 반영]이 켜져 있을 때)
      if (bulkCb.checked && rows[0] === row) applyBulkAction();
      updateRowMode(row);
      updateHint();
      updatePreview();
    });
    row.newTagInput.addEventListener("input", updatePreview);
    return row;
  }

  // --- [적용 내용 일괄 반영] ------------------------------------------------
  // 켜면 맨 위 줄의 적용 내용이 아래 줄 전부에 그대로 들어가고, 아래 줄의 적용 내용 칸은
  // 회색으로 잠겨 못 고친다 — 줄마다 다른 값이 남아 있으면 "일괄"이라는 말과 어긋나므로.
  function applyBulkAction() {
    if (rows.length === 0) return;
    rows.forEach((r, i) => {
      if (i === 0) return;
      r.actionSel.value = rows[0].actionSel.value;
      updateRowMode(r);
    });
  }
  function syncBulkLock() {
    rows.forEach((r, i) => { r.actionSel.disabled = bulkCb.checked && i > 0; });
  }
  bulkCb.addEventListener("change", () => {
    if (bulkCb.checked) applyBulkAction();
    syncBulkLock();
    updateHint();
    updatePreview();
  });

  // 줄마다 적용 내용이 다를 수 있으므로, 지금 쓰이는 것의 설명만 모아 보여준다(같은 것은 한 번).
  function updateHint() {
    const hints = [];
    rows.forEach((r) => {
      const conf = TAG_HISTORY_ACTIONS.find((a) => a.value === r.actionSel.value);
      if (conf && conf.hint && !hints.includes(conf.hint)) hints.push(conf.hint);
    });
    actionHint.textContent = hints.join("\n");
    // 설명이 없는 것([Tag No 추가])만 쓰면 빈 줄만큼 자리가 뜨지 않게 아예 감춘다
    actionHint.style.display = hints.length ? "" : "none";
  }

  layer.querySelector("#thf-add-row").addEventListener("click", () => {
    // 일괄 반영이 켜져 있으면 새 줄도 처음부터 맨 위 줄과 같은 적용 내용으로 만든다
    const row = makeRow(bulkCb.checked && rows[0] ? { action: rows[0].actionSel.value } : {});
    syncBulkLock();
    updateHint();
    updatePreview();
    row.tagInput.focus();
  });

  // --- 사유 드롭다운 -------------------------------------------------------
  // 고른 값을 화면 밖(변수)에도 들고 있는다 — 목록을 다시 그릴 때(추가·이름변경) 고르던
  // 값이 사라지지 않게 하기 위함이다.
  let chosenReason = (filled && filled.note_reason) || "";
  function fillReasonSelect() {
    // 이미 고른 사유가 목록에 없으면(그 사이 숨겼거나 지운 사유 — [수정]으로 옛 이력을 열 때
    // 생긴다) 맨 위에 "(목록에 없음)"으로 그대로 보여준다. 조용히 빠지면 Note 문구가 저 혼자
    // 바뀌기 때문이다(설비유형·자료유형과 같은 규칙).
    const master = typeListCache.reason.map((t) => t.name);
    const missing = chosenReason && !master.includes(chosenReason)
      ? `<option value="${esc(chosenReason)}">${esc(chosenReason)} (목록에 없음)</option>` : "";
    reasonSel.innerHTML = '<option value="">(고르지 않음)</option>' + missing +
      typeListCache.reason.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
    reasonSel.value = [...reasonSel.options].some((o) => o.value === chosenReason) ? chosenReason : "";
    updatePreview();
  }
  // openTypeListManager가 목록을 고칠 때마다 불러주는 창구(설비유형·자료유형의 체크박스
  // 드롭다운과 같은 자리). 여기서는 하나만 고르는 보통 드롭다운이라 이렇게 맞춰준다.
  const reasonDropdown = {
    reloadOptions: () => fillReasonSelect(),
    addSelected: (name) => { chosenReason = name; fillReasonSelect(); },
    renameSelection: (oldName, newName) => {
      if (chosenReason === oldName) chosenReason = newName;
      fillReasonSelect();
    },
  };
  reasonSel.addEventListener("change", () => { chosenReason = reasonSel.value; updatePreview(); });
  layer.querySelector("#thf-reason-manage").addEventListener("click", () => {
    openTypeListManager("reason", reasonDropdown, { layered: true });
  });

  // --- 공사명 드롭다운 (연도는 여기서 함께 정해진다) ------------------------
  // 항목으로는 MDB 폴더트리 최상위 폴더 이름을 그대로 보여주고("2016. 02. - Yu4A 배합 개선 공사"),
  // 고르면 Note에는 앞 날짜를 뗀 공사명("Yu4A 배합 개선 공사")과 연도("2016년")가 들어간다
  // (2026-09-01 CM 지시). 그래서 연도를 직접 적는 칸은 없앴다.
  let chosenProject = (filled && filled.note_project) || "";  // Note에 적힐 공사명
  let chosenYear = (filled && filled.note_year) || "";        // Note에 적힐 연도 ("2016년")

  function fillProjectSelect() {
    const opts = tagHistoryCache.folders.map((f) => {
      const name = shortProjectLabel(f.folder);
      const year = f.year ? `${f.year}년` : "";
      return `<option value="${esc(f.folder)}" data-name="${esc(name)}" data-year="${esc(year)}">${esc(f.folder)}</option>`;
    }).join("");
    // 폴더 목록에 없는 공사명이 이미 적혀 있으면(직접 적어 넣던 시절의 옛 이력을 [수정]으로
    // 열 때) 맨 위에 그대로 보여준다 — 조용히 빠지면 Note 문구가 저 혼자 바뀐다(사유와 같은 규칙).
    const known = tagHistoryCache.folders.some((f) => shortProjectLabel(f.folder) === chosenProject);
    const missing = chosenProject && !known
      ? `<option value="__keep__" data-name="${esc(chosenProject)}" data-year="${esc(chosenYear)}">${esc(chosenProject)} (폴더 없음)</option>`
      : "";
    projectSel.innerHTML =
      '<option value="" data-name="" data-year="">(고르지 않음)</option>' + missing + opts;
    // 지금 값에 맞는 항목을 고른다 — 공사명이 같은 폴더가 둘이면 연도까지 맞는 쪽을 고른다.
    const all = [...projectSel.options];
    const match = all.find((o) => o.dataset.name === chosenProject && o.dataset.year === chosenYear)
      || all.find((o) => o.dataset.name === chosenProject);
    projectSel.value = match ? match.value : "";
    if (match) { chosenProject = match.dataset.name; chosenYear = match.dataset.year; }
  }
  projectSel.addEventListener("change", () => {
    const opt = projectSel.selectedOptions[0];
    chosenProject = opt ? opt.dataset.name : "";
    chosenYear = opt ? opt.dataset.year : "";
    updatePreview();
  });

  // --- Note 문구 미리보기 --------------------------------------------------
  // 서버(mdb_note.py build_note_line)와 같은 규칙으로 만든다 — 빈 칸은 그 자리째 빠지고
  // 밑줄도 생기지 않는다. 줄이 여러 개면 Tag No마다 문구가 하나씩 만들어진다.
  function noteLineFor(row) {
    const base = row.tagInput.value.trim();
    const newTag = rowNeedsNewTag(row) ? row.newTagInput.value.trim() : "";
    const change = base && newTag ? `${base} ${NOTE_ARROW} ${newTag}` : base;
    return [labelSel.value, change, chosenYear, chosenProject, reasonSel.value, memoInput.value]
      .map((v) => (v || "").trim())
      .filter(Boolean)
      .join("_");
  }
  // 지금 적고 있는 값으로 서버가 내려주는 note_items 한 줄을 흉내 낸다 — 그래야 아래
  // 미리보기가 MDB 자료 상세보기의 Note 표와 같은 코드(noteTableHtml)를 쓸 수 있다.
  function previewNoteItem(row) {
    const base = row.tagInput.value.trim();
    const newTag = rowNeedsNewTag(row) ? row.newTagInput.value.trim() : "";
    return {
      text: noteLineFor(row),
      from_history: true,
      label: labelSel.value,
      base_tag: base,
      // "무엇이 무엇으로 바뀌는지"가 문구에 들어가는 조건을 위 noteLineFor와 똑같이 맞춘다 —
      // 대상 Tag No를 아직 안 적었으면 문구에는 아무것도 안 들어가므로, 표에도 화살표를
      // 그리지 않는다(안 그러면 "→ TM1601B"처럼 실제 문구에 없는 것이 보인다).
      new_tag: base && newTag ? newTag : "",
      year: chosenYear,
      project: chosenProject,
      reason: reasonSel.value,
      memo: memoInput.value.trim(),
    };
  }

  // 밑줄로 이어 붙인 한 줄이 아니라 **표**로 보여준다(2026-09-01 CM 지시). 저장하고 나면
  // MDB 자료 상세보기에서 표로 보이므로, 적으면서 보는 모양과 저장한 뒤 보는 모양이 같아야
  // 하기 때문이다. 표를 그리는 코드는 상세보기와 함께 쓰는 noteTableHtml 한 곳에 있다.
  function updatePreview() {
    const on = writeNoteCb.checked;
    noteFields.classList.toggle("th-off", !on);
    const items = on
      ? rows.filter((r) => r.tagInput.value.trim()).map(previewNoteItem).filter((it) => it.text)
      : [];
    // 표를 넣을 때는 칸 자체의 테두리·바탕을 없앤다(표에 이미 테두리가 있어 두 겹이 된다)
    preview.classList.toggle("th-preview-table", items.length > 0);
    if (items.length === 0) {
      preview.textContent = on
        ? "대상 Tag No를 입력하면 문구가 만들어집니다."
        : "Note에는 아무것도 쓰지 않습니다.";
      return;
    }
    preview.innerHTML = noteTableHtml(items);
  }

  // --- 바뀔 자료 미리보기 --------------------------------------------------
  // 한 번에 수십 건이 바뀌는 기능이라, 무엇이 바뀔지 눈으로 확인하고 누를 수 있어야 한다.
  // 줄이 여러 개면 Tag No별로 나눠서 이 한 상자에 모아 보여준다(CM 승인).
  function targetCountOf(row) {
    const tag = row.tagInput.value.trim();
    return row.targets && row.targets.tag === tag ? row.targets.doc_count : 0;
  }

  async function refreshTargets(row) {
    const tag = row.tagInput.value.trim();
    if (!tag) { row.targets = null; row.loading = false; renderTargets(); return; }
    row.loading = true;
    renderTargets();
    const data = await (await fetch(`/mdb-tag-history/targets?tag=${encodeURIComponent(tag)}`)).json();
    // 그 사이 입력이 또 바뀌었으면 늦게 온 답은 버린다
    if (row.tagInput.value.trim() !== tag) return;
    let suggests = [];
    if (!data.doc_count) {
      const hits = await (await fetch(`/mdb/tags/suggest?q=${encodeURIComponent(tag)}`)).json();
      if (row.tagInput.value.trim() !== tag) return;
      suggests = hits.slice(0, 12).map((h) => h.tag_no);
    }
    row.loading = false;
    row.targets = Object.assign({ tag, suggests }, data);
    renderTargets();
  }

  function scheduleTargets(row) {
    clearTimeout(row.timer);
    row.timer = setTimeout(() => refreshTargets(row), 300);
  }

  function renderTargets() {
    // Tag No가 둘 이상이면 구획마다 자료 목록을 짧게 줄여, 어느 Tag No가 몇 건인지가
    // 한눈에 들어오게 한다(CSS의 .th-target-box--multi).
    targetsBox.classList.toggle(
      "th-target-box--multi",
      rows.filter((r) => r.tagInput.value.trim()).length > 1
    );
    if (rows.every((r) => !r.tagInput.value.trim())) {
      targetsBox.innerHTML =
        '<span class="muted">대상 Tag No 입력시 바뀔 자료를 여기에 보여줍니다.</span>';
      return;
    }
    targetsBox.innerHTML = rows.map((row, i) => {
      const tag = row.tagInput.value.trim();
      if (!tag) return "";
      if (row.loading || !row.targets || row.targets.tag !== tag) {
        return `<div class="th-target-sec"><b>${esc(tag)}</b> <span class="muted">찾는 중…</span></div>`;
      }
      const t = row.targets;
      if (!t.doc_count) {
        // 이미 적용된 [Tag No 변경]·[Tag No 삭제] 이력을 고칠 때는 그 Tag No가 자료에서 이미
        // 빠져 있어 늘 0건으로 보인다 — 고장이 아니라는 것을 적어준다(수정하면 서버가 먼저
        // 되돌려 그 Tag No를 도로 넣은 뒤 고친 내용을 다시 넣는다). [수정]으로 연 첫 줄만 해당.
        const isEditRow = !!editing && rows[0] === row;
        const chips = t.suggests
          .map((s) => `<button type="button" class="th-suggest-btn" data-row="${i}" data-tag="${esc(s)}">${esc(s)}</button>`)
          .join("");
        return `<div class="th-target-sec">
            <b>${esc(tag)} — ${isEditRow ? "지금 이 Tag No가 붙은 자료는 없습니다." : "이 Tag No가 붙은 자료가 없습니다."}</b>
            ${isEditRow
              ? `<div class="muted">이미 적용된 이력이면 넣었던 것을 되돌린 뒤 고친 내용으로 다시 넣습니다${
                  editing.applied_doc_count ? ` (그때 적용한 자료 ${editing.applied_doc_count}건)` : ""}.</div>`
              : ""}
            ${chips ? `<div class="th-suggest">비슷한 Tag No: ${chips}</div>` : ""}
          </div>`;
      }
      return `<div class="th-target-sec">
          <b>${esc(tag)} — 바뀔 자료 ${t.doc_count}건</b>
          <div class="th-target-list">${t.items.map((it) => `
            <div title="${esc(it.source_path)}">${esc(it.name)}
              <span class="muted">${esc(shortProjectLabel(it.project_name))}</span></div>`).join("")}</div>
        </div>`;
    }).join("");

    targetsBox.querySelectorAll("[data-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows[Number(btn.dataset.row)];
        row.tagInput.value = btn.dataset.tag;
        updatePreview();
        refreshTargets(row);
      });
    });
  }

  // --- 첫 줄 만들고 화면 그리기 --------------------------------------------
  makeRow(filled
    ? { tag: filled.base_tag || "", action: filled.action, newTag: filled.new_tag || "" }
    : { tag: prefillTag || "" });

  fillReasonSelect();
  fillProjectSelect();
  syncBulkLock();
  updateHint();
  updatePreview();
  refreshTargets(rows[0]);
  setTimeout(() => rows[0].tagInput.focus(), 30);

  labelSel.addEventListener("change", updatePreview);
  memoInput.addEventListener("input", updatePreview);
  writeNoteCb.addEventListener("change", updatePreview);

  layer.querySelector("#thf-cancel").addEventListener("click", () => popDialogLayer(layer));

  layer.querySelector("#thf-apply").addEventListener("click", async () => {
    // 비어 있는 줄은 그냥 넘어간다([행 추가]를 잘못 눌렀으면 비워두면 된다).
    const use = rows.filter((r) => r.tagInput.value.trim());
    if (use.length === 0) { await showAlert("대상 Tag No를 입력해주세요."); return; }

    const nth = (i) => (use.length > 1 ? `${i + 1}번째 줄: ` : "");
    for (let i = 0; i < use.length; i++) {
      const r = use[i];
      if (rowNeedsNewTag(r) && !r.newTagInput.value.trim()) {
        await showAlert(`${nth(i)}새 Tag No를 입력해주세요.`); return;
      }
      if (r.actionSel.value === "NOTE_ONLY" && !(writeNoteCb.checked && noteLineFor(r))) {
        await showAlert(`${nth(i)}Tag No도 바꾸지 않고 Note도 쓰지 않으면 할 일이 없습니다.`); return;
      }
    }

    // 같은 Tag No를 두 줄에 적으면 똑같은 이력이 두 벌 생긴다 — 미리 막는다.
    const tags = use.map((r) => r.tagInput.value.trim());
    const dup = tags.find((t, i) => tags.findIndex((x) => x.toUpperCase() === t.toUpperCase()) !== i);
    if (dup) {
      await showAlert(`"${dup}"가 여러 줄에 있습니다.\n대상 Tag No는 줄마다 달라야 합니다.`);
      return;
    }

    // 빨리 눌러서 아직 "바뀔 자료"를 못 받아온 줄이 있으면 먼저 받아온다
    await Promise.all(use.map((r) => {
      clearTimeout(r.timer);
      return r.targets && r.targets.tag === r.tagInput.value.trim() ? null : refreshTargets(r);
    }));

    // [수정]으로 연 첫 줄만 0건이어도 막지 않는다 — 위 미리보기 설명과 같은 이유다.
    for (let i = 0; i < use.length; i++) {
      if (editing && rows[0] === use[i]) continue;
      if (targetCountOf(use[i]) === 0) {
        await showAlert(`"${tags[i]}" Tag No가 붙은 자료가 없습니다.\nTag No를 다시 확인해주세요.`);
        return;
      }
    }

    const reverted = !!editing && editing.status === "취소됨";
    const noteLines = use.map((r) => (writeNoteCb.checked ? noteLineFor(r) : ""));
    const lines = [];
    if (editing) {
      lines.push(`"${editing.base_tag}" 이력을 고친 내용으로 바꿉니다.`, "");
      lines.push(reverted
        ? "되돌린(취소됨) 이력이라 자료에는 넣지 않고 내용만 고칩니다."
        : "이 이력이 자료에 넣었던 Tag No·Note 줄을 도로 뺀 뒤, 고친 내용으로 다시 넣습니다.");
      lines.push("직접 적어두신 다른 Note 줄과, 원래부터 붙어 있던 Tag No는 그대로 둡니다.");
      // [수정] 창에서 늘린 줄은 고치는 게 아니라 새 이력으로 등록된다(CM 승인)
      if (use.length > 1) lines.push("", `늘리신 ${use.length - 1}줄은 새 이력으로 따로 등록됩니다.`);
      lines.push("");
    } else if (use.length > 1) {
      lines.push(`아래 ${use.length}줄을 각각 이력 1건으로 등록합니다.`, "");
    } else {
      lines.push(`"${tags[0]}" Tag No가 붙은 자료 ${targetCountOf(use[0])}건에 다음을 적용합니다.`, "");
    }
    use.forEach((r, i) => {
      if (use.length > 1) lines.push(`[${i + 1}] ${tags[i]} — 자료 ${targetCountOf(r)}건`);
      const changeLine = tagChangeLine(r.actionSel.value, tags[i], r.newTagInput.value.trim());
      if (changeLine) lines.push(`· ${changeLine}`);
      if (noteLines[i]) lines.push(`· Note에 한 줄 추가: ${noteLines[i]}`);
      if (use.length > 1) lines.push("");
    });
    if (autoCb.checked) {
      lines.push(`앞으로 어떤 자료에 ${tags.map((t) => `"${t}"`).join(", ")}${
        tags.length > 1 ? " 중 하나를" : "를"} 달면 위 내용이 자동으로 들어갑니다.`);
    }
    lines.push("", "계속하시겠습니까?");
    if (!(await showConfirm(lines.join("\n")))) return;

    const bodyFor = (r) => ({
      base_tag: r.tagInput.value.trim(),
      action: r.actionSel.value,
      new_tag: rowNeedsNewTag(r) ? r.newTagInput.value.trim() : null,
      // 공사 범위 드롭다운은 없앴다(2026-09-01 CM 지시) — 이력은 항상 그 Tag No가 붙은
      // 자료 전부에 들어간다. 서버·DB의 project_id 칸 자체는 옛 이력을 위해 그대로 둔다.
      project_id: null,
      note_label: labelSel.value || null,
      note_year: chosenYear || null,
      note_project: chosenProject || null,
      note_reason: reasonSel.value || null,
      note_memo: memoInput.value.trim() || null,
      write_note: writeNoteCb.checked,
      auto_apply: autoCb.checked,
    });

    // 줄마다 이력 1건이라 저장도 줄마다 한 번씩 부른다. [수정]으로 열었으면 첫 줄만 그
    // 이력을 고치고(PATCH), 늘린 줄은 새 이력으로 등록한다(POST).
    const results = [];
    let failed = null;
    for (const r of use) {
      const isEditRow = !!editing && rows[0] === r;
      const res = await fetch(isEditRow ? `/mdb-tag-history/${editing.id}` : "/mdb-tag-history", {
        method: isEditRow ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFor(r)),
      });
      if (!res.ok) { failed = { tag: r.tagInput.value.trim(), msg: await safeErrText(res) }; break; }
      results.push({ tag: r.tagInput.value.trim(), data: await res.json() });
    }

    popDialogLayer(layer);

    if (failed) {
      // 앞줄은 이미 저장됐다 — 무엇까지 됐는지 그대로 알린다
      await showAlert(
        `${use.length}줄 중 ${results.length}줄까지 저장하고 문제가 발생했습니다.\n\n` +
        `· 멈춘 줄: ${failed.tag}\n· 이유: ${failed.msg}\n\n` +
        "저장된 것은 이력 목록에서 확인해주세요."
      );
    } else if (reverted) {
      const extra = results.slice(1);
      await showAlert(
        "이력 내용을 고쳤습니다.\n\n" +
        "되돌린(취소됨) 이력이라 자료에는 아무것도 넣지 않았습니다.\n" +
        "목록에서 [다시 적용]을 누르면 고친 내용이 자료에 들어갑니다." +
        (extra.length
          ? `\n\n새로 등록한 이력 ${extra.length}건은 그대로 적용됐습니다.\n` +
            extra.map((x) => `· ${x.tag} — 자료 ${x.data.doc_count}건`).join("\n")
          : "")
      );
    } else {
      const actionLabel = TAG_HISTORY_ACTIONS.find((a) => a.value === use[0].actionSel.value).label;
      await showAlert(tagHistoryMultiResultMessage(results, editing ? "수정" : `${actionLabel} 적용`));
    }
    if (onSaved) await onSaved();
  });
}

// ---------------------------------------------------------------------------
// MDB 자료 상세보기의 Note ✎ — 어느 이력을 고칠지 정해 위 팝업을 연다 (2026-08-30 CM 지시)
//
// 자료의 Note는 사람이 자유롭게 적는 글이 아니라 Tag No 이력이 한 줄씩 쌓아 만든 것이다.
// 그래서 Note를 고치는 것도 "그 줄을 넣은 이력을 고치는 것"이어야 하고, MDB 관리
// [Tag No 이력관리]의 [수정]이 여는 팝업과 **같은 함수**(openTagHistoryForm)를 부른다.
//
// 어느 이력이 그 줄을 넣었는지는 Note 한 줄과 이력의 완성 문장(note_line)이 글자까지 같은지로
// 찾는다 — 서버가 되돌릴 때 쓰는 기준과 같다(mdb_tag_history.py의 remove_note_line).
//   · 이력에서 온 줄이 1개면      그 이력의 [수정] 팝업을 바로 연다
//   · 2개 이상이면               어느 줄을 고칠지 먼저 고르게 한다
//   · 하나도 없으면(빈 Note 등)  새 이력 등록 팝업을 연다(대상 Tag No는 자료 것으로 채워둠)
//
// 고친 내용은 그 Tag No가 붙은 **다른 자료에도 함께** 들어간다(이 기능이 원래 그런 것이다).
// 고르는 팝업에 그 사실을 적어두어 지금 보는 자료만 바뀐다고 오해하지 않게 한다.
//
// note : 지금 자료의 Note 전체(줄바꿈으로 여러 줄)
// tags : 그 자료의 Tag No 목록 — 새로 등록할 때 대상 Tag No를 채워주는 데 쓴다
async function openNoteHistoryEditor(note, tags, { onSaved = null } = {}) {
  const lines = String(note || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const histories = await (await fetch("/mdb-tag-history")).json();

  // 같은 문장을 넣은 이력이 둘 이상이면(문구를 똑같이 만든 경우) 먼저 등록된 쪽을 가리킨다.
  const byLine = new Map();
  histories.forEach((h) => {
    const key = (h.note_line || "").trim();
    if (key && !byLine.has(key)) byLine.set(key, h);
  });

  const found = lines.map((line) => byLine.get(line)).filter(Boolean);
  // 대상 Tag No는 자료에 Tag No가 하나뿐일 때만 채워준다 — 여럿이면 어느 것인지 알 수 없다.
  const prefillTag = (tags || []).length === 1 ? tags[0] : "";

  if (found.length === 0) return openTagHistoryForm(null, { onSaved, prefillTag });
  if (found.length === 1) return openTagHistoryForm(found[0], { onSaved });

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box">
        <p class="modal-title">고칠 Note 줄 고르기</p>
        <p class="modal-hint-text">이 자료의 Note는 아래 이력이 한 줄씩 남긴 것입니다.
          고칠 줄을 눌러주세요 — 그 이력이 붙은 다른 자료의 Note도 함께 바뀝니다.</p>
        <div class="note-history-pick">
          ${found.map((h, i) => `
            <button type="button" class="note-history-line" data-pick="${i}">
              <span class="note-history-no">${i + 1}</span>
              <span>${esc(h.note_line)}</span>
            </button>`).join("")}
        </div>
        <div class="modal-actions">
          <button type="button" data-cancel>취소</button>
        </div>
      </div>
    </div>`);

  layer.querySelector("[data-cancel]").addEventListener("click", () => popDialogLayer(layer));
  layer.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      popDialogLayer(layer);
      openTagHistoryForm(found[Number(btn.dataset.pick)], { onSaved });
    });
  });
}
