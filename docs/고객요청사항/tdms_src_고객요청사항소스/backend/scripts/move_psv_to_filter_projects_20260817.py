"""1회성: PSV 안전밸브 Data Sheet 11건을 설비 폴더에서 원래 공사 폴더로 되돌린다.

CM 지시(2026-08-17):
  · `2012. 02. - SK가스 Tank Terminal Project\\5. Instrument\\050. NG110-01&11 Pressure Safety
    Valve\\1-2.SPECIFICATION (추가)` 폴더는 필요 없으니 삭제한다.
  · 그 안의 11건을 원래 공사인 `2016. 07. - 육상출하 필터 7기 설치 공사`(5건),
    `2016. 12. - 육상출하 필터 6기 설치 공사`(6건) 밑 `1. Instrument Data Sheet` 폴더로 살린다.
  · 원본 폴더(도면관리시스템\\MDB)와 앱(storage\\MDB + DB) 양쪽 모두 반영한다.

배경: 원본 폴더에는 이 11건이 공사 폴더와 설비 폴더 두 군데에 중복으로 있었고, 앱에는
설비 폴더 쪽 한 벌만 들어가 있었다. 그래서 앱에서 공사로 찾으면 PSV 자료가 안 나왔다.

앱 쪽은 지웠다 새로 넣지 않고 **옮기기**로 처리한다 — 그래야 각 자료에 지정된
Tag No(NG110-01, NG110-11)와 비고가 그대로 유지된다. 옮기면 공사·연도는
`resync_project_and_year`가 새 폴더명을 보고 자동으로 다시 잡는다(설비유형은 안 건드림).

어느 파일이 어느 공사로 가는지는 원본 폴더의 공사별 `1. Instrument Data Sheet` 내용을
읽어서 정한다(하드코딩하지 않는다). 옮기기 전에 앱 파일과 원본 파일의 내용(SHA256)이
같은지 한 건씩 확인하고, 하나라도 다르면 아무것도 바꾸지 않고 멈춘다.

  확인:  python scripts/move_psv_to_filter_projects_20260817.py --dry-run
  반영:  python scripts/move_psv_to_filter_projects_20260817.py --execute
"""

import argparse
import hashlib
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.mdb_utils import project_name_for
from app.models import AuditLog, MdbFile, MdbFolderPlaceholder, User
from app.routers.mdb_editor import filename_of, folder_of, move_backup_file, resync_project_and_year

SYSTEM_USERNAME = "bulk_import_system"

# 비울 폴더 (원본·앱 공통 상대경로)
SOURCE_FOLDER = (
    "2012. 02. - SK가스 Tank Terminal Project\\5. Instrument\\"
    "050. NG110-01&11 Pressure Safety Valve\\1-2.SPECIFICATION (추가)"
)

# 자료를 되살릴 공사 폴더 (원본에서 매핑을 읽어올 곳)
TARGET_FOLDERS = [
    "2016. 07. - 육상출하 필터 7기 설치 공사\\1. Instrument Data Sheet",
    "2016. 12. - 육상출하 필터 6기 설치 공사\\1. Instrument Data Sheet",
]

