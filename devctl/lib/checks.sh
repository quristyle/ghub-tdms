#!/usr/bin/env bash
# 사전 점검 — 무엇이 없어서 안 되는지 한눈에 보여준다.

PSQL_ARGS=()
psql_ready() {
  command -v psql >/dev/null || return 1
  [[ -n "${PGHOST:-}" && -n "${PGDATABASE:-}" && -n "${PGUSER:-}" ]] || return 1
  PSQL_ARGS=(-h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" -X -tA)
  return 0
}

db_query() {
  psql_ready || return 1
  PGPASSWORD="${PGPASSWORD:-}" psql "${PSQL_ARGS[@]}" -c "$1" 2>/dev/null
}

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
      bad "$(printf '%-6s %s' "$t" '없음')"
    fi
  done

  if [[ -x "$ROOT/packages/worker/.venv/bin/python" ]]; then
    ok "$(printf '%-6s %s' python "$("$ROOT/packages/worker/.venv/bin/python" -V 2>&1 | awk '{print $2}') (워커 환경 있음)")"
  elif command -v python3 >/dev/null; then
    warn "$(printf '%-6s %s' python "$(python3 -V | awk '{print $2}') — 워커 가상환경 없음")"
    info "준비: sudo apt install python3.12-venv  →  ./dev.sh setup-worker"
  else
    warn "$(printf '%-6s %s' python '없음 — 워커를 쓸 수 없습니다')"
  fi
}

check_config() {
  head1 "설정"
  if [[ -f "$ROOT/.env" ]]; then
    ok ".env 있음"
    local perm; perm="$(stat -c '%a' "$ROOT/.env")"
    [[ "$perm" == "600" ]] && ok ".env 권한 600" || warn ".env 권한이 $perm 입니다 (chmod 600 권장)"
  else
    bad ".env 가 없습니다 — cp .env.example .env 뒤 값을 채우세요"
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

check_db() {
  head1 "데이터베이스"
  if ! psql_ready; then
    bad "psql 또는 접속 설정이 없습니다"
    return 1
  fi
  info "$PGUSER@$PGHOST:${PGPORT:-5432}/$PGDATABASE (스키마 ${PGSCHEMA:-public})"

  local ver; ver="$(db_query 'select version()' | head -1 | awk '{print $1, $2}')"
  if [[ -z "$ver" ]]; then
    bad "접속할 수 없습니다"
    return 1
  fi
  ok "접속됨 — $ver"

  local tables rows
  tables="$(db_query "select count(*) from information_schema.tables
                       where table_schema='${PGSCHEMA:-public}' and table_type='BASE TABLE'")"
  ok "표 ${tables:-?}개"

  # 적용 대기 중인 마이그레이션
  local applied total
  applied="$(db_query "select count(*) from ${PGSCHEMA:-public}.schema_migrations" 2>/dev/null || echo 0)"
  total="$(find "$ROOT/db/migrations" -name '*.sql' 2>/dev/null | wc -l)"
  if [[ "${applied:-0}" -lt "$total" ]]; then
    warn "마이그레이션 대기 $((total - applied))개 (적용 $applied / 전체 $total) — ./dev.sh migrate"
  else
    ok "마이그레이션 최신 ($applied/$total)"
  fi

  rows="$(db_query "select
            (select count(*) from ${PGSCHEMA:-public}.documents) || '/' ||
            (select count(*) from ${PGSCHEMA:-public}.mdb_files) || '/' ||
            (select count(*) from ${PGSCHEMA:-public}.users)" 2>/dev/null)"
  if [[ -n "$rows" ]]; then
    ok "자료 — TDB/MDB/계정: $rows"
    [[ "${rows%%/*}" == "0" ]] && info "비어 있습니다 — ./dev.sh seed 로 시험 자료를 넣을 수 있습니다"
  fi
}

check_ports() {
  head1 "포트"
  for name in api web; do
    local port pid ours
    port="$(svc_port "$name")"
    pid="$(port_pid "$port")"
    ours="$(svc_pid "$name")"

    if [[ -z "$pid" ]]; then
      ok "$(printf '%-6s %s' "$port" '비어 있음')"
      continue
    fi

    # pid 파일에 든 것은 감싼 래퍼이고 실제로 포트를 쥔 것은 그 손자일 수 있다.
    # 같은 프로세스 그룹이면 우리 것이다.
    if [[ -n "$ours" ]] && [[ "$pid" == "$ours" || "$(pgid_of "$pid")" == "$(pgid_of "$ours")" ]]; then
      ok "$(printf '%-6s %s' "$port" "$(svc_label "$name") 사용 중 (pid $pid)")"
    else
      warn "$(printf '%-6s %s' "$port" "다른 프로세스가 쓰고 있습니다 (pid $pid)")"
    fi
  done
}

check_storage() {
  head1 "blob 저장소"
  local root="${STORAGE_ROOT:-}"
  [[ -n "$root" ]] || { bad "STORAGE_ROOT 이 없습니다"; return 1; }

  if [[ "$root" == "$PROD_MOUNT"* ]]; then
    if prod_mounted; then
      ok "운영 저장소 ($PROD_SSH_HOST:$PROD_REMOTE_DIR) — blob $(find "$root/blobs" -type f 2>/dev/null | wc -l)개"
    else
      # 여기서 넘어가면 DB 는 운영을 보는데 파일만 개발 장비에 쌓인다.
      bad "운영 저장소를 가리키는데 붙어 있지 않습니다 — ./dev.sh storage mount"
      return 1
    fi
  elif [[ -d "$root/blobs" ]]; then
    ok "로컬 저장소 $root — blob $(find "$root/blobs" -type f 2>/dev/null | wc -l)개"
    info "DB 는 운영과 공유입니다. 운영과 같은 파일을 보려면 ./dev.sh storage mount"
  else
    warn "$root/blobs 가 없습니다 — node db/tools/seed-files.mjs 로 만들 수 있습니다"
  fi
}

doctor() {
  printf '%sGHub TDMS — 개발 환경 점검%s\n' "$C_BOLD" "$C_RESET"
  check_tools
  check_config || true
  check_db || true
  check_storage || true
  check_ports
  printf '\n'
}
