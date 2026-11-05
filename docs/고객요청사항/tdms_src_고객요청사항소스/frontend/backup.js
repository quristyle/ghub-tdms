// 백업 관리 화면 (2026-09-29 CM 지시로 신설 — 원칙 12·D-18 개정, D-105).
//
// 하는 일은 셋이다.
//   ① 지금 상태 보여주기 — 무엇이 얼마나 있고, 마지막 백업 뒤 무엇이 달라졌는지
//   ② 백업 만들기 — 서버가 딴 줄에서 묶으므로 진행상황을 1초마다 물어본다
//   ③ 이력 표 — 만든 묶음을 [받기]로 내려받고(이어받기 됨), [파일 삭제]로 용량을 비우고,
//      비고를 적는다
//
// 되살리기(복원) 버튼은 일부러 만들지 않았다 — 서버를 멈추고 DB를 통째로 바꾸는 일이라
// 묶음 안의 읽어주세요 파일 순서대로 사람이 한다(app/backup.py 참고).
//
// [파일 삭제]는 묶음 파일만 지우고 이력 줄은 그대로 둔다(D-107). 그래서 상태 칸이 셋이다 —
// 있음 / 삭제됨(화면에서 지움) / 없음(탐색기에서 지웠거나 옮김).
//
// 이 화면은 보안 머리글(CSP) 때문에 onclick 같은 것을 HTML에 직접 쓸 수 없다 —
// 버튼은 전부 여기서 addEventListener로 연결한다(D-96 ⑥).

const PERM_RUN = "screen.backup.run";
const PERM_DELETE = "screen.backup.delete_file";
const POPUP_TITLE = "백업 이력";

let statusData = null;
let runs = [];
let pollTimer = null;
let canRun = false;
let canDelete = false;

function perms() {
  return window.__tdmsPerms || new Set();
}

function gb(bytes) {
  if (bytes == null) return "—";
  return formatFileSize(bytes);
}

// ── 지금 상태 ────────────────────────────────────────────────────────────────
function kindExplain(info) {
  if (info.kind === "TDB") return "TDB 도면 파일 전부 (최신·이력·검수대기·반출·폐기)";
  if (info.kind === "MDB") return "MDB 자료 파일 전부 (폐기 포함)";
  if (info.kind === "DB") return "도면 목록·리비전 이력·반출·검수·시스템 로그·계정·권한 (비밀번호는 담지 않습니다)";
  if (info.kind === "CODE") return "서버·화면 코드와 지침서 (이것만 있으면 시스템을 다시 세울 수 있습니다)";
  return "필요한 외부 프로그램의 버전·받는 곳·설치 순서";
}

function renderStatus() {
  const tbody = document.getElementById("bk-status-tbody");
  document.getElementById("bk-dest").textContent = statusData.dest;
  document.getElementById("bk-free").textContent = ` (남은 공간 ${gb(statusData.free_bytes)})`;

  tbody.innerHTML = statusData.kinds
    .map((info) => {
      const now = info.current_count != null
        ? `${info.current_count.toLocaleString()}개 / ${gb(info.current_bytes)}`
        : "—";
      const last = info.last_seq
        ? `${info.last_seq}회차 · ${fmtDateTime(info.last_at)}`
        : `<span class="bk-never">없음</span>`;
      let changed = "—";
      if (info.changed_count != null) {
        const parts = [`${info.changed_count.toLocaleString()}개 / ${gb(info.changed_bytes)}`];
        if (info.removed_count) parts.push(`없어진 것 ${info.removed_count.toLocaleString()}개`);
        changed = info.changed_count || info.removed_count
          ? `<span class="bk-changed">${parts.join(" · ")}</span>`
          : "바뀐 것 없음";
      }
      return `<tr><td>${escapeHtml(info.label)}</td><td>${now}</td><td>${last}</td>` +
        `<td>${changed}</td><td class="bk-explain">${escapeHtml(kindExplain(info))}</td></tr>`;
    })
    .join("");

  // 담을 항목 체크박스 — 처음엔 전부 켜 둔다
  const box = document.getElementById("bk-kinds");
  if (!box.dataset.ready) {
    box.innerHTML = statusData.kinds
      .map(
        (info) =>
          `<label class="bk-check"><input type="checkbox" data-kind="${info.kind}" checked /> ${escapeHtml(info.label)}</label>`
      )
      .join("");
    box.dataset.ready = "1";
  }
}

