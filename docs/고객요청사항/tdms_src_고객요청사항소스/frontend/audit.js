// 동작 코드 → 배지 색(라벨은 /audit-log/meta에서 받아온다). DB에는 영문 코드 그대로 저장된다.
const ACTION_BADGE_CLASS = {
  LOGIN: "badge-neutral", LOGOUT: "badge-neutral", REGISTER: "badge-info", DISTRIBUTE: "badge-warning",
  DOWNLOAD: "badge-neutral", UPLOAD: "badge-info", APPROVE: "badge-success",
  REJECT: "badge-danger", MERGE_REQUIRED: "badge-danger", RETURN: "badge-success",
  UPDATE_NOTE: "badge-neutral", EXPORT: "badge-neutral",
  IMPORT_ISSUE_RESOLVE: "badge-success", IMPORT_ISSUE_DISCARD: "badge-danger",
};

// /audit-log/meta 로딩 전에 그릴 일이 없어 처음엔 비어 있다가 채워진다.
let ACTION_LABELS = {}; // action 코드 -> 한글 라벨 (표·엑셀 표시용. 엑셀내보내기 등도 포함)
let ACTIONS_BY_SCREEN = {}; // 화면명(내부 키) -> [action 코드, ...] (드롭다운에 올릴 것만)
let ALL_SCREENS = []; // 내부 키. 나브바 순서대로 백엔드가 이미 정렬해서 준다
let SCREEN_LABELS = {}; // 내부 키 -> 지금 나브바 이름 (필터링은 내부 키로, 화면 표시는 이 라벨로)
let ACTION_GROUPS = []; // [{label, actions:[code,...]}, ...] — 로그동작 드롭다운 그룹·순서 (백엔드가 정함)
let ALL_ACTION_CODES = []; // ACTION_GROUPS를 펼친 코드 목록 (엑셀내보내기 등 드롭다운 제외 항목은 안 들어있음)

