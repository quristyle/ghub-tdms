"""백업 관리 화면 (2026-09-29 CM 지시로 신설 — 원칙 12·D-18 개정, D-105).

무엇을 담는지·어떻게 묶는지는 전부 `app/backup.py`에 있고, 이 파일은 그것을 화면에 연결한다.

## 만들기는 딴 줄에서 돌린다

10GB를 묶는 데 몇 분이 걸리므로 요청을 붙잡아 두면 화면이 응답을 기다리다 끊긴다. 그래서
별도 실행줄(thread)에서 돌리고, 화면은 `GET /backup/progress`로 진행상황을 물어본다.
**한 번에 하나만 돈다** — 같은 파일을 두 번 쓰거나 디스크가 갑자기 두 배로 차는 일을 막는다.

## 받기는 이어받기가 된다

인터넷을 지나 10GB를 받는 동안 한 번도 끊기지 않기를 바랄 수는 없다. 그래서 만들어 둔 파일을
`Range` 머리글대로 잘라 보내 준다(끊긴 자리부터 다시 받을 수 있다). 파일을 미리 만들어 두는
방식이라 이것이 가능하다 — 그때그때 묶어 흘려보내면 이어받기를 만들 수 없다.

동시에 여러 사람이 받아도 서버는 파일을 읽어 보내기만 하므로 묶는 일을 다시 하지 않는다.

## 되살리기(복원)는 여기 없다

일부러 만들지 않았다. 서버를 멈추고 DB를 통째로 바꾸는 일이라 버튼으로 두면 위험하다.
묶음 안에 넣은 읽어주세요 파일의 순서대로 사람이 한다.

## 묶음 파일만 지우는 것은 있다 (2026-09-29 CM 지시, D-107)

한 번 받아 둔 묶음이 서버 용량을 계속 차지하므로 `[파일 삭제]`로 **묶음 파일만** 지운다.
**이력 줄은 지우지 않는다** — 어느 회차를 만들고 받았는지가 변경분을 이어 붙이는 근거라서,
그 줄이 없어지면 다음 변경분이 무엇을 기준으로 만들어진 것인지 알 수 없게 된다.
변경분 계산에 쓰는 목록표(`storage/백업기록/`)도 함께 남긴다 — 그것까지 지우면 다음
변경분이 전체 백업만큼 커진다.
"""

import re
import shutil
import threading
from io import BytesIO
from pathlib import Path
from typing import Iterator, Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import backup as bk
from app.auth import current_user
from app.database import SessionLocal, get_db
from app.models import AuditLog, BackupRun, User
from app.permissions import require_permission
from app.utils import (
    build_export_filename,
    content_disposition_header,
    filename_timestamp,
    kst_now,
    neutralize_formulas,
)

SCREEN = "백업 관리"
PERM_ACCESS = "screen.backup.access"   # 이 화면에 들어갈 수 있는지 (D-104와 같은 "페이지 접속")
PERM_RUN = "screen.backup.run"         # 만들기·받기·비고 작성
# 묶음 파일 지우기 (D-107). 되돌릴 수 없는 일이라 만들기·받기와 따로 뒀다 — 삭제 보관함의
# [완전 삭제]에 별도 권한을 둔 것과 같은 판단이다(D-38).
PERM_DELETE = "screen.backup.delete_file"

# 이력 표 `상태` 칸. 파일이 없어진 까닭을 둘로 나눠 보여 준다(D-107) —
# 화면에서 지운 것(삭제됨)과 탐색기에서 지웠거나 옮긴 것(없음)은 뜻이 다르다.
STATE_LABELS = {"EXISTS": "있음", "DELETED": "삭제됨", "MISSING": "없음"}

# 이 화면의 주소는 다른 화면과 함께 쓰는 것이 하나도 없어, 화면 접속 권한을 주소에도 그대로
# 건다(화면만 막으면 주소를 직접 친 사람에게는 목록이 그대로 내려간다).
router = APIRouter(
    prefix="/backup", tags=["backup"],
    dependencies=[Depends(require_permission(PERM_ACCESS))],
)

# 내려받을 때 한 번에 읽어 보내는 크기. 너무 작으면 10GB에 요청이 잘게 쪼개져 느려지고,
# 너무 크면 한 사람이 받는 동안 메모리를 그만큼 잡는다.
CHUNK = 1024 * 1024


