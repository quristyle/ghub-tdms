# -*- coding: utf-8 -*-
"""MDB 폴더 재정리 반영: CM이 `도면관리시스템\\MDB` 폴더를 손으로 직접 정리(이름변경·이동·
삭제·추가)한 뒤, 시스템 DB가 그 새 구조를 따라가도록 맞춘다.

- 파일은 내용(SHA256)으로 식별한다. 같은 내용의 파일이 다른 경로로 옮겨졌으면, 그 자료에
  이미 붙어있는 태그·설비유형·비고는 그대로 두고, 위치 기록(source_path)과 백업 사본 위치
  (storage_path)를 새 위치로 맞춘다. 소속 공사·연도는 최상위 폴더(=공사) 기준으로 다시
  계산한다 — 최상위 폴더가 안 바뀌었으면 결과도 그대로다.
- 원본에서 파일이 사라졌어도(삭제) storage/MDB에 이미 복사해둔 백업 사본이 있으므로 시스템
  에서 그 자료를 지우지 않는다 — 이 프로젝트 전체 원칙(삭제 없음, D-6)과 같은 이유.
- 새로 생긴 파일은 mdb_import.py 최초 적재와 같은 방식(태그/설비유형 자동 추정)으로 추가한다.
- 같은 내용의 파일이 여러 벌 있던 경우(중복)는 자동으로 짝짓되, 확실하지 않으면 건드리지
  않고 "확인 필요" 목록으로 보고만 한다 — 잘못 짝지어 엉뚱한 자료에 기존 태그가 붙는 사고를
  막기 위해서다.
- 여러 번 실행해도 안전하다 (현재 상태와 비교해 달라진 것만 반영).
"""
import hashlib
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))       # backend/scripts/ (mdb_import 임포트용)

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.mdb_utils import get_or_create_project, project_name_for, year_for  # noqa: E402
from app.models import MdbFile, MdbFileTag  # noqa: E402
from app.storage import mdb_file_path, to_relative  # noqa: E402

from mdb_import import (  # noqa: E402
    JUNK_EXTS,
    JUNK_NAMES,
    MDB_ROOT,
    extract_tags,
    guess_equipment_type,
)


def scan_current():
    """지금 MDB_ROOT 폴더를 훑어 sha256 -> [(상대경로, 파일명, 확장자, 크기, 바이트), ...] 맵을 만든다."""
    by_hash: dict[str, list[tuple]] = defaultdict(list)
    total = 0
    for dirpath, _dirs, files in os.walk(MDB_ROOT):
        for fn in files:
            if fn.lower() in JUNK_NAMES:
                continue
            ext = fn.rsplit(".", 1)[-1].lower() if "." in fn else ""
            if ext in JUNK_EXTS:
                continue
            full = Path(dirpath) / fn
            rel = str(full.relative_to(MDB_ROOT))
            data = full.read_bytes()
            sha256 = hashlib.sha256(data).hexdigest()
            by_hash[sha256].append((rel, fn, ext, len(data), data))
            total += 1
    return by_hash, total


def apply_move(db, row: MdbFile, rel: str, fn: str, data: bytes) -> None:
    """기존 자료 하나를 새 위치로 옮긴다 — 태그·설비유형·비고는 그대로 두고, 최상위 폴더(=공사)가
    바뀌었으면 소속 공사·연도만 새 경로 기준으로 다시 정한다."""
    old_dest = Path(STORAGE_ROOT) / row.storage_path
    new_dest = mdb_file_path(rel)
    new_dest.parent.mkdir(parents=True, exist_ok=True)
    if old_dest.is_file() and old_dest != new_dest:
        old_dest.replace(new_dest)
    elif not new_dest.is_file():
        # 백업 사본을 못 찾으면(비정상 상황) 원본 폴더에서 지금 읽은 내용으로 안전하게 채워둔다
        new_dest.write_bytes(data)
    row.source_path = rel
    row.original_filename = fn
    row.storage_path = to_relative(new_dest)
    project = get_or_create_project(db, project_name_for(rel))
    row.project_id = project.id
    row.year = year_for(rel)


