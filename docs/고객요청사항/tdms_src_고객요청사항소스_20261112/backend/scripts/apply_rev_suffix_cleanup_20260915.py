# -*- coding: utf-8 -*-
"""TDB 자료명에 박힌 리비전·날짜 표기(_R0, Rev.0, (r.2)_251208 등)를 떼어내는 1회성 스크립트
(2026-09-15 CM 지시).

배경: find_rev_suffix_20260915.py로 찾은 409건을 CM이 검토했고("자료명(변경계획)" 열대로
수정하라"), 원본·사본(DWG·PDF) 둘 다 있으면 둘 다 파일명을 바꾸라고 확정했다.

무엇을 바꾸나
  - documents.drawing_no, documents.title (시스템의 "자료명 변경" 기능과 동일하게 둘 다
    새 이름으로 맞춘다 — TDB 관리 [자료명 변경]이 하는 일과 같다, editor.rename_document 참고)
  - files.is_current=true 인 파일들의 실제 저장 파일 이름(storage.move_stored_file로 물리
    파일까지 이름을 바꿈). 원본·PDF 등 그 자료의 현재본 파일 전부에 적용된다.
  - files.original_filename(업체가 보낸 원래 파일명)은 절대 손대지 않는다(모델 주석: "절대
    안 바뀜") — TDB 관리 이름변경 기능도 이 값은 안 건드린다.
  - 이력(구본) 파일은 옛 이름 그대로 둔다(그 시점의 진짜 이름이라 자연스럽다 — 기존
    rename_current_file 규칙 그대로).

무엇을 안 바꾸나
  - is_archived=true(삭제/폐기 보관함) 자료는 건드리지 않는다.
  - "새 이름"이 옛 이름과 같으면(=제거할 표기가 없으면) 건드리지 않는다.
  - 같은 폴더(source_path)에 새 이름과 똑같은 자료가 이미 있으면 충돌이라 건드리지 않고
    목록에 남긴다(CM이 수동으로 판단).

실행
  venv\\Scripts\\python.exe scripts\\apply_rev_suffix_cleanup_20260915.py --dry-run   (기본값, 미리보기만)
  venv\\Scripts\\python.exe scripts\\apply_rev_suffix_cleanup_20260915.py --apply     (실제 반영, 먼저 백업 저장)

되돌리기
  venv\\Scripts\\python.exe scripts\\restore_rev_suffix_cleanup_20260915.py <백업파일>
"""

import argparse
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent
sys.path.insert(0, str(BACKEND_ROOT))
sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

from app import storage  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, Document, File  # noqa: E402
from app.routers.editor import rename_current_file  # noqa: E402

from find_rev_suffix_20260915 import PATTERN_SQL, plan_removal  # noqa: E402

BACKUP_DIR = PROJECT_ROOT / "backup"
SYSTEM_USERNAME = "batch_system"


