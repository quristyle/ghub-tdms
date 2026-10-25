# 개발서버 제어판

개발 장비에서 TDMS 를 띄우고 들여다보는 도구. **운영 배포와는 무관하다**
(운영은 `deploy/` 의 nginx + systemd 를 쓴다).

실행은 저장소 뿌리의 `dev.sh` 로 한다.

```bash
./dev.sh              # 대화형 제어판
./dev.sh start        # 전부 시작
./dev.sh status       # 상태만 보기
```

## 폴더

```
devctl/
  lib/
    common.sh    색·출력·.env 읽기·포트/프로세스 도구
    services.sh  서비스 정의(api·web·worker)와 기동·중지·상태
    checks.sh    사전 점검 (도구·설정·DB·포트)
    actions.sh   제어판이 하는 일들
    menu.sh      대화형 메뉴
  run/           PID 파일 (gitignore)
  logs/          서비스 로그 (gitignore)
```

## 다루는 서비스

| 이름 | 무엇 | 포트 | 기동 확인 |
|---|---|---|---|
| `api` | Fastify API | 8080 | `GET /health` |
| `web` | Vite 개발 서버 | 5173 | `GET /` |
| `worker` | Python 작업 워커 | — | 프로세스 생존 |

워커는 파이썬 가상환경이 있어야 쓸 수 있다. 없으면 제어판이 건너뛰고 준비 방법을 알려 준다.

## 알아 둘 것

- **제어판 밖에서 띄운 것도 알아본다.** PID 파일이 없으면 포트를 보고 찾으므로,
  터미널에서 직접 `pnpm dev` 로 띄운 것도 상태에 잡히고 `stop` 으로 끌 수 있다.
- **중지는 프로세스 나무를 통째로 끝낸다.** `pnpm → tsx/vite → node` 로 이어지는
  자식들을 차례로 끝내고, 그래도 포트를 쥐고 있으면 그 프로세스까지 정리한다.
- **로그는 `devctl/logs/` 에 쌓인다.** 서비스를 시작할 때마다 비운다.
- 제어판은 `.env` 를 읽기만 하고 고치지 않는다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `start [서비스…]` | 시작 (생략하면 전부) |
| `stop [서비스…]` | 중지 |
| `restart [서비스…]` | 다시 시작 |
| `status` | 상태와 작업 큐 적체 |
| `logs [서비스]` | 로그. 서비스를 주면 따라가며 본다 |
| `doctor` | 도구·설정·DB·포트 점검 |
| `migrate` / `db` | 마이그레이션 적용 / 상태 |
| `seed` | 시험 자료 넣기 |
| `verify` | 타입체크 + 테스트 + 흐름 검증 |
| `build` | 운영 빌드 |
| `setup-worker` | 파이썬 가상환경 준비 |
| `open` | 브라우저로 열기 |
| `clean` | PID·로그 정리 |