# ── 만들기 ───────────────────────────────────────────────────────────────────
class RunRequest(BaseModel):
    kinds: Optional[list[str]] = None          # 비우면 5종 전부
    scope: str = bk.SCOPE_FULL                 # FULL / DELTA
    delivery: str = bk.DELIVERY_ZIP            # ZIP / FOLDER
    dest: Optional[str] = None                 # 저장 위치를 그때만 다르게 하고 싶을 때
    note: Optional[str] = None


def _check_dest(dest: Optional[str]) -> Optional[Path]:
    """화면에서 받은 저장 위치를 확인한다.

    아무 경로나 받아 쓰면 서버 어디에나 파일을 쓸 수 있게 되므로, 드라이브 문자로 시작하는
    온전한 경로이고 **그 바로 위 폴더가 이미 있을 때만** 허용한다(오타로 엉뚱한 곳에 깊은
    폴더가 생기는 것을 막는다). 이 기능 자체가 관리자 전용이고, 어디에 만들었는지는
    시스템 로그에 남는다.
    """
    if not dest:
        return None
    path = Path(dest.strip().strip('"'))
    if not path.is_absolute() or not path.drive:
        raise HTTPException(400, "저장 위치는 드라이브부터 적어 주세요 (예: E:\\DMS백업)")
    if path.exists() and path.is_file():
        raise HTTPException(400, "저장 위치에 같은 이름의 파일이 이미 있습니다")
    if not path.exists() and not path.parent.exists():
        raise HTTPException(400, f"저장 위치의 상위 폴더가 없습니다: {path.parent}")
    return path


def _next_seq(db: Session, kind: str) -> int:
    last = (
        db.query(BackupRun.seq)
        .filter(BackupRun.kind == kind)
        .order_by(BackupRun.seq.desc())
        .first()
    )
    return (last[0] + 1) if last else 1


def _last_full_or_delta(db: Session, kind: str) -> Optional[BackupRun]:
    """그 분류의 마지막 백업 한 줄(변경분 기준으로 쓴다)."""
    return (
        db.query(BackupRun)
        .filter(BackupRun.kind == kind)
        .order_by(BackupRun.seq.desc())
        .first()
    )


def _estimate_bytes(db: Session, kinds: list[str], scope: str) -> int:
    total = 0
    for kind in kinds:
        if kind not in bk.FILE_KINDS:
            total += 50 * 1024 * 1024  # DB·코드·정보는 다 합쳐도 수십MB
            continue
        disk = bk.scan_disk(kind)
        if scope == bk.SCOPE_DELTA:
            prev = _last_full_or_delta(db, kind)
            manifest = bk.load_manifest(prev.manifest_path if prev else None)
            cur = {"files": {r: {"size": s, "mtime": m, "sha256": ""} for r, (s, m) in disk.items()}}
            diff = bk.diff_manifest(manifest, cur)
            total += sum(disk[r][0] for r in diff["changed"] if r in disk)
        else:
            total += sum(s for s, _ in disk.values())
    return total


