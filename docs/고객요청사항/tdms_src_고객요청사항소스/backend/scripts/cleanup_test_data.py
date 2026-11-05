"""1회성 스크립트: 테스트 흔적을 지우고 TDB를 '최초 적재(rev 0)' 상태로 되돌린다.

CM 확정(2026-08-06): 지금까지의 반출/반입/리비전/사용자 테스트는 전부 테스트였고
정상적으로 등록·수정한 자료는 하나도 없음. 최초 대량 적재(rev=0, 11,618건)만 진짜 원본.

실행 전 반드시 `python scripts/cleanup_test_data.py --dry-run`으로 먼저 확인할 것.
실제 반영은 `python scripts/cleanup_test_data.py --execute`.
"""

import argparse
import hashlib
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
    FolderPlaceholder,
    HiddenVendor,
    ImportIssue,
    Project,
    User,
)
from app.storage import latest_file_path, to_relative

STORAGE = Path(STORAGE_ROOT)

# 문서 1은 이미 수동으로 rev0 복원 완료(2026-08-06, 원인불명 파일소실 사고 후 CM 백업에서 복구).
# 원본 그대로 두되 테스트로 rev가 올라갔던 나머지 문서 (rev0로 되돌림)
REVERT_DOC_IDS = [8582, 10833, 10834]
# 최초 적재에 없던, 순전히 테스트로 새로 만든 문서 (통째로 삭제)
DELETE_DOC_IDS = [11631, 11632, 11633]
DELETE_PROJECT_IDS = [3, 4, 71, 72]
DELETE_USER_IDS = [3, 4, 5, 6]  # test1, hong123, qatest1, _qa_test


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def log(dry_run, msg):
    print(("[dry-run] " if dry_run else "[실행] ") + msg)


def revert_document(db, doc_id, dry_run):
    doc = db.query(Document).filter(Document.id == doc_id).one()
    files = db.query(File).filter(File.document_id == doc_id).all()
    rev0 = [f for f in files if f.rev == 0]
    others = [f for f in files if f.rev != 0]
    if not rev0:
        raise RuntimeError(f"문서 {doc_id}에 rev0 파일이 없습니다 - 중단")

    log(dry_run, f"문서 {doc_id}({doc.drawing_no}): rev0 파일 {len(rev0)}건 유지, 테스트 파일 {len(others)}건 삭제")

    # 안전 순서: 값진 rev0 원본을 먼저 최신 위치로 안전하게 옮기고(해시 검증까지),
    # 그 다음에야 테스트 파일을 지운다. (사고 재발 방지 - 8/6 원인불명 파일소실 이후)
    # 주의: 테스트 파일(others)이 "최신" 자리(현재본)에 있던 경우 rev0 목적지와 경로가
    # 같아진다 - rev0 이동 때 이미 그 자리를 덮어썼으므로, others 삭제 때 같은 경로를
    # 다시 지우면 방금 복원한 rev0 파일이 사라진다(8/6 실제로 발생한 버그). 그래서 rev0
    # 목적지 경로 집합을 먼저 구해서 others 삭제 시 겹치는 경로는 건너뛴다.
    rev0_dest_paths = {
        latest_file_path(doc.source_path, doc.drawing_no, f.file_ext).resolve() for f in rev0
    }
    for f in rev0:
        src = STORAGE / f.file_path
        if not dry_run and not src.exists():
            raise RuntimeError(f"중단: rev0 원본이 디스크에 없습니다 - {src}")
        dst = latest_file_path(doc.source_path, doc.drawing_no, f.file_ext)
        if src.resolve() == dst.resolve():
            log(dry_run, f"  - rev0 파일 이미 최신 위치: {dst}")
        else:
            log(dry_run, f"  - rev0 파일 복원: {src} -> {dst}")
            if not dry_run:
                src_hash = sha256_of(src)
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists():
                    dst.unlink()
                shutil.copy2(str(src), str(dst))
                if not dst.exists() or sha256_of(dst) != src_hash:
                    raise RuntimeError(f"중단: 복사 후 검증 실패 - {dst}")
                src.unlink()
                f.file_path = to_relative(dst)
        if not dry_run:
            f.is_current = True

    for f in others:
        p = STORAGE / f.file_path
        if p.resolve() in rev0_dest_paths:
            log(dry_run, f"  - 건너뜀(rev0 목적지와 경로 동일, 이미 rev0로 덮어씀): {p}")
            continue
        log(dry_run, f"  - 삭제할 테스트 파일: {p}")
        if not dry_run and p.exists():
            p.unlink()

    if not dry_run:
        for f in others:
            db.delete(f)
        doc.current_rev = 0
        doc.status = "ACTIVE"
        doc.has_dwg = any(f.file_ext == "dwg" for f in rev0)
        doc.has_pdf = any(f.file_ext == "pdf" for f in rev0)


def delete_document(db, doc_id, dry_run):
    doc = db.query(Document).filter(Document.id == doc_id).one()
    files = db.query(File).filter(File.document_id == doc_id).all()
    log(dry_run, f"문서 {doc_id}({doc.drawing_no}) 통째로 삭제 - 파일 {len(files)}건 포함")
    if not dry_run:
        for f in files:
            db.delete(f)
        db.delete(doc)


def rmtree_contents(path: Path, dry_run):
    if not path.exists():
        return
    for child in path.iterdir():
        log(dry_run, f"  - 폴더 삭제: {child}")
        if not dry_run:
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink()


def prune_empty_dirs(root: Path, dry_run):
    if not root.exists():
        return
    for dirpath in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if dirpath.is_dir() and not any(dirpath.iterdir()):
            log(dry_run, f"  - 빈 폴더 정리: {dirpath}")
            if not dry_run:
                dirpath.rmdir()