function actionBadge(action) {
  const cls = ACTION_BADGE_CLASS[action] || "badge-neutral";
  const text = ACTION_LABELS[action] || action;
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

// ---- 상세(jsonb) 사람이 읽기 쉬운 문구로 변환 ----
// 백엔드 audit.py의 format_detail(엑셀 내보내기용)과 같은 규칙(키 라벨·값 변환)을 쓴다.
const DETAIL_KEY_LABELS = {
  count: "건수", kind: "구분", scope: "대상", columns: "구성",
  filters: "검색조건", path: "경로", old_path: "이전 경로", new_path: "변경 경로",
  target_path: "대상 경로", old_title: "이전 이름", new_title: "변경 이름",
  old_filename: "이전 파일명", new_filename: "변경 파일명",
  original_filename: "원본 파일명", batch_id: "보관함 번호",
  document_count: "대상 자료", file_count: "대상 파일",
  affected_documents: "영향받은 자료", affected_placeholders: "영향받은 빈 폴더",
  affected_files: "영향받은 자료", removed_placeholders: "삭제된 빈 폴더",
  restored_documents: "복원된 자료", restored_files: "복원된 자료",
  archived_documents: "보관 처리된 자료", cascade_numbering: "하위 번호 자동변경",
  rev: "리비전", branch: "분기", vendor: "업체명", vendor_name: "업체명",
  any_mismatch_warning: "표기 리비전 불일치 경고", via: "처리 경로",
  created: "생성 건수", unmatched: "미매칭 건수", partial: "일부매칭 건수",
  distribution_id: "반출 번호", zip_filename: "Zip 파일명", return_note: "반납 사유",
  note: "비고", file_id: "파일 번호", file_ext: "확장자", drawing_no: "도면번호",
  doc_class: "자료종류", tags: "태그", equipment_type: "설비유형",
  mdb_file_id: "MDB 파일 번호", issue_id: "확인필요 번호", new_issue_id: "새 확인필요 번호",
  reason: "사유", is_internal: "사내통합 여부", project_id: "공사 번호",
  status: "상태", q: "검색어", group: "그룹", category: "분류", tag: "Tag No",
  username: "계정", name: "이름", role: "권한", target_username: "대상 계정",
  label: "이름", selected_only: "선택항목만", recursive: "하위폴더 포함",
  iso: "Isometric", holding: "원본/사본", kind_scope: "검색대상",
  purpose: "반출목적", is_active: "활성여부", password: "비밀번호",
  employment_status: "계정 상태",
  table: "대상", // 옛 기록 호환용 — 지금은 이 키 자체를 안 남긴다
  days: "조회 기간(일)", modified: "수정일 범위", change_kind: "변경 종류",
  batch_count: "보관함 항목", freed_bytes: "확보 용량(바이트)", labels: "대상 이름",
  bulk: "일괄처리", drawing_nos: "도면번호 목록",
  batch: "일괄 작업", journal: "되돌리기 기록 파일", restored: "되돌림",
  // Tag No 이력관리(mdb_tag_history.py)가 남기는 키들
  history_id: "이력 번호", base_tag: "대상 Tag No", new_tag: "바뀐 Tag No",
  action_label: "구분", note_line: "Note 문구", before: "이전 내용",
  after: "변경 내용", reapplied: "자료에 다시 반영",
  tag_changed_docs: "Tag No가 바뀐 자료", note_changed_docs: "Note가 바뀐 자료",
  added: "신규 추가 여부", already_exists: "이미 등록됨(건너뜀)",
  attached: "기존 자료에 추가", attached_files: "기존 자료에 추가",
  auto: "자동 처리 사유", distributed_by: "반출자", doc_count: "대상 자료 건수",
  duplicate_warning: "중복 반출 경고", duplicates_skipped: "중복 건너뜀",
  dwg_path: "DWG 경로", pdf_path: "PDF 경로", files: "대상 파일",
  mdb_file_ids: "MDB 파일 번호", merged_document_id: "병합된 자료 번호",
  moved_exts: "이동된 확장자", names: "대상 자료명", new_document_id: "새 자료 번호",
  pair_folder: "DWG·PDF 폴더", pair_folders: "DWG·PDF 폴더 병합", parent: "상위 폴더",
  project: "공사", purpose_note: "반출목적 비고", skipped: "건너뜀",
  split_documents: "분리된 자료 번호",
};

// 값 자체가 내부 코드라 그대로 두면 못 알아보는 것들만 별도로 한글 변환한다 (키별로 다름)
const DETAIL_VALUE_LABELS = {
  columns: { full: "전체 목록", cart: "대기함 목록", list: "결과 목록", unclassified: "미분류 관리 목록" },
  kind_scope: { FILE: "자료명", FOLDER: "폴더명", BOTH: "자료명+폴더명" },
  role: { ADMIN: "관리자", VIEWER: "조회전용", INTERNAL: "시스템" },
  employment_status: { ACTIVE: "재직", RETIRED: "퇴직", DELETED: "삭제" },
  purpose: { MODIFY: "수정용", REFERENCE: "참조용", OTHER: "기타" },
  // 확인필요 사유 코드(NOT_DISTRIBUTED 등 영문)를 반입·검수 화면 배지와 같은 한글 단어로
  // 보여준다. 문장으로 풀면 표 칸 너비에 안 맞아서 짧은 단어만 쓴다
  // (import.js REASON_LABELS·백엔드 audit.py와 동일 내용, 2026-08-13 CM 요청)
  reason: {
    FILENAME_MISMATCH: "자료명 불일치",
    PATH_MISMATCH: "경로 불일치",
    ORIGINAL_MISSING: "원본 누락",
    PDF_MISSING: "사본 누락",
    ALREADY_IMPORTED: "기 반입 완료",
    NOT_DISTRIBUTED: "반출 대상 아님",
  },
  scope: { mdb: "MDB" },
  table: { audit_log: "감사로그" },
  kind: {
    FOLDER: "폴더", DOCUMENT: "자료", MDB_FOLDER: "MDB 폴더",
    MDB_FILE: "MDB 파일", MDB_ZIP: "MDB Zip",
  },
  // 최근수정본 팝업 필터값(documents.py). 화면의 "수정일" 드롭다운·30/90일 기준과 동일 문구
  modified: { ALL: "전체", D30: "오늘~30일", D31_90: "31일~90일", D91: "91일 이전" },
  // 최근수정본 팝업의 "구분" 필터값(documents.py). 화면 changeKindCell과 동일 문구
  change_kind: { REVISION: "Revision 수정", INFO: "일반 수정" },
};

function detailLabel(key) {
  return DETAIL_KEY_LABELS[key] || key;
}

function detailValue(key, value) {
  if (value === true) return "예";
  const labels = DETAIL_VALUE_LABELS[key];
  if (labels && value in labels) return labels[value];
  if (Array.isArray(value)) {
    return value.map((v) => (labels && v in labels ? labels[v] : String(v))).join(", ");
  }
  return String(value);
}

function isBlankDetail(value) {
  return value === null || value === undefined || value === false || value === "" ||
    (Array.isArray(value) && value.length === 0);
}

// 상세(jsonb)를 사람이 읽을 수 있게 한글 라벨로 풀어준다.
function formatDetail(detail) {
  if (!detail) return "";
  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (isBlankDetail(value)) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const inner = Object.entries(value)
        .filter(([, v]) => !isBlankDetail(v))
        .map(([k, v]) => `${detailLabel(k)} ${detailValue(k, v)}`)
        .join(", ");
      if (inner) parts.push(`${detailLabel(key)}(${inner})`);
    } else {
      parts.push(`${detailLabel(key)}: ${detailValue(key, value)}`);
    }
  }
  return parts.join(" · ");
}

