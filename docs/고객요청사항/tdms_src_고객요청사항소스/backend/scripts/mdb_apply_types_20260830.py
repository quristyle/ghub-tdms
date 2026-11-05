# -*- coding: utf-8 -*-
"""MDB 자료유형·설비유형 채우기 1회성 스크립트 (2026-08-30 CM 지시).

CM 지시 내용
  ① 자료유형 목록은 검토안 엑셀 "1.자료유형 후보안" 그대로 만든다 ("없다. 일단 해보고 나중에 바꾸자").
  ② 자료유형은 자료 이름을 "&"로 쪼개 조각마다 붙이고, 여러 개면 슬래시로 이어 저장한다
     (예: "IRN & Inspection Report" -> "IRN/Inspection Report"). app/mdb_types.py 규칙 그대로.
  ③ 이름에 단서가 없어 모르는 것은 **비워둔다**.
  ④ 설비유형은 지금 비어 있는 자료만 채우고, 경로에 설비 이름이 뚜렷할 때만 넣는다.

손대지 않는 것 (지시 범위 밖)
  · 이미 자료유형·설비유형이 들어 있는 자료는 그대로 둔다 — CM이 손으로 넣은 값을 덮지 않는다.
  · Tag No·Note·자료명·경로·파일은 건드리지 않는다.
  · 기존 목록의 다른 값(ETC, Index & Schedule)은 지우지 않는다(D-6).

실행
  python scripts/mdb_apply_types_20260830.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/mdb_apply_types_20260830.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  python scripts/mdb_restore_types_20260830.py <백업파일> --apply
"""

import argparse
import io
import json
import os
import re
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

# --- 자료유형: (이름, 그 유형으로 볼 말들) — 구체적인 것을 위에 둔다 ---------------
DOC_TYPES = [
    ("IRN", ["IRN", "INSPECTION RELEASE"]),
    ("Inspection Report", ["INSPECTION REPORT", "INSPECTION&TEST REPORT", "INSPECTION TEST REPORT",
                           "TEST REPORT", "EXAMINATION", "MILL TEST", "INSPECTION RECORD",
                           "DATA REPORT", "TEST RESULT"]),
    ("Test Plan", ["TEST PLAN", "INSPECTION PLAN", "ITP", "QUALITY PLAN"]),
    ("Procedure", ["PROCEDURE", "WPS", "PQR", "WELDING MAP", "INSTRUCTION OF PAINTING",
                   "WORK INSTRUCTION"]),
    ("Inspection", ["INSPECTION", "검사"]),
    ("Data Sheet", ["DATA SHEET", "DATASHEET"]),
    ("Drawing", ["DRAWING", "OUTLINE", "SECTIONAL", "LAYOUT", "DIAGRAM", "CURVE", "P&ID", "P & ID",
                 "GAD", "GENERAL ASSEMBLY", "PLAN VIEW", "ANCHOR BOLT PLAN"]),
    ("Manual", ["MANUAL", "I.O.M", "IOM", "INSTRUCTION", "OPERATION"]),
    ("Catalog", ["CATALOG", "CATALOGUE"]),
    ("Certificate", ["CERTIFICAT", "NAME PLATE", "NAMEPLATE", "GUARANTEE"]),
    ("Calculation", ["CALCULATION", "CAL.", "CALC"]),
    ("Specification", ["SPECIFICATION"]),
    ("Schedule", ["SCHEDULE"]),
    ("Index", ["INDEX"]),
    ("List", ["LIST", "BILL OF MATERIAL", "BM", "B/M", "SCOPE OF SUPPLY", "TABULATION"]),
    ("Cover", ["COVER", "HEAD"]),
    ("Contents", ["CONTENTS"]),
    ("Transmittal", ["TRANSMITTAL"]),
]

