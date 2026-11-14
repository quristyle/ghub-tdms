// 보관 목록 — 상단 [보관 목록] 버튼 · 목록 팝업 · 보관 팝업 (2026-09-05 CM 지시).
//
// 모든 화면이 이 파일을 읽는다(ui.js 바로 다음). 화면마다 따로 만들지 않고 여기 한 곳에 두는 것은
// ui.js의 [TDB 최근수정]·[TDB 반출] 팝업과 같은 이유다 — 어느 화면에서 보관하든 같은 팝업·같은 동작이어야 한다.
//
// ## 어디서 보관하나 — 미리보기 도구모음의 [»] 안 두 버튼뿐이다
// 처음에는 자료 상세보기와 미리보기 팝업 제목줄에 하트를 달았는데, CM 지시로 그 버튼을 전부
// 없애고 **미리보기(PDF 뷰어) 도구모음 오른쪽 끝 [»] 안**의 [보관하기]·[다른 이름으로 보관]으로
// 모았다. 그 두 버튼은 뷰어 안(assets/pdfjs/web/dms-favorite.js)에 있고, 누르면 이 파일의
// openFavoriteSaveDialog를 부른다(팝업은 바깥 화면인 여기 것을 쓴다 — 뷰어는 작은 창(iframe)이라
// 그 안에서 팝업을 띄우면 미리보기 크기 안에 갇힌다).
//
// ## 보관하는 것은 자료의 사본이 아니다
// 보관하는 것은 "그 자료로 가는 바로가기"와 미리보기에서 그린 편집 내용이다. 보관해도 자료는
// 하나도 변하지 않는다. 편집 내용(도형·문구·형광펜·도장)이 있으면 **그린 내용만** 함께 보관한다
// (PDF를 통째로 복사하지 않는다 — 그 까닭은 backend/app/routers/favorites.py 맨 위에 적어 뒀다).
// 다시 열면 그 편집 내용이 그리기 상태 그대로 되살아나 이어서 옮기고 지우고 색을 바꿀 수 있다.
//
// ## 이름
// [보관하기]는 언제나 **자료명 그대로** 보관한다 — 편집 내용이 있어도 뒤에 아무것도 붙이지
// 않는다(2026-09-05 CM 지시). 내려받는 파일 이름에 붙는 "(Markup)"과는 다른 이야기다.
// [다른 이름으로 보관]은 사용자가 적은 이름을 그대로 쓴다.

// ---------------------------------------------------------------------------
// 서버와 주고받기
// ---------------------------------------------------------------------------

// 팝업 제목. 엑셀 파일명·시트 이름이 이 값을 그대로 따라가므로(제목이 바뀌면 파일명도
// 따라간다는 공통 규칙) 여기 한 곳에서만 고친다.
// 이름이 지나온 길: 2026-09-05 CM 지시로 "저장"·"저장 목록" → "사용자 저장"·"사용자 저장 목록",
// 2026-09-07 CM 지시로 이 기능에서 "저장"이라 부르던 것을 전부 "보관"으로 바꿔 아래 두 이름이 됐다.
// 상단 바 버튼 문구는 2026-09-07에 "저장 목록 (N)" → "저장 (N)" → "보관 (N)" 순으로 줄고 바뀌었다.
const FAV_SAVE_TITLE = "사용자 보관";
const FAV_LIST_TITLE = "사용자 보관 목록";

let favListCache = null;

async function favFetchList({ fresh = false } = {}) {
  if (favListCache && !fresh) return favListCache;
  const res = await fetch("/favorites");
  if (!res.ok) return [];
  favListCache = await res.json();
  return favListCache;
}

function favInvalidate() {
  favListCache = null;
}

async function favFetchSummary() {
  const res = await fetch("/favorites/summary");
  return res.ok ? res.json() : null;
}

// ---------------------------------------------------------------------------
// 보관 팝업 — 미리보기의 [보관하기]·[다른 이름으로 보관]이 부른다
// ---------------------------------------------------------------------------
//
// opts
//   mode     : "save"(보관하기) | "saveAs"(다른 이름으로 보관)
//   target   : { kind, documentId, mdbFileId, name, pdfFileId } — 지금 보고 있는 자료
//   saved    : 이 자료를 이미 보관해 둔 것들 [{ id, name, has_markup, updated_at }]
//   allSaved : 보관해 둔 것 **전부**(다른 자료 것까지) — "보관 위치" 표에 그대로 보여준다
//   markup   : 미리보기에서 그린 편집 내용(없으면 빈 배열)
//   linkedId : 덮어쓸 자리(주소의 fav 번호이거나 이번에 보관했던 자리). 없으면 null
//   used/limit : 지금 몇 개를 보관해 뒀는지 / 상한
//   onSaved(favId) : 보관이 끝나면 뷰어에게 알려준다(다음 [보관하기]가 그 자리를 덮어쓰도록)
//   onChanged()    : 이 팝업에서 보관 자리를 지웠을 때 — 뷰어가 두 버튼 상태를 다시 맞춘다
//
// ## "보관 위치"에는 보관해 둔 것을 전부 보여준다 (2026-09-05 CM 지시)
// 예전에는 지금 보고 있는 자료의 보관분만 드롭다운에 담았다. 그러면 50자리 가운데 무엇이 자리를
// 차지하고 있는지 알 수 없어 ㉠덮어쓸지 새로 보관할지 판단할 수 없고 ㉡자리가 다 찼을 때 무엇을
// 지워야 할지도 알 수 없었다. 그래서 드롭다운을 표로 바꿔 전부 보여주고, 줄마다 [지우기]를 뒀다.
// 지금 보고 있는 자료를 가리키는 줄에는 "이 자료" 배지가 붙어 어느 것을 덮어쓸지 바로 보인다.