// ---- 화면·로그동작 다중선택 드롭다운 (서로 맞물림) ----
// "전체" 체크박스와 개별 항목은 서로 배타적이다: 전체를 고르면 개별 선택이 다 풀리고, 개별을
// 하나라도 고르면 전체 체크는 자동으로 풀린다. Set이 비어있는 상태 = "전체".
// 체크박스를 고르는 즉시 목록에 반영된다(별도 조회 버튼 없음).
// 화면 목록 순서는 지금 나브바 메뉴 순서(백엔드가 정렬해서 준 ALL_SCREENS 순서) 그대로 쓰고,
// 로그동작은 가나다 순 정렬한다.
//
// 둘은 서로 맞물린다: 화면을 고르면 로그동작 목록이 그 화면에 실제 있는 동작만 남고, 반대로
// 로그동작을 고르면 화면 목록도 그 동작이 실제 일어난 화면만 남는다(예: 로그동작에서 "반출"을
// 고르면 화면 목록엔 반출이 실제 있었던 화면만 뜬다). 그래서 조합했을 때 결과가 0건이 되는
// 화면·동작 짝은 애초에 체크박스 목록에서 안 보이게 된다.
const selectedScreens = new Set();
const selectedActions = new Set();

// 지금 로그동작 선택(들)에 실제로 있는 화면 집합. 로그동작 미선택("전체")이면 전체 화면.
function visibleScreenNames() {
  if (selectedActions.size === 0) {
    return new Set(ALL_SCREENS);
  }
  const names = new Set();
  for (const screen of ALL_SCREENS) {
    const codes = ACTIONS_BY_SCREEN[screen] || [];
    if (codes.some((c) => selectedActions.has(c))) names.add(screen);
  }
  return names;
}

