# -*- coding: utf-8 -*-
"""MDB Tag No 앞에 붙은 "TT-" 접두어 제거 1회성 스크립트 (2026-08-29 CM 지시).

CM 요청: "TT-P1104A"처럼 Tag No 앞에 "TT-"가 붙어 있는 것은 그 접두어만 지워서
"P1104A"로 바꿔달라는 것. mdb_file_tags.tag_no 값만 고친다 — 다른 테이블·다른
접두어·다른 컬럼은 이 지시 범위 밖이라 손대지 않는다.

사전 확인 결과: "TT-"로 시작하는 401건 전부 대소문자까지 정확히 "TT-"였고,
접두어를 떼었을 때 같은 mdb_file_id 안에 이미 같은 Tag No가 있는 충돌은 0건이었다.

실행:  python scripts/fix_tagno_tt_prefix_20260829.py --dry-run   (무엇을 바꿀지 보기만)
       python scripts/fix_tagno_tt_prefix_20260829.py             (실제 실행)
"""

import argparse
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")

from app.database import SessionLocal
from app.models import AuditLog, MdbFileTag

PREFIX = "TT-"
SYSTEM_USER_ID = 1  # 일괄등록 계정


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    rows = db.query(MdbFileTag).filter(MdbFileTag.tag_no.like(f"{PREFIX}%")).all()

    print(f"대상 {len(rows)}건")
    changes = []
    for row in rows:
        old = row.tag_no
        new = old[len(PREFIX):]
        changes.append((row.id, old, new))
        print(f"  id={row.id}: {old!r} -> {new!r}")

    if args.dry_run:
        print("dry-run이므로 실제로 바꾸지 않았습니다.")
        return

    for row in rows:
        row.tag_no = row.tag_no[len(PREFIX):]

    db.add(
        AuditLog(
            user_id=SYSTEM_USER_ID,
            action="FIX_TAGNO_TT_PREFIX",
            document_id=None,
            detail={
                "script": "fix_tagno_tt_prefix_20260829.py",
                "count": len(changes),
                "sample": [{"id": i, "old": o, "new": n} for i, o, n in changes[:20]],
            },
            created_at=datetime.now(timezone.utc),
        )
    )
    db.commit()
    print(f"{len(changes)}건 수정 완료.")


if __name__ == "__main__":
    main()
