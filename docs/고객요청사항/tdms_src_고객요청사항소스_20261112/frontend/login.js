// 로그인 화면.
// 2026-09-17 시큐어코딩(CM 지시): 로그인 없이 자동으로 관리자 계정으로 들어가던 임시 방식을 없애고
// 로그인을 다시 켰다. 기본 비밀번호(새 계정·비밀번호 초기화)로 들어온 사람은 여기서 새 비밀번호를
// 정하고 다른 화면으로 넘어간다 — 다른 화면에서 그 상태가 발견되면 auth-guard.js가 login.html?change=1로
// 보내 이 칸을 다시 연다.
// 2026-09-29 CM 지시: 급할 땐 [다음에 변경하기]로 이번만 미루고 그대로 쓸 수 있다. 미뤘다는 표시는
// 서버 세션에만 남으므로 다음에 다시 로그인하면 이 칸이 또 뜬다.

const loginPanel = document.getElementById("login-panel");
const changePanel = document.getElementById("change-panel");
const errorBox = document.getElementById("login-error");

// 방금 로그인 칸에 적은 비밀번호. 로그인하자마자 비밀번호 변경 칸이 뜨는 경우 "현재 비밀번호"를
// 한 번 더 묻지 않으려고 이 화면에 있는 동안만 들고 있다(저장하지 않는다).
let justTypedPassword = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

async function readDetail(res, fallback) {
  try {
    const body = await res.json();
    return body.detail || fallback;
  } catch {
    return fallback;
  }
}

function goToApp() {
  // 과거 Rev 폴더 안내창의 "띄우지 않기"는 로그아웃 전까지만 유효하다(2026-09-29 CM 지시).
  // 로그인할 때마다 지워 다시 뜨게 한다 — 키 이름은 ui.js의 OLD_REV_NOTICE_OFF_KEY와 같아야 한다
  // (로그인 화면은 ui.js를 읽지 않아 값을 그대로 적는다).
  try {
    sessionStorage.removeItem("dms_old_rev_notice_off");
  } catch (e) {
    /* 저장소를 못 쓰는 브라우저 — 안내창이 계속 뜰 뿐이라 그냥 넘어간다 */
  }
  window.location.href = "index.html";
}

function showLoginPanel(message) {
  justTypedPassword = null;
  changePanel.classList.add("hidden");
  loginPanel.classList.remove("hidden");
  ["change-current", "change-new", "change-confirm", "password"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  if (message) showError(message);
  else clearError();
  document.getElementById("username").focus();
}

function showChangePanel(me, knownCurrentPassword) {
  justTypedPassword = knownCurrentPassword;
  loginPanel.classList.add("hidden");
  changePanel.classList.remove("hidden");
  // 규칙 문구는 서버가 실제로 검사하는 규칙과 같은 글을 받아 쓴다(app/auth.py PASSWORD_RULE_TEXT)
  document.getElementById("change-rule").textContent = `규칙: ${me.password_rule}`;
  document.getElementById("change-current-label").classList.toggle("hidden", Boolean(knownCurrentPassword));
  document.getElementById(knownCurrentPassword ? "change-new" : "change-current").focus();
}

async function doLogin() {
  clearError();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  if (!username || !password) {
    showError("아이디와 비밀번호를 입력해 주세요");
    return;
  }

  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    document.getElementById("password").value = "";
    showError(await readDetail(res, "로그인하지 못했습니다"));
    return;
  }

  const me = await res.json();
  if (me.must_change_password) {
    showChangePanel(me, password);
    return;
  }
  goToApp();
}

async function doChangePassword() {
  clearError();
  const current = justTypedPassword ?? document.getElementById("change-current").value;
  const next = document.getElementById("change-new").value;
  const confirmValue = document.getElementById("change-confirm").value;
  if (!current || !next || !confirmValue) {
    showError("비밀번호 칸을 모두 입력해 주세요");
    return;
  }
  if (next !== confirmValue) {
    showError("새 비밀번호와 확인이 서로 다릅니다");
    return;
  }

  const res = await fetch("/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: current, new_password: next }),
  });
  if (res.status === 401) {
    showLoginPanel("로그인이 풀렸습니다. 다시 로그인해 주세요");
    return;
  }
  if (!res.ok) {
    showError(await readDetail(res, "비밀번호를 바꾸지 못했습니다"));
    return;
  }
  justTypedPassword = null;
  goToApp();
}

document.getElementById("login-btn").addEventListener("click", doLogin);
["username", "password"].forEach((id) => {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
});

document.getElementById("change-btn").addEventListener("click", doChangePassword);
["change-current", "change-new", "change-confirm"].forEach((id) => {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") doChangePassword();
  });
});

// [다음에 변경하기] — 이번만 미루고 그대로 쓴다. 서버가 이 로그인 동안만 안내를 넘겨 준다.
document.getElementById("change-later-btn").addEventListener("click", async () => {
  clearError();
  const res = await fetch("/auth/password/defer", { method: "POST" });
  if (!res.ok) {
    showError(await readDetail(res, "잠시 미루지 못했습니다. 비밀번호를 바꿔 주세요"));
    return;
  }
  justTypedPassword = null;
  goToApp();
});

document.getElementById("change-logout-btn").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  showLoginPanel();
});

(async function init() {
  // 다른 화면에서 "비밀번호를 먼저 바꿔야 한다"로 넘어온 경우 — 로그인은 돼 있으니 변경 칸부터 연다
  if (new URLSearchParams(window.location.search).get("change") === "1") {
    const res = await fetch("/auth/me");
    if (res.ok) {
      const me = await res.json();
      if (me.must_change_password && !me.password_change_deferred) {
        showChangePanel(me, null);
        return;
      }
      goToApp();
      return;
    }
  }
  // 로그인하고 4시간이 지나 자동으로 풀려서 넘어온 경우 (2026-10-16)
  if (new URLSearchParams(window.location.search).get("expired") === "1") {
    showError("로그인하고 4시간이 지나 자동으로 로그아웃되었습니다. 다시 로그인해 주세요");
  }
  document.getElementById("username").focus();
})();
