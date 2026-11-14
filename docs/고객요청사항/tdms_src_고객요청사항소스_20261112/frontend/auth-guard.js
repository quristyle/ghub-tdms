// 모든 보호 페이지에서 로드. 로그인 안 됐으면 로그인 화면으로 보내고,
// 로그인돼 있으면 상단 앱 바의 #user-slot에 사용자명 + 로그아웃을 채운다.
//
// 권한(2026-08-12, 권한.xlsx 기준 CM 확정): role=ADMIN은 항상 전체 권한. 그 외엔
// permission_tree.py에 있는 화면·기능만 그룹 권한(Y/N)으로 막고, 트리에 없는 화면·기능은
// 로그인만 하면 전부 열려 있다(화면 안 특정 버튼만 개별로 가려진다).
//
// 화면 접속(2026-09-28 CM 지시): 예전에는 "사용자 관리"만 권한이 있어야 들어갈 수 있었는데,
// 이제 모든 화면에 "페이지 접속" 권한이 있다. 어느 화면에 어느 권한이 필요한지는 서버
// (permission_tree.py의 PAGE_PERMISSIONS) 한 곳에만 적혀 있고 /auth/me가 그대로 내려준다
// (me.page_permissions·me.page_order) — 화면에 따로 적어 두면 서버와 어긋나기 때문이다.
// 실제 차단은 서버가 한다(화면 파일을 아예 안 내려준다). 여기서 하는 일은 상단 메뉴에서
// 링크를 빼고, 권한 없는 화면에 들어왔을 때 들어갈 수 있는 화면으로 보내는 것이다.

// 로그인이 풀렸거나(401) 임시 비밀번호를 아직 안 바꿨으면(403 + 표시 머리글) 어느 화면에서든
// 로그인 화면으로 보낸다(2026-09-17 — 로그인을 다시 켜면서 추가). 이 파일은 모든 화면에서 가장
// 먼저 읽히므로, 여기서 fetch를 한 번 감싸 두면 화면마다 따로 처리하지 않아도 된다.
(function watchLoginState() {
  const originalFetch = window.fetch.bind(window);
  let leaving = false;
  window.fetch = async function fetchWithLoginCheck(...args) {
    const res = await originalFetch(...args);
    if (!leaving && res.status === 401) {
      leaving = true;
      // 로그인하고 4시간이 지나 풀린 것이면 로그인 화면이 그 이유를 알려 준다 (2026-10-16)
      window.location.href = res.headers.get("X-Login-Expired") ? "login.html?expired=1" : "login.html";
    } else if (!leaving && res.status === 403 && res.headers.get("X-Password-Change-Required")) {
      leaving = true;
      window.location.href = "login.html?change=1";
    }
    return res;
  };
})();

// 상단 바 [도움말] 버튼 (2026-09-07 CM 지시로 감춤).
// 화면(help.html/help.js/help.css)과 아래 버튼 코드는 그대로 남겨 뒀다 — 이 한 줄을 true로
// 되돌리면 버튼이 예전 자리(사용자 이름 왼쪽)에 그대로 다시 나온다.
// 감춰도 주소(help.html)를 직접 치면 도움말 화면은 열린다.
const SHOW_HELP_BUTTON = false;

// 마이페이지 팝업 (2026-08-11: 별도 페이지에서 모든 화면 공용 팝업으로 전환).
// ui.js가 이 시점엔 이미 로드돼 있다(auth-guard.js의 fetch가 비동기로 끝나는 사이 나머지
// <script> 태그들이 먼저 실행됨) — escapeHtml/showAlert/ensureDialogRoot를 그대로 가져다 쓴다.
// 이름이 다른 화면(users.js/mdb.js 등)의 fetchJson·openModal과 겹치지 않도록
// 전부 mypage 접두어를 붙인다.

