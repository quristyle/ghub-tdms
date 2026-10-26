#!/usr/bin/env bash
# 미리보기(자료 상세 > 미리보기 탭)가 비어 보일 때 어디서 끊겼는지 찾는 읽기 전용 점검.
# 운영서버에서 돌린다. DB·디스크를 고치지 않는다.
#
#   사용법:  deploy/진단-미리보기.sh <문서번호>
#   예:      deploy/진단-미리보기.sh 2004
#
# 미리보기는 이 차례로 간다. 끊길 수 있는 자리가 넷이고, 아래 1~4가 그 넷이다.
#
#   브라우저  /documents/2004  (Vue)
#     └ iframe  /pdfjs/web/viewer.html?file=/api/files/<fileId>/view      ← 2·3
#         └ fetch  /api/files/<fileId>/view
#             └ api: 권한 확인 → X-Accel-Redirect: /_blob/ab/cd/<sha256>  ← 1
#                 └ nginx: alias /srv/tdms/blobs/ 에서 직송                ← 4
set -u

DOC_ID="${1:-}"
if [[ -z "$DOC_ID" ]]; then
  echo "사용법: $0 <문서번호>   (예: $0 2004)" >&2
  exit 2
fi

BLOB_ROOT="${BLOB_ROOT:-/srv/tdms/blobs}"
WEB_ORIGIN="${WEB_ORIGIN:-http://127.0.0.1:5570}"   # 웹 컨테이너가 열어 둔 자리
PSQL="${PSQL:-psql}"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31m문제\033[0m %s\n' "$1"; }
info() { printf '       %s\n' "$1"; }

echo "문서 $DOC_ID 미리보기 점검"
echo

# ── 1. DB: 그 문서의 현재 PDF 와 블롭 ────────────────────────────────────────
echo "[1] DB — 현재 Rev 의 PDF 가 있는지, 블롭이 등록돼 있는지"
ROW=$($PSQL -At -F'|' -c "
  SELECT fl.id, encode(fl.blob_sha256,'hex'), b.byte_size, fl.display_name
    FROM files fl
    LEFT JOIN blobs b ON b.sha256 = fl.blob_sha256
   WHERE fl.document_id = $DOC_ID
     AND lower(fl.file_ext) = 'pdf'
   ORDER BY fl.is_current DESC NULLS LAST, fl.id DESC
   LIMIT 1;" 2>&1)

if [[ $? -ne 0 ]]; then
  bad "DB에 물어보지 못했다: $ROW"
  info "PGHOST·PGUSER·PGPASSWORD·PGDATABASE 를 넣고 다시 돌릴 것"
  exit 1
fi
if [[ -z "$ROW" ]]; then
  bad "이 문서에 PDF 파일 줄이 없다 → 미리보기 탭은 원래 비어 있는 게 맞다"
  info "원본(DWG·오피스)만 있는 자료라면 변환이 안 끝난 것일 수 있다(worker 확인)"
  exit 0
fi

FILE_ID="${ROW%%|*}";  REST="${ROW#*|}"
SHA="${REST%%|*}";     REST="${REST#*|}"
SIZE="${REST%%|*}";    NAME="${REST#*|}"
ok "files.id=$FILE_ID  이름=$NAME"

if [[ -z "$SHA" || -z "$SIZE" ]]; then
  bad "blobs 에 그 sha256 줄이 없다 → /api/files/$FILE_ID/view 가 404 를 낸다"
  info "파일 적재(이관)가 덜 끝난 자료다"
  exit 0
fi
ok "blobs 등록됨  sha256=${SHA:0:16}…  크기=$SIZE"

# ── 2. 디스크: 실제 블롭 파일 ────────────────────────────────────────────────
echo
echo "[2] 디스크 — 블롭 파일이 실제로 있는지 (nginx 가 여기서 직송한다)"
BLOB_PATH="$BLOB_ROOT/${SHA:0:2}/${SHA:2:2}/$SHA"
info "경로: $BLOB_PATH"
if [[ -f "$BLOB_PATH" ]]; then
  ACTUAL=$(stat -c%s "$BLOB_PATH")
  if [[ "$ACTUAL" == "$SIZE" ]]; then
    ok "파일 있음, 크기도 DB와 같다"
  else
    bad "파일은 있는데 크기가 다르다 (DB $SIZE / 디스크 $ACTUAL) — 복사가 덜 됐다"
  fi
else
  bad "그 자리에 파일이 없다 → nginx 가 404 를 내고 뷰어가 빈 채로 남는다"
  info "BLOB_ROOT 가 맞는지 확인: 지금 보는 곳은 $BLOB_ROOT"
  info "컨테이너에도 같은 자리가 물려 있어야 한다 — docker-compose.yml 의"
  info "  web: /srv/tdms/blobs:/srv/tdms/blobs:ro  와 nginx 의 alias 가 같은 곳을 봐야 한다"
fi

# ── 3. 뷰어 자체 ────────────────────────────────────────────────────────────
echo
echo "[3] 뷰어 — /pdfjs/web/viewer.html 이 내려오는지, iframe 에 들어갈 수 있는지"
HDRS=$(curl -sS -o /dev/null -D- "$WEB_ORIGIN/pdfjs/web/viewer.html" 2>&1)
STATUS=$(sed -n '1s/.*\([0-9][0-9][0-9]\).*/\1/p' <<<"$HDRS")
if [[ "$STATUS" == "200" ]]; then
  ok "viewer.html 200"
else
  bad "viewer.html 응답이 $STATUS — 뷰어 자체가 안 내려온다"
  info "web 이미지에 packages/web/public/pdfjs 가 들어갔는지 확인"
fi
XFO=$(grep -i '^x-frame-options:' <<<"$HDRS" | tr -d '\r')
if [[ -n "$XFO" ]]; then
  bad "뷰어 응답에 $XFO 가 붙어 있다 → 브라우저가 iframe 표시를 거부한다(화면이 빈 채로 남는다)"
  info "DENY 는 같은 사이트 iframe 도 막는다. 이 자리만 SAMEORIGIN 이어야 한다"
  info "앞단(호스트) nginx 가 add_header 로 덧붙이고 있지 않은지도 함께 볼 것"
else
  ok "뷰어 응답에 X-Frame-Options 없음 (iframe 가능)"
fi

# ── 4. 파일 내려받는 길 ──────────────────────────────────────────────────────
echo
echo "[4] API — /api/files/$FILE_ID/view (로그인 쿠키 없이 부르므로 401 이 정상)"
VHDRS=$(curl -sS -o /dev/null -D- "$WEB_ORIGIN/api/files/$FILE_ID/view" 2>&1)
VSTATUS=$(sed -n '1s/.*\([0-9][0-9][0-9]\).*/\1/p' <<<"$VHDRS")
case "$VSTATUS" in
  401|403) ok "$VSTATUS — 경로가 살아 있다(인증만 없음)" ;;
  404)     bad "404 — 라우트나 파일을 못 찾는다. 위 [1] 결과와 함께 볼 것" ;;
  502|504) bad "$VSTATUS — api 컨테이너가 안 떠 있거나 응답이 없다" ;;
  *)       info "$VSTATUS" ;;
esac

echo
echo "쿠키를 넣어 실제 응답까지 보려면(브라우저 개발자도구에서 session 쿠키 복사):"
echo "  curl -sS -D- -o /dev/null -b 'tdms_session=<값>' $WEB_ORIGIN/api/files/$FILE_ID/view"
echo "  → 200 + Content-Type: application/pdf 이면 서버는 정상이고 화면 쪽 문제다"
