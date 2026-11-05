import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]
STORAGE_ROOT = os.environ["STORAGE_ROOT"]

# 백업 관리 화면이 만든 묶음을 두는 곳 (D-105). 비워 두면 프로젝트 폴더의 backup\백업묶음 을 쓴다.
# 외장하드에 바로 만들고 싶으면 여기에 그 경로를 적는다(예: E:\DMS백업).
BACKUP_ROOT = os.environ.get("BACKUP_ROOT") or str(
    (Path(__file__).resolve().parents[2] / "backup" / "백업묶음")
)

# DB를 뜨는 데 쓰는 pg_dump 실행 파일. 비워 두면 C:\Program Files\PostgreSQL 밑에서 찾는다.
PG_DUMP_PATH = os.environ.get("PG_DUMP_PATH") or ""

# 세션(로그인 상태) 쿠키에 찍는 서명용 비밀 키. 코드에 기본값을 두지 않는다 — 예전에는 없으면
# 코드에 적힌 고정값을 썼는데, 코드를 본 사람은 그 값으로 로그인을 위조할 수 있었다(2026-09-17).
# .env에 없거나 너무 짧으면 서버가 켜지지 않는다(main.py → security.require_secret_key).
SECRET_KEY = os.environ.get("SECRET_KEY", "")

# "전용 복도" — 여기 적힌 주소에서 온 접속만 받는다(2026-09-17 CM 지시). 쉼표로 여러 개를 적고,
# 203.0.113.0/24처럼 범위로도 적을 수 있다. 적지 않으면 이 컴퓨터 자신만 받는다.
ALLOWED_CLIENT_IPS = os.environ.get("ALLOWED_CLIENT_IPS", "127.0.0.1,::1")

# 서버 실행 설정(run_server.py가 읽는다). 이 컴퓨터에서만 쓰면 127.0.0.1 그대로 두고,
# 다른 컴퓨터에서 들어오게 하려면 SERVER_HOST=0.0.0.0으로 바꾼다.
SERVER_HOST = os.environ.get("SERVER_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("SERVER_PORT", "8000"))

# HTTPS 인증서 — 두 파일 경로를 모두 적으면 https로 실행되고, 로그인 쿠키도 https에서만 오가게 된다.
SSL_CERTFILE = os.environ.get("SSL_CERTFILE", "")
SSL_KEYFILE = os.environ.get("SSL_KEYFILE", "")
HTTPS_ENABLED = bool(SSL_CERTFILE and SSL_KEYFILE)

# 원본(DWG·엑셀·워드·PPT) 미리보기 변환 도구 (D-102). 전부 이 컴퓨터 안에서 돈다 — 외부 호출 없음.
# 오피스 변환 엔진: libreoffice(운영 서버 기본) / msoffice(로컬 시험용 — 회사 PC는 문서보안 프로그램이
# LibreOffice를 막아서 설치된 MS 엑셀로 대신 시험한다. 워드는 자동 변환이 멈춰 msoffice에서는 안 된다).
# .env에 칸만 있고 값이 비어 있어도 기본값을 쓰도록 `or`로 받는다.
PREVIEW_OFFICE_ENGINE = (os.environ.get("PREVIEW_OFFICE_ENGINE") or "libreoffice").strip().lower()
PREVIEW_SOFFICE_PATH = (
    os.environ.get("PREVIEW_SOFFICE_PATH") or r"C:\Program Files\LibreOffice\program\soffice.com"
)
# 비워 두면 C:\Program Files\ODA 밑에서 가장 최근 버전을 찾아 쓴다.
PREVIEW_ODA_PATH = os.environ.get("PREVIEW_ODA_PATH") or ""
# 한 파일을 바꾸는 데 이보다 오래 걸리면 멈추고 "미리보기를 만들 수 없음"으로 안내한다.
# 서버 시험에서 큰 엑셀이 52초 걸렸으므로 넉넉히 잡는다.
PREVIEW_TIMEOUT_SECONDS = int(os.environ.get("PREVIEW_TIMEOUT_SECONDS") or "180")