def _run_job(
    user_id: int, kinds: list[str], scope: str, delivery: str,
    note: Optional[str], dest: Optional[str],
) -> None:
    """딴 줄에서 도는 실제 작업. 요청 세션을 쓸 수 없으니 자기 세션을 새로 만든다."""
    bk.set_bundle_root(dest)   # 이 실행줄에만 걸린다(다른 요청은 기본 위치를 본다)
    db = SessionLocal()
    stamp = filename_timestamp()
    tmp_dir = bk.bundle_root() / "_임시"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        made: list[BackupRun] = []
        for kind in bk.ALL_KINDS:
            if kind not in kinds:
                continue
            seq = _next_seq(db, kind)
            base = None
            if kind in bk.FILE_KINDS and scope == bk.SCOPE_DELTA:
                base = _last_full_or_delta(db, kind)
                if base is None:
                    raise RuntimeError(
                        f"{bk.KIND_LABELS[kind]}는 아직 전체 백업이 없어 변경분을 만들 수 없습니다. "
                        "전체 백업을 먼저 만들어 주세요."
                    )

            if kind in bk.FILE_KINDS:
                if delivery == bk.DELIVERY_FOLDER:
                    result = bk.copy_drawing_folder(db, kind, seq, stamp)
                else:
                    prev_manifest = bk.load_manifest(base.manifest_path) if base else None
                    result = bk.write_drawing_bundle(
                        db, kind, scope, seq, stamp, prev_manifest,
                        [note] if note else [],
                    )
            elif kind == bk.KIND_DB:
                result = bk.write_record_bundle(db, seq, stamp, tmp_dir)
            elif kind == bk.KIND_CODE:
                result = bk.write_code_bundle(seq, stamp)
            else:
                result = bk.write_external_info(db, seq, stamp)

            row = BackupRun(
                kind=result["kind"], scope=result["scope"], seq=result["seq"],
                base_run_id=base.id if base else None, set_key=stamp,
                filename=result["filename"], dest_dir=result["dest_dir"],
                delivery=result["delivery"],
                file_size=result["file_size"], source_bytes=result["source_bytes"],
                file_count=result["file_count"], removed_count=result["removed_count"],
                manifest_path=result["manifest_path"], created_by=user_id, note=note,
            )
            db.add(row)
            db.commit()
            made.append(row)
            bk.job_made({
                "kind": result["kind"], "label": bk.KIND_LABELS[result["kind"]],
                "filename": result["filename"], "file_size": result["file_size"],
                "file_count": result["file_count"], "delivery": result["delivery"],
                # 비밀번호가 적혀 있어 묶음에서 뺀 파일(D-105 ②) — 화면이 크게 알려 준다
                "skipped_secret": result.get("skipped_secret") or [],
            })

        db.add(AuditLog(
            user_id=user_id, action="BACKUP_RUN", screen=SCREEN,
            detail={
                "kind": ", ".join(bk.KIND_LABELS[k] for k in kinds),
                "scope": bk.SCOPE_LABELS.get(scope, scope),
                "count": len(made),
                "path": str(bk.bundle_root()),
                "total_bytes": sum(r.file_size for r in made),
            },
        ))
        db.commit()
        bk.job_end()
    except Exception as exc:  # 어떤 실패든 화면에 이유가 보이게 남긴다
        db.rollback()
        bk.job_end(str(exc) or exc.__class__.__name__)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        db.close()


@router.post("/run")
def run_backup(
    body: RunRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission(PERM_RUN)),
):
    kinds = [k for k in bk.ALL_KINDS if not body.kinds or k in body.kinds]
    if not kinds:
        raise HTTPException(400, "백업할 항목을 골라 주세요")
    if body.scope not in (bk.SCOPE_FULL, bk.SCOPE_DELTA):
        raise HTTPException(400, "전체 또는 변경분만 만들 수 있습니다")
    if body.scope == bk.SCOPE_DELTA and any(k not in bk.FILE_KINDS for k in kinds):
        raise HTTPException(400, "변경분은 TDB·MDB 도면 파일만 만들 수 있습니다")
    if body.delivery not in (bk.DELIVERY_ZIP, bk.DELIVERY_FOLDER):
        raise HTTPException(400, "받는 방법이 올바르지 않습니다")
    if body.delivery == bk.DELIVERY_FOLDER and any(k not in bk.FILE_KINDS for k in kinds):
        raise HTTPException(400, "폴더로 그대로 만드는 것은 TDB·MDB 도면 파일만 됩니다")
    if bk.job_running():
        raise HTTPException(409, "이미 백업을 만드는 중입니다. 끝난 뒤에 다시 눌러 주세요")

    dest = _check_dest(body.dest)
    root = dest or bk.default_bundle_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(400, f"저장 위치를 쓸 수 없습니다: {exc}")

    need = _estimate_bytes(db, kinds, body.scope)
    free = shutil.disk_usage(root).free
    if free < need:
        raise HTTPException(
            400,
            f"저장 위치의 여유 공간이 부족합니다. 담을 자료가 "
            f"{need / 1024 / 1024 / 1024:.1f}GB인데 남은 공간은 "
            f"{free / 1024 / 1024 / 1024:.1f}GB입니다. 자리를 정리하시거나 "
            f"저장 위치를 외장하드로 바꿔 주세요.",
        )

    if not bk.job_begin(kinds, body.scope):
        raise HTTPException(409, "이미 백업을 만드는 중입니다")
    threading.Thread(
        target=_run_job,
        args=(
            user.id, kinds, body.scope, body.delivery,
            (body.note or "").strip() or None, str(dest) if dest else None,
        ),
        daemon=True,
    ).start()
    return {"started": True, "kinds": kinds, "scope": body.scope, "dest": str(root)}


