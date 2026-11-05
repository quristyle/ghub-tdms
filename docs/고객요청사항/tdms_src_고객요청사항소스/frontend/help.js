// 도움말 화면.
//  - 왼쪽 목차는 본문 <section>을 읽어 자동으로 만든다(본문에 절을 추가하면 목차도 따라온다).
//  - 검색은 서버에 묻지 않고 화면 안에서만 거른다(도움말 내용이 전부 이 페이지 안에 있으므로).
//  - [인쇄 · PDF로 저장]은 브라우저 인쇄창을 연다. 인쇄용 모양은 help.css의 @media print에 있다.

const helpState = {
  sections: [],   // [{ el, id, title, blocks: [{ el, originalHtml }] }]
  query: "",
};

// ---- 목차 만들기 ----------------------------------------------------------
function buildHelpToc() {
  const list = document.getElementById("help-toc-list");
  helpState.sections = [...document.querySelectorAll(".help-section")].map((section) => ({
    el: section,
    id: section.id,
    title: section.dataset.title || section.querySelector("h2").textContent,
    blocks: [...section.querySelectorAll(".help-block")].map((block) => ({
      el: block,
      originalHtml: block.innerHTML,
    })),
  }));

  list.innerHTML = helpState.sections
    .map((s) => `<a href="#${s.id}" data-toc="${s.id}">${escapeHtml(s.title)}</a>`)
    .join("");
}

// ---- 지금 보고 있는 절을 목차에 표시 --------------------------------------
function highlightCurrentSection() {
  const line = 140; // 화면 위에서 이만큼 내려온 지점에 걸친 절을 "지금 보는 절"로 본다
  const visible = helpState.sections.filter((s) => !s.el.classList.contains("hidden"));
  if (!visible.length) return;

  let currentId = visible[0].id;
  visible.forEach((s) => {
    if (s.el.getBoundingClientRect().top <= line) currentId = s.id;
  });

  // 맨 아래까지 내려왔을 때는 마지막 절을 표시한다 — 마지막 절은 짧으면 위 기준선까지
  // 올라오지 못해서, 그냥 두면 그 앞 절이 계속 선택된 것처럼 보인다.
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  if (atBottom) currentId = visible[visible.length - 1].id;

  document.querySelectorAll("#help-toc-list a").forEach((a) => {
    a.classList.toggle("active", a.dataset.toc === currentId);
  });
}

// ---- 검색 ----------------------------------------------------------------
// 태그를 건드리지 않도록 글자 노드만 훑어서 찾은 부분을 감싼다.
function highlightInBlock(blockEl, query) {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.toLowerCase().includes(query)) targets.push(walker.currentNode);
  }

  targets.forEach((node) => {
    const parts = node.nodeValue.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
    const fragment = document.createDocumentFragment();
    parts.forEach((part) => {
      if (part.toLowerCase() === query) {
        const mark = document.createElement("span");
        mark.className = "help-hit";
        mark.textContent = part;
        fragment.appendChild(mark);
      } else if (part) {
        fragment.appendChild(document.createTextNode(part));
      }
    });
    node.parentNode.replaceChild(fragment, node);
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyHelpSearch(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  helpState.query = query;
  const resultBox = document.getElementById("help-search-result");

  // 항상 원래 내용으로 되돌린 뒤 다시 칠한다(이전 검색의 표시가 남지 않도록).
  helpState.sections.forEach((s) => {
    s.blocks.forEach((b) => {
      b.el.innerHTML = b.originalHtml;
      b.el.classList.remove("hidden");
    });
    s.el.classList.remove("hidden");
  });

  if (!query) {
    resultBox.textContent = "";
    document.querySelectorAll("#help-toc-list a").forEach((a) => a.classList.remove("hidden"));
    removeEmptyMessage();
    highlightCurrentSection();
    return;
  }

  let hitBlocks = 0;
  let hitSections = 0;

  helpState.sections.forEach((s) => {
    const titleHit = s.title.toLowerCase().includes(query);
    let sectionHasHit = false;

    s.blocks.forEach((b) => {
      const hit = b.el.textContent.toLowerCase().includes(query);
      if (hit) {
        hitBlocks += 1;
        sectionHasHit = true;
        highlightInBlock(b.el, query);
      } else {
        b.el.classList.add("hidden");
      }
    });

    const show = sectionHasHit || titleHit;
    s.el.classList.toggle("hidden", !show);
    if (show) hitSections += 1;

    const tocLink = document.querySelector(`#help-toc-list a[data-toc="${s.id}"]`);
    if (tocLink) tocLink.classList.toggle("hidden", !show);
  });

  if (hitSections === 0) {
    resultBox.textContent = "찾는 내용이 없습니다";
    showEmptyMessage(rawQuery.trim());
  } else {
    resultBox.textContent = `${hitSections}개 항목 · ${hitBlocks}곳에서 찾았습니다`;
    removeEmptyMessage();
  }
  highlightCurrentSection();
}

function showEmptyMessage(query) {
  removeEmptyMessage();
  const box = document.createElement("div");
  box.className = "help-empty";
  box.id = "help-empty";
  box.textContent = `"${query}"에 해당하는 내용이 없습니다. 다른 말로 찾아보거나, 검색을 지우고 목차에서 찾아보세요.`;
  document.getElementById("help-body").prepend(box);
}

function removeEmptyMessage() {
  const box = document.getElementById("help-empty");
  if (box) box.remove();
}

// ---- 시작 ----------------------------------------------------------------
function initHelp() {
  buildHelpToc();

  const search = document.getElementById("help-search");
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => applyHelpSearch(search.value), 150);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyHelpSearch(search.value);
    if (e.key === "Escape") {
      search.value = "";
      applyHelpSearch("");
    }
  });

  document.getElementById("help-search-reset").addEventListener("click", () => {
    search.value = "";
    applyHelpSearch("");
    search.focus();
  });

  document.getElementById("help-print-btn").addEventListener("click", () => {
    // 검색으로 일부만 보이는 상태에서 인쇄하면 그 부분만 나오므로 전체를 되돌린 뒤 연다.
    if (helpState.query) {
      document.getElementById("help-search").value = "";
      applyHelpSearch("");
    }
    window.print();
  });

  document.getElementById("help-toc-list").addEventListener("click", (e) => {
    const link = e.target.closest("a[data-toc]");
    if (!link) return;
    e.preventDefault();
    const section = document.getElementById(link.dataset.toc);
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  window.addEventListener("scroll", highlightCurrentSection, { passive: true });
  highlightCurrentSection();
}

initHelp();
