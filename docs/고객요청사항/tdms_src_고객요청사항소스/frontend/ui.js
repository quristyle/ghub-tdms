// 화면 공통 표시 헬퍼. 여러 페이지에서 같은 규칙으로 상태를 보여주기 위한 것.
// DB에는 영문 코드(ACTIVE 등)가 그대로 저장되고, 화면에만 한글 라벨을 붙인다.

const STATUS_LABEL = {
  ACTIVE: { text: "정상", cls: "badge-success" },
  CHECKED_OUT: { text: "반출", cls: "badge-warning" },
  // 통합필요(MERGE_REQUIRED)는 반출의 한 상태일 뿐이라 목록 화면에서는 "반출"과 똑같이 보여준다.
  // 상태 검색 드롭다운에도 "통합필요"라는 별도 선택지가 없어서, 다르게 보여주면 그 값으로는
  // 검색이 안 되는 문제가 있었다. 반입·검수 화면(중복반출 처리)에서는 여전히 MERGE_REQUIRED로 판단한다.
  MERGE_REQUIRED: { text: "반출", cls: "badge-warning" },
  PENDING: { text: "대기", cls: "badge-neutral" },
  SUPERSEDED: { text: "구본", cls: "badge-neutral" },
};

const REVIEW_LABEL = {
  PENDING_REVIEW: { text: "검수대기", cls: "badge-info" },
  APPROVED: { text: "승인", cls: "badge-success" },
  REJECTED: { text: "반려", cls: "badge-danger" },
  MERGED: { text: "통합됨", cls: "badge-neutral" },
};

function badge(map, code) {
  const item = map[code] || { text: code ?? "", cls: "badge-neutral" };
  return `<span class="badge ${item.cls}">${escapeHtml(item.text)}</span>`;
}

function statusBadge(status) {
  return badge(STATUS_LABEL, status);
}

function reviewBadge(status) {
  return badge(REVIEW_LABEL, status);
}

function purposeBadge(purpose, purposeNote) {
  const title = purposeNote ? ` title="${escapeHtml(purposeNote)}"` : "";
  if (purpose === "MODIFY") return `<span class="badge badge-warning"${title}>수정용</span>`;
  if (purpose === "OTHER") return `<span class="badge badge-neutral"${title}>기타</span>`;
  return `<span class="badge badge-neutral"${title}>참조용</span>`;
}

// 보유 여부: 있으면 초록 Y, 없으면 흐린 점
function yn(value) {
  return value ? '<span class="yn-y">Y</span>' : '<span class="yn-n">·</span>';
}

// 표에서 "해당 없음"을 나타내는 공통 기호 — TDB 조회 DWG·PDF 보유 없음 표시(yn의 ·)와
// 모양·색을 통일한다. 시스템 모든 표에서 값이 없을 때 이 기호를 쓴다.
function naCell() {
  return '<span class="yn-n">·</span>';
}

// 값이 있으면 그대로(HTML 이스케이프해서), 없으면 위 공통 "해당 없음" 기호를 넣는다.
function textOrNa(value) {
  return value ? escapeHtml(value) : naCell();
}

// 현재 Rev 표시. 분기 중에도 Rev 숫자만 그대로 보여준다(상세 화면 Rev 이력에서 분기 내역 확인 가능).
function revLabel(doc) {
  return String(doc.current_rev);
}

function fmtDateTime(value) {
  return value ? value.slice(0, 16).replace("T", " ") : "";
}

// 파일 크기를 사람이 읽는 단위로. 삭제 보관함 완전삭제의 "확보한 용량" 안내가 GB 단위까지
// 나올 수 있어 MDB 상세보기에 있던 것을 여기로 옮겨 공용으로 쓴다.
function formatFileSize(bytes) {
  if (bytes == null) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// 서버가 거절했을 때 그 이유(detail)를 꺼낸다 — 본문이 JSON이 아니면 상태 문구를 그대로.
// TDB 관리·MDB 관리에 같은 것이 따로 있던 것을 여기로 모았다(설비유형 목록 편집·Tag No
// 이력관리를 여러 화면이 함께 쓰게 되면서 화면마다 갖고 있을 이유가 없어졌다).
async function safeErrText(res) {
  try {
    const j = await res.json();
    return j.detail || res.statusText;
  } catch {
    return res.statusText;
  }
}

// ---- 미리보기 팝업 (TDB 조회 / 자료 상세보기 / TDB 반출이력 / TDB 관리 공용) ----
// 예전엔 이 팝업의 HTML·JS가 화면마다(index/detail/distributions/editor) 거의 그대로
// 복사돼 있었다. 여기 한 곳으로 모아서 화면마다 따로 고치지 않아도 되게 한다.
//
// 목록 표의 돋보기 아이콘은 PDF가 없는 항목도 눌린다 — 눌러도 "PDF 없음"만 보이지만, 그 덕분에
// 이전/다음으로 쭉 넘겨보다가 "이 자료는 PDF가 없구나"를 그 자리에서 바로 알 수 있다(예전처럼
// 비활성 처리해서 건너뛰면 그걸 알 방법이 없었다). 아이콘 자체는 PDF 없으면 여전히 흐리게 표시한다.

const searchIconSvg = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6.8" cy="6.8" r="4.8"/><line x1="10.4" y1="10.4" x2="14.2" y2="14.2"/></svg>`;

// hasOriginal: 사본(PDF)이 없어도 원본(DWG·엑셀 등)이 있으면 원본으로 미리보기할 수 있다(D-102).
function previewBtnHtml(fileId, hasOriginal = false) {
  const isEmpty = !fileId && !hasOriginal;
  return `<button type="button" class="preview-icon-btn${isEmpty ? " is-empty" : ""}" data-preview-btn title="${isEmpty ? "PDF 없음" : "미리보기"}">${searchIconSvg}</button>`;
}

// TDB 목록 행에 원본(DWG·엑셀·그 밖)이 있는지 — 목록 API가 형식별로 알려준다.
function tdbHasOriginal(row) {
  return !!(row && (row.has_dwg || row.has_xlsx || row.has_etc));
}

// ===========================================================================
// 미리보기(PDF)를 어느 뷰어로 볼 것인가 — 되돌리는 스위치
// ===========================================================================
// true  = 우리 뷰어(PDF.js, `assets/pdfjs`에 파일로 들어 있다. 인터넷 접속 없음)
//         형광펜 창이 색을 골라도 닫히지 않고, 소리 내어 읽기 아이콘이 없고, 저장 파일명을
//         우리가 정한다(2026-09-02 CM 지시로 시험 도입).
// false = 브라우저(엣지)에 들어 있는 PDF 뷰어 — 2026-09-02 이전과 똑같은 모습
//
// **마음에 안 들면 이 한 줄만 false로 바꾸고 화면을 새로고침하면 원래대로 돌아온다.**
// 아래 함수 하나가 미리보기 주소를 전부 만들고, 미리보기를 여는 모든 화면(TDB·MDB 자료
// 상세보기, 돋보기 팝업, 반입·검수 [비교])이 이 함수를 거치므로 고칠 곳이 여기 말고는 없다.
const USE_OWN_PDF_VIEWER = true;

const PDFJS_VIEWER_PAGE = "/assets/pdfjs/web/viewer.html";
const MARKUP_SUFFIX = "(Markup)"; // assets/pdfjs/web/dms-viewer.js의 같은 이름 상수와 값이 같아야 한다

// viewUrl: 서버에서 PDF를 받는 주소(`/files/12/view` 등), name: 화면에 보이는 자료명,
// favId: 보관 목록에 보관해 둔 편집 내용(도형·문구 등)을 되살려 열 때 그 보관 번호(2026-09-05).
function previewUrlWithSaveName(viewUrl, name, favId) {
  if (!viewUrl) return viewUrl;

  // 우리 뷰어: PDF 주소를 그대로 넘겨준다. 저장 파일명은 서버가 함께 내려주는 파일명(자료명)을
  // 뷰어가 쓰고, 그리기·형광펜으로 고친 뒤 저장할 때만 dms-viewer.js가 (Markup)을 붙인다.
  // fav 번호가 붙어 있으면 뷰어가 자료를 연 뒤 그 편집 내용을 받아 그대로 되살린다.
  if (USE_OWN_PDF_VIEWER) {
    const favQs = favId ? `&fav=${encodeURIComponent(favId)}` : "";
    return `${PDFJS_VIEWER_PAGE}?file=${encodeURIComponent(viewUrl)}${favQs}`;
  }

  // 브라우저 내장 뷰어: [저장]을 눌렀을 때 파일명을 두 가지 방법으로 정한다.
  //   · 손대지 않은 PDF          → 서버가 내려준 이름(= 자료명.pdf)
  //   · 그리기·형광펜으로 고친 PDF → 그 이름을 무시하고 **주소 맨 뒤**를 파일명으로 쓴다
  // 그래서 주소가 `/files/12/view`로 끝나던 예전에는 마크업 후 저장하면 `view.pdf`가 됐다.
  // 주소 뒤에 `자료명(Markup).pdf`를 붙여두면 그 이름으로 저장된다(서버는 이 이름을 쓰지 않는다).
  const base = String(name || "")
    .replace(/\.pdf$/i, "")            // 자료명에 확장자가 붙어 있으면 두 번 적히지 않게
    .replace(/[\\/:*?"<>|]/g, "_")     // 파일명에 쓸 수 없는 문자 (서버 sanitize_path_component와 같은 규칙)
    .trim();
  if (!base) return viewUrl;
  return `${viewUrl}/${encodeURIComponent(base + MARKUP_SUFFIX + ".pdf")}`;
}

// ===========================================================================
// 원본(DWG·엑셀·워드·PPT) 미리보기 — 사본(PDF)과 원본을 한 틀에서 바꿔 본다 (D-102)
// ===========================================================================
// 원본은 서버가 미리보기용 PDF로 바꿔 두고(/preview/original/…), 그것을 사본과 같은 뷰어로 띄운다.
// 한 틀(stage) 안에 사본 창과 원본 창을 겹쳐 두고 보이는 쪽만 바꾼다 — 창을 갈아 끼우면 사본에
// 그리던 표시가 사라지는데, 이렇게 두면 원본을 보고 돌아와도 그대로 남는다(CM 지시).
// 전환 버튼은 뷰어 도구모음(화면 회전 옆)에 있고(dms-source-switch.js), 누르면 이 화면에
// 알려 온다(postMessage). 미리보기 팝업과 TDB·MDB 자료 상세보기가 모두 이 틀 하나를 쓴다.

// 목록 항목이 어느 자료인지 — 서버에 "이 자료의 사본·원본"을 물을 때 쓴다.
function tdbSource(docId) {
  return docId ? { kind: "TDB", docId } : null;
}
function mdbSource(fileId) {
  return fileId ? { kind: "MDB", fileId } : null;
}
// 자료 상세보기 Revision 이력 한 줄(리비전 세트) — 현재본이 아니라 그 세트의 사본·원본을 본다.
function tdbRevSetSource(fileId) {
  return fileId ? { kind: "TDB", setFileId: fileId } : null;
}

const previewSourcesCache = new Map(); // "TDB:12" → 서버 응답(같은 창을 열어 둔 동안 다시 묻지 않는다)

async function fetchPreviewSources(source) {
  const key = source.setFileId ? `TDBSET:${source.setFileId}` : `${source.kind}:${source.docId || source.fileId}`;
  if (previewSourcesCache.has(key)) return previewSourcesCache.get(key);
  const qs = source.setFileId ? `set_file_id=${source.setFileId}`
    : source.kind === "TDB" ? `doc_id=${source.docId}` : `file_id=${source.fileId}`;
  const res = await fetch(`/preview/sources?kind=${source.kind}&${qs}`);
  if (!res.ok) throw new Error(`sources ${res.status}`);
  const data = await res.json();
  previewSourcesCache.set(key, data);
  // 오래 들고 있으면 그 사이 바뀐 자료(리비전 승인 등)를 못 따라가므로 잠시만 기억한다.
  setTimeout(() => previewSourcesCache.delete(key), 60 * 1000);
  return data;
}

const activePreviewStages = new Set(); // 지금 떠 있는 틀들 — 뷰어가 보낸 전환 요청의 주인을 찾는 데 쓴다

function viewerUrlWithParams(url, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

// container 안에 미리보기 틀을 그린다. 돌려주는 값의 preferOriginal은 사용자가 마지막으로 고른 쪽이다.
//   spec.source        : tdbSource(...) / mdbSource(...) — 없으면 사본(pdfUrl)만 보여준다(예전과 같다)
//   spec.pdfUrl        : 사본을 받는 주소(목록이 이미 알고 있는 값)
//   spec.name          : 자료명
//   spec.favId         : 보관해 둔 편집 내용을 되살려 열 때 그 보관 번호
//   spec.preferOriginal: 원본이 있으면 원본으로 열지(연속보기에서 "원본 우선"을 이어 가는 값)
//   spec.onModeChange  : 사용자가 전환 버튼을 눌렀을 때 불린다("pdf" / "original")
//   spec.emptyHtml     : 사본도 원본도 없을 때 보여줄 내용
function mountDocPreview(container, spec) {
  container.innerHTML = `<div class="preview-stage"></div>`;
  const stage = container.firstElementChild;
  const ctl = {
    stage,
    frames: {},            // mode → iframe
    sources: null,
    mode: null,
    preferOriginal: !!spec.preferOriginal,
    destroyed: false,
    spec,
  };
  activePreviewStages.add(ctl);

  const originalViewable = () => {
    const o = ctl.sources?.original;
    return !!(o && !o.unsupported_reason);
  };

  function message(html) {
    let box = stage.querySelector(".preview-stage-msg");
    if (!box) {
      box = document.createElement("div");
      box.className = "preview-stage-msg";
      stage.appendChild(box);
    }
    box.innerHTML = html;
    return box;
  }
  function clearMessage() {
    stage.querySelector(".preview-stage-msg")?.remove();
  }

  function showFrame(mode) {
    for (const [m, f] of Object.entries(ctl.frames)) f.classList.toggle("is-hidden", m !== mode);
    ctl.mode = mode;
  }

  function makeFrame(mode, src) {
    const f = document.createElement("iframe");
    f.src = src;
    f.dataset.previewMode = mode;
    stage.appendChild(f);
    ctl.frames[mode] = f;
    return f;
  }

  async function openOriginal() {
    const o = ctl.sources.original;
    if (ctl.frames.original) { clearMessage(); showFrame("original"); return; }
    // 사본 창은 지우지 않고 뒤로 감춘다(그리던 표시가 남아 있어야 하므로).
    for (const f of Object.values(ctl.frames)) f.classList.add("is-hidden");
    ctl.mode = "original";
    message(`<div class="preview-empty"><div><b>원본(${escapeHtml(o.label)})을 미리보기용으로 바꾸는 중입니다…</b><br>처음 한 번만 시간이 걸립니다(길게는 몇 분).</div></div>`);
    let error = null;
    try {
      const res = await fetch(o.prepare_url, { method: "POST" });
      if (!res.ok) error = (await res.json().catch(() => ({}))).detail || "미리보기를 만들 수 없습니다.";
    } catch (e) {
      error = "미리보기를 만들 수 없습니다.";
    }
    if (ctl.destroyed || ctl.mode !== "original") return; // 그 사이 다른 자료로 넘어갔거나 사본으로 돌아갔다
    if (error) {
      const box = message(`
        <div class="preview-empty"><div>
          <b>${escapeHtml(error)}</b><br>
          <a class="btn btn-secondary" href="${o.download_url}">원본 다운로드</a>
          ${ctl.sources.pdf ? `<button type="button" class="btn btn-secondary" data-back-to-pdf>사본(PDF) 보기</button>` : ""}
        </div></div>`);
      box.querySelector("[data-back-to-pdf]")?.addEventListener("click", () => ctl.switchTo("pdf", true));
      return;
    }
    clearMessage();
    makeFrame("original", viewerUrlWithParams(`${PDFJS_VIEWER_PAGE}?file=${encodeURIComponent(o.view_url)}`, {
      dmsView: "original",
      dmsLabel: o.label,
      dmsAlt: ctl.sources.pdf ? "1" : "0",
      fav: spec.favId,   // 보관해 둔 것이면 원본에 그려 둔 편집 내용도 되살린다(dms-favorite.js)
    }));
    showFrame("original");
  }

  function openPdf() {
    clearMessage();
    if (!ctl.frames.pdf) {
      const base = previewUrlWithSaveName(ctl.sources.pdf.view_url, spec.name, spec.favId);
      // 브라우저 내장 뷰어로 되돌려 둔 경우(USE_OWN_PDF_VIEWER=false)에는 전환 버튼을 붙일 뷰어가 없다.
      const src = USE_OWN_PDF_VIEWER
        ? viewerUrlWithParams(base, {
          dmsView: "pdf",
          dmsAlt: originalViewable() ? "1" : "0",
          dmsLabel: ctl.sources.original?.label || "",
        })
        : base;
      makeFrame("pdf", src);
    }
    showFrame("pdf");
  }

  // user=true: 사용자가 버튼을 눌러 바꾼 것 — "원본 우선/사본 우선"을 기억한다.
  ctl.switchTo = (mode, user = false) => {
    if (ctl.destroyed || !ctl.sources) return;
    if (mode === "original" && !originalViewable()) return;
    if (mode === "pdf" && !ctl.sources.pdf) return;
    if (user) {
      ctl.preferOriginal = mode === "original";
      spec.onModeChange?.(mode);
    }
    if (mode === "original") openOriginal();
    else openPdf();
  };

  ctl.destroy = () => {
    ctl.destroyed = true;
    activePreviewStages.delete(ctl);
  };

  (async () => {
    const fallback = { pdf: spec.pdfUrl ? { view_url: spec.pdfUrl } : null, original: null };
    if (spec.source && USE_OWN_PDF_VIEWER) {
      try {
        ctl.sources = await fetchPreviewSources(spec.source);
      } catch (e) {
        ctl.sources = fallback;
      }
      // 목록이 알고 있는 사본 주소가 따로 있으면(MDB 등) 그것을 그대로 쓴다.
      if (ctl.sources.pdf && spec.pdfUrl) ctl.sources = { ...ctl.sources, pdf: { ...ctl.sources.pdf, view_url: spec.pdfUrl } };
    } else {
      ctl.sources = fallback;
    }
    if (ctl.destroyed) return;

    if (ctl.preferOriginal && originalViewable()) ctl.switchTo("original");
    else if (ctl.sources.pdf) ctl.switchTo("pdf");
    else if (originalViewable()) ctl.switchTo("original");
    else if (ctl.sources.original) {
      // 원본은 있는데 이 형식(HWP 등)이나 이 컴퓨터 설정으로는 미리보기를 못 만드는 경우
      const o = ctl.sources.original;
      message(`
        <div class="preview-empty"><div>
          <b>${escapeHtml(o.unsupported_reason || "미리보기를 만들 수 없습니다.")}</b><br>
          <a class="btn btn-secondary" href="${o.download_url}">원본 다운로드</a>
        </div></div>`);
    } else {
      message(spec.emptyHtml || `<div class="preview-empty"><div><b>PDF를 보유하고 있지 않습니다.</b></div></div>`);
    }
  })();

  return ctl;
}

// 뷰어 안의 전환 버튼이 보내는 요청 — 어느 틀의 창에서 왔는지 찾아 그 틀을 바꾼다.
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.type !== "dms-preview-switch") return;
  for (const ctl of activePreviewStages) {
    if (Object.values(ctl.frames).some((f) => f.contentWindow === event.source)) {
      ctl.switchTo(data.to, true);
      return;
    }
  }
});

// 원본 창이 [보관하기]를 할 때 같은 틀의 사본 창을 찾는다 — 편집 내용은 사본에 그린 것이라
// 원본을 보다가 보관해도 사본의 편집 내용이 함께 보관돼야 한다(CM 지시).
window.dmsPreviewSibling = (win) => {
  for (const ctl of activePreviewStages) {
    const entries = Object.entries(ctl.frames);
    const mine = entries.find(([, f]) => f.contentWindow === win);
    if (!mine) continue;
    const other = entries.find(([m]) => m !== mine[0]);
    return other ? other[1].contentWindow : null;
  }
  return null;
};

// ===========================================================================
// 미리보기에 저장하지 않은 표시를 두고 화면을 떠날 때
// ===========================================================================
// 미리보기에서 그린 표시(그리기·형광펜·도형 등)는 [저장]으로 내려받기 전에는 브라우저 안에만
// 있어서, 그대로 화면을 떠나면 사라진다. 그래서 한 번 물어보는데 아무것도 안 하면 브라우저가
// 제 모양의 경고창("사이트에서 나갈까요?")을 띄운다. 그 창은 브라우저 것이라 모양을 바꿀 수
// 없으므로, 우리 화면 안에서 떠나는 길(상단 메뉴·[목록으로]·표 안 자료명 링크·이전/다음)은
// 여기서 먼저 가로채 시스템 알림창으로 물어본다(2026-09-03 CM 지시).
// 창을 닫거나 브라우저의 뒤로 가기·새로고침으로 떠날 때는 가로챌 방법이 없어 브라우저 경고창이
// 그대로 뜬다 — 그건 브라우저가 정하는 자리다.

// 지금 열려 있는 미리보기 중 저장하지 않은 표시가 있는 것들. 미리보기는 언제나 화면 안의 작은
// 창(iframe)으로 열리고, 팝업 안에 상세보기를 띄운 경우처럼 한 겹 더 들어가 있을 수도 있어
// 안쪽 창까지 따라 들어가 찾는다.
function previewFramesWithMarkup(win = window, found = []) {
  for (let i = 0; i < win.frames.length; i++) {
    try {
      const frame = win.frames[i];
      if (frame.dmsMarkup && frame.dmsMarkup.hasChanges()) found.push(frame);
      previewFramesWithMarkup(frame, found);
    } catch (e) {
      // 다른 주소의 창은 들여다볼 수 없다 — 우리 미리보기가 아니므로 넘어간다
    }
  }
  return found;
}

// 떠나도 되는지 물어본다. 저장 안 한 표시가 하나도 없으면 묻지 않고 그대로 보내준다.
async function confirmLeaveWithMarkup() {
  const frames = previewFramesWithMarkup();
  if (!frames.length) return true;
  const ok = await showConfirm(
    "미리보기에 저장하지 않은 표시가 있습니다.\n이 화면을 떠나면 그 표시는 사라집니다.\n\n떠나시겠습니까?",
  );
  // 떠나기로 했으면 브라우저 경고창이 뒤이어 겹쳐 뜨지 않게 미리보기 쪽에 알려준다.
  if (ok) {
    frames.forEach((f) => {
      try { f.dmsMarkup.allowLeaveOnce(); } catch (e) { /* 그 사이 닫힌 창은 넘어간다 */ }
    });
  }
  return ok;
}

// 링크로 떠나는 길은 화면마다 흩어져 있어 여기서 한 번에 거른다. 저장 안 한 표시가 없으면
// 아무것도 하지 않으므로 평소 조작에는 영향이 없다. 링크 자신이 이미 처리한 클릭
// (e.defaultPrevented)은 그 화면 몫이라 건드리지 않는다.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // 새 탭으로 여는 클릭
  const link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
  if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return;
  if (!previewFramesWithMarkup().length) return;
  e.preventDefault();
  confirmLeaveWithMarkup().then((ok) => {
    if (ok) window.location.href = link.href;
  });
});

