# -*- coding: utf-8 -*-
"""P&ID Rev0 (2012)의 `49.TT01-HBO-04-509r` 자료명에서 끝의 `r`을 뺀다 (2026-08-30 CM 확정).

배경 — Rev0 (2012)를 등록할 때 "PDF 파일명을 기준으로 원본(DWG) 파일명을 맞춘다"는 규칙을
그대로 따랐는데, 이 자료만 PDF 파일명 자체에 리비전 표시 `r`이 붙어 있었다.

    PDF : 49.TT01-HBO-04-509r.pdf          ← 끝에 r
    DWG : 49.TT01-HBO-04-509.r.3(120425).dwg   ← .r.3 이 리비전 표시

그래서 규칙대로 맞추니 자료명이 `49.TT01-HBO-04-509r`이 됐다. CM이 "r을 빼는 게 맞다"고
확정해 `49.TT01-HBO-04-509`로 고친다(도면번호에 리비전 표시가 섞이면 안 되므로).

바꾸는 것은 자료명·제목과 저장된 파일 이름 두 개(원본·사본)뿐이다. 파일 내용은 손대지 않는다.
등록할 때 파일명을 이미 자료명에 맞춰 저장했으므로 `original_filename`도 함께 맞춘다 —
Rev0 (2012)의 다른 자료 63건도 전부 "자료명 + 확장자"로 되어 있어 이 자료만 어긋나면 안 된다.

손대지 않는 것 — 자료명이 `.r`로 끝나는 다른 13건(`8.TT01-UCO-04-103.r` 등)은 업체가 준
원본과 사본 **양쪽 파일명에 모두** `.r`이 있어 이 건과 사정이 다르다. CM 지시 범위 밖이라
그대로 뒀다(지시에 없는 대상까지 처리하지 않는다).

실행:  python scripts/pid_rev0_fix_509r_20260830.py --dry-run   (무엇을 할지 보기만)
       python scripts/pid_rev0_fix_509r_20260830.py             (실제 실행)
"""

import argparse
import io
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")

from app import storage
from app.config import STORAGE_ROOT
from app.database import SessionLocal
from app.models import AuditLog, Document, File
from app.routers.editor import rename_current_file

SYSTEM_USER_ID = 1  # 일괄등록 계정

TARGET_PATH = "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)\\Rev0 (2012)"
OLD_NAME = "49.TT01-HBO-04-509r"
NEW_NAME = "49.TT01-HBO-04-509"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="실제로 바꾸지 않고 무엇을 할지만 보여준다")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        doc = (
            db.query(Document)
            .filter(Document.source_path == TARGET_PATH,
                    Document.drawing_no == OLD_NAME,
                    Document.is_archived.is_(False))
            .one_or_none()
        )
        if doc is None:
            print(f"[건너뜀] '{OLD_NAME}' 자료를 찾을 수 없습니다 (이미 고쳤을 수 있음).")
            return

        clash = (
            db.query(Document)
            .filter(Document.source_path == TARGET_PATH,
                    Document.drawing_no == NEW_NAME,
                    Document.is_archived.is_(False))
            .first()
        )
        if clash is not None:
            print(f"[중단] 같은 폴더에 '{NEW_NAME}' 자료가 이미 있습니다 (id={clash.id}).")
            return

        print("=" * 74)
        print(f"자료명 변경   {OLD_NAME}")
        print(f"          →   {NEW_NAME}")
        print(f"폴더          {TARGET_PATH}")
        print("=" * 74)

        files = db.query(File).filter(File.document_id == doc.id).order_by(File.id).all()
        for f in files:
            old_rel = f.file_path
            new_dest = storage.latest_file_path(doc.source_path, NEW_NAME, f.file_ext, f.pairing_folder)
            print(f"   {f.file_ext.upper():4} {Path(old_rel).name}")
            print(f"        → {new_dest.name}   (실제파일 "
                  f"{'있음' if (Path(STORAGE_ROOT) / old_rel).is_file() else '없음'})")
            if args.dry_run:
                continue
            rename_current_file(doc.source_path, OLD_NAME, NEW_NAME, f)
            f.original_filename = f"{NEW_NAME}.{f.file_ext}"

        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return

        doc.drawing_no = NEW_NAME
        doc.title = NEW_NAME
        doc.updated_at = datetime.now(timezone.utc)
        db.add(AuditLog(
            user_id=SYSTEM_USER_ID, action="RENAME_DOCUMENT",
            screen="폴더·자료 편집(스크립트)", document_id=doc.id,
            detail={"old_title": OLD_NAME, "new_title": NEW_NAME,
                    "note": "Rev0 (2012) 등록 시 PDF 파일명에 섞여 있던 리비전 표시 r 제거 "
                            "(2026-08-30 CM 확정)"},
        ))
        db.commit()
        print("\n완료 — 시스템 로그에 RENAME_DOCUMENT로 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
