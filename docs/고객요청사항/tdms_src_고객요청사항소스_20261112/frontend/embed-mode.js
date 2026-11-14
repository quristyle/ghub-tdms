// 사용자 관리 화면의 팝업(iframe) 안에서 열렸을 때는 헤더·네비를 감춘다(?embed=1).
// <head>에서 곧바로 읽혀 화면이 그려지기 전에 적용된다. 예전엔 groups.html 안에 스크립트를 직접
// 적어 두었는데, 보안 머리글(Content-Security-Policy)이 페이지 안에 직접 적힌 스크립트를 실행하지
// 않게 막아 파일로 뺐다(2026-09-17 시큐어코딩).
if (new URLSearchParams(window.location.search).get("embed") === "1") {
  document.documentElement.classList.add("embedded");
}