// 지금 화면 선택(들)에 실제로 있는 로그동작 코드 집합. 화면 미선택("전체")이면 전체 로그동작.
function visibleActionCodes() {
  if (selectedScreens.size === 0) {
    return new Set(ALL_ACTION_CODES);
  }
  const codes = new Set();
  for (const s of selectedScreens) {
    for (const code of ACTIONS_BY_SCREEN[s] || []) codes.add(code);
  }
  return codes;
}

// 로그동작 선택이 바뀌면, 이제 로그동작 밖으로 밀려난 화면 선택은 지운다.
function pruneScreensOutsideActions() {
  const visible = visibleScreenNames();
  for (const name of [...selectedScreens]) {
    if (!visible.has(name)) selectedScreens.delete(name);
  }
}

// 화면 선택이 바뀌면, 이제 화면 밖으로 밀려난 로그동작 선택은 지운다.
function pruneActionsOutsideScreens() {
  const visible = visibleActionCodes();
  for (const code of [...selectedActions]) {
    if (!visible.has(code)) selectedActions.delete(code);
  }
}

function renderScreenList() {
  const list = document.getElementById("screen-list");
  const visible = visibleScreenNames();
  const allChecked = selectedScreens.size === 0;
  list.innerHTML = [
    `<label class="dropdown-item dropdown-item-ms">
       <input type="checkbox" class="screen-cb" value="ALL" ${allChecked ? "checked" : ""} />
       <span class="dropdown-item-label">전체</span>
     </label>`,
    ...ALL_SCREENS.filter((name) => visible.has(name)).map(
      (name) => `
      <label class="dropdown-item dropdown-item-ms">
        <input type="checkbox" class="screen-cb" value="${name}" ${selectedScreens.has(name) ? "checked" : ""} />
        <span class="dropdown-item-label">${SCREEN_LABELS[name] ?? name}</span>
      </label>`
    ),
  ].join("");
  list.querySelectorAll(".screen-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.value === "ALL") {
        if (cb.checked) selectedScreens.clear();
      } else {
        if (cb.checked) selectedScreens.add(cb.value);
        else selectedScreens.delete(cb.value);
      }
      renderScreenList();
      renderScreenToggle();
      pruneActionsOutsideScreens();
      renderActionList();
      renderActionToggle();
      load();
    });
  });
}

function renderScreenToggle() {
  const toggle = document.getElementById("screen-toggle");
  if (selectedScreens.size === 0) {
    toggle.textContent = "전체";
  } else if (selectedScreens.size <= 2) {
    toggle.textContent = [...selectedScreens].map((s) => SCREEN_LABELS[s] ?? s).join(", ");
  } else {
    toggle.textContent = `${selectedScreens.size}개 선택`;
  }
}

document.getElementById("screen-toggle").addEventListener("click", () => {
  document.getElementById("screen-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("screen-dropdown").contains(e.target)) {
    document.getElementById("screen-list").classList.add("hidden");
  }
});

// 로그동작 목록은 가나다순이 아니라 ACTION_GROUPS(백엔드가 정한 업무 흐름 순서: 자료
// 반출입·검수 → 자료·폴더 정보 변경 → 외부 반출·다운로드 → 계정)로 묶어서 보여준다.
// 지금 선택된 화면에 실제로 없는 동작이거나(visible), 그 그룹에 항목이 하나도 안 남으면 그룹째 뺀다.
function renderActionList() {
  const list = document.getElementById("action-list");
  const visible = visibleActionCodes();
  const allChecked = selectedActions.size === 0;

  const groupsHtml = ACTION_GROUPS.map((group) => {
    const codes = group.actions.filter((c) => visible.has(c));
    if (codes.length === 0) return "";
    return `
      <div class="dropdown-group-label">${group.label}</div>
      ${codes.map(
        (code) => `
        <label class="dropdown-item dropdown-item-ms">
          <input type="checkbox" class="action-cb" value="${code}" ${selectedActions.has(code) ? "checked" : ""} />
          <span class="dropdown-item-label">${ACTION_LABELS[code]}</span>
        </label>`
      ).join("")}`;
  }).join("");

  list.innerHTML = `
    <label class="dropdown-item dropdown-item-ms">
      <input type="checkbox" class="action-cb" value="ALL" ${allChecked ? "checked" : ""} />
      <span class="dropdown-item-label">전체</span>
    </label>
    ${groupsHtml}`;
  list.querySelectorAll(".action-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.value === "ALL") {
        if (cb.checked) selectedActions.clear();
      } else {
        if (cb.checked) selectedActions.add(cb.value);
        else selectedActions.delete(cb.value);
      }
      renderActionList();
      renderActionToggle();
      pruneScreensOutsideActions();
      renderScreenList();
      renderScreenToggle();
      load();
    });
  });
}