// 보관 이름은 언제나 **자료명 그대로**다 (2026-09-05 CM 지시).
// 예전에는 편집 내용이 있으면 뒤에 "(Markup)"을 붙였는데(미리보기 [다운로드]와 같은 규칙),
// CM이 "미리보기에서 편집된 자료를 보관하더라도 Markup 문구는 붙지 않도록 하라"고 해서 뗐다.
// 내려받는 파일 이름에 붙는 "(Markup)"은 그대로다 — 그건 파일을 구분하는 자리라 성격이 다르다.
function favDefaultName(target) {
  return String(target.name || "").trim();
}

// [다른 이름으로 보관]이 처음 채워 넣는 이름. 이미 같은 이름이 있으면 뒤에 (2),(3)…을 붙인다
// (같은 이름이 여러 개면 목록에서 어느 것이 무엇인지 알 수 없으므로).
function favUniqueName(base, saved) {
  const taken = new Set((saved || []).map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// 보관 자리 한 줄이 가리키는 자료명. 자료가 없어졌으면 그렇게 적는다.
// (2026-09-05 CM 지시로 "보관 이름" 칸을 없애고 이 값만 "자료명" 칸에 보여준다 —
//  보관 이름은 이제 자료명 그대로라 두 칸이 사실상 같은 값이었다.)
function favSlotTargetName(slot) {
  if (slot.missing) return "(삭제됨)";
  return slot.target_name || slot.name || "";
}

// "보관 위치" 표의 한 줄. 칸 구성은 엑셀 내보내기(columns=slot)와 같다(공통 규칙).
// no는 표에 보이는 순번 — 정렬하면 ui.js가 td.col-no를 다시 매긴다.
function favSlotRowHtml(slot, checked, no) {
  const desc = slot.description || "";
  const targetName = favSlotTargetName(slot);
  const sameBadge = slot.same ? ' <span class="badge badge-info">이 자료</span>' : "";
  return `
    <tr data-slot-row="${slot.id}">
      <td class="tc"><input type="radio" name="fav-save-slot" class="fav-slot-radio"
                            value="${slot.id}"${checked ? " checked" : ""} /></td>
      <td class="col-no">${no}</td>
      <td data-sort-value="${escapeHtml(targetName)}" title="${escapeHtml(targetName)}">${previewBtnHtml(slot.pdf_file_id)} ${escapeHtml(targetName)}${sameBadge}</td>
      <td title="${escapeHtml(desc)}">${escapeHtml(desc)}</td>
      <td class="tc">${escapeHtml(slot.kind || "")}</td>
      <td class="tc">${slot.has_markup ? '<span class="badge badge-neutral">있음</span>' : ""}</td>
      <td class="muted tc">${fmtDateTime(slot.updated_at)}</td>
      <td class="tc"><button type="button" class="small fav-slot-del" data-slot-del="${slot.id}">삭제</button></td>
    </tr>`;
}

// [보관하기]로 어떤 자리를 덮어쓸 때 이름 칸에 채워 넣을 이름.
//  · 같은 자료의 자리면 그 자리 이름을 그대로 쓴다 — [다른 이름으로 보관]으로 직접 적어 둔
//    이름을 마음대로 바꾸지 않기 위함이다(덮어쓰는 것은 그 자리이지 새 이름을 붙이는 것이 아니다).
//  · 다만 예전 규칙으로 뒤에 "(Markup)"이 저절로 붙었던 이름은 그 꼬리만 뗀다 — 이제는 붙이지
//    않는 문구라(CM 지시), 덮어쓰는 김에 정리한다. 사람이 직접 적은 이름은 그대로 둔다.
//  · 다른 자료의 자리면 그 자리가 가리키는 자료가 바뀌므로 지금 자료명을 쓴다
//    (옛 이름을 그대로 두면 이름과 실제 자료가 어긋난다).
function favSlotFillName(slot, baseName) {
  if (!slot || !slot.same) return baseName;
  return slot.name === `${baseName}${MARKUP_SUFFIX}` ? baseName : slot.name;
}

// 돋보기 미리보기에 넘길 값. 목록 팝업의 favPreviewItem과 같은 모양이다
// (편집 내용을 보관해 둔 자리는 그것까지 되살려 보여준다 — 무엇을 보관해 뒀는지 확인하는 자리이므로).
function favSlotPreviewItem(slot) {
  return {
    id: slot.id,
    drawingNo: favSlotTargetName(slot),
    path: slot.path ?? "",
    pdfFileId: slot.kind === "TDB" ? slot.pdf_file_id : null,
    previewUrl: slot.kind === "MDB" && slot.pdf_file_id ? `/mdb/files/${slot.pdf_file_id}/view` : null,
    favId: slot.has_markup ? slot.id : null,
    source: slot.kind === "TDB" ? tdbSource(slot.document_id) : mdbSource(slot.mdb_file_id),
    preferOriginal: slot.view_mode === "original",
  };
}

async function openFavoriteSaveDialog(opts = {}) {
  const mode = opts.mode === "saveAs" ? "saveAs" : "save";
  const target = opts.target ? { ...opts.target } : null;
  if (!target || (!target.documentId && !target.mdbFileId)) {
    await showAlert("보관할 자료를 알 수 없습니다. 자료를 열고 다시 눌러 주세요.");
    return;
  }

  // 넘어온 값은 미리보기(작은 창) 쪽에서 만들어진 것이라, 그 창이 닫히면 못 읽게 된다.
  // 팝업이 떠 있는 동안 미리보기가 닫힐 수 있으므로(자료를 넘기거나 화면을 떠날 때) 여기서
  // 이 화면 것으로 복사해 둔다 — 보관을 눌렀을 때 값이 비어 있는 사고를 막는다.
  const markup = opts.markup && opts.markup.length ? JSON.parse(JSON.stringify(opts.markup)) : [];
  // 원본 미리보기(DWG 등)에 그린 편집 내용 — 사본 것과 따로 담는다(D-102).
  const originalMarkup = opts.originalMarkup && opts.originalMarkup.length
    ? JSON.parse(JSON.stringify(opts.originalMarkup)) : [];
  // 원본(DWG·엑셀 등) 미리보기를 보다가 보관했는지 — 다시 열 때 그쪽으로 연다(D-102).
  const viewMode = opts.viewMode === "original" ? "original" : null;
  const saved = (opts.saved || []).map((f) => ({
    id: f.id, name: f.name, has_markup: f.has_markup, updated_at: f.updated_at,
  }));
  // 표에 보여줄 보관 자리 전부(다른 자료 것까지). allSaved를 안 보내는 옛 미리보기에서 열려도
  // 최소한 이 자료 것은 보이도록 saved로 넘어간다.
  const slots = (opts.allSaved || opts.saved || []).map((f) => ({ ...f }));
  const limit = opts.limit || 50;
  let used = opts.used ?? slots.length;

  // 덮어쓸 자리 — [보관하기]는 지금 열려 있는 그 자리(주소의 fav 번호나 방금 보관한 자리)를
  // 먼저 고르고, 그런 것이 없으면 이 자료를 가장 최근에 보관한 것을 고른다.
  // [다른 이름으로 보관]은 언제나 "새로 보관"에서 시작한다.
  const linked = saved.find((f) => f.id === opts.linkedId) || saved[0] || null;
  let slotId = mode === "save" && linked ? linked.id : null;

  const baseName = favDefaultName(target);
  const initialName = mode === "saveAs"
    ? favUniqueName(baseName, slots)
    : favSlotFillName(slotId ? slots.find((f) => f.id === slotId) : null, baseName);

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box fav-save-box">
        <p class="modal-title">${FAV_SAVE_TITLE}</p>

        <label class="fav-field-label" for="fav-save-name">보관 이름</label>
        <input type="text" id="fav-save-name" value="${escapeHtml(initialName)}"
               ${mode === "saveAs" ? "" : "readonly"} />

        <label class="fav-field-label" for="fav-save-desc">설명</label>
        <textarea id="fav-save-desc" rows="3"></textarea>

        <span class="fav-field-label">보관 위치</span>
        <!-- "새로 보관"과 [엑셀 내보내기]를 한 줄에 둔다 — 예전에는 그 사이에
             "아래에서 고르면 그 자리를 덮어씁니다" 줄이 따로 있었는데, CM 지시로 그 문구를
             없애고 빈 줄이 남지 않도록 표를 그만큼 위로 올렸다(2026-09-05). -->
        <div class="status-bar fav-slot-bar">
          <span class="status-bar-left">
            <label class="fav-slot-new">
              <input type="radio" name="fav-save-slot" class="fav-slot-radio" value="" id="fav-slot-new" />
              <span>새로 보관 (<b id="fav-slot-used">${used + 1}</b> / ${limit})</span>
            </label>
          </span>
          <span class="cart-status">
            <button type="button" class="cart-btn" id="fav-slot-export">엑셀 내보내기</button>
          </span>
        </div>
        <div class="table-scroll fav-slot-scroll">
          <table id="fav-slot-table">
            <!-- 칸 폭은 1,000px 팝업(style.css의 .fav-save-box)에서 가로 스크롤이 생기지 않게 잡았다.
                 "편집" 같은 배지 칸과 "보관 일시"는 글자가 잘리지 않을 만큼 주고,
                 "설명"이 남는 폭을 쓴다(길면 잘리되 마우스를 올리면 전체가 보인다). -->
            <colgroup>
              <col style="width:52px" /><col style="width:44px" /><col style="width:300px" />
              <col /><col style="width:52px" /><col style="width:68px" />
              <col style="width:126px" /><col style="width:74px" />
            </colgroup>
            <thead>
              <tr>
                <th data-sort="off">선택</th><th data-sort="off">No</th><th>자료명</th><th>설명</th>
                <th>구분</th><th>편집</th><th>보관 일시</th><th data-sort="off">조치</th>
              </tr>
            </thead>
            <tbody id="fav-slot-tbody"></tbody>
          </table>
        </div>

        <div class="modal-actions">
          <button type="button" id="fav-save-cancel">취소</button>
          <button type="button" class="primary" id="fav-save-ok">보관</button>
        </div>
      </div>
    </div>`);

  const nameInput = layer.querySelector("#fav-save-name");
  const tbody = layer.querySelector("#fav-slot-tbody");
  const newRadio = layer.querySelector("#fav-slot-new");

  const emptyRowHtml =
    '<tr class="fav-slot-empty"><td colspan="8" class="empty">보관해 둔 자료가 없습니다.</td></tr>';

  function slotOf(id) {
    return slots.find((f) => f.id === id) || null;
  }

  // 자리가 다 차면 "새로 보관"을 고를 수 없다 — 그때는 덮어쓰거나, 여기서 하나를 지워야 한다.
  //
  // 괄호 안 숫자는 **지금 보관하면 몇 번째가 되는지**다(2026-09-05 CM 지시 —
  // "기존에 보관된 게 5개라면 새로 보관 (6 / 50)"). 그래서 보관해 둔 개수 + 1을 적는다.
  function applyFull() {
    const full = used >= limit;
    layer.querySelector("#fav-slot-used").textContent = used + 1;
    newRadio.disabled = full;
    newRadio.closest(".fav-slot-new").classList.toggle("is-disabled", full);
  }

  // 고른 자리에 맞춰 이름 칸을 맞춘다([보관하기]는 이름을 직접 못 고치므로 여기서 정해진다).
  //  · 같은 자료의 보관 자리를 고르면 그 자리의 이름을 그대로 쓴다(덮어쓰는 것은 그 자리이지
  //    새 이름을 붙이는 것이 아니므로).
  //  · 다른 자료의 자리를 고르면 그 자리 내용이 지금 자료로 바뀌므로 지금 자료명을 쓴다
  //    (옛 이름을 그대로 두면 이름과 실제 자료가 어긋난다).
  function syncName() {
    if (mode !== "save") return;
    nameInput.value = favSlotFillName(slotId ? slotOf(slotId) : null, baseName);
  }

  // 자료명 왼쪽 돋보기 = 미리보기 (2026-09-05 CM 지시). 어느 자료를 가리키는 자리인지
  // 덮어쓰기 전에 눈으로 확인하기 위한 것이라, 표를 다시 그릴 때마다 같이 걸어 준다.
  //
  // 이 팝업은 미리보기 위에 떠 있을 수도 있는데(미리보기 도구모음 [»]에서 열므로), 그 미리보기를
  // 갈아 끼우면 그때까지 그린 표시가 사라진다. 덮어쓰기 전에 보관해 둔 자료를 확인하려고 누르는
  // 자리인데 그 때문에 편집한 것이 없어지거나 "떠나시겠습니까"를 묻는 것은 곧 덮어쓰지 말라는
  // 말이 되므로, **보던 미리보기는 그대로 두고 한 겹 위에 따로 띄운다**
  // (openDocPreviewAside — 2026-09-06 CM 지시). 그래서 아무것도 묻지 않고 사라지지도 않는다.
  function wireSlotPreviews() {
    const previewList = slots.map(favSlotPreviewItem);
    [...tbody.querySelectorAll("[data-preview-btn]")].forEach((btn, i) => {
      btn.addEventListener("click", () => openDocPreviewAside(previewList, i));
    });
  }

  function renderSlots() {
    tbody.innerHTML = slots.length
      ? slots.map((f, i) => favSlotRowHtml(f, f.id === slotId, i + 1)).join("")
      : emptyRowHtml;
    newRadio.checked = !slotId;
    applyFull();
    wireSlotPreviews();
  }

  renderSlots();
  wireNoticeTableChrome(layer.querySelector("#fav-slot-table"));

  // 줄 아무 데나 눌러도 그 자리가 골라진다(라디오 동그라미를 정확히 겨냥하지 않아도 되게).
  // [지우기]를 누른 것은 여기서 걸러 낸다.
  tbody.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const row = e.target.closest("tr[data-slot-row]");
    if (!row) return;
    const radio = row.querySelector(".fav-slot-radio");
    if (radio) radio.checked = true;
    slotId = Number(row.dataset.slotRow);
    syncName();
  });

  layer.addEventListener("change", (e) => {
    if (!e.target.classList.contains("fav-slot-radio")) return;
    slotId = e.target.value ? Number(e.target.value) : null;
    syncName();
  });

  // 줄마다 [삭제] — 필요 없는 보관 자리를 이 자리에서 비운다(2026-09-05 CM 지시).
  // 지우는 것은 보관해 둔 바로가기뿐이고 자료·파일·이력은 그대로다.
  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-slot-del]");
    if (!btn) return;
    const id = Number(btn.dataset.slotDel);
    const victim = slotOf(id);
    if (!victim) return;
    const ok = await showConfirm(
      `"${favSlotTargetName(victim)}"을(를) 보관 목록에서 지웁니다.\n` +
      `${victim.has_markup ? "함께 보관해 둔 편집 내용도 사라집니다.\n" : ""}` +
      `자료 자체는 그대로 남습니다.\n\n지울까요?`,
    );
    if (!ok) return;
    btn.disabled = true;
    const res = await fetch(`/favorites/${id}`, { method: "DELETE" });
    btn.disabled = false;
    if (!res.ok) {
      await showAlert(await safeErrText(res));
      return;
    }
    // 표를 통째로 다시 그리지 않고 그 줄만 뺀다 — 눌러 둔 정렬 순서를 그대로 지키기 위함.
    // 대신 No 칸은 번호가 비지 않게 다시 매긴다(ui.js가 정렬할 때 쓰는 것과 같은 함수).
    const row = tbody.querySelector(`tr[data-slot-row="${id}"]`);
    if (row) row.remove();
    renumberSortedRows(tbody);
    slots.splice(slots.indexOf(victim), 1);
    const sameIdx = saved.findIndex((f) => f.id === id);
    if (sameIdx !== -1) saved.splice(sameIdx, 1);
    if (!slots.length) tbody.innerHTML = emptyRowHtml;
    if (slotId === id) { slotId = null; newRadio.checked = true; syncName(); }
    used = Math.max(0, used - 1);
    applyFull();
    favInvalidate();
    await refreshFavoriteButtonCount();
    if (typeof opts.onChanged === "function") {
      try { opts.onChanged(); } catch (err) { /* 미리보기가 그 사이 닫혔으면 넘어간다 */ }
    }
  });

  layer.querySelector("#fav-slot-export").addEventListener("click", () => {
    window.location = `/favorites/list/export?columns=slot&title=${encodeURIComponent(FAV_SAVE_TITLE)}`;
  });

  const close = () => popDialogLayer(layer);
  layer.querySelector("#fav-save-cancel").addEventListener("click", close);
  layer.querySelector("#fav-save-ok").addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      await showAlert("보관 이름을 입력하세요.");
      return;
    }
    const overwriteId = slotId;
    if (!overwriteId && used >= limit) {
      await showAlert(`보관은 ${limit}개까지 할 수 있습니다.\n덮어쓸 자리를 고르거나, 표에서 쓰지 않는 것을 지워 주세요.`);
      return;
    }
    if (overwriteId) {
      const victim = slotOf(overwriteId);
      // 다른 자료의 자리를 덮어쓰면 그 자리가 가리키던 자료가 바뀐다 — 그 사실을 분명히 적는다.
      const other = victim && !victim.same
        ? `\n그 자리는 지금 "${favSlotTargetName(victim)}" 자료를 가리키고 있습니다.`
        : "";
      const ok = await showConfirm(
        `"${victim ? favSlotTargetName(victim) : ""}"에 보관해 둔 내용을 지우고 새로 보관합니다.${other}\n\n계속할까요?`,
      );
      if (!ok) return;
    }

    const okBtn = layer.querySelector("#fav-save-ok");
    okBtn.disabled = true;
    okBtn.textContent = "보관 중…";
    const res = await fetch("/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: target.kind,
        document_id: target.kind === "TDB" ? target.documentId : null,
        mdb_file_id: target.kind === "MDB" ? target.mdbFileId : null,
        name,
        source_name: target.name || null,
        description: layer.querySelector("#fav-save-desc").value,
        pdf_file_id: target.pdfFileId ?? null,
        markup: markup.length ? markup : null,
        original_markup: originalMarkup.length ? originalMarkup : null,
        overwrite_id: overwriteId,
        view_mode: viewMode,
      }),
    });
    okBtn.disabled = false;
    okBtn.textContent = "보관";
    if (!res.ok) {
      await showAlert(await safeErrText(res));
      return;
    }
    const item = await res.json();
    close();
    favInvalidate();
    await refreshFavoriteButtonCount();
    if (typeof opts.onSaved === "function") {
      try { opts.onSaved(item.id); } catch (e) { /* 미리보기가 그 사이 닫혔으면 넘어간다 */ }
    }
    await showAlert("보관했습니다.");
  });
}

// ---------------------------------------------------------------------------
// 상단 [보관] 버튼 — [도움말](있을 때) 또는 사용자 이름 왼쪽에 스스로 붙는다
// ---------------------------------------------------------------------------

async function loadFavoriteButton(slot) {
  const summary = await favFetchSummary();
  if (!summary) return;
  const box = document.createElement("span");
  box.className = "fav-btn-box";
  box.innerHTML = `<button type="button" class="notice-btn fav-open-btn" id="favorites-btn">보관 (${summary.count})</button>`;
  // [도움말]이 있으면 그 바로 왼쪽, 없으면 사용자 이름 왼쪽에 둔다. 상단 알림 버튼
  // ([TDB 수정]·[TDB 반출])은 슬롯 맨 앞에 붙으므로 결과 순서는
  // [TDB 수정][TDB 반출][보관][사용자 이름][로그아웃]이 된다.
  // (2026-09-07 [도움말]을 감추면서 기준점을 하나 더 뒀다 — 예전에는 [도움말]이 없으면
  //  슬롯 맨 앞으로 가서 [보관]이 알림 버튼보다 앞에 섰다.)
  const anchor = slot.querySelector("#help-btn") || slot.querySelector("#mypage-link");
  if (anchor) slot.insertBefore(box, anchor);
  else slot.prepend(box);
  document.getElementById("favorites-btn").addEventListener("click", () => openFavoritesPopup());
}

async function refreshFavoriteButtonCount() {
  const btn = document.getElementById("favorites-btn");
  if (!btn) return;
  const summary = await favFetchSummary();
  if (summary) btn.textContent = `보관 (${summary.count})`;
}

// ---------------------------------------------------------------------------
// 목록 팝업
// ---------------------------------------------------------------------------

// 보관해 둔 것을 여는 주소.
//  · 편집 내용이 있으면 주소에 fav 번호를 실어 보내고, 미리보기가 자료를 연 뒤 그 번호로
//    편집 내용을 받아 그대로 되살린다.
//  · favback=1은 "이 팝업에서 들어왔다"는 표시다. 상세보기의 [목록으로]가 그것을 보고
//    돌아갈 주소에 favlist=1을 붙여, 되돌아온 화면에서 이 팝업이 다시 열린다(아래 참고).
//  · from은 지금 있는 화면 — 그래야 [목록으로]가 원래 있던 화면으로 돌아간다(공통 규칙).
function favoriteOpenHref(item) {
  const favQs = item.has_markup ? `&fav=${item.id}` : "";
  // 원본을 보다가 보관한 것이면 원본부터 보여준다(D-102).
  const pvQs = item.view_mode === "original" ? "&pv=o" : "";
  const href = item.kind === "TDB" ? detailHref(item.document_id) : mdbDetailHref(item.mdb_file_id);
  return `${href}${favQs}${pvQs}&favback=1`;
}

function favStateCell(item) {
  if (item.missing) return '<span class="badge badge-warning">삭제됨</span>';
  if (item.renamed) return '<span class="badge badge-warning">이름 바뀜</span>';
  return '<span class="badge badge-neutral">정상</span>';
}

function favPreviewItem(item) {
  return {
    id: item.id,
    drawingNo: item.current_name || item.name,
    path: item.path ?? "",
    pdfFileId: item.kind === "TDB" ? item.pdf_file_id : null,
    // MDB 자료는 미리보기 주소가 다르다(자료의 대표 id로 열면 서버가 PDF를 찾아 준다).
    previewUrl: item.kind === "MDB" && item.pdf_file_id ? `/mdb/files/${item.pdf_file_id}/view` : null,
    favId: item.has_markup ? item.id : null,
    source: item.kind === "TDB" ? tdbSource(item.document_id) : mdbSource(item.mdb_file_id),
    preferOriginal: item.view_mode === "original",
  };
}

async function openFavoritesPopup() {
  const [list, summary] = await Promise.all([favFetchList({ fresh: true }), favFetchSummary()]);
  const limit = summary ? summary.limit : 50;

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box notice-box fav-list-box">
        <div class="notice-head">
          <h2>${FAV_LIST_TITLE}</h2>
        </div>
        <div class="status-bar">
          <span class="status-bar-left">보관 <b>(<span id="fav-used">${list.length}</span> / ${limit})</b></span>
          <span class="cart-status">
            <button type="button" class="cart-btn" id="fav-delete-btn">선택 삭제</button>
            <button type="button" class="cart-btn" id="fav-export-btn">엑셀 내보내기</button>
          </span>
        </div>
        <div class="table-scroll notice-list">
          <table id="fav-table">
            <!-- 칸 폭은 1,180px 팝업에서 가로 스크롤이 생기지 않게 맞춰 잡았다(style.css의 .fav-list-box).
                 "편집"·"상태"는 그 안의 배지가 잘리지 않을 만큼(배지 + 칸 좌우 여백 24px) 넓히고,
                 "설명"은 CM 지시대로 넓게 준다. 경로는 남는 폭을 쓰고, 길면 잘리되 마우스를 올리면 다 보인다. -->
            <colgroup>
              <col style="width:46px" /><col style="width:34px" /><col style="width:250px" />
              <col style="width:290px" /><col style="width:56px" /><col style="width:68px" />
              <col /><col style="width:96px" /><col style="width:126px" />
            </colgroup>
            <thead>
              <tr>
                <th data-sort="off">No</th>
                <th class="col-check" data-sort="off"><input type="checkbox" id="fav-select-all" /></th>
                <th>자료명</th><th>설명</th>
                <th>구분</th><th>편집</th><th>경로</th>
                <th>상태</th><th>보관 일시</th>
              </tr>
            </thead>
            <tbody id="fav-tbody"></tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button type="button" class="primary" id="fav-close-btn">닫기</button>
        </div>
      </div>
    </div>`);

  const tbody = layer.querySelector("#fav-tbody");
  const items = [...list];

  function render() {
    layer.querySelector("#fav-used").textContent = items.length;
    tbody.innerHTML = "";
    if (!items.length) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="empty">보관한 자료가 없습니다. 미리보기의 [»] 안 [보관하기]로 보관해 보세요.</td></tr>';
      return;
    }
    items.forEach((item, i) => {
      const tr = document.createElement("tr");
      if (item.missing) tr.classList.add("warning-row");
      // 자료가 없어졌으면 열 수 없으므로 링크 대신 이름만 보여준다.
      const nameCell = item.missing
        ? `${previewBtnHtml(null)} ${escapeHtml(item.name)}`
        : `${previewBtnHtml(item.pdf_file_id)} <a href="${favoriteOpenHref(item)}">${escapeHtml(item.name)}</a>`;
      // 이름이 바뀌었으면 지금 자료명을 함께 보여준다(보관 이름은 보관할 때 것 그대로 둔다).
      const currentLine = item.renamed
        ? `<div class="fav-current-name" title="지금 자료명">현재: ${escapeHtml(item.current_name || "")}</div>`
        : "";
      // 정렬 값을 따로 적어 주는 칸 둘.
      //  · 자료명 — 칸 안에 돋보기 버튼과 "현재: …" 줄이 함께 있어 글자 그대로 비교하면 어긋난다.
      //  · 설명   — 칸 안이 입력칸(비고 편집)이라 글자가 아예 없어 그대로는 정렬되지 않는다.
      tr.innerHTML = `
        <td class="col-no">${i + 1}</td>
        <td class="tc" data-sort="off"><input type="checkbox" class="fav-row-check" data-id="${item.id}" /></td>
        <td data-sort-value="${escapeHtml(item.name)}">${nameCell}${currentLine}</td>
        <td class="fav-desc-cell${item.description ? " is-clickable" : ""}"
            data-sort-value="${escapeHtml(item.description || "")}">${noteEditCellHtml(item.id, item.description)}</td>
        <td class="tc">${item.kind}</td>
        <td class="tc">${item.has_markup ? '<span class="badge badge-neutral">있음</span>' : ""}</td>
        <td class="path-cell" title="${escapeHtml(item.path || "")}">${escapeHtml(item.path || "")}</td>
        <td class="tc">${favStateCell(item)}</td>
        <td class="muted tc">${fmtDateTime(item.created_at)}</td>
      `;
      tbody.appendChild(tr);
    });

    // 이름 왼쪽 돋보기 = 미리보기. 편집 내용을 보관해 둔 것은 그것까지 되살려 보여준다.
    const previewList = items.map(favPreviewItem);
    [...tbody.querySelectorAll("[data-preview-btn]")].forEach((btn, i) => {
      btn.addEventListener("click", () => openDocPreview(previewList, i));
    });
    // 설명 칸은 다른 화면의 비고 칸과 똑같이 연필 → [확인]으로 고친다.
    // 고치고 나면 그 칸의 정렬 값과 "눌러서 전체 보기"가 새 내용에 맞아야 하므로 함께 맞춰 준다.
    wireNoteEdits(tbody, (id) => `/favorites/${id}/note`, null, (id, note, wrap) => {
      const cell = wrap.closest("td");
      if (cell) {
        cell.dataset.sortValue = note || "";
        cell.classList.toggle("is-clickable", !!note);
      }
      const item = items.find((it) => String(it.id) === String(id));
      if (item) item.description = note || null;
    });
  }

  async function reload() {
    favInvalidate();
    const fresh = await favFetchList({ fresh: true });
    items.splice(0, items.length, ...fresh);
    render();
    layer.querySelector("#fav-select-all").checked = false;
    await refreshFavoriteButtonCount();
  }

  render();
  wireNoticeTableChrome(layer.querySelector("#fav-table"));

  // 설명 내용을 누르면 전체가 팝업으로 뜬다(2026-09-05 CM 지시) — 시스템 로그의 "상세 내용"을
  // 누를 때와 같은 팝업(showDetailTextPopup)이다. 칸이 좁아 잘려 보이는 글을 그 자리에서
  // 전부 읽기 위한 것이라, 연필로 고치는 중일 때는 뜨지 않는다(그때는 글자를 만지는 중이므로).
  tbody.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const cell = e.target.closest(".fav-desc-cell");
    if (!cell) return;
    const input = cell.querySelector(".note-input");
    if (!input || !input.disabled) return;
    const text = input.value.trim();
    if (text) showDetailTextPopup("설명", text);
  });

  const selectAll = layer.querySelector("#fav-select-all");
  selectAll.addEventListener("change", () => {
    layer.querySelectorAll(".fav-row-check").forEach((cb) => { cb.checked = selectAll.checked; });
  });

  layer.querySelector("#fav-delete-btn").addEventListener("click", async () => {
    const ids = [...layer.querySelectorAll(".fav-row-check:checked")].map((cb) => Number(cb.dataset.id));
    if (!ids.length) { await showAlert("지울 항목을 하나 이상 선택하세요."); return; }
    const picked = items.filter((f) => ids.includes(f.id));
    const withMarkup = picked.filter((f) => f.has_markup).length;
    // 지우는 것은 보관해 둔 바로가기뿐이고 자료는 그대로 있다 — 그 사실을 확인창에 적는다.
    const ok = await showConfirm(
      `보관 목록에서 ${ids.length}건을 지웁니다.\n` +
      `${withMarkup ? `그중 ${withMarkup}건은 함께 보관해 둔 편집 내용도 사라집니다.\n` : ""}` +
      `자료 자체는 그대로 남습니다.\n\n지울까요?`,
    );
    if (!ok) return;
    const res = await fetch("/favorites/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      await showAlert(await safeErrText(res));
      return;
    }
    await reload();
  });

  layer.querySelector("#fav-close-btn").addEventListener("click", () => popDialogLayer(layer));
  layer.querySelector("#fav-export-btn").addEventListener("click", () => {
    window.location = `/favorites/list/export?title=${encodeURIComponent(FAV_LIST_TITLE)}`;
  });
}

