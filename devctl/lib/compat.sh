#!/usr/bin/env bash
# Windows(Git Bash) 호환 계층.
#
# 이 파일은 **맨 마지막에** 읽힌다. 앞의 라이브러리가 정의한 함수를 덮어쓰는 것이
# 일이기 때문이다. 리눅스에서는 아래 가드에서 바로 빠져나가므로 아무것도 바뀌지
# 않는다 — 운영·리눅스 개발의 동작은 그대로다.
#
# Git Bash 에 **없는** 것들을 Windows 기본 도구로 바꾼다:
#
#   setsid      → 그냥 백그라운드로 띄운다 (Windows 에 쓸 프로세스 그룹이 없다)
#   ss          → netstat -ano
#   pgrep/kill  → tasklist / taskkill //T  (자식까지 한 번에)
#   ps -o etime → 띄울 때 시각을 적어 두고 뺀다
#   sshfs       → SSHFS-Win 의 sshfs.exe 를 PATH 맞춰 직접 띄운다
#   .venv/bin   → .venv/Scripts
#
# PID 규칙 — Windows 에서는 적어 두고 견주는 번호를 **전부 WINPID** 로 맞춘다.
# msys 가 매기는 번호와 Windows 가 매기는 번호가 다른데 netstat·taskkill 이
# 아는 것은 후자뿐이라, 둘을 섞으면 엉뚱한 프로세스를 죽인다.

case "${OSTYPE:-}" in
  msys*|cygwin*|win32) IS_WINDOWS=1 ;;
  *)                   IS_WINDOWS=0 ;;
esac
export IS_WINDOWS
[[ "$IS_WINDOWS" == 1 ]] || return 0

# 도움말·안내문에 보여 줄 실행 이름. cmd 에서는 `./dev.sh` 가 돌지 않는다.
SELF="dev.bat"

# Git Bash 는 로캘이 비어 있다. 그러면 ${#s} 가 글자가 아니라 **바이트**를 세어
# common.sh 의 disp_width 가 한글 한 자를 6칸으로 읽고, 상태표가 통째로 어긋난다.
#
# C.UTF-8 로 둔다. 다른 UTF-8 로캘(en_US·ko_KR)은 [가-힣] 같은 범위를 collation
# 순서로 풀어서 ASCII 괄호까지 한글로 세므로 또 틀린다 — C 는 코드포인트 순서다.
# 메시지 언어까지 건드리지 않도록 LC_ALL 이 아니라 LC_CTYPE 만 둔다.
export LC_CTYPE="${LC_CTYPE:-C.UTF-8}"

# ── Windows 기본 도구 ─────────────────────────────────────────────────────
# `//FI` 는 MSYS 가 `/FI` 로 바꿔 넘긴다 — `/FI` 라고 쓰면 경로로 오해한다.

win_alive() {
  [[ -n "${1:-}" ]] || return 1
  tasklist //FI "PID eq $1" //NH //FO CSV 2>/dev/null | grep -q "\"$1\""
}

# msys 번호 → Windows 번호. 띄운 직후에는 아직 안 보일 수 있어 잠깐 기다린다.
win_pid_of() {
  local mpid="$1" w i
  for (( i = 0; i < 20; i++ )); do
    w="$(ps 2>/dev/null | awk -v p="$mpid" '$1==p {print $4; exit}')"
    [[ -n "$w" ]] && { printf '%s' "$w"; return 0; }
    sleep 0.1
  done
  return 1
}

# 쓸 수 있는 파이썬. Microsoft Store 자리끼(실행하면 Store 가 열리는 껍데기)는
# 실제로 돌려 보고 걸러낸다.
win_python() {
  local c
  for c in py python python3; do
    command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c 'import sys' >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}

VENV_BIN="Scripts"
VENV_PY="$ROOT/packages/worker/.venv/Scripts/python.exe"

# ── 포트·프로세스 ─────────────────────────────────────────────────────────

port_pid() {
  local port="${1:-}"
  [[ -n "$port" ]] || return 0
  netstat -ano 2>/dev/null | awk -v port="$port" '
    $1=="TCP" && $4=="LISTENING" {
      n = split($2, a, ":")
      if (a[n] == port) { print $5; exit }
    }'
}