function renderActionToggle() {
  const toggle = document.getElementById("action-toggle");
  if (selectedActions.size === 0) {
    toggle.textContent = "전체";
  } else if (selectedActions.size <= 2) {
    toggle.textContent = [...selectedActions].map((c) => ACTION_LABELS[c] ?? c).join(", ");
  } else {
    toggle.textContent = `${selectedActions.size}개 선택`;
  }
}

document.getElementById("action-toggle").addEventListener("click", () => {
  document.getElementById("action-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("action-dropdown").contains(e.target)) {
    document.getElementById("action-list").classList.add("hidden");
  }
});

// ---- 사용자 다중선택 드롭다운 ----
// "전체"와 개별 사용자는 서로 배타적이다: 전체를 고르면 개별 선택이 다 풀리고, 개별을 하나라도
// 고르면 전체 선택은 자동으로 풀린다. selectedUsers가 비어있는 상태 = "전체".
let allUsers = []; // [{id, name}] — 사용자 관리에 등록된 계정(비활성 포함, 과거 기록 조회용)
const selectedUsers = new Set();

function renderUserList() {
  const list = document.getElementById("user-list");
  const allChecked = selectedUsers.size === 0;
  list.innerHTML = [
    `<label class="dropdown-item dropdown-item-ms">
       <input type="checkbox" class="user-cb" value="ALL" ${allChecked ? "checked" : ""} />
       <span class="dropdown-item-label">전체</span>
     </label>`,
    ...allUsers.map(
      (u) => `
       <label class="dropdown-item dropdown-item-ms">
         <input type="checkbox" class="user-cb" value="${u.id}" ${selectedUsers.has(u.id) ? "checked" : ""} />
         <span class="dropdown-item-label">${escapeHtml(u.name)}</span>
       </label>`
    ),
  ].join("");

  list.querySelectorAll(".user-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.value === "ALL") {
        if (cb.checked) selectedUsers.clear();
        // 전체를 체크 해제해도 다른 게 하나도 안 골라졌으면 다시 전체로 되돌아간다
        // (아래 renderUserList가 selectedUsers.size===0 기준으로 다시 그리므로 자동 처리됨)
      } else {
        const id = Number(cb.value);
        if (cb.checked) selectedUsers.add(id);
        else selectedUsers.delete(id);
      }
      renderUserList();
      renderUserToggle();
      load();
    });
  });
}

function renderUserToggle() {
  const toggle = document.getElementById("user-toggle");
  if (selectedUsers.size === 0) {
    toggle.textContent = "전체";
    return;
  }
  const names = allUsers.filter((u) => selectedUsers.has(u.id)).map((u) => u.name);
  toggle.textContent = names.length <= 2 ? names.join(", ") : `${names[0]} 외 ${names.length - 1}명`;
}