// ── 이력 표 ──────────────────────────────────────────────────────────────────
function scopeText(it) {
  if (it.scope === "DELTA") {
    return it.base_seq ? `변경분 (${it.base_seq}회차 이후)` : "변경분";
  }
  return "전체";
}

function renderRuns() {
  const tbody = document.getElementById("bk-runs-tbody");
  document.getElementById("bk-count").textContent = `전체 ${runs.length}건`;

  if (!runs.length) {
    tbody.innerHTML = `<tr><td colspan="17" class="empty">아직 만든 백업이 없습니다. 위에서 [전체 백업 만들기]를 눌러 주세요.</td></tr>`;
    return;
  }

  tbody.innerHTML = runs
    .map((it, idx) => {
      const state = stateCellHtml(it);
      const acts = [];
      if (it.downloadable) {
        acts.push(
          `<button type="button" class="small" data-download="${it.id}" ${canRun ? "" : "disabled"}>받기</button>`
        );
      } else if (it.exists) {
        // 폴더로 만든 백업은 화면에서 내려받을 수 없다(탐색기에서 가져간다)
        acts.push(
          `<span class="bk-dash" title="폴더로 만든 백업입니다. 탐색기에서 복사해 가져가 주세요.">—</span>`
        );
      }
      if (it.deletable) {
        acts.push(
          `<button type="button" class="small" data-delfile="${it.id}" ${canDelete ? "" : "disabled"}` +
            ` title="묶음 파일만 지웁니다. 이 이력 줄은 그대로 남습니다.">파일 삭제</button>`
        );
      }
      const act = acts.length
        ? acts.join(" ")
        : `<span class="bk-dash" title="${
            it.state === "DELETED"
              ? "화면에서 지운 백업입니다. 이력만 남아 있습니다."
              : "묶음 파일이 저장 위치에 없습니다."
          }">—</span>`;
      return `<tr>
        <td>${idx + 1}</td>
        <td>${it.seq}</td>
        <td>${escapeHtml(it.kind_label)}</td>
        <td>${escapeHtml(scopeText(it))}</td>
        <td class="bk-file" title="${escapeHtml(it.dest_dir + "\\" + it.filename)}">${escapeHtml(it.filename)}</td>
        <td>${it.delivery === "ZIP" ? "묶음 파일" : "폴더"}</td>
        <td>${gb(it.source_bytes)}</td>
        <td>${it.delivery === "ZIP" ? gb(it.file_size) : "—"}</td>
        <td>${(it.file_count || 0).toLocaleString()}</td>
        <td>${it.removed_count ? it.removed_count.toLocaleString() : ""}</td>
        <td>${escapeHtml(it.created_by || "")}</td>
        <td>${fmtDateTime(it.created_at)}</td>
        <td>${it.download_count || 0}</td>
        <td>${fmtDateTime(it.downloaded_at)}</td>
        <td>${state}</td>
        <td>${act}</td>
        <td>${noteEditCellHtml(it.id, it.note)}</td>
      </tr>`;
    })
    .join("");

  wireNoteEdits(tbody, (id) => `/backup/runs/${id}/note`, PERM_RUN);
  tbody.querySelectorAll("[data-download]").forEach((btn) => {
    btn.addEventListener("click", () => downloadRun(Number(btn.dataset.download)));
  });
  tbody.querySelectorAll("[data-delfile]").forEach((btn) => {
    btn.addEventListener("click", () => deleteRunFile(Number(btn.dataset.delfile)));
  });
}

