#!/usr/bin/env bash
# 대화형 메뉴 — 인자 없이 ./dev.sh 를 실행하면 열린다.

# 테두리를 손으로 맞추면 한글 폭 때문에 어긋난다 — pad 로 계산해 그린다.
BOX_W=54

box_line() { printf '  │ %s │\n' "$(pad "$1" $(( BOX_W - 2 )))"; }

banner() {
  clear 2>/dev/null || true
  local bar; bar="$(printf '─%.0s' $(seq 1 $BOX_W))"
  printf '  ┌%s┐\n' "$bar"
  box_line "${C_BOLD}GHub TDMS${C_RESET} — 개발서버 제어판"
  box_line "기술자료 관리 시스템"
  printf '  └%s┘\n' "$bar"
}

menu_loop() {
  while true; do
    banner
    action_status
    printf '\n'
    printf '  %s[1]%s 전체 시작        %s[5]%s 로그 보기\n'   "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '  %s[2]%s 전체 중지        %s[6]%s 환경 점검\n'   "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '  %s[3]%s 다시 시작        %s[7]%s 검증 돌리기\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '  %s[4]%s 접속 주소        %s[8]%s DB (마이그레이션·시드)\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '\n'
    printf '  %s[s]%s 서비스 하나만 다루기   %s[w]%s 워커 환경 준비\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '  %s[r]%s 새로 고침              %s[q]%s 나가기\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '\n  고르세요: '

    local c; read -r c || break
    case "$c" in
      1) action_start; pause ;;
      2) action_stop; pause ;;
      3) action_restart; pause ;;
      4) print_urls; pause ;;
      5) menu_logs ;;
      6) doctor; pause ;;
      7) action_verify || true; pause ;;
      8) menu_db ;;
      s|S) menu_service ;;
      w|W) action_setup_worker || true; pause ;;
      r|R) ;;
      q|Q|'') printf '\n'; break ;;
      *) ;;
    esac
  done
}

pause() { printf '\n  %s엔터를 누르면 돌아갑니다%s ' "$C_DIM" "$C_RESET"; read -r _ || true; }

menu_logs() {
  banner
  printf '\n  어느 로그를 볼까요?\n\n'
  printf '  %s[1]%s API    %s[2]%s 화면    %s[3]%s 워커    %s[a]%s 전부 조금씩    %s[b]%s 뒤로\n\n' \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '  고르세요: '
  local c; read -r c || return
  case "$c" in
    1) action_logs api ;;
    2) action_logs web ;;
    3) action_logs worker ;;
    a|A) action_logs; pause ;;
    *) ;;
  esac
}

menu_db() {
  banner
  printf '\n  %sDB%s\n\n' "$C_BOLD" "$C_RESET"
  printf '  %s[1]%s 마이그레이션 상태 보기\n' "$C_BOLD" "$C_RESET"
  printf '  %s[2]%s 마이그레이션 적용\n'      "$C_BOLD" "$C_RESET"
  printf '  %s[3]%s 시험 자료 넣기 (계정·폴더·도면·MDB)\n' "$C_BOLD" "$C_RESET"
  printf '  %s[b]%s 뒤로\n\n' "$C_BOLD" "$C_RESET"
  printf '  고르세요: '
  local c; read -r c || return
  case "$c" in
    1) action_db_status; pause ;;
    2) action_migrate; pause ;;
    3) action_seed; pause ;;
    *) ;;
  esac
}

menu_service() {
  banner
  printf '\n  %s서비스 하나만 다루기%s\n\n' "$C_BOLD" "$C_RESET"
  local i=1
  for s in "${SERVICES[@]}"; do
    printf '  %s[%d]%s %s\n' "$C_BOLD" "$i" "$C_RESET" "$(svc_label "$s")"
    ((i++))
  done
  printf '  %s[b]%s 뒤로\n\n  고르세요: ' "$C_BOLD" "$C_RESET"
  local c; read -r c || return
  [[ "$c" =~ ^[0-9]+$ ]] || return
  local name="${SERVICES[$((c-1))]:-}"
  [[ -n "$name" ]] || return

  printf '\n  %s — %s[1]%s 시작  %s[2]%s 중지  %s[3]%s 다시 시작  %s[4]%s 로그: ' \
    "$(svc_label "$name")" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  local a; read -r a || return
  case "$a" in
    1) action_start "$name"; pause ;;
    2) action_stop "$name"; pause ;;
    3) action_restart "$name"; pause ;;
    4) action_logs "$name" ;;
    *) ;;
  esac
}