async function loadUsers() {
  // /users는 screen.users.access 권한이 있어야 해서, 이름만 필요한 이 드롭다운은
  // 권한 없이도(로그인만 하면) 쓸 수 있는 /users/names를 쓴다(퇴직자도 과거 기록 조회용으로 포함).
  const res = await fetch("/users/names");
  if (!res.ok) return;
  allUsers = (await res.json()).sort((a, b) => a.name.localeCompare(b.name, "ko"));

  // screen.audit.viewer.other_user 권한이 없으면 본인 기록만 조회 가능하다(서버도 user_id를
  // 본인 id로 강제 고정한다) — 드롭다운도 본인 하나만 보이게 고정해둔다.
  const perms = window.__tdmsPerms || new Set();
  const me = window.__tdmsMe;
  if (!perms.has("screen.audit.viewer.other_user") && me) {
    allUsers = allUsers.filter((u) => u.id === me.id);
    selectedUsers.clear();
    selectedUsers.add(me.id);
    document.getElementById("user-toggle").disabled = true;
  }

  renderUserList();
  renderUserToggle();
}

document.getElementById("user-toggle").addEventListener("click", () => {
  document.getElementById("user-list").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("user-dropdown").contains(e.target)) {
    document.getElementById("user-list").classList.add("hidden");
  }
});

function buildQuery() {
  const usp = new URLSearchParams();
  for (const screen of selectedScreens) usp.append("screen", screen);
  for (const action of selectedActions) usp.append("action", action);
  for (const id of selectedUsers) usp.append("user_id", id);
  const q = document.getElementById("q").value.trim();
  if (q) usp.set("q", q);
  const from = document.getElementById("from-filter").value;
  const to = document.getElementById("to-filter").value;
  if (from) usp.set("date_from", `${from}T00:00:00`);
  if (to) usp.set("date_to", `${to}T23:59:59`);
  return usp.toString();
}

async function loadMeta() {
  const res = await fetch("/audit-log/meta");
  const meta = await res.json();
  ALL_SCREENS = meta.screens;
  ACTIONS_BY_SCREEN = meta.actions_by_screen;
  ACTION_LABELS = meta.action_labels;
  SCREEN_LABELS = meta.screen_labels;
  ACTION_GROUPS = meta.action_groups;
  ALL_ACTION_CODES = ACTION_GROUPS.flatMap((g) => g.actions);
}

// ---------------------------------------------------------------------------
// 화면 이동 후 돌아와도 검색조건이 유지되도록 sessionStorage에 저장/복원 (TDB 조회와 같은 방식).
// 새로고침(F5)이나 로고 클릭 시에는 ui.js가 지운다. 드롭다운 항목(화면·로그동작·사용자)은
// loadMeta()·loadUsers()가 끝난 뒤라야 존재하므로, restoreState()는 init()에서 그 다음에 부른다.
// ---------------------------------------------------------------------------
const STATE_KEY = "dms_audit_state";

function saveState() {
  const snapshot = {
    q: document.getElementById("q").value,
    from: document.getElementById("from-filter").value,
    to: document.getElementById("to-filter").value,
    screens: [...selectedScreens],
    actions: [...selectedActions],
    users: [...selectedUsers],
  };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
}

function restoreState() {
  const raw = sessionStorage.getItem(STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    document.getElementById("q").value = s.q || "";
    document.getElementById("from-filter").value = s.from || "";
    document.getElementById("to-filter").value = s.to || "";
    selectedScreens.clear();
    (s.screens || []).forEach((v) => selectedScreens.add(v));
    selectedActions.clear();
    (s.actions || []).forEach((v) => selectedActions.add(v));
    renderScreenList();
    renderScreenToggle();
    renderActionList();
    renderActionToggle();
    // 다른 사용자 조회 권한이 없으면 본인 것만 강제 고정돼 있으므로(loadUsers) 건드리지 않는다
    if (!document.getElementById("user-toggle").disabled) {
      selectedUsers.clear();
      (s.users || []).forEach((v) => selectedUsers.add(v));
      renderUserList();
      renderUserToggle();
    }
  } catch (e) {
    /* 무시 */
  }
}