# taskkill //T 가 자식까지 맡는다 — 직접 훑을 일이 없다.
kill_tree() {
  local pid="${1:-}" sig="${2:-TERM}"
  [[ -n "$pid" ]] || return 0
  if [[ "$sig" == "KILL" ]]; then
    taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
  else
    taskkill //PID "$pid" //T >/dev/null 2>&1 || true
  fi
}

# Windows 에는 쓸 프로세스 그룹이 없다. kill_group 을 실패로 두면 부르는 쪽이
# 알아서 kill_tree 로 넘어간다 — services.sh 가 `||` 로 받아 둔 그대로다.
kill_group()  { return 1; }
group_alive() { return 1; }
pgid_of()     { printf ''; }

wait_gone() {
  local pid="$1" limit="${2:-10}" i=0
  while win_alive "$pid"; do
    (( i++ )); (( i > limit * 10 )) && return 1
    sleep 0.1
  done
  return 0
}

# ps -o etime 은 WINPID 를 모른다. 띄울 때 적어 둔 시각에서 뺀다.
# 제어판 밖에서 띄운 것은 적어 둔 적이 없으니 '-' 다.
started_file() { printf '%s/started-%s.pid' "$RUN_DIR" "${1:-none}"; }

human_etime() {
  local f t d
  f="$(started_file "${1:-}")"
  [[ -f "$f" ]] || { printf '%s' '-'; return 0; }
  t="$(cat "$f" 2>/dev/null)"
  [[ "$t" =~ ^[0-9]+$ ]] || { printf '%s' '-'; return 0; }
  d=$(( $(date +%s) - t ))
  printf '%02d:%02d:%02d' $(( d / 3600 )) $(( d % 3600 / 60 )) $(( d % 60 ))
}

# ── 서비스 ────────────────────────────────────────────────────────────────

# Vite 는 Windows 에서 **[::1] 에만** 붙는다 — 127.0.0.1 로는 닿지 않아 기동 확인이
# 영영 끝나지 않는다(화면은 떠 있는데 제어판은 "응답하지 않습니다" 라고 한다).
# localhost 로 물으면 curl 이 IPv6·IPv4 를 다 짚어 보므로 어느 쪽에 붙든 받는다.
svc_health() {
  case "$1" in
    api) echo "http://localhost:$(svc_port api)/health" ;;
    web) echo "http://localhost:$(svc_port web)/" ;;
    *)   echo "" ;;
  esac
}

svc_cmd() {
  case "$1" in
    api)    echo "pnpm --filter @tdms/api dev" ;;
    web)    echo "pnpm --filter @tdms/web dev" ;;
    # PYTHONUTF8 — 3.14 까지 Python 은 Windows 에서 표준출력을 로캘 코드페이지로
    # 쓴다. 그대로 두면 로그 파일이 CP949 가 되어 제어판의 [워커 로그] 가 깨진다.
    worker) echo "PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \"$VENV_PY\" -m tdms_worker --id 1" ;;
  esac
}

svc_available() {
  case "$1" in
    worker)
      [[ -f "$VENV_PY" ]] || return 1
      "$VENV_PY" -c 'import psycopg' >/dev/null 2>&1
      ;;
    *) return 0 ;;
  esac
}

svc_pid() {
  local name="$1" pf pid
  pf="$(svc_pidfile "$name")"
  if [[ -f "$pf" ]]; then
    pid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && win_alive "$pid"; then printf '%s' "$pid"; return 0; fi
    rm -f "$pf"
    [[ -n "$pid" ]] && rm -f "$(started_file "$pid")"
  fi
  local port; port="$(svc_port "$name")"
  [[ -n "$port" ]] && port_pid "$port"
}