// 상태 칸 — 파일이 없어진 까닭을 둘로 나눠 보여 준다(화면에서 지움 / 탐색기에서 없어짐).
function stateCellHtml(it) {
  if (it.state === "DELETED") {
    const who = it.deleted_by ? `${it.deleted_by}님이 ` : "";
    const when = it.deleted_at ? fmtDateTime(it.deleted_at) : "";
    return `<span class="badge badge-neutral" title="${escapeHtml(
      `${who}${when}에 화면에서 지웠습니다. 이력은 그대로 남아 있습니다.`
    )}">삭제됨</span>`;
  }
  if (!it.exists) {
    return `<span class="badge badge-warning" title="저장 위치에 묶음이 없습니다. 탐색기에서 지웠거나 다른 곳으로 옮겼을 수 있습니다.">없음</span>`;
  }
  return `<span class="badge badge-success">있음</span>`;
}

function renderWarn(notDownloaded) {
  const box = document.getElementById("bk-warn");
  const lines = [];
  Object.keys(notDownloaded || {}).forEach((kind) => {
    const seqs = notDownloaded[kind];
    const label = (statusData ? statusData.kinds.find((k) => k.kind === kind) : null);
    lines.push(
      `${label ? label.label : kind}: ${seqs.join(", ")}회차를 아직 받지 않았습니다.`
    );
  });
  if (!lines.length) {
    box.classList.add("hidden");
    return;
  }
  box.innerHTML =
    `<strong>받지 않은 회차가 있습니다.</strong> 변경분은 앞 회차가 모두 있어야 완전합니다 — 빠진 회차를 먼저 받아 두십시오.<br />` +
    lines.map((t) => escapeHtml(t)).join("<br />");
  box.classList.remove("hidden");
}

function downloadRun(id) {
  // 보통 다운로드로 받는다 — 끊기면 브라우저가 이어받을 수 있다(서버가 Range를 받아 준다).
  const a = document.createElement("a");
  a.href = `/backup/runs/${id}/download`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 받은 횟수가 표에 반영되도록 잠시 뒤 다시 읽는다
  setTimeout(loadRuns, 1500);
}

// 묶음 파일만 지운다 — 이력 줄은 남는다(D-107).
// 되살릴 수 없는 일이라, 무엇이 지워지고 무엇이 남는지를 눌러 보기 전에 전부 적어 둔다.
async function deleteRunFile(id) {
  const it = runs.find((r) => r.id === id);
  if (!it) return;

  const lines = [
    `백업 묶음 ${it.delivery === "FOLDER" ? "폴더" : "파일"}를 지웁니다.`,
    ``,
    `종류: ${it.kind_label} · ${scopeText(it)} · ${it.seq}회차`,
    `파일: ${it.filename}`,
    `크기: ${gb(it.file_size)}`,
    `자리: ${it.dest_dir}`,
    ``,
    `지워지는 것은 이 백업 사본 하나뿐입니다.`,
    `· 백업 이력(이 줄)은 그대로 남습니다.`,
    `· 변경분 계산에 쓰는 목록표도 남아, 다음 변경분을 이어서 만들 수 있습니다.`,
    `· 시스템의 도면·자료·기록은 아무것도 지워지지 않습니다.`,
  ];

  if (!it.download_count) {
    lines.push(
      ``,
      `※ 이 백업은 아직 한 번도 받지 않았습니다. 지우면 이 회차의 자료는 어디에도 남지 않습니다.`
    );
  }
  const later = runs.filter(
    (r) => r.kind === it.kind && r.scope === "DELTA" && r.seq > it.seq
  );
  if (later.length) {
    lines.push(
      ``,
      `※ 이 회차 뒤로 변경분이 ${later.length}건 만들어져 있습니다. 나중에 되살리려면 이 백업부터`,
      `   차례로 필요하니, 받아 두지 않았다면 지우지 마십시오.`
    );
  }
  lines.push(``, `지운 파일은 되살릴 수 없습니다. 계속할까요?`);

  if (!(await showConfirm(lines.join("\n")))) return;

  const res = await fetch(`/backup/runs/${id}/delete-file`, { method: "POST" });
  if (!res.ok) {
    await showAlert(await safeErrText(res));
    await loadRuns();
    return;
  }
  const data = await res.json();
  await loadStatus();
  await loadRuns();
  await showAlert(
    `묶음을 지웠습니다. ${gb(data.freed)}를 비웠습니다.\n백업 이력은 "삭제됨"으로 그대로 남아 있습니다.`
  );
}

