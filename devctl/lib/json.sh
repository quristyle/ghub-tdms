#!/usr/bin/env bash
# 상태를 JSON 으로 — 브라우저 제어판이 읽는다.
# 판정 로직을 복사하지 않고 services.sh·checks.sh 의 함수를 그대로 쓴다.

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

jstr() { printf '"%s"' "$(json_escape "${1-}")"; }

# null 또는 문자열
jopt() { [[ -z "${1-}" ]] && printf 'null' || jstr "$1"; }

status_json() {
  local first=1
  printf '{"services":['
  for name in "${SERVICES[@]}"; do
    (( first )) || printf ','
    first=0

    local pid port state label
    pid="$(svc_pid "$name")"
    port="$(svc_port "$name")"
    label="$(svc_label "$name")"

    if ! svc_available "$name"; then state=unavailable
    elif [[ -n "$pid" ]]; then state=running
    else state=stopped; fi

    printf '{"name":%s,"label":%s,"state":%s,"port":%s,"pid":%s,"uptime":%s,"owned":%s,"url":%s}' \
      "$(jstr "$name")" "$(jstr "$label")" "$(jstr "$state")" \
      "$(jopt "$port")" "$(jopt "$pid")" \
      "$(jopt "$([[ -n "$pid" ]] && human_etime "$pid")")" \
      "$([[ -f "$(svc_pidfile "$name")" ]] && echo true || echo false)" \
      "$(jopt "$([[ -n "$port" ]] && echo "http://localhost:$port")")"
  done
  printf '],'

  # DB 는 한 번에 묶어 묻는다 (왕복을 줄인다)
  local db_ok=false tables=0 applied=0 pending=0 queued=0 docs=0 mdb=0 users=0
  local total; total="$(find "$ROOT/db/migrations" -name '*.sql' 2>/dev/null | wc -l)"
  if psql_ready; then
    local row
    row="$(db_query "select
        (select count(*) from information_schema.tables
          where table_schema='${PGSCHEMA:-public}' and table_type='BASE TABLE') || '|' ||
        (select count(*) from ${PGSCHEMA:-public}.schema_migrations) || '|' ||
        (select count(*) from ${PGSCHEMA:-public}.jobs where state='queued') || '|' ||
        (select count(*) from ${PGSCHEMA:-public}.documents) || '|' ||
        (select count(*) from ${PGSCHEMA:-public}.mdb_files) || '|' ||
        (select count(*) from ${PGSCHEMA:-public}.users)" 2>/dev/null)"
    if [[ -n "$row" ]]; then
      db_ok=true
      IFS='|' read -r tables applied queued docs mdb users <<< "$row"
      pending=$(( total - applied ))
    fi
  fi

  printf '"db":{"ok":%s,"host":%s,"database":%s,"schema":%s,' \
    "$db_ok" "$(jstr "${PGHOST:-}:${PGPORT:-5432}")" "$(jstr "${PGDATABASE:-}")" "$(jstr "${PGSCHEMA:-public}")"
  printf '"tables":%s,"migApplied":%s,"migTotal":%s,"migPending":%s,' \
    "${tables:-0}" "${applied:-0}" "${total:-0}" "${pending:-0}"
  printf '"queued":%s,"documents":%s,"mdbFiles":%s,"users":%s},' \
    "${queued:-0}" "${docs:-0}" "${mdb:-0}" "${users:-0}"

  printf '"env":{"root":%s,"workerReady":%s,"now":%s}}' \
    "$(jstr "$ROOT")" \
    "$(svc_available worker && echo true || echo false)" \
    "$(jstr "$(date '+%H:%M:%S')")"
}
