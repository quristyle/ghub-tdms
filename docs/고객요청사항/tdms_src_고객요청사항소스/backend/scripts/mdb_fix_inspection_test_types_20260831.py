# -*- coding: utf-8 -*-
"""MDB 자료유형 중 IRN·Inspection Report·Test를 Inspection & Test로 정리 (2026-08-31 CM 지시).

CM 지시: "자료유형에 Inspection Report, IRN, Test 중 하나라도 포함되어 있다면 모두
삭제하고, 자료유형은 Inspection & Test 만 선택되도록 수정하라." CM이 자료유형을 지정할 때
IRN·Inspection Report·Test를 개별로 잘못 골라둔 것을 "Inspection & Test" 하나로 바로잡는
데이터 정정이다 — 새 규칙을 만드는 것이 아니다(CM 확인).

무엇을 바꾸는가
  자료유형 문자열(슬래시로 이어붙인 값, app/mdb_types.py)에서 "IRN"·"Inspection Report"·"Test"
  조각만 정확히 골라 지우고, 그 자리에 "Inspection & Test"가 없으면 추가한다. 그 세 조각과
  무관한 다른 유형(Data Sheet·Drawing·Certificate·Procedure 등)은 그대로 둔다.
  이미 "Inspection & Test"만 있거나 그 셋이 전혀 안 섞여 있는 자료는 손대지 않는다.

  예) "IRN/Inspection Report"                              -> "Inspection & Test"
      "Test/Procedure"                                     -> "Procedure/Inspection & Test"
      "IRN/Inspection Report/Certificate"                  -> "Certificate/Inspection & Test"
      "Inspection & Test/Procedure" (Test·IRN·IR 없음)       -> 그대로

손대지 않는 것 (지시 범위 밖)
  · mdb_doc_types 마스터 목록(IRN·Inspection Report·Test 항목 자체)은 그대로 둔다 — CM이 이번
    지시가 "규칙을 만드는 것이 아니라 잘못 고른 데이터만 고치는 것"이라고 확인했다(D-31 예외는
    이 스크립트가 쓸 일이 아님). 목록에서 고를 수 있는 값은 앞으로도 그대로다.
  · equipment_type·Tag No·Note·자료명·경로·파일은 건드리지 않는다.
  · 자료유형이 비어 있거나(None) 저 셋과 무관한 자료는 건드리지 않는다.

실행
  python scripts/mdb_fix_inspection_test_types_20260831.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/mdb_fix_inspection_test_types_20260831.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  python scripts/mdb_restore_types_20260830.py <백업파일> --apply
  (자료유형·설비유형 값 되돌리기는 mdb_restore_types_20260830.py가 이미 하는 일과 같아 그대로 쓴다)
"""

import argparse
import io
import json
import os
import sys
from collections import Counter
from datetime import datetime

# Windows 콘솔 기본 인코딩(cp949)으로는 한글·기호가 깨지거나 오류가 난다.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import mdb_group, mdb_types  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, EquipmentType, MdbDocType, MdbFile  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정

TARGET_TOKENS = {"IRN", "INSPECTION REPORT", "TEST"}
KEEP_TYPE = "Inspection & Test"


def fix_doc_type(value: str | None) -> str | None:
    """대상 조각(IRN·Inspection Report·Test)이 있으면 지우고 Inspection & Test를 넣은 새 값.
    대상 조각이 하나도 없으면 None(안 바꿈)."""
    tokens = mdb_types.split_types(value)
    if not any(t.upper() in TARGET_TOKENS for t in tokens):
        return None
    kept = [t for t in tokens if t.upper() not in TARGET_TOKENS]
    if not any(t.upper() == KEEP_TYPE.upper() for t in kept):
        kept.append(KEEP_TYPE)
    return mdb_types.join_types(kept)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    db = SessionLocal()

    rows = db.query(MdbFile).filter(MdbFile.is_archived.is_(False)).all()
    groups = mdb_group.build_groups(rows, mdb_group.load_tags_map(db, [r.id for r in rows]))

    changes: list[tuple] = []  # (group, old_value, new_value)
    transitions: Counter = Counter()

    for group in groups:
        new_value = fix_doc_type(group.doc_type)
        if new_value is not None and new_value != group.doc_type:
            changes.append((group, group.doc_type, new_value))
            transitions[(group.doc_type, new_value)] += 1

    file_count = sum(len(g.rows) for g, _old, _new in changes)

    print("자료유형에 IRN·Inspection Report·Test가 섞여 있어 바뀌는 자료: %d건 (파일 %d건)"
          % (len(changes), file_count))
    print()
    for (old, new), c in sorted(transitions.items(), key=lambda x: -x[1]):
        print("  %4d건  %-55s -> %s" % (c, old, new))

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        db.rollback()
        db.close()
        return

    # --- 백업 -------------------------------------------------------------
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "mdb_inspection_test_types_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump({
            "mdb_doc_types": [{"id": t.id, "name": t.name} for t in db.query(MdbDocType).all()],
            "equipment_types": [{"id": t.id, "name": t.name} for t in db.query(EquipmentType).all()],
            "mdb_files": [{"id": r.id, "doc_type": r.doc_type, "equipment_type": r.equipment_type}
                          for r in db.query(MdbFile).all()],
        }, handle, ensure_ascii=False, indent=1)
    print("\n백업 저장: %s" % backup_path)
    print("(mdb_restore_types_20260830.py 로 이 백업을 되돌릴 수 있습니다.)")

    # --- 반영 ---------------------------------------------------------------
    # 자료유형은 자료 단위 값이라 자료에 속한 파일(원본+PDF 사본) 전부에 같은 값을 써준다
    # (mdb_editor.update_info와 같은 방식, D-40 ③).
    for group, _old, new_value in changes:
        for row in group.rows:
            row.doc_type = new_value

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID,
        action="MDB_TYPES_FIX_INSPECTION_TEST",
        document_id=None,
        detail={
            "script": "mdb_fix_inspection_test_types_20260831.py",
            "reason": "CM 지시 — IRN/Inspection Report/Test로 잘못 지정된 자료유형을 Inspection & Test로 정정",
            "groups_changed": len(changes),
            "files_changed": file_count,
            "transitions": {f"{old} -> {new}": c for (old, new), c in transitions.items()},
            "backup": os.path.basename(backup_path),
        },
    ))
    db.commit()
    print("반영 완료: 자료 %d건 / 파일 %d건" % (len(changes), file_count))
    db.close()


if __name__ == "__main__":
    main()
