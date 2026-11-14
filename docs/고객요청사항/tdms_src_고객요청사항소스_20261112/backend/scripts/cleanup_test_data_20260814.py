"""1회성 스크립트: 2026-08-10~08-14 시스템 테스트 중 생긴 TDB/MDB "자료" 테스트 흔적만 정리한다.

CM 확정(2026-08-14): 계정/권한/그룹/화면기능 변경은 그대로 두고, TDB/MDB 자료(반출/반입/
리비전/보관함테스트/공사)만 테스트 이전 상태로 되돌린다.

실행 전 반드시 `python scripts/cleanup_test_data_20260814.py --dry-run`으로 먼저 확인할 것.
실제 반영은 `python scripts/cleanup_test_data_20260814.py --execute`.
"""

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import (
    ArchiveBatch,
    AuditLog,
    Distribution,
    Document,
    File,
    ImportIssue,
    MdbFile,
    Project,
)

STORAGE = Path(STORAGE_ROOT)

# 테스트로 rev>0 파일이 생겨 상태가 어긋난 문서 (rev0/ACTIVE로 되돌림)
REVERT_DOC_IDS = [11599, 11403, 11404]

# 테스트(폴더명 변경 테스트, 반출 테스트) 중 부산물로 생긴 공사
DELETE_PROJECT_IDS = [73, 74, 75, 76]

# 보관함(archive) 기능 테스트 흔적 - 파일은 이미 복원되어 있고 이력만 남음
DELETE_ARCHIVE_BATCH_IDS = [13, 14]
CLEAR_ARCHIVE_BATCH_MDB_FILE_IDS = [5034, 5932, 5933, 5934, 5935, 5936, 5937, 5938, 5939]

# 위 테스트 행위와 직접 연결된 감사로그만 삭제 (계정/그룹/권한/폴더명 이력은 보존)
DELETE_AUDIT_LOG_IDS = [
    # DISTRIBUTE (18건, distributions 전체와 1:1)
    1514, 1611, 1612, 1615, 1616, 1620, 1621, 1628, 1629,
    1651, 1652, 1655, 1708, 1710, 1713, 1715, 1716, 1717,
    # UPLOAD (테스트 문서 리비전 업로드)
    1653, 1654, 1709, 1711, 1720,
    # MERGE_REQUIRED
    1712, 1721,
    # IMPORT_ISSUE_RECHECK / DISCARD
    1669, 1670, 1718, 1786,
    # 보관함 테스트 (ARCHIVE_DOCUMENT / RESTORE_FROM_TRASH)
    1527, 1528, 1530,
    # MDB 폴더명 변경 왕복 테스트 (최종적으로 원래 이름으로 복귀됨)
    1531, 1532, 1533, 1534, 1535, 1536, 1537, 1538,
]


def log(dry_run, msg):
    print(("[dry-run] " if dry_run else "[실행] ") + msg)


def revert_document(db, doc_id, dry_run):
    doc = db.query(Document).filter(Document.id == doc_id).one()
    files = db.query(File).filter(File.document_id == doc_id).all()
    rev0 = [f for f in files if f.rev == 0]
    others = [f for f in files if f.rev != 0]
    if not rev0:
        raise RuntimeError(f"문서 {doc_id}에 rev0 파일이 없습니다 - 중단")

    log(dry_run, f"문서 {doc_id}({doc.drawing_no}): rev0 유지 {len(rev0)}건, 테스트 리비전 파일 {len(others)}건 삭제, status {doc.status} -> ACTIVE")

    for f in others:
        p = STORAGE / f.file_path
        log(dry_run, f"  - 검수대기 테스트 파일 삭제: {p}")
        if not dry_run and p.exists():
            p.unlink()

    if not dry_run:
        for f in others:
            db.delete(f)
        doc.status = "ACTIVE"
        doc.current_rev = 0


def run(dry_run):
    db = SessionLocal()
    try:
        print("=" * 60)
        print("1) 반출 기록 전체 삭제 + storage/반출 폴더 비우기")
        dist_count = db.query(Distribution).count()
        log(dry_run, f"  - distributions {dist_count}건 삭제")
        if not dry_run:
            db.query(Distribution).delete()
            db.flush()
        dist_dir = STORAGE / "반출"
        if dist_dir.exists():
            for child in dist_dir.iterdir():
                log(dry_run, f"  - 폴더 삭제: {child}")
                if not dry_run:
                    shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()

        print("=" * 60)
        print("2) 반입확인필요 전체 삭제 + storage/검수대기_확인필요 폴더 비우기")
        issue_count = db.query(ImportIssue).count()
        log(dry_run, f"  - import_issues {issue_count}건 삭제")
        if not dry_run:
            db.query(ImportIssue).delete()
            db.flush()
        issue_dir = STORAGE / "검수대기_확인필요"
        if issue_dir.exists():
            for child in issue_dir.iterdir():
                log(dry_run, f"  - 파일 삭제: {child}")
                if not dry_run:
                    shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()

        print("=" * 60)
        print("3) 테스트 문서 3건 rev0/ACTIVE로 복구")
        for doc_id in REVERT_DOC_IDS:
            revert_document(db, doc_id, dry_run)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("4) 테스트 중 생긴 공사(project) 삭제")
        for pid in DELETE_PROJECT_IDS:
            p = db.query(Project).filter(Project.id == pid).one_or_none()
            if p:
                log(dry_run, f"  - project {pid}({p.name}) 삭제")
                if not dry_run:
                    db.delete(p)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("5) 보관함 기능 테스트 흔적 정리 (archive_batches 13/14)")
        for mfid in CLEAR_ARCHIVE_BATCH_MDB_FILE_IDS:
            mf = db.query(MdbFile).filter(MdbFile.id == mfid).one_or_none()
            if mf and mf.archive_batch_id in DELETE_ARCHIVE_BATCH_IDS:
                log(dry_run, f"  - mdb_file {mfid} archive_batch_id 참조 제거")
                if not dry_run:
                    mf.archive_batch_id = None
        if not dry_run:
            db.flush()
        for bid in DELETE_ARCHIVE_BATCH_IDS:
            ab = db.query(ArchiveBatch).filter(ArchiveBatch.id == bid).one_or_none()
            if ab:
                log(dry_run, f"  - archive_batch {bid}({ab.label}) 삭제")
                if not dry_run:
                    db.delete(ab)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("6) 관련 감사로그 삭제")
        log(dry_run, f"  - audit_log {len(DELETE_AUDIT_LOG_IDS)}건 삭제")
        if not dry_run:
            db.query(AuditLog).filter(AuditLog.id.in_(DELETE_AUDIT_LOG_IDS)).delete(synchronize_session=False)
            db.flush()

        print("=" * 60)
        print("7) 남은 검수대기 빈 폴더 정리")
        pending_dir = STORAGE / "검수대기"
        if pending_dir.exists():
            for dirpath in sorted(pending_dir.rglob("*"), key=lambda p: len(p.parts), reverse=True):
                if dirpath.is_dir() and not any(dirpath.iterdir()):
                    log(dry_run, f"  - 빈 폴더 정리: {dirpath}")
                    if not dry_run:
                        dirpath.rmdir()

        if dry_run:
            db.rollback()
            print("=" * 60)
            print("[dry-run] 미리보기만 실행함. 실제 반영 없음.")
        else:
            db.commit()
            print("=" * 60)
            print("[실행] 커밋 완료.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    run(dry_run=not args.execute)
