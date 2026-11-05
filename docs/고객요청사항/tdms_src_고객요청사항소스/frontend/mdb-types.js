// 설비유형·자료유형 — 고를 수 있는 값 목록(마스터)과 그 값을 고르는 체크박스 드롭다운.
//
// 둘은 성격이 완전히 같다(고를 수 있는 값 목록 + 옆의 ✎ 목록 편집 팝업). 서버도 같은 코드로
// 만들어져 있어서(backend/app/routers/type_lists.py) 화면 쪽도 여기 한 곳에 모아뒀다.
// 자료 1건에 여러 개를 붙일 수 있고, 저장·표시는 슬래시로 이어 붙인다("Pump/Strainer").
// (2026-08-28 CM 확정)
//
// 원래 MDB 관리(mdb-editor.js) 안에만 있던 코드인데, MDB 자료 상세보기에서도 설비유형·자료유형을
// 그 자리에서 고칠 수 있게 되면서(2026-08-29 CM 지시) 두 화면이 같이 쓰게 됐다. 한쪽만 고쳐져
// 두 화면이 다르게 동작하는 일이 없도록 파일 하나로 나눠둔 것이다.
// 쓰는 화면: MDB 관리(mdb-editor.html) · MDB 자료 상세보기(mdb-detail.html)
//
// 목록 자체를 고치는 것도 전부 여기 있다 — 새로 만들기(addTypeToList)·이름 바꾸기
// (renameTypeInList)와, 숨기기·삭제까지 하는 [목록 편집] 팝업(openTypeListManager).
// 그 팝업을 여는 ✎ 버튼은 MDB 관리의 [자료명·정보 변경]과 Tag No 이력 등록 팝업에만 있다.
//
// Tag No 입력칸에서 슬래시(/)로 이어 적은 것을 나누는 규칙(맨 아래 expandSlashTag)도 여기 뒀다.
// 유형 목록과는 다른 이야기지만, 그것도 위 두 화면이 함께 쓰는 규칙이라 한쪽만 고쳐지면 안 된다.

// reason(Tag No 변경사유)은 MDB 관리 "Tag No 이력관리"에서 Note 문구에 넣을 사유를 고르는 목록이다.
// 앞의 둘과 성격·규칙이 같아 같은 자리에 두었지만, 자료에 붙는 값이 아니라 Note 문장으로
// 들어가는 값이라 검색줄 드롭다운이 없다(filterId 없음).
// keepHint: 목록에서 숨기거나 지울 때 "이미 쓰인 것은 어떻게 되는지" 알려주는 문구.
// 설비유형·자료유형은 자료에 그 값이 붙어 있고, 사유는 자료 Note에 문장으로 적혀 나간다.
const TYPE_LISTS = {
  equipment: {
    api: "/equipment-types", label: "설비유형", filterId: "equipment_type",
    keepHint: "이미 이 유형으로 지정된 자료는 값이 그대로 남습니다",
  },
  doc: {
    api: "/mdb-doc-types", label: "자료유형", filterId: "doc_type",
    keepHint: "이미 이 유형으로 지정된 자료는 값이 그대로 남습니다",
    // 여러 개 고르면 고른 순서가 아니라 알파벳순으로 저장·표시한다 (2026-08-31 CM 확정,
    // 예: List·Schedule을 고르면 "List/Schedule"). 설비유형은 고른 순서를 그대로 지킨다.
    sortValue: true,
  },
  reason: {
    api: "/mdb-tag-reasons", label: "사유", filterId: null,
    keepHint: "이미 자료 Note에 적혀 나간 문구는 그대로 남습니다",
  },
};

const TYPE_SEPARATOR = "/";

// 마스터 목록(숨기지 않은 것들)을 화면마다 따로 들고 있지 않도록 여기 한 곳에 담아둔다.
const typeListCache = { equipment: [], doc: [], reason: [] };

function splitTypes(value) {
  return String(value || "").split(TYPE_SEPARATOR).map((t) => t.trim()).filter(Boolean);
}

async function loadTypeList(kind) {
  typeListCache[kind] = await (await fetch(TYPE_LISTS[kind].api)).json();
  return typeListCache[kind];
}

