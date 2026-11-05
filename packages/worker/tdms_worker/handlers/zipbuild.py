"""Zip 묶기 — TDB 반출, MDB 다운대기함, 삭제 보관함 묶음 다운로드.

고객 시스템은 요청 스레드에서 zipfile 로 묶어 바로 내려줬다(distributions.py download-zip,
mdb.py download-zip, editor.py trash/{id}/download). 수백 건이면 화면이 멈췄다.
여기서는 워커가 묶어 blob 으로 넣고, 화면은 /jobs/:id/download 로 받는다.

payload
  · TDB 반출      {zipName, documentIds, keepPaths, vendorName}
  · MDB 다운로드  {kind: 'MDB', fileIds}
  · 보관함 묶음   {kind: 'TRASH', docClass: 'TDB'|'MDB', batchId}

TDB 반출 Zip 에는 반출목록.xlsx 를 함께 넣는다 — 업체가 수정본을 같은 Zip 꼴로 돌려보내면
반입(Zip)이 이 목록의 문서ID·업체로 어느 반출 건인지 정확히 고른다(고객 시스템 parse_manifest_rows).
"""

from __future__ import annotations

import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import psycopg
from openpyxl import Workbook

from .. import blob
from ..config import Config
from .excel import neutralize

MANIFEST_NAME = "반출목록.xlsx"

# 폴더 경로는 ltree(id 라벨)라 이름으로 풀어 쓴다.
FOLDER_PATH_SQL = """
    (SELECT string_agg(a.name, '/' ORDER BY a.depth)
       FROM folders a WHERE a.path @> f.path)
"""


def _safe(name: str) -> str:
    """Zip 안 이름 — 경로 구분자·상위 이동이 섞이지 않게 한다."""
    cleaned = name.replace("\\", "_").replace("/", "_").strip()
    return cleaned.lstrip(".") or "_"


def _arcname(folder_path: str | None, filename: str, keep_paths: bool) -> str:
    if not keep_paths or not folder_path:
        return _safe(filename)
    parts = [_safe(p) for p in folder_path.split("/") if p.strip()]
    return "/".join([*parts, _safe(filename)])


def _tdb_entries(conn: psycopg.Connection, payload: dict[str, Any]) -> tuple[list[tuple], list[list]]:
    ids = [int(x) for x in payload.get("documentIds") or []]
    keep = bool(payload.get("keepPaths", True))
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT d.id, d.drawing_no, d.title, d.current_rev, {FOLDER_PATH_SQL} AS folder_path,
                   encode(fl.blob_sha256, 'hex'), fl.display_name
              FROM documents d
              JOIN folders f ON f.id = d.folder_id
              JOIN files fl ON fl.document_id = d.id AND fl.is_current
             WHERE d.id = ANY(%s)
             ORDER BY folder_path, d.drawing_no, fl.file_ext
            """,
            (ids,),
        )
        rows = cur.fetchall()

    entries = [(sha, _arcname(path, name, keep)) for (_i, _n, _t, _r, path, sha, name) in rows]
    vendor = payload.get("vendorName") or ""
    manifest: dict[int, list] = {}
    for doc_id, drawing_no, title, rev, path, _sha, _name in rows:
        manifest.setdefault(doc_id, [doc_id, drawing_no, title, f"Rev{rev:02d}", path or "", vendor])
    return entries, list(manifest.values())


def _mdb_entries(conn: psycopg.Connection, file_ids: list[int], keep: bool) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT encode(m.blob_sha256, 'hex'), m.display_name, {FOLDER_PATH_SQL} AS folder_path
              FROM mdb_files m
              JOIN folders f ON f.id = m.folder_id
             WHERE m.id = ANY(%s)
             ORDER BY folder_path, m.display_name
            """,
            (file_ids,),
        )
        return [(sha, _arcname(path, name, keep)) for sha, name, path in cur.fetchall()]