// list: 정규화된 항목 배열 [{ id, drawingNo, path, pdfFileId }], index: 지금 열 항목의 위치.
// pdfFileId가 없는 항목도 순서대로 그대로 보여준다(그 자리에서 "PDF 없음"을 보여주면 되므로
// 건너뛸 필요가 없다).
//
// 미리보기 창은 보통 화면에 하나("main")면 된다. 다만 **사용자 보관 팝업의 돋보기**처럼
// "이미 열려 있는 미리보기를 그대로 둔 채" 다른 자료를 봐야 하는 자리가 있어 한 겹 더 띄울 수
// 있게 해 두었다("aside" — 2026-09-06 CM 지시). 보관해 둔 자리가 어떤 자료인지 확인하려고
// 눌렀을 뿐인데 그때까지 그린 표시가 사라지면 안 되기 때문이다(창이 하나뿐이면 그 안의 PDF를
// 갈아 끼우게 되어 그리던 표시가 없어진다).
const previewWindows = new Map(); // key → { root, els, nav }

// "N / 전체" 칸의 N을 직접 입력하고 Enter를 치면 그 번호로 이동한다 — 미리보기 팝업과
// 자료 상세보기 화면이 공용으로 쓴다. getTotal()은 그 시점의 전체 건수, onJump(n)은
// 1~전체로 이미 보정된 번호를 받아 실제 이동을 처리한다.
function wireNavPosInput(input, getTotal, onJump) {
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const n = parseInt(input.value, 10);
    const total = getTotal();
    if (!Number.isFinite(n) || total <= 0) return; // 숫자가 아니면 무시(입력한 값은 그대로 둠)
    onJump(Math.min(Math.max(n, 1), total));
  });
}

