"""content-addressed 저장소 — API 쪽 core/blob.ts 와 같은 규칙을 쓴다."""

from __future__ import annotations

import errno
import hashlib
import os
import shutil
from pathlib import Path


def blob_path(blobs_root: Path, sha256_hex: str) -> Path:
    return blobs_root / sha256_hex[:2] / sha256_hex[2:4] / sha256_hex


def store_file(blobs_root: Path, src: Path) -> tuple[str, int]:
    """파일을 blob 저장소에 넣고 (sha256 hex, 바이트 수) 를 돌려준다.

    같은 내용이 이미 있으면 새로 쓰지 않는다. rename 은 같은 파일시스템에서 원자적이다.
    """
    digest = hashlib.sha256()
    size = 0
    with src.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)

    hex_digest = digest.hexdigest()
    dest = blob_path(blobs_root, hex_digest)
    if dest.exists():
        src.unlink(missing_ok=True)
        return hex_digest, size

    dest.parent.mkdir(parents=True, exist_ok=True)
    _move_into(src, dest)
    return hex_digest, size


def _move_into(src: Path, dest: Path) -> None:
    """docker 에서는 tmp 와 blobs 가 따로 마운트되어 os.replace 가 EXDEV 로 실패한다.
    그때는 최종 폴더 안 임시 이름으로 복사한 뒤 replace 한다 — 반쪽 파일이 최종 이름으로 보이지 않게.
    """
    try:
        os.replace(src, dest)
        return
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
    part = dest.with_name(f"{dest.name}.part-{os.getpid()}")
    try:
        shutil.copyfile(src, part)
        os.replace(part, dest)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    src.unlink(missing_ok=True)
