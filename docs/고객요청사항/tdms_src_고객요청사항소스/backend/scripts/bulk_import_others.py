"""도면대장에 없는 나머지 폴더(1~4, 6~9) 적재.

`도면대장.xlsx`는 '5. DRAWINGS'만 담고 있어서 나머지 폴더는 적재되지 않았다.
이 스크립트는 원본 폴더를 직접 훑어서 나머지를 적재한다. 대장이 없으므로
분류정보는 폴더 경로에서 그대로 가져온다 (D-5: 폴더 경로 기반 분류).

문서 단위: 같은 폴더 안에서 확장자만 다른 같은 이름 = 한 문서 1건
  예) TT01-LS-10-PR-001_Equipment-List.pdf + .xls  →  문서 1건, 파일 2건

실행 (backend 폴더에서):
    venv\\Scripts\\python.exe scripts\\bulk_import_others.py ^
        --root "C:\\Users\\Ghub\\바탕화면\\주요자료\\G.hub 도면 최신화 최종본"
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Document, File  # noqa: E402
from app.utils import sanitize_path_component  # noqa: E402
from bulk_import import copy_and_hash, get_or_create_system_user  # noqa: E402

# 도면대장이 이미 담당하는 폴더 (여기서는 건너뜀)
SKIP_TOP_FOLDER = "5. DRAWINGS"

# 프로그램이 만드는 잠금/백업/로그 파일 — 자료가 아니므로 제외
JUNK_EXTS = {"ldb", "log", "bac", "tmp", "dwl", "dwl2"}

# 최상위 폴더 → doc_class (CLAUDE.md 6.3의 5가지 값만 사용)
DOC_CLASS_BY_TOP = {
    "1. GENERAL DESCRIPTION": "REPORT",
    "2. DESIGN BASIS": "SPEC",
    "3. PROCESS & FACILITIES DESCRIPTION": "REPORT",
    "4. CALCULATION SHEETS": "CALC",
    "6. LIST": "REPORT",
    "7. DATA SHEETS": "SPEC",
    "8. PROJECT SPECIFICATION & STANDARD DRAWING": "SPEC",
    "9. DETAIL DRAWING INDEX (AS-BUILT)": "REPORT",
}


def doc_class_for(top_folder: str, ext: str) -> str:
    if ext == "mdb":
        return "MDB_RECORD"
    return DOC_CLASS_BY_TOP.get(top_folder, "REPORT")


def main():
    parser = argparse.ArgumentParser(description="도면대장에 없는 나머지 폴더 적재")
    parser.add_argument("--root", required=True, help="원본 루트 경로")
    parser.add_argument("--storage", default=STORAGE_ROOT)
    parser.add_argument("--force", action="store_true", help="이미 적재돼 있어도 강행")
    args = parser.parse_args()

    root = Path(args.root)
    storage_root = Path(args.storage)
    import_time = datetime.now(timezone.utc)
    session = SessionLocal()

    already = (
        session.query(Document)
        .filter(Document.category.isnot(None), Document.category != SKIP_TOP_FOLDER)
        .count()
    )
    if already > 0 and not args.force:
        print(f"5. DRAWINGS 외 문서가 이미 {already}건 있습니다. 중복 적재를 막기 위해 중단합니다.")
        print("강행하려면 --force")
        return

    system_user = get_or_create_system_user(session)
    session.commit()

    # 1) 파일을 (폴더, 파일명(확장자 제외)) 기준으로 묶는다 = 문서 단위
    groups: dict[tuple[Path, str], list[Path]] = defaultdict(list)
    skipped_junk = 0

    for top in sorted(root.iterdir()):
        if not top.is_dir() or top.name == SKIP_TOP_FOLDER:
            continue
        for path in top.rglob("*"):
            if not path.is_file():
                continue
            ext = path.suffix.lstrip(".").lower()
            if not ext or ext in JUNK_EXTS:
                skipped_junk += 1
                continue
            groups[(path.parent, path.stem)].append(path)

    print(f"묶인 문서 후보: {len(groups)}건 (제외한 잠금/임시 파일: {skipped_junk}개)")

    doc_count = 0
    file_count = 0
    failed: list[str] = []

    for (folder, stem), paths in sorted(groups.items(), key=lambda kv: str(kv[0][0])):
        rel_dir = folder.relative_to(root)
        parts = rel_dir.parts

        top_folder = parts[0]
        category = top_folder
        discipline = parts[1] if len(parts) > 1 else None
        doc_type = parts[2] if len(parts) > 2 else None
        area = " / ".join(parts[3:]) if len(parts) > 3 else None

        exts = {p.suffix.lstrip(".").lower() for p in paths}
        is_isometric = bool(doc_type and "isometric" in doc_type.lower())

        doc = Document(
            doc_class=doc_class_for(top_folder, next(iter(exts)) if len(exts) == 1 else ""),
            drawing_no=stem,
            title=stem,
            category=category,
            discipline=discipline,
            doc_type=doc_type,
            isbl_osbl=None,
            elevation=None,
            area=area,
            source_path=str(rel_dir),
            is_isometric=is_isometric,
            current_rev=0,
            status="ACTIVE",
            has_dwg="dwg" in exts,
            has_pdf="pdf" in exts,
        )
        session.add(doc)
        session.flush()
        doc_count += 1

        for src in sorted(paths):
            ext = src.suffix.lstrip(".").lower()
            dest = (
                storage_root / "revisions"
                / f"{doc.id}_{sanitize_path_component(stem)}" / "rev0" / src.name
            )
            try:
                file_size, sha256_hex = copy_and_hash(src, dest)
            except OSError as e:
                failed.append(f"{doc.id}\t{stem}\t{ext}\t{src}\t{e}")
                continue

            relative_path = str(dest.relative_to(storage_root)).replace("\\", "/")
            session.add(File(
                document_id=doc.id,
                rev=0,
                branch=None,
                file_ext=ext,
                file_path=relative_path,
                original_filename=src.name,
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
            ))
            file_count += 1

        if doc_count % 100 == 0:
            session.commit()
            print(f"  진행 중... 문서 {doc_count}건")

    session.commit()

    if failed:
        report = Path(__file__).resolve().parent / f"others_failed_{import_time.strftime('%Y%m%d_%H%M%S')}.txt"
        report.write_text("\n".join(failed), encoding="utf-8")
        print(f"복사 실패 목록: {report}")

    print("=" * 50)
    print(f"추가된 문서: {doc_count}건")
    print(f"추가된 파일: {file_count}건")
    print(f"복사 실패: {len(failed)}건")
    print("=" * 50)


if __name__ == "__main__":
    main()
