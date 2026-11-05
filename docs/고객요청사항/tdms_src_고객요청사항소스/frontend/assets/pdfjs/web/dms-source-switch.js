// 사본(PDF) / 원본(DWG·엑셀 등) 전환 버튼 (D-102, 2026-09-19 CM 지시).
// G.Hub 도면관리시스템이 덧붙인 파일이다 — 원래 PDF.js에는 없다.
//
// 원본은 서버가 미리보기용 PDF로 바꿔 둔 것을 이 뷰어로 띄운다. 사본 창과 원본 창은 바깥 화면(ui.js
// mountDocPreview)이 한 틀에 겹쳐 두고 보이는 쪽만 바꾸므로, 이 버튼은 바깥 화면에 "바꿔 달라"고
// 알리기만 한다. 버튼 자리는 새 줄을 만들지 않고 화면 회전 버튼 바로 뒤다(CM 지시).
//
// 원본을 보는 창에서는 (2026-09-20 CM 지시)
//   · 편집 도구를 사본과 똑같이 쓴다. 다만 강조 표시(형광펜)는 글자를 따라가지 않고 칠한 자리에
//     반투명 색을 그대로 덮는다(dms-tools.js의 원본 창 형광펜 설명) — 사본처럼 "어두운 쪽 남기기"로
//     칠하면 DWG의 검은 바탕에서는 칠해도 보이지 않는다.
//   · 그리기·텍스트의 처음 색은 #f2a900(주황빛 노랑) — 검은 바탕에서 잘 보이게.
//   · [다운로드]는 지금 화면(그린 표시 포함)을 PDF로 받는다. 이름은 `자료명(Dwg_Markup).pdf`
//     (안 그렸으면 `자료명(Dwg).pdf`) — dms-viewer.js ①.
//   · 인쇄는 화면 그대로 나간다(DWG는 검은 바탕까지 그대로 — CM 확정).
//
// 주소에 붙는 값(ui.js가 붙인다):
//   dmsView  : pdf / original — 이 창이 어느 쪽인지. 없으면 전환 버튼을 만들지 않는다(리비전 이력 등).
//   dmsAlt   : 1이면 반대쪽을 볼 수 있다.
//   dmsLabel : 원본 형식(DWG·XLSX…) — 버튼 글자에 쓴다.

export function sourceViewMode() {
  return new URLSearchParams(window.location.search).get("dmsView");
}

function askOuterToSwitch(to) {
  try {
    window.parent.postMessage({ type: "dms-preview-switch", to }, window.location.origin);
  } catch (e) {
    /* 바깥 화면이 없으면(주소만 따로 연 경우) 아무 일도 하지 않는다 */
  }
}

export function installSourceSwitch(app) {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("dmsView");
  if (mode !== "pdf" && mode !== "original") return;
  const altAvailable = params.get("dmsAlt") === "1";
  const label = params.get("dmsLabel") || "";
  const onOriginal = mode === "original";

  const group = document.createElement("div");
  group.className = "toolbarHorizontalGroup dmsSourceSwitch";
  // 원본이 왼쪽, 사본이 오른쪽(2026-09-20 CM 지시)
  group.innerHTML = `
    <button type="button" class="dmsSourceBtn" data-to="original">원본${label ? `(${label})` : ""}</button>
    <button type="button" class="dmsSourceBtn" data-to="pdf">사본(PDF)</button>`;
  const anchor = document.querySelector(".dmsRotateGroup") || document.getElementById("numPages");
  anchor?.after(group);

  for (const btn of group.querySelectorAll(".dmsSourceBtn")) {
    const isCurrent = btn.dataset.to === mode;
    btn.setAttribute("aria-pressed", isCurrent ? "true" : "false");
    btn.classList.toggle("toggled", isCurrent);
    if (isCurrent) {
      btn.title = onOriginal ? "지금 원본을 보고 있습니다" : "지금 사본(PDF)을 보고 있습니다";
      continue;
    }
    if (!altAvailable) {
      btn.disabled = true;
      btn.title = btn.dataset.to === "pdf" ? "사본(PDF)이 없습니다" : "원본 미리보기를 볼 수 없습니다";
      continue;
    }
    btn.title = btn.dataset.to === "pdf" ? "사본(PDF)으로 보기" : "원본으로 보기";
    btn.addEventListener("click", () => askOuterToSwitch(btn.dataset.to));
  }

  if (!onOriginal) return;

  document.body.classList.add("dmsOriginalView");
}
