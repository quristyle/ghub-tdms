# PDF.js (이식분)

기존 시스템 `frontend/assets/pdfjs/` 를 그대로 옮긴 것.
**재작성이 아니라 이식**이다 — 인수인계 문서의 "8,400줄 포크" 기술은 사실이 아니었다
(docs/00-시스템개요.md 7절 참조).

| 대상 | 상태 |
|---|---|
| `web/viewer.mjs` | **원본 그대로** (0줄 수정) |
| `build/pdf.mjs` | **원본 그대로** |
| `build/pdf.worker.mjs` | 2곳 수정 — `[DMS 수정]` 하이라이트 주석 blend mode |
| `web/viewer.html` | 1줄 추가 — `<script src="dms-viewer.js" type="module">` |
| `web/dms-*.js` (17개) | 전부 자체 작성 모듈. PDF.js 내부를 건드리지 않는다 |

PDF.js 버전: **6.3.289**

## 이식 과정에서 고친 것

API 경로에 `/api` 접두어를 붙였다. 그 외에는 한 줄도 고치지 않았다.

| 파일 | 변경 |
|---|---|
| `dms-favorite.js:235` | `/favorites/resolve/target` → `/api/favorites/resolve/target` |
| `dms-favorite.js:347` | `/favorites/{id}/markup` → `/api/favorites/{id}/markup` |

## 호스트(Vue) 가 제공해야 하는 것

뷰어는 iframe 안에서 돌고, 바깥 창에 아래가 있어야 "우리 앱 안"이라고 판단한다
(`dms-viewer.js` 의 `outerAppWindow()`).

| 이름 | 쓰임 |
|---|---|
| `window.showAlert(message)` | **필수** — 이 함수가 있어야 뷰어가 호스트를 인식한다 |
| `window.openFavoriteSaveDialog(...)` | 있으면 [보관하기] 버튼이 켜진다 |

뷰어가 바깥으로 보내는 것:

| 방향 | 내용 |
|---|---|
| `postMessage({type:'dms-preview-switch', to})` | 원본/사본 전환 요청 |
| `iframe.contentWindow.dmsMarkup.collect()` | 호스트가 마크업을 거둬 간다 |
| `iframe.contentWindow.dmsMarkup.hasChanges()` | 떠날 때 저장 여부를 묻는 데 쓴다 |

## 주소 파라미터

```
viewer.html?file=<PDF 주소(encodeURIComponent)>&fav=<보관 번호>
```

`fav` 가 있으면 자료를 연 뒤 보관해 둔 마크업을 되살린다.

## 업스트림 갱신 절차

1. PDF.js 새 버전을 받아 `build/`, `web/` 중 `dms-*` 를 뺀 전부를 덮어쓴다
2. `build/pdf.worker.mjs` 의 `[DMS 수정]` 2곳을 다시 적용한다 (`grep -n "DMS 수정"`)
3. `web/viewer.html` 에 `<script src="dms-viewer.js" type="module">` 한 줄을 다시 넣는다
4. 마크업(도형·스탬프·회전·복사)을 손으로 한 번 확인한다
