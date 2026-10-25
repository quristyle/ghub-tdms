#!/usr/bin/env bash
# 공통 — 색, 출력, 설정 읽기, 작은 도구들.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVCTL="$ROOT/devctl"
RUN_DIR="$DEVCTL/run"
LOG_DIR="$DEVCTL/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

# 색 — 터미널이 아니면 끈다(로그로 넘길 때 깨지지 않게)
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
bad()   { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }
info()  { printf '  %s·%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
head1() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
dim()   { printf '%s%s%s' "$C_DIM" "$*" "$C_RESET"; }

die() { bad "$*"; exit 1; }

# 화면에 보이는 너비 — printf 의 %-18s 는 **바이트**를 세므로 한글이 섞이면 열이 틀어진다.
# 한중일 글자는 두 칸을 차지하므로 따로 센다.
disp_width() {
  local s="$1" w=0 ch
  s="${s//$'\033'\[[0-9;]*m/}"
  for (( i = 0; i < ${#s}; i++ )); do
    ch="${s:i:1}"
    case "$ch" in
      [가-힣]|[一-鿿]|[ぁ-ゟ]|[゠-ヿ]|[！-～]) w=$(( w + 2 )) ;;
      *) w=$(( w + 1 )) ;;
    esac
  done
  printf '%s' "$w"
}

# 보이는 너비에 맞춰 오른쪽을 공백으로 채운다
pad() {
  local s="$1" want="$2" have
  have="$(disp_width "$s")"
  printf '%s' "$s"
  (( want > have )) && printf '%*s' "$(( want - have ))" ''
  return 0
}

# .env 를 읽어 환경에 올린다 (주석·빈 줄 무시, 이미 있는 값은 덮지 않는다)
load_env() {
  local f="$ROOT/.env"
  [[ -f "$f" ]] || return 0
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    local k="${BASH_REMATCH[1]}" v="${BASH_REMATCH[2]}"
    [[ -n "${!k:-}" ]] || export "$k=$v"
  done < "$f"
}

# 포트를 쓰는 프로세스 PID (없으면 빈 문자열)
port_pid() {
  local port="$1"
  ss -tlnpH "sport = :$port" 2>/dev/null \
    | grep -oP 'pid=\K[0-9]+' | head -1
}

port_free() { [[ -z "$(port_pid "$1")" ]]; }

# 사람이 읽는 경과 시간
human_etime() {
  local pid="$1"
  ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || echo '-'
}

# 프로세스와 그 자식들을 차례로 끝낸다 (TERM 먼저, 안 죽으면 KILL)
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local kids
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  for k in $kids; do kill_tree "$k" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# 프로세스 그룹째 끝낸다.
#
# 자식만 죽이면 `pnpm → tsx watch → node` 의 **감시 프로세스가 살아남아** 파일을
# 고치는 순간 서버가 되살아난다. 개발 도구는 이런 감시 사슬을 쓰므로 그룹째 끝내야 한다.
# 우리(제어판) 자신의 그룹은 건드리지 않는다.
kill_group() {
  local pid="$1" sig="${2:-TERM}" pgid
  [[ -n "$pid" ]] || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$pgid" && "$pgid" != "1" ]] || return 1
  [[ "$pgid" != "$(ps -o pgid= -p $$ | tr -d ' ')" ]] || return 1
  kill "-$sig" "-$pgid" 2>/dev/null || return 1
  return 0
}

# 그룹에 아직 살아 있는 프로세스가 있는가
group_alive() {
  local pgid="$1"
  [[ -n "$pgid" ]] || return 1
  [[ -n "$(pgrep -g "$pgid" 2>/dev/null || true)" ]]
}

pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

wait_gone() {
  local pid="$1" limit="${2:-10}" i=0
  while kill -0 "$pid" 2>/dev/null; do
    ((i++)); (( i > limit * 10 )) && return 1
    sleep 0.1
  done
  return 0
}

# HTTP 가 응답할 때까지 기다린다
wait_http() {
  local url="$1" limit="${2:-40}" i=0
  while (( i < limit )); do
    curl -fsS -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5; ((i++))
  done
  return 1
}
