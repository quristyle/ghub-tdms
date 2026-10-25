// 도면관리시스템이 덧붙인 "색상 고르기" 칸 — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
// 형광펜·그리기(펜)·텍스트·도형 네 도구가 전부 이 칸을 써서 같은 모양·같은 동작이 되게 한다.
// 한쪽만 고쳐져 도구마다 다르게 움직이는 일이 없도록, 칸을 만드는 코드는 이 파일 한 곳에만 둔다.
//
// 칸은 세 줄이다(CM이 정한 구성).
//   색상 선택  : 시스템이 정해둔 5가지. 도구마다 다르고 바뀌지 않는다.
//   최근 사용  : 사용자가 직접 고른 색을 최신순으로 기억한다. 브라우저에 저장되고 네 도구가 함께 쓴다.
//   사용자 지정: 지금 색 동그라미(누르면 색을 찍어 고르는 창) + 색상코드 입력칸 + [적용]

const STORE_KEY = "dms.pdfviewer.recentColors";
const RECENT_MAX = 5; // 고정 5색과 같은 줄 길이로 맞췄다 (2026-09-02 CM 지시)

// 도구별로 미리 정해둔 5색 (CM이 바꾸라고 하기 전에는 이 값이 고정이다)
export const PRESET_COLORS = {
  // 형광펜 — 글자가 비쳐 보이도록 연한 색
  // (노랑은 2026-09-04 CM 지시로 #fff066에서 조금 더 진하게 바꿨다)
  highlight: ["#ffe03d", "#a5f3a0", "#a5e8ff", "#ffbde0", "#ff8f8f"],
  // 펜·도형 선·글자 — 도면 위에서 눈에 띄는 진한 색
  pen: ["#e02020", "#1a5cd8", "#0f9d58", "#f2a900", "#000000"],
  // 도형 채우기 — 도면이 비쳐 보이도록 연한 색
  fill: ["#fff066", "#a5f3a0", "#a5e8ff", "#ffbde0", "#ff8f8f"],
};

let recentColors = loadRecent();
const openFields = new Set(); // 지금 화면에 있는 색상 칸들 — 최근 사용 줄을 다 같이 다시 그린다

function loadRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(saved) ? saved.filter(isHex).slice(0, RECENT_MAX) : [];
  } catch {
    return []; // 저장된 값이 깨졌거나 브라우저가 저장을 막아도 그냥 빈 목록으로 시작한다
  }
}

function saveRecent() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(recentColors));
  } catch {
    /* 저장이 막혀 있어도 이번 화면에서는 그대로 쓸 수 있으므로 넘어간다 */
  }
}