// ---------------------------------------------------------------------------
// 상단 버튼 붙이기 · 상세보기에서 돌아오면 팝업 다시 열기
// ---------------------------------------------------------------------------
// auth-guard.js가 대신 불러 주지 않는 이유: 그 파일은 <head>에서, 이 파일은 <body> 끝에서
// 읽히므로 로그인 확인이 먼저 끝나면 그 시점에 이 파일의 함수가 아직 없다.
// window.tdmsReady는 auth-guard.js가 만들어 두는 것이라 여기서는 언제나 쓸 수 있다.
//
// 팝업에서 자료명을 눌러 상세보기로 갔다가 [목록으로]를 누르면 이 팝업이 다시 열린다(CM 요청).
// 주소에 favlist=1이 붙어 돌아오는데, 그 표시는 상세보기의 [목록으로]만 붙이므로 상단 메뉴로
// 다른 화면에 갔다가 오는 경우에는 열리지 않는다. 한 번 열고 나면 주소에서 지워, 새로고침하거나
// 즐겨찾기로 그 주소를 보관해 둔 경우에 또 열리지 않게 한다.
(async function attachFavoriteButton() {
  try {
    if (!window.tdmsReady) return;
    await window.tdmsReady;
    const slot = document.getElementById("user-slot");
    if (slot) await loadFavoriteButton(slot);

    const params = new URLSearchParams(window.location.search);
    if (params.get("favlist") === "1") {
      params.delete("favlist");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
      await openFavoritesPopup();
    }
  } catch (e) {
    // 건수를 못 불러와도 화면 나머지는 그대로 동작해야 한다(상단 알림 버튼과 같은 방침).
  }
})();