// 미리보기 창 하나를 만든다(같은 key로 다시 부르면 이미 만들어 둔 것을 그대로 쓴다).
// 창 안의 칸은 id가 아니라 class로 찾는다 — 창이 둘이 되면 같은 id가 두 번 생기기 때문이다.
// 첫 번째 창(main)에만 예전 id를 그대로 달아 둔다(style.css가 그 id로 폭을 못박아 두었다).
function previewWindow(key) {
  const found = previewWindows.get(key);
  if (found) return found;

  const root = document.createElement("div");
  root.className = "modal-overlay preview-overlay hidden";
  root.innerHTML = `
    <div class="modal-box preview-modal">
      <div class="preview-modal-head">
        <div class="preview-modal-titlebox">
          <h2 class="preview-title"></h2>
          <div class="preview-title-path" title=""></div>
        </div>
        <span class="preview-modal-nav">
          <span class="nav-btn-pair">
            <button type="button" class="nav-step-btn preview-first" title="맨 처음 자료"><span class="nav-arrow dbl-arrow">◀◀</span> 처음</button>
            <button type="button" class="nav-step-btn preview-prev" title="이전 자료"><span class="nav-arrow">◀</span> 이전</button>
          </span>
          <span class="preview-modal-count">
            <input type="text" inputmode="numeric" class="nav-pos-input preview-pos" title="번호를 입력하고 Enter" />
            <span>/ <span class="preview-total"></span></span>
          </span>
          <span class="nav-btn-pair">
            <button type="button" class="nav-step-btn preview-next" title="다음 자료">다음 <span class="nav-arrow">▶</span></button>
            <button type="button" class="nav-step-btn preview-last" title="맨 끝 자료">끝 <span class="nav-arrow dbl-arrow">▶▶</span></button>
          </span>
        </span>
        <button type="button" class="preview-close">닫기</button>
      </div>
      <div class="preview-frame-box"></div>
    </div>`;
  document.body.appendChild(root);

  const els = {
    title: root.querySelector(".preview-title"),
    path: root.querySelector(".preview-title-path"),
    frameBox: root.querySelector(".preview-frame-box"),
    posInput: root.querySelector(".preview-pos"),
    total: root.querySelector(".preview-total"),
    first: root.querySelector(".preview-first"),
    prev: root.querySelector(".preview-prev"),
    next: root.querySelector(".preview-next"),
    last: root.querySelector(".preview-last"),
  };
  if (key === "main") {
    // 예전부터 쓰던 id — style.css와 다른 화면이 이 id로 찾는 자리가 있어 그대로 둔다.
    root.id = "doc-preview-modal";
    els.posInput.id = "doc-preview-pos-input";
  }

  const view = { root, els, nav: { list: [], index: -1 } };
  previewWindows.set(key, view);

  root.querySelector(".preview-close").addEventListener("click", () => closeDocPreview(key));
  els.first.addEventListener("click", () => jumpDocPreview(key, 0));
  els.prev.addEventListener("click", () => stepDocPreview(key, -1));
  els.next.addEventListener("click", () => stepDocPreview(key, 1));
  els.last.addEventListener("click", () => jumpDocPreview(key, view.nav.list.length - 1));
  wireNavPosInput(els.posInput, () => view.nav.list.length, (n) => {
    view.nav.index = n - 1;
    renderDocPreviewFrame(key);
  });
  document.addEventListener("keydown", (e) => {
    if (root.classList.contains("hidden")) return;
    // 맨 앞에 있는 것만 Esc·화살표를 받는다 — 미리보기 위에 팝업이 떠 있으면(미리보기 안
    // [보관하기]로 연 보관 팝업 등) 그 팝업이 앞이므로 미리보기가 가로채지 않는다.
    // Esc로 미리보기가 먼저 닫혀 버리면 그 위 팝업이 갈 곳 없이 남기 때문이다.
    // 미리보기가 두 겹일 때도 앞에 있는 것부터 닫힌다.
    if (!isFrontmostPreview(root)) return;
    if (document.activeElement === els.posInput) return; // 번호 입력 중엔 화살표 키로 페이지가 넘어가지 않게
    if (e.key === "Escape") closeDocPreview(key);
    else if (e.key === "ArrowLeft") stepDocPreview(key, -1);
    else if (e.key === "ArrowRight") stepDocPreview(key, 1);
  });

  return view;
}

// 지금 화면에서 이 미리보기가 맨 앞인지 — 열려 있는 팝업 레이어·다른 미리보기와 견준다.
function isFrontmostPreview(root) {
  const mine = Number(root.style.zIndex) || 0;
  let top = dialogLayerCount() ? DIALOG_Z_BASE + dialogLayerCount() * 2 : 0;
  for (const other of previewWindows.values()) {
    if (other.root === root || other.root.classList.contains("hidden")) continue;
    top = Math.max(top, Number(other.root.style.zIndex) || 0);
  }
  return mine > top;
}

function stepDocPreview(key, dir) {
  const view = previewWindows.get(key);
  if (!view) return;
  const target = view.nav.index + dir;
  if (target < 0 || target >= view.nav.list.length) return;
  view.nav.index = target;
  renderDocPreviewFrame(key);
}

function jumpDocPreview(key, target) {
  const view = previewWindows.get(key);
  if (!view) return;
  if (target < 0 || target >= view.nav.list.length || target === view.nav.index) return;
  view.nav.index = target;
  renderDocPreviewFrame(key);
}

function renderDocPreviewFrame(key) {
  const view = previewWindows.get(key);
  if (!view) return;
  const { els, nav } = view;
  const item = nav.list[nav.index];
  if (!item) return;
  els.title.innerHTML = `미리보기 — ${escapeHtml(item.drawingNo)}`;
  // 경로는 제목과 같은 줄에 붙이면 길 때 통째로 잘려버려서 따로 한 줄을 준다.
  // 그래도 다 못 보여줄 만큼 길면 말줄임표로 자르고, title 속성(hover)로 전체를 보여준다.
  if (item.path) {
    els.path.textContent = item.path;
    els.path.title = item.path;
    els.path.classList.remove("hidden");
  } else {
    els.path.textContent = "";
    els.path.removeAttribute("title");
    els.path.classList.add("hidden");
  }
  // previewUrl을 직접 넘기면 그걸 쓰고(MDB 등 /files/ 아닌 다른 경로), 없으면 TDB 기본 경로.
  // 사본·원본을 한 틀에서 바꿔 보는 것은 mountDocPreview가 맡는다(D-102). 원본으로 바꿔 둔
  // 채 다음 자료로 넘기면 그 자료도 원본부터 보여주고, 원본이 없는 자료만 사본으로 보여준다.
  view.stage?.destroy();
  view.stage = mountDocPreview(els.frameBox, {
    source: item.source || null,
    pdfUrl: item.previewUrl || (item.pdfFileId ? `/files/${item.pdfFileId}/view` : null),
    name: item.drawingNo,
    favId: item.favId,   // 보관 목록에서 연 것이면 보관해 둔 편집 내용까지 되살린다
    preferOriginal: view.preferOriginal,
    onModeChange: (mode) => { view.preferOriginal = mode === "original"; },
  });

  const total = nav.list.length;
  els.posInput.closest(".preview-modal-count").classList.toggle("hidden", total <= 1);
  els.posInput.value = nav.index + 1;
  els.total.textContent = total;

  els.first.disabled = nav.index <= 0;
  els.prev.disabled = nav.index <= 0;
  els.next.disabled = nav.index >= total - 1;
  els.last.disabled = nav.index >= total - 1;

  // 과거 Rev 폴더(P&ID·PFD) 자료면 안내창을 띄운다 — 이전/다음으로 넘어갈 때도 마찬가지다.
  noticeIfOutdatedRev(item.path);
}

// list 안의 index번째 항목을 연다. PDF가 없는 항목이어도 그대로 열어 "PDF 없음"을 보여준다.
function openDocPreviewIn(key, list, index) {
  const item = list[index];
  if (!item) return;
  const view = previewWindow(key);
  view.nav.list = list;
  view.nav.index = index;
  // 새로 열 때는 사본부터(보관 목록에서 원본을 보다가 보관한 것이면 원본부터) 보여준다.
  view.preferOriginal = !!item.preferOriginal;
  // 지금 열려 있는 팝업 레이어보다 한 단계 위에 뜬다(팝업 표의 돋보기로 열었을 때 그 팝업에
  // 가리지 않게). 그 뒤에 열리는 팝업(미리보기 안 [보관하기] 등)은 다시 이 위로 온다.
  // 미리보기가 이미 하나 떠 있으면 그것보다도 한 단계 위에 둔다 — 방금 연 것이 앞이어야
  // 눌리고, Esc도 앞에 있는 것부터 닫힌다(isFrontmostPreview).
  let z = DIALOG_Z_BASE + dialogLayerCount() * 2 + 1;
  for (const other of previewWindows.values()) {
    if (other === view || other.root.classList.contains("hidden")) continue;
    z = Math.max(z, (Number(other.root.style.zIndex) || 0) + 1);
  }
  view.root.style.zIndex = String(z);
  view.root.classList.remove("hidden");
  renderDocPreviewFrame(key);
}

function openDocPreview(list, index) {
  openDocPreviewIn("main", list, index);
}

// 이미 열려 있는 미리보기는 그대로 두고 한 겹 위에 다른 자료를 띄운다.
// 사용자 보관 팝업의 돋보기가 쓴다 — 그리던 표시가 있는 미리보기를 건드리지 않기 위함이다.
function openDocPreviewAside(list, index) {
  openDocPreviewIn("aside", list, index);
}

function closeDocPreview(key = "main") {
  const view = previewWindows.get(key);
  if (!view) return;
  view.root.classList.add("hidden");
  view.stage?.destroy();
  view.stage = null;
  view.els.frameBox.innerHTML = ""; // 안의 미리보기(작은 창)를 비운다
}

// 표에 그려진 미리보기 버튼(data-preview-btn)들에 openDocPreview를 걸어준다. 이제 PDF 유무와
// 상관없이 모든 행에 버튼이 그려지므로, 버튼 순서와 list 순서가 항상 1:1로 대응한다.
// list는 그 표에 실제로 그려진 항목들을 { id, drawingNo, path, pdfFileId } 형태로 정규화한 배열.
function wirePreviewButtons(tbody, list) {
  [...tbody.querySelectorAll("[data-preview-btn]")].forEach((btn, i) => {
    btn.addEventListener("click", () => openDocPreview(list, i));
  });
}

// ===========================================================================
// 과거 Rev 폴더(P&ID·PFD) 안내창 (2026-09-29 CM 지시)
// ===========================================================================
// P&ID(5.2)·PFD(3.2)는 다른 폴더와 달리 리비전을 자료 안의 Revision 이력이 아니라
// `Rev0 (2012)`·`Rev6 (2026)` 같은 연도별 하위 폴더로 나눠 보관한다(D-60·D-61).
// 최신 폴더가 아닌 자료를 모르고 열면 구본을 최신인 줄 알고 쓰게 되므로, 그런 자료를 열 때
// (자료 상세보기·미리보기) "최신 버전이 아닙니다" 안내창을 띄운다. 열람을 막지는 않는다.
//
// 어느 폴더가 과거인지는 서버가 정한다(app/rev_folders.py → GET /documents/rev-folders).
// 폴더 이름을 화면 코드에 박아 두면 Rev 폴더가 늘거나 이름이 바뀔 때 어긋나기 때문이다.

// "로그아웃 전까지 그만 보기" 표시. 탭 안에서만 사는 저장소(sessionStorage)에 두고
// 로그인할 때 지운다(login.js의 goToApp) — 다시 로그인하면 안내창이 되살아난다.
const OLD_REV_NOTICE_OFF_KEY = "dms_old_rev_notice_off";

function oldRevNoticeOff() {
  try {
    return sessionStorage.getItem(OLD_REV_NOTICE_OFF_KEY) === "1";
  } catch (e) {
    return false; // 저장소를 못 쓰는 브라우저 — 안내창이 계속 뜰 뿐이라 그냥 넘어간다
  }
}

function setOldRevNoticeOff(off) {
  try {
    if (off) sessionStorage.setItem(OLD_REV_NOTICE_OFF_KEY, "1");
    else sessionStorage.removeItem(OLD_REV_NOTICE_OFF_KEY);
  } catch (e) {
    /* 위와 같은 이유로 넘어간다 */
  }
}

// 과거 폴더 목록은 화면당 한 번만 받아 둔다(자료를 열 때마다 서버에 묻지 않게).
// 받지 못하면 빈 목록으로 두어 안내창만 안 뜨고 열람은 그대로 되게 한다.
let outdatedRevFoldersPromise = null;

function loadOutdatedRevFolders() {
  if (!outdatedRevFoldersPromise) {
    outdatedRevFoldersPromise = fetch("/documents/rev-folders")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data && data.outdated) || {})
      .catch(() => ({}));
  }
  return outdatedRevFoldersPromise;
}

// 경로를 폴더 이름 조각으로 쪼갠다. 화면마다 경로를 적는 모양이 다르기 때문이다 —
// 자료 상세보기는 저장된 그대로(`5. DRAWINGS\5.2 P&ID\Rev0 (2012)`)를 쓰고, 목록·미리보기는
// 분류를 떼고 ` / `로 이어 붙인 표시용 경로(`5.2 P&ID / Rev0 (2012)`)를 쓴다.
function revPathSegments(path) {
  return String(path || "").split(/\s*[\\/]\s*/).filter(Boolean);
}

// 이 경로가 과거 Rev 폴더면 { folder, latest }, 아니면 null.
// 앞이 잘려 있을 수 있으므로 **뒤에서부터** 짧은 쪽 길이만큼만 견준다.
function outdatedRevInfo(map, path) {
  const segs = revPathSegments(path);
  if (!segs.length) return null;
  for (const key of Object.keys(map)) {
    const keySegs = revPathSegments(key);
    const depth = Math.min(segs.length, keySegs.length);
    let same = true;
    for (let i = 1; i <= depth; i++) {
      if (segs[segs.length - i] !== keySegs[keySegs.length - i]) {
        same = false;
        break;
      }
    }
    if (same) return map[key];
  }
  return null;
}

