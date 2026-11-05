"""접속 보안 관문 — 모든 요청이 화면·API에 닿기 전에 한 번씩 거친다 (2026-09-17 CM 지시).

Azure(외부 클라우드)에 시험 설치하기 전에 넣은 시큐어코딩 항목이다. 셋 다 개별 화면·API 코드와
상관없이 main.py에서 한 줄씩 붙이기만 하면 전체에 걸린다.

1) 허용 주소 검사 — ClientAddressAllowlistMiddleware ("전용 복도")
   .env의 ALLOWED_CLIENT_IPS에 적힌 주소(회사 인터넷 주소 등)에서 온 요청만 통과시킨다.
   목록에 없는 곳에서 오면 로그인 화면조차 내주지 않는다. Azure 방화벽(NSG)에도 같은 주소만
   열어 두는데, 방화벽 설정을 실수해도 여기서 한 번 더 막히도록 겹으로 둔다.
   **주의**: 서버 앞에 중계 프로그램(리버스 프록시)을 두면 모든 요청이 그 프로그램의 주소
   (보통 127.0.0.1)에서 온 것으로 보여 이 검사가 무의미해진다. 그렇게 바꿀 때는 이 검사도
   같이 다시 설계해야 한다.

2) 보안 머리글 — SecurityHeadersMiddleware
   브라우저에게 "이 사이트 파일만 실행하라(Content-Security-Policy)", "다른 사이트가 이 화면을
   틀 안에 넣지 못하게 하라" 같은 규칙을 알려준다. 화면 코드에서 글자를 빠뜨리고 안전하게
   바꾸지 못한 곳이 남아 있더라도, 남이 심어 넣은 스크립트가 실행되지 않게 막는 두 번째 자물쇠다.

3) 다른 사이트에서 보낸 쓰기 요청 막기 — SameOriginWriteMiddleware
   로그인해 둔 브라우저로 다른 사이트를 열었을 때, 그 사이트가 몰래 이 시스템에 저장·삭제
   요청을 보내는 것(CSRF)을 막는다. 브라우저가 붙여 보내는 Origin(요청을 보낸 사이트 주소)이
   이 서버 주소와 다르면 거절한다.
"""

import ipaddress
import logging
from urllib.parse import urlsplit

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import PlainTextResponse

logger = logging.getLogger("uvicorn.error")

MIN_SECRET_KEY_LENGTH = 32


def require_secret_key(secret_key: str) -> None:
    """세션 서명 키가 .env에 제대로 들어 있지 않으면 서버를 켜지 않는다.

    예전에는 없으면 코드에 적힌 고정값을 썼는데, 코드를 본 사람은 누구든 그 값으로 로그인
    쿠키를 위조할 수 있어 없앴다. 키 만드는 방법은 .env.example에 적어 두었다.
    """
    if len(secret_key) < MIN_SECRET_KEY_LENGTH:
        raise RuntimeError(
            f"SECRET_KEY in .env is missing or shorter than {MIN_SECRET_KEY_LENGTH} characters. "
            "See .env.example for how to create one."
        )


def parse_allowed_networks(raw: str) -> list:
    """ALLOWED_CLIENT_IPS("127.0.0.1, 203.0.113.0/24" 처럼 쉼표로 구분)를 주소 범위 목록으로 바꾼다.

    잘못 적힌 값이 있으면 조용히 건너뛰지 않고 서버를 켜지 않는다 — 건너뛰면 CM이 의도한 주소가
    막혀 있는데도 이유를 알 수 없기 때문이다. 목록이 비어 있어도 마찬가지다(아무도 못 들어온다).
    """
    networks = []
    for item in raw.replace(";", ",").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            raise RuntimeError(f"ALLOWED_CLIENT_IPS in .env has an invalid address: {item!r}")
    if not networks:
        raise RuntimeError("ALLOWED_CLIENT_IPS in .env is empty. Nobody could connect.")
    return networks


def is_allowed_address(host, networks) -> bool:
    """접속한 주소(host)가 허용 범위 안에 있는지. 주소로 읽히지 않는 값은 막는다."""
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host.split("%", 1)[0])  # IPv6 주소 끝의 "%인터페이스" 표시는 뗀다
    except ValueError:
        return False
    # IPv4·IPv6를 함께 받도록 서버를 띄우면 IPv4 주소가 "::ffff:1.2.3.4" 모양으로 들어온다
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip in network for network in networks)


class ClientAddressAllowlistMiddleware:
    """허용 주소 검사 (위 1번)."""

    def __init__(self, app, allowed_networks: list):
        self.app = app
        self.allowed_networks = allowed_networks

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        host = client[0] if client else None
        if is_allowed_address(host, self.allowed_networks):
            await self.app(scope, receive, send)
            return

        # 누가 막혔는지 서버 기록(server.log)에 남긴다 — "왜 접속이 안 되느냐"를 찾을 때 본다.
        logger.warning("Blocked request from address not in ALLOWED_CLIENT_IPS: %s %s", host, scope.get("path"))
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        response = PlainTextResponse("허용되지 않은 위치에서 접속했습니다.", status_code=403)
        await response(scope, receive, send)


# 이 사이트에서 온 파일만 쓰게 한다. PDF 미리보기(PDF.js)가 쓰는 것까지 고려한 값이다.
#   'wasm-unsafe-eval' : PDF.js가 일부 도면 이미지(JPEG2000 등)를 풀 때 쓰는 WebAssembly
#   blob:              : PDF.js의 작업용 스레드, 다운로드·인쇄용 임시 파일
#   data:              : 화면 아이콘·도장 그림 등 문자열로 들어 있는 그림
#   'unsafe-inline'(style) : 화면 코드가 칸 너비 등을 style 속성으로 바로 적는 곳이 많다(스크립트가 아니라 모양만)
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])


class SecurityHeadersMiddleware:
    """보안 머리글 (위 2번). 응답이 이미 같은 머리글을 갖고 있으면 그 값을 존중한다."""

    def __init__(self, app, https_enabled: bool):
        self.app = app
        self.headers = [
            ("Content-Security-Policy", CONTENT_SECURITY_POLICY),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "SAMEORIGIN"),
            ("Referrer-Policy", "same-origin"),
        ]
        if https_enabled:
            # 한 번 https로 접속한 브라우저는 앞으로 이 주소를 http로 열지 않는다(1년)
            self.headers.append(("Strict-Transport-Security", "max-age=31536000"))

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in self.headers:
                    headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)


WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def is_same_origin(origin: str, host) -> bool:
    """Origin 머리글("https://서버주소")이 이 서버 주소(Host 머리글)와 같은지."""
    if not host or not origin or origin == "null":
        return False
    return urlsplit(origin).netloc.lower() == host.lower()


class SameOriginWriteMiddleware:
    """다른 사이트에서 보낸 쓰기 요청 막기 (위 3번).

    요즘 브라우저는 쓰기 요청(POST 등)에 Origin을 반드시 붙이므로, Origin이 있는데 이 서버와
    다르면 거절한다. Origin이 아예 없는 요청은 브라우저가 아닌 프로그램이 보낸 것이라 여기서
    막지 않는다(그런 요청에는 로그인 쿠키가 따라오지 않아 어차피 로그인 검사에서 걸린다).
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] in WRITE_METHODS:
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            if origin is not None and not is_same_origin(origin, headers.get("host")):
                logger.warning("Blocked cross-site %s %s from origin %s", scope["method"], scope.get("path"), origin)
                response = PlainTextResponse("다른 사이트에서 보낸 요청은 처리하지 않습니다.", status_code=403)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
