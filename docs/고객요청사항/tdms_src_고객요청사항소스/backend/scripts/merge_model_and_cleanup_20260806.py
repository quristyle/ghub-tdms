# -*- coding: utf-8 -*-
"""2026-08-06 CM 지시 3건 일괄 처리 (일회성 스크립트).

작업 1: 5.5\HVAC Drawing\2.ADMINISTRATION & CONTROL BUILDING\OLD 폴더 통째로 보관함으로 (20건)
작업 2: 폴더 같고 -Model↔원본이 PDF↔DWG 짝인 자료 (857건)
        - Model 문서의 PDF를 원본 문서로 옮기고 파일명도 원본 이름과 같게 변경
        - Model 문서 자체는 보관함으로 이동 (내용은 원본에 흡수됨)
        - 원본 문서 has_pdf=true 갱신
작업 3: 원본에 이미 DWG+PDF 다 있는데 별개 Model 문서로 중복 등록된 자료 (6건)
        - Model 문서 보관함으로 이동
        - Model의 PDF 파일은 이력 폴더로 옮겨 최신 폴더에서 제거 (되살리기용으로 파일은 보존)

D-6 원칙 준수: 실제 삭제(DELETE) 없음. is_archived=true로 숨기고 ArchiveBatch에 기록해
CM이 "폴더·자료 편집 > 보관함"에서 언제든 되살릴 수 있게 한다.

사용법:
    venv\\Scripts\\python.exe scripts\\merge_model_and_cleanup_20260806.py           # dry-run (기본)
    venv\\Scripts\\python.exe scripts\\merge_model_and_cleanup_20260806.py --commit  # 실제 실행
"""
import argparse
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import ArchiveBatch, AuditLog, Document, File, User
from app.storage import history_file_path, latest_file_path, to_relative

SYSTEM_USERNAME = "bulk_import_system"
OLD_FOLDER_PATH = r"5. DRAWINGS\5.5   HVAC Drawing\2.ADMINISTRATION & CONTROL BUILDING\OLD"
SUFFIX_RE = re.compile(r"^(.*)-model$", re.IGNORECASE)


def get_system_user(session) -> User:
    u = session.query(User).filter_by(username=SYSTEM_USERNAME).one_or_none()
    if u is None:
        raise SystemExit(f"시스템 계정 '{SYSTEM_USERNAME}'가 없습니다.")
    return u


