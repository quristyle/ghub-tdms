"""bulk_import.py 실행 후 남은 누락 리포트를 재검색해서 채워 넣는 보정 스크립트.

등록대장의 '전체경로'가 실제 폴더 구조보다 얕은 경우(예: Isometric 구간에서
DWG/PDF 파일이 하위 폴더로 한 번 더 나뉜 경우)를 대비해, leaf 폴더 하위를
재귀 탐색해서 파일명이 일치하는 파일을 찾아 채워 넣는다.
기존에 이미 적재된 documents/files는 건드리지 않는다.

실행 예:
    venv\\Scripts\\python.exe scripts\\bulk_import_fix_missing.py ^
        --report scripts\\bulk_import_missing_20260716_010224.txt
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import File  # noqa: E402
from bulk_import import copy_and_hash, find_source_file, get_or_create_system_user  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="누락 리포트 재검색 및 보정 적재")
    parser.add_argument("--report", required=True, help="bulk_import.py가 만든 누락 리포트 경로")
    parser.add_argument("--storage", default=STORAGE_ROOT)
    args = parser.parse_args()

    storage_root = Path(args.storage)
    import_time = datetime.now(timezone.utc)

    lines = Path(args.report).read_text(encoding="utf-8").splitlines()
    print(f"누락 리포트 {len(lines)}건 재검색 시작")

    session = SessionLocal()
    system_user = get_or_create_system_user(session)
    session.commit()

    dir_index_cache: dict[Path, dict] = {}
    resolved = 0
    still_missing: list[str] = []

    for line in lines:
        doc_id_str, drawing_no, ext, old_src = line.split("\t")
        doc_id = int(doc_id_str)
        leaf_dir = Path(old_src).parent
        target_name = f"{drawing_no}.{ext}"

        found = find_source_file(leaf_dir, target_name.lower(), dir_index_cache)
        if found is None:
            still_missing.append(line)
            continue

        existing = (
            session.query(File)
            .filter_by(document_id=doc_id, rev=0, file_ext=ext)
            .one_or_none()
        )
        if existing is not None:
            resolved += 1
            continue

        dest = storage_root / "revisions" / f"{doc_id}_{drawing_no}" / "rev0" / f"{drawing_no}.{ext}"
        file_size, sha256_hex = copy_and_hash(found, dest)
        relative_path = str(dest.relative_to(storage_root)).replace("\\", "/")

        file_row = File(
            document_id=doc_id,
            rev=0,
            branch=None,
            file_ext=ext,
            file_path=relative_path,
            original_filename=found.name,
            file_size=file_size,
            sha256=sha256_hex,
            uploaded_by=system_user.id,
            vendor_name=None,
            project_id=None,
            vendor_labeled_rev=None,
            rev_mismatch_warning=False,
            review_status="APPROVED",
            review_note=None,
            uploaded_at=import_time,
            is_current=True,
        )
        session.add(file_row)
        resolved += 1

        if resolved % 500 == 0:
            session.commit()
            print(f"  진행 중... {resolved}건 보정")

    session.commit()

    report_path = Path(args.report).with_name(
        f"bulk_import_still_missing_{import_time.strftime('%Y%m%d_%H%M%S')}.txt"
    )
    if still_missing:
        report_path.write_text("\n".join(still_missing), encoding="utf-8")

    print("=" * 50)
    print(f"보정 완료: {resolved}건")
    print(f"끝까지 못 찾음: {len(still_missing)}건")
    if still_missing:
        print(f"최종 누락 리포트: {report_path}")
    print("=" * 50)


if __name__ == "__main__":
    main()