@router.get("/progress")
def progress(user: User = Depends(current_user)):
    return bk.job_snapshot()


# ── 지금 상태 (화면 위쪽) ────────────────────────────────────────────────────
@router.get("/status")
def status(db: Session = Depends(get_db), user: User = Depends(current_user)):
    root = bk.default_bundle_root()
    free = shutil.disk_usage(root if root.exists() else root.anchor).free
    out = {
        "dest": str(root),
        "free_bytes": free,
        "running": bk.job_running(),
        "kinds": [],
    }
    for kind in bk.ALL_KINDS:
        last = _last_full_or_delta(db, kind)
        info = {
            "kind": kind,
            "label": bk.KIND_LABELS[kind],
            "can_delta": kind in bk.FILE_KINDS,
            "last_seq": last.seq if last else 0,
            "last_at": last.created_at.isoformat() if last and last.created_at else None,
            "last_scope": last.scope if last else None,
            "changed_count": None,
            "changed_bytes": None,
            "removed_count": None,
        }
        if kind in bk.FILE_KINDS:
            disk = bk.scan_disk(kind)
            info["current_count"] = len(disk)
            info["current_bytes"] = sum(s for s, _ in disk.values())
            manifest = bk.load_manifest(last.manifest_path if last else None)
            if manifest:
                cur = {
                    "files": {r: {"size": s, "mtime": m, "sha256": ""} for r, (s, m) in disk.items()}
                }
                diff = bk.diff_manifest(manifest, cur)
                info["changed_count"] = len(diff["changed"])
                info["changed_bytes"] = sum(disk[r][0] for r in diff["changed"] if r in disk)
                info["removed_count"] = len(diff["removed"])
        out["kinds"].append(info)
    return out


# ── 이력 ─────────────────────────────────────────────────────────────────────
def run_path(row: BackupRun) -> Path:
    """그 묶음이 실제로 있는 자리. 만들 때 적어 둔 폴더를 쓴다(기본 위치가 바뀌어도 찾는다)."""
    return Path(row.dest_dir or bk.default_bundle_root()) / row.filename


def _row_to_item(row: BackupRun, users: dict[int, str]) -> dict:
    path = run_path(row)
    exists = path.exists()
    # 지운 뒤에 같은 파일을 도로 갖다 놓았으면(외장하드에서 되돌려 놓는 경우) 다시 "있음"이다
    state = "EXISTS" if exists else ("DELETED" if row.file_deleted_at else "MISSING")
    return {
        "id": row.id,
        "kind": row.kind,
        "kind_label": bk.KIND_LABELS.get(row.kind, row.kind),
        "scope": row.scope,
        "scope_label": bk.SCOPE_LABELS.get(row.scope, row.scope),
        "seq": row.seq,
        "base_seq": None,
        "set_key": row.set_key,
        "filename": row.filename,
        "dest_dir": row.dest_dir or str(bk.default_bundle_root()),
        "delivery": row.delivery,
        "file_size": row.file_size,
        "source_bytes": row.source_bytes,
        "file_count": row.file_count,
        "removed_count": row.removed_count,
        "created_by": users.get(row.created_by or 0, ""),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "downloaded_at": row.downloaded_at.isoformat() if row.downloaded_at else None,
        "download_count": row.download_count,
        "note": row.note or "",
        "exists": exists,
        "state": state,
        "state_label": STATE_LABELS[state],
        "deleted_at": row.file_deleted_at.isoformat() if row.file_deleted_at else None,
        "deleted_by": users.get(row.file_deleted_by or 0, ""),
        "downloadable": exists and row.delivery == bk.DELIVERY_ZIP,
        "deletable": exists,   # 폴더로 만든 백업도 지울 수 있다(용량을 차지하는 것은 같다)
    }


def _load_runs(db: Session) -> list[dict]:
    rows = db.query(BackupRun).order_by(BackupRun.created_at.desc(), BackupRun.id.desc()).all()
    users = {u.id: u.name for u in db.query(User).all()}
    by_id = {r.id: r for r in rows}
    items = [_row_to_item(r, users) for r in rows]
    for item, row in zip(items, rows):
        if row.base_run_id and row.base_run_id in by_id:
            item["base_seq"] = by_id[row.base_run_id].seq
    return items


