"""1차 적재에서 빠진 것들을 마저 채운다.

빠진 이유:
  - 루트의 Index.xlsx: 폴더만 스캔하고 루트 파일은 안 봤음
  - '5. DRAWINGS' 안의 List/Index 표지, CAD 폰트 리소스(.shx/.ttf/.ctb), zip 등:
    도면대장이 다 커버한다고 보고 '5. DRAWINGS' 폴더 전체를 건너뛴 게 원인.
    실제로는 도면대장에 없는 보조파일이 섞여 있었다.

이 스크립트는:
  1) 루트 Index.xlsx를 문서 1건으로 등록
  2) '5. DRAWINGS' 전체를 (폴더, 파일명) 기준으로 다시 훑어서,
     - 이미 문서가 있는데 그 확장자 파일만 없으면 파일만 보충
     - 문서 자체가 없으면 새 문서로 등록
  둘 다 즉시 승인 상태로 '최신'에 저장한다 (초기 적재분이므로).

실행 (backend 폴더에서):
    venv\\Scripts\\python.exe scripts\\bulk_import_remaining.py --root "원본루트경로"
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app import storage  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Document, File  # noqa: E402
from bulk_import import copy_and_hash, get_or_create_system_user  # noqa: E402
from bulk_import_others import JUNK_EXTS  # noqa: E402

TARGET_FOLDER = "5. DRAWINGS"


def main():
    parser = argparse.ArgumentParser(description="1차 적재 누락분 보충")
    parser.add_argument("--root", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root)
    session = SessionLocal()
    system_user = get_or_create_system_user(session)
    session.commit()
    now = datetime.now(timezone.utc)

    added_docs = 0
    added_files = 0

    # --- 1) 루트 Index.xlsx ---
    root_index = root / "Index.xlsx"
    if root_index.is_file():
        exists = session.query(Document).filter(
            Document.drawing_no == "Index", Document.source_path.is_(None)
        ).first()
        if exists is None:
            print(f"[루트] Index.xlsx 등록 {'(미리보기)' if args.dry_run else ''}")
            if not args.dry_run:
                doc = Document(
                    doc_class="REPORT", drawing_no="Index", title="Index",
                    category=None, discipline=None, doc_type=None,
                    source_path=None, is_isometric=False, current_rev=0,
                    status="ACTIVE", has_dwg=False, has_pdf=False,
                )
                session.add(doc)
                session.flush()
                dest = storage.latest_file_path(None, "Index", "xlsx")
                size, sha = copy_and_hash(root_index, dest)
                session.add(File(
                    document_id=doc.id, rev=0, branch=None, file_ext="xlsx",
                    file_path=storage.to_relative(dest), original_filename=root_index.name,
                    file_size=size, sha256=sha, uploaded_by=system_user.id,
                    vendor_name=None, project_id=None, vendor_labeled_rev=None,
                    rev_mismatch_warning=False, review_status="APPROVED",
                    uploaded_at=now, is_current=True,
                ))
                doc.has_dwg = False
                doc.has_pdf = False
                session.commit()
            added_docs += 1
            added_files += 1
        else:
            print("[루트] Index.xlsx 이미 등록됨")

    # --- 2) 5. DRAWINGS 전체 재스캔 ---
    target_dir = root / TARGET_FOLDER
    groups: dict[tuple[Path, str], list[Path]] = defaultdict(list)
    for path in target_dir.rglob("*"):
        if not path.is_file():
            continue
        ext = path.suffix.lstrip(".").lower()
        if not ext or ext in JUNK_EXTS:
            continue
        groups[(path.parent, path.stem)].append(path)

    print(f"5. DRAWINGS 재스캔 그룹: {len(groups)}개")

    # drawing_no별 기존 문서 캐시 (경로 접두어로 같은 문서인지 판단하기 위해)
    by_drawing_no: dict[str, list[Document]] = defaultdict(list)
    for d in session.query(Document).filter(Document.category == TARGET_FOLDER).all():
        by_drawing_no[d.drawing_no].append(d)

    ambiguous = []

    for (folder, stem), paths in sorted(groups.items(), key=lambda kv: str(kv[0][0])):
        rel_dir = folder.relative_to(root)
        source_path_str = str(rel_dir)

        # 1순위: 경로까지 정확히 같은 문서
        doc = next((d for d in by_drawing_no.get(stem, []) if d.source_path == source_path_str), None)

        # 2순위: 같은 도면번호인데 이 폴더가 그 문서 경로의 하위 폴더인 경우
        # (예: 문서 경로 '5.9 ...', 실제 파일은 '5.9 ...\PDF' 안에 있는 흔한 패턴)
        if doc is None:
            candidates = [
                d for d in by_drawing_no.get(stem, [])
                if d.source_path and source_path_str.startswith(d.source_path)
            ]
            if len(candidates) == 1:
                doc = candidates[0]
            elif len(candidates) > 1:
                ambiguous.append(f"{source_path_str}\\{stem}\t후보 {len(candidates)}개: "
                                 f"{[d.id for d in candidates]}")
                continue

        if doc is None:
            parts = rel_dir.parts  # ('5. DRAWINGS', '5.x ...', ...)
            category = parts[0] if len(parts) > 0 else None
            discipline = parts[1] if len(parts) > 1 else None
            doc_type = parts[2] if len(parts) > 2 else None
            area = " / ".join(parts[3:]) if len(parts) > 3 else None
            exts_here = {p.suffix.lstrip(".").lower() for p in paths}
            is_isometric = bool(doc_type and "isometric" in doc_type.lower())

            print(f"[신규 문서] {source_path_str} \\ {stem}  ({','.join(exts_here)})")
            if not args.dry_run:
                doc = Document(
                    doc_class="REPORT", drawing_no=stem, title=stem,
                    category=category, discipline=discipline, doc_type=doc_type,
                    area=area, source_path=source_path_str, is_isometric=is_isometric,
                    current_rev=0, status="ACTIVE",
                    has_dwg="dwg" in exts_here, has_pdf="pdf" in exts_here,
                )
                session.add(doc)
                session.flush()
                by_drawing_no[stem].append(doc)
            added_docs += 1

        else:
            have_exts = {
                f.file_ext for f in session.query(File).filter(File.document_id == doc.id).all()
            }
            need = [p for p in paths if p.suffix.lstrip(".").lower() not in have_exts]
            if not need:
                continue
            print(f"[파일 보충] {source_path_str} \\ {stem}  -> {[p.name for p in need]}")
            paths = need  # 아래 공통 저장 루프에서 이것만 저장

        if args.dry_run:
            added_files += len(paths)
            continue

        for src in sorted(paths):
            ext = src.suffix.lstrip(".").lower()
            dest = storage.latest_file_path(doc.source_path, doc.drawing_no, ext)
            # 같은 문서에 같은 확장자가 이미 있으면(예: 신규 문서인데 그룹 안에 중복 확장자) 건너뛰지 않고 그대로 진행
            size, sha = copy_and_hash(src, dest)
            session.add(File(
                document_id=doc.id, rev=0, branch=None, file_ext=ext,
                file_path=storage.to_relative(dest), original_filename=src.name,
                file_size=size, sha256=sha, uploaded_by=system_user.id,
                vendor_name=None, project_id=None, vendor_labeled_rev=None,
                rev_mismatch_warning=False, review_status="APPROVED",
                uploaded_at=now, is_current=True,
            ))
            if ext == "dwg":
                doc.has_dwg = True
            if ext == "pdf":
                doc.has_pdf = True
            added_files += 1

        if added_docs % 20 == 0:
            session.commit()

    if not args.dry_run:
        session.commit()

    if ambiguous:
        report = Path(__file__).resolve().parent / "remaining_ambiguous.txt"
        report.write_text("\n".join(ambiguous), encoding="utf-8")
        print(f"모호해서 건너뜀: {len(ambiguous)}건 -> {report}")

    print("=" * 50)
    print(f"{'[미리보기] ' if args.dry_run else ''}추가된 문서: {added_docs}건 / 추가된 파일: {added_files}건")
    print("=" * 50)


if __name__ == "__main__":
    main()
