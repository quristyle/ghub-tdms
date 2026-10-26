# 운영 배포 — tdms.jsini.co.kr

운영서버: `ssh lee@jin114.co.kr -p 31010` (호스트명 `han`, Ubuntu 24)

배포는 **main 에 푸시하면 끝**이다. GitHub 러너가 이미지를 굽고, han 에 등록된
자체 호스팅 러너가 받아서 올린다. 사람이 손대는 자리는 아래 「첫 설치」뿐이다.

```
git push origin main
  └─ verify : typecheck · test · build            (GitHub 러너)
  └─ build  : api·web·worker 이미지 → GHCR         (GitHub 러너, 3개 병렬)
  └─ release: pull → migrate → up -d → health 확인 (han, 자체 호스팅 러너)
                                        └ 실패하면 직전 TAG 로 자동 롤백
```

## 구성

```
            443 ────────────────────────────────┐
  인터넷 ──▶ 호스트 nginx (TLS 만 벗긴다)        │
            tdms.jsini.co.kr                    │
                     │ proxy_pass 127.0.0.1:5570│
                     ▼                          │
            ┌─ web 컨테이너 (nginx) ────────────┴──────────┐
            │  /            SPA 정적 파일                   │
            │  /api/   ──▶  api:8080  (앞의 /api 는 뗀다)   │
            │  /_blob/      internal · 커널 sendfile 직송    │
            └───────────────┬───────────────────────────────┘
                            │
                   ┌────────┴────────┐
                   ▼                 ▼
              api 컨테이너      worker 컨테이너
              (포트 없음)        (포트 없음, 큐는 DB)
                   └────────┬────────┘
                            ▼
              PostgreSQL 16  host.docker.internal:31015 / ghub_tdms
```

호스트 루프백에 내놓는 포트는 **5570 하나뿐**이다. api·worker 는 포트를 열지 않는다.

웹 컨테이너 안에 nginx 를 둔 까닭:
- X-Accel-Redirect 직송은 **응답을 받은 nginx** 가 처리한다. blob 볼륨을 그 컨테이너에
  붙여 두면 호스트 `www-data` 가 컨테이너가 쓴 파일을 읽을 수 있는지 따질 일이 없다.
- 화면·API·파일직송이 한 태그로 함께 움직인다 → 롤백이 쪼개지지 않는다.
- 호스트 `/etc/nginx` 에 들어가는 설정이 최소가 된다 → **sudo 가 필요한 자리가 준다.**

## 첫 설치 (한 번만)

### 1. DNS  — 외부 작업
`tdms.jsini.co.kr` A 레코드 → `175.200.10.40`

### 2. 디렉터리와 비밀값  — `lee` 로, sudo 는 첫 줄만

```bash
sudo mkdir -p /srv/tdms && sudo chown lee:lee /srv/tdms   # ← sudo 필요
mkdir -p /srv/tdms/{blobs,tmp,backup,.docker}
umask 077
cat > /srv/tdms/.env <<'ENV'
TAG=latest
PGHOST=host.docker.internal
PGPORT=31015
PGDATABASE=ghub_tdms
PGUSER=ghub_tdms
PGPASSWORD=여기에_실제_암호
PGSCHEMA=ghub_tdms
PG_POOL_MAX=16
SESSION_SECRET=여기에_openssl_rand_hex_32_결과
SESSION_TTL_HOURS=12
LOG_LEVEL=info
ENV
chmod 600 /srv/tdms/.env
```

`SESSION_SECRET` 은 **새로 뽑는다**(`openssl rand -hex 32`). 개발 값을 그대로 쓰면
개발에서 만든 세션 쿠키가 운영에서도 통한다.

### 3. 자체 호스팅 러너 추가  — `lee` 로, sudo 없음

기존 러너(`/srv/jsini/runner`)는 **Funeralv2 저장소 전용**이다. 건드리지 말고 하나 더 깐다.
라벨에 `tdms` 를 반드시 넣는다 — 배포 잡이 `runs-on: [self-hosted, tdms]` 로 집는다.