async function mypageFetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await showAlert(body.detail || "요청을 처리하지 못했습니다");
    throw new Error(body.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

let mypageLayer = null;

function closeMypageModal() {
  if (mypageLayer) {
    popDialogLayer(mypageLayer);
    mypageLayer = null;
  }
}

async function openMypageModal() {
  const me = await mypageFetchJson("/auth/me");
  mypageLayer = pushDialogLayer(`
    <div class="modal-overlay">
      <div class="modal-box mypage-box">
        <p class="modal-title">마이페이지</p>

        <div class="mypage-info">
          <div class="mypage-info-row"><span class="mypage-info-label">아이디</span><span class="mypage-info-value">${escapeHtml(me.username)}</span></div>
          <div class="mypage-info-row"><span class="mypage-info-label">이름</span><span class="mypage-info-value">${escapeHtml(me.name)}</span></div>
          <div class="mypage-info-row"><span class="mypage-info-label">권한</span><span class="mypage-info-value">${escapeHtml(me.group_name || "미배정")}</span></div>
        </div>

        <p class="mypage-section-title">비밀번호 변경</p>
        <label class="mypage-field-label" for="mp-current-password">현재 비밀번호</label>
        <input type="password" id="mp-current-password" autocomplete="off" />
        <label class="mypage-field-label" for="mp-new-password">새 비밀번호</label>
        <input type="password" id="mp-new-password" autocomplete="new-password" />
        <label class="mypage-field-label" for="mp-new-password-confirm">새 비밀번호 확인</label>
        <input type="password" id="mp-new-password-confirm" autocomplete="new-password" />
        <p class="page-desc" style="margin-top:8px">규칙: ${escapeHtml(me.password_rule || "")}</p>

        <div class="modal-actions">
          <button type="button" id="mp-close-btn">닫기</button>
          <button type="button" class="primary" id="mp-change-password-btn">비밀번호 변경</button>
        </div>
      </div>
    </div>`);

  // 크롬은 autocomplete="off"를 무시하고 저장된 비밀번호를 채워 넣는 경우가 있어
  // (실제로 "현재 비밀번호" 칸이 자동 입력되는 문제가 있었음), 채워질 시간을 준 뒤 비운다.
  const currentPwInput = mypageLayer.querySelector("#mp-current-password");
  setTimeout(() => { currentPwInput.value = ""; }, 0);

  mypageLayer.querySelector("#mp-close-btn").addEventListener("click", closeMypageModal);
  mypageLayer.querySelector("#mp-change-password-btn").addEventListener("click", async () => {
    const current = mypageLayer.querySelector("#mp-current-password").value;
    const next = mypageLayer.querySelector("#mp-new-password").value;
    const confirmVal = mypageLayer.querySelector("#mp-new-password-confirm").value;

    if (!current || !next || !confirmVal) {
      await showAlert("현재 비밀번호와 새 비밀번호를 모두 입력해 주세요");
      return;
    }
    if (next !== confirmVal) {
      await showAlert("새 비밀번호와 확인이 서로 다릅니다");
      return;
    }
    // 규칙(길이·섞을 글자 종류)은 서버가 검사하고 맞지 않으면 그 이유를 알림창으로 보여준다

    await mypageFetchJson("/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });

    closeMypageModal();
    await showAlert("비밀번호가 변경됐습니다.");
  });
}

// 다른 화면 스크립트가 window.__tdmsMe/__tdmsPerms를 쓰기 전에 이 fetch가 끝났다는 보장이
// 없다(둘 다 페이지 로드 시 거의 동시에 시작하는 별도 요청이라 순서가 뒤바뀔 수 있음) — 권한에
// 따라 화면을 다르게 그리는 곳은 자기 init()에서 `await window.tdmsReady`로 이 fetch가 끝날
// 때까지 기다린 뒤 그리면 된다.
let resolveTdmsReady;
window.tdmsReady = new Promise((resolve) => { resolveTdmsReady = resolve; });

// 권한 없는 항목은 숨기지 않고 흐리게 표시만 한다(2026-08-13 CM 확정) — 사용자가 자기한테
// 없는 기능이 뭔지 알아야 관리자에게 권한을 요청할 수 있기 때문. 화면 스크립트가 나중에
// 동적으로 만드는 버튼에도 그대로 쓸 수 있도록 전역에 노출해둔다.
window.applyPermDisabled = function applyPermDisabled(el) {
  el.classList.add("perm-disabled");
  if ("disabled" in el) el.disabled = true;
  el.querySelectorAll("input, button, select, textarea").forEach((f) => { f.disabled = true; });
};

(function () {
  fetch("/auth/me")
    .then((res) => {
      if (!res.ok) {
        window.location.href = "login.html";
        return null;
      }
      return res.json();
    })
    .then((me) => {
      if (!me) return;
      // 기본 비밀번호로 들어온 사람은 새 비밀번호를 정하기 전엔 다른 화면을 쓸 수 없다.
      // 다만 [다음에 변경하기]로 이번만 미뤘으면(password_change_deferred) 그대로 쓴다 (2026-09-29).
      if (me.must_change_password && !me.password_change_deferred) {
        window.location.href = "login.html?change=1";
        return;
      }
      window.__tdmsMe = me;
      // 로그인 4시간 자동 로그아웃(관리자 제외, 2026-10-16 CM 지시). 화면을 가만히 두어도 그 시각이 되면
      // 서버에 한 번 물어보고, 서버가 401로 답하면 위 fetch 감시가 로그인 화면으로 보낸다.
      if (typeof me.login_seconds_left === "number") {
        setTimeout(() => { fetch("/auth/me"); }, (me.login_seconds_left + 1) * 1000);
      }
      const perms = new Set(me.permissions || []);
      window.__tdmsPerms = perms;

      // 들어갈 수 없는 화면은 상단 메뉴에서 링크 자체를 지운다(2026-08-13 CM 확정 — 화면
      // 접속만 이렇게 하고, 화면 안 버튼·항목은 흐리게 표시하는 원칙을 그대로 따른다).
      const pagePerms = me.page_permissions || {};
      const pageOrder = me.page_order || [];
      document.querySelectorAll(".app-nav a").forEach((a) => {
        const href = (a.getAttribute("href") || "").split("?")[0].split("/").pop();
        const needed = pagePerms[href];
        if (needed && !perms.has(needed)) a.remove();
      });
      // [data-perm="리프키"]가 붙은 요소는 권한 없으면 흐리게 표시하고 조작만 막는다(승인/반려,
      // 폴더·자료 편집, zip업로드, 삭제보관함, 수정없이반납처리 등 화면마다 다른 버튼에 공통으로 쓴다).
      document.querySelectorAll("[data-perm]").forEach((el) => {
        if (!perms.has(el.dataset.perm)) applyPermDisabled(el);
      });
      // 예전 방식(admin-only-action)은 아직 role만으로 막아야 하는 극히 일부 요소만 남는다.
      if (me.role !== "ADMIN") {
        document.querySelectorAll(".admin-only-action").forEach((el) => applyPermDisabled(el));
      }
      // 권한 없는 화면에 주소를 직접 쳐서 들어온 경우(서버가 이미 막지만, 화면이 먼저 그려지는
      // 경우를 대비) 들어갈 수 있는 첫 화면으로 보낸다. 들어갈 수 있는 화면이 하나도 없으면
      // "/"로 보내 서버가 안내 화면을 보여주게 한다.
      const currentPage = window.location.pathname.split("/").pop() || "index.html";
      const requiredForPage = pagePerms[currentPage] || document.body.dataset.requirePermission;
      if (requiredForPage && !perms.has(requiredForPage)) {
        const target = pageOrder.find((page) => perms.has(pagePerms[page]));
        window.location.href = target || "/";
        return;
      }
      document.dispatchEvent(new CustomEvent("tdms:auth", { detail: me }));
      resolveTdmsReady(me);

      const slot = document.getElementById("user-slot");
      if (!slot) return;
      // [도움말]은 화면마다 HTML을 고치지 않아도 모든 화면에 똑같이 나오도록 여기서 붙인다
      // (상단 알림 버튼과 같은 방식). 로그아웃과 같은 .small 버튼이라 모양이 저절로 맞는다.
      // 2026-09-07 CM 지시로 지금은 SHOW_HELP_BUTTON이 꺼져 있어 버튼만 안 나온다.
      slot.innerHTML = `
        ${SHOW_HELP_BUTTON ? '<button id="help-btn" class="small" type="button">도움말</button>' : ""}
        <a href="#" id="mypage-link"></a>
        <button id="logout-btn" class="small" type="button">로그아웃</button>
      `;
      // 이름은 글자 그대로 넣는다(HTML로 해석되지 않게) — ui.js가 아직 안 읽혔어도 되도록 escapeHtml을 쓰지 않는다
      document.getElementById("mypage-link").textContent = me.name;
      // 상단 알림 버튼([최근수정본]·[반출])은 화면마다 HTML을 고치지 않아도 모든 화면에
      // 똑같이 나오도록 여기서 붙인다(ui.js 공용 함수). 건수를 못 불러와도 화면 나머지는
      // 그대로 동작해야 하므로 실패는 조용히 넘긴다.
      if (typeof loadNoticeButtons === "function") {
        loadNoticeButtons(slot).catch(() => {});
      }
      // 상단 [보관] 버튼은 favorites.js가 스스로 붙인다 — 이 파일은 <head>에서 읽히고
      // favorites.js는 <body> 끝에서 읽혀, 여기서 부르면 아직 없을 수 있기 때문이다.
      document.getElementById("mypage-link").addEventListener("click", (e) => {
        e.preventDefault();
        openMypageModal();
      });
      // 이 두 버튼도 화면을 떠나므로, 미리보기에 저장 안 한 표시가 있으면 먼저 물어본다
      // (ui.js가 없는 화면도 있을 수 있어 있을 때만 부른다 — 위 loadNoticeButtons와 같은 방식).
      const canLeave = async () =>
        typeof confirmLeaveWithMarkup !== "function" || (await confirmLeaveWithMarkup());
      const helpBtn = document.getElementById("help-btn");
      if (helpBtn) {
        helpBtn.addEventListener("click", async () => {
          if (!(await canLeave())) return;
          window.location.href = "help.html";
        });
      }
      document.getElementById("logout-btn").addEventListener("click", async () => {
        if (!(await canLeave())) return;
        await fetch("/auth/logout", { method: "POST" });
        window.location.href = "login.html";
      });
    });
})();