def main():
    db = SessionLocal()
    by_hash, total_scanned = scan_current()

    rows = db.query(MdbFile).all()
    existing_hashes = {r.sha256 for r in rows}
    rows_by_hash: dict[str, list[MdbFile]] = defaultdict(list)
    for r in rows:
        rows_by_hash[r.sha256].append(r)

    unchanged = 0
    moved = 0
    missing_original: list[MdbFile] = []
    review_needed: list[tuple[MdbFile, list[str]]] = []

    for h, db_rows in rows_by_hash.items():
        candidates = list(by_hash.get(h, []))
        if not candidates:
            missing_original.extend(db_rows)
            continue

        # 먼저 경로가 그대로인 것들부터 제외 (안 바뀐 것)
        remaining_rows = []
        for r in db_rows:
            match = next((c for c in candidates if c[0] == r.source_path), None)
            if match:
                candidates.remove(match)
                unchanged += 1
            else:
                remaining_rows.append(r)

        if not remaining_rows:
            continue

        if len(remaining_rows) == len(candidates):
            # 개수가 딱 맞으면 이동/이름변경으로 보고 반영한다.
            # 후보가 2개 이상이었던 경우(같은 내용 파일이 여러 벌)는 순서로 짝지은 것이라
            # 확인이 필요하니 review 목록에도 같이 남긴다.
            ambiguous_case = len(db_rows) > 1 or len(by_hash.get(h, [])) > 1
            for r, (rel, fn, ext, size, data) in zip(remaining_rows, candidates):
                apply_move(db, r, rel, fn, data)
                moved += 1
                if ambiguous_case:
                    review_needed.append((r, [c[0] for c in by_hash.get(h, [])]))
        elif len(candidates) == 0:
            # 후보 전부 소진(다른 동일내용 파일에 이미 배정됨) — 이 자료들의 원본은 사라진 셈
            missing_original.extend(remaining_rows)
        else:
            # 개수가 안 맞아 자동으로 못 정한다 — 손대지 않고 확인 목록으로만 남긴다
            for r in remaining_rows:
                review_needed.append((r, [c[0] for c in by_hash.get(h, [])]))

    db.commit()

    # 새로 생긴 파일 반영 (mdb_import.py 최초 적재와 같은 규칙)
    created = 0
    for sha256, candidates in by_hash.items():
        if sha256 in existing_hashes:
            continue
        rel, fn, ext, size, data = candidates[0]
        rel_upper = rel.upper()
        rel_lower = rel.lower()
        tags = extract_tags(rel_upper)
        equipment_type = guess_equipment_type(rel_lower)
        project = get_or_create_project(db, project_name_for(rel))

        dest = mdb_file_path(rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)

        mdb_file = MdbFile(
            storage_path=to_relative(dest),
            source_path=rel,
            original_filename=fn,
            file_ext=ext,
            file_size=size,
            sha256=sha256,
            is_pdf=(ext == "pdf"),
            equipment_type=equipment_type,
            project_id=project.id,
            year=year_for(rel),
        )
        db.add(mdb_file)
        db.flush()
        for t in tags:
            db.add(MdbFileTag(mdb_file_id=mdb_file.id, tag_no=t))
        created += 1
        existing_hashes.add(sha256)

        if len(candidates) > 1:
            # 새로 추가된 자료인데 같은 내용이 여러 벌 있으면, 대표로 첫 번째만 적재했다는 뜻
            review_needed.append((mdb_file, [c[0] for c in candidates]))

    db.commit()

    print("=== MDB 재동기화 결과 ===")
    print(f"현재 MDB 폴더 스캔: 파일 {total_scanned}건")
    print(f"위치 변경 없음: {unchanged}건")
    print(f"이동/이름변경 반영: {moved}건")
    print(f"원본은 없어졌지만 백업은 안전한 자료(시스템엔 그대로 남음): {len(missing_original)}건")
    print(f"새로 추가된 자료: {created}건")

    scripts_dir = Path(__file__).parent
    if missing_original:
        report_path = scripts_dir / "mdb_resync_missing_originals.txt"
        with open(report_path, "w", encoding="utf-8") as f:
            for row in missing_original:
                f.write(f"{row.id}\t{row.source_path}\n")
        print(f"\n원본이 없어진 자료 목록 저장: {report_path.name}")

    if review_needed:
        report_path = scripts_dir / "mdb_resync_review_needed.txt"
        with open(report_path, "w", encoding="utf-8") as f:
            for row, all_candidates in review_needed:
                f.write(f"{row.id}\t{row.source_path}\t후보들: {' | '.join(all_candidates)}\n")
        print(f"같은 내용의 파일이 여러 벌 있어 확인이 필요한 자료: {len(review_needed)}건 -> {report_path.name}")


if __name__ == "__main__":
    main()