# 원본 MDB 폴더 (프로젝트 폴더 바로 밑)
DEFAULT_MDB_ROOT = Path(__file__).resolve().parent.parent.parent / "MDB"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build_mapping(mdb_root: Path) -> dict[str, str]:
    """원본의 공사별 `1. Instrument Data Sheet` 폴더를 읽어 {파일명: 새 폴더} 를 만든다."""
    mapping: dict[str, str] = {}
    for folder in TARGET_FOLDERS:
        d = mdb_root / folder.replace("\\", "/")
        if not d.is_dir():
            raise SystemExit(f"원본에 폴더가 없습니다: {folder}")
        for f in sorted(d.iterdir()):
            if f.is_file():
                if f.name in mapping:
                    raise SystemExit(f"같은 파일명이 두 공사에 있습니다: {f.name}")
                mapping[f.name] = folder
    return mapping


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--mdb-root", default=str(DEFAULT_MDB_ROOT), help="원본 MDB 폴더 경로")
    args = parser.parse_args()
    if not args.dry_run and not args.execute:
        parser.error("--dry-run 또는 --execute 중 하나를 지정하세요")

    mdb_root = Path(args.mdb_root)
    storage_root = Path(STORAGE_ROOT)
    mapping = build_mapping(mdb_root)
    print(f"원본에서 읽은 배치표 {len(mapping)}건")
    for folder in TARGET_FOLDERS:
        names = [n for n, f in mapping.items() if f == folder]
        print(f"  {folder}  -> {len(names)}건")

    db = SessionLocal()
    try:
        # LIKE에서 역슬래시·%·_ 는 특수문자라 그대로 쓰면 안 맞는다 (mdb_editor.py와 같은 방식으로 이스케이프)
        escaped = SOURCE_FOLDER.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = (
            db.query(MdbFile)
            .filter(MdbFile.is_archived.is_(False),
                    MdbFile.source_path.like(f"{escaped}\\\\%", escape="\\"))
            .order_by(MdbFile.original_filename)
            .all()
        )
        print(f"\n앱에서 옮길 자료 {len(rows)}건")
        if not rows:
            print("대상 없음 — 이미 처리됐을 수 있습니다.")
            return

        # --- 옮기기 전 전수 검증: 배치표에 있고, 원본 파일과 내용이 같아야 한다 ---
        plans = []
        problems = []
        for row in rows:
            name = row.original_filename
            target_folder = mapping.get(name)
            if target_folder is None:
                problems.append(f"{name}: 원본 공사 폴더에 같은 이름이 없습니다")
                continue
            app_file = storage_root / row.storage_path
            orig_file = mdb_root / target_folder.replace("\\", "/") / name
            if not app_file.is_file():
                problems.append(f"{name}: 앱 파일이 없습니다 ({row.storage_path})")
                continue
            if sha256_of(app_file) != sha256_of(orig_file):
                problems.append(f"{name}: 앱 파일과 원본 파일의 내용이 다릅니다")
                continue
            plans.append((row, f"{target_folder}\\{name}"))

        if problems:
            print("\n[중단] 아래 문제가 있어 아무것도 바꾸지 않았습니다:")
            for p in problems:
                print(f"  - {p}")
            raise SystemExit(1)

        print("검증 통과 — 11건 모두 원본과 내용이 같습니다.\n")
        for row, new_path in plans:
            print(f"  {row.original_filename}")
            print(f"     {folder_of(row.source_path)}")
            print(f"  -> {folder_of(new_path)}   (공사: {project_name_for(new_path)})")

        if args.dry_run:
            print("\n[확인 모드] 아무것도 바꾸지 않았습니다.")
            return

        # --- 앱: 자료 옮기기 (Tag No·비고 유지) ---
        user = db.query(User).filter_by(username=SYSTEM_USERNAME).one()
        now = datetime.now(timezone.utc)
        moved = []
        for row, new_path in plans:
            old_path = row.source_path
            row.storage_path = move_backup_file(old_path, new_path, row.storage_path)
            row.source_path = new_path
            row.original_filename = filename_of(new_path)
            resync_project_and_year(db, row)
            row.updated_at = now
            moved.append({"mdb_file_id": row.id, "filename": row.original_filename,
                          "from": folder_of(old_path), "to": folder_of(new_path)})

        # 비운 폴더는 CM 지시대로 없앤다 -> 표시용 placeholder를 남기지 않는다
        stale = db.query(MdbFolderPlaceholder).filter(
            MdbFolderPlaceholder.path.in_([SOURCE_FOLDER])
        ).all()
        for p in stale:
            db.delete(p)

        db.add(AuditLog(
            user_id=user.id, action="MOVE_DOCUMENT", screen="MDB 편집",
            detail={"scope": "mdb", "bulk": True, "count": len(moved),
                    "reason": "PSV Data Sheet를 원래 공사 폴더로 되돌림 (CM 지시 2026-08-17)",
                    "removed_folder": SOURCE_FOLDER, "moved": moved},
        ))
        db.commit()
        print(f"\n[앱] 자료 {len(moved)}건 옮김 완료")
    finally:
        db.close()

    # --- 앱 storage: 비워진 폴더 삭제 ---
    app_folder = storage_root / "MDB" / SOURCE_FOLDER.replace("\\", "/")
    if app_folder.is_dir():
        left = [p for p in app_folder.rglob("*") if p.is_file()]
        if left:
            print(f"[앱] 폴더에 파일이 {len(left)}개 남아 삭제하지 않았습니다: {app_folder}")
        else:
            shutil.rmtree(app_folder)
            print(f"[앱] 빈 폴더 삭제: {SOURCE_FOLDER}")

    # --- 원본 폴더: 중복본 폴더 삭제 ---
    orig_folder = mdb_root / SOURCE_FOLDER.replace("\\", "/")
    if orig_folder.is_dir():
        n = len([p for p in orig_folder.rglob("*") if p.is_file()])
        shutil.rmtree(orig_folder)
        print(f"[원본] 중복본 폴더 삭제: {SOURCE_FOLDER} (파일 {n}개)")

    print("\n[반영 완료]")


if __name__ == "__main__":
    main()