// ── 만들기 ───────────────────────────────────────────────────────────────────
function checkedKinds() {
  return [...document.querySelectorAll("#bk-kinds input[data-kind]")]
    .filter((el) => el.checked)
    .map((el) => el.dataset.kind);
}

async function runBackup(scope) {
  let kinds = checkedKinds();
  const folderMode = document.getElementById("bk-folder-mode").checked;
  if (scope === "DELTA") kinds = kinds.filter((k) => k === "TDB" || k === "MDB");
  if (folderMode) kinds = kinds.filter((k) => k === "TDB" || k === "MDB");
  if (!kinds.length) {
    await showAlert(
      scope === "DELTA" || folderMode
        ? "변경분과 폴더로 만들기는 TDB·MDB 도면 파일만 됩니다. 담을 항목에서 그 둘 중 하나를 골라 주세요."
        : "담을 항목을 하나 이상 골라 주세요."
    );
    return;
  }

  const labels = kinds
    .map((k) => (statusData.kinds.find((s) => s.kind === k) || {}).label || k)
    .join(", ");
  const dest = document.getElementById("bk-dest-input").value.trim();
  const lines = [
    `${scope === "DELTA" ? "변경분" : "전체"} 백업을 만듭니다.`,
    ``,
    `담을 항목: ${labels}`,
    `저장 위치: ${dest || statusData.dest}`,
    folderMode ? `받는 방법: 압축하지 않고 폴더로 (화면에서 내려받을 수 없습니다)` : `받는 방법: 묶음 파일`,
    ``,
    `만드는 동안 자료를 등록·반입하지 말아 주십시오.`,
    `자료가 많으면 몇 분 걸릴 수 있습니다.`,
  ];
  if (!(await showConfirm(lines.join("\n")))) return;

  const res = await fetch("/backup/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kinds,
      scope,
      delivery: folderMode ? "FOLDER" : "ZIP",
      dest: dest || null,
      note: document.getElementById("bk-note-input").value.trim() || null,
    }),
  });
  if (!res.ok) {
    await showAlert(await safeErrText(res));
    return;
  }
  document.getElementById("bk-result").classList.add("hidden");
  startPolling();
}

function setRunning(on) {
  ["bk-run-full", "bk-run-delta"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = on || !canRun;
  });
  document.getElementById("bk-progress").classList.toggle("hidden", !on);
}

function startPolling() {
  setRunning(true);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollProgress, 1000);
  pollProgress();
}

