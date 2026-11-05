# -*- coding: utf-8 -*-
"""P&ID Rev0 (2012) 자료명 끝의 리비전 표시 `.r`을 뗀다 — 13건 (2026-08-30 CM 확정).

배경 — Rev0 (2012)를 등록할 때 "PDF 파일명을 기준으로 원본(DWG) 파일명을 맞춘다"는 규칙을
따랐는데, 업체가 준 파일명 자체에 리비전 표시가 섞여 있는 것들이 있었다.

    8.TT01-UCO-04-103.r.dwg / 8.TT01-UCO-04-103.r.pdf   ← 원본·사본 양쪽에 `.r`

`.r`은 도면번호가 아니라 리비전 표시이므로 CM이 "r 다 빼라"고 확정했다.
앞서 사본에만 `r`이 붙어 있던 `49.TT01-HBO-04-509r` 1건은 이미 고쳤고
(`pid_rev0_fix_509r_20260830.py`), 이 스크립트는 양쪽에 `.r`이 붙은 나머지 13건을 고친다.

**실제 파일 이름까지 바꾼다** — 화면에서만 지워 보이게 하는 것이 아니라, 저장폴더의
`최신\\...\\Rev0 (2012)\\DWG\\8.TT01-UCO-04-103.r.dwg` 파일 자체가
`8.TT01-UCO-04-103.dwg`로 바뀐다(원본·사본 둘 다). 파일 내용은 손대지 않는다.
화면에 보이는 자료명(`drawing_no`·`title`)과 시스템이 기억하는 파일명(`original_filename`)도
같이 맞춘다 — Rev0 (2012)의 다른 자료도 전부 "자료명 + 확장자"라서 이 13건만 어긋나면 안 된다.

대상은 아래 목록에 적힌 13건뿐이다(찾아낸 결과를 그대로 적어둔 것). 목록에 없는 자료는
건드리지 않고, 실행할 때 목록과 실제 자료가 어긋나면 그 건을 건너뛰고 알려준다.

실행:  python scripts/pid_rev0_strip_r_suffix_20260830.py --dry-run   (무엇을 할지 보기만)
       python scripts/pid_rev0_strip_r_suffix_20260830.py             (실제 실행)
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

# 끝의 ".r"을 뗄 자료 13건 (2026-08-30 전수 조사 결과)
NAMES = [
    "8.TT01-UCO-04-103.r",
    "12.TT01-UCO-04-107.r",
    "13.TT01-UCO-04-108.r",
    "14.TT01-UCO-04-109.r",
    "15.TT01-LBO-04-200.r",
    "16.TT01-LBO-04-201.r",
    "17.TT01-LBO-04-202.r",
    "18.TT01-LBO-04-203.r",
    "19.TT01-LBO-04-204.r",
    "20.TT01-LBO-04-205.r",
    "21.TT01-LBO-04-206.r",
    "22.TT01-LBO-04-207.r",
    "23.TT01-LBO-04-208.r",
]

SUFFIX = ".r"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="실제로 바꾸지 않고 무엇을 할지만 보여준다")
    args = ap.parse_args()

    db = SessionLocal()
    renamed, skipped = [], []
    try:
        print("=" * 78)
        print(f"자료명 끝 '{SUFFIX}' 떼기 — {TARGET_PATH}")
        print("=" * 78)

        for old_name in NAMES:
            if not old_name.endswith(SUFFIX):
                skipped.append(f"{old_name}: 끝이 '{SUFFIX}'가 아님")
                continue
            new_name = old_name[: -len(SUFFIX)]

            doc = (
                db.query(Document)
                .filter(Document.source_path == TARGET_PATH,
                        Document.drawing_no == old_name,
                        Document.is_archived.is_(False))
                .one_or_none()
            )
            if doc is None:
                skipped.append(f"{old_name}: 자료를 못 찾음(이미 고쳤을 수 있음)")
                continue

            clash = (
                db.query(Document)
                .filter(Document.source_path == TARGET_PATH,
                        Document.drawing_no == new_name,
                        Document.is_archived.is_(False))
                .first()
            )
            if clash is not None:
                skipped.append(f"{old_name}: 같은 폴더에 '{new_name}'가 이미 있어 건너뜀")
                continue

            files = db.query(File).filter(File.document_id == doc.id).order_by(File.id).all()
            parts = []
            for f in files:
                exists = (Path(STORAGE_ROOT) / f.file_path).is_file()
                parts.append(f"{f.file_ext}{'' if exists else '(파일없음)'}")
                if args.dry_run:
                    continue
                rename_current_file(doc.source_path, old_name, new_name, f)
                f.original_filename = f"{new_name}.{f.file_ext}"

            print(f"   {old_name:26} → {new_name:24}  [{', '.join(parts)}]")

            if not args.dry_run:
                doc.drawing_no = new_name
                doc.title = new_name
                doc.updated_at = datetime.now(timezone.utc)
                db.add(AuditLog(
                    user_id=SYSTEM_USER_ID, action="RENAME_DOCUMENT",
                    screen="폴더·자료 편집(스크립트)", document_id=doc.id,
                    detail={"old_title": old_name, "new_title": new_name,
                            "note": "Rev0 (2012) 자료명 끝의 리비전 표시 .r 제거 "
                                    "(2026-08-30 CM 확정) — 실제 파일 이름까지 변경"},
                ))
            renamed.append(f"{old_name} → {new_name}")

        print()
        print(f"   이름 바꾼 자료 : {len(renamed)}건")
        if skipped:
            print(f"   건너뛴 자료    : {len(skipped)}건")
            for s in skipped:
                print(f"      - {s}")

        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return

        db.commit()
        print("\n완료 — 시스템 로그에 RENAME_DOCUMENT로 자료마다 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