// 자료를 열 때 부른다(자료 상세보기 화면·미리보기 창). 과거 폴더가 아니거나 "그만 보기"를
// 눌러 뒀으면 아무 일도 하지 않는다.
async function noticeIfOutdatedRev(path) {
  if (!path || oldRevNoticeOff()) return;
  const info = outdatedRevInfo(await loadOutdatedRevFolders(), path);
  if (!info) return;
  if (oldRevNoticeOff()) return; // 목록을 받아오는 사이에 꺼 뒀을 수 있다

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box confirm-box">
        <p><b>최신 버전이 아닙니다.</b></p>
        <p>이 자료는 과거 이력 폴더 <b>${escapeHtml(info.folder)}</b>에 있습니다.<br />
           최신은 <b>${escapeHtml(info.latest)}</b> 폴더입니다.</p>
        <label class="old-rev-skip">
          <input type="checkbox" id="old-rev-skip" />
          과거 이력 폴더 열람 시 안내창 띄우지 않기
        </label>
        <div class="modal-actions">
          <button class="primary" id="old-rev-ok">확인</button>
        </div>
      </div>
    </div>`);
  layer.querySelector("#old-rev-ok").addEventListener("click", () => {
    setOldRevNoticeOff(layer.querySelector("#old-rev-skip").checked);
    popDialogLayer(layer);
  });
}

// ---- 자료 상세보기 화면 이전/다음 이동 ----
// 목록(TDB 조회/TDB 관리/TDB 반출이력) 표를 그릴 때 그 순서를 저장해두면, 상세보기
// 화면(별도 페이지)에서 "이전/다음"으로 같은 순서를 따라 다른 자료로 넘어갈 수 있다.
const DETAIL_NAV_KEY = "dms_detail_nav_ids";

// "검색조건 전체" 목록을 이 화면에서 이미 저장했는지 (2026-08-29 CM 요청).
// 표에 보이는 50건과 검색조건 전체 목록은 서버에서 따로 받아오는데, 어느 쪽 응답이 먼저
// 도착할지는 그때그때 다르다(MDB는 둘이 거의 동시에 온다). 전체가 먼저 도착하면 뒤늦게 그려진
// 표가 그것을 50건으로 덮어써서 상세보기 이전/다음이 50건 안에서만 움직이는 문제가 있었다.
// 도착 순서와 상관없이 항상 "전체"가 이기도록 이 표시 하나로 정리한다.
let detailNavFullSaved = false;

// 그 목록이 곧 전부일 때 쓴다 (검색조건 전체 목록, 또는 애초에 페이지 나눔이 없는 표).
function saveDetailNavList(ids) {
  detailNavFullSaved = true;
  sessionStorage.setItem(DETAIL_NAV_KEY, JSON.stringify(ids));
}

// 지금 페이지(50건)만 아는 상태의 임시 목록. 전체 목록이 이미 저장돼 있으면 덮지 않는다.
function saveDetailNavPageList(ids) {
  if (detailNavFullSaved) return;
  sessionStorage.setItem(DETAIL_NAV_KEY, JSON.stringify(ids));
}

// 검색조건이 바뀌어 전체 목록을 새로 받기 시작할 때 — 이전 검색의 전체 목록이 남아
// 새 검색의 임시 목록(위 saveDetailNavPageList)을 막지 않도록 표시를 지운다.
function beginDetailNavFullList() {
  detailNavFullSaved = false;
}

function getDetailNavList() {
  try {
    return JSON.parse(sessionStorage.getItem(DETAIL_NAV_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

// 표를 그릴 때 saveDetailNavList를 한 번만 불러두면, 화면 안에 자료명 표가 두 개 이상일 때
// (TDB 반입·검수의 확인필요 등) 나중에 그려진 표가 먼저 그려진 표의 목록을 덮어써서,
// 실제로는 안 누른 표의 순서로 이전/다음이 동작하는 문제가 있었다. 그래서 자료명 링크를
// 누르는 그 순간에 "그 표에 지금 조회된 자료들"로 다시 저장해 항상 클릭한 표 기준으로 맞춘다.
//
// 검수 대기 표는 자료명이 링크가 아니라 텍스트라 여기 해당하지 않는다 — 같은 문서가 분기
// (a/b 등) 여러 행으로 겹쳐 나올 때 상세보기 이전/다음이 어느 행인지 구분 못 하는 문제가
// 있었고, 검수는 돋보기 미리보기로 각 행의 실제 파일을 바로 확인하는 것으로 충분하다.
function wireDetailLinks(tbody, ids) {
  tbody.querySelectorAll('a[href^="detail.html"]').forEach((a, i) => {
    const url = new URL(a.getAttribute("href"), window.location.href);
    url.searchParams.set("navpos", i);
    a.setAttribute("href", `${url.pathname}${url.search}`);
    a.addEventListener("click", () => saveDetailNavList(ids));
  });
}

// 페이지를 나눠 보여주는 목록 화면(TDB 조회·TDB 관리·MDB 조회·MDB 관리) 전용 (2026-08-29 CM 요청).
// 이 화면들은 상세보기 이전/다음이 표에 보이는 50건이 아니라 검색조건 전체를 넘나들어야 한다.
// 전체 목록은 표보다 조금 늦게 도착할 수 있어서, 그 전에 자료명을 누르면 50건짜리 임시 목록으로
// 상세보기가 열려버린다. 그래서 아직 안 왔으면 도착할 때까지 기다렸다가 상세보기로 넘어간다
// (보통은 이미 도착해 있어서 그냥 바로 열린다).
//
// 여기서는 navpos(몇 번째 행인지)를 붙이지 않는다 — 이 표들은 자료 1건이 1행이라 상세보기가
// 자료 id로 위치를 정확히 찾을 수 있고, 붙이면 오히려 표 안 순번(0~49)이 전체 목록 순번과
// 어긋나기 때문이다. navpos는 같은 자료가 여러 행에 겹쳐 나오는 표(반출이력·감사로그·확인필요)
// 에서만 쓴다(위 wireDetailLinks).
function wireDetailLinksFullNav(tbody, getNavListPromise) {
  tbody.querySelectorAll('a[href^="detail.html"], a[href^="mdb-detail.html"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      if (detailNavFullSaved) return; // 전체 목록이 이미 저장돼 있으면 그대로 이동
      const href = a.getAttribute("href");
      e.preventDefault();
      const go = () => { window.location.href = href; };
      Promise.resolve(getNavListPromise()).then(go, go); // 못 받아왔더라도 이동은 한다
    });
  });
}

// ---- 표 헤더 너비를 화면전환 후에도 유지하기 ----
// 상세보기 등 다른 화면 갔다가 "목록으로" 돌아오면 페이지가 통째로 다시 로드되므로, 드래그로
// 조절한 너비를 sessionStorage에 저장해뒀다가 복원한다. key는 페이지+표 단위로 고유해야 한다
// (예: "index:doc-table"). 새로고침(F5)했을 때는 디폴트로 돌아가야 하므로, 그때만 저장값을 지운다.
const COL_WIDTH_PREFIX = "dms_col_widths:";

(function clearColumnWidthsOnReload() {
  const nav = performance.getEntriesByType("navigation")[0];
  if (nav && nav.type === "reload") {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(COL_WIDTH_PREFIX))
      .forEach((k) => sessionStorage.removeItem(k));
  }
})();

// ---- 로고 클릭(전체 초기화) / 지금 보는 화면의 메뉴 재클릭(그 화면만 초기화) ----
// 로고·메뉴는 그냥 해당 화면으로 이동하는 링크라 새로고침(F5)과 달리 위 clearColumnWidthsOnReload가
// 동작하지 않고, 폴더 트리 너비처럼 localStorage에 저장된 값(F5로도 안 지워짐)도 그대로 남는다.
// CM 요청(2026-08-15)으로 로고는 "전체 초기화", 2026-08-16 요청으로 "지금 보는 화면의 상단
// 메뉴를 다시 누르면 그 화면만 초기화"가 되도록 화면별 저장 키를 여기 한곳에 모아둔다.
// 새 화면이 검색조건·트리너비·표너비를 저장하게 되면 아래 PAGE_UI_STATE에도 같이 추가할 것.
const PAGE_UI_STATE = {
  "index.html": { stateKey: "dms_list_state", treeWidthKey: "dms_tree_width", colWidthPrefix: "index:" },
  "editor.html": { stateKey: "dms_editor_state", treeWidthKey: "dms_editor_tree_width", colWidthPrefix: "editor:" },
  "mdb.html": { stateKey: "dms_mdb_state", treeWidthKey: "dms_mdb_tree_width", colWidthPrefix: "mdb:" },
  "mdb-editor.html": { stateKey: "dms_mdb_editor_state", treeWidthKey: "dms_mdb_editor_tree_width", colWidthPrefix: "mdb-editor:" },
  "distributions.html": { stateKey: "dms_distributions_state", colWidthPrefix: "distributions:" },
  "audit.html": { stateKey: "dms_audit_state" },
  "users.html": { stateKey: "dms_users_state" },
  "import.html": { stateKey: "dms_import_sel_state", colWidthPrefix: "import:" },
};

function resetPageUiState(info) {
  if (!info) return;
  if (info.treeWidthKey) localStorage.removeItem(info.treeWidthKey);
  if (info.stateKey) sessionStorage.removeItem(info.stateKey);
  if (info.colWidthPrefix) {
    const prefix = COL_WIDTH_PREFIX + info.colWidthPrefix;
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(prefix))
      .forEach((k) => sessionStorage.removeItem(k));
  }
}

function resetAllUiStateForLogoClick() {
  Object.values(PAGE_UI_STATE).forEach(resetPageUiState);
  sessionStorage.removeItem(DETAIL_NAV_KEY);
}

document.querySelectorAll(".app-brand").forEach((el) => {
  el.addEventListener("click", resetAllUiStateForLogoClick);
});

// 상단 메뉴에서 지금 보고 있는 화면(class="active")을 다시 누르면 그 화면 하나만 초기화한다.
document.querySelectorAll(".app-nav a.active").forEach((el) => {
  el.addEventListener("click", () => {
    const filename = (el.getAttribute("href") || "").split("/").pop();
    resetPageUiState(PAGE_UI_STATE[filename]);
  });
});

// defaults는 이 함수를 부르는 시점(= restore 전, HTML 그대로)의 colgroup 값을 그대로 스냅샷해둔다.
// reset()이 그 값으로 되돌리므로, 페이지 쪽에서 디폴트 폭을 따로 하드코딩할 필요가 없다.
function persistedColumnWidths(table, key) {
  const storageKey = COL_WIDTH_PREFIX + key;
  const defaults = [...table.querySelectorAll("colgroup col")].map((c) => c.style.width || "");

  function save() {
    const widths = [...table.querySelectorAll("colgroup col")].map((c) => c.style.width || "");
    sessionStorage.setItem(storageKey, JSON.stringify(widths));
  }

  function restore() {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    try {
      const widths = JSON.parse(raw);
      [...table.querySelectorAll("colgroup col")].forEach((c, i) => {
        if (widths[i]) c.style.width = widths[i];
      });
    } catch (e) {
      /* 무시 */
    }
  }

  function reset() {
    sessionStorage.removeItem(storageKey);
    [...table.querySelectorAll("colgroup col")].forEach((c, i) => {
      c.style.width = defaults[i] || "";
    });
  }

  return { save, restore, reset };
}

// 표 헤더 오른쪽 끝을 드래그해서 열 너비를 바꿀 수 있게 한다.
// 실제 너비는 <colgroup>의 <col>이 정하므로(표 자체 table-layout:fixed), 드래그도 그 col을 조정한다.
// 그래야 목록 내용(폴더 이동 등)이 바뀌어도 너비가 흔들리지 않고, 새로고침하면 HTML의 기본값으로 되돌아간다.
//
// 표 전체 폭은 항상 유지된다(가로 스크롤이 생기지 않는다). 폭을 주고받는 방식은:
//  - 오른쪽으로 넓힘: 바로 오른쪽 열부터 순서대로 최소 폭(MIN_WIDTH)까지 줄여 흡수한다.
//    첫 오른쪽 열이 최소 폭에 닿으면 그 다음 열, 또 그 다음… 식으로 이어진다.
//    (도면목록의 "경로" 옆에 좁은 열들이 몰려 있는 경우에도 자연스럽게 넓혀진다)
//  - 왼쪽으로 좁힘: 바로 오른쪽 열이 그만큼 넓어진다(인접 두 열끼리만 주고받음).
function makeColumnsResizable(table, onResize) {
  table.classList.add("resizable");
  const ths = [...table.querySelectorAll("thead th")];
  const cols = [...table.querySelectorAll("colgroup col")];

  // "경로"처럼 폭을 지정 안 한(auto) 열은 표 전체 폭에서 나머지 열들의 폭을 뺀 값으로 확정해둔다.
  // (브라우저가 auto 열의 렌더 폭을 이 시점에 항상 정확히 돌려주지는 않아서 직접 계산한다)
  const autoIndex = cols.findIndex((col) => !col.style.width);
  if (autoIndex !== -1) {
    const tableWidth = table.getBoundingClientRect().width;
    const specifiedSum = cols.reduce(
      (sum, col, i) => (i === autoIndex ? sum : sum + parseFloat(col.style.width || "0")),
      0
    );
    cols[autoIndex].style.width = Math.max(60, tableWidth - specifiedSum) + "px";
  }

  const MIN_WIDTH = 34;

  ths.forEach((th, i) => {
    const col = cols[i];
    if (!col || th.querySelector(".col-resize-handle")) return;
    // 오른쪽으로 흡수할 열이 하나도 없으면(=마지막 열) 리사이즈 불가.
    if (i >= cols.length - 1) return;

    const handle = document.createElement("div");
    handle.className = "col-resize-handle";
    th.appendChild(handle);

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = parseFloat(col.style.width);
      // 오른쪽 열들 시작 폭을 전부 기억해뒀다가, 드래그 위치에 따라 각 열 폭을 다시 계산.
      const rightCols = cols.slice(i + 1).map((c) => ({
        col: c,
        startWidth: parseFloat(c.style.width),
      }));
      const totalRightSlack = rightCols.reduce(
        (s, r) => s + Math.max(0, r.startWidth - MIN_WIDTH), 0
      );
      handle.classList.add("resizing");

      function onMove(ev) {
        let delta = ev.clientX - startX;
        delta = Math.max(delta, -(startWidth - MIN_WIDTH));  // 자기 열이 MIN 이하로 못 감
        delta = Math.min(delta, totalRightSlack);            // 오른쪽 전체 여유폭 이상 못 넓힘

        col.style.width = startWidth + delta + "px";

        if (delta >= 0) {
          // 오른쪽으로 넓힘 — 오른쪽 열들에서 순서대로 흡수
          let need = delta;
          for (const r of rightCols) {
            const canShrink = Math.max(0, r.startWidth - MIN_WIDTH);
            const take = Math.min(need, canShrink);
            r.col.style.width = (r.startWidth - take) + "px";
            need -= take;
          }
        } else {
          // 왼쪽으로 좁힘 — 바로 오른쪽 열만 그만큼 넓어진다(나머지는 원래대로 유지)
          rightCols.forEach((r, idx) => {
            r.col.style.width = (idx === 0 ? r.startWidth - delta : r.startWidth) + "px";
          });
        }
      }
      function onUp() {
        handle.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (typeof onResize === "function") onResize();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// ---- 표 헤더 클릭 정렬 (오름차순 ↔ 내림차순) ----
// 헤더 글씨가 없거나 data-sort="off"인 칸(No, 액션 버튼 칸 등)은 정렬 대상에서 뺀다.
//
// 정렬은 항상 "조회 결과 전체"가 기준이다 (2026-08-14 CM 확정 공통 규칙).
//   - 페이지가 나뉘는 표(TDB 조회 등)는 화면에 50건만 있으므로 그것만 정렬하면 안 된다.
//     이런 표는 헤더에 data-sort-key를 달고 makeSortable에 onServerSort를 넘긴다 —
//     서버가 전체를 정렬해서 1페이지부터 다시 내려준다.
//   - 페이지가 없는 표(팝업·검수 대기 등 한 번에 다 보여주는 표)는 화면에 그려진 행이
//     곧 전체이므로 지금처럼 여기서 정렬해도 결과가 같다.

// 값이 통째로 숫자일 때만 숫자로 비교한다. "2026-07-16 10:03" 같은 날짜를 parseFloat에
// 맡기면 앞의 2026만 읽혀서 같은 해 날짜가 전부 동점이 돼버린다(= 눌러도 순서가 안 바뀜).
function numericCellValue(raw) {
  const cleaned = raw.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
}

function compareCellValues(cellA, cellB) {
  const rawA = (cellA?.dataset.sortValue ?? cellA?.textContent ?? "").trim();
  const rawB = (cellB?.dataset.sortValue ?? cellB?.textContent ?? "").trim();
  const numA = numericCellValue(rawA);
  const numB = numericCellValue(rawB);
  if (numA !== null && numB !== null) {
    return numA - numB;
  }
  return rawA.localeCompare(rawB, "ko");
}

// No 열은 렌더 시점의 순번(도면목록은 페이지 넘어가도 이어지는 번호)이라, 정렬 후에도
// 원래 시작 번호부터 다시 이어서 매긴다 — 무조건 1부터로 리셋하면 그 규칙이 깨진다.
function renumberSortedRows(tbody) {
  const noCells = [...tbody.querySelectorAll("td.col-no")];
  if (noCells.length === 0) return;
  const nums = noCells.map((c) => parseInt(c.textContent, 10)).filter((n) => !isNaN(n));
  const startNo = nums.length ? Math.min(...nums) : 1;
  noCells.forEach((cell, i) => {
    cell.textContent = startNo + i;
  });
}

function sortTableRows(table, colIndex, dir) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll("tr")].filter((r) => r.children.length > colIndex);
  if (rows.length < 2) return;
  rows.sort((a, b) => compareCellValues(a.children[colIndex], b.children[colIndex]) * dir);
  rows.forEach((r) => tbody.appendChild(r));
  renumberSortedRows(tbody);
}

// onServerSort(key, dir)를 넘기면 data-sort-key가 달린 칸은 화면에서 정렬하지 않고
// 그 함수를 부른다(dir은 "asc"/"desc"). 부르는 쪽에서 서버에 조건을 보내 1페이지부터 다시
// 받아 그리면 된다. 헤더는 다시 그리지 않으므로 정렬 표시(진한 글씨)는 그대로 유지된다.
function makeSortable(table, onServerSort) {
  if (!table) return;
  const ths = [...table.querySelectorAll("thead th")];
  let sortState = { index: -1, dir: 1 };

  ths.forEach((th, index) => {
    if (th.dataset.sort === "off" || !th.textContent.trim()) return;
    th.classList.add("sortable-th");

    th.addEventListener("click", (e) => {
      if (e.target.closest(".col-resize-handle")) return;
      const dir = sortState.index === index && sortState.dir === 1 ? -1 : 1;
      sortState = { index, dir };
      if (onServerSort && th.dataset.sortKey) {
        onServerSort(th.dataset.sortKey, dir === 1 ? "asc" : "desc");
      } else {
        sortTableRows(table, index, dir);
      }
      ths.forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(dir === 1 ? "sort-asc" : "sort-desc");
    });
  });

  // 화면을 다녀와서 저장해둔 정렬 조건으로 다시 그렸을 때, 어느 열로 정렬 중인지 표시를 되살린다.
  return function showSortedColumn(key, dir) {
    ths.forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
    if (!key) return;
    const index = ths.findIndex((h) => h.dataset.sortKey === key);
    if (index === -1) return;
    sortState = { index, dir: dir === "desc" ? -1 : 1 };
    ths[index].classList.add(dir === "desc" ? "sort-desc" : "sort-asc");
  };
}

// ---- 표 안 비고(메모) 칸 — 평소엔 읽기 전용이다가 연필(✎)을 눌러야 입력 가능해지고,
// 그때만 [확인] 버튼이 나타난다. 실수로 스치듯 고치는 걸 막기 위함.
// 자료 상세보기의 Revision 이력·반출 이력 비고, TDB 관리 삭제 보관함의 비고까지 여러 화면이 같이 쓴다.
function noteEditCellHtml(id, note) {
  const safeNote = escapeHtml(note ?? "");
  return `
    <div class="note-edit" data-id="${id}">
      <input type="text" class="note-input" value="${safeNote}" placeholder="비고 입력" disabled />
      <button type="button" class="note-edit-btn" data-note-edit title="수정">✎</button>
      <button type="button" class="small note-confirm-btn hidden" data-note-confirm>확인</button>
    </div>
  `;
}

// permKey를 주면 그 권한이 없는 사용자는 비고 내용은 그대로 보이되(조회는 항상 허용) 연필
// 버튼만 흐리게 막는다 — "공통 > 비고 작성" 권한 트리(2026-08-17 CM 확정)와 짝을 이룬다.
//
// onSaved(id, note, wrap)는 저장이 끝난 뒤 부르는 선택 인자다(2026-09-05 추가). 표가 그 값으로
// 무언가를 더 맞춰야 할 때 쓴다 — 보관 목록 팝업은 설명 칸의 정렬 값을 여기서 다시 맞춘다.
// 안 넘기면 예전과 똑같이 동작하므로 기존 화면은 손댈 것이 없다.
function wireNoteEdits(tbody, saveUrlFn, permKey, onSaved) {
  const allowed = !permKey || (window.__tdmsPerms && window.__tdmsPerms.has(permKey));

  tbody.querySelectorAll(".note-edit").forEach((wrap) => {
    const input = wrap.querySelector(".note-input");
    const editBtn = wrap.querySelector("[data-note-edit]");
    const confirmBtn = wrap.querySelector("[data-note-confirm]");

    if (!allowed) {
      window.applyPermDisabled(editBtn);
      return;
    }

    editBtn.addEventListener("click", () => {
      input.disabled = false;
      input.focus();
      input.select();
      editBtn.classList.add("hidden");
      confirmBtn.classList.remove("hidden");
    });

    confirmBtn.addEventListener("click", async () => {
      const note = input.value.trim();
      confirmBtn.disabled = true;
      const res = await fetch(saveUrlFn(wrap.dataset.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || null }),
      });
      confirmBtn.disabled = false;
      if (!res.ok) {
        await showAlert("비고 저장에 실패했습니다.");
        return;
      }
      input.disabled = true;
      confirmBtn.classList.add("hidden");
      editBtn.classList.remove("hidden");
      if (typeof onSaved === "function") onSaved(wrap.dataset.id, note, wrap);
    });
  });
}

// ---- 알림 · 확인 · 입력용 자체 대화상자 (네이티브 alert/confirm/prompt 대체) ----
// 네이티브 창은 브라우저 주소가 찍혀 나와서 대신 이 모달을 쓴다. 어느 화면에서 불러도 같은 디자인.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function dialogMessageHtml(message) {
  return escapeHtml(message).replace(/\n/g, "<br>");
}

function ensureDialogRoot() {
  let root = document.getElementById("shared-dialog-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "shared-dialog-root";
    document.body.appendChild(root);
  }
  return root;
}

// 팝업·미리보기가 앞뒤로 겹칠 때의 순서 (2026-09-05 정리)
// -------------------------------------------------------------------------
// 겹치는 것은 둘뿐이다 — 아래 pushDialogLayer가 쌓는 팝업 레이어와 미리보기 팝업.
// 둘은 서로를 열 수 있어(팝업 표의 돋보기 → 미리보기, 미리보기 안 [보관하기] → 보관 팝업)
// 어느 한쪽을 늘 위로 두면 반드시 한 경우가 가려진다. 그래서 **나중에 연 것이 위로** 오도록
// 열 때마다 번호를 매긴다.
//   팝업 레이어 : 200 + 쌓인 순서 × 2   (202, 204, 206 …)
//   미리보기    : 그때 맨 위 레이어 + 1  (그 레이어보다 위, 다음 레이어보다 아래)
// 미리보기 팝업은 화면에 하나뿐이라(열려 있는 것을 갈아 끼운다) 번호가 하나면 된다.
const DIALOG_Z_BASE = 200;

function applyDialogLayerZ(layer, index) {
  // 레이어에 번호만 적어 두고 실제 앞뒤 순서(z-index)는 CSS가 그 값을 읽어 쓴다
  // (style.css의 `.dialog-layer .modal-overlay`). 여기서 창에 직접 값을 박아 넣으면,
  // 팝업 내용을 나중에 채워 넣는 경우(mdb-types.js의 목록 편집 팝업)에 그때 만들어진
  // 창이 번호를 못 받아 다른 팝업 뒤로 숨는다.
  layer.style.setProperty("--dialog-z", String(DIALOG_Z_BASE + index * 2));
}

// 지금 쌓여 있는 팝업 레이어 수(미리보기가 자기 번호를 정할 때 쓴다).
function dialogLayerCount() {
  const root = document.getElementById("shared-dialog-root");
  return root ? root.children.length : 0;
}

// 팝업 위에 팝업이 뜨는 경우(예: 마이페이지 팝업 안에서 알림창), 뒤 팝업을 지우지 않고
// 그 위에 새 레이어를 쌓는다 — 앞 레이어를 닫으면 뒤 레이어가 그대로 남아있어야 하기 때문
// (2026-08-13 CM 확정 규칙, 전 화면 공통). 뒤 레이어는 흐리게 표시하고 조작을 막는다.
function pushDialogLayer(html) {
  const root = ensureDialogRoot();
  const prevTop = root.lastElementChild;
  if (prevTop) prevTop.classList.add("dialog-layer-dim");
  const layer = document.createElement("div");
  layer.className = "dialog-layer";
  layer.innerHTML = html;
  root.appendChild(layer);
  applyDialogLayerZ(layer, root.children.length);
  return layer;
}

function popDialogLayer(layer) {
  const root = layer.parentElement;
  layer.remove();
  if (root && root.lastElementChild) root.lastElementChild.classList.remove("dialog-layer-dim");
}

function showAlert(message) {
  return new Promise((resolve) => {
    const layer = pushDialogLayer(`
      <div class="modal-overlay">
        <div class="modal-box confirm-box">
          <p>${dialogMessageHtml(message)}</p>
          <div class="modal-actions">
            <button class="primary" id="shared-dialog-ok">확인</button>
          </div>
        </div>
      </div>`);
    layer.querySelector("#shared-dialog-ok").addEventListener("click", () => {
      popDialogLayer(layer);
      resolve();
    });
  });
}

// showAlert에 제목을 붙인 버전 — 표 칸에 잘려 보이는 긴 텍스트를 눌렀을 때 전체 내용을 보여주는
// 용도(시스템 로그의 "상세 내용" 등). confirm-box(560px)라 대부분의 내용이 한 화면에 다 보인다.
function showDetailTextPopup(title, message) {
  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box confirm-box">
        <div class="section-head" style="margin-bottom:10px">
          <h2 style="font-size:15px">${escapeHtml(title)}</h2>
        </div>
        <p>${dialogMessageHtml(message)}</p>
        <div class="modal-actions">
          <button class="primary" id="shared-dialog-ok">확인</button>
        </div>
      </div>
    </div>`);
  layer.querySelector("#shared-dialog-ok").addEventListener("click", () => {
    popDialogLayer(layer);
  });
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const layer = pushDialogLayer(`
      <div class="modal-overlay">
        <div class="modal-box confirm-box">
          <p>${dialogMessageHtml(message)}</p>
          <div class="modal-actions">
            <button id="shared-dialog-cancel">취소</button>
            <button class="primary" id="shared-dialog-ok">확인</button>
          </div>
        </div>
      </div>`);
    function finish(result) {
      popDialogLayer(layer);
      resolve(result);
    }
    layer.querySelector("#shared-dialog-ok").addEventListener("click", () => finish(true));
    layer.querySelector("#shared-dialog-cancel").addEventListener("click", () => finish(false));
  });
}

