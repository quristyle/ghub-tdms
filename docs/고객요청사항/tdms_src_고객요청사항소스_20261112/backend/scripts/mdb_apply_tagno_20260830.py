# -*- coding: utf-8 -*-
"""MDB Tag No 정리 1회성 스크립트 (2026-08-30 CM 지시).

CM 지시 내용은 이랬다.
  ① Tag No는 원래 "TT-"가 붙는 것만이다. MB300-01 같은 품목코드는 Tag No가 아니므로 뺀다.
     (저장값에는 TT- 접두어가 없다 — 2026-08-29 fix_tagno_tt_prefix_20260829.py로 이미 떼어냈다.)
  ② 품목코드 자리에 들어갈 진짜 Tag No는 CM이 엑셀에 적어주었다
     (MDB_TagNo_입력자료_20260830.xlsx, 시트 "3.공사별 품목코드").
     같은 품목코드라도 공사가 다르면 다른 기기이므로 "공사 + 품목코드"로 짝지어 읽는다.
  ③ 슬래시는 각각 나눈다.  T1504A/B -> T1504A, T1504B
  ④ 자료가 그 기기 여러 대 중 어느 것인지 모를 때는 **비워둔다** (A안, CM 승인).
     · 카탈로그·매뉴얼·도면처럼 그 기종 전체에 공통인 자료 -> 그 줄의 Tag No 전부
     · 성적서·데이터시트처럼 기기 한 대마다 만드는 자료   -> 자료 안에 번호가 적혀 있을 때만
     · 그 밖                                          -> 비워둔다

지시 범위 밖이라 손대지 않는 것: 설비유형·자료유형·Note·자료명·경로·파일.
mdb_file_tags 표만 고친다.

실행
  python scripts/mdb_apply_tagno_20260830.py --dry-run   무엇이 바뀌는지 보기만 (기본값)
  python scripts/mdb_apply_tagno_20260830.py --apply     실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  python scripts/mdb_restore_tagno_20260830.py <백업파일>
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

from openpyxl import load_workbook  # noqa: E402

from app import mdb_group  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, MdbFile, MdbFileTag  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE_XLSX = os.path.join(ROOT, "참고자료", "MDB_TagNo_입력자료_20260830.xlsx")
SHEET = "3.공사별 품목코드"
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정

# 품목코드 모양 — 영문 2자 + 숫자 3자리 + "-" + 숫자 2자리 (MB300-01)
ITEM_CODE = re.compile(r"^[A-Z]{2}\d{3}-\d{2}$")

# CM이 "Tag No 없음", "추후 확인 예정"처럼 적은 칸은 태그가 아니다.
NOT_A_TAG = ("없음", "추후", "확인 예정", "미정", "해당없음")

# 값 하나를 푸는 모양:  접두문자 + 숫자 + (글자) + (/글자)*   예) SV1102A/E/H
TOKEN = re.compile(r"^([A-Za-z]+)\s*(\d+)\s*([A-Za-z]*)((?:\s*/\s*[A-Za-z0-9]+)*)$")
# 범위 표기:  SV1701 ~ SV1708
RANGE = re.compile(r"^([A-Za-z]+)(\d+)\s*~\s*([A-Za-z]+)?(\d+)$")

# 이 품목코드들의 Tag No는 U-Plus 공사 문서(계장 인덱스) 한 곳에서만 확인된 값이다.
# 다른 공사 줄에 그대로 쓰면 남의 공사 설비번호를 붙이게 되므로 U-Plus 줄에서만 쓴다.
# (2026-08-30 CM 보고 후 확정)
UPLUS_ONLY = {"NB110-01", "ND110-01", "ND210-01", "NE210-01", "NE310-01",
              "NF110-03", "NF410-01", "NF510-01", "NG110-02", "MF110-01"}
UPLUS_PROJECT = "2022. 01. - U-Plus Project"

# 기기 한 대마다 따로 만드는 자료 — 어느 대 것인지 모르면 비운다.
PER_UNIT_WORDS = ("INSPECTION REPORT", "TEST REPORT", "IRN", "INSPECTION RELEASE", "DATA SHEET",
                  "DATASHEET", "MILL TEST", "EXAMINATION", "CERTIFICAT", "NAME PLATE",
                  "INSPECTION RECORD", "DATA REPORT", "CALCULATION", "LOADING DATA")
# 그 기종 전체에 공통인 자료 — 그 줄의 Tag No를 전부 붙인다.
COMMON_WORDS = ("CATALOG", "CATALOGUE", "MANUAL", "I.O.M", "INSTRUCTION", "DRAWING", "DWG",
                "SPECIFICATION", "PROCEDURE", "WPS", "PQR", "LIST", "SCHEDULE", "PLAN",
                "OUTLINE", "SECTIONAL", "DIAGRAM", "CURVE")

# 자료 안(PDF 글자)에서 찾은 Tag No — clues 파일이 있으면 쓴다. 없으면 그 자료는 비운다.
CLUES_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mdb_tagno_clues_20260830.json")


# ---------------------------------------------------------------------------
# CM 엑셀 읽기
# ---------------------------------------------------------------------------

def expand_token(token: str) -> list[str]:
    """CM이 적은 값 하나를 실제 Tag No 목록으로 푼다. 못 풀면 빈 목록."""
    text = token.strip()
    if not text or any(word in text for word in NOT_A_TAG):
        return []

    ranged = RANGE.match(text.replace(" ", ""))
    if ranged:
        prefix, start, prefix2, end = ranged.groups()
        if prefix2 and prefix2.upper() != prefix.upper():
            return []
        start_n, end_n = int(start), int(end)
        if end_n < start_n or end_n - start_n > 60:
            return []
        width = len(start)
        return ["%s%0*d" % (prefix.upper(), width, i) for i in range(start_n, end_n + 1)]

    matched = TOKEN.match(text)
    if not matched:
        return []
    prefix, number, first, rest = matched.groups()
    base = "%s%s" % (prefix.upper(), number)
    tags = [base + first.upper()] if first else [base]
    for piece in re.findall(r"/\s*([A-Za-z0-9]+)", rest):
        tags.append(base + piece.upper())
    return tags


def read_cm_table() -> tuple[dict[tuple[str, str], list[str]], list[str]]:
    """엑셀에서 (공사, 품목코드) -> Tag No 목록을 읽는다."""
    sheet = load_workbook(SOURCE_XLSX, data_only=True)[SHEET]
    table: dict[tuple[str, str], list[str]] = {}
    unreadable: list[str] = []
    for row in sheet.iter_rows(min_row=2, values_only=True):
        project, code, _name, _n, _c, _p, _s, found, _judge, cm_tag = row[:10]
        raw = " , ".join(value for value in (found, cm_tag) if value)
        if not raw.strip():
            continue
        tags: list[str] = []
        for piece in re.split(r"[,\n]", raw):
            expanded = expand_token(piece)
            if not expanded and piece.strip() and not any(w in piece for w in NOT_A_TAG):
                unreadable.append("%s / %s / %s" % (project, code, piece.strip()))
            for tag in expanded:
                if tag not in tags:
                    tags.append(tag)
        if tags:
            table[(project, code)] = tags
    return table, unreadable


# ---------------------------------------------------------------------------
# 자료마다 붙일 Tag No 정하기
# ---------------------------------------------------------------------------

def is_item_code(tag: str) -> bool:
    return bool(ITEM_CODE.fullmatch(tag.upper()))


def document_nature(group) -> str:
    text = ("%s %s" % (group.name, group.folder.split("\\")[-1])).upper()
    if any(word in text for word in PER_UNIT_WORDS):
        return "기기별"
    if any(word in text for word in COMMON_WORDS):
        return "공통"
    return "모름"


def strip_tt(tag: str) -> str:
    upper = tag.upper()
    return upper[3:] if upper.startswith("TT-") else upper


def load_clues() -> dict[int, list[str]]:
    """자료 안 글자에서 찾아둔 Tag No (자료 id -> 태그들)."""
    if not os.path.exists(CLUES_JSON):
        return {}
    with open(CLUES_JSON, encoding="utf-8") as handle:
        return {int(k): v for k, v in json.load(handle).items()}


def decide(group, cm_table, clues) -> tuple[list[str], str]:
    """이 자료에 최종적으로 붙일 Tag No와 그 이유."""
    keep = [t for t in group.tags if not is_item_code(t)]
    codes = [t.upper() for t in group.tags if is_item_code(t)]
    if not codes:
        return sorted(keep, key=str.upper), "품목코드가 없어 그대로 둠"

    code = codes[0]
    project = group.folder.split("\\")[0]
    pool = cm_table.get((project, code), [])
    if code in UPLUS_ONLY and project != UPLUS_PROJECT:
        return sorted(keep, key=str.upper), "다른 공사에서 확인된 값이라 쓰지 않음 — 비움"
    if not pool:
        return sorted(keep, key=str.upper), "CM이 Tag No를 안 적은 줄 — 비움"

    nature = document_nature(group)
    if nature == "공통":
        return sorted(set(keep) | set(pool), key=str.upper), "기종 공통 자료 — 그 공사 Tag No 전부"

    if nature == "기기별":
        # 자료 안에서 찾은 값에도 슬래시가 있다(TT-D2100A/B) — CM 규칙대로 똑같이 나눈다.
        found: list[str] = []
        for raw in clues.get(group.id, []):
            found.extend(expand_token(strip_tt(raw)))
        narrowed = [t for t in found if t in pool]
        if narrowed:
            return sorted(set(keep) | set(narrowed), key=str.upper), "자료 안에 적힌 번호"
        return sorted(keep, key=str.upper), "기기별 자료인데 어느 대 것인지 몰라 비움"

    return sorted(keep, key=str.upper), "자료 성격을 몰라 비움"


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    cm_table, unreadable = read_cm_table()
    print("CM 엑셀에서 읽은 줄: %d개 / Tag No 종류 %d개"
          % (len(cm_table), len({t for v in cm_table.values() for t in v})))
    if unreadable:
        print("!! 못 읽은 값이 있어 중단한다:")
        for line in unreadable:
            print("   ", line)
        return

    clues = load_clues()
    print("자료 안에서 미리 찾아둔 번호가 있는 자료: %d건" % len(clues))

    db = SessionLocal()
    rows = db.query(MdbFile).filter(MdbFile.is_archived.is_(False)).all()
    groups = mdb_group.build_groups(rows, mdb_group.load_tags_map(db, [r.id for r in rows]))

    changes = []
    reasons = Counter()
    for group in groups:
        before = sorted(group.tags, key=str.upper)
        after, reason = decide(group, cm_table, clues)
        if before != after:
            changes.append((group, before, after, reason))
            reasons[reason] += 1

    print("\n=== 바뀌는 자료 %d건 ===" % len(changes))
    for reason, count in reasons.most_common():
        print("  %-44s %4d건" % (reason, count))

    with_tag_before = sum(1 for g in groups if g.tags)
    after_map = {g.id: a for g, _b, a, _r in changes}
    with_tag_after = sum(1 for g in groups if after_map.get(g.id, sorted(g.tags, key=str.upper)))
    print("\n  Tag No 있는 자료: %d건 -> %d건" % (with_tag_before, with_tag_after))

    print("\n=== 바뀌는 예시 8 ===")
    for group, before, after, reason in changes[:8]:
        print("  %s" % group.name[:56])
        print("      전: %s" % (", ".join(before)[:74] or "(없음)"))
        print("      후: %s   <- %s" % (", ".join(after)[:74] or "(없음)", reason))

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        db.close()
        return

    # --- 백업 먼저 ---------------------------------------------------------
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "mdb_file_tags_백업_%s.json" % stamp)
    all_tags = db.query(MdbFileTag).all()
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump([{"id": t.id, "mdb_file_id": t.mdb_file_id, "tag_no": t.tag_no} for t in all_tags],
                  handle, ensure_ascii=False, indent=1)
    print("\n백업 저장: %s (%d줄)" % (backup_path, len(all_tags)))

    # --- 반영 -------------------------------------------------------------
    # Tag No는 자료 단위 값이라 자료에 속한 파일 전부에 같은 것을 달아둔다
    # (mdb_editor.update_info와 같은 방식).
    for group, _before, after, _reason in changes:
        for row in group.rows:
            db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id == row.id).delete()
            for tag in after:
                db.add(MdbFileTag(mdb_file_id=row.id, tag_no=tag))

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID,
        action="MDB_TAGNO_CLEANUP",
        document_id=None,
        detail={
            "script": "mdb_apply_tagno_20260830.py",
            "source": os.path.basename(SOURCE_XLSX),
            "changed_documents": len(changes),
            "with_tag_before": with_tag_before,
            "with_tag_after": with_tag_after,
            "reasons": dict(reasons),
            "backup": os.path.basename(backup_path),
        },
    ))
    db.commit()
    print("반영 완료: 자료 %d건" % len(changes))
    db.close()


if __name__ == "__main__":
    main()
