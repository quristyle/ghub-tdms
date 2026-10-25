#!/usr/bin/env bash
#
# GHub TDMS — 개발서버 제어판
#
#   ./dev.sh              대화형 제어판
#   ./dev.sh start        전부 시작
#   ./dev.sh <명령> …     아래 help 참조
#
# 구현은 devctl/ 에 있다. 이 파일은 진입점일 뿐이다.
# 운영 배포와는 무관하다 — 운영은 deploy/ 의 nginx + systemd 를 쓴다.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/devctl/lib"

[[ -d "$LIB" ]] || { echo "devctl/lib 를 찾을 수 없습니다: $LIB" >&2; exit 1; }

# shellcheck source=devctl/lib/common.sh
source "$LIB/common.sh"
load_env
source "$LIB/services.sh"
source "$LIB/checks.sh"
source "$LIB/actions.sh"
source "$LIB/menu.sh"

usage() {
  cat <<'TXT'
GHub TDMS — 개발서버 제어판

  ./dev.sh                     대화형 제어판을 연다

서비스
  start   [api|web|worker…]    시작 (생략하면 전부)
  stop    [api|web|worker…]    중지
  restart [api|web|worker…]    다시 시작
  status                       상태와 작업 큐 적체
  logs    [api|web|worker]     로그 (서비스를 주면 따라가며 본다)

환경
  doctor                       도구·설정·DB·포트 점검
  setup-worker                 파이썬 가상환경 준비

DB
  db                           마이그레이션 상태
  migrate                      마이그레이션 적용
  seed                         시험 자료 넣기 (계정·폴더·도면·MDB)

검사
  verify                       타입체크 + 테스트 + 흐름 검증
  build                        운영 빌드

기타
  open                         브라우저로 화면 열기
  clean                        PID·로그 정리
  help                         이 도움말

시험 계정 — 초기 비밀번호는 ghub + 아이디
  admin / cm / viewer
TXT
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
  '')            menu_loop ;;
  start)         action_start "$@" ;;
  stop)          action_stop "$@" ;;
  restart)       action_restart "$@" ;;
  status|st)     action_status ;;
  logs|log)      action_logs "${1:-}" ;;
  doctor|check)  doctor ;;
  setup-worker)  action_setup_worker ;;
  db)            action_db_status ;;
  migrate)       action_migrate ;;
  seed)          action_seed ;;
  verify|test)   action_verify ;;
  build)         action_build ;;
  open)          action_open ;;
  clean)         action_clean ;;
  help|-h|--help) usage ;;
  *)             echo "모르는 명령입니다: $cmd" >&2; echo; usage; exit 1 ;;
esac