async function load() {
  saveState();
  const res = await fetch(`/audit-log?${buildQuery()}`);
  const rows = await res.json();

  document.getElementById("total-count").textContent = `${rows.length}건 (최근 순)`;

  const tbody = document.getElementById("audit-tbody");
  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">기록이 없습니다.</td></tr>';
    return;
  }

  // 미리보기 돋보기는 자료(document_id)가 있는 행에만 그린다 — 순서가 버튼 순서와 1:1로
  // 대응해야 해서(wirePreviewButtons), 자료 없는 행은 목록에서도 아예 뺀다.
  const previewList = rows
    .filter((r) => r.document_id)
    .map((r) => ({ id: r.document_id, drawingNo: r.display_name, path: null, pdfFileId: r.current_pdf_file_id, source: tdbSource(r.document_id) }));
  // 자료명 클릭 시 이전/다음이 이 표(시스템 로그, 지금 조회된 조건)에 나온 자료만 따라가게 한다.
  const navIds = [...new Set(rows.filter((r) => r.document_id).map((r) => r.document_id))];

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const nameCell = r.document_id
      ? `${previewBtnHtml(r.current_pdf_file_id)} <a href="detail.html?id=${r.document_id}&from=audit">${escapeHtml(r.display_name)}</a>`
      : naCell();
    const zipName = r.zip_filename ? escapeHtml(r.zip_filename) : "";
    const zipActions = r.zip_filename
      ? `<button class="small" data-zip-download="${zipName}">Zip 다운</button>
         <button class="small" data-zip-status="${zipName}">상세 현황</button>`
      : "";
    const detailText = formatDetail(r.detail);
    tr.innerHTML = `
      <td class="col-no">${i + 1}</td>
      <td class="muted tc">${r.created_at.slice(0, 19).replace("T", " ")}</td>
      <td class="muted tc">${r.screen ? escapeHtml(SCREEN_LABELS[r.screen] ?? r.screen) : naCell()}</td>
      <td class="tc">${actionBadge(r.action)}</td>
      <td class="muted tc">${textOrNa(r.user_name)}</td>
      <td>${nameCell}</td>
      <td class="muted tc">${zipName || naCell()}</td>
      <td class="tc">${zipActions}</td>
      <td class="muted detail-cell${detailText ? " detail-cell-clickable" : ""}">${escapeHtml(detailText)}</td>
    `;
    if (detailText) {
      tr.querySelector(".detail-cell").addEventListener("click", () => {
        showDetailTextPopup("상세 내용", detailText);
      });
    }
    tbody.appendChild(tr);
  });

  wirePreviewButtons(tbody, previewList);
  wireDetailLinks(tbody, navIds);
  wireZipButtons(tbody, "audit");
}

document.getElementById("search-btn").addEventListener("click", load);
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") load();
});

document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("q").value = "";
  document.getElementById("from-filter").value = "";
  document.getElementById("to-filter").value = "";
  selectedScreens.clear();
  selectedActions.clear();
  selectedUsers.clear();
  renderScreenList();
  renderScreenToggle();
  renderActionList();
  renderActionToggle();
  renderUserList();
  renderUserToggle();
  load();
});

document.getElementById("export-btn").addEventListener("click", () => {
  // 현재 조회 조건 그대로 엑셀로 내려받는다
  window.location = `/audit-log/export?${buildQuery()}`;
});

(async function init() {
  await window.tdmsReady; // 권한(window.__tdmsPerms)에 따라 "사용자" 필터를 다르게 그리므로 먼저 기다린다
  await loadMeta();
  await loadUsers(); // 화면·로그동작·사용자 드롭다운 목록(ALL_SCREENS 등)이 다 갖춰진 뒤 복원한다
  restoreState();
  renderScreenList();
  renderScreenToggle();
  renderActionList();
  renderActionToggle();
  await load();
  makeColumnsResizable(document.getElementById("audit-table"));
  makeSortable(document.getElementById("audit-table"));
})();