function isHex(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

// "4f46e5", "#4F46E5", "#f00" 을 전부 "#4f46e5" 모양으로 맞춘다. 못 알아보면 null.
export function normalizeHex(text) {
  let value = String(text || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    value = value.split("").map((c) => c + c).join("");
  }
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null;
}

function rememberColor(hex) {
  const color = normalizeHex(hex);
  if (!color) return;
  recentColors = [color, ...recentColors.filter((c) => c !== color)].slice(0, RECENT_MAX);
  saveRecent();
  for (const field of openFields) field.redrawRecent();
}

// ---------------------------------------------------------------------------

function swatchButton(color, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dmsSwatch";
  button.tabIndex = 0;
  button.title = title || color;
  button.dataset.color = color || "";
  const dot = document.createElement("span");
  dot.className = "swatch";
  if (color) dot.style.backgroundColor = color;
  else dot.classList.add("none"); // "없음"은 대각선이 그어진 빈 동그라미
  button.append(dot);
  return button;
}

/**
 * 색상 고르기 칸을 하나 만들어 돌려준다.
 *   label     : 맨 윗줄 문구 (기본 "색상 선택")
 *   colors    : 고정 5색 (PRESET_COLORS 참고)
 *   value     : 처음 색 (null이면 "없음")
 *   allowNone : true면 고정색 앞에 "없음"을 둔다 (도형 채우기용)
 *   onChange  : 색이 바뀔 때마다 부른다. 인자는 "#rrggbb" 또는 null
 * 돌려주는 것: { element, setValue }
 */
export function createColorField({ label = "색상 선택", colors, value = null, allowNone = false, onChange }) {
  const root = document.createElement("div");
  root.className = "colorPicker dmsColorField";
  root.innerHTML = `
    <span class="editorParamsLabel dmsColorTitle">${label}</span>
    <div class="dmsSwatchRow dmsPresetRow"></div>
    <span class="editorParamsLabel dmsColorTitle">최근 사용</span>
    <div class="dmsSwatchRow dmsRecentRow"></div>
    <span class="editorParamsLabel dmsColorTitle">사용자 지정</span>
    <div class="dmsCustomRow">
      <button type="button" class="dmsSwatch dmsCurrentSwatch" title="색을 찍어서 고르기"><span class="swatch"></span></button>
      <input type="text" class="dmsHexInput" spellcheck="false" maxlength="7" aria-label="색상코드" />
      <button type="button" class="dmsApplyButton">적용</button>
      <input type="color" class="dmsHiddenPicker" tabindex="-1" aria-hidden="true" />
    </div>`;

  const presetRow = root.querySelector(".dmsPresetRow");
  const recentRow = root.querySelector(".dmsRecentRow");
  const currentSwatch = root.querySelector(".dmsCurrentSwatch");
  const hexInput = root.querySelector(".dmsHexInput");
  const applyButton = root.querySelector(".dmsApplyButton");
  const hiddenPicker = root.querySelector(".dmsHiddenPicker");

  let current = value;

  function markChosen() {
    for (const button of root.querySelectorAll(".dmsSwatchRow .dmsSwatch")) {
      const same = (button.dataset.color || null) === (current || null);
      button.setAttribute("aria-selected", String(same));
    }
    currentSwatch.querySelector(".swatch").style.backgroundColor = current || "transparent";
    currentSwatch.querySelector(".swatch").classList.toggle("none", !current);
    hexInput.value = current || "";
    if (current) hiddenPicker.value = current;
  }

  // 색을 정한다. remember=true면 "최근 사용"에도 남긴다(고정 5색은 남기지 않는다 — CM 설명대로
  // "사용자가 임의로 선택한 컬러"만 쌓이는 자리다).
  function pick(color, { remember = false } = {}) {
    current = color || null;
    if (remember && current) rememberColor(current);
    markChosen();
    onChange?.(current);
  }

  if (allowNone) presetRow.append(swatchButton(null, "채우기 없음"));
  for (const color of colors) presetRow.append(swatchButton(color));

  presetRow.addEventListener("click", (e) => {
    const button = e.target.closest(".dmsSwatch");
    if (button) pick(button.dataset.color || null);
  });
  recentRow.addEventListener("click", (e) => {
    const button = e.target.closest(".dmsSwatch");
    if (button) pick(button.dataset.color, { remember: true });
  });

  // 지금 색 동그라미를 누르면 브라우저의 색 고르는 창이 열린다(마우스로 찍어서 고르는 그 창).
  // 그 창에서 마우스를 움직일 때마다가 아니라 **[확인]을 눌렀을 때 한 번만** 색을 정한다
  // (2026-09-02 CM 지시). 예전에는 지나가는 색이 전부 "최근 사용"에 쌓여 목록이 비슷한
  // 색으로 가득 참다. change는 창을 닫을 때(취소하면 원래 값으로) 한 번만 불린다.
  currentSwatch.addEventListener("click", () => hiddenPicker.click());
  hiddenPicker.addEventListener("change", () => pick(hiddenPicker.value, { remember: true }));

  function applyTyped() {
    const color = normalizeHex(hexInput.value);
    if (color) pick(color, { remember: true });
    else {
      hexInput.value = current || "";
      hexInput.focus();
    }
  }
  applyButton.addEventListener("click", applyTyped);
  hexInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    applyTyped();
  });

  const field = {
    element: root,
    setValue(color) {
      current = normalizeHex(color);
      markChosen();
    },
    redrawRecent() {
      recentRow.textContent = "";
      if (recentColors.length === 0) {
        const empty = document.createElement("span");
        empty.className = "dmsRecentEmpty";
        empty.textContent = "고른 색이 여기 쌓입니다";
        recentRow.append(empty);
      } else {
        for (const color of recentColors) recentRow.append(swatchButton(color));
      }
      markChosen();
    },
  };
  openFields.add(field);
  field.redrawRecent();
  markChosen();
  return field;
}
