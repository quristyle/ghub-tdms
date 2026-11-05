"""백업 묶음 만들기.

고객 시스템(backup.py)은 화면에서 DB(pg_dump)·자료·코드를 한 묶음으로 만들고 사람이 내려받았다.
같은 일을 워커가 한다. 묶음은 blob 저장소가 아니라 BACKUP_ROOT 에 둔다 — 자료 전체(수 GB)를
blob 으로 한 벌 더 복사하지 않기 위해서다. 받기는 API 의 /backup/runs/:id/download 가 맡는다.

담는 것 (backup_runs.scope)
  · DB     — pg_dump(평문 SQL). 비밀번호 해시는 쓸 수 없는 값으로 바꾸고 다음 로그인 때
             변경하게 한다(고객 시스템도 덤프에서 해시를 치환했다). 세션·로그인 시도는 빼고 담는다.
  · FILES  — blob 파일. 전체 또는 변경분(직전 '자료 파일'이 든 백업 이후 들어온 것만).
  · CODE / WEB — 코드는 git 저장소가 정본이다. 이미지 태그(커밋)만 적어 둔다.

payload: {runId, kind, scope, storagePath, compressed}
"""

from __future__ import annotations

import os
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import psycopg

from .. import blob
from ..config import Config

UNUSABLE_HASH = "reset$backup$-$-"
SKIP_DATA = ("sessions", "login_attempts", "users")
USER_COLUMNS_SQL = """
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = %s AND table_name = 'users'
"""


def backup_root() -> Path:
    return Path(os.environ.get("BACKUP_ROOT", "/srv/tdms/backup"))


def _target_dir(storage_path: str | None) -> Path:
    """저장 위치는 BACKUP_ROOT 아래 하위 폴더로만 받는다 — 화면에서 서버의 아무 경로에나
    쓰게 두지 않는다."""
    root = backup_root().resolve()
    if not storage_path:
        return root
    rel = storage_path.strip().replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"저장 위치는 백업 폴더 아래여야 합니다: {storage_path}")
    return target


def _pg_dump(cfg: Config, out, *extra: str) -> None:
    args = ["pg_dump", "--no-owner", "--no-privileges", "--format=plain",
            f"--schema={cfg.schema}", *extra]
    proc = subprocess.run(args, stdout=out, stderr=subprocess.PIPE, timeout=3600)
    if proc.returncode != 0:
        raise RuntimeError("pg_dump 실패: " + proc.stderr.decode("utf-8", "replace")[-800:])


def _dump_db(cfg: Config, conn: psycopg.Connection, dest: Path) -> None:
    """구조 → 자료 → (사용자) → 제약·색인 순서로 쓴다. 사용자 행을 끝에 붙이면
    외래키가 먼저 걸려 복원이 실패하므로 post-data 앞에 끼운다."""
    schema = cfg.schema
    skip = [f"--exclude-table-data={schema}.{t}" for t in SKIP_DATA]
    with dest.open("wb") as out:
        _pg_dump(cfg, out, "--section=pre-data")
        out.flush()
        _pg_dump(cfg, out, "--section=data", *skip)
        out.flush()

        with conn.cursor() as cur:
            cur.execute(USER_COLUMNS_SQL, (schema,))
            cols = cur.fetchone()[0]
            select_cols = cols.replace("password_hash", f"'{UNUSABLE_HASH}'::text AS password_hash") \
                              .replace("must_change_password", "true AS must_change_password")
            out.write(
                "\n-- 사용자: 비밀번호 해시는 백업에 담지 않는다. 복원 후 비밀번호를 다시 정할 것.\n"
                f"COPY {schema}.users ({cols}) FROM stdin;\n".encode()
            )
            with cur.copy(f"COPY (SELECT {select_cols} FROM {schema}.users ORDER BY id) TO STDOUT") as cp:
                for chunk in cp:
                    out.write(bytes(chunk))
            out.write(b"\\.\n\n")
            out.flush()
        conn.commit()

        _pg_dump(cfg, out, "--section=post-data")


def _blob_rows(conn: psycopg.Connection, since: datetime | None) -> list[tuple[str, int]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT encode(sha256,'hex'), byte_size FROM blobs"
            " WHERE (%s::timestamptz IS NULL OR stored_at > %s::timestamptz) ORDER BY stored_at",
            (since, since),
        )
        return cur.fetchall()


def _last_files_backup(conn: psycopg.Connection, run_id: int) -> datetime | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT max(created_at) FROM backup_runs"
            " WHERE state IN ('READY','FILE_DELETED') AND 'FILES' = ANY(scope) AND id <> %s",
            (run_id,),
        )
        return cur.fetchone()[0]


