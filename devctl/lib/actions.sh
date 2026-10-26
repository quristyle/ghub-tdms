#!/usr/bin/env bash
# 제어판이 하는 일들 — 기동·중지·로그·DB·검증.

action_start() {
  local targets=("${@}")
  [[ ${#targets[@]} -eq 0 ]] && targets=("${SERVICES[@]}")
  storage_guard || return 1
  head1 "시작"
  local failed=0
  for s in "${targets[@]}"; do svc_start "$s" || failed=1; done
  printf '\n'
  action_status
  (( failed == 0 )) || return 1
  print_urls
}

action_stop() {
  local targets=("${@}")
  [[ ${#targets[@]} -eq 0 ]] && targets=("${SERVICES[@]}")
  head1 "중지"
  for s in "${targets[@]}"; do svc_stop "$s"; done
}

action_restart() {
  action_stop "$@"
  sleep 1
  action_start "$@"
}

action_status() {
  head1 "상태"
  printf '  %s %s %s %s\n' \
    "$(pad 서비스 20)" "$(pad 상태 6)" "$(pad 포트 6)" "비고"
  printf '  %s\n' "$(printf '─%.0s' {1..62})"
  for s in "${SERVICES[@]}"; do svc_status_line "$s"; done

  # 작업 큐 적체 — 워커가 없으면 쌓이기만 한다
  local queued
  queued="$(db_query "select count(*) from ${PGSCHEMA:-public}.jobs where state='queued'" 2>/dev/null || true)"
  if [[ -n "$queued" && "$queued" != "0" ]]; then
    printf '\n'
    warn "작업 큐에 $queued 건이 대기 중입니다"
    svc_available worker || info "워커가 없어 처리되지 않습니다 — ./dev.sh setup-worker"
  fi
}

print_urls() {
  head1 "접속"
  printf '  %s화면%s   http://localhost:%s\n' "$C_BOLD" "$C_RESET" "$(svc_port web)"
  printf '  %sAPI%s    http://127.0.0.1:%s/health\n' "$C_BOLD" "$C_RESET" "$(svc_port api)"
  printf '\n'
  printf '  %s시험 계정 — 초기 비밀번호는 ghub + 아이디%s\n' "$C_DIM" "$C_RESET"
  printf '    admin  / ghubadmin   관리자 (전체)\n'
  printf '    cm     / ghubcm      설비기술팀 (권한 34개)\n'
  printf '    viewer / ghubviewer  조회전용 (TDB·MDB 조회만)\n\n'
}

action_logs() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    head1 "로그 (최근 20줄씩)"
    for s in "${SERVICES[@]}"; do
      local f; f="$(svc_logfile "$s")"
      [[ -f "$f" ]] || continue
      printf '\n%s── %s %s\n' "$C_CYAN" "$(svc_label "$s")" "$C_RESET"
      tail -n 20 "$f" | sed 's/^/  /'
    done
    printf '\n'
    info "따라가며 보기: ./dev.sh logs api"
    return 0
  fi
  local f; f="$(svc_logfile "$name")"
  [[ -f "$f" ]] || die "로그가 없습니다: $f"
  printf '%s%s — Ctrl+C 로 빠져나옵니다%s\n\n' "$C_DIM" "$f" "$C_RESET"
  tail -n 60 -f "$f"
}

action_migrate() {
  head1 "마이그레이션"
  ( cd "$ROOT" && node db/migrate.mjs up )
}

action_db_status() {
  head1 "마이그레이션 상태"
  ( cd "$ROOT" && node db/migrate.mjs status )
}

action_seed() {
  head1 "시험 자료 넣기"
  ( cd "$ROOT" \
    && node db/migrate.mjs seed \
    && node db/seed/hash.mjs \
    && node db/tools/seed-files.mjs \
    && node db/tools/seed-mdb.mjs )
  ok "완료 — 계정 초기 비밀번호는 ghub + 아이디"
}

action_verify() {
  head1 "검증"
  local fail=0

  # 판정은 **종료 코드**로 한다. 출력 모양에 기대면 도구가 조용해질 때 조용히 틀린다
  # (실제로 pnpm -s 가 자식 출력을 삼켜 통과한 테스트를 실패로 읽은 적이 있다).
  printf '\n  %s타입체크%s\n' "$C_BOLD" "$C_RESET"
  if ( cd "$ROOT" && pnpm typecheck ) >"$LOG_DIR/verify-typecheck.log" 2>&1; then
    ok "3개 패키지 통과"
  else
    bad "타입 오류"; tail -n 8 "$LOG_DIR/verify-typecheck.log" | sed 's/^/      /'; fail=1
  fi

  printf '\n  %s단위 테스트%s\n' "$C_BOLD" "$C_RESET"
  if ( cd "$ROOT" && pnpm test ) >"$LOG_DIR/verify-test.log" 2>&1; then
    local n; n="$(grep -oE 'Tests[[:space:]]+[0-9]+ passed' "$LOG_DIR/verify-test.log" | tail -1)"
    ok "${n:-통과}"
  else
    bad "테스트 실패"; tail -n 12 "$LOG_DIR/verify-test.log" | sed 's/^/      /'; fail=1
  fi

  if svc_running api; then
    printf '\n  %s흐름 검증 (실제 API 호출)%s\n' "$C_BOLD" "$C_RESET"
    for f in import editor distribution mdb admin; do
      local script="$ROOT/db/tools/$f-flow-check.mjs"
      [[ -f "$script" ]] || continue
      local r; r="$(cd "$ROOT" && node "$script" 2>&1 | tail -1)"
      if [[ "$r" == *"0 실패"* ]]; then ok "$(printf '%-13s %s' "$f" "$r")"
      else bad "$(printf '%-13s %s' "$f" "$r")"; fail=1; fi
    done
    # 큐 검증은 워커와 같은 작업을 두고 다툰다 — 잠깐 재우고 돌린 뒤 되살린다.
    local worker_was_up=0
    if svc_running worker; then worker_was_up=1; svc_stop worker >/dev/null 2>&1; sleep 2; fi
    local q; q="$(cd "$ROOT" && node db/tools/queue-smoke.mjs 2>&1 | tail -1)"
    [[ "$q" == *"0 실패"* ]] && ok "$(printf '%-13s %s' queue "$q")" || { bad "queue $q"; fail=1; }
    (( worker_was_up )) && svc_start worker >/dev/null 2>&1
  else
    printf '\n'
    warn "API 가 꺼져 있어 흐름 검증을 건너뜁니다 — ./dev.sh start api"
  fi

  printf '\n'
  (( fail == 0 )) && ok "모두 통과" || bad "실패한 항목이 있습니다"
  return $fail
}

action_build() {
  head1 "빌드"
  ( cd "$ROOT" && pnpm -r build )
}

action_setup_worker() {
  head1 "워커 환경 준비"
  local wdir="$ROOT/packages/worker"
  if ! python3 -c 'import ensurepip' 2>/dev/null; then
    bad "python3-venv 가 없습니다"
    info "먼저: sudo apt install python3.12-venv"
    return 1
  fi
  ( cd "$wdir" \
    && python3 -m venv .venv \
    && ./.venv/bin/pip install -q --upgrade pip \
    && ./.venv/bin/pip install -q -e . ) || return 1
  ok "준비됨 — ./dev.sh start worker"
}

action_open() {
  local url="http://localhost:$(svc_port web)"
  command -v xdg-open >/dev/null && xdg-open "$url" >/dev/null 2>&1 &
  info "$url"
}

action_clean() {
  head1 "정리"
  rm -f "$RUN_DIR"/*.pid && ok "PID 파일 정리"
  : > "$LOG_DIR/api.log"; : > "$LOG_DIR/web.log"; : > "$LOG_DIR/worker.log" 2>/dev/null || true
  ok "로그 비움"
}

# ── 운영 blob 저장소 붙이기/떼기 ───────────────────────────────────────────
#
#   ./dev.sh storage          지금 어디를 보고 있는지
#   ./dev.sh storage mount    운영 저장소에 붙인다 (sshfs)
#   ./dev.sh storage umount   뗀다
#
# 붙이는 자리와 이유는 common.sh 의 PROD_* 주석에 적어 두었다.
action_storage() {
  case "${1:-status}" in
    mount)  storage_mount ;;
    umount|unmount) storage_umount ;;
    status) storage_status ;;
    *) die "storage 뒤에는 mount·umount·status 중 하나를 씁니다" ;;
  esac
}

storage_status() {
  head1 "blob 저장소"
  info "STORAGE_ROOT=${STORAGE_ROOT:-(없음)}"
  if prod_mounted; then
    ok "운영 저장소에 붙어 있음 — $PROD_SSH_HOST:$PROD_REMOTE_DIR"
    info "blob $(find "$PROD_MOUNT/blobs" -type f 2>/dev/null | wc -l)개"
  else
    warn "운영 저장소에 붙어 있지 않습니다 ($PROD_MOUNT)"
    info "./dev.sh storage mount"
  fi
}

storage_mount() {
  if prod_mounted; then ok "이미 붙어 있습니다 — $PROD_MOUNT"; return 0; fi

  command -v sshfs >/dev/null || {
    bad "sshfs 가 없습니다. 한 번만 설치하면 됩니다:"
    info "sudo apt install -y sshfs"
    return 1
  }

  # fusermount 는 마운트 지점에 쓰기 권한을 요구한다 — 권한으로는 잠글 수 없다.
  # 안 붙은 채로 쓰이는 것은 storage_guard 가 시작 지점에서 막는다.
  mkdir -p "$PROD_MOUNT"
  chmod 700 "$PROD_MOUNT"

  sshfs -p "$PROD_SSH_PORT" \
        -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
        -o idmap=user,uid="$(id -u)",gid="$(id -g)" \
        "$PROD_SSH_HOST:$PROD_REMOTE_DIR" "$PROD_MOUNT" || {
    die "붙이지 못했습니다 — ssh -p $PROD_SSH_PORT $PROD_SSH_HOST 가 되는지 확인하세요"
  }

  prod_mounted || die "sshfs 는 끝났는데 마운트가 보이지 않습니다"
  ok "붙었습니다 — $PROD_MOUNT ($(find "$PROD_MOUNT/blobs" -type f 2>/dev/null | wc -l)개)"
  info "API·워커가 떠 있다면 다시 시작하세요: ./dev.sh restart api worker"
}

storage_umount() {
  prod_mounted || { info "붙어 있지 않습니다"; return 0; }
  fusermount3 -u "$PROD_MOUNT" 2>/dev/null || fusermount -u "$PROD_MOUNT" || die "떼지 못했습니다"
  ok "뗐습니다 — $PROD_MOUNT"
}

# STORAGE_ROOT 이 운영 마운트를 가리키는데 붙어 있지 않으면 **시작하지 않는다**.
# 그대로 띄우면 DB 는 운영을 보는데 파일만 개발 장비의 빈 디렉터리에 쌓여,
# 목록은 보이는데 미리보기만 비는 어긋남이 그대로 되살아난다.
storage_guard() {
  [[ "${STORAGE_ROOT:-}" == "$PROD_MOUNT"* ]] || return 0
  prod_mounted && return 0
  bad "STORAGE_ROOT 이 운영 저장소($PROD_MOUNT)를 가리키는데 붙어 있지 않습니다"
  info "붙이기:   ./dev.sh storage mount"
  info "로컬로:   .env 의 STORAGE_ROOT 를 $ROOT/.storage 로 되돌린다"
  return 1
}
