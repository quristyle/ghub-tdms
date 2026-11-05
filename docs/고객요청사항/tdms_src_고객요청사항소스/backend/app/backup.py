"""백업 만들기 — 무엇을 담고 어떻게 묶는지를 여기 한 곳에 둔다 (2026-09-29 CM 지시, D-105).

원칙 12·D-18의 "백업 기능을 만들지 않는다"를 CM이 이번에 폐기했다. 만드는 목적은 하나다 —
**운영 서버가 고장날 때를 대비해 그 시점 자료를 서버 밖(CM PC·유지보수 업체)으로 빼두는 것.**
그래서 이 기능은 "서버에서 묶음을 만들고 → 사람이 내려받는다"는 두 단계로 되어 있다.

## 왜 두 단계인가 (스트리밍으로 곧바로 내려보내지 않는 이유)

받는 사람은 인터넷을 지나 내려받는다. 2026-09-18에 도면 10GB를 로컬→서버로 올릴 때 1시간이
걸렸으니(초당 1.6~3.4MB), 받는 방향이 더 빠르다 해도 10분~1시간을 봐야 한다. 그렇게 긴
다운로드가 한 번도 끊기지 않아야 한다면 위험하다. **먼저 서버 디스크에 파일로 만들어 두면
끊겨도 이어받을 수 있다**(routers/backup.py의 Range 처리). 부수 효과도 둘이다.
  ㉠ 한 번 만든 묶음을 CM과 업체가 각각 받아도 서버는 한 번만 일한다.
  ㉡ "그 시점의 스냅샷"이 되어, 자료가 계속 바뀌는 운영 서버에서도 DB와 파일의 시점이 어긋나지 않는다.

## 분류 — CM이 말한 5개에서 4개(+정보 1개)가 됐다

CM이 처음 말한 분류는 도면자료·시스템자료·민감시스템자료·이력자료·외부프로그램이었다.
그중 **"이력자료"는 따로 뽑을 수 없다** — 반출·반입·검수·수정 기록은 별도 파일이 아니라 도면
목록과 같은 DB 안에 있고 서로 연결돼 있어, 이력만 떼어내면 되살릴 때 "기록이 가리키는 도면이
없는" 상태가 된다. 그래서 DB는 언제나 통째로 하나가 한 항목이 된다.
**"민감시스템자료"도 없앴다** — CM이 "구성원 명단만 받고 비밀번호는 초기화하는 방법도 괜찮다"고
정해서, 아래 `dump_database`가 비밀번호를 담지 않는다. 그래서 백업 어디에도 비밀번호가 없다.

  1. TDB 도면 파일      storage의 최신·이력·검수대기·검수대기_확인필요·반출·폐기
  2. MDB 자료 파일      storage의 MDB·폐기/MDB
  3. 시스템 기록        DB 통째(목록·Rev이력·반출·검수·감사로그·권한·계정 명단) + 보관해 둔 편집 내용
  4. 코드·화면          backend(venv 제외)·frontend·docs·CLAUDE.md·도면대장 등
  5. 외부 프로그램 정보  버전·받는 곳·설치 순서(설치 파일 자체는 담지 않는다 — 다시 받을 수 있다)

담지 않는 것: `.env`(비밀번호·서명키 — 새로 만들면 되는 값, `.env.example`에 형식만 있다),
`미리보기변환`(원본에서 다시 만들어진다), `venv`(다시 설치한다), 로그, 그리고 루트의 MDB 원본
폴더(시스템이 쓰는 자료가 아니라 CM이 직접 관리하는 원본이라 백업 기능 밖이다).

## 전체 / 변경분

전체는 폴더를 통째로 담고, 변경분은 **지난 회차의 목록표와 견주어 새로 생기거나 달라진 파일만**
담는다. 매번 10GB를 인터넷으로 받는 부담을 없애려는 것이다(변경분은 보통 수십MB).
함정 셋을 이렇게 막는다.
  ㉠ 없어진 파일은 변경분에 담길 수 없다 → 묶음마다 **그 시점 전체 목록표**를 함께 넣고
     빠진 파일을 목록에 적는다.
  ㉡ 중간 회차를 빼먹으면 구멍이 난다 → 회차 번호를 매기고, 화면이 안 받은 회차를 알려준다.
  ㉢ 바뀐 파일을 날짜만으로 판단하면 틀릴 수 있다 → (크기·수정시각)과 함께 **DB에 이미 적혀
     있는 파일 지문(sha256)**까지 견준다. 우리가 10GB를 다시 해시하지는 않는다(매번 1~2분을
     그냥 버리게 되고, 이 시스템은 파일을 바꿀 때 항상 새로 써서 크기·시각이 함께 바뀐다).

## 되살리기는 화면에 만들지 않는다

서버를 멈추고 DB를 통째로 바꾸는 일이라 버튼으로 두면 위험하다. 묶음 안에 넣는
`_읽어주세요_백업내용과_복원방법.txt`의 순서대로 사람이 한다(2026-08-17 수동 백업과 같은 방식).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

import openpyxl
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app import storage
from app.auth import default_password, hash_password
from app.config import (
    BACKUP_ROOT,
    DATABASE_URL,
    PREVIEW_ODA_PATH,
    PREVIEW_SOFFICE_PATH,
    PG_DUMP_PATH,
    STORAGE_ROOT,
)
from app.models import File, MdbFile, User
from app.secret_values import contains_secret, secret_values
from app.utils import filename_timestamp, kst_now, neutralize_formulas

# ── 분류 ─────────────────────────────────────────────────────────────────────
KIND_TDB = "TDB"
KIND_MDB = "MDB"
KIND_DB = "DB"
KIND_CODE = "CODE"
KIND_EXTERNAL = "EXTERNAL"

# 화면·엑셀·파일명에 쓰는 이름. 파일명이 이 값을 따라가므로 고치면 새 묶음의 이름이 바뀐다
# (이미 만들어 둔 묶음의 파일명은 DB에 적혀 있어 그대로 남는다).
KIND_LABELS: dict[str, str] = {
    KIND_TDB: "TDB 도면",
    KIND_MDB: "MDB 자료",
    KIND_DB: "시스템 기록",
    KIND_CODE: "코드·화면",
    KIND_EXTERNAL: "외부 프로그램 정보",
}

# 만드는 차례. 시스템 기록(DB)을 **가장 먼저** 뜬다 — 백업 도는 중에 누가 자료를 등록하면
# DB와 파일의 시점이 어긋나는데, DB를 먼저 뜨면 "파일은 있는데 목록에 없는" 안전한 쪽으로만
# 어긋난다(반대면 목록에 있는 파일이 백업에 없어 복원 후 깨진 자료가 된다).
ALL_KINDS: tuple[str, ...] = (KIND_DB, KIND_TDB, KIND_MDB, KIND_CODE, KIND_EXTERNAL)

# 도면 파일이 있는 storage 폴더. 파일 지문이 있는 두 종류(TDB·MDB)만 변경분을 만들 수 있다.
FILE_KINDS: tuple[str, ...] = (KIND_TDB, KIND_MDB)

SCOPE_FULL = "FULL"
SCOPE_DELTA = "DELTA"
SCOPE_LABELS = {SCOPE_FULL: "전체", SCOPE_DELTA: "변경분"}

DELIVERY_ZIP = "ZIP"       # 묶음 파일 하나 (내려받을 수 있다)
DELIVERY_FOLDER = "FOLDER" # 압축하지 않고 폴더째 복사 (외장하드용 — 내려받기는 안 된다)

_MDB_RETIRED = f"{storage.RETIRED}/{storage.MDB}"

# TDB는 폐기 폴더를 담되 그 안의 MDB 자리는 MDB 쪽이 담으므로 뺀다.
TDB_TOPS: tuple[str, ...] = (
    storage.LATEST, storage.HISTORY, storage.PENDING,
    storage.QUARANTINE, storage.DISTRIBUTED, storage.RETIRED,
)
TDB_SKIP: tuple[str, ...] = (_MDB_RETIRED,)
MDB_TOPS: tuple[str, ...] = (storage.MDB, _MDB_RETIRED)
MDB_SKIP: tuple[str, ...] = ()

# 도면 묶음을 압축하는 세기. DWG는 눌리는 편이고 PDF는 거의 안 눌린다. 서버가 2코어뿐이라
# 세게 누르면 10GB에 몇 분씩 더 걸리므로 약하게(1) 눌러 속도를 택했다 — 인터넷으로 보내는
# 양은 줄이면서 만드는 시간은 짧게. 실제 줄어드는 비율은 만들고 나면 화면에 보인다.
DRAWING_COMPRESS_LEVEL = 1

# 코드·기록처럼 작은 것은 기본 세기로 눌러 크기를 줄인다.
SMALL_COMPRESS_LEVEL = 6

README_NAME = "_읽어주세요_백업내용과_복원방법.txt"
MANIFEST_NAME = "_목록표.json"


# ── 자리 ─────────────────────────────────────────────────────────────────────
def project_root() -> Path:
    """프로젝트 폴더(backend·frontend가 나란히 있는 곳). main.py가 frontend를 찾는 방법과 같다."""
    return Path(__file__).resolve().parents[2]


# 이번 한 번만 다른 곳(외장하드 등)에 만들 때 쓰는 자리. 백업을 만드는 그 실행줄에만
# 걸어 두므로(threading.local) 같은 시간에 들어온 다른 요청은 늘 .env의 기본 위치를 본다.
# **이미 만들어 둔 묶음을 찾을 때는 이 값을 쓰지 않는다** — 그 줄의 dest_dir에 적힌 자리를 쓴다
# (저장 위치를 바꾼 뒤에 예전 묶음을 못 찾는 일이 생기기 때문).
_bundle_override = threading.local()


def set_bundle_root(path: Optional[str]) -> None:
    _bundle_override.value = path or None


def bundle_root() -> Path:
    """이번 작업에서 묶음을 만들 곳. .env의 BACKUP_ROOT가 기본이다."""
    return Path(getattr(_bundle_override, "value", None) or BACKUP_ROOT)


def default_bundle_root() -> Path:
    return Path(BACKUP_ROOT)


def manifest_dir() -> Path:
    """변경분 계산에 쓰는 목록표를 두는 곳.

    묶음 폴더(BACKUP_ROOT)가 아니라 **storage 안**에 둔다 — BACKUP_ROOT는 외장하드처럼 늘
    꽂혀 있지 않을 수 있는데, 목록표는 서버에 항상 있어야 다음 변경분을 계산할 수 있다.
    이 폴더는 도면 백업 대상에서 빠진다(아래 `_tops_for`).
    """
    return Path(STORAGE_ROOT) / storage.BACKUP_LOG


def _tops_for(kind: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    if kind == KIND_TDB:
        return TDB_TOPS, TDB_SKIP
    if kind == KIND_MDB:
        return MDB_TOPS, MDB_SKIP
    raise ValueError(f"파일을 담는 분류가 아닙니다: {kind}")


# ── 목록표 (무엇이 있는지·무엇이 바뀌었는지) ──────────────────────────────────
def _walk_files(base: Path, rel_prefix: str, skip: Iterable[str]) -> Iterator[tuple[str, Path]]:
    """base 밑 모든 파일을 (storage 기준 상대경로, 실제 경로)로 돌려준다."""
    skip_set = {s.replace("\\", "/").rstrip("/") + "/" for s in skip}
    if not base.exists():
        return
    for dirpath, dirnames, filenames in os.walk(base):
        rel_dir = Path(dirpath).relative_to(base).as_posix()
        here = rel_prefix if rel_dir == "." else f"{rel_prefix}/{rel_dir}"
        if any(f"{here}/".startswith(s) for s in skip_set):
            dirnames[:] = []
            continue
        dirnames.sort()
        for name in sorted(filenames):
            yield f"{here}/{name}", Path(dirpath) / name


def scan_disk(kind: str) -> dict[str, tuple[int, int]]:
    """디스크를 훑어 {상대경로: (크기, 수정시각)}. 해시는 계산하지 않는다(위 문서 ㉢ 참고)."""
    root = Path(STORAGE_ROOT)
    tops, skip = _tops_for(kind)
    out: dict[str, tuple[int, int]] = {}
    for top in tops:
        for rel, path in _walk_files(root / top, top, skip):
            try:
                st = path.stat()
            except OSError:
                continue  # 훑는 사이에 없어진 파일은 건너뛴다
            out[rel] = (st.st_size, int(st.st_mtime))
    return out


def scan_empty_dirs(kind: str) -> list[str]:
    """파일이 하나도 없는 폴더. 묶음에 폴더 자리만이라도 담아 원래 모양을 지킨다."""
    root = Path(STORAGE_ROOT)
    tops, skip = _tops_for(kind)
    skip_set = {s.replace("\\", "/").rstrip("/") + "/" for s in skip}
    out: list[str] = []
    for top in tops:
        base = root / top
        if not base.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            rel_dir = Path(dirpath).relative_to(base).as_posix()
            here = top if rel_dir == "." else f"{top}/{rel_dir}"
            if any(f"{here}/".startswith(s) for s in skip_set):
                dirnames[:] = []
                continue
            if not filenames and not dirnames:
                out.append(here)
    return sorted(out)


def db_hashes(db: Session, kind: str) -> dict[str, str]:
    """DB에 이미 적혀 있는 파일 지문 {상대경로: sha256}. 새로 계산하지 않고 그대로 가져온다."""
    if kind == KIND_TDB:
        rows = db.query(File.file_path, File.sha256).all()
    else:
        rows = db.query(MdbFile.storage_path, MdbFile.sha256).all()
    return {(p or "").replace("\\", "/"): (h or "") for p, h in rows if p}


def build_manifest(db: Session, kind: str) -> dict:
    disk = scan_disk(kind)
    hashes = db_hashes(db, kind)
    files = {
        rel: {"size": size, "mtime": mtime, "sha256": hashes.get(rel, "")}
        for rel, (size, mtime) in sorted(disk.items())
    }
    return {
        "kind": kind,
        "created_at": kst_now().isoformat(timespec="seconds"),
        "file_count": len(files),
        "total_bytes": sum(v["size"] for v in files.values()),
        "files": files,
    }


def manifest_path(kind: str, seq: int) -> Path:
    return manifest_dir() / f"목록표_{kind}_{seq}회차.json"


def save_manifest(manifest: dict, kind: str, seq: int) -> str:
    path = manifest_path(kind, seq)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return storage.to_relative(path)


def load_manifest(rel_or_path: str | None) -> Optional[dict]:
    if not rel_or_path:
        return None
    path = Path(rel_or_path)
    if not path.is_absolute():
        path = Path(STORAGE_ROOT) / rel_or_path
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def diff_manifest(prev: Optional[dict], cur: dict) -> dict:
    """지난 목록표와 견주어 무엇이 달라졌는지.

    changed = 새로 생겼거나 (크기·수정시각·지문) 중 하나라도 달라진 파일 → 묶음에 담는다.
    removed = 지난번엔 있었는데 지금 없는 파일 → 담을 것이 없으니 목록표에만 적는다.
    """
    prev_files = (prev or {}).get("files", {})
    cur_files = cur.get("files", {})
    changed: list[str] = []
    for rel, info in cur_files.items():
        old = prev_files.get(rel)
        if old is None:
            changed.append(rel)
            continue
        if old.get("size") != info.get("size") or old.get("mtime") != info.get("mtime"):
            changed.append(rel)
            continue
        # 지문은 양쪽에 다 있을 때만 견준다(DB에 없는 파일은 빈 문자열이라 늘 다르다고 보면 안 된다)
        if old.get("sha256") and info.get("sha256") and old["sha256"] != info["sha256"]:
            changed.append(rel)
    removed = sorted(set(prev_files) - set(cur_files))
    return {"changed": sorted(changed), "removed": removed}


# ── 진행상황 (화면이 물어보는 값) ─────────────────────────────────────────────
@dataclass
class JobState:
    running: bool = False
    step: str = ""
    kinds: list[str] = field(default_factory=list)
    scope: str = SCOPE_FULL
    done_files: int = 0
    total_files: int = 0
    done_bytes: int = 0
    total_bytes: int = 0
    started_at: str = ""
    finished_at: Optional[str] = None
    error: Optional[str] = None
    made: list[dict] = field(default_factory=list)  # 만든 묶음 요약 (화면 알림용)


_job = JobState()
_job_lock = threading.Lock()


def job_snapshot() -> dict:
    with _job_lock:
        return asdict(_job)


def job_running() -> bool:
    with _job_lock:
        return _job.running


def job_begin(kinds: list[str], scope: str) -> bool:
    """한 번에 하나만 돈다. 이미 돌고 있으면 False."""
    global _job
    with _job_lock:
        if _job.running:
            return False
        _job = JobState(
            running=True, step="준비 중", kinds=list(kinds), scope=scope,
            started_at=kst_now().isoformat(timespec="seconds"),
        )
        return True


def job_step(step: str, *, total_files: int = 0, total_bytes: int = 0) -> None:
    with _job_lock:
        _job.step = step
        _job.done_files = 0
        _job.done_bytes = 0
        _job.total_files = total_files
        _job.total_bytes = total_bytes


def job_tick(files: int = 1, byte_count: int = 0) -> None:
    with _job_lock:
        _job.done_files += files
        _job.done_bytes += byte_count


def job_made(summary: dict) -> None:
    with _job_lock:
        _job.made.append(summary)


def job_end(error: Optional[str] = None) -> None:
    with _job_lock:
        _job.running = False
        _job.error = error
        _job.step = "끝났습니다" if error is None else "실패"
        _job.finished_at = kst_now().isoformat(timespec="seconds")


# ── 묶음 만들기 ──────────────────────────────────────────────────────────────
def bundle_filename(kind: str, scope: str, seq: int, stamp: str, ext: str = "zip") -> str:
    label = KIND_LABELS[kind].replace("·", "")
    if kind in FILE_KINDS:
        part = f"{label}_{SCOPE_LABELS[scope]}_{seq}회차"
    else:
        part = f"{label}_{seq}회차"
    return f"{part}_{stamp}.{ext}" if ext else f"{part}_{stamp}"


def _add_file(zf: zipfile.ZipFile, src: Path, arcname: str) -> int:
    try:
        size = src.stat().st_size
    except OSError:
        return 0
    zf.write(src, arcname)
    job_tick(1, size)
    return size


def write_drawing_bundle(
    db: Session, kind: str, scope: str, seq: int, stamp: str,
    prev_manifest: Optional[dict], note_lines: list[str],
) -> dict:
    """TDB·MDB 파일 묶음 하나를 만든다. 돌려주는 값이 그대로 backup_runs 한 줄이 된다."""
    root = Path(STORAGE_ROOT)
    job_step(f"{KIND_LABELS[kind]} 목록 확인 중")
    manifest = build_manifest(db, kind)
    diff = diff_manifest(prev_manifest, manifest) if scope == SCOPE_DELTA else None

    if scope == SCOPE_DELTA:
        rels = list(diff["changed"])
    else:
        rels = list(manifest["files"].keys())
    total_bytes = sum(manifest["files"][r]["size"] for r in rels if r in manifest["files"])

    manifest["scope"] = scope
    manifest["seq"] = seq
    if diff is not None:
        manifest["included"] = rels
        manifest["removed_since_last"] = diff["removed"]
        manifest["base_created_at"] = (prev_manifest or {}).get("created_at")

    dest = bundle_root() / bundle_filename(kind, scope, seq, stamp)
    dest.parent.mkdir(parents=True, exist_ok=True)
    job_step(f"{KIND_LABELS[kind]} 묶는 중", total_files=len(rels), total_bytes=total_bytes)

    written = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=DRAWING_COMPRESS_LEVEL) as zf:
        for rel in rels:
            written += _add_file(zf, root / rel, f"storage/{rel}")
        if scope == SCOPE_FULL:
            # 빈 폴더도 자리만 담아 원래 모양을 지킨다
            for rel in scan_empty_dirs(kind):
                zf.writestr(f"storage/{rel}/", "")
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False))
        zf.writestr(README_NAME, readme_drawing(kind, scope, seq, stamp, manifest, diff, note_lines))

    size = dest.stat().st_size
    return {
        "kind": kind, "scope": scope, "seq": seq,
        "filename": dest.name, "dest_dir": str(dest.parent), "delivery": DELIVERY_ZIP,
        "file_size": size, "file_count": len(rels),
        "source_bytes": written,
        "manifest_path": save_manifest(manifest, kind, seq),
        "removed_count": len(diff["removed"]) if diff else 0,
    }


def copy_drawing_folder(db: Session, kind: str, seq: int, stamp: str) -> dict:
    """압축하지 않고 폴더째 복사한다(외장하드에 바로 만들 때 쓰는 예비 길).

    내려받기는 되지 않는다 — 탐색기에서 가져간다. 대신 풀 필요가 없고 받는 공간도 필요 없다.
    """
    root = Path(STORAGE_ROOT)
    job_step(f"{KIND_LABELS[kind]} 목록 확인 중")
    manifest = build_manifest(db, kind)
    manifest["scope"] = SCOPE_FULL
    manifest["seq"] = seq
    rels = list(manifest["files"].keys())

    dest_dir = bundle_root() / bundle_filename(kind, SCOPE_FULL, seq, stamp, ext="")
    dest_dir.mkdir(parents=True, exist_ok=True)
    job_step(
        f"{KIND_LABELS[kind]} 복사 중",
        total_files=len(rels), total_bytes=manifest["total_bytes"],
    )
    written = 0
    for rel in rels:
        src = root / rel
        out = dest_dir / "storage" / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, out)
            written += src.stat().st_size
        except OSError:
            continue
        job_tick(1, 0)
    for rel in scan_empty_dirs(kind):
        (dest_dir / "storage" / rel).mkdir(parents=True, exist_ok=True)
    (dest_dir / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (dest_dir / README_NAME).write_text(
        readme_drawing(kind, SCOPE_FULL, seq, stamp, manifest, None, []), encoding="utf-8",
    )
    return {
        "kind": kind, "scope": SCOPE_FULL, "seq": seq,
        "filename": dest_dir.name, "dest_dir": str(dest_dir.parent), "delivery": DELIVERY_FOLDER,
        "file_size": written, "file_count": len(rels),
        "source_bytes": written,
        "manifest_path": save_manifest(manifest, kind, seq),
        "removed_count": 0,
    }


def write_record_bundle(db: Session, seq: int, stamp: str, tmp_dir: Path) -> dict:
    """시스템 기록(DB 통째 + 계정 명단 + 보관해 둔 편집 내용)."""
    job_step("시스템 기록(DB) 뜨는 중")
    sql_path = tmp_dir / f"dms_{stamp}.sql"
    dump_database(sql_path)
    changed_users = strip_passwords_from_dump(sql_path, db)
    # 마지막 확인 — 뜬 자료 안에 .env의 비밀값이 섞여 있으면 묶지 않고 멈춘다.
    # (지금은 그런 칸이 없지만, 나중에 어딘가에 비밀번호를 적어 두면 조용히 실려 나간다)
    secrets = secret_values()
    if secrets and contains_secret(sql_path.read_bytes(), secrets):
        raise RuntimeError(
            "뜬 DB 안에 .env의 비밀번호가 들어 있어 백업을 멈췄습니다. "
            "어느 자료에 비밀번호가 적혔는지 확인한 뒤 다시 시도해 주세요."
        )

    dest = bundle_root() / bundle_filename(KIND_DB, SCOPE_FULL, seq, stamp)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fav_dir = Path(STORAGE_ROOT) / storage.FAVORITES
    fav_files = [p for p in fav_dir.rglob("*") if p.is_file()] if fav_dir.exists() else []
    job_step("시스템 기록 묶는 중", total_files=2 + len(fav_files))

    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=SMALL_COMPRESS_LEVEL) as zf:
        zf.write(sql_path, f"DB/{sql_path.name}")
        job_tick()
        zf.writestr(f"DB/계정명단_{stamp}.xlsx", account_list_xlsx(db))
        job_tick()
        for path in fav_files:
            rel = path.relative_to(Path(STORAGE_ROOT)).as_posix()
            _add_file(zf, path, f"storage/{rel}")
        zf.writestr(README_NAME, readme_record(stamp, sql_path.name, changed_users, len(fav_files)))

    return {
        "kind": KIND_DB, "scope": SCOPE_FULL, "seq": seq,
        "filename": dest.name, "dest_dir": str(dest.parent), "delivery": DELIVERY_ZIP,
        "file_size": dest.stat().st_size, "file_count": 2 + len(fav_files),
        "source_bytes": sql_path.stat().st_size,
        "manifest_path": None, "removed_count": 0,
    }


# ── 비밀값이 백업에 섞여 나가지 않게 하는 장치 (2026-09-29, D-105 ②) ───────────
# 묶을 때마다 .env의 실제 값과 대조해 **그 값이 든 파일은 묶음에서 빼고 이름을 알려준다.**
# (조용히 빼면 복원할 때 그 파일이 없는 이유를 알 수 없으므로 읽어주세요와 화면에 반드시 적는다.)
# 무엇을 비밀값으로 보는지는 app/secret_values.py 한 곳에 있다 — 보안 자동 검사(security_check.py)도
# 같은 규칙을 쓰므로, 여기서 따로 고치지 말고 그 파일을 고칠 것(2026-10-01, D-111).


# 코드 묶음에서 빼는 것 — 다시 만들 수 있거나(venv·캐시·로그) 비밀이 들어 있는 것(.env).
CODE_SKIP_DIRS = {"venv", "__pycache__", ".git", "node_modules"}
CODE_SKIP_SUFFIX = (".pyc", ".log")
CODE_FILES = ("CLAUDE.md", ".env.example")
CODE_DIRS = ("backend", "frontend", "docs", "참고자료", ".claude")


def write_code_bundle(seq: int, stamp: str) -> dict:
    """코드·화면. 이것만 있으면 시스템을 다시 세울 수 있다(PDF.js도 여기 들어 있다)."""
    root = project_root()
    targets: list[tuple[Path, str]] = []
    for name in CODE_DIRS:
        base = root / name
        if not base.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in CODE_SKIP_DIRS)
            for fname in sorted(filenames):
                if fname.endswith(CODE_SKIP_SUFFIX) or fname == ".env":
                    continue
                src = Path(dirpath) / fname
                targets.append((src, src.relative_to(root).as_posix()))
    for name in CODE_FILES:
        src = root / name
        if src.exists():
            targets.append((src, name))

    # 비밀값(.env의 DB 비밀번호·서명키)이 적힌 파일은 묶음에서 뺀다
    secrets = secret_values()
    kept: list[tuple[Path, str]] = []
    skipped: list[str] = []
    for src, arc in targets:
        try:
            if secrets and contains_secret(src.read_bytes(), secrets):
                skipped.append(arc)
                continue
        except OSError:
            continue
        kept.append((src, arc))

    dest = bundle_root() / bundle_filename(KIND_CODE, SCOPE_FULL, seq, stamp)
    dest.parent.mkdir(parents=True, exist_ok=True)
    job_step("코드·화면 묶는 중", total_files=len(kept))
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=SMALL_COMPRESS_LEVEL) as zf:
        for src, arc in kept:
            _add_file(zf, src, arc)
        zf.writestr(README_NAME, readme_code(stamp, len(kept), skipped))
    return {
        "kind": KIND_CODE, "scope": SCOPE_FULL, "seq": seq,
        "filename": dest.name, "dest_dir": str(dest.parent), "delivery": DELIVERY_ZIP,
        "file_size": dest.stat().st_size, "file_count": len(kept),
        "source_bytes": sum(s.stat().st_size for s, _ in kept if s.exists()),
        "manifest_path": None, "removed_count": 0,
        "skipped_secret": skipped,
    }


def write_external_info(db: Session, seq: int, stamp: str) -> dict:
    """외부 프로그램 정보 — 글 파일 하나. 설치 파일 자체는 담지 않는다(다시 받을 수 있다)."""
    dest = bundle_root() / bundle_filename(KIND_EXTERNAL, SCOPE_FULL, seq, stamp, ext="txt")
    dest.parent.mkdir(parents=True, exist_ok=True)
    job_step("외부 프로그램 정보 적는 중", total_files=1)
    dest.write_text(external_info_text(db, stamp), encoding="utf-8")
    job_tick()
    return {
        "kind": KIND_EXTERNAL, "scope": SCOPE_FULL, "seq": seq,
        "filename": dest.name, "dest_dir": str(dest.parent), "delivery": DELIVERY_ZIP,
        "file_size": dest.stat().st_size, "file_count": 1,
        "source_bytes": dest.stat().st_size,
        "manifest_path": None, "removed_count": 0,
    }


# ── DB 뜨기 ──────────────────────────────────────────────────────────────────
def pg_dump_exe() -> Path:
    """pg_dump 실행 파일. .env에 PG_DUMP_PATH를 적으면 그것을 쓰고, 없으면 찾아본다."""
    if PG_DUMP_PATH:
        path = Path(PG_DUMP_PATH)
        if path.exists():
            return path
        raise RuntimeError(f".env의 PG_DUMP_PATH에 적힌 파일이 없습니다: {path}")
    found = sorted(Path(r"C:\Program Files\PostgreSQL").glob("*/bin/pg_dump.exe"), reverse=True)
    if found:
        return found[0]
    for name in ("pg_dump.exe", "pg_dump"):
        which = shutil.which(name)
        if which:
            return Path(which)
    raise RuntimeError(
        "pg_dump를 찾지 못했습니다. PostgreSQL이 설치된 곳의 bin\\pg_dump.exe 경로를 "
        ".env의 PG_DUMP_PATH에 적어 주세요."
    )


def dump_database(dest: Path) -> None:
    """DB를 사람이 읽을 수 있는 SQL 한 파일로 뜬다.

    압축 형식(-Fc)이 아니라 글자 형식(-Fp)으로 뜨는 이유는 둘이다.
      ㉠ 아래 `strip_passwords_from_dump`가 비밀번호 칸만 바꿔 넣어야 한다.
      ㉡ 되살릴 때 `psql -f 파일` 한 줄로 끝나 복원 절차가 단순해진다.
    소유자·권한 설정은 담지 않는다(--no-owner·--no-privileges) — 되살리는 곳의 계정 이름이
    다를 수 있고, 그대로 담으면 그 계정이 없다며 복원이 멈춘다.
    """
    url = make_url(DATABASE_URL)
    args = [
        str(pg_dump_exe()),
        "--host", url.host or "localhost",
        "--port", str(url.port or 5432),
        "--username", url.username or "postgres",
        "--dbname", url.database or "dms",
        "--encoding=UTF8", "--no-owner", "--no-privileges",
        "--file", str(dest),
    ]
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = url.password
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        args, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        raise RuntimeError(f"DB를 뜨지 못했습니다: {(result.stderr or '').strip()[:500]}")


def strip_passwords_from_dump(sql_path: Path, db: Session) -> int:
    """뜬 SQL에서 **비밀번호 칸만** 초기값으로 바꿔 넣는다 (2026-09-29 CM 지시).

    CM이 "구성원 명단 정도만 백업받고 비밀번호는 초기화하는 방법도 괜찮다"고 정해서, 백업
    파일에는 실제 비밀번호(해시)를 담지 않는다. 되살리면 전원이 `ghub+아이디`로 로그인하고
    첫 로그인 때 새 비밀번호를 정하게 된다(D-104의 장치가 그대로 작동한다).

    사용자 표를 통째로 빼지 않는 이유: 반출·검수·로그 기록이 "누가 했는지"로 계정을 가리키고
    있어서, 계정이 없으면 되살릴 때 그 기록들이 통째로 들어가지 못한다.

    바꾸는 방법은 글자 찾아 바꾸기가 아니다 — `COPY public.users (칸 이름들)` 줄에서 칸 순서를
    읽어 **그 칸 자리만** 바꾼다. 그래서 다른 표나 비고 글에 비슷한 글자가 있어도 건드리지 않는다.
    """
    text_body = sql_path.read_text(encoding="utf-8")
    lines = text_body.splitlines(keepends=True)

    head = None
    for idx, line in enumerate(lines):
        if line.startswith("COPY public.users (") and "FROM stdin;" in line:
            head = idx
            break
    if head is None:
        raise RuntimeError("뜬 DB 안에서 사용자 표를 찾지 못했습니다(비밀번호를 지울 수 없어 중단).")

    inner = lines[head][len("COPY public.users ("):].split(")")[0]
    columns = [c.strip().strip('"') for c in inner.split(",")]
    try:
        i_user = columns.index("username")
        i_pw = columns.index("password_hash")
    except ValueError as exc:
        raise RuntimeError(f"사용자 표의 칸 구성을 읽지 못했습니다: {exc}")
    i_must = columns.index("must_change_password") if "must_change_password" in columns else None
    i_failed = columns.index("failed_login_count") if "failed_login_count" in columns else None
    i_locked = columns.index("locked_until") if "locked_until" in columns else None

    cache: dict[str, str] = {}
    changed = 0
    for idx in range(head + 1, len(lines)):
        raw = lines[idx]
        if raw.rstrip("\r\n") == "\\.":
            break
        newline = raw[len(raw.rstrip("\r\n")):]
        fields = raw.rstrip("\r\n").split("\t")
        if len(fields) != len(columns):
            continue
        username = fields[i_user]
        if username not in cache:
            cache[username] = hash_password(default_password(username))
        fields[i_pw] = cache[username]
        if i_must is not None:
            fields[i_must] = "t"      # 첫 로그인 때 새 비밀번호를 정하게 한다
        if i_failed is not None:
            fields[i_failed] = "0"    # 되살린 시스템이 잠긴 상태로 시작하지 않게
        if i_locked is not None:
            fields[i_locked] = "\\N"
        lines[idx] = "\t".join(fields) + newline
        changed += 1

    sql_path.write_text("".join(lines), encoding="utf-8")
    return changed


def account_list_xlsx(db: Session) -> bytes:
    """사람이 읽는 계정 명단. 비밀번호는 담지 않는다."""
    users = db.query(User).order_by(User.username).all()
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "계정 명단"
    ws.append(["아이디", "이름", "권한", "소속 그룹", "재직 상태", "사용 가능", "마지막 접속", "만든 날짜"])
    for u in users:
        ws.append([
            u.username, u.name, u.role,
            u.group.name if getattr(u, "group", None) else "",
            u.employment_status, "예" if u.is_active else "아니오",
            u.last_login_at.strftime("%Y-%m-%d %H:%M") if u.last_login_at else "",
            u.created_at.strftime("%Y-%m-%d") if u.created_at else "",
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([14, 14, 10, 18, 12, 10, 18, 14], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width
    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    return buf.getvalue()


# ── 외부 프로그램 정보 ───────────────────────────────────────────────────────
def _installed_packages() -> list[str]:
    """지금 돌고 있는 파이썬에 설치된 부품과 그 버전(= venv의 pip freeze와 같다).

    requirements.txt에는 버전이 안 적혀 있어서, 몇 년 뒤 그냥 설치하면 다른 버전이 깔려
    안 돌 수 있다. 그래서 백업할 때마다 지금 버전을 적어 둔다.
    """
    try:
        from importlib.metadata import distributions
    except ImportError:  # 아주 옛 파이썬
        return []
    items = []
    for dist in distributions():
        name = dist.metadata.get("Name") if dist.metadata else None
        if name:
            items.append(f"{name}=={dist.version}")
    return sorted(set(items), key=str.lower)


def _oda_dir() -> Optional[Path]:
    if PREVIEW_ODA_PATH:
        path = Path(PREVIEW_ODA_PATH)
        return path if path.exists() else None
    found = sorted(Path(r"C:\Program Files\ODA").glob("ODAFileConverter*"), reverse=True)
    return found[0] if found else None


def _libreoffice_version() -> str:
    """LibreOffice 버전. 프로그램을 실행하면 느리고 창이 뜰 수 있어 설정 파일만 읽는다.

    version.ini에는 큰 버전 번호가 그대로 적힌 줄이 없고 `UpdateID=LibreOffice_26_en-US_…`
    같은 줄에 섞여 있다. 거기서 번호만 꺼내고, 못 찾으면 빌드 번호라도 적어 둔다.
    """
    soffice = Path(PREVIEW_SOFFICE_PATH)
    ini = soffice.parent / "version.ini" if soffice.parent.name == "program" else None
    if ini and ini.exists():
        try:
            major, build_id = "", ""
            for line in ini.read_text(encoding="utf-8", errors="replace").splitlines():
                low = line.strip().lower()
                if low.startswith("updateid=") and "_" in line:
                    parts = line.split("=", 1)[1].split("_")
                    if len(parts) > 1 and parts[1][:1].isdigit():
                        major = parts[1]
                elif low.startswith("buildid="):
                    build_id = line.split("=", 1)[1].strip()
            if major:
                return f"{major} (빌드 {build_id[:12]})" if build_id else major
            if build_id:
                return f"빌드 {build_id[:12]}"
        except OSError:
            pass
    return "설치됨(버전은 프로그램에서 확인)" if soffice.exists() else "설치 안 됨"


def _pdfjs_version() -> str:
    """PDF.js 버전. 배포본 pdf.mjs 안에 `version = "6.3.289"`처럼 적혀 있다."""
    build = project_root() / "frontend" / "assets" / "pdfjs" / "build" / "pdf.mjs"
    if build.exists():
        try:
            import re as _re
            head = build.read_text(encoding="utf-8", errors="replace")
            found = _re.search(r"""version\s*=\s*["'](\d+\.\d+\.\d+)["']""", head)
            if found:
                return found.group(1)
        except OSError:
            pass
    return "확인 필요"


def external_info_text(db: Session, stamp: str) -> str:
    try:
        pg_version = db.execute(text("show server_version")).scalar() or "확인 필요"
    except Exception:
        pg_version = "확인 필요"
    oda = _oda_dir()
    lines = [
        f"TDMS 기술자료 관리 시스템 — 외부 프로그램 정보 ({stamp})",
        "=" * 70,
        "",
        "이 시스템은 우리가 만든 코드 말고도 아래 프로그램을 씁니다. 시스템을 새로 세울 때",
        "같은 것들을 먼저 설치해야 합니다. 설치 파일 자체는 백업에 담지 않았습니다 — 전부",
        "무료로 다시 받을 수 있기 때문입니다. 다만 **버전이 중요합니다**(아래 적힌 버전과",
        "너무 다르면 동작이 달라질 수 있습니다). 인터넷에서 그 버전이 사라질 것이 걱정되면",
        "설치 파일을 따로 모아 외장하드에 보관해 두십시오.",
        "",
        "[1] 꼭 필요한 것",
        "-" * 70,
        f"  · Python            {sys.version.split()[0]}   받는 곳: https://www.python.org/downloads/",
        f"  · PostgreSQL        {pg_version}   받는 곳: https://www.postgresql.org/download/windows/",
        "      (설치 프로그램으로 설치합니다. Docker는 쓰지 않습니다 — 지침서 D-11)",
        "",
        "[2] 원본(DWG·엑셀·워드) 미리보기에 필요한 것",
        "-" * 70,
        f"  · ODA File Converter  {oda.name if oda else '설치 안 됨'}",
        "      받는 곳: https://www.opendesign.com/guestfiles/oda_file_converter (무료, 가입 필요)",
        f"  · LibreOffice         {_libreoffice_version()}",
        "      받는 곳: https://www.libreoffice.org/download/",
        "      (운영 서버는 LibreOffice를 씁니다. 회사 PC는 문서보안 프로그램이 이것을 막아",
        "       설치된 MS 오피스로 대신 시험합니다 — .env의 PREVIEW_OFFICE_ENGINE)",
        "  · 한글 글꼴           바탕체 계열이 없으면 워드 문서의 쪽이 밀릴 수 있습니다",
        "",
        "[3] 코드 안에 함께 들어 있는 것 (따로 설치하지 않습니다)",
        "-" * 70,
        f"  · PDF.js  {_pdfjs_version()}   frontend/assets/pdfjs",
        "      미리보기 화면입니다. 새 버전으로 올릴 때 **우리가 고친 두 곳을 다시 넣어야**",
        "      합니다 — 잊으면 저장 파일이 조용히 예전 모양으로 돌아갑니다.",
        "        ① web/viewer.html 한 줄  : dms-viewer.js를 불러오는 <script> 태그",
        "        ② build/pdf.worker.mjs 두 줄 : 칠하는 표시의 겹침 방식",
        "           (`annotation.blendMode || \"Darken\"` — 찾기 쉽게 [DMS 수정]이라 적어 두었습니다)",
        "",
        "[4] 파이썬 부품 (venv에 설치된 그대로)",
        "-" * 70,
        "  requirements.txt에는 버전이 적혀 있지 않습니다. 아래 목록의 버전으로 설치하십시오.",
        "      backend> python -m venv venv",
        "      backend> venv\\Scripts\\python.exe -m pip install -r requirements.txt",
        "  그대로 맞추려면 아래 목록을 requirements_고정.txt로 저장해 -r로 설치하면 됩니다.",
        "  ※ 이 백업을 개발 PC에서 만들었다면 목록에 보안 검사 도구 bandit과 그것이 함께 설치한",
        "     부품(rich·stevedore 등)이 섞여 있습니다. 개발 PC 전용이라(requirements-dev.txt)",
        "     운영 서버에는 설치하지 않아도 됩니다.",
        "",
    ]
    lines += [f"  {item}" for item in _installed_packages()]
    lines += [
        "",
        "[5] 설치 순서 요점",
        "-" * 70,
        "  1) Python·PostgreSQL 설치",
        "  2) 코드·화면 묶음을 풀고 backend에 venv를 만들어 위 부품 설치",
        "     (코드를 고칠 PC라면 requirements-dev.txt도 설치 — 보안 검사 도구)",
        "  3) DB를 만들고(UTF8, 정렬 Korean_Korea.949) 시스템 기록 묶음의 SQL을 psql로 넣기",
        "  4) 도면 묶음을 풀어 storage 폴더에 놓기",
        "  5) .env를 새로 쓰기(.env.example 참고 — SECRET_KEY·DB 비밀번호는 새로 만듭니다)",
        "  6) ODA File Converter·LibreOffice 설치",
        "  7) backend에서 run_server.py 실행",
        "  자세한 순서는 시스템 기록 묶음 안의 읽어주세요 파일에 있습니다.",
        "",
    ]
    return "\n".join(lines)


# ── 묶음마다 넣는 읽어주세요 ─────────────────────────────────────────────────
def _common_tail() -> list[str]:
    return [
        "",
        "[주의] 이 백업에는 비밀번호가 들어 있지 않습니다.",
        "-" * 70,
        "  되살리면 모든 사람의 비밀번호가 `ghub` + 아이디로 시작하고(예: 아이디 1234 → ghub1234),",
        "  각자 첫 로그인 때 새 비밀번호를 정하게 됩니다. .env(DB 비밀번호·서명키)도 담지 않았으니",
        "  새로 만들어 적으십시오(.env.example에 형식이 있습니다).",
        "",
        "[주의] 되살리기는 화면 버튼으로 하지 않습니다.",
        "-" * 70,
        "  서버를 멈추고 DB를 통째로 바꾸는 일이라 순서를 틀리면 자료가 섞입니다.",
        "  혼자 시도하지 마시고 아래 순서대로, 또는 유지보수 담당자와 함께 진행하십시오.",
        "",
    ]


def readme_drawing(
    kind: str, scope: str, seq: int, stamp: str,
    manifest: dict, diff: Optional[dict], note_lines: list[str],
) -> str:
    label = KIND_LABELS[kind]
    lines = [
        f"TDMS 기술자료 관리 시스템 — {label} {SCOPE_LABELS[scope]} 백업 ({seq}회차, {stamp})",
        "=" * 70,
        "",
        "[1] 무엇이 들어 있나",
        "-" * 70,
    ]
    if scope == SCOPE_FULL:
        lines += [
            f"  storage 폴더 밑 {label} 파일 전부입니다.",
            f"    · 파일 {manifest['file_count']:,}개 / {manifest['total_bytes'] / 1024 / 1024 / 1024:.2f}GB",
            f"    · 담은 폴더: {', '.join(_tops_for(kind)[0])}",
        ]
    else:
        base = (manifest.get("base_created_at") or "").replace("T", " ")
        lines += [
            f"  {seq - 1}회차({base}) 이후 새로 생기거나 달라진 {label} 파일만 담았습니다.",
            f"    · 담은 파일 {len(manifest.get('included', [])):,}개",
            f"    · 그 사이 없어진 파일 {len(manifest.get('removed_since_last', [])):,}개"
            "  ← 파일이 없으니 목록표에만 적혀 있습니다",
            f"    · 그 시점 전체는 파일 {manifest['file_count']:,}개 /"
            f" {manifest['total_bytes'] / 1024 / 1024 / 1024:.2f}GB",
            "",
            "  ※ 변경분은 앞 회차들과 함께 있어야 완전합니다. 1회차(전체)부터 이 회차까지",
            "     차례대로 풀어 덮어쓰고, 목록표의 `removed_since_last`에 적힌 파일은 지우면",
            "     그 시점 모습이 됩니다.",
        ]
    lines += [
        "",
        f"  {MANIFEST_NAME} — 그 시점 전체 파일 목록(경로·크기·수정시각·지문). 백업이 제대로 됐는지",
        "                    대조할 때, 그리고 다음 변경분을 계산할 때 씁니다.",
        "",
        "[2] 되살리는 방법",
        "-" * 70,
        "  이 묶음 안의 `storage` 폴더를 시스템의 storage 폴더 자리에 그대로 덮어씁니다",
        "  (어디인지는 .env의 STORAGE_ROOT에 적혀 있습니다).",
        "  ★ 도면 파일만으로는 시스템이 돌지 않습니다 — 같은 시점의 `시스템 기록` 묶음(DB)을",
        "     반드시 함께 되살려야 합니다. 그것이 없으면 이 파일들이 어느 도면의 몇 번째",
        "     리비전인지 시스템이 알 방법이 없습니다.",
    ]
    if scope == SCOPE_FULL:
        lines += [
            "",
            "  ※ 시스템에 등록되지 않은 채 폴더에만 있던 파일도 그대로 담겨 있습니다",
            "     (전체 백업은 폴더를 통째로 담기 때문입니다).",
        ]
    lines += _common_tail()
    if note_lines:
        lines += ["[비고]", "-" * 70] + [f"  {t}" for t in note_lines] + [""]
    return "\n".join(lines)


def readme_record(stamp: str, sql_name: str, changed_users: int, fav_count: int) -> str:
    lines = [
        f"TDMS 기술자료 관리 시스템 — 시스템 기록(DB) 백업 ({stamp})",
        "=" * 70,
        "",
        "[1] 무엇이 들어 있나",
        "-" * 70,
        f"  DB/{sql_name}",
        "      데이터베이스 전체입니다. 아래가 전부 이 파일 하나에 들어 있습니다.",
        "        · TDB 도면 목록과 리비전 이력, MDB 자료와 Tag No",
        "        · 반출·반입·검수 기록, 시스템 로그(감사로그)",
        "        · 계정·권한 그룹, 공사·업체 목록, 보관함·폐기 이력",
        f"      계정 {changed_users}개의 비밀번호는 담지 않고 초기값으로 바꿔 넣었습니다.",
        f"  DB/계정명단_{stamp}.xlsx",
        "      사람이 읽는 계정 명단입니다(비밀번호 없음). 되살린 뒤 누가 있어야 하는지",
        "      눈으로 대조하는 용도입니다.",
        f"  storage/즐겨찾기/  — 사람마다 미리보기에서 보관해 둔 편집 내용 {fav_count}개",
        "      DB의 보관 목록과 짝이라 함께 담습니다.",
        "",
        "[2] 되살리는 방법",
        "-" * 70,
        "  1) 서버(웹 프로그램)를 멈춥니다.",
        "  2) 빈 데이터베이스를 새로 만듭니다 — 글자 UTF8, 정렬 Korean_Korea.949로 만들어야",
        "     한글 정렬이 지금과 같아집니다.",
        "  3) psql로 위 SQL 파일을 넣습니다.",
        f"       psql -U <계정> -d <DB이름> -f {sql_name}",
        "  4) 같은 시점의 도면 묶음(TDB·MDB)을 풀어 storage에 놓습니다.",
        "  5) .env를 새로 쓰고 서버를 켭니다.",
        "  6) 화면에서 도면이 열리는지, 목록 건수가 맞는지 확인합니다.",
        "  ★ 도면 파일 묶음과 짝입니다. 둘의 시점이 다르면 목록에 있는 파일이 없거나",
        "     그 반대가 되어 화면에서 오류가 납니다.",
    ]
    lines += _common_tail()
    return "\n".join(lines)


def readme_code(stamp: str, file_count: int, skipped: Optional[list[str]] = None) -> str:
    warn: list[str] = []
    if skipped:
        warn = [
            "",
            "[주의] 아래 파일은 **비밀번호가 적혀 있어 이 묶음에서 뺐습니다.**",
            "-" * 70,
            "  .env에 있는 DB 접속 비밀번호나 로그인 서명키가 그 파일 안에 그대로 적혀 있습니다.",
            "  백업을 남에게 넘길 때 비밀번호가 함께 나가지 않도록 자동으로 뺀 것입니다.",
            "  그 파일에서 비밀번호를 걷어내고(.env에서 읽도록 고치고) 다시 백업하십시오.",
            "",
        ] + [f"    · {name}" for name in skipped]
    return "\n".join([
        f"TDMS 기술자료 관리 시스템 — 코드·화면 백업 ({stamp})",
        "=" * 70,
        "",
        "[1] 무엇이 들어 있나",
        "-" * 70,
        f"  파일 {file_count:,}개. 이 묶음만 있으면 시스템을 다시 세울 수 있습니다.",
        "    · backend/  서버 프로그램(app)·DB 구조 관리(alembic)·1회성 스크립트(scripts)",
        "    · frontend/ 화면 전부. 미리보기 프로그램(PDF.js)도 여기 들어 있습니다",
        "    · docs/     프로젝트 문서,  CLAUDE.md  시스템 규칙·결정사항 지침서",
        "    · .claude/  Claude Code 설정 — 코드를 고칠 때마다 보안 검사를 자동으로 돌리는 설정 포함",
        "    · 도면대장.xlsx 등 처음 자료를 넣을 때 쓴 근거 자료",
        "",
        "  담지 않은 것: venv(파이썬 부품 — 다시 설치합니다), .env(비밀번호·서명키 — 새로",
        "  만듭니다), 로그, 캐시. 어떤 부품을 어느 버전으로 설치해야 하는지는 같은 시점의",
        "  `외부 프로그램 정보` 파일에 적혀 있습니다.",
        "",
        "[2] 되살리는 방법",
        "-" * 70,
        "  1) 이 묶음을 새 폴더에 풉니다(backend·frontend가 나란히 있어야 합니다).",
        "  2) backend 폴더에서 venv를 만들고 부품을 설치합니다.",
        "  3) .env를 새로 씁니다(.env.example 참고).",
        "  4) DB와 도면 파일은 각각의 묶음에서 되살립니다.",
        "",
        "  ※ CLAUDE.md는 이 시스템을 왜 그렇게 만들었는지 적어 둔 지침서입니다. 고치기 전에",
        "     반드시 읽어 주십시오 — 그 안의 결정사항을 모르고 고치면 같은 사고가 되풀이됩니다.",
        "",
        "[3] 코드를 고친 뒤에는 보안 검사",
        "-" * 70,
        "  지켜야 할 보안 규칙은 CLAUDE.md 3-1절에 있고, 아래 명령 하나로 프로젝트 전체를 검사합니다.",
        "  \"결과: 문제 없음\"이 나와야 서버에 올립니다.",
        "      backend> venv\\Scripts\\python.exe -m pip install -r requirements-dev.txt   (처음 한 번)",
        "      backend> venv\\Scripts\\python.exe security_check.py",
    ] + warn + [""])