// 예/아니오로 나눌 수 없는 갈림길용(선택지 2개 + 취소). choices = [{ value, label, primary }].
// 취소하면 null을 돌려준다(showPrompt와 같은 규칙).
function showChoice(message, choices) {
  return new Promise((resolve) => {
    const buttons = choices
      .map((c, i) => `<button class="${c.primary ? "primary" : ""}" data-choice="${i}">${escapeHtml(c.label)}</button>`)
      .join("");
    const layer = pushDialogLayer(`
      <div class="modal-overlay">
        <div class="modal-box confirm-box">
          <p>${dialogMessageHtml(message)}</p>
          <div class="modal-actions">
            <button id="shared-dialog-cancel">취소</button>
            ${buttons}
          </div>
        </div>
      </div>`);
    function finish(result) {
      popDialogLayer(layer);
      resolve(result);
    }
    layer.querySelectorAll("[data-choice]").forEach((btn) => {
      btn.addEventListener("click", () => finish(choices[Number(btn.dataset.choice)].value));
    });
    layer.querySelector("#shared-dialog-cancel").addEventListener("click", () => finish(null));
  });
}

// 반환값이 null이면 취소한 것 (기존 window.prompt와 동일한 규칙)
function showPrompt(message, defaultValue = "") {
  return new Promise((resolve) => {
    const layer = pushDialogLayer(`
      <div class="modal-overlay">
        <div class="modal-box confirm-box">
          <p>${dialogMessageHtml(message)}</p>
          <input type="text" id="shared-dialog-input" value="${escapeHtml(defaultValue)}" />
          <div class="modal-actions">
            <button id="shared-dialog-cancel">취소</button>
            <button class="primary" id="shared-dialog-ok">확인</button>
          </div>
        </div>
      </div>`);
    function finish(result) {
      popDialogLayer(layer);
      resolve(result);
    }
    const input = layer.querySelector("#shared-dialog-input");
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
    });
    layer.querySelector("#shared-dialog-ok").addEventListener("click", () => finish(input.value));
    layer.querySelector("#shared-dialog-cancel").addEventListener("click", () => finish(null));
  });
}