def _set_run(conn: psycopg.Connection, run_id: int, **cols: Any) -> None:
    sets = ", ".join(f"{k} = %s" for k in cols)
    with conn.cursor() as cur:
        cur.execute(f"UPDATE backup_runs SET {sets} WHERE id = %s", (*cols.values(), run_id))
    conn.commit()


def run(
    conn: psycopg.Connection,
    cfg: Config,
    payload: dict[str, Any],
    progress: Callable[..., None],
) -> dict[str, Any]:
    run_id = int(payload["runId"])
    try:
        return _run(conn, cfg, payload, progress, run_id)
    except Exception:
        conn.rollback()
        _set_run(conn, run_id, state="FAILED")
        raise


def _run(conn, cfg, payload, progress, run_id) -> dict[str, Any]:
    scope = set(payload.get("scope") or [])
    kind = payload.get("kind") or "FULL"
    compressed = bool(payload.get("compressed", True))
    target_dir = _target_dir(payload.get("storagePath"))
    target_dir.mkdir(parents=True, exist_ok=True)
    _set_run(conn, run_id, state="PREPARING")

    with conn.cursor() as cur:
        cur.execute("SELECT seq FROM backup_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
    if row is None:
        raise ValueError(f"백업 회차가 없습니다: {run_id}")
    seq = row[0]

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    name = f"TDMS_백업_{'전체' if kind == 'FULL' else '변경분'}_{seq:03d}_{stamp}.zip"
    final = target_dir / name
    part = target_dir / f".{name}.part"
    method = zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED

    file_count = 0
    missing = 0
    try:
        with zipfile.ZipFile(part, "w", method, compresslevel=1 if compressed else None,
                             allowZip64=True) as zf:
            readme = [
                f"TDMS 백업 {seq}회차 ({'전체' if kind == 'FULL' else '변경분'})",
                f"만든 시각(UTC): {stamp}",
                f"담은 항목: {', '.join(sorted(scope))}",
                "",
            ]

            if "DB" in scope:
                progress(5, "DB 를 덤프하는 중")
                cfg.tmp.mkdir(parents=True, exist_ok=True)
                dump = cfg.tmp / f"backup-{run_id}-{stamp}.sql"
                try:
                    _dump_db(cfg, conn, dump)
                    zf.write(dump, "db/ghub_tdms.sql")
                finally:
                    dump.unlink(missing_ok=True)
                readme += [
                    "[DB] db/ghub_tdms.sql — psql -f 로 복원한다.",
                    "  사용자 비밀번호 해시는 담지 않았다. 복원 후 관리자가 비밀번호를 다시 정해야 한다.",
                    "  세션·로그인 시도 기록은 담지 않았다.",
                    "",
                ]

            if "FILES" in scope:
                since = _last_files_backup(conn, run_id) if kind == "INCREMENTAL" else None
                rows = _blob_rows(conn, since)
                total = len(rows) or 1
                for i, (sha, _size) in enumerate(rows, start=1):
                    src = blob.blob_path(cfg.blobs, sha)
                    if not src.exists():
                        missing += 1
                        continue
                    zf.write(src, f"blobs/{sha[:2]}/{sha[2:4]}/{sha}")
                    file_count += 1
                    if i % 50 == 0 or i == total:
                        progress(15 + int(80 * i / total), f"자료 파일 {i:,}/{len(rows):,}")
                readme += [
                    f"[자료 파일] blobs/ — {file_count:,}개"
                    + (f" (직전 백업 {since:%Y-%m-%d %H:%M} 이후 변경분)" if since else " (전체)"),
                    "  STORAGE_ROOT/blobs 아래에 같은 구조로 풀면 된다. 파일 이름이 내용의 sha256 이다.",
                    f"  DB 에는 있으나 디스크에 없던 파일: {missing}개" if missing else "",
                    "",
                ]

            if scope & {"CODE", "WEB"}:
                tag = os.environ.get("TAG") or os.environ.get("IMAGE_TAG") or "(알 수 없음)"
                readme += [
                    "[코드] 서버·화면 코드는 git 저장소(github.com/quristyle/ghub-tdms)가 정본이다.",
                    f"  이 백업 시점의 배포 태그: {tag}",
                    "",
                ]

            zf.writestr("README.txt", "\n".join(x for x in readme if x is not None))

        os.replace(part, final)
    except BaseException:
        part.unlink(missing_ok=True)
        raise

    size = final.stat().st_size
    rel = str(final.relative_to(backup_root().resolve()))
    _set_run(conn, run_id, state="READY", set_key=rel, byte_size=size,
             file_count=file_count, missing_count=missing)
    progress(100, f"{size / 1024 ** 2:,.1f} MB")
    return {"backupFile": rel, "byteSize": size, "fileCount": file_count, "missingCount": missing}