def get_system_user_id(db) -> int:
    from app.models import User

    user = db.query(User).filter(User.username == SYSTEM_USERNAME).one_or_none()
    if user is not None:
        return user.id
    # bulk_import.py가 만들어 둔 "일괄등록" 계정이 있으면 그걸 쓴다
    user = db.query(User).filter(User.role == "INTERNAL").first()
    if user is not None:
        return user.id
    # 최후 수단: ADMIN 아무나
    user = db.query(User).filter(User.role == "ADMIN").first()
    return user.id if user else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(기본은 미리보기만)")
    args = parser.parse_args()
    apply_mode = args.apply

    db = SessionLocal()
    try:
        docs = (
            db.query(Document)
            .filter(Document.is_archived == False)  # noqa: E712
            .filter(Document.drawing_no.op("~*")(PATTERN_SQL))
            .order_by(Document.id)
            .all()
        )
        print(f"대상 후보: {len(docs)}건")

        plans = []  # (doc, old_name, new_name)
        skipped_unchanged = []
        for doc in docs:
            old_name = doc.drawing_no or ""
            new_name, _ranges = plan_removal(old_name)
            if not new_name or new_name == old_name:
                skipped_unchanged.append((doc.id, old_name))
                continue
            plans.append((doc, old_name, new_name))

        # 같은 폴더에 새 이름이 이미 있는지(자기 자신 제외) 충돌 검사.
        # - 이번 계획 안에서 두 자료가 같은 (폴더, 새이름)으로 겹치는 경우
        # - DB에 이미 그 (폴더, 새이름)의 다른 살아있는 자료가 있는 경우
        conflicts = []
        applied_plans = []
        planned_targets = {}
        for doc, old_name, new_name in plans:
            key = (doc.source_path, new_name)
            if key in planned_targets:
                conflicts.append((doc.id, old_name, new_name, "이번 계획 안에서 같은 폴더·같은 새이름 중복"))
                continue
            existing = (
                db.query(Document)
                .filter(
                    Document.is_archived == False,  # noqa: E712
                    Document.id != doc.id,
                    Document.source_path == doc.source_path,
                    Document.drawing_no == new_name,
                )
                .first()
            )
            if existing is not None:
                conflicts.append((doc.id, old_name, new_name, f"같은 폴더에 자료 {existing.id}가 이미 같은 이름"))
                continue
            planned_targets[key] = doc.id
            applied_plans.append((doc, old_name, new_name))

        print(f"제거할 표기 없어 건너뜀: {len(skipped_unchanged)}건")
        print(f"충돌로 건너뜀: {len(conflicts)}건")
        for doc_id, old_name, new_name, reason in conflicts:
            print(f"  [충돌] id={doc_id} '{old_name}' -> '{new_name}' ({reason})")
        print(f"실제로 이름을 바꿀 자료: {len(applied_plans)}건")

        if not apply_mode:
            print("\n(미리보기 모드입니다. 실제로 반영하려면 --apply 를 붙여 다시 실행하세요.)")
            for doc, old_name, new_name in applied_plans[:20]:
                print(f"  id={doc.id} '{old_name}' -> '{new_name}'")
            if len(applied_plans) > 20:
                print(f"  ... 외 {len(applied_plans) - 20}건")
            return

        # --- 여기부터 실제 반영 ---
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = BACKUP_DIR / f"rev_suffix_cleanup_백업_{stamp}.json"

        system_user_id = get_system_user_id(db)
        now = datetime.now(timezone.utc)

        backup_entries = []
        changed = 0
        for doc, old_name, new_name in applied_plans:
            current_files = (
                db.query(File)
                .filter(File.document_id == doc.id, File.is_current.is_(True))
                .all()
            )
            file_backup = [
                {"file_id": f.id, "old_file_path": f.file_path, "file_ext": f.file_ext}
                for f in current_files
            ]
            backup_entries.append(
                {
                    "document_id": doc.id,
                    "old_drawing_no": old_name,
                    "old_title": doc.title,
                    "new_drawing_no": new_name,
                    "source_path": doc.source_path,
                    "files": file_backup,
                }
            )

            for f in current_files:
                rename_current_file(doc.source_path, old_name, new_name, f)

            doc.drawing_no = new_name
            doc.title = new_name
            doc.updated_at = now

            db.add(
                AuditLog(
                    user_id=system_user_id,
                    action="RENAME_DOCUMENT",
                    screen="폴더·자료 편집",
                    document_id=doc.id,
                    detail={
                        "old_title": old_name,
                        "new_title": new_name,
                        "batch": "rev_suffix_cleanup_20260915",
                    },
                )
            )
            changed += 1

        with open(backup_path, "w", encoding="utf-8") as fh:
            json.dump(backup_entries, fh, ensure_ascii=False, indent=2)

        db.commit()
        print(f"\n백업 저장: {backup_path} ({len(backup_entries)}건)")
        print(f"반영 완료: {changed}건")
    finally:
        db.close()


if __name__ == "__main__":
    main()