// ---- 파일 끌어다 놓기 ----
// 기존 [파일 선택] 버튼은 그대로 두고, 그 아래에 끌어다 놓는 칸을 하나 더 붙인다.
// 탐색기에서 끌어온 파일을 <input type="file">에 그대로 담아주므로,
// 업로드하는 쪽 코드는 파일 선택으로 골랐을 때와 똑같이 input.files만 읽으면 된다.
function attachDropZone(inputId, { multiple = true, hint } = {}) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.dropZone === "on") return;
  input.dataset.dropZone = "on";

  const defaultText =
    hint || (multiple ? "여기로 파일을 끌어다 놓으세요 (여러 개 가능)" : "여기로 파일을 끌어다 놓으세요");
  const zone = document.createElement("div");
  zone.className = "drop-zone";
  zone.textContent = defaultText;
  input.insertAdjacentElement("afterend", zone);

  function describe() {
    const files = [...input.files];
    if (!files.length) {
      zone.className = "drop-zone";
      zone.textContent = defaultText;
      return;
    }
    zone.className = "drop-zone filled";
    zone.textContent =
      files.length === 1 ? files[0].name : `${files[0].name} 외 ${files.length - 1}개`;
  }

  // 브라우저 기본 동작(파일을 새 탭으로 여는 것)을 막아야 놓기가 동작한다
  ["dragenter", "dragover"].forEach((type) =>
    zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    })
  );
  ["dragleave", "dragend"].forEach((type) =>
    zone.addEventListener(type, () => zone.classList.remove("dragover"))
  );

  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const dropped = [...(e.dataTransfer?.files || [])];
    if (!dropped.length) return;

    // input.files는 직접 못 바꾸므로 DataTransfer로 목록을 새로 만들어 넣는다
    const dt = new DataTransfer();
    for (const f of multiple ? dropped : dropped.slice(0, 1)) dt.items.add(f);
    input.files = dt.files;
    describe();
  });

  input.addEventListener("change", describe);
  describe();
  return { reset: describe };
}

// ---- 삭제(X) 가능한 드롭다운 (공사/업체 선택 등) ----
// 네이티브 <select>는 옵션 안에 버튼을 넣을 수 없어서, 항목별로 "숨기기(X)"가 필요한
// 드롭다운은 이 컴포넌트로 직접 그린다. value가 ""인 첫 항목("선택")에는 X를 안 그린다.
// containerId 안에 .dropdown-toggle 버튼과 .dropdown-list 두 요소가 이미 있어야 한다.
function createHideableDropdown(containerId, { onSelect, onHide, onEdit }) {
  const container = document.getElementById(containerId);
  const toggle = container.querySelector(".dropdown-toggle");
  const list = container.querySelector(".dropdown-list");
  let currentValue = "";
  let options = [{ value: "", label: "선택" }];

  function renderList() {
    list.innerHTML = options
      .map((o) => {
        const value = escapeHtml(String(o.value));
        const label = escapeHtml(o.label);
        const editBtn =
          o.value === "" || !onEdit
            ? ""
            : `<button type="button" class="dropdown-item-edit" data-value="${value}" title="이름 편집">✎</button>`;
        const xBtn =
          o.value === "" || !onHide
            ? ""
            : `<button type="button" class="dropdown-item-x" data-value="${value}">×</button>`;
        return `<div class="dropdown-item" data-value="${value}"><span class="dropdown-item-label">${label}</span>${editBtn}${xBtn}</div>`;
      })
      .join("");
  }

  function renderToggle() {
    const selected = options.find((o) => String(o.value) === String(currentValue));
    toggle.textContent = selected ? selected.label : "선택";
  }

  function close() {
    list.classList.add("hidden");
  }

  toggle.addEventListener("click", () => list.classList.toggle("hidden"));

  list.addEventListener("click", async (e) => {
    const editBtn = e.target.closest(".dropdown-item-edit");
    if (editBtn) {
      e.stopPropagation();
      const value = editBtn.dataset.value;
      const currentLabel = editBtn.closest(".dropdown-item").querySelector(".dropdown-item-label").textContent;
      const newName = await showPrompt(`새 이름을 입력해주세요.`, currentLabel);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === currentLabel) return;
      await onEdit(value, trimmed);
      return;
    }
    const xBtn = e.target.closest(".dropdown-item-x");
    if (xBtn) {
      e.stopPropagation();
      const value = xBtn.dataset.value;
      const label = xBtn.closest(".dropdown-item").querySelector(".dropdown-item-label").textContent;
      const confirmed = await showConfirm(
        `"${label}"을(를) 목록에서 숨기시겠습니까?\n(기존 반출·리비전 기록은 그대로 남습니다)`
      );
      if (confirmed) await onHide(value);
      return;
    }
    const item = e.target.closest(".dropdown-item");
    if (item) {
      currentValue = item.dataset.value;
      renderToggle();
      close();
      onSelect(currentValue);
    }
  });

  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) close();
  });

  return {
    setOptions(newOptions) {
      options = [{ value: "", label: "선택" }, ...newOptions];
      renderList();
      renderToggle();
    },
    getOptions() {
      return options.filter((o) => o.value !== "");
    },
    getValue() {
      return currentValue;
    },
    setValue(value) {
      currentValue = value ?? "";
      renderToggle();
    },
  };
}

// ---- Zip 세부 현황 팝업 (TDB 반출이력 · 시스템 로그 공용) ----
// 그 Zip에 담겼던 자료들이 지금 각각 어떤 상태인지 보여준다. 팝업 안에서 엑셀로도 내려받는다.
// distributions.js의 표 자체(자료/Zip 상태 배지)와는 별개라 이름을 다르게 둔다.
const ZIP_STATUS_MATERIAL_LABEL = {
  INCOMPLETE: { text: "반입미완료", cls: "badge-warning" },
  ISSUE: { text: "확인필요", cls: "badge-danger" },
  REVIEWING: { text: "검수대기", cls: "badge-info" },
  DONE: { text: "반입완료", cls: "badge-success" },
};

function zipStatusMaterialCell(code) {
  const item = ZIP_STATUS_MATERIAL_LABEL[code];
  if (item) return `<span class="badge ${item.cls}">${item.text}</span>`;
  return '<span class="badge badge-neutral">반입대상 아님</span>';
}