async function loadTypeLists() {
  await Promise.all([loadTypeList("equipment"), loadTypeList("doc")]);
}

// 검색줄의 설비유형·자료유형 드롭다운(하나만 고르는 보통 select). 고른 유형이 하나라도 붙어
// 있는 자료가 검색된다 — 판정은 서버(mdb.py filter_groups)가 한다.
// 검색줄이 없는 화면(자료 상세보기)에서도 그냥 부를 수 있도록, 칸이 없으면 아무것도 하지 않는다.
function fillTypeFilterSelect(kind) {
  const conf = TYPE_LISTS[kind];
  const sel = conf.filterId ? document.getElementById(conf.filterId) : null;
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '<option value="">전체</option>' +
    typeListCache[kind].map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  sel.value = keep;  // 목록을 다시 받아도 고른 조건은 그대로 둔다
}

// 목록에 없는 유형을 그 자리에서 새로 만들어 바로 고른다 (2026-08-29 CM 지시).
// MDB 자료 상세보기에서 자료를 넘겨보다가 없는 유형을 만났을 때, MDB 관리 화면까지 가서
// 목록에 추가하고 돌아오지 않아도 되게 하는 것이 목적이다. 만든 유형은 마스터 목록에 그대로
// 등록되므로 다음부터 다른 자료에서도 고를 수 있고 검색줄 드롭다운에도 나온다.
//
// kind: "equipment" | "doc", dropdown: createTypeCheckDropdown이 돌려준 것(거기에 체크해준다)
// 돌려주는 값: { ok, message } — 알릴 말이 있으면 message에 담아 보내고, 띄우는 것은 부르는
// 쪽이 한다(이 파일은 화면마다 다른 알림창을 쓰지 않기 위해 직접 띄우지 않는다).
async function addTypeToList(kind, rawName, dropdown) {
  const conf = TYPE_LISTS[kind];
  const name = (rawName || "").trim();
  if (!name) return { ok: false };

  // 이미 목록에 있는 이름이면 새로 만들지 않고 그대로 골라준다(대소문자만 다른 것도 같은 유형
  // 취급 — 서버도 같은 규칙으로 중복을 막는다). 이때 표기는 목록에 등록된 쪽을 따른다.
  const known = typeListCache[kind].find((t) => t.name.toUpperCase() === name.toUpperCase());
  if (known) {
    dropdown.addSelected(known.name);
    return { ok: true, message: `이미 목록에 있는 ${conf.label}입니다: ${known.name}` };
  }

  const res = await fetch(conf.api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    // 숨겨둔 유형과 이름이 같으면 서버가 중복(409)으로 거절한다. 목록에 이미 있는 것이므로
    // 그 이름을 그대로 골라주고, 왜 목록에 안 보였는지 알려준다.
    if (res.status === 409) {
      const all = await (await fetch(`${conf.api}?include_hidden=true`)).json();
      const hidden = all.find((t) => t.name.toUpperCase() === name.toUpperCase());
      if (hidden) {
        dropdown.addSelected(hidden.name);
        return {
          ok: true,
          message: `이미 목록에 있지만 숨겨둔 ${conf.label}입니다: ${hidden.name}
`
            + `그대로 골라뒀습니다. 목록에 다시 보이게 하려면 MDB 관리 화면에서 복구하세요.`,
        };
      }
    }
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* 본문이 JSON이 아니면 상태문구 그대로 */ }
    return { ok: false, message: `${conf.label}을 추가하지 못했습니다: ${detail}` };
  }

  await loadTypeList(kind);
  fillTypeFilterSelect(kind);   // 검색줄 드롭다운이 있는 화면이면 새 유형이 바로 나오게
  dropdown.addSelected(name);   // 새로 만든 것은 바로 쓰려고 만든 것이므로 체크해둔다
  return { ok: true };
}

