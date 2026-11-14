# -*- coding: utf-8 -*-
"""2026-08-10 CM 지시: TT01-10-12-012 단건 정리 (일회성 스크립트).

같은 폴더에 도면번호 오타(끝에 - 하나 더 붙음)로 문서가 둘로 쪼개져 있던 건.
- 문서 8105 (TT01-10-12-012): DWG만 있음
- 문서 8106 (TT01-10-12-012-): PDF만 있음, 끝에 오타 -

2026-08-06 "-Model 접미사" 정리(작업 2)와 완전히 같은 패턴이라 같은 방식으로 처리한다:
- 8106의 PDF 파일을 8105로 옮기고 파일명도 8105의 도면번호(오타 없는 이름)로 맞춘다.
- 8106은 삭제하지 않고 is_archived=true로 보관함 이동 (D-6, 언제든 되살리기 가능).
- 8105.has_pdf = true 갱신.

사용법:
    venv\\Scripts\\python.exe scripts\\fix_TT01-10-12-012_20260810.py           # dry-run (기본)
    venv\\Scripts\\python.exe scripts\\fix_TT01-10-12-012_20260810.py --commit  # 실제 실행
"""
import argparse
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import ArchiveBatch, AuditLog, Document, File, User
from app.storage import latest_file_path, to_relative

SYSTEM_USERNAME = "bulk_import_system"
BASE_DOC_ID = 8105   # TT01-10-12-012 (DWG만)
DASH_DOC_ID = 8106   # TT01-10-12-012- (PDF만, 오타)


def pg_dump(label: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    out = Path(__file__).resolve().parents[2] / "backup" / "TDB" / f"dms_{label}_{ts}.dump"
    out.parent.mkdir(parents=True, exist_ok=True)
    pg_dump_exe = r"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"
    cmd = [pg_dump_exe, "-U", "dms_user", "-d", "dms", "-F", "c", "-f", str(out)]
    # 비밀번호를 코드에 적지 않고 .env에서 읽는다 (2026-09-29 — 적어 두면 코드 백업·
    # GitHub에 그대로 실려 나간다, D-105 ②)
    from sqlalchemy.engine import make_url
    from app.config import DATABASE_URL
    env = {"PGPASSWORD": make_url(DATABASE_URL).password or ""}
    print(f"  pg_dump 실행 -> {out.name}")
    subprocess.run(cmd, check=True, env={**__import__("os").environ, **env})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", action="store_true", help="실제 실행 (기본은 dry-run)")
    args = parser.parse_args()

    session = SessionLocal()
    system_user = session.query(User).filter_by(username=SYSTEM_USERNAME).one_or_none()
    if system_user is None:
        raise SystemExit(f"시스템 계정 '{SYSTEM_USERNAME}'가 없습니다.")

    base_doc = session.get(Document, BASE_DOC_ID)
    dash_doc = session.get(Document, DASH_DOC_ID)
    if base_doc is None or dash_doc is None:
        raise SystemExit("대상 문서를 찾을 수 없습니다.")

    print("=" * 70)
    print("[대상 확인]")
    print("=" * 70)
    print(f"  base : {base_doc.id} {base_doc.drawing_no!r} has_dwg={base_doc.has_dwg} has_pdf={base_doc.has_pdf}")
    print(f"  dash : {dash_doc.id} {dash_doc.drawing_no!r} has_dwg={dash_doc.has_dwg} has_pdf={dash_doc.has_pdf}")

    if base_doc.drawing_no != "TT01-10-12-012" or dash_doc.drawing_no != "TT01-10-12-012-":
        raise SystemExit("도면번호가 예상과 다릅니다. 스크립트를 중단합니다.")
    if not (base_doc.has_dwg and not base_doc.has_pdf and dash_doc.has_pdf and not dash_doc.has_dwg):
        raise SystemExit("보유 현황이 예상(base=DWG만, dash=PDF만)과 다릅니다. 스크립트를 중단합니다.")

    pdf_files = session.query(File).filter(
        File.document_id == dash_doc.id, File.is_current.is_(True), File.file_ext == "pdf"
    ).all()
    if len(pdf_files) != 1:
        raise SystemExit(f"dash 문서의 현재 PDF 파일이 1개가 아님 ({len(pdf_files)}개)")
    f = pdf_files[0]

    src = Path(STORAGE_ROOT) / f.file_path
    dst = latest_file_path(base_doc.source_path, base_doc.drawing_no, "pdf")

    print()
    print("[파일 이동 계획]")
    print(f"  src: {src}")
    print(f"  dst: {dst}")
    if not src.is_file():
        raise SystemExit(f"원본 파일이 없습니다: {src}")
    if dst.exists():
        raise SystemExit(f"대상 파일이 이미 있습니다: {dst}")

    if not args.commit:
        print()
        print("=" * 70)
        print("Dry-run: 실제 변경 없이 종료합니다. 실행하려면 --commit 붙이세요.")
        print("=" * 70)
        return

    print()
    print("=" * 70)
    print("[실행 시작] - 백업부터 뜹니다")
    print("=" * 70)
    pg_dump("실행전_TT01-10-12-012정리")

    now = datetime.now(timezone.utc)
    batch = ArchiveBatch(
        kind="DOCUMENT", label="TT01-10-12-012- 오타 문서 정리 (TT01-10-12-012로 흡수)",
        original_path=dash_doc.source_path, archived_by=system_user.id,
    )
    session.add(batch)
    session.flush()

    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dst))

        f.document_id = base_doc.id
        f.original_filename = f"{base_doc.drawing_no}.pdf"
        f.file_path = to_relative(dst)
        base_doc.has_pdf = True
        base_doc.updated_at = now
        dash_doc.is_archived = True
        dash_doc.archive_batch_id = batch.id
        dash_doc.updated_at = now

        session.add(AuditLog(
            user_id=system_user.id, action="MERGE_MODEL_SUFFIX",
            screen="일괄정리 스크립트(2026-08-10)",
            detail={"batch_id": batch.id, "base_doc_id": base_doc.id, "dash_doc_id": dash_doc.id,
                    "reason": "CM 지시: TT01-10-12-012- 끝 오타 문서를 TT01-10-12-012로 흡수"},
        ))
        session.commit()
    except Exception as e:
        print(f"  [!] 실행 중 오류 - 되돌리는 중: {e}")
        session.rollback()
        if dst.exists() and not src.exists():
            shutil.move(str(dst), str(src))
        raise

    print()
    print("=" * 70)
    print("[DB 커밋 완료] - 실행 후 백업 뜹니다")
    print("=" * 70)
    pg_dump("원본_TT01-10-12-012정리")
    print()
    print(f"완료. 문서 {base_doc.id}(TT01-10-12-012)에 DWG+PDF 모두 있음, "
          f"문서 {dash_doc.id}(TT01-10-12-012-)는 보관함(batch_id={batch.id})으로 이동됨.")


if __name__ == "__main__":
    main()