```bash
mkdir -p /srv/tdms/runner && cd /srv/tdms/runner
# 저장소 Settings → Actions → Runners → New self-hosted runner 에서 받은
# 내려받기·config 명령을 그대로 실행한다. 이름 tdms-prod, 라벨에 tdms 추가.
./config.sh --url https://github.com/quristyle/ghub-tdms --token <발급토큰> \
            --name tdms-prod --labels tdms --work _work --unattended
sudo ./svc.sh install lee && sudo ./svc.sh start                 # ← sudo 필요
```

### 4. nginx  — 전부 sudo

```bash
sudo certbot --nginx -d tdms.jsini.co.kr                          # ← sudo 필요
sudo cp deploy/nginx/tdms.jsini.co.kr.conf /etc/nginx/sites-available/
sudo ln -sfn /etc/nginx/sites-available/tdms.jsini.co.kr.conf \
             /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

certbot 이 vhost 를 먼저 만들어 버리므로, **인증서를 받은 뒤 이 파일로 덮어쓴다.**
기존 12개 사이트 설정은 건드리지 않는다.

### 5. 첫 배포

main 에 푸시하면 자동으로 돈다. 손으로 돌리려면 Actions → 배포 → Run workflow.

## 평소 운영

| 하려는 일 | 방법 |
|---|---|
| 배포 | main 에 푸시 |
| 특정 버전 배포·롤백 | Actions → 배포 → Run workflow → 태그에 옛 커밋 SHA |
| 지금 뭐가 떠 있나 | `grep TAG= /srv/tdms/.env` |
| 로그 | `cd /srv/tdms && docker compose logs -f api` |
| 워커 늘리기 | compose 의 `worker.deploy.replicas` ↑ (큐가 SKIP LOCKED 라 중복 처리 없음) |
| 긴급 수동 빌드 | 서버에서 `docker build -f deploy/docker/Dockerfile.api .` — BuildKit 전용 문법을 안 썼다 |

## 알아 둘 것

- **운영과 개발이 같은 DB 다**(`ghub_tdms` @ 31015). 개발에서 돌린 마이그레이션·시드가
  그대로 운영에 보인다. 분리하려면 DB 를 새로 만들고 `/srv/tdms/.env` 의 `PGDATABASE`
  만 바꾸면 된다 — 배포 쪽은 고칠 데가 없다.
- PostgreSQL 이 `0.0.0.0:31015` 로 바깥에 열려 있다. 운영 전환 뒤에는 접근 제한을 권한다.
- `client_max_body_size 2g` 는 **호스트 nginx 와 웹 컨테이너 양쪽**에 있다. 한쪽만
  올리면 작은 쪽에서 413 이 난다.
- 변환(DWG·오피스) 핸들러가 붙으면 worker 이미지에 LibreOffice 를 더해야 한다.
  ODA File Converter 는 재배포가 막혀 있어 이미지에 굽지 못한다 — 호스트에 두고
  볼륨으로 붙인 뒤 `PREVIEW_ODA_PATH` 로 가리킨다.
- `deploy/systemd/`, `deploy/nginx/_참고-단독설치.conf` 는 컨테이너를 쓰지 않는
  단독 설치용 참고본이다. 지금 운영 경로는 컨테이너다.

## sudo 가 필요한 작업 — 사람이 해야 하는 것 전부

han 의 `lee` 는 sudo 에 암호를 요구한다. 자동화가 닿지 않는 자리는 아래 넷뿐이다.

1. `sudo mkdir -p /srv/tdms && sudo chown lee:lee /srv/tdms`
2. `sudo ./svc.sh install lee && sudo ./svc.sh start` (러너를 서비스로 등록)
3. `sudo certbot --nginx -d tdms.jsini.co.kr`
4. `sudo cp … /etc/nginx/sites-available/` · `ln -s` · `nginx -t` · `systemctl reload nginx`

이 넷이 끝나면 이후 배포는 sudo 없이 돈다(`lee` 가 docker 그룹에 있다).