# --- 설비유형: 경로·이름에 이 말이 있으면 그 설비로 본다 -------------------------
EQUIPMENT_TYPES = [
    ("Loading Arm", ["LOADING ARM"]),
    ("Compressor", ["COMPRESSOR"]),
    ("Crane", ["CRANE", "HOIST"]),
    ("Mixer", ["MIXER"]),
    ("Strainer", ["STRAINER", "FILTER"]),
    ("Pump", ["PUMP"]),
    ("Vessel", ["VESSEL", "PIG RECEIVER"]),
    ("Tank", ["TANK"]),
    ("Valve", ["VALVE", "MOV", "ACTUATOR"]),
    ("Motor", ["MOTOR"]),
    ("PSV", ["PSV", "SAFETY VALVE"]),
    ("Instrument", ["INSTRUMENT", "TRANSMITTER", "GAUGE"]),
    ("Electrical", ["ELECTRIC", "SWITCHGEAR", "MCC", "BATTER"]),
]
# 설비유형이 셋 이상 걸리면 무엇인지 가릴 수 없으므로 비워둔다.
MAX_EQUIPMENT_GUESS = 2


def split_pieces(text: str) -> list[str]:
    """자료 이름을 "&"·"and"·"+" 로 쪼갠다. 앞의 번호와 Rev 표기는 떼어낸다."""
    cleaned = re.sub(r"^[\s\(\[]*[0-9IVXa-z]{1,4}[\.\)\-_]+\s*", "", text)
    cleaned = re.sub(r"\(?rev[\. ]*[0-9A-Za-z]*\)?", "", cleaned, flags=re.I)
    return [p.strip() for p in re.split(r"\s*(?:&|and|\+)\s*", cleaned, flags=re.I) if p.strip()]


# 낱말 한가운데에 우연히 들어가면 안 되는 말들. 예를 들어 "BM"(자재목록)을 그냥 찾으면
# "Su(bm)ersible Pump"가 목록으로 걸리고, "PLAN"은 "PLANT"에 걸린다.
WHOLE_WORD_ONLY = {"BM", "PLAN", "HEAD", "IRN", "ITP", "IOM", "GAD", "WPS", "PQR", "DWG",
                   "MOV", "MCC", "PSV", "LIST"}


def contains_word(text: str, word: str) -> bool:
    """word가 text에 들어 있는지 본다. 짧아서 헷갈리는 말은 낱말 단위로만 찾는다."""
    if word in WHOLE_WORD_ONLY:
        return re.search(r"\b%s\b" % re.escape(word), text) is not None
    if word.isalpha():
        # 낱말 첫머리부터 맞아야 한다("PUMPS"는 PUMP로 걸리되 "SUBMERSIBLE"은 BM으로 안 걸린다).
        return re.search(r"\b%s" % re.escape(word), text) is not None
    return word in text


def classify_piece(piece: str) -> str | None:
    upper = piece.upper()
    for name, words in DOC_TYPES:
        if any(contains_word(upper, word) for word in words):
            return name
    return None


def guess_doc_types(group) -> list[str]:
    """자료 이름으로 자료유형을 고른다. 이름으로 안 되면 마지막 폴더 이름으로 한 번 더 본다."""
    found: list[str] = []
    for piece in split_pieces(group.name):
        name = classify_piece(piece)
        if name and name not in found:
            found.append(name)
    if not found:
        for piece in split_pieces(group.folder.split("\\")[-1]):
            name = classify_piece(piece)
            if name and name not in found:
                found.append(name)
    return found


def guess_equipment_types(group) -> list[str]:
    # 맨 위 공사 폴더는 빼고 본다 — "SK가스 Tank Terminal Project"처럼 공사 이름에 설비 이름이
    # 들어 있으면 그 공사 자료가 전부 Tank로 걸려버린다.
    inner = "\\".join(group.folder.split("\\")[1:])
    text = ("%s %s" % (group.name, inner)).upper()
    return [name for name, words in EQUIPMENT_TYPES if any(contains_word(text, word) for word in words)]


