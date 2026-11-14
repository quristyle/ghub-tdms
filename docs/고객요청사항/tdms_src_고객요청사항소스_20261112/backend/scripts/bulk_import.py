"""초기 데이터 적재 (Bulk Import) — CLAUDE.md 7절.

도면대장.xlsx를 읽어 documents/files를 생성하고, 원본 파일을
storage/revisions/{document_id}_{drawing_no}/rev0/ 로 복사한다.

실행 예:
    venv\\Scripts\\python.exe scripts\\bulk_import.py ^
        --root "C:\\Users\\Ghub\\바탕화면\\주요자료\\G.hub 도면 최신화 최종본" ^
        --xlsx "..\\참고자료\\도면대장.xlsx"
"""

import argparse
import hashlib
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Document, File, User  # noqa: E402

SYSTEM_USERNAME = "bulk_import_system"
SYSTEM_USER_NAME = "일괄등록"
SHEET_NAME = "도면대장"


def get_or_create_system_user(session) -> User:
    user = session.query(User).filter_by(username=SYSTEM_USERNAME).one_or_none()
    if user is not None:
        return user
    user = User(
        username=SYSTEM_USERNAME,
        password_hash="!disabled",  # 로그인 불가 계정 (D-12)
        name=SYSTEM_USER_NAME,
        role="INTERNAL",
        is_active=False,
    )
    session.add(user)
    session.flush()
    return user


def find_source_file(leaf_dir: Path, filename_lower: str, cache: dict) -> Path | None:
    """전체경로가 실제 폴더보다 얕은 경우(예: Isometric DWG/PDF 하위 폴더 분리)를 대비해
    leaf_dir 하위를 재귀 탐색한다. leaf_dir당 한 번만 인덱싱해 재사용한다."""
    if leaf_dir not in cache:
        index: dict[str, Path] = {}
        if leaf_dir.is_dir():
            for dirpath, _dirs, files in os.walk(leaf_dir):
                for f in files:
                    index.setdefault(f.lower(), Path(dirpath) / f)
        cache[leaf_dir] = index
    return cache[leaf_dir].get(filename_lower)


def copy_and_hash(src: Path, dest: Path) -> tuple[int, str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    sha256 = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha256.update(chunk)
    return dest.stat().st_size, sha256.hexdigest()


def blank(value):
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


def main():
    parser = argparse.ArgumentParser(description="도면대장.xlsx 초기 데이터 적재")
    parser.add_argument("--root", required=True, help="원본 파일 루트 경로 (전체경로 컬럼의 기준 폴더)")
    parser.add_argument("--xlsx", default=str(Path(__file__).resolve().parents[2] / "참고자료" / "도면대장.xlsx"))
    parser.add_argument("--storage", default=STORAGE_ROOT, help="시스템 storage 경로")
    parser.add_argument("--force", action="store_true", help="documents에 기존 데이터가 있어도 강행")
    args = parser.parse_args()

    root = Path(args.root)
    storage_root = Path(args.storage)
    import_time = datetime.now(timezone.utc)

    session = SessionLocal()

    existing = session.query(Document).count()
    if existing > 0 and not args.force:
        print(f"documents에 이미 {existing}건이 있습니다. 중복 적재를 막기 위해 중단합니다. "
              f"강행하려면 --force를 붙이세요.")
        return

    system_user = get_or_create_system_user(session)
    session.commit()

    wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)
    ws = wb[SHEET_NAME]

    doc_count = 0
    file_count = 0
    missing: list[str] = []
    dir_index_cache: dict[Path, dict] = {}

    for row in ws.iter_rows(min_row=2, values_only=True):
        drawing_no = row[1]
        if drawing_no is None:
            continue

        doc_class = blank(row[2]) or "DRAWING"
        category = blank(row[3])
        discipline = blank(row[4])
        doc_type = blank(row[5])
        isbl_osbl = blank(row[6])
        elevation = blank(row[7])
        area = blank(row[8])
        has_dwg = row[9] == "Y"
        has_pdf = row[11] == "Y"
        source_path = blank(row[15])
        is_isometric = bool(doc_type and "isometric" in doc_type.lower())

        doc = Document(
            doc_class=doc_class,
            drawing_no=drawing_no,
            title=drawing_no,
            category=category,
            discipline=discipline,
            doc_type=doc_type,
            isbl_osbl=isbl_osbl,
            elevation=elevation,
            area=area,
            source_path=source_path,
            is_isometric=is_isometric,
            current_rev=0,
            status="ACTIVE",
            has_dwg=has_dwg,
            has_pdf=has_pdf,
        )
        session.add(doc)
        session.flush()
        doc_count += 1

        for ext, flag in (("dwg", has_dwg), ("pdf", has_pdf)):
            if not flag:
                continue
            src_dir = root / source_path if source_path else root
            target_name = f"{drawing_no}.{ext}"
            src = src_dir / target_name
            if not src.is_file():
                found = find_source_file(src_dir, target_name.lower(), dir_index_cache)
                if found is None:
                    missing.append(f"{doc.id}\t{drawing_no}\t{ext}\t{src}")
                    continue
                src = found

            dest = storage_root / "revisions" / f"{doc.id}_{drawing_no}" / "rev0" / f"{drawing_no}.{ext}"
            file_size, sha256_hex = copy_and_hash(src, dest)
            relative_path = str(dest.relative_to(storage_root)).replace("\\", "/")

            file_row = File(
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
            )
            session.add(file_row)
            file_count += 1

        if doc_count % 500 == 0:
            session.commit()
            print(f"  진행 중... {doc_count}건 처리")

    session.commit()

    report_path = Path(__file__).resolve().parent / f"bulk_import_missing_{import_time.strftime('%Y%m%d_%H%M%S')}.txt"
    if missing:
        report_path.write_text("\n".join(missing), encoding="utf-8")

    print("=" * 50)
    print(f"documents 적재: {doc_count}건")
    print(f"files 적재: {file_count}건")
    print(f"원본 파일 누락: {len(missing)}건")
    if missing:
        print(f"누락 목록 리포트: {report_path}")
    print("=" * 50)


if __name__ == "__main__":
    main()