# 워커는 **운영 DB + 로컬 저장소** 조합에서 띄우면 안 된다.
#
# 큐는 DB 에 있다. 개발 장비가 운영 DB 를 보는 채로 워커를 띄우면 운영 사용자가
# 넣은 작업을 이 장비가 집어다 처리하고, 결과(미리보기·Zip·백업)를 운영이 아니라
# 여기 .storage 에 쓴다. DB 에는 "되었다" 고 적히는데 파일은 운영에 없으니,
# 운영 화면에서 미리보기만 비는 고장이 난다. 되돌리기도 번거롭다.
#
# Windows 는 저장소를 안 붙인 채로 쓰기 쉬워(sshfs 가 기본 도구가 아니다) 이 조합에
# 빠지기 쉽다 — 그래서 여기서 막는다. 붙이면(storage mount) 풀린다.
# api·web 은 요청을 받아 처리할 뿐이라 해당 없다.
worker_guard() {
  local prod_host="${PROD_SSH_HOST#*@}"
  [[ "${PGHOST:-}" == "$prod_host" ]] || return 0          # 운영 DB 가 아니면 상관없다
  [[ "${STORAGE_ROOT:-}" != "$PROD_MOUNT"* ]] || return 0  # 저장소까지 운영이면 괜찮다

  bad "워커를 띄우지 않았습니다 — 운영 DB 를 보는데 저장소는 이 장비입니다"
  info "띄우면 운영 사용자의 작업을 여기서 처리하고 결과 파일을 운영이 아닌"
  info "${STORAGE_ROOT:-(없음)} 에 씁니다. 운영 화면에서 미리보기가 비게 됩니다."
  printf '\n'
  info "운영 저장소를 붙이면 풀립니다:  $SELF storage mount"
  info "또는 .env 의 PGHOST 를 개발용 DB 로 돌린 뒤에 띄우세요."
  return 1
}

svc_start() {
  local name="$1"
  [[ "$name" == worker ]] && { worker_guard || return 1; }
  if ! svc_available "$name"; then
    warn "$(svc_label "$name") — 실행 환경이 없어 건너뜁니다"
    [[ "$name" == worker ]] && info "준비: dev.bat setup-worker"
    return 0
  fi
  if svc_running "$name"; then
    info "$(svc_label "$name") 는 이미 돌고 있습니다 (pid $(svc_pid "$name"))"
    return 0
  fi

  local port; port="$(svc_port "$name")"
  if [[ -n "$port" ]] && ! port_free "$port"; then
    bad "$(svc_label "$name") — 포트 $port 를 다른 프로세스가 쓰고 있습니다 (pid $(port_pid "$port"))"
    info "먼저 dev.bat stop 또는 taskkill /PID $(port_pid "$port") /T /F"
    return 1
  fi

  local log; log="$(svc_logfile "$name")"
  : > "$log"
  # setsid 가 없다. Git Bash 의 백그라운드 작업은 부모가 끝나도 살아남으므로
  # 이대로 두고, 대신 자식까지 한 번에 끝낼 수 있게 WINPID 를 적어 둔다.
  ( cd "$(svc_cwd "$name")" && exec bash -c "$(svc_cmd "$name")" ) >>"$log" 2>&1 &
  local mpid=$! wpid
  wpid="$(win_pid_of "$mpid")" || wpid=""
  if [[ -z "$wpid" ]]; then
    bad "$(svc_label "$name") — 프로세스 번호를 알아내지 못했습니다"
    kill "$mpid" 2>/dev/null || true
    tail -n 12 "$log" | sed 's/^/      /'
    return 1
  fi
  printf '%s' "$wpid" > "$(svc_pidfile "$name")"
  date +%s > "$(started_file "$wpid")"

  local health; health="$(svc_health "$name")"
  if [[ -n "$health" ]]; then
    printf '  %s·%s %s 기동 중' "$C_DIM" "$C_RESET" "$(svc_label "$name")"
    if wait_http "$health" 60; then
      # 뜬 것이 확인되면 **실제로 포트를 쥔** 프로세스를 pid 로 고쳐 적는다.
      #
      # MSYS 의 exec 는 Windows 프로세스를 갈아 끼우는 흉내라, 띄울 때 적어 둔
      # 껍데기 번호가 금세 헌 것이 된다. 그대로 두면 다음 번 status 에서 pid
      # 파일이 죽은 것으로 보여 지워지고, 제어판이 띄운 서비스인데도 "제어판
      # 밖에서 시작됨" 으로 나온다. 포트 주인은 안 바뀌므로 그쪽을 믿는다.
      local real; real="$(port_pid "$port")"
      if [[ -n "$real" && "$real" != "$wpid" ]]; then
        rm -f "$(started_file "$wpid")"
        printf '%s' "$real" > "$(svc_pidfile "$name")"
        date +%s > "$(started_file "$real")"
        wpid="$real"
      fi
      printf '\r'; ok "$(svc_label "$name") 올라왔습니다 — $health"
    else
      printf '\r'; bad "$(svc_label "$name") 가 응답하지 않습니다"
      info "로그: dev.bat logs $name"
      tail -n 12 "$log" | sed 's/^/      /'
      return 1
    fi
  else
    sleep 1
    if win_alive "$wpid"; then
      ok "$(svc_label "$name") 시작 (pid $wpid)"
    else
      bad "$(svc_label "$name") 가 바로 종료되었습니다"
      tail -n 12 "$log" | sed 's/^/      /'
      return 1
    fi
  fi
}

svc_stop() {
  local name="$1" pid; pid="$(svc_pid "$name")"
  if [[ -z "$pid" ]]; then
    info "$(svc_label "$name") 는 돌고 있지 않습니다"
    rm -f "$(svc_pidfile "$name")"
    return 0
  fi

  # //T 가 자식까지 데려간다 — tsx watch·vite 의 감시 프로세스가 자식이라,
  # 리눅스에서 프로세스 그룹째 끝내던 것과 같은 효과가 난다.
  #
  # //F 를 바로 쓴다. 곱게 끊는 쪽(//F 없는 taskkill)은 창에 WM_CLOSE 를 보내는
  # 것이라 창 없는 콘솔 프로그램인 node·python 은 거들떠보지 않는다. 그래서
  # 먼저 곱게 해 봐야 기다린 시간만 버리고 어차피 //F 로 넘어간다.
  kill_tree "$pid" KILL
  if wait_gone "$pid" 5; then
    ok "$(svc_label "$name") 중지 (pid $pid)"
  else
    bad "$(svc_label "$name") 를 끝내지 못했습니다 (pid $pid)"
  fi

  rm -f "$(svc_pidfile "$name")" "$(started_file "$pid")"

  # 포트를 아직 쥐고 있는 잔여 프로세스 정리
  local port; port="$(svc_port "$name")"
  if [[ -n "$port" ]]; then
    local leftover; leftover="$(port_pid "$port")"
    if [[ -n "$leftover" ]]; then
      kill_tree "$leftover" KILL; wait_gone "$leftover" 3
      info "포트 $port 를 쥐고 있던 잔여 프로세스 정리 (pid $leftover)"
    fi
  fi
}

# ── DB 묻기 ───────────────────────────────────────────────────────────────
#
# psql 은 Windows 개발 장비에 없는 쪽이 보통이다. 그것 하나 때문에 상태 화면의 DB
# 칸이 통째로 비어 DB 가 죽은 것처럼 보이므로, 앱이 이미 쓰는 pg 드라이버로 대신
# 묻는다(devctl/db-query.mjs). psql 이 있으면 그대로 psql 을 쓴다.

DB_VIA_NODE=0

psql_ready() {
  [[ -n "${PGHOST:-}" && -n "${PGDATABASE:-}" && -n "${PGUSER:-}" ]] || return 1
  if command -v psql >/dev/null 2>&1; then
    PSQL_ARGS=(-h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" -X -tA)
    DB_VIA_NODE=0
    return 0
  fi
  command -v node >/dev/null 2>&1 || return 1
  [[ -f "$DEVCTL/db-query.mjs" ]] || return 1
  [[ -e "$ROOT/packages/api/node_modules/pg" ]] || return 1   # pnpm install 전
  DB_VIA_NODE=1
  return 0
}

db_query() {
  psql_ready || return 1
  if (( DB_VIA_NODE )); then
    node "$DEVCTL/db-query.mjs" "$1"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql "${PSQL_ARGS[@]}" -c "$1" 2>/dev/null
  fi
}

# ── 점검 ──────────────────────────────────────────────────────────────────

check_tools() {
  head1 "도구"
  local v
  for t in node pnpm psql curl; do
    if command -v "$t" >/dev/null; then
      case "$t" in
        node) v="$(node -v)" ;;
        pnpm) v="v$(pnpm -v)" ;;
        psql) v="$(psql --version | awk '{print $3}')" ;;
        *)    v="" ;;
      esac
      ok "$(printf '%-6s %s' "$t" "$v")"
    else
      if [[ "$t" == psql ]]; then
        # Windows 에서는 없어도 된다 — db-query.mjs 가 pg 드라이버로 대신 묻는다.
        warn "$(printf '%-6s %s' "$t" '없음 — pg 드라이버로 대신 묻습니다')"
      else
        bad "$(printf '%-6s %s' "$t" '없음')"
      fi
    fi
  done

  local py
  if [[ -f "$VENV_PY" ]]; then
    ok "$(printf '%-6s %s' python "$("$VENV_PY" -V 2>&1 | awk '{print $2}') (워커 환경 있음)")"
  elif py="$(win_python)"; then
    warn "$(printf '%-6s %s' python "$("$py" -V 2>&1 | awk '{print $2}') — 워커 가상환경 없음")"
    info "준비: dev.bat setup-worker"
  else
    warn "$(printf '%-6s %s' python '없음 — 워커를 쓸 수 없습니다')"
    info "python.org 설치본을 쓰세요 — Store 자리끼는 venv 를 만들지 못합니다"
  fi
}

