# GHub TDMS

SK가스 G.Hub 사업장 **기술자료 관리 시스템** 재구축.
기존 시스템(FastAPI + 순수 HTML/JS, Windows)을 기능 100% 보존하면서
**관리성과 성능을 1순위**로 재구성한다.

설계는 [`docs/`](docs/README.md) 에 있다. 먼저 [docs/00-시스템개요.md](docs/00-시스템개요.md) 를 읽을 것.

## 구성

| 영역 | 기술 |
|---|---|
| OS | Ubuntu 24.04 LTS |
| DB | PostgreSQL 16 (`ltree`, `pg_trgm`, `pgcrypto`) |
| API | TypeScript + Fastify 5 (Node 22) |
| 워커 | Python 3.12 (DWG·오피스 변환, Zip, 엑셀, 백업) |
| 프론트 | Vue 3.5 + Vite + TypeScript strict (컴포넌트 프레임워크 미사용) |
| 계약 | Zod 1벌 → 런타임 검증 + 응답 직렬화 컴파일 + 프론트 타입 |
| 큐 | PostgreSQL `SKIP LOCKED` + `LISTEN/NOTIFY` (Redis 미사용) |
| 파일 전송 | nginx `X-Accel-Redirect` (앱이 바이트를 만지지 않음) |

```
packages/
  contracts/   Zod 스키마 1벌 — FE/BE 단일 진실
  api/         Fastify. 모듈은 기존 라우터 18개와 1:1
  worker/      Python 변환·배치 워커
  web/         Vue 3 화면 14개
db/
  migrations/  번호순 SQL (되돌리기 없음 — 앞으로만)
  seed/        초기 데이터
deploy/        nginx, systemd, PostgreSQL 튜닝
docs/          설계문서
```

## 개발 환경 준비

필요: Node 22+, pnpm 10+, Python 3.12+, PostgreSQL 클라이언트

```bash
pnpm install
cp .env.example .env     # DB 접속·세션키를 채운다
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
```

### DB 준비

```bash
pnpm db:status     # 적용 상태 확인
pnpm db:migrate    # 마이그레이션 적용
pnpm db:seed       # 기본 데이터 (계정·그룹·분류·샘플 폴더)
node db/seed/hash.mjs   # 시드 계정 비밀번호 설정
```

시드 계정 — 초기 비밀번호는 기존 규칙 `ghub` + 아이디. 첫 로그인 시 변경 화면이 열린다(미루기 가능).

| 아이디 | 역할 | 그룹 |
|---|---|---|
| `admin` | ADMIN | 설비기술팀 |
| `cm` | VIEWER | 설비기술팀 (권한 34개) |
| `viewer` | VIEWER | 조회전용 (TDB·MDB 조회만) |

### 실행

```bash
pnpm --filter @tdms/api dev     # http://127.0.0.1:8080
pnpm --filter @tdms/web dev     # http://localhost:5173  (/api 를 API 로 프록시)
```

### 검사

```bash
pnpm typecheck    # 전 패키지 tsc --noEmit
pnpm test         # Vitest
pnpm build        # 빌드 + 번들 예산 확인
```

## 지켜야 할 규약

1. **모듈은 4개 파일만 가진다** — `routes.ts`(선언) / `service.ts`(업무 규칙) /
   `queries.ts`(**SQL 은 여기에만**) / `schema.ts`(계약 재노출)
2. **모든 라우트는 `access` 를 선언한다.** 빠뜨리면 기동 시점에 서버가 뜨지 않는다.
   쓰기 작업과 파일 접근 경로는 `audit` 선언도 필수다.
3. **`OFFSET` 을 쓰지 않는다.** 목록은 전부 keyset(cursor) 페이징.
4. **권한 키는 36개 리프에서만 고른다.** 트리에 없는 키는 컴파일 에러가 난다.
5. **마이그레이션은 수정하지 않는다.** 적용된 파일이 바뀌면 적용기가 거부한다. 새 파일을 추가할 것.
6. **장시간 작업은 작업 큐로 넘긴다.** 요청 스레드에서 엑셀·Zip·백업·변환을 돌리지 않는다.
7. **업로드 스트림에 곁다리 `data` 리스너를 붙이지 않는다.** `.on('data')` 는 스트림을 즉시
   flowing 모드로 바꿔 `pipeline()` 보다 먼저 청크를 삼킨다 — 실제로 모든 업로드가
   0바이트로 저장된 적이 있다. 해싱·검사는 `core/blob.ts` 의 Transform 안에서 한다.
8. **업무 규칙은 순수 함수로 뽑아 테스트한다.** 리비전 상태 머신(`contracts/revision.ts`)이
   그 본보기다 — DB 를 모르므로 전수 검증이 가능하다.
9. **SQL 매개변수에는 캐스트를 적는다.** `SELECT $1, trim(t.tag)` 처럼 매개변수를 목록에
   섞으면 Postgres 가 주변 컬럼을 보고 타입을 잘못 추론한다 — 실제로 `bigint` 컬럼에
   text 가 들어가 500 이 났다. `$1::bigint` 로 못박을 것.
10. **화면에서 `@tdms/contracts` 는 `import type` 으로만 가져온다.** 런타임 값(라벨 맵 등)을
   가져오면 그 화면 청크로 Zod 전체가 끌려 들어온다 — 실제로 한 화면이 7배로 부풀었다.
   화면용 상수는 `web/src/lib/` 에 둔다.

## 현재 진행 상황

[docs/08-이행계획.md](docs/08-이행계획.md) 의 단계 기준.

| 단계 | 상태 |
|---|---|
| 0 · 기준선 | 기능 인벤토리 완료 (메뉴 9 / 화면 14 / 권한 36 / API 201) |
| 1 · 데이터 | 스키마 설계·적용 완료 (테이블 29, 인덱스 93) |
| 2 · 골격 | **완료** — 계약, API 골격, 인증·권한·감사·캐시, 셸·메뉴 |
| 3 · 조회 | **완료** — TDB 목록·트리·검색·상세 4탭, 파일 전송, 작업 큐+SSE, **PDF 뷰어 이식** |
| 4 · 워크플로 | **완료** — 반입·검수(상태 머신·업로드·검수·중복반출·병합본) + TDB 관리(폴더·자료 편집·보관함 2종) |
| 5 · 반출 | **완료** — 반출 실행·목록(자료별/Zip별)·반납처리·미입고·반입대상 |
| 6 · MDB | **완료** — MDB 조회·관리·Tag 이력. 보관함·폴더 기구를 TDB 와 공용화 |
| 7 · 운영 | 다음 — 시스템 로그 + 사용자·권한 + 백업 + 도움말 |
| 8 | 대기 |

### 알려진 제약

`packages/worker` (Python)는 코드만 있고 **이 개발 장비에서는 실행하지 못했다**
(`python3-venv`/`pip` 미설치, 설치 권한 없음). 큐 계약은 같은 SQL 로 도는
`db/tools/queue-smoke.mjs` 로 검증했다. 워커 실행 준비:

```bash
sudo apt install python3.12-venv
cd packages/worker && python3 -m venv .venv && .venv/bin/pip install -e .
```