def preflight_check(db):
    """실행 전 rev0 원본(잃으면 안 되는 것)이 실제로 디스크에 있는지 확인.
    테스트 파일(others, DELETE_DOC_IDS)은 이미 없어도 상관없으므로(어차피 지울 것) 검사 안 함."""
    problems = []
    for doc_id in REVERT_DOC_IDS:
        files = db.query(File).filter(File.document_id == doc_id, File.rev == 0).all()
        for f in files:
            p = STORAGE / f.file_path
            if not p.exists():
                problems.append(f"문서 {doc_id} rev0 원본 파일 {f.id}({f.file_path}) 없음")
    if problems:
        raise RuntimeError("사전 점검 실패, 중단:\n" + "\n".join(problems))
    print("사전 점검 통과: rev0 원본 파일 전부 디스크에 존재함")


def run(dry_run):
    db = SessionLocal()
    try:
        if not dry_run:
            preflight_check(db)
        # 순서 중요: distributions.returned_file_id가 테스트 파일(rev>0)을 참조하는 행이
        # 실제로 존재해서(예: id 988/985/986), 파일을 먼저 지우면 FK 위반이 난다.
        # 그래서 반출/반입확인필요/감사로그부터 전부 지운 다음에 파일·문서를 건드린다.
        print("=" * 60)
        print("1) 반출 기록 전체 삭제 + storage/반출 폴더 비우기")
        dist_count = db.query(Distribution).count()
        log(dry_run, f"  - distributions {dist_count}건 삭제")
        if not dry_run:
            db.query(Distribution).delete()
            db.flush()
        rmtree_contents(STORAGE / "반출", dry_run)

        print("=" * 60)
        print("2) 반입 확인필요 전체 삭제 + storage/검수대기_확인필요 폴더 비우기")
        issue_count = db.query(ImportIssue).count()
        log(dry_run, f"  - import_issues {issue_count}건 삭제")
        if not dry_run:
            db.query(ImportIssue).delete()
            db.flush()
        rmtree_contents(STORAGE / "검수대기_확인필요", dry_run)

        print("=" * 60)
        print("3) 감사로그 전체 삭제")
        audit_count = db.query(AuditLog).count()
        log(dry_run, f"  - audit_log {audit_count}건 삭제")
        if not dry_run:
            db.query(AuditLog).delete()
            db.flush()

        print("=" * 60)
        print("4) 문서 rev0 복원")
        for doc_id in REVERT_DOC_IDS:
            revert_document(db, doc_id, dry_run)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("5) 테스트 전용 문서 삭제")
        for doc_id in DELETE_DOC_IDS:
            delete_document(db, doc_id, dry_run)
        log(dry_run, f"폴더 삭제: {STORAGE / '이력' / '3-1. 테스트'}")
        log(dry_run, f"폴더 삭제: {STORAGE / '최신' / '3-1. 테스트'}")
        if not dry_run:
            db.flush()  # documents 삭제를 먼저 반영해야 archive_batches를 지울 수 있음
            shutil.rmtree(STORAGE / "이력" / "3-1. 테스트", ignore_errors=True)
            shutil.rmtree(STORAGE / "최신" / "3-1. 테스트", ignore_errors=True)

        print("=" * 60)
        print("6) 남아있는 CHECKED_OUT/기타 상태 문서 전부 ACTIVE로 되돌림")
        stuck = db.query(Document).filter(Document.status != "ACTIVE").all()
        for d in stuck:
            log(dry_run, f"  - 문서 {d.id}({d.drawing_no}) status {d.status} -> ACTIVE")
            if not dry_run:
                d.status = "ACTIVE"
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("7) 테스트 공사(project) 삭제")
        for pid in DELETE_PROJECT_IDS:
            p = db.query(Project).filter(Project.id == pid).one_or_none()
            if p:
                log(dry_run, f"  - project {pid}({p.name}) 삭제")
                if not dry_run:
                    db.delete(p)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("8) hidden_vendors 전체 삭제 (테스트 벤더 숨김 + 실수로 숨겨진 '사내(자체 통합)' 복구)")
        hv_count = db.query(HiddenVendor).count()
        log(dry_run, f"  - hidden_vendors {hv_count}건 삭제")
        if not dry_run:
            db.query(HiddenVendor).delete()
            db.flush()

        print("=" * 60)
        print("9) 테스트 계정 삭제")
        for uid in DELETE_USER_IDS:
            u = db.query(User).filter(User.id == uid).one_or_none()
            if u:
                log(dry_run, f"  - user {uid}({u.username}/{u.name}) 삭제")
                if not dry_run:
                    db.delete(u)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("10) archive_batches / folder_placeholders 테스트 잔재 삭제")
        for bid in (5, 6):
            ab = db.query(ArchiveBatch).filter(ArchiveBatch.id == bid).one_or_none()
            if ab:
                log(dry_run, f"  - archive_batch {bid}({ab.label}) 삭제")
                if not dry_run:
                    db.delete(ab)
        fp = db.query(FolderPlaceholder).filter(FolderPlaceholder.path == "3-1. 테스트").one_or_none()
        if fp:
            log(dry_run, f"  - folder_placeholder({fp.path}) 삭제")
            if not dry_run:
                db.delete(fp)
        if not dry_run:
            db.flush()

        print("=" * 60)
        print("11) storage/검수대기 폴더 비우기 + storage/이력 빈 폴더 정리")
        rmtree_contents(STORAGE / "검수대기", dry_run)
        prune_empty_dirs(STORAGE / "이력", dry_run)

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