def ensure_type_rows(db, model, names: list[str]) -> list[str]:
    """마스터 목록에 없는 이름을 새로 만든다. 만든 이름을 돌려준다."""
    existing = {row.name for row in db.query(model).all()}
    created = []
    for name in names:
        if name not in existing:
            db.add(model(name=name))
            created.append(name)
    return created


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    db = SessionLocal()

    # --- 1) 마스터 목록에 없는 자료유형 만들기 ---------------------------------
    wanted = [name for name, _ in DOC_TYPES]
    have = {row.name for row in db.query(MdbDocType).all()}
    to_create = [n for n in wanted if n not in have]
    print("자료유형 목록: 이미 있는 것 %d개 / 새로 만들 것 %d개" % (len(wanted) - len(to_create), len(to_create)))
    if to_create:
        print("  새로 만들 것: %s" % ", ".join(to_create))

    # --- 2) 자료마다 채울 값 정하기 -------------------------------------------
    rows = db.query(MdbFile).filter(MdbFile.is_archived.is_(False)).all()
    groups = mdb_group.build_groups(rows, mdb_group.load_tags_map(db, [r.id for r in rows]))

    doc_changes = []      # (group, 새 doc_type)
    eq_changes = []       # (group, 새 equipment_type)
    doc_stat = Counter()
    eq_stat = Counter()
    doc_type_use = Counter()

    for group in groups:
        if group.doc_type:
            doc_stat["이미 값이 있어 그대로 둠"] += 1
        else:
            guessed = guess_doc_types(group)
            if guessed:
                doc_changes.append((group, mdb_types.join_types(guessed)))
                doc_stat["채움"] += 1
                for name in guessed:
                    doc_type_use[name] += 1
            else:
                doc_stat["이름에 단서가 없어 비워둠"] += 1

        if group.equipment_type:
            eq_stat["이미 값이 있어 그대로 둠"] += 1
        else:
            guessed = guess_equipment_types(group)
            if not guessed:
                eq_stat["단서가 없어 비워둠"] += 1
            elif len(guessed) > MAX_EQUIPMENT_GUESS:
                eq_stat["여러 설비가 걸려 비워둠"] += 1
            else:
                eq_changes.append((group, mdb_types.join_types(guessed)))
                eq_stat["채움"] += 1

    print("\n=== 자료유형 (자료 %d건) ===" % len(groups))
    for key, count in doc_stat.most_common():
        print("  %-28s %5d건" % (key, count))
    print("\n  유형별로 몇 건에 붙나")
    for name, count in doc_type_use.most_common():
        print("     %-20s %4d건" % (name, count))
    multi = Counter(len(mdb_types.split_types(value)) for _g, value in doc_changes)
    print("\n  한 자료에 붙는 유형 개수: %s"
          % ", ".join("%d개=%d건" % (k, v) for k, v in sorted(multi.items())))

    print("\n=== 설비유형 (지금 비어 있는 자료만) ===")
    for key, count in eq_stat.most_common():
        print("  %-28s %5d건" % (key, count))

    print("\n=== 자료유형 예시 10 ===")
    for group, value in doc_changes[:10]:
        print("  %-52s -> %s" % (group.name[:52], value))
    print("\n=== 설비유형 예시 10 ===")
    for group, value in eq_changes[:10]:
        print("  %-52s -> %s" % (group.name[:52], value))

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        db.rollback()
        db.close()
        return

    # --- 3) 백업 -------------------------------------------------------------
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "mdb_types_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump({
            "mdb_doc_types": [{"id": t.id, "name": t.name} for t in db.query(MdbDocType).all()],
            "equipment_types": [{"id": t.id, "name": t.name} for t in db.query(EquipmentType).all()],
            "mdb_files": [{"id": r.id, "doc_type": r.doc_type, "equipment_type": r.equipment_type}
                          for r in db.query(MdbFile).all()],
        }, handle, ensure_ascii=False, indent=1)
    print("\n백업 저장: %s" % backup_path)

    # --- 4) 반영 -------------------------------------------------------------
    created = ensure_type_rows(db, MdbDocType, wanted)
    # 자료유형·설비유형은 자료 단위 값이라 자료에 속한 파일 전부에 같은 값을 써준다
    # (mdb_editor.update_info와 같은 방식).
    for group, value in doc_changes:
        for row in group.rows:
            row.doc_type = value
    for group, value in eq_changes:
        for row in group.rows:
            row.equipment_type = value

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID,
        action="MDB_TYPES_FILL",
        document_id=None,
        detail={
            "script": "mdb_apply_types_20260830.py",
            "created_doc_types": created,
            "doc_type_filled": len(doc_changes),
            "equipment_type_filled": len(eq_changes),
            "doc_type_stat": dict(doc_stat),
            "equipment_type_stat": dict(eq_stat),
            "backup": os.path.basename(backup_path),
        },
    ))
    db.commit()
    print("반영 완료: 자료유형 %d건 / 설비유형 %d건 / 새 자료유형 %d개"
          % (len(doc_changes), len(eq_changes), len(created)))
    db.close()


if __name__ == "__main__":
    main()