async function openZipStatusPopup(zipFilename, from) {
  const res = await fetch(`/distributions/zip-status?zip_filename=${encodeURIComponent(zipFilename)}`);
  if (!res.ok) {
    await showAlert("현황을 불러오지 못했습니다.");
    return;
  }
  const items = await res.json();
  const fromQs = from ? `&from=${from}` : "";

  const rowsHtml = items
    .map(
      (m, i) => `
      <tr>
        <td class="col-no">${i + 1}</td>
        <td><a href="detail.html?id=${m.document_id}${fromQs}">${escapeHtml(m.display_name)}</a></td>
        <td class="tc">${m.rev_at_distribution}</td>
        <td class="tc">${purposeBadge(m.purpose, null)}</td>
        <td class="tc">${zipStatusMaterialCell(m.status)}</td>
        <td class="muted tc">${fmtDateTime(m.distributed_at)}</td>
        <td class="muted tc">${fmtDateTime(m.returned_at)}</td>
      </tr>`
    )
    .join("");

  const root = ensureDialogRoot();
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:820px;width:92vw">
        <div class="section-head" style="margin-bottom:10px">
          <h2 style="font-size:15px">세부 현황 — ${escapeHtml(zipFilename)}</h2>
        </div>
        <div class="status-bar">
          <span>총 ${items.length}건</span>
          <button id="zip-status-export" type="button">엑셀 내보내기</button>
        </div>
        <div class="table-scroll" style="max-height:52vh">
          <table>
            <thead>
              <tr><th>No</th><th>자료명</th><th>반출Rev</th><th>목적</th><th>상태</th><th>반출일시</th><th>반입일시</th></tr>
            </thead>
            <tbody>${rowsHtml || '<tr><td colspan="7" class="empty">자료가 없습니다.</td></tr>'}</tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button class="primary" id="zip-status-close">닫기</button>
        </div>
      </div>
    </div>`;

  // 이 팝업의 자료명을 눌러 상세보기로 가면, 이전/다음이 이 팝업에 나온 자료들만 따라가게 한다.
  wireDetailLinks(root.querySelector("tbody"), items.map((m) => m.document_id));

  document.getElementById("zip-status-export").addEventListener("click", () => {
    window.location.href = `/distributions/zip-status/export?zip_filename=${encodeURIComponent(zipFilename)}`;
  });
  document.getElementById("zip-status-close").addEventListener("click", () => {
    root.innerHTML = "";
  });
}

// ---- "최근 수정" 표시 기준 (2026-08-14 CM 확정) ----------------------------
// 백엔드 documents.py의 RECENT_STRONG_DAYS/RECENT_SOFT_DAYS와 같은 값이어야 한다.
// 두 숫자만 바꾸면 목록 날짜 색·수정일 드롭다운·[최근수정본] 버튼이 전부 같이 바뀐다.
const RECENT_STRONG_DAYS = 30;
const RECENT_SOFT_DAYS = 90;

// "수정일" 드롭다운 항목 — 세 구간은 겹치지 않고, 목록 "최종수정" 날짜의 색 두 단계와
// 정확히 같은 구간을 쓴다. TDB 조회 화면과 최근수정본 팝업이 같은 목록을 쓴다.
const MODIFIED_OPTIONS = [
  { value: "D30", label: `오늘~${RECENT_STRONG_DAYS}일` },
  { value: "D31_90", label: `${RECENT_STRONG_DAYS + 1}일~${RECENT_SOFT_DAYS}일` },
  { value: "D91", label: `${RECENT_SOFT_DAYS + 1}일 이전` },
];

// 목록 "최종수정" 날짜에 붙일 색 단계.
//   최근 30일 = 진한 색 / 31~90일 = 연한 색 / 그 밖 = 색 없음
// isModified가 false면(등록만 되고 손댄 적 없는 자료) 날짜가 최근이어도 색을 칠하지 않는다 —
// 그 날짜는 "수정한 날"이 아니라 "처음 등록한 날"이기 때문.
function recentDateClass(updatedAt, isModified) {
  if (!isModified || !updatedAt) return "";
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86400000;
  if (days < 0) return "";
  if (days <= RECENT_STRONG_DAYS) return "recent-strong";
  if (days <= RECENT_SOFT_DAYS) return "recent-soft";
  return "";
}

// ---- 체크박스 다중선택 드롭다운 (전체 규칙 포함) ----------------------------
// 2026-08-14 CM 확정 공통 규칙 — 체크박스가 들어가는 모든 드롭다운은 이 세 줄을 지킨다.
//   ① [전체]를 체크하면 나머지 전부 해제
//   ② 나머지 중 하나라도 체크하면 [전체] 자동 해제
//   ③ 체크가 하나도 없게 되면 [전체] 자동 체크 (조건이 비어 결과가 0건이 되는 걸 막는다)
// containerId 안에 .dropdown-toggle 버튼과 .dropdown-list 두 요소가 이미 있어야 한다.
// getValues()는 [전체]일 때 빈 배열을 돌려준다(= 필터를 안 거는 것).
const CHECK_DROPDOWN_ALL = "ALL";

function createCheckDropdown(containerId, options, onChange) {
  const container = document.getElementById(containerId);
  const toggle = container.querySelector(".dropdown-toggle");
  const list = container.querySelector(".dropdown-list");
  const selected = new Set([CHECK_DROPDOWN_ALL]);
  const allOptions = [{ value: CHECK_DROPDOWN_ALL, label: "전체" }, ...options];

  function renderList() {
    list.innerHTML = allOptions
      .map((o) => `
        <label class="dropdown-item dropdown-item-ms">
          <input type="checkbox" class="check-dd-cb" value="${escapeHtml(o.value)}" ${selected.has(o.value) ? "checked" : ""} />
          <span class="dropdown-item-label">${escapeHtml(o.label)}</span>
        </label>`)
      .join("");
    list.querySelectorAll(".check-dd-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        applyRule(cb.value, cb.checked);
        renderList();
        renderToggle();
        if (onChange) onChange(getValues());
      });
    });
  }

  function applyRule(value, checked) {
    if (value === CHECK_DROPDOWN_ALL) {
      selected.clear();
      selected.add(CHECK_DROPDOWN_ALL); // ① 전체를 누르면 항상 전체만 남는다(해제해도 전체 유지 = ③)
      return;
    }
    selected.delete(CHECK_DROPDOWN_ALL); // ②
    if (checked) selected.add(value);
    else selected.delete(value);
    if (selected.size === 0) selected.add(CHECK_DROPDOWN_ALL); // ③
  }

  function renderToggle() {
    if (selected.has(CHECK_DROPDOWN_ALL)) {
      toggle.textContent = "전체";
      return;
    }
    toggle.textContent = allOptions
      .filter((o) => selected.has(o.value))
      .map((o) => o.label)
      .join(", ");
  }

  function getValues() {
    return selected.has(CHECK_DROPDOWN_ALL) ? [] : [...selected];
  }

  toggle.addEventListener("click", () => list.classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) list.classList.add("hidden");
  });

  renderList();
  renderToggle();

  return {
    getValues,
    setValues(values) {
      selected.clear();
      (values || []).forEach((v) => selected.add(v));
      if (selected.size === 0) selected.add(CHECK_DROPDOWN_ALL);
      renderList();
      renderToggle();
    },
    reset() {
      this.setValues([]);
    },
  };
}

// ---- 상단 알림 버튼 ([TDB 수정] · [TDB 반출]) -------------------------------
// 어느 화면에 있든 상단 바에 늘 보인다. 반출이력 화면에서 조건을 걸면 알 수 있는 내용이지만
// 일반 사용자는 거기까지 찾아 들어가지 않으므로, 건수만 먼저 보여주고 누르면 목록을 연다.
// 건수는 권한과 무관하게 모두에게 똑같이 보인다(서로 보고한 숫자가 어긋나면 안 되므로 — CM 확정).

// 팝업 안 자료명을 눌러 상세보기로 갔다가 "목록으로" 누르면 지금 있던 화면으로 돌아오게 한다.
const PAGE_FROM_KEYS = {
  "distributions.html": "distributions",
  "audit.html": "audit",
  "editor.html": "editor",
  "import.html": "import",
};

function currentFromKey() {
  const file = window.location.pathname.split("/").pop() || "index.html";
  return PAGE_FROM_KEYS[file] || "";
}

function detailHref(documentId) {
  const from = currentFromKey();
  return `detail.html?id=${documentId}${from ? `&from=${from}` : ""}`;
}

// 건수가 0이면 평범하게, 1건이라도 있으면 색이 들어간다. 두 버튼이 같은 규칙·같은 색이다.
function noticeButtonHtml(id, label, count) {
  const tone = count > 0 ? " is-strong" : "";
  return `<button type="button" class="notice-btn${tone}" id="${id}">${label} (${count})</button>`;
}

async function loadNoticeButtons(slot) {
  const [recent, outstanding] = await Promise.all([
    fetch("/documents/recent-changes/summary").then((r) => (r.ok ? r.json() : null)),
    fetch("/distributions/outstanding/summary").then((r) => (r.ok ? r.json() : null)),
  ]);
  if (!recent && !outstanding) return;

  const box = document.createElement("span");
  box.className = "notice-btns";
  box.innerHTML =
    (recent ? noticeButtonHtml("notice-recent-btn", "TDB 수정", recent.count) : "") +
    (outstanding ? noticeButtonHtml("notice-outstanding-btn", "TDB 반출", outstanding.count) : "");
  slot.prepend(box);

  // 두 버튼 너비를 같게 맞춘다(건수 자릿수가 달라도 흔들리지 않게 넓은 쪽 기준).
  const buttons = [...box.querySelectorAll(".notice-btn")];
  const widest = Math.max(...buttons.map((b) => b.offsetWidth));
  buttons.forEach((b) => { b.style.width = `${widest}px`; });

  const recentBtn = document.getElementById("notice-recent-btn");
  if (recentBtn) recentBtn.addEventListener("click", openRecentChangesPopup);
  const outBtn = document.getElementById("notice-outstanding-btn");
  if (outBtn) outBtn.addEventListener("click", openOutstandingPopup);
}

function changeKindCell(item) {
  if (item.change_kind !== "REVISION") {
    return '<span class="badge badge-neutral">일반 수정</span>';
  }
  return `<span class="badge badge-warning">Rev ${item.rev_from} → ${item.rev_to}</span>`;
}

// 팝업 표의 자료명 칸 — 목록 화면과 똑같이 [돋보기(미리보기)] + [자료명(누르면 상세보기)].
function noticeDrawingCell(item) {
  return `${previewBtnHtml(item.current_pdf_file_id)} <a href="${detailHref(item.document_id)}">${escapeHtml(item.display_name)}</a>`;
}

function noticePreviewItem(item) {
  return {
    id: item.document_id,
    drawingNo: item.display_name,
    path: item.path ?? "",
    pdfFileId: item.current_pdf_file_id,
    source: tdbSource(item.document_id),
  };
}

// 팝업 표를 다시 그릴 때마다 행에 걸어줘야 하는 것 — 돋보기 미리보기 · 자료명 상세보기.
function wireNoticeRows(tbody, items) {
  wireDetailLinks(tbody, items.map((i) => i.document_id));
  wirePreviewButtons(tbody, items.map(noticePreviewItem));
}

// 표 자체에 거는 것(열 너비 조절 + 세로 경계선, 헤더 클릭 정렬)은 한 번만 — 다시 걸면
// 클릭 한 번에 정렬이 두 번 일어난다. 행이 그려진 뒤에 불러야 열 너비 계산이 맞는다.
// 팝업 표는 페이지 나눔이 없어 화면에 그려진 행이 곧 전체이므로 여기서 정렬해도 전체 정렬이다.
function wireNoticeTableChrome(table) {
  makeColumnsResizable(table);
  makeSortable(table);
}

async function openRecentChangesPopup() {
  const res = await fetch(`/documents/recent-changes?days=${RECENT_SOFT_DAYS}`);
  if (!res.ok) {
    await showAlert("최근 수정 내역을 불러오지 못했습니다.");
    return;
  }
  const data = await res.json();

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box notice-box">
        <div class="notice-head">
          <h2>TDB 최근수정 현황</h2>
        </div>
        <div class="status-bar">
          <span>최근 ${data.days}일 이내 수정 <b>(${data.total})</b>
            = Revision 수정 <b>(${data.revision_count})</b>
            + 일반 수정 <b>(${data.total - data.revision_count})</b></span>
        </div>
        <div class="notice-filters">
          <div class="field">
            <label for="recent-kind-toggle">수정 구분</label>
            <div class="hideable-dropdown ms-dropdown" id="recent-kind-dropdown">
              <button type="button" class="dropdown-toggle" id="recent-kind-toggle">전체</button>
              <div class="dropdown-list hidden"></div>
            </div>
          </div>
          <div class="field">
            <label for="recent-modified-toggle">수정일</label>
            <div class="hideable-dropdown ms-dropdown" id="recent-modified-dropdown">
              <button type="button" class="dropdown-toggle" id="recent-modified-toggle">전체</button>
              <div class="dropdown-list hidden"></div>
            </div>
          </div>
          <span class="cart-status">
            <button type="button" class="cart-btn" id="recent-export-btn">엑셀 내보내기</button>
          </span>
        </div>
        <div class="table-scroll notice-list">
          <table id="recent-table">
            <colgroup>
              <col style="width:54px" /><col style="width:152px" /><col style="width:240px" />
              <col style="width:110px" /><col /><col style="width:56px" />
              <col style="width:150px" /><col style="width:124px" />
              <col style="width:112px" /><col style="width:80px" />
            </colgroup>
            <thead>
              <tr>
                <th data-sort="off">No</th><th>수정일</th><th>자료명</th><th>분류</th><th>경로</th>
                <th>Rev</th><th>공사</th><th>업체</th><th>변경 내용</th><th>수정자</th>
              </tr>
            </thead>
            <tbody id="recent-tbody"></tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button type="button" class="primary" id="recent-close-btn">닫기</button>
        </div>
      </div>
    </div>`);

  const KIND_OPTIONS = [
    { value: "REVISION", label: "Revision 수정" },
    { value: "INFO", label: "일반 수정" },
  ];
  const kindDropdown = createCheckDropdown("recent-kind-dropdown", KIND_OPTIONS, render);
  const modifiedDropdown = createCheckDropdown("recent-modified-dropdown", MODIFIED_OPTIONS, render);

  // 화면에 보이는 목록을 두 드롭다운 조건으로 거른다. 엑셀 내보내기도 같은 조건을 서버에
  // 그대로 넘겨서 표와 내용이 어긋나지 않게 한다.
  function visibleItems() {
    const kinds = kindDropdown.getValues();
    const scopes = modifiedDropdown.getValues();
    const strongCut = Date.now() - RECENT_STRONG_DAYS * 86400000;
    const softCut = Date.now() - RECENT_SOFT_DAYS * 86400000;

    return data.items.filter((item) => {
      if (kinds.length > 0 && !kinds.includes(item.change_kind)) return false;
      if (scopes.length === 0) return true;
      const at = new Date(item.updated_at).getTime();
      if (scopes.includes("D30") && at >= strongCut) return true;
      if (scopes.includes("D31_90") && at >= softCut && at < strongCut) return true;
      if (scopes.includes("D91") && at < softCut) return true;
      return false;
    });
  }

  // 이 팝업은 최근 90일만 담고 있어서 "91일 이전"을 고르면 늘 0건이다 — 왜 비었는지
  // 알 수 있게 안내한다(더 오래된 수정은 TDB 조회 화면의 수정일 조건으로 찾으면 된다).
  function emptyMessage() {
    const scopes = modifiedDropdown.getValues();
    if (scopes.length === 1 && scopes[0] === "D91") {
      return `이 목록은 최근 ${data.days}일 안에 수정된 자료만 보여줍니다. ` +
        `더 오래된 수정은 TDB 조회 화면의 [수정일] 조건으로 찾아보세요.`;
    }
    return "조건에 맞는 자료가 없습니다.";
  }

  function render() {
    const items = visibleItems();
    const tbody = layer.querySelector("#recent-tbody");
    tbody.innerHTML = items.length === 0
      ? `<tr><td colspan="10" class="empty">${emptyMessage()}</td></tr>`
      : items.map((item, i) => `
          <tr>
            <td class="col-no">${i + 1}</td>
            <td class="tc ${recentDateClass(item.updated_at, true)}">${fmtDateTime(item.updated_at)}</td>
            <td>${noticeDrawingCell(item)}</td>
            <td class="muted">${textOrNa(item.category)}</td>
            <td class="muted">${textOrNa(item.path)}</td>
            <td class="tc">${escapeHtml(item.rev_label)}</td>
            <td class="muted">${textOrNa(item.project_name)}</td>
            <td>${textOrNa(item.vendor_name)}</td>
            <td class="tc">${changeKindCell(item)}</td>
            <td class="tc muted">${textOrNa(item.changed_by)}</td>
          </tr>`).join("");
    wireNoticeRows(tbody, items);
  }

  render();
  wireNoticeTableChrome(layer.querySelector("#recent-table"));
  layer.querySelector("#recent-export-btn").addEventListener("click", () => {
    const params = new URLSearchParams({ days: data.days });
    kindDropdown.getValues().forEach((v) => params.append("kind", v));
    modifiedDropdown.getValues().forEach((v) => params.append("modified", v));
    window.location.href = `/documents/recent-changes/export?${params}`;
  });
  layer.querySelector("#recent-close-btn").addEventListener("click", () => popDialogLayer(layer));
}

// 반출 팝업 — 도면이 곧 바뀔 수 있는 것(미반납 + 검수대기). 오래 나가 있는 순(위에서부터 독촉 순서).
const OUTSTANDING_STATUS_LABEL = {
  NOT_RETURNED: { text: "미반납", cls: "badge-warning" },
  REVIEWING: { text: "검수대기", cls: "badge-info" },
};