async function pollProgress() {
  let job;
  try {
    job = await (await fetch("/backup/progress")).json();
  } catch (e) {
    return;
  }
  const stepEl = document.getElementById("bk-progress-step");
  const timeEl = document.getElementById("bk-progress-time");
  const detailEl = document.getElementById("bk-progress-detail");
  const fill = document.getElementById("bk-bar-fill");

  stepEl.textContent = job.step || "준비 중";
  if (job.started_at) {
    const started = new Date(job.started_at);
    const end = job.finished_at ? new Date(job.finished_at) : new Date();
    const sec = Math.max(0, Math.round((end - started) / 1000));
    timeEl.textContent = `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  }
  const pct = job.total_bytes
    ? Math.min(100, Math.round((job.done_bytes / job.total_bytes) * 100))
    : job.total_files
    ? Math.min(100, Math.round((job.done_files / job.total_files) * 100))
    : 0;
  fill.style.width = `${pct}%`;
  detailEl.textContent = job.total_files
    ? `파일 ${job.done_files.toLocaleString()} / ${job.total_files.toLocaleString()}개` +
      (job.total_bytes ? `  (${gb(job.done_bytes)} / ${gb(job.total_bytes)}, ${pct}%)` : "")
    : "";

  if (!job.running) {
    clearInterval(pollTimer);
    pollTimer = null;
    setRunning(false);
    showResult(job);
    await loadStatus();
    await loadRuns();
  }
}

function showResult(job) {
  const box = document.getElementById("bk-result");
  if (job.error) {
    box.className = "bk-result bk-result-bad";
    box.innerHTML = `<strong>백업을 만들지 못했습니다.</strong><br />${escapeHtml(job.error)}`;
    box.classList.remove("hidden");
    return;
  }
  if (!job.made || !job.made.length) {
    box.classList.add("hidden");
    return;
  }
  const rows = job.made
    .map(
      (m) =>
        `<li>${escapeHtml(m.label)} — ${escapeHtml(m.filename)} ` +
        `(${m.file_count.toLocaleString()}개, ${gb(m.file_size)}${m.delivery === "FOLDER" ? ", 폴더" : ""})</li>`
    )
    .join("");

  // 비밀번호가 적혀 있어 묶음에서 뺀 파일이 있으면 크게 알린다 (D-105 ②).
  // 조용히 빼면 "왜 그 파일이 없지?"를 나중에 알 수 없고, 무엇보다 그 파일을 고쳐야 한다.
  const leaked = job.made.flatMap((m) => m.skipped_secret || []);
  let warn = "";
  if (leaked.length) {
    warn =
      `<div class="bk-leak"><strong>비밀번호가 적혀 있어 ${leaked.length}개 파일을 묶음에서 뺐습니다.</strong><br />` +
      `그 파일 안에 .env의 DB 비밀번호나 서명키가 그대로 적혀 있습니다. 백업에 비밀번호가 실려 나가지 ` +
      `않도록 자동으로 뺀 것이니, 해당 파일에서 비밀번호를 걷어낸 뒤 다시 백업해 주세요.<ul>` +
      leaked.map((f) => `<li>${escapeHtml(f)}</li>`).join("") +
      `</ul></div>`;
  }

  box.className = "bk-result bk-result-good";
  box.innerHTML =
    `<strong>백업을 만들었습니다.</strong> 아래 이력 표에서 [받기]로 내려받으실 수 있습니다.<ul>${rows}</ul>${warn}`;
  box.classList.remove("hidden");
}

// ── 불러오기 ─────────────────────────────────────────────────────────────────
async function loadStatus() {
  const res = await fetch("/backup/status");
  if (!res.ok) return;
  statusData = await res.json();
  renderStatus();
}

async function loadRuns() {
  const res = await fetch("/backup/runs");
  if (!res.ok) return;
  const data = await res.json();
  runs = data.items || [];
  renderRuns();
  renderWarn(data.not_downloaded);
}

async function init() {
  await window.tdmsReady; // 권한에 따라 버튼을 흐리게 하므로 먼저 기다린다
  canRun = perms().has(PERM_RUN);
  canDelete = perms().has(PERM_DELETE);

  await loadStatus();
  await loadRuns();

  if (!canRun) {
    // 권한 없는 항목은 숨기지 않고 흐리게 (2026-08-17 이후 확립된 공통 원칙)
    document.querySelectorAll("#bk-make-panel button, #bk-make-panel input").forEach((el) => {
      el.disabled = true;
    });
    const panel = document.getElementById("bk-make-panel");
    const hint = panel.querySelector(".bk-hint");
    if (hint) hint.textContent = "백업을 만들 권한이 없습니다. 이력은 그대로 보실 수 있습니다.";
  }

  document.getElementById("bk-run-full").addEventListener("click", () => runBackup("FULL"));
  document.getElementById("bk-run-delta").addEventListener("click", () => runBackup("DELTA"));
  document.getElementById("bk-export-btn").addEventListener("click", () => {
    window.location = `/backup/runs/export?title=${encodeURIComponent(POPUP_TITLE)}`;
  });
  makeSortable(document.getElementById("bk-runs-table"));
  makeColumnsResizable(document.getElementById("bk-runs-table"));

  // 새로고침했을 때 이미 만드는 중이면 진행상황을 이어서 보여준다
  const job = await (await fetch("/backup/progress")).json();
  if (job.running) startPolling();
}

init();