// 이미 목록에 있는 유형의 이름(문구)을 고친다 (2026-08-29 CM 지시). 위 addTypeToList(새로
// 만들기)의 짝이다 — 자료를 넘겨보다가 잘못 적힌 유형명을 만났을 때 MDB 관리 화면까지 가지
// 않고 그 자리에서 고칠 수 있게 하는 것이 목적이다.
//
// 자료 쪽은 이 목록을 가리키는 번호가 아니라 이름 글자를 그대로 들고 있으므로, 이미 이
// 유형으로 지정된 자료들의 값도 서버가 함께 갈아끼운다("Pump/Strainer"처럼 여러 개를 이어
// 붙인 값에서도 그 조각만 바뀐다 — backend/app/routers/type_lists.py).
//
// 돌려주는 값은 addTypeToList와 같다: { ok, message } — 띄우는 것은 부르는 쪽이 한다.
async function renameTypeInList(kind, oldName, newName, dropdown) {
  const conf = TYPE_LISTS[kind];
  const target = typeListCache[kind].find((t) => t.name === oldName);
  if (!target) return { ok: false, message: `목록에서 찾지 못한 ${conf.label}입니다: ${oldName}` };

  const res = await fetch(`${conf.api}/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });

  if (!res.ok) {
    // 이미 있는 이름(409)·이름에 슬래시를 넣은 경우(400) 등은 서버가 이유를 적어 보낸다.
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* 본문이 JSON이 아니면 상태문구 그대로 */ }
    return { ok: false, message: `${conf.label} 이름을 바꾸지 못했습니다: ${detail}` };
  }

  await loadTypeList(kind);
  fillTypeFilterSelect(kind);                  // 검색줄 드롭다운도 새 이름으로
  dropdown.renameSelection(oldName, newName);  // 고르고 있던 값이 옛 이름으로 저장되지 않게
  return { ok: true };
}

// 설비유형·자료유형을 고르는 칸 — 체크박스로 여러 개를 고르고, 고른 것은 슬래시로 이어 붙여
// 보여준다("Pump/Strainer/Valve").
// ui.js의 createCheckDropdown을 안 쓰는 이유: 그건 검색용이라 [전체] 항목이 있어야 하고
// 아무것도 안 고르면 전체가 되는데, 여기서는 아무것도 안 고른 것이 그대로 "(없음)"이다.
// 이미 지정돼 있지만 목록에 없는 값(숨겼거나 지운 유형)은 맨 위에 그대로 보여준다 — 저장할 때
// 조용히 사라지면 안 되기 때문이다(설비유형 목록에서 지워도 이미 지정된 자료의 값은 남는다).
// emptyHint: 목록이 비었을 때 안내할 문구 — 화면마다 추가하는 방법이 달라서 부르는 쪽이 정한다
//            (MDB 관리는 옆의 ✎ 버튼, 자료 상세보기는 그 아래 새 유형 입력칸으로 안내).
// onRename : 넘기면 목록 항목마다 이름을 고치는 ✎가 붙는다 — 새 이름을 물어본 뒤
//            onRename(옛이름, 새이름)으로 알려준다(실제 처리는 위 renameTypeInList).
//            MDB 관리는 칸 옆에 [설비유형 목록 편집] 팝업(이름변경·숨기기·삭제)이 따로 있어
//            넘기지 않고, 그 팝업이 없는 자료 상세보기에서만 넘겨 쓴다.
function createTypeCheckDropdown(containerId, kind, currentValue, { emptyHint = "", onRename = null } = {}) {
  const conf = TYPE_LISTS[kind];
  const container = document.getElementById(containerId);
  const toggle = container.querySelector(".dropdown-toggle");
  const list = container.querySelector(".dropdown-list");
  const selected = splitTypes(currentValue); // 설비유형은 고른 순서, 자료유형은 알파벳순(아래)
  // 자료유형(doc)은 여러 개를 고르면 고른 순서가 아니라 알파벳순으로 저장·표시한다
  // (2026-08-31 CM 확정: "List·Schedule을 고르면 List/Schedule"). 설비유형은 그대로 고른 순서.
  const sortSelected = () => {
    if (conf.sortValue) selected.sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
  };
  sortSelected();

  const sameName = (a, b) => a.toUpperCase() === b.toUpperCase();
  const masterNames = () => typeListCache[kind].map((t) => t.name);

  function render() {
    const master = masterNames();
    const missing = selected.filter((v) => !master.some((m) => sameName(m, v)));
    const names = [...missing, ...master];
    list.innerHTML = names.length
      ? names.map((name) => {
          const inMaster = master.some((m) => sameName(m, name));
          const gone = inMaster ? "" : ' <span class="type-missing-tag">(목록에 없음)</span>';
          const checked = selected.some((v) => sameName(v, name)) ? "checked" : "";
          // 이름 고치기(✎)는 목록에 등록된 것에만 붙인다 — "(목록에 없음)"은 목록에서 숨겼거나
          // 지운 값이라 고칠 대상이 목록에 없다.
          const renameBtn = onRename && inMaster
            ? `<button type="button" class="dropdown-item-edit" data-rename="${esc(name)}" title="이름 고치기">✎</button>`
            : "";
          return `<label class="dropdown-item dropdown-item-ms">
              <input type="checkbox" class="type-dd-cb" value="${esc(name)}" ${checked} />
              <span class="dropdown-item-label">${esc(name)}${gone}</span>${renameBtn}
            </label>`;
        }).join("")
      : `<p class="dropdown-empty">등록된 ${conf.label}이 없습니다.${emptyHint ? " " + esc(emptyHint) : ""}</p>`;
    list.querySelectorAll(".type-dd-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        setChecked(cb.value, cb.checked);
        render();
        renderToggle();
      });
    });
    list.querySelectorAll("[data-rename]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // 항목 한 줄 전체가 <label>이라, 막지 않으면 이름을 고치려다 체크까지 같이 눌린다
        e.preventDefault();
        e.stopPropagation();
        askRename(btn.dataset.rename);
      });
    });
  }

  // 목록 항목의 ✎ — 새 이름을 물어보고 부르는 쪽(onRename)에 넘긴다. 묻는 방식은 공사·업체
  // 드롭다운의 이름 편집(ui.js createHideableDropdown)과 같게 맞췄다.
  async function askRename(oldName) {
    const newName = await showPrompt(
      `새 ${conf.label}명을 입력해주세요.\n(이미 이 ${conf.label}으로 지정된 자료의 값도 함께 바뀝니다)`,
      oldName
    );
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    await onRename(oldName, trimmed);
    // 확인창을 누르면 바깥을 누른 것이 되어 목록이 닫히므로, 바뀐 이름이 바로 보이게 다시 편다
    list.classList.remove("hidden");
  }

  function setChecked(name, on) {
    const i = selected.findIndex((v) => sameName(v, name));
    if (on && i === -1) selected.push(name);
    if (!on && i !== -1) selected.splice(i, 1);
    sortSelected();
  }

  function renderToggle() {
    const text = selected.length ? selected.join(TYPE_SEPARATOR) : "(없음)";
    toggle.textContent = text;
    toggle.title = text; // 여러 개를 골라 길어지면 칸에서 잘리므로 마우스를 올리면 다 보이게
  }

  toggle.addEventListener("click", () => list.classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) list.classList.add("hidden");
  });

  render();
  renderToggle();

  return {
    // 저장할 값 — 고른 것을 슬래시로 이어 붙인다. 하나도 없으면 빈 문자열(= 유형 미지정).
    getValue: () => selected.join(TYPE_SEPARATOR),
    // 아래 목록 편집 팝업(mdb-editor.js openTypeListManager)이 목록을 고친 뒤 불러주는 것들
    reloadOptions() { render(); renderToggle(); },
    addSelected(name) { setChecked(name, true); render(); renderToggle(); },
    renameSelection(oldName, newName) {
      const i = selected.findIndex((v) => sameName(v, oldName));
      if (i !== -1) selected[i] = newName;
      sortSelected();
      render();
      renderToggle();
    },
  };
}

// "설비유형 목록 편집" / "자료유형 목록 편집" / "사유 목록 편집" 팝업 — 세 목록은 성격이 같아
// 이 함수 하나가 다 띄운다(kind로 구분). 추가·이름변경·숨기기·삭제를 여기서 하고, 고칠 때마다
// 부모 모달의 드롭다운(dropdown)과 검색줄 드롭다운을 바로 다시 그려 화면이 서로 어긋나지 않게 한다.
//
// layered=false(기본)면 picker-modal-root에 띄운다 — MDB 관리의 자료명·정보 변경 모달을
// 지우지 않기 위함이다. layered=true면 레이어로 쌓는다(Tag No 이력관리의 "새 이력 등록"처럼
// 이미 팝업 위에 뜬 화면에서 열 때. 뒤 팝업을 지우지 않고 흐리게 두는 공통 규칙, ui.js).
// picker-modal-root가 없는 화면(MDB 자료 상세보기)에서는 layered=true로만 부른다.
//
// 원래 mdb-editor.js에 있던 것을 여기로 옮겼다(2026-08-30) — Tag No 이력 등록 팝업이 MDB 관리와
// MDB 자료 상세보기 두 화면에서 함께 열리게 되면서, 그 안의 [사유 목록 편집]도 같이 필요해졌다.
async function openTypeListManager(kind, dropdown, { layered = false } = {}) {
  const conf = TYPE_LISTS[kind];
  const layer = layered ? pushDialogLayer("") : null;

  // 목록을 고쳤을 때 화면 곳곳을 같은 값으로 맞춘다.
  async function refreshEverywhere() {
    await loadTypeList(kind);
    fillTypeFilterSelect(kind);   // 검색줄 드롭다운
    dropdown.reloadOptions();     // 자료명·정보 변경 팝업의 체크박스 드롭다운
  }

  async function render() {
    // 관리 팝업은 숨긴 것까지 전부 보여준다(그래야 되살릴 수 있다) — 드롭다운용 목록
    // (숨김 제외)과는 별도로 매번 새로 받는다.
    const types = await (await fetch(`${conf.api}?include_hidden=true`)).json();
    const rows = types.length
      ? types.map((t) => `
          <div class="eq-manage-row${t.is_hidden ? " is-hidden" : ""}" data-id="${t.id}">
            <span class="eq-manage-name">${esc(t.name)}${t.is_hidden ? ' <span class="eq-manage-hidden-tag">(숨김)</span>' : ""}</span>
            <button type="button" class="small" data-rename="${t.id}">이름 변경</button>
            ${t.is_hidden
              ? `<button type="button" class="small eq-toggle-btn" data-unhide="${t.id}">복구</button>`
              : `<button type="button" class="small eq-toggle-btn" data-hide="${t.id}">숨기기</button>`}
            <button type="button" class="small danger-line" data-delete="${t.id}">삭제</button>
          </div>`).join("")
      : `<p class="muted">등록된 ${conf.label}이 없습니다.</p>`;

    const root = layer || document.getElementById("picker-modal-root");
    root.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-box eq-manage-box">
          <p class="modal-title">${conf.label} 목록 편집</p>
          <div class="eq-manage-list">${rows}</div>
          <div class="eq-add-row">
            <input type="text" id="eq-new-name" placeholder="새 ${conf.label}명" />
            <button type="button" id="eq-add-btn">추가</button>
          </div>
          <div class="modal-actions">
            <button type="button" class="primary" id="eq-close-btn">닫기</button>
          </div>
        </div>
      </div>`;

    // 고칠 때마다 이미 화면에 반영해두므로(refreshEverywhere) 닫을 때 따로 할 일은 없다
    document.getElementById("eq-close-btn").addEventListener("click", () => {
      if (layer) popDialogLayer(layer);
      else root.innerHTML = "";
    });

    const nameInput = document.getElementById("eq-new-name");
    document.getElementById("eq-add-btn").addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const res = await fetch(conf.api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
      nameInput.value = "";
      await render();
      await refreshEverywhere();
      // 새로 만든 것은 바로 쓰려고 추가한 것이므로 부모 팝업에서 체크된 상태로 만들어준다
      dropdown.addSelected(name);
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("eq-add-btn").click(); });

    root.querySelectorAll("[data-rename]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.rename;
        const current = btn.closest(".eq-manage-row").querySelector(".eq-manage-name").textContent.replace(/\s*\(숨김\)\s*$/, "");
        const newName = await showPrompt(`새 ${conf.label}명을 입력해주세요.`, current);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === current) return;
        const res = await fetch(`${conf.api}/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다: " + (await safeErrText(res))); return; }
        await render();
        await refreshEverywhere();
        // 이 유형으로 지정된 자료는 서버가 이미 새 이름으로 바꿔놨다. 부모 팝업에서 고르고
        // 있던 값도 같이 새 이름으로 맞춰준다(그대로 두면 옛 이름으로 저장돼 버린다).
        dropdown.renameSelection(current, trimmed);
      });
    });
    root.querySelectorAll("[data-hide]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.hide;
        const name = btn.closest(".eq-manage-row").querySelector(".eq-manage-name").textContent;
        const ok = await showConfirm(`"${name}"을(를) 목록에서 숨기시겠습니까?\n(${conf.keepHint})`);
        if (!ok) return;
        const res = await fetch(`${conf.api}/${id}/hide`, { method: "POST" });
        if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다."); return; }
        await render();
        await refreshEverywhere();
      });
    });
    root.querySelectorAll("[data-unhide]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.unhide;
        const res = await fetch(`${conf.api}/${id}/unhide`, { method: "POST" });
        if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다."); return; }
        await render();
        await refreshEverywhere();
      });
    });
    root.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delete;
        const name = btn.closest(".eq-manage-row").querySelector(".eq-manage-name").textContent;
        const ok = await showConfirm(`"${name}"을(를) 목록에서 완전히 삭제하시겠습니까?\n(${conf.keepHint} — 새로 고를 후보에서만 빠집니다)`);
        if (!ok) return;
        const res = await fetch(`${conf.api}/${id}`, { method: "DELETE" });
        if (!res.ok) { await showAlert("처리 중 문제가 발생했습니다."); return; }
        await render();
        await refreshEverywhere();
      });
    });
  }
  await render();
}


// Tag No 입력칸에서 슬래시(/)로 이어 적은 것을 여러 개로 나누는 규칙.
// 쓰는 곳: MDB 관리 [자료명·정보 변경] 팝업 · MDB 자료 상세보기의 Tag No 편집칸.
//
// 맨 앞 조각은 언제나 완전한 Tag No이고, 그 뒤 조각은 앞 조각에서 "바뀌는 자리"만 적은 것으로
// 본다. 뒤 조각이 무엇으로 시작하느냐에 따라 갈아끼우는 자리가 다르다.
//   · 영문뿐인 조각 → 앞 조각 끝의 영문을 갈아끼운다
//        "TM1303A/B/C"       → TM1303A, TM1303B, TM1303C
//        "P1200/A/B"         → P1200, P1200A, P1200B  (끝에 영문이 없으면 그냥 뒤에 붙는다)
//   · 숫자로 시작하는 조각 → 앞 조각의 마지막 숫자부터 끝까지를 갈아끼운다 (2026-08-31 CM 지시)
//        "MOV1351/1416/1417" → MOV1351, MOV1416, MOV1417
//        "NA210-01/02"       → NA210-01, NA210-02
//        "TM1303A/1304"      → TM1303A, TM1304
//   · 그 밖의 조각(영문+숫자가 섞여 그 자체로 완전한 Tag No이거나 기호로 시작하는 것)은 어디를
//     갈아끼울지 짐작하지 않고 적은 그대로 둔다 — "MOV1351/P1201C" → MOV1351, P1201C
// 앞 조각에 숫자가 아예 없으면 숫자 조각도 갈아끼울 자리가 없어 그대로 둔다.
function expandSlashTag(token) {
  const segs = String(token).split("/").map((s) => s.trim()).filter(Boolean);
  if (segs.length <= 1) return segs;
  const base = segs[0];
  // 영문 조각이 갈아끼울 자리 — 끝의 영문(끝이 숫자면 떼어낼 것이 없어 그대로 뒤에 붙는다)
  const letterPrefix = base.replace(/[A-Za-z]+$/, "");
  // 숫자 조각이 갈아끼울 자리 — 마지막 숫자부터 끝까지("MOV1351"→"MOV", "P1201C"→"P")
  const digitTail = base.match(/\d+[A-Za-z]*$/);
  const digitPrefix = digitTail ? base.slice(0, base.length - digitTail[0].length) : null;
  return [base, ...segs.slice(1).map((seg) => {
    if (/^[A-Za-z]+$/.test(seg)) return letterPrefix + seg;
    if (/^\d/.test(seg) && digitPrefix !== null) return digitPrefix + seg;
    return seg;
  })];
}