@router.get("/runs")
def list_runs(db: Session = Depends(get_db), user: User = Depends(current_user)):
    items = _load_runs(db)
    # 변경분을 이어 붙이는데 중간 회차를 안 받았으면 알려준다(CM이 말한 "다운이력 관리").
    missing: dict[str, list[int]] = {}
    for kind in bk.FILE_KINDS:
        seqs = [it for it in items if it["kind"] == kind]
        never = [it["seq"] for it in seqs if it["download_count"] == 0 and it["downloadable"]]
        if never:
            missing[kind] = sorted(never)
    return {"items": items, "not_downloaded": missing}


class NoteBody(BaseModel):
    note: str = ""


@router.post("/runs/{run_id}/note")
def update_note(
    run_id: int,
    body: NoteBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission(PERM_RUN)),
):
    row = db.get(BackupRun, run_id)
    if row is None:
        raise HTTPException(404, "그 백업 기록을 찾을 수 없습니다")
    row.note = (body.note or "").strip() or None
    db.add(AuditLog(
        user_id=user.id, action="UPDATE_NOTE", screen=SCREEN,
        detail={"kind": bk.KIND_LABELS.get(row.kind, row.kind), "note": row.note or ""},
    ))
    db.commit()
    return {"ok": True, "note": row.note or ""}


# ── 묶음 파일만 지우기 (D-107) ───────────────────────────────────────────────
@router.post("/runs/{run_id}/delete-file")
def delete_run_file(
    run_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission(PERM_DELETE)),
):
    """만들어 둔 묶음 파일(또는 폴더)을 지운다. **이력 줄과 목록표는 그대로 둔다.**

    한 번 받아 둔 백업이 서버 용량을 계속 차지해 CM이 요청한 기능이다. 여기서 지우는 것은
    백업 사본 하나뿐이고 시스템의 도면·자료·DB는 아무것도 건드리지 않는다.
    """
    row = db.get(BackupRun, run_id)
    if row is None:
        raise HTTPException(404, "그 백업 기록을 찾을 수 없습니다")
    path = run_path(row)
    if not path.exists():
        raise HTTPException(404, "묶음 파일이 저장 위치에 이미 없습니다")

    # 안전장치 — 만들 때 적어 둔 폴더 안의, 그 줄이 가리키는 이름일 때만 지운다.
    # (드라이브 뿌리나 저장 위치 폴더 자체를 지우는 사고를 막는다.)
    if path.name != row.filename or path.parent == path:
        raise HTTPException(400, "지울 수 있는 자리가 아닙니다")

    freed = row.file_size or 0
    try:
        if path.is_dir():
            freed = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
            shutil.rmtree(path)
        else:
            freed = path.stat().st_size
            path.unlink()
    except OSError as exc:
        raise HTTPException(400, f"묶음 파일을 지우지 못했습니다: {exc}")

    row.file_deleted_at = kst_now()
    row.file_deleted_by = user.id
    db.add(AuditLog(
        user_id=user.id, action="BACKUP_FILE_DELETE", screen=SCREEN,
        detail={
            "kind": bk.KIND_LABELS.get(row.kind, row.kind),
            "scope": bk.SCOPE_LABELS.get(row.scope, row.scope),
            "filename": row.filename,
            "path": str(path.parent),
            "total_bytes": freed,
        },
    ))
    db.commit()
    return {
        "ok": True, "freed": freed,
        "state": "DELETED", "state_label": STATE_LABELS["DELETED"],
        "deleted_at": row.file_deleted_at.isoformat(),
    }


# ── 받기 (이어받기 지원) ─────────────────────────────────────────────────────
_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _file_iter(path: Path, start: int, length: int) -> Iterator[bytes]:
    """파일의 일부만 읽어 내보낸다. 보통 def라 딴 줄에서 돌아 다른 화면을 멈추지 않는다."""
    remain = length
    with path.open("rb") as fh:
        fh.seek(start)
        while remain > 0:
            chunk = fh.read(min(CHUNK, remain))
            if not chunk:
                break
            remain -= len(chunk)
            yield chunk


