#!/usr/bin/env bash
# 서비스 정의와 기동·중지·상태.
#
# 서비스 하나는 이름·포트·실행 명령·기동 확인 주소로 이뤄진다.
# PID 는 devctl/run/<이름>.pid, 로그는 devctl/logs/<이름>.log 에 둔다.

SERVICES=(api web worker)

svc_label() {
  case "$1" in
    api)    echo "API 서버 (Fastify)" ;;
    web)    echo "웹 화면 (Vite)" ;;
    worker) echo "작업 워커 (Python)" ;;
  esac
}

svc_port() {
  case "$1" in
    api)    echo "${API_PORT:-8080}" ;;
    web)    echo "${WEB_PORT:-5173}" ;;
    worker) echo "" ;;
  esac
}

svc_health() {
  case "$1" in
    api) echo "http://127.0.0.1:$(svc_port api)/health" ;;
    web) echo "http://127.0.0.1:$(svc_port web)/" ;;
    *)   echo "" ;;
  esac
}

svc_cmd() {
  case "$1" in
    api)    echo "pnpm --filter @tdms/api dev" ;;
    web)    echo "pnpm --filter @tdms/web dev" ;;
    worker) echo "$ROOT/packages/worker/.venv/bin/python -m tdms_worker --id 1" ;;
  esac
}

svc_cwd() {
  case "$1" in
    worker) echo "$ROOT/packages/worker" ;;
    *)      echo "$ROOT" ;;
  esac
}

# 워커는 파이썬 환경이 있어야 쓸 수 있다.
# python 심볼릭 링크만 있고 패키지가 없는 **반쪽 venv** 가 남을 수 있으므로
# (venv 만들기가 중간에 끊기면 pip 가 없다) 실제로 쓸 수 있는지까지 본다.
svc_available() {
  case "$1" in
    worker)
      local v="$ROOT/packages/worker/.venv"
      [[ -x "$v/bin/python" && -x "$v/bin/pip" ]] || return 1
      "$v/bin/python" -c 'import psycopg' 2>/dev/null
      ;;
    *) return 0 ;;
  esac
}

svc_pidfile() { echo "$RUN_DIR/$1.pid"; }
svc_logfile() { echo "$LOG_DIR/$1.log"; }

# 살아 있는 PID 를 돌려준다. pid 파일이 없으면 포트로도 찾아본다
# (제어판 밖에서 띄운 것도 알아보게 하기 위해서다).
svc_pid() {
  local name="$1" pf; pf="$(svc_pidfile "$name")"
  if [[ -f "$pf" ]]; then
    local pid; pid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; return 0; fi
    rm -f "$pf"
  fi
  local port; port="$(svc_port "$name")"
  [[ -n "$port" ]] && port_pid "$port"
}

svc_running() { [[ -n "$(svc_pid "$1")" ]]; }

# 제어판이 띄운 것인가 (pid 파일이 있으면 우리 것)
svc_owned() { [[ -f "$(svc_pidfile "$1")" ]]; }

svc_start() {
  local name="$1"
  if ! svc_available "$name"; then
    warn "$(svc_label "$name") — 실행 환경이 없어 건너뜁니다"
    [[ "$name" == worker ]] && info "준비: sudo apt install python3.12-venv 뒤 ./dev.sh setup-worker"
    return 0
  fi
  if svc_running "$name"; then
    info "$(svc_label "$name") 는 이미 돌고 있습니다 (pid $(svc_pid "$name"))"
    return 0
  fi

  local port; port="$(svc_port "$name")"
  if [[ -n "$port" ]] && ! port_free "$port"; then
    bad "$(svc_label "$name") — 포트 $port 를 다른 프로세스가 쓰고 있습니다 (pid $(port_pid "$port"))"
    info "먼저 ./dev.sh stop 또는 kill $(port_pid "$port")"
    return 1
  fi

  local log; log="$(svc_logfile "$name")"
  : > "$log"
  ( cd "$(svc_cwd "$name")" && exec setsid bash -c "$(svc_cmd "$name")" ) >>"$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$(svc_pidfile "$name")"

  local health; health="$(svc_health "$name")"
  if [[ -n "$health" ]]; then
    printf '  %s·%s %s 기동 중' "$C_DIM" "$C_RESET" "$(svc_label "$name")"
    if wait_http "$health" 60; then
      printf '\r'; ok "$(svc_label "$name") 올라왔습니다 — $health"
    else
      printf '\r'; bad "$(svc_label "$name") 가 응답하지 않습니다"
      info "로그: ./dev.sh logs $name"
      tail -n 12 "$log" | sed 's/^/      /'
      return 1
    fi
  else
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then ok "$(svc_label "$name") 시작 (pid $pid)"
    else bad "$(svc_label "$name") 가 바로 종료되었습니다"; tail -n 12 "$log" | sed 's/^/      /'; return 1; fi
  fi
}

svc_stop() {
  local name="$1" pid; pid="$(svc_pid "$name")"
  if [[ -z "$pid" ]]; then
    info "$(svc_label "$name") 는 돌고 있지 않습니다"
    rm -f "$(svc_pidfile "$name")"
    return 0
  fi

  # 그룹째 끝낸다 — 자식만 죽이면 tsx watch·vite 감시 프로세스가 살아남아
  # 파일을 고치는 순간 되살아난다.
  local pgid; pgid="$(pgid_of "$pid")"
  kill_group "$pid" TERM || kill_tree "$pid" TERM

  if wait_gone "$pid" 8; then
    ok "$(svc_label "$name") 중지 (pid $pid)"
  else
    kill_group "$pid" KILL || kill_tree "$pid" KILL
    wait_gone "$pid" 3 && ok "$(svc_label "$name") 강제 중지 (pid $pid)" \
                       || bad "$(svc_label "$name") 를 끝내지 못했습니다 (pid $pid)"
  fi

  # 그룹에 남은 감시 프로세스 정리
  if [[ -n "$pgid" ]] && group_alive "$pgid"; then
    kill -KILL "-$pgid" 2>/dev/null || true
    sleep 0.3
    group_alive "$pgid" || info "감시 프로세스까지 정리했습니다 (그룹 $pgid)"
  fi

  rm -f "$(svc_pidfile "$name")"

  # 포트를 아직 쥐고 있는 잔여 프로세스 정리
  local port; port="$(svc_port "$name")"
  if [[ -n "$port" ]]; then
    local leftover; leftover="$(port_pid "$port")"
    if [[ -n "$leftover" ]]; then
      kill_tree "$leftover" TERM; wait_gone "$leftover" 5 || kill_tree "$leftover" KILL
      info "포트 $port 를 쥐고 있던 잔여 프로세스 정리 (pid $leftover)"
    fi
  fi
}

svc_status_line() {
  local name="$1" pid port state detail
  pid="$(svc_pid "$name")"
  port="$(svc_port "$name")"

  if ! svc_available "$name"; then
    state="${C_DIM}없음${C_RESET}"; detail="실행 환경 미구성"
  elif [[ -n "$pid" ]]; then
    state="${C_GREEN}동작${C_RESET}"
    detail="pid $pid · $(human_etime "$pid")"
    svc_owned "$name" || detail="$detail · $(dim '제어판 밖에서 시작됨')"
  else
    state="${C_RED}정지${C_RESET}"; detail="-"
  fi

  printf '  %s %s %s %s\n' \
    "$(pad "$(svc_label "$name")" 20)" \
    "$(pad "$state" 6)" \
    "$(pad "${port:--}" 6)" \
    "$detail"
}