# NTFS 에는 POSIX 권한 비트가 없다 — stat -c %a 가 늘 777 을 돌려주므로 보지 않는다.
check_config() {
  head1 "설정"
  if [[ -f "$ROOT/.env" ]]; then
    ok ".env 있음"
    info ".env 권한은 Windows ACL 로 관리됩니다 (파일 속성 → 보안)"
  else
    bad ".env 가 없습니다 — copy .env.example .env 뒤 값을 채우세요"
    return 1
  fi

  if [[ -z "${SESSION_SECRET:-}" || ${#SESSION_SECRET} -lt 32 ]]; then
    bad "SESSION_SECRET 이 없거나 32자 미만입니다 (API 가 뜨지 않습니다)"
    info "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
  else
    ok "SESSION_SECRET 설정됨 (${#SESSION_SECRET}자)"
  fi

  [[ -d "$ROOT/node_modules" ]] && ok "의존성 설치됨" || { bad "의존성 미설치 — pnpm install"; return 1; }
  [[ -d "$ROOT/packages/web/public/pdfjs/web" ]] && ok "PDF 뷰어 이식분 있음" || warn "PDF 뷰어 파일이 없습니다"
}

# 프로세스 그룹이 없어 pgid 로 견주지 못한다. 우리가 띄운 기록(pid 파일)이 살아
# 있으면서 포트가 잡혀 있으면 그것이 우리 것이다 — 한 포트를 둘이 쥘 수는 없다.
check_ports() {
  head1 "포트"
  for name in api web; do
    local port pid
    port="$(svc_port "$name")"
    svc_pid "$name" >/dev/null      # 죽은 pid 파일을 먼저 털어낸다
    pid="$(port_pid "$port")"

    if [[ -z "$pid" ]]; then
      ok "$(printf '%-6s %s' "$port" '비어 있음')"
    elif svc_owned "$name"; then
      ok "$(printf '%-6s %s' "$port" "$(svc_label "$name") 사용 중 (pid $pid)")"
    else
      warn "$(printf '%-6s %s' "$port" "제어판 밖의 프로세스가 쓰고 있습니다 (pid $pid)")"
    fi
  done
}

# ── 워커 환경 ─────────────────────────────────────────────────────────────

action_setup_worker() {
  head1 "워커 환경 준비"
  local wdir="$ROOT/packages/worker" py
  if ! py="$(win_python)"; then
    bad "쓸 수 있는 python 이 없습니다"
    info "python.org 설치본을 쓰고 'Add python.exe to PATH' 를 켜세요"
    info "Microsoft Store 자리끼는 venv 를 만들지 못합니다"
    return 1
  fi
  ( cd "$wdir" \
    && "$py" -m venv .venv \
    && "./.venv/$VENV_BIN/python.exe" -m pip install -q --upgrade pip \
    && "./.venv/$VENV_BIN/python.exe" -m pip install -q -e . ) || return 1
  ok "준비됨 — dev.bat start worker"
}

# ── 저장소 ────────────────────────────────────────────────────────────────
#
# 리눅스는 sshfs 로 운영의 /srv/tdms 를 통째로 붙인다. Windows 에도 같은 것이 있다 —
# WinFsp(커널 파일시스템) 위에 올라가는 SSHFS-Win 이다. 붙이면 드라이브 한 글자
# (기본 Z:)가 운영의 /srv/tdms 가 되고, 그다음부터는 리눅스와 똑같이 돈다.
#
# **통째로** 붙인다. blobs 만 붙이면 안 된다 — 업로드는 tmp 에 받아 blobs 로
# rename 하는데(core/blob.ts), 둘이 다른 볼륨이면 rename 이 EXDEV 로 실패한다.
#
# 열쇠 — SSHFS-Win 은 %USERPROFILE%\.ssh\id_rsa 만 기본으로 본다. 다른 이름의
# 열쇠는 ssh config 에 별칭을 두어 알려 줘야 하고, 암호가 걸린 열쇠는 못 쓴다.
# 그 별칭은 storage mount 가 PROD_SSH_* 값에서 만들어 준다.
#
# ── `net use \\sshfs.kr\...` 를 쓰지 않는 까닭 ───────────────────────────
#
# 그 길은 WinFsp.Launcher 가 sshfs 를 대신 띄운다. 그런데 Launcher 는 서비스라
# **시스템 PATH** 를 물려주는데, 거기에 SSHFS-Win 의 bin 이 들어가지 않는다.
# 그러면 sshfs(Cygwin 프로그램)가 `ssh` 를 찾다가 Windows 기본 OpenSSH
# (C:\Windows\System32\OpenSSH\ssh.exe)를 집는다. 그 ssh 는 Cygwin 쪽과 파이프가
# 맞지 않아 곧바로 끊기고(`read: Connection reset by peer`), Launcher 는 2~3초 뒤
# 프로세스를 거두며 net use 는 "시스템 오류 67" 을 낸다. 등록은 멀쩡하므로
# 들여다봐도 까닭이 보이지 않는 고장이다.
#
# 시스템 PATH 를 고치면 net use 도 되지만 그건 관리자 권한이 필요하다. 개발 장비
# 하나 쓰자고 요구할 일이 아니므로, PATH 를 맞춰 sshfs 를 **우리가 직접** 띄운다.
# 이렇게 붙인 드라이브도 api·워커·탐색기에서 똑같이 보인다(확인함).

PROD_DRIVE="${TDMS_PROD_DRIVE:-Z:}"
PROD_MOUNT="$PROD_DRIVE"          # $PROD_MOUNT/blobs 가 Z:/blobs 가 되게 둔다
SSH_ALIAS="${TDMS_SSH_ALIAS:-tdms-prod}"

prod_mounted() { [[ -d "$PROD_MOUNT/blobs" ]]; }

sshfs_win_dir() {
  local p
  for p in "/c/Program Files/SSHFS-Win" "/c/Program Files (x86)/SSHFS-Win"; do
    [[ -x "$p/bin/sshfs.exe" ]] && { printf '%s' "$p/bin"; return 0; }
  done
  return 1
}

storage_tool_ready() { sshfs_win_dir >/dev/null 2>&1; }

storage_pidfile() { printf '%s/storage.pid' "$RUN_DIR"; }

# ssh config 에 적을 열쇠 경로.
#
# SSHFS-Win 은 제 ssh(Cygwin 쪽)를 들고 온다. 그 ssh 는 MSYS 의 `/c/...` 를 모르고,
# Git Bash 는 Cygwin 의 `/cygdrive/c/...` 를 모른다. 둘 다 아는 꼴은 두 가지다 —
# 집 안이면 `~/...`(각자 제 HOME 으로 푼다), 밖이면 `C:/...`(둘 다 받아 준다).
ssh_key_for_config() {
  local real; real="$(prod_key_path)" || return 1
  if [[ "$real" == "$HOME/"* ]]; then
    printf '~/%s' "${real#"$HOME"/}"
  else
    cygpath -m "$real" 2>/dev/null || printf '%s' "$real"
  fi
}

ssh_alias_ok() {
  local cfg="$HOME/.ssh/config"
  [[ -f "$cfg" ]] && grep -qiE "^[[:space:]]*Host([[:space:]]+[^[:space:]]+)*[[:space:]]+$SSH_ALIAS([[:space:]]|$)" "$cfg"
}

# ssh config 에 별칭을 더한다. 있는 줄은 건드리지 않고 뒤에 붙이기만 한다.
ssh_alias_write() {
  local cfg="$HOME/.ssh/config" key
  key="$(ssh_key_for_config || true)"
  mkdir -p "$HOME/.ssh"
  [[ -s "$cfg" ]] && printf '\n' >> "$cfg"
  {
    echo "# GHub TDMS 운영 저장소 — sshfs 가 열쇠를 찾는 자리."
    echo "# devctl 의 storage mount 가 만들었다. 지워도 되지만 그러면 다시 만든다."
    echo "Host $SSH_ALIAS"
    echo "    HostName ${PROD_SSH_HOST#*@}"
    echo "    Port $PROD_SSH_PORT"
    echo "    User ${PROD_SSH_HOST%@*}"
    [[ -n "$key" ]] && echo "    IdentityFile $key"
    echo "    IdentitiesOnly yes"
  } >> "$cfg"
  chmod 600 "$cfg" 2>/dev/null || true
}

storage_status() {
  head1 "blob 저장소"
  info "STORAGE_ROOT=${STORAGE_ROOT:-(없음)}"
  info "붙일 자리  $PROD_MOUNT   ←   $PROD_SSH_HOST:$PROD_REMOTE_DIR"
  printf '\n'

  if prod_mounted; then
    ok "운영 저장소에 붙어 있습니다"
    [[ "${STORAGE_ROOT:-}" == "$PROD_MOUNT"* ]] \
      || warn "그런데 STORAGE_ROOT 은 아직 ${STORAGE_ROOT:-(없음)} 입니다 — $PROD_DRIVE/ 로 바꾸세요"
    return 0
  fi

  warn "붙어 있지 않습니다"
  if storage_tool_ready; then
    info "붙이기: $SELF storage mount  (제어판에서는 [운영 저장소 붙이기])"
  else
    bad "붙일 도구(SSHFS-Win)가 없습니다 — 리눅스의 sshfs 에 해당합니다"
    info "관리자 PowerShell 에서 한 번만 깔면 됩니다:"
    info "  winget install -e --id WinFsp.WinFsp --source winget"
    info "  winget install -e --id SSHFS-Win.SSHFS-Win --source winget"
    info "--source winget 을 빼지 마세요 — msstore 원본이 막힌 망에서는 winget 이"
    info "원본을 못 정하고 멈춥니다 (0x8a15005e: 서버 인증서가 일치하지 않습니다)"
    info "깐 뒤 다시 시작하고 [운영 저장소 붙이기] 를 누르세요"
  fi
  if [[ -z "$PROD_SSH_KEY" ]]; then
    printf '\n'
    warn "PROD_SSH_KEY 가 비어 있습니다 — .env 에 운영 접속 열쇠 자리를 적어 두세요"
    info "  PROD_SSH_KEY=~/.ssh/<열쇠이름>   (암호가 걸리지 않은 열쇠여야 합니다)"
  fi
  return 0
}

storage_mount() {
  if prod_mounted; then ok "이미 붙어 있습니다 — $PROD_MOUNT"; return 0; fi

  # 1. 도구
  local bin
  if ! bin="$(sshfs_win_dir)"; then
    bad "SSHFS-Win 이 없습니다 (리눅스의 sshfs 에 해당합니다)"
    info "관리자 PowerShell 에서 한 번만 깔면 됩니다:"
    info "  winget install -e --id WinFsp.WinFsp --source winget"
    info "  winget install -e --id SSHFS-Win.SSHFS-Win --source winget"
    info "깐 뒤 한 번 다시 시작하세요 (WinFsp 는 커널 드라이버입니다)"
    return 1
  fi

  # 2. 열쇠 — .env 의 `~` 는 안 풀려 있으므로 prod_key_path 로 푼 뒤에 본다
  if [[ -n "$PROD_SSH_KEY" ]]; then
    local keyfile; keyfile="$(prod_key_path)"
    if [[ ! -f "$keyfile" ]]; then
      bad "PROD_SSH_KEY 가 가리키는 열쇠가 없습니다"
      info "적힌 값:   $PROD_SSH_KEY"
      info "찾아본 곳: $keyfile"
      return 1
    fi
    if grep -q "ENCRYPTED" "$keyfile" 2>/dev/null; then
      bad "암호가 걸린 열쇠는 쓰지 못합니다 — $keyfile"
      info "sshfs 는 암호를 물어볼 자리가 없습니다. 암호 없는 열쇠를 따로 만드세요"
      return 1
    fi
  fi

  # 3. ssh 별칭
  if ! ssh_alias_ok; then
    ssh_alias_write
    ok "ssh 별칭을 더했습니다 — $HOME/.ssh/config 의 '$SSH_ALIAS'"
  fi

  # 4. 드라이브가 이미 쓰이고 있으면 먼저 말한다
  if [[ -d "$PROD_DRIVE/" ]]; then
    bad "$PROD_DRIVE 드라이브가 이미 쓰이고 있습니다"
    info "다른 글자를 쓰려면: TDMS_PROD_DRIVE=Y: $SELF storage mount"
    return 1
  fi

  # 5. 띄운다. PATH 맨 앞에 SSHFS-Win 의 bin 을 둔다 — 이게 이 일의 핵심이다.
  #    sshfs 는 `ssh` 를 PATH 에서 찾는데, 번들 ssh(Cygwin)가 아니면 파이프가
  #    맞지 않아 바로 끊긴다.
  local log="$LOG_DIR/storage.log"
  : > "$log"
  local remote="${PROD_SSH_HOST%@*}@${SSH_ALIAS}:${PROD_REMOTE_DIR}"
  info "붙이는 중 — $PROD_DRIVE  ←  $remote"

  (
    export PATH="$bin:$PATH"
    exec "$bin/sshfs.exe" "$remote" "$PROD_DRIVE" -f \
      -o uid=-1,gid=-1 \
      -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
      -o FileInfoTimeout=5000,DirInfoTimeout=5000
  ) >>"$log" 2>&1 &

  local mpid=$! wpid
  wpid="$(win_pid_of "$mpid")" || wpid=""
  [[ -n "$wpid" ]] && printf '%s' "$wpid" > "$(storage_pidfile)"

  # 붙을 때까지 기다린다 (먼 길이라 넉넉히)
  local i
  for (( i = 0; i < 60; i++ )); do
    prod_mounted && break
    win_alive "${wpid:-0}" || break
    sleep 0.5
  done

  if ! prod_mounted; then
    bad "붙이지 못했습니다"
    tail -n 15 "$log" | sed 's/^/      /'
    [[ -n "$wpid" ]] && kill_tree "$wpid" KILL
    rm -f "$(storage_pidfile)"
    printf '\n'
    info "ssh 쪽부터 확인해 보세요:  ssh $SSH_ALIAS"
    return 1
  fi

  ok "붙었습니다 — $PROD_MOUNT  (pid ${wpid:-?})"
  printf '\n'
  if [[ "${STORAGE_ROOT:-}" == "$PROD_MOUNT"* ]]; then
    info "STORAGE_ROOT 은 이미 맞습니다. 서비스를 다시 띄우세요: $SELF restart"
  else
    info ".env 의 STORAGE_ROOT 를 이렇게 두세요 (끝의 / 가 있어야 합니다):"
    info "  STORAGE_ROOT=$PROD_DRIVE/"
    info "그다음: $SELF restart"
  fi
}

storage_umount() {
  local pf; pf="$(storage_pidfile)"
  local pid=""
  [[ -f "$pf" ]] && pid="$(cat "$pf" 2>/dev/null)"

  if ! prod_mounted && [[ -z "$pid" ]]; then
    info "붙어 있지 않습니다"
    return 0
  fi

  # 서비스가 그 드라이브를 쥐고 있으면 뗄 수 없다
  local s
  for s in api web worker; do
    if svc_running "$s" && [[ "${STORAGE_ROOT:-}" == "$PROD_MOUNT"* ]]; then
      bad "$(svc_label "$s") 가 그 저장소를 쓰고 있습니다"
      info "먼저 내리세요: $SELF stop"
      return 1
    fi
  done

  if [[ -n "$pid" ]]; then
    kill_tree "$pid" KILL
    wait_gone "$pid" 5 || true
  else
    warn "우리가 띄운 기록이 없습니다 — 손으로 띄운 sshfs 인 듯합니다"
    info "작업 관리자에서 sshfs.exe 를 끝내거나, net use 로 붙였다면:"
    info "  net use $PROD_DRIVE /delete /y"
    return 1
  fi
  rm -f "$pf"

  prod_mounted && { bad "뗐는데도 $PROD_MOUNT 가 아직 보입니다"; return 1; }
  ok "뗐습니다 — $PROD_MOUNT"
}

# ── 기타 ──────────────────────────────────────────────────────────────────

action_open() {
  local url="http://localhost:$(svc_port web)"
  cmd //c start "" "$url" >/dev/null 2>&1 || true
  info "$url"
}