@router.get("/runs/{run_id}/download")
def download_run(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission(PERM_RUN)),
):
    row = db.get(BackupRun, run_id)
    if row is None:
        raise HTTPException(404, "그 백업 기록을 찾을 수 없습니다")
    if row.delivery != bk.DELIVERY_ZIP:
        raise HTTPException(
            400, "이 백업은 압축하지 않고 폴더로 만든 것입니다. 탐색기에서 복사해 가져가 주세요"
        )
    path = run_path(row)
    if not path.exists():
        raise HTTPException(
            404,
            "묶음 파일을 화면에서 지웠습니다(이력만 남아 있습니다)" if row.file_deleted_at
            else "묶음 파일이 저장 위치에 없습니다(옮겼거나 지웠을 수 있습니다)",
        )

    total = path.stat().st_size
    start, end = 0, total - 1
    status_code = 200
    match = _RANGE_RE.match(request.headers.get("range", "") or "")
    if match and total > 0:
        first, last = match.group(1), match.group(2)
        if first:
            start = int(first)
            if last:
                end = min(int(last), total - 1)
        elif last:  # bytes=-500 → 마지막 500바이트
            start = max(total - int(last), 0)
        if start > end or start >= total:
            return Response(
                status_code=416, headers={"Content-Range": f"bytes */{total}"},
            )
        status_code = 206

    length = end - start + 1
    headers = {
        "Content-Disposition": content_disposition_header("attachment", row.filename),
        "Content-Length": str(length),
        # 이어받기가 된다고 브라우저에 알려 준다 — 이것이 없으면 처음부터 다시 받는다
        "Accept-Ranges": "bytes",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"

    # 처음부터 받기 시작할 때만 기록한다(이어받기까지 세면 받은 횟수가 부풀려진다)
    if start == 0:
        row.downloaded_at = kst_now()
        row.download_count = (row.download_count or 0) + 1
        db.add(AuditLog(
            user_id=user.id, action="BACKUP_DOWNLOAD", screen=SCREEN,
            detail={
                "kind": bk.KIND_LABELS.get(row.kind, row.kind),
                "scope": bk.SCOPE_LABELS.get(row.scope, row.scope),
                "filename": row.filename, "total_bytes": total,
            },
        ))
        db.commit()

    media = "application/zip" if row.filename.lower().endswith(".zip") else "text/plain; charset=utf-8"
    return StreamingResponse(
        _file_iter(path, start, length), status_code=status_code,
        media_type=media, headers=headers,
    )


# ── 엑셀 내보내기 ────────────────────────────────────────────────────────────
@router.get("/runs/export")
def export_runs(
    title: Optional[str] = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """지금 보이는 이력 표 그대로(행 번호 칸만 빼고 칸 구성이 같다)."""
    items = _load_runs(db)
    wb = openpyxl.Workbook()
    ws = wb.active
    popup_title = (title or "").strip() or "백업 이력"
    ws.title = popup_title[:31]
    # 칸 구성은 화면 표와 같다(행 번호·조치 칸만 빼고) — 엑셀 내보내기 공통 규칙
    ws.append([
        "회차", "종류", "범위", "파일명", "받는 방법", "담은 자료(MB)", "묶음 크기(MB)",
        "파일 수", "없어진 파일", "만든 사람", "만든 시각", "받은 횟수",
        "마지막 받은 시각", "상태", "비고",
    ])
    for it in items:
        scope = it["scope_label"]
        if it["scope"] == bk.SCOPE_DELTA and it["base_seq"]:
            scope = f"{scope} ({it['base_seq']}회차 이후)"
        ws.append([
            it["seq"], it["kind_label"], scope, it["filename"],
            "묶음 파일" if it["delivery"] == bk.DELIVERY_ZIP else "폴더",
            round((it["source_bytes"] or 0) / 1024 / 1024, 1),
            round((it["file_size"] or 0) / 1024 / 1024, 1) if it["delivery"] == bk.DELIVERY_ZIP else "",
            it["file_count"], it["removed_count"] or "", it["created_by"],
            (it["created_at"] or "").replace("T", " ")[:16],
            it["download_count"],
            (it["downloaded_at"] or "").replace("T", " ")[:16],
            it["state_label"], it["note"],
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(
        [7, 16, 18, 46, 11, 14, 14, 9, 12, 12, 18, 10, 18, 8, 30], start=1
    ):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename(SCREEN, popup_title)
    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen=SCREEN,
        detail={"kind": popup_title, "count": len(items)},
    ))
    db.commit()
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )
