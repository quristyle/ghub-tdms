"""TDMS 서버 실행 (2026-09-17, Azure 시험 설치 대비).

설정은 전부 .env에서 읽는다 — 이 파일은 고칠 필요가 없다.
  SERVER_HOST   받을 주소. 이 컴퓨터에서만 쓰면 127.0.0.1, 다른 컴퓨터에서도 들어오게 하려면 0.0.0.0
  SERVER_PORT   포트 번호 (기본 8000. https로 쓰면 보통 443)
  SSL_CERTFILE  https 인증서 파일 경로 ┐ 둘 다 적으면 https로 실행된다
  SSL_KEYFILE   https 인증서 키 파일 경로 ┘
  ALLOWED_CLIENT_IPS  접속을 받을 주소 목록 ("전용 복도", app/security.py)

사용법 (backend 폴더에서):
    venv\\Scripts\\python.exe run_server.py
"""

import uvicorn

from app.config import SERVER_HOST, SERVER_PORT, SSL_CERTFILE, SSL_KEYFILE


def main():
    uvicorn.run(
        "app.main:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        ssl_certfile=SSL_CERTFILE or None,
        ssl_keyfile=SSL_KEYFILE or None,
        # 서버 앞에 중계 프로그램(리버스 프록시)을 두지 않으므로 요청 머리글에 적힌 "원래 접속 주소"를
        # 믿지 않는다. 믿으면 누구나 그 머리글을 꾸며 허용 주소 검사를 통과할 수 있다.
        proxy_headers=False,
        # 응답에 "uvicorn"이라는 서버 프로그램 이름을 싣지 않는다(공격에 쓸 정보를 줄인다).
        server_header=False,
    )


if __name__ == "__main__":
    main()
