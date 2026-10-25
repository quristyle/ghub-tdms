"""워커 설정. 운영에서는 systemd LoadCredential= 로 비밀값을 받는다."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _load_dotenv() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def _credential(name: str) -> str | None:
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not directory:
        return None
    path = Path(directory) / name
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


_load_dotenv()


@dataclass(frozen=True)
class Config:
    dsn: str
    schema: str
    storage_root: Path
    soffice: str
    oda: str
    convert_timeout: int
    poll_seconds: int = 30  # NOTIFY 를 놓쳤을 때를 대비한 안전망. 평소엔 쓰이지 않는다.

    @property
    def blobs(self) -> Path:
        return self.storage_root / "blobs"

    @property
    def tmp(self) -> Path:
        return self.storage_root / "tmp"


def load() -> Config:
    password = _credential("db-password") or os.environ.get("PGPASSWORD", "")
    host = os.environ["PGHOST"]
    port = os.environ.get("PGPORT", "5432")
    db = os.environ["PGDATABASE"]
    user = os.environ["PGUSER"]
    return Config(
        dsn=f"host={host} port={port} dbname={db} user={user} password={password}"
        " application_name=tdms-worker",
        schema=os.environ.get("PGSCHEMA", "public"),
        storage_root=Path(os.environ.get("STORAGE_ROOT", "/srv/tdms")),
        soffice=os.environ.get("PREVIEW_SOFFICE_PATH", "/usr/bin/soffice"),
        oda=os.environ.get("PREVIEW_ODA_PATH", ""),
        convert_timeout=int(os.environ.get("PREVIEW_TIMEOUT_SECONDS", "180")),
    )
