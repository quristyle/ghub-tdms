"""비밀값(.env의 DB 비밀번호·로그인 서명키)이 파일에 섞여 나가지 않게 하는 규칙 — 한 곳에만 둔다.

쓰는 곳:
  - 보안 자동 검사(backend/security_check.py): 코드를 고칠 때마다 이 값이 적혀 들어갔는지 본다 (D-111).

생긴 사연: CM 질문("백업 기능을 쓰면 비밀번호는 노출 안 되는 거지?")을 확인하다가, DB 접속 비밀번호가
1회성 스크립트 2개와 .claude 설정에 **그대로 적혀 있어** 코드 묶음에 실려 나가는 것을 발견했다.
그 파일들은 그 자리에서 고쳤지만, 나중에 누가 또 코드에 비밀번호를 적으면 같은 일이 되풀이된다.

**값 자체는 어디에도 출력하지 않는다** — 화면·로그·검사 결과에는 "들어 있다"는 사실과 파일 이름만 적는다.
"""

import os

from sqlalchemy.engine import make_url

from app.config import DATABASE_URL


def secret_values() -> list[str]:
    """밖으로 나가면 안 되는 값들 — DB 접속 비밀번호와 로그인 서명키.

    .env를 직접 읽지 않고 이미 읽어 둔 설정에서 가져온다. 값이 짧으면(8자 미만) 우연히 다른
    글자와 겹쳐 멀쩡한 파일을 빼 버릴 수 있어 건너뛴다.
    """
    values = []
    try:
        pw = make_url(DATABASE_URL).password
        if pw:
            values.append(pw)
    except Exception:  # nosec B110 — 주소 모양이 이상하면 이 값만 건너뛰고 나머지(서명키 등)는 계속 본다
        pass
    for name in ("POSTGRES_PASSWORD", "SECRET_KEY"):
        val = os.environ.get(name, "")
        if val:
            values.append(val)
    return [v for v in dict.fromkeys(values) if len(v) >= 8]


def contains_secret(data: bytes, secrets: list[str]) -> bool:
    return any(v.encode("utf-8") in data for v in secrets)
