"""작업 종류별 처리기.

핸들러 서명:  (conn, cfg, payload, progress) -> result dict
  · 예외를 던지면 작업이 실패로 기록되고 max_attempts 까지 재시도된다
  · progress(퍼센트, 안내문) 를 부르면 화면이 SSE 로 받는다
  · 결과 dict 에 {filename, sha256, byteSize} 를 넣으면 화면에서 내려받을 수 있다
"""

from __future__ import annotations

from typing import Any, Callable

import psycopg

from ..config import Config
from . import excel

Handler = Callable[[psycopg.Connection, Config, dict[str, Any], Callable[..., None]], dict[str, Any]]

HANDLERS: dict[str, Handler] = {
    "excel_export": excel.run,
    # 이후 단계에서 추가: zip_build, backup, convert, bulk_import, mirror, gc
}
