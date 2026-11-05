"""저장소를 최신/이력/검수대기/반출 구조로 재배치 (1회성).

이전:  storage/revisions/{문서ID}_{도면번호}/rev{N}/파일
이후:  storage/최신/{원본경로}/{도면번호}.{확장자}          ← 지금 유효한 승인본
       storage/이력/{원본경로}/{도면번호}/rev{N}/파일        ← 구본·반려본·분기본
       storage/검수대기/{문서ID}_{도면번호}/rev{N}/파일       ← 승인 전
       storage/반출/{업체}/{일자}_{도면번호}/파일            ← 업체에 나간 사본

같은 드라이브 안에서 '이동'하므로 용량이 두 배로 늘지 않는다.
DB의 file_path도 함께 갱신한다.

실행 (backend 폴더에서):
    venv\\Scripts\\python.exe scripts\\migrate_storage_layout.py
    venv\\Scripts\\python.exe scripts\\migrate_storage_layout.py --dry-run   (미리보기)
"""

import argparse
import shutil
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app import storage  # noqa: E402
from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Document, File  # noqa: E402


def target_path(doc: Document, f: File, current_name: str) -> Path:
    """이 파일이 새 구조에서 있어야 할 자리."""
    if f.review_status == "PENDING_REVIEW":
        return storage.pending_file_path(doc.id, doc.drawing_no, f.rev, f.branch, current_name)
    if f.is_current and f.review_status == "APPROVED":
        return storage.latest_file_path(doc.source_path, doc.drawing_no, f.file_ext)
    # 구본 / 반려본 / 분기본 / 통합처리본
    return storage.history_file_path(doc.source_path, doc.drawing_no, f.rev, f.branch, current_name)


def main():
    parser = argparse.ArgumentParser(description="저장소 구조 재배치")
    parser.add_argument("--dry-run", action="store_true", help="옮기지 않고 계획만 출력")
    args = parser.parse_args()

    root = Path(STORAGE_ROOT)
    session = SessionLocal()

    rows = (
        session.query(File, Document)
        .join(Document, Document.id == File.document_id)
        .order_by(File.id)
        .all()
    )
    print(f"대상 파일: {len(rows)}건")

    moved = 0
    already = 0
    missing = []
    counts = {"최신": 0, "이력": 0, "검수대기": 0}

    for f, doc in rows:
        src = root / f.file_path
        current_name = Path(f.file_path).name
        dest = target_path(doc, f, current_name)

        bucket = dest.relative_to(root).parts[0]
        counts[bucket] = counts.get(bucket, 0) + 1

        if src.resolve() == dest.resolve():
            already += 1
            continue

        if not src.is_file():
            missing.append(f"{doc.id}\t{doc.drawing_no}\t{f.file_path}")
            continue

        if not args.dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                dest.unlink()
            shutil.move(str(src), str(dest))
            f.file_path = storage.to_relative(dest)

        moved += 1
        if moved % 1000 == 0:
            if not args.dry_run:
                session.commit()
            print(f"  진행 중... {moved}건")

    if not args.dry_run:
        session.commit()

    # 반출 폴더 이름 변경 (distributed → 반출)
    old_dist = root / "distributed"
    new_dist = root / storage.DISTRIBUTED
    if old_dist.is_dir() and not args.dry_run:
        if new_dist.exists():
            shutil.rmtree(new_dist)
        shutil.move(str(old_dist), str(new_dist))
        # DB의 반출 경로도 갱신
        from app.models import Distribution
        for d in session.query(Distribution).all():
            if d.file_saved_path and d.file_saved_path.startswith("distributed/"):
                d.file_saved_path = d.file_saved_path.replace("distributed/", f"{storage.DISTRIBUTED}/", 1)
        session.commit()
        print("반출 폴더 이름 변경 완료 (distributed → 반출)")

    # 빈 revisions 폴더 정리
    old_rev = root / "revisions"
    if old_rev.is_dir() and not args.dry_run:
        remaining = [p for p in old_rev.rglob("*") if p.is_file()]
        if remaining:
            print(f"주의: revisions 폴더에 파일 {len(remaining)}개가 남아 DB에 없는 파일입니다. 폴더를 남겨둡니다.")
        else:
            shutil.rmtree(old_rev)
            print("빈 revisions 폴더 삭제 완료")

    if missing:
        report = Path(__file__).resolve().parent / "migrate_missing.txt"
        report.write_text("\n".join(missing), encoding="utf-8")
        print(f"원본 없음 {len(missing)}건 → {report}")

    print("=" * 52)
    print(f"{'[미리보기] ' if args.dry_run else ''}이동: {moved}건 / 이미 제자리: {already}건 / 원본없음: {len(missing)}건")
    for k, v in counts.items():
        print(f"  {k}: {v}건")
    print("=" * 52)


if __name__ == "__main__":
    main()