def pg_dump(label: str) -> Path:
    """실행 전/후 백업. label을 파일명에 넣어 어떤 시점인지 알아보게."""
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    out = Path(__file__).resolve().parents[2] / "backup" / "TDB" / f"dms_{label}_{ts}.dump"
    out.parent.mkdir(parents=True, exist_ok=True)
    pg_dump_exe = r"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"
    cmd = [
        pg_dump_exe, "-U", "dms_user", "-d", "dms",
        "-F", "c", "-f", str(out),
    ]
    # 비밀번호를 코드에 적지 않고 .env에서 읽는다 (2026-09-29 — 적어 두면 코드 백업·
    # GitHub에 그대로 실려 나간다, D-105 ②)
    from sqlalchemy.engine import make_url
    from app.config import DATABASE_URL
    env = {"PGPASSWORD": make_url(DATABASE_URL).password or ""}
    print(f"  pg_dump 실행 → {out.name}")
    subprocess.run(cmd, check=True, env={**__import__("os").environ, **env})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", action="store_true", help="실제 실행 (기본은 dry-run)")
    args = parser.parse_args()

    session = SessionLocal()
    system_user = get_system_user(session)
    now = datetime.now(timezone.utc)

    # ==========================================================
    # 대상 수집
    # ==========================================================
    print("=" * 70)
    print("[대상 수집]")
    print("=" * 70)

    # 작업 1: OLD 폴더
    old_docs = session.query(Document).filter(
        Document.source_path == OLD_FOLDER_PATH,
        Document.is_archived == False,
    ).all()
    print(f"작업 1 (OLD 폴더 archive): {len(old_docs)}건")

    # 작업 2, 3: -Model 짝 매칭 (같은 폴더에 원본이 있는 것만)
    all_docs = session.query(Document).filter(Document.is_archived == False).all()
    by_key = defaultdict(list)
    for d in all_docs:
        by_key[(d.drawing_no.strip().lower(), d.source_path)].append(d)

    work2 = []  # (model_doc, base_doc): 원본 DWG만 + Model PDF만
    work3 = []  # (model_doc, base_doc): 원본 DWG+PDF 다 있음, Model PDF만
    unhandled = []  # 그 외 케이스 (없어야 함)

    for d in all_docs:
        m = SUFFIX_RE.match(d.drawing_no.strip())
        if not m:
            continue
        base = m.group(1).strip()
        same = [c for c in by_key.get((base.lower(), d.source_path), []) if c.id != d.id]
        if not same:
            unhandled.append((d, None, "짝 없음(동일 폴더)"))
            continue
        c = same[0]
        if c.has_dwg and not c.has_pdf and d.has_pdf and not d.has_dwg:
            work2.append((d, c))
        elif c.has_dwg and c.has_pdf and d.has_pdf and not d.has_dwg:
            work3.append((d, c))
        else:
            unhandled.append((d, c, f"비표준 조합: 원본DWG={c.has_dwg}/PDF={c.has_pdf}, Model DWG={d.has_dwg}/PDF={d.has_pdf}"))

    print(f"작업 2 (Model PDF → 원본 흡수, 이름 변경): {len(work2)}건")
    print(f"작업 3 (원본에 이미 PDF, Model 정리): {len(work3)}건")
    if unhandled:
        print(f"⚠ 처리 방침 없는 케이스: {len(unhandled)}건")
        for ex in unhandled[:5]:
            print(f"    {ex[0].id} {ex[0].drawing_no}: {ex[2]}")

    # ==========================================================
    # 실행 계획 (파일 이동 경로 미리 계산)
    # ==========================================================
    print()
    print("=" * 70)
    print("[실행 계획]")
    print("=" * 70)

    work2_plans = []  # {'model_doc', 'base_doc', 'model_file', 'src', 'dst'}
    for d, c in work2:
        files = session.query(File).filter(
            File.document_id == d.id, File.is_current == True, File.file_ext == "pdf"
        ).all()
        if len(files) != 1:
            raise SystemExit(f"작업2: 문서 {d.id}({d.drawing_no})의 현재 PDF 파일이 1개가 아님({len(files)}개)")
        f = files[0]
        src = Path(STORAGE_ROOT) / f.file_path
        dst = latest_file_path(c.source_path, c.drawing_no, "pdf")
        work2_plans.append({
            "model_doc": d, "base_doc": c, "model_file": f, "src": src, "dst": dst,
        })

    work3_plans = []  # {'model_doc', 'base_doc', 'model_file', 'src', 'dst'}
    for d, c in work3:
        files = session.query(File).filter(
            File.document_id == d.id, File.is_current == True, File.file_ext == "pdf"
        ).all()
        if len(files) != 1:
            raise SystemExit(f"작업3: 문서 {d.id}({d.drawing_no})의 현재 PDF 파일이 1개가 아님({len(files)}개)")
        f = files[0]
        src = Path(STORAGE_ROOT) / f.file_path
        # 이력 폴더로 이동: 되살리기 대비, 최신 폴더에서만 안 보이게
        dst = history_file_path(d.source_path, d.drawing_no, 0, None, f.original_filename)
        work3_plans.append({
            "model_doc": d, "base_doc": c, "model_file": f, "src": src, "dst": dst,
        })

    # 사전 검증
    problems = 0
    for p in work2_plans + work3_plans:
        if not p["src"].exists():
            print(f"⚠ 원본 파일 없음: {p['src']}")
            problems += 1
        if p["dst"].exists():
            print(f"⚠ 대상 파일 이미 존재: {p['dst']}")
            problems += 1
    if problems:
        raise SystemExit(f"검증 실패: {problems}건. 실행 중단.")
    print("파일 이동 사전 검증 OK (충돌 없음, 원본 파일 전부 존재)")

    # ==========================================================
    # 실행
    # ==========================================================
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
    pg_dump("실행전_20260806작업")

    print()
    print("[1/3] 작업 1: OLD 폴더 archive")
    batch1 = ArchiveBatch(
        kind="FOLDER", label="OLD",
        original_path=OLD_FOLDER_PATH, archived_by=system_user.id,
    )
    session.add(batch1)
    session.flush()
    for d in old_docs:
        d.is_archived = True
        d.archive_batch_id = batch1.id
        d.updated_at = now
    session.add(AuditLog(
        user_id=system_user.id, action="ARCHIVE_FOLDER",
        screen="일괄정리 스크립트(2026-08-06)",
        detail={"batch_id": batch1.id, "path": OLD_FOLDER_PATH, "count": len(old_docs),
                "reason": "CM 지시: 5.5 폴더의 OLD 폴더 통째로 정리"},
    ))
    print(f"  → {len(old_docs)}건 archive, batch_id={batch1.id}")

    print()
    print(f"[2/3] 작업 2: -Model 자료 → 원본으로 흡수 ({len(work2_plans)}건)")
    batch2 = ArchiveBatch(
        kind="DOCUMENT", label=f"-Model 접미사 자료 합치기 ({len(work2_plans)}건)",
        original_path=None, archived_by=system_user.id,
    )
    session.add(batch2)
    session.flush()

    moved_files_work2 = []  # 롤백용 (src, dst) 기록
    try:
        for i, p in enumerate(work2_plans):
            d, c, f = p["model_doc"], p["base_doc"], p["model_file"]
            src, dst = p["src"], p["dst"]

            # 파일 이동
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            moved_files_work2.append((src, dst))

            # DB 갱신
            f.document_id = c.id
            f.original_filename = f"{c.drawing_no}.pdf"
            f.file_path = to_relative(dst)
            c.has_pdf = True
            c.updated_at = now
            d.is_archived = True
            d.archive_batch_id = batch2.id
            d.updated_at = now

            if (i + 1) % 100 == 0:
                print(f"  ...{i+1}/{len(work2_plans)}")

        session.add(AuditLog(
            user_id=system_user.id, action="MERGE_MODEL_SUFFIX",
            screen="일괄정리 스크립트(2026-08-06)",
            detail={"batch_id": batch2.id, "count": len(work2_plans),
                    "reason": "CM 지시: 폴더 같고 -Model/원본 짝인 자료 합치기"},
        ))
        print(f"  → {len(work2_plans)}건 처리 완료")
    except Exception as e:
        print(f"  [!] 실행 중 오류 - 파일 이동 되돌리는 중: {e}")
        session.rollback()
        for src, dst in reversed(moved_files_work2):
            try:
                shutil.move(str(dst), str(src))
            except Exception as e2:
                print(f"    되돌리기 실패: {dst} → {src}: {e2}")
        raise

    print()
    print(f"[3/3] 작업 3: 원본 PDF 있는데 중복된 Model 자료 정리 ({len(work3_plans)}건)")
    batch3 = ArchiveBatch(
        kind="DOCUMENT", label=f"중복 -Model 자료 정리 ({len(work3_plans)}건)",
        original_path=None, archived_by=system_user.id,
    )
    session.add(batch3)
    session.flush()

    moved_files_work3 = []
    try:
        for p in work3_plans:
            d, c, f = p["model_doc"], p["base_doc"], p["model_file"]
            src, dst = p["src"], p["dst"]

            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            moved_files_work3.append((src, dst))

            f.file_path = to_relative(dst)
            f.is_current = False  # 최신에서 사라졌으니 현재본 아님
            d.is_archived = True
            d.archive_batch_id = batch3.id
            d.updated_at = now

        session.add(AuditLog(
            user_id=system_user.id, action="ARCHIVE_DUPLICATE_MODEL",
            screen="일괄정리 스크립트(2026-08-06)",
            detail={"batch_id": batch3.id, "count": len(work3_plans),
                    "reason": "CM 지시: 원본에 이미 PDF 있어 중복된 -Model PDF는 정리"},
        ))
        print(f"  → {len(work3_plans)}건 처리 완료")
    except Exception as e:
        print(f"  [!] 실행 중 오류 - 파일 이동 되돌리는 중: {e}")
        session.rollback()
        for src, dst in reversed(moved_files_work3):
            try:
                shutil.move(str(dst), str(src))
            except Exception as e2:
                print(f"    되돌리기 실패: {dst} → {src}: {e2}")
        raise

    # 최종 커밋
    session.commit()
    print()
    print("=" * 70)
    print("[DB 커밋 완료] - 실행 후 백업 뜹니다")
    print("=" * 70)
    pg_dump("원본_20260806")
    print()
    print("모든 작업 완료.")


if __name__ == "__main__":
    main()
