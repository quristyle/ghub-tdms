"""TDMS 워커 — 장시간 작업 실행기.

기존 시스템은 엑셀 17종·Zip·백업·DWG 변환을 요청 스레드에서 동기 실행해서
큰 건은 화면이 수십 초 멈췄다. 여기서는 전부 이 워커가 받는다.

동작
  · PostgreSQL LISTEN 'job_enqueued' 로 깨어난다 (폴링하지 않는다)
  · SELECT ... FOR UPDATE SKIP LOCKED 로 하나를 집는다 (워커를 여럿 띄워도 경쟁이 없다)
  · 진행률을 jobs.progress 에 적으면 화면이 SSE 로 받는다
  · heartbeat 를 갱신한다. 2분 이상 끊기면 다른 워커가 좀비로 보고 되돌린다

실행: python -m tdms_worker --id 1
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
import traceback
from typing import Any

import psycopg
from psycopg.rows import dict_row

from . import config
from .handlers import HANDLERS

log = logging.getLogger("tdms.worker")

CLAIM_SQL = """
UPDATE jobs
   SET state = 'running', locked_by = %s, heartbeat_at = now(),
       started_at = coalesce(started_at, now()), attempts = attempts + 1
 WHERE id = (SELECT id FROM jobs
              WHERE state = 'queued'
              ORDER BY priority, id
                FOR UPDATE SKIP LOCKED
              LIMIT 1)
RETURNING id, kind, payload, attempts, max_attempts, requested_by
"""

_stop = threading.Event()


class Progress:
    """핸들러가 진행률을 보고하는 창구. 하트비트도 같이 갱신한다."""

    def __init__(self, conn: psycopg.Connection, job_id: int) -> None:
        self._conn = conn
        self._job_id = job_id
        self._last = -1

    def __call__(self, percent: int, note: str | None = None) -> None:
        percent = max(0, min(100, int(percent)))
        # 같은 값을 반복해서 쓰지 않는다 — 쓰기 증폭을 막는다
        if percent == self._last and note is None:
            return
        self._last = percent
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE jobs SET progress = %s, progress_note = coalesce(%s, progress_note),"
                " heartbeat_at = now() WHERE id = %s",
                (percent, note, self._job_id),
            )
        self._conn.commit()


def run_one(conn: psycopg.Connection, cfg: config.Config, worker_id: str) -> bool:
    """큐에서 하나를 집어 처리한다. 집을 것이 없으면 False."""
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(CLAIM_SQL, (worker_id,))
        job: dict[str, Any] | None = cur.fetchone()
    conn.commit()

    if job is None:
        return False

    job_id = job["id"]
    kind = job["kind"]
    log.info("작업 시작 id=%s kind=%s (시도 %s/%s)", job_id, kind, job["attempts"], job["max_attempts"])

    handler = HANDLERS.get(kind)
    if handler is None:
        _fail(conn, job_id, f"알 수 없는 작업 종류: {kind}", retry=False)
        return True

    try:
        result = handler(conn, cfg, job["payload"], Progress(conn, job_id))
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE jobs SET state='done', progress=100, result=%s, finished_at=now(),"
                " error=NULL WHERE id=%s",
                (psycopg.types.json.Json(result or {}), job_id),
            )
        conn.commit()
        log.info("작업 완료 id=%s", job_id)
    except Exception as exc:  # noqa: BLE001 — 어떤 실패든 작업만 실패시키고 워커는 살린다
        log.exception("작업 실패 id=%s", job_id)
        retry = job["attempts"] < job["max_attempts"]
        _fail(conn, job_id, f"{exc}\n{traceback.format_exc(limit=3)}", retry=retry)

    return True


def _fail(conn: psycopg.Connection, job_id: int, message: str, *, retry: bool) -> None:
    conn.rollback()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET state=%s, error=%s, locked_by=NULL,"
            " finished_at = CASE WHEN %s THEN NULL ELSE now() END WHERE id=%s",
            ("queued" if retry else "failed", message[:4000], retry, job_id),
        )
    conn.commit()


def revive_zombies(conn: psycopg.Connection) -> None:
    """하트비트가 끊긴 running 작업을 큐로 되돌린다."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE jobs
                  SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
                      error = CASE WHEN attempts >= max_attempts
                                   THEN '워커가 응답하지 않아 중단되었습니다' ELSE error END,
                      locked_by = NULL
                WHERE state = 'running' AND heartbeat_at < now() - interval '2 minutes'"""
        )
        if cur.rowcount:
            log.warning("좀비 작업 %s건 회수", cur.rowcount)
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(prog="tdms_worker")
    parser.add_argument("--id", default="1", help="워커 식별자 (systemd 인스턴스 번호)")
    parser.add_argument("--once", action="store_true", help="큐를 한 번만 비우고 종료")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )

    cfg = config.load()
    worker_id = f"worker-{args.id}"

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: _stop.set())

    with psycopg.connect(cfg.dsn, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute(f"SET search_path TO {cfg.schema}, public")
        conn.commit()

        log.info("워커 시작 %s (스키마 %s)", worker_id, cfg.schema)
        revive_zombies(conn)

        # 큐에 남아 있던 것을 먼저 비운다
        while run_one(conn, cfg, worker_id):
            if _stop.is_set():
                break

        if args.once:
            return 0

        # 이후에는 NOTIFY 로 깨어난다. poll_seconds 는 알림을 놓쳤을 때의 안전망.
        with conn.cursor() as cur:
            cur.execute("LISTEN job_enqueued")
        conn.commit()

        while not _stop.is_set():
            got_any = False
            for _ in conn.notifies(timeout=cfg.poll_seconds, stop_after=1):
                got_any = True
            # 알림이 왔든 타임아웃이든 큐를 비운다
            _ = got_any
            while run_one(conn, cfg, worker_id):
                if _stop.is_set():
                    break
            revive_zombies(conn)

        log.info("워커 종료 %s", worker_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