def _trash_entries(conn: psycopg.Connection, payload: dict[str, Any]) -> list[tuple]:
    batch_id = int(payload["batchId"])
    if payload.get("docClass") == "MDB":
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM mdb_files WHERE archive_batch_id = %s", (batch_id,))
            ids = [r[0] for r in cur.fetchall()]
        return _mdb_entries(conn, ids, True)
    with conn.cursor() as cur:
        # 삭제 보관함은 자료째 묶여 있으므로 그 자료의 모든 Rev 파일을 담는다(이력까지 되살릴 수 있게).
        cur.execute(
            f"""
            SELECT encode(fl.blob_sha256, 'hex'), fl.display_name, {FOLDER_PATH_SQL} AS folder_path,
                   fl.is_current
              FROM documents d
              JOIN folders f ON f.id = d.folder_id
              JOIN files fl ON fl.document_id = d.id
             WHERE d.archive_batch_id = %s AND fl.review_status IN ('APPROVED','MERGED')
             ORDER BY folder_path, fl.display_name
            """,
            (batch_id,),
        )
        out = []
        for sha, name, path, current in cur.fetchall():
            folder = path if current else f"{path or ''}/이력"
            out.append((sha, _arcname(folder, name, True)))
        return out


def _write_manifest(path: Path, rows: list[list]) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "반출목록"
    ws.append(["문서ID", "자료명", "내용", "반출Rev", "폴더", "업체"])
    for r in rows:
        ws.append([neutralize(v) for v in r])
    wb.save(path)


def run(
    conn: psycopg.Connection,
    cfg: Config,
    payload: dict[str, Any],
    progress: Callable[..., None],
) -> dict[str, Any]:
    kind = payload.get("kind") or "TDB"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    manifest: list[list] = []

    progress(2, "담을 파일을 고르는 중")
    if kind == "MDB":
        entries = _mdb_entries(conn, [int(x) for x in payload.get("fileIds") or []], True)
        filename = payload.get("zipName") or f"MDB_다운로드_{stamp}.zip"
    elif kind == "TRASH":
        entries = _trash_entries(conn, payload)
        filename = payload.get("zipName") or f"삭제보관함_{payload['batchId']}_{stamp}.zip"
    else:
        entries, manifest = _tdb_entries(conn, payload)
        filename = payload.get("zipName") or f"반출_{stamp}.zip"
    if not filename.lower().endswith(".zip"):
        filename += ".zip"

    if not entries:
        raise ValueError("묶을 파일이 없습니다")

    cfg.tmp.mkdir(parents=True, exist_ok=True)
    tmp_path = cfg.tmp / f"zip-{stamp}-{abs(hash(filename)) % 10**8}.zip"
    used: set[str] = set()
    missing = 0
    try:
        # DWG·PDF 는 이미 압축된 꼴이 많지만 DWG 는 꽤 줄어든다. 수준은 낮게 — 속도가 먼저다.
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
            if manifest:
                mpath = cfg.tmp / f"manifest-{stamp}.xlsx"
                _write_manifest(mpath, manifest)
                zf.write(mpath, MANIFEST_NAME)
                mpath.unlink(missing_ok=True)
            total = len(entries)
            for i, (sha, arc) in enumerate(entries, start=1):
                src = blob.blob_path(cfg.blobs, sha)
                if not src.exists():
                    missing += 1
                    continue
                name, n = arc, 2
                while name.lower() in used:   # 같은 이름이 둘이면 뒤에 번호를 붙인다
                    stem, dot, ext = arc.rpartition(".")
                    name = f"{stem}({n}).{ext}" if dot else f"{arc}({n})"
                    n += 1
                used.add(name.lower())
                zf.write(src, name)
                if i % 20 == 0 or i == total:
                    progress(5 + int(85 * i / total), f"{i:,}/{total:,}개 담음")

        if missing == len(entries):
            raise ValueError("저장소에서 파일을 찾지 못했습니다")

        progress(95, "저장소에 넣는 중")
        sha_hex, size = blob.store_file(cfg.blobs, tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO blobs (sha256, byte_size) VALUES (decode(%s,'hex'), %s)"
            " ON CONFLICT (sha256) DO NOTHING",
            (sha_hex, size),
        )
        # 반출 Zip 은 [Zip 다운] 으로 다시 받을 수 있어야 한다 — 반출 행에 묶음을 적어 둔다.
        if kind == "TDB" and payload.get("zipName"):
            cur.execute(
                "UPDATE distributions SET blob_sha256 = decode(%s,'hex')"
                " WHERE zip_name = %s AND blob_sha256 IS NULL",
                (sha_hex, payload["zipName"]),
            )
            if cur.rowcount:
                cur.execute(
                    "UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = decode(%s,'hex')",
                    (sha_hex,),
                )
    conn.commit()

    note = f"{len(entries) - missing:,}개 파일" + (f" (없는 파일 {missing}개 제외)" if missing else "")
    progress(100, note)
    return {"filename": filename, "sha256": sha_hex, "byteSize": size,
            "fileCount": len(entries) - missing, "missingCount": missing}