async function openOutstandingPopup() {
  const res = await fetch("/distributions/outstanding");
  if (!res.ok) {
    await showAlert("반출 현황을 불러오지 못했습니다.");
    return;
  }
  const items = await res.json();

  const elapsedDays = (value) =>
    value ? Math.floor((Date.now() - new Date(value).getTime()) / 86400000) : null;

  const rowsHtml = items.length === 0
    ? '<tr><td colspan="9" class="empty">도면이 곧 바뀔 수 있는 자료가 없습니다.</td></tr>'
    : items.map((it, i) => {
        const days = elapsedDays(it.distributed_at);
        const overdue = days !== null && days > RECENT_SOFT_DAYS;
        return `
          <tr>
            <td class="col-no">${i + 1}</td>
            <td class="tc">${badge(OUTSTANDING_STATUS_LABEL, it.status)}</td>
            <td class="tc ${overdue ? "recent-strong" : ""}">${fmtDateTime(it.distributed_at)}</td>
            <td>${noticeDrawingCell(it)}</td>
            <td class="muted">${textOrNa(it.project_name)}</td>
            <td class="tc">${textOrNa(it.vendor)}</td>
            <td class="muted">${textOrNa(it.category)}</td>
            <td class="muted">${textOrNa(it.path)}</td>
            <td class="tc muted">${textOrNa(it.distributed_by_name)}</td>
          </tr>`;
      }).join("");

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box notice-box">
        <div class="notice-head">
          <h2>TDB 반출 현황 (수정 예정)</h2>
        </div>
        <div class="status-bar">
          <span>반출 자료 <b>(${items.length})</b></span>
          <span class="cart-status">
            <button type="button" class="cart-btn" id="outstanding-export-btn">엑셀 내보내기</button>
          </span>
        </div>
        <div class="table-scroll notice-list">
          <table id="outstanding-table">
            <colgroup>
              <col style="width:54px" /><col style="width:90px" /><col style="width:150px" />
              <col style="width:260px" /><col style="width:150px" /><col style="width:130px" />
              <col style="width:110px" /><col /><col style="width:96px" />
            </colgroup>
            <thead>
              <tr>
                <th data-sort="off">No</th><th>상태</th><th>반출일</th><th>자료명</th>
                <th>공사</th><th>업체</th><th>분류</th><th>경로</th><th>반출자</th>
              </tr>
            </thead>
            <tbody id="outstanding-tbody">${rowsHtml}</tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button type="button" class="primary" id="outstanding-close-btn">닫기</button>
        </div>
      </div>
    </div>`);

  wireNoticeRows(layer.querySelector("#outstanding-tbody"), items);
  wireNoticeTableChrome(layer.querySelector("#outstanding-table"));
  layer.querySelector("#outstanding-export-btn").addEventListener("click", () => {
    // 파일명은 이 팝업 제목을 그대로 따라간다(엑셀 내보내기 공통 규칙).
    const title = layer.querySelector(".notice-head h2").textContent.trim();
    window.location.href = `/distributions/outstanding/export?label=${encodeURIComponent(title)}`;
  });
  layer.querySelector("#outstanding-close-btn").addEventListener("click", () => popDialogLayer(layer));
}

// ---- 폐기 보관함 팝업 (TDB 조회 · TDB 관리 · MDB 조회 · MDB 관리 공용) ----
// 폐기는 삭제와 다르다 — 그때는 맞았지만 리비전이 진행되며 최신본에서 빠진 자료를 폴더
// 트리에서만 감추고 이력으로 남겨두는 것이라, 완전 삭제가 없고 [복구]만 있다.
// 조회 화면에서도 같은 목록을 보여준다(일반 사용자도 폐기 이력을 볼 수 있어야 하므로).
// 다만 조회 화면에는 체크박스·조치 칸이 없고 비고도 읽기만 된다 — 고칠 권한이 없기 때문.
// 네 화면이 같은 팝업을 쓰므로 여기 한 곳만 고치면 네 곳이 함께 바뀐다.
const RETIRE_SCOPES = {
  tdb: {
    title: "TDB 폐기 보관함",
    base: "/editor/retired",
    permKey: "screen.tdb_editor.retire",
    hasRev: true,
    idOf: (it) => it.document_id,
    nameOf: (it) => it.display_name,
    hrefOf: (id) => detailHref(id),
    previewUrlOf: () => null,  // TDB는 ui.js 기본 경로(/files/{id}/view)를 쓴다
    sourceOf: (it) => tdbSource(it.document_id),
  },
  mdb: {
    title: "MDB 폐기 보관함",
    base: "/mdb-editor/retired",
    permKey: "screen.mdb_editor.retire",
    hasRev: false,  // MDB 자료에는 리비전이 없다
    idOf: (it) => it.file_id,
    nameOf: (it) => it.name,
    hrefOf: (id) => mdbDetailHref(id),
    previewUrlOf: (pdfFileId) => (pdfFileId ? `/mdb/files/${pdfFileId}/view` : null),
    sourceOf: (it) => mdbSource(it.file_id),
  },
};

const MDB_PAGE_FROM_KEYS = { "mdb-editor.html": "mdb-editor" };

function mdbDetailHref(fileId) {
  const file = window.location.pathname.split("/").pop() || "mdb.html";
  const from = MDB_PAGE_FROM_KEYS[file] || "";
  return `mdb-detail.html?id=${fileId}${from ? `&from=${from}` : ""}`;
}

// 화면 위 [폐기 보관함] 버튼 옆 괄호 숫자. 목록 전체가 아니라 건수만 받아온다.
async function refreshRetiredCount(scope, elementId = "retired-count") {
  const box = document.getElementById(elementId);
  if (!box) return;
  const res = await fetch(`${RETIRE_SCOPES[scope].base}/count`);
  if (!res.ok) return;
  const { count } = await res.json();
  box.textContent = count ? `(${count})` : "";
}

// screen  : 이 팝업을 연 화면 이름(엑셀 파일명에 그대로 들어간다)
// canEdit : 관리 화면이면 true — 체크박스·[복구]·[선택 복구]·비고 연필이 나온다
// pickFolder(info) : 관리 화면만 넘긴다. 복구할 자리가 없어졌을 때 새 폴더를 물어보는 함수
//                    (폴더 트리는 관리 화면이 이미 갖고 있어서 그 화면에 맡긴다)
// onChanged : 복구 후 화면(트리·목록·버튼 숫자)을 다시 그리는 함수
async function openRetiredPopup(scope, { screen, canEdit = false, pickFolder = null, onChanged = null } = {}) {
  const cfg = RETIRE_SCOPES[scope];
  const res = await fetch(cfg.base);
  if (!res.ok) {
    await showAlert("폐기 보관함을 불러오지 못했습니다.");
    return;
  }
  let items = await res.json();

  const canRestore = canEdit && (window.__tdmsPerms || new Set()).has(cfg.permKey);
  // 비어 있을 때 안내 문구가 표 폭 전체에 걸리도록 칸 수를 센다
  // (기본 여섯 칸 = No·자료명·분류·경로·폐기 시간·비고 + Rev + 관리 화면의 체크박스·조치).
  const colCount = 6 + (cfg.hasRev ? 1 : 0) + (canEdit ? 2 : 0);

  const layer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box notice-box">
        <div class="notice-head">
          <h2>${cfg.title}</h2>
        </div>
        <div class="status-bar">
          <span><b>전체 <span id="retired-total">0</span>건</b></span>
          <span class="cart-status">
            ${canEdit ? '<button type="button" class="cart-btn" id="retired-restore-btn">선택 복구</button>' : ""}
            <button type="button" class="cart-btn" id="retired-export-btn">엑셀 내보내기</button>
          </span>
        </div>
        <div class="table-scroll notice-list">
          <table id="retired-table">
            <colgroup>
              <col style="width:54px" />
              ${canEdit ? '<col style="width:34px" />' : ""}
              <col style="width:260px" />
              <col style="width:120px" />
              <col />
              ${cfg.hasRev ? '<col style="width:56px" />' : ""}
              <col style="width:150px" />
              ${canEdit ? '<col style="width:82px" />' : ""}
              <col style="width:200px" />
            </colgroup>
            <thead>
              <tr>
                <th data-sort="off">No</th>
                ${canEdit ? '<th class="col-check" data-sort="off"><input type="checkbox" id="retired-select-all" /></th>' : ""}
                <th>자료명</th>
                <th>분류</th>
                <th>경로</th>
                ${cfg.hasRev ? "<th>Rev</th>" : ""}
                <th>폐기 시간</th>
                ${canEdit ? '<th data-sort="off">조치</th>' : ""}
                <th data-sort="off">비고</th>
              </tr>
            </thead>
            <tbody id="retired-tbody"></tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button type="button" class="primary" id="retired-close-btn">닫기</button>
        </div>
      </div>
    </div>`);

  function render() {
    const tbody = layer.querySelector("#retired-tbody");
    layer.querySelector("#retired-total").textContent = items.length;
    tbody.innerHTML = items.length === 0
      ? `<tr><td colspan="${colCount}" class="empty">폐기 보관함이 비어 있습니다.</td></tr>`
      : items.map((it, i) => {
          const id = cfg.idOf(it);
          const name = cfg.nameOf(it);
          return `
            <tr>
              <td class="col-no">${i + 1}</td>
              ${canEdit ? `<td class="tc" data-sort="off"><input type="checkbox" class="retired-row-check" data-batch="${it.batch_id}" ${canRestore ? "" : "disabled"} /></td>` : ""}
              <td>${previewBtnHtml(it.pdf_file_id)} <a href="${cfg.hrefOf(id)}" data-retired-link>${escapeHtml(name)}</a></td>
              <td class="muted">${textOrNa(it.category)}</td>
              <td class="muted" title="${escapeHtml(it.path || "")}">${textOrNa(it.path)}</td>
              ${cfg.hasRev ? `<td class="tc">${it.rev ?? 0}</td>` : ""}
              <td class="tc muted">${fmtDateTime(it.retired_at)}</td>
              ${canEdit ? `<td class="tc" data-sort="off"><button class="small" type="button" data-restore="${it.batch_id}" ${canRestore ? "" : "disabled"}>복구</button></td>` : ""}
              <td data-sort="off">${canEdit ? noteEditCellHtml(it.batch_id, it.reason) : escapeHtml(it.reason || "")}</td>
            </tr>`;
        }).join("");

    // 자료명 링크(상세보기)와 돋보기(미리보기) — 목록 화면과 같은 방식. 이 팝업 목록에는
    // 페이지 나눔이 없어 이것이 곧 전부이므로, 상세보기의 이전/다음도 이 목록을 따라간다
    // (ui.js의 wireDetailLinks는 TDB 링크만 다뤄서 MDB까지 함께 쓰려고 여기서 직접 건다).
    const navIds = items.map((it) => cfg.idOf(it));
    tbody.querySelectorAll("a[data-retired-link]").forEach((a) => {
      a.addEventListener("click", () => saveDetailNavList(navIds));
    });
    wirePreviewButtons(tbody, items.map((it) => ({
      id: cfg.idOf(it),
      drawingNo: cfg.nameOf(it),
      path: it.path ?? "",
      pdfFileId: it.pdf_file_id,
      previewUrl: cfg.previewUrlOf(it.pdf_file_id),
      source: cfg.sourceOf(it),
    })));

    if (!canEdit) return;
    wireNoteEdits(tbody, (id) => `${cfg.base}/${id}/note`, cfg.permKey);
    tbody.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", () => restore([Number(btn.dataset.restore)]));
    });
  }

  // 복구 — 원래 폴더가 없어졌거나 그 자리에 같은 이름 자료가 이미 있으면 서버가 아무것도
  // 되살리지 않고 그 목록을 돌려준다. 그때 새 위치를 물어보고 다시 시도한다.
  async function restore(batchIds) {
    const newPaths = {};
    for (let round = 0; round < 10; round += 1) {
      const result = await fetch(`${cfg.base}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_ids: batchIds, new_paths: newPaths }),
      });
      if (!result.ok) {
        await showAlert("복구에 실패했습니다: " + (await safeErrText(result)));
        return;
      }
      const data = await result.json();
      if (!data.blocked.length) {
        await reload();
        await showAlert(data.restored > 1
          ? `자료 ${data.restored}건을 복구하였습니다.`
          : "자료를 복구하였습니다.");
        return;
      }
      if (!pickFolder) {
        await showAlert("복구할 폴더가 없어졌습니다. 관리 화면에서 위치를 다시 지정해 주세요.");
        return;
      }
      // 폐기 당시 경로가 같은 것끼리 묶어 한 번만 물어본다(수십 건이면 매번 묻지 않도록).
      const group = data.blocked.filter((b) => b.original_path === data.blocked[0].original_path);
      const picked = await pickFolder({
        originalPath: group[0].original_path || "",
        reason: group[0].reason,
        names: group.map((b) => b.label),
      });
      if (picked === null) return;  // 취소 — 아무것도 복구되지 않은 상태 그대로 둔다
      group.forEach((b) => { newPaths[b.batch_id] = picked; });
    }
    await showAlert("복구할 위치를 정하지 못했습니다. 폴더를 만든 뒤 다시 시도해 주세요.");
  }

  async function reload() {
    const res2 = await fetch(cfg.base);
    items = res2.ok ? await res2.json() : items;
    render();
    if (onChanged) await onChanged();
  }

  render();
  wireNoticeTableChrome(layer.querySelector("#retired-table"));

  if (canEdit) {
    const selectAll = layer.querySelector("#retired-select-all");
    if (!canRestore) window.applyPermDisabled(layer.querySelector("#retired-restore-btn"));
    selectAll.addEventListener("change", () => {
      layer.querySelectorAll(".retired-row-check").forEach((cb) => { cb.checked = selectAll.checked; });
    });
    layer.querySelector("#retired-restore-btn").addEventListener("click", async () => {
      const ids = [...layer.querySelectorAll(".retired-row-check:checked")].map((cb) => Number(cb.dataset.batch));
      if (!ids.length) { await showAlert("복구할 항목을 하나 이상 선택하세요."); return; }
      await restore(ids);
    });
  }

  layer.querySelector("#retired-export-btn").addEventListener("click", () => {
    // 파일명은 "화면이름_팝업제목_날짜"라 어느 화면에서 받았는지가 파일명에 남는다(공통 규칙).
    window.location.href = `${cfg.base}/export?screen=${encodeURIComponent(screen)}`;
  });
  layer.querySelector("#retired-close-btn").addEventListener("click", () => popDialogLayer(layer));
}

// 표에 그려진 Zip 다운·상세 현황 버튼([data-zip-download]/[data-zip-status])에 동작을 걸어준다.
// distributions.js·audit.js 공용 — from은 팝업 안 자료명 링크가 "목록으로" 누를 때 돌아갈 화면.
function wireZipButtons(tbody, from) {
  tbody.querySelectorAll("[data-zip-download]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.location.href = `/distributions/zip-file?zip_filename=${encodeURIComponent(btn.dataset.zipDownload)}`;
    });
  });
  tbody.querySelectorAll("[data-zip-status]").forEach((btn) => {
    btn.addEventListener("click", () => openZipStatusPopup(btn.dataset.zipStatus, from));
  });
}
