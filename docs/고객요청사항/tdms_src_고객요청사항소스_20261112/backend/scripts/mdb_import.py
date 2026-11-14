# -*- coding: utf-8 -*-
"""MDB 초기 적재: 로컬 MDB 폴더(CM이 정리해둔 백업 사본)를 storage/MDB로 복사하고,
경로에서 태그/설비유형을 자동 추출해 mdb_files/mdb_file_tags에 채운다.

- 원본(CM이 가진 진짜 원본)은 건드리지 않는다. 여기서 읽는 폴더 자체가 이미 CM이 준 사본이고,
  이 스크립트가 그걸 다시 storage/MDB로 한 번 더 복사해 시스템 안에 백업해둔다(D-24와 같은 원칙).
- 자동으로 태그가 안 잡히는 자료는 equipment_type만 최대한 추정해서 '공용'으로, 그것도 안 되면
  '확인필요'로 남긴다. CM이 화면에서 나중에 태그를 채워 넣을 수 있다.
- 재실행해도 안전하도록 sha256 기준으로 이미 있는 파일은 건너뛴다.
"""
import hashlib
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.mdb_utils import TOP_FOLDER_YEAR_RE, get_or_create_project, project_name_for  # noqa: E402
from app.models import MdbFile, MdbFileTag, User  # noqa: E402
from app.storage import mdb_file_path  # noqa: E402

MDB_ROOT = r"C:\Users\Ghub\바탕화면\도면관리시스템\MDB"

JUNK_NAMES = {"thumbs.db", "desktop.ini"}
JUNK_EXTS = {"tmp", "bak", "old", "log"}

TAG_RE = re.compile(r"TT-[A-Z]{1,5}\d{3,5}[A-Z]{0,3}(?:[/&][A-Z0-9]+)*")
# 뒤에 언더스코어가 바로 붙는 경우가 많아서(예: "NF410-03_Electro...") \b 대신
# 영문·숫자가 아니면 전부 경계로 인정하는 lookaround를 쓴다. \b는 '_'를 단어문자로 쳐서 놓친다.
TYPE_CODE_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z]{1,2}\d{2,3}-\d{2}(?:&\d{1,3})*(?![A-Za-z0-9])")

COMMON_PART_HINTS = ["strainer", "tube & tube fitting", "gasket", "bolt",
                      "fitting", "flange", "catalogue", "wps", "pqr", "spec"]

TYPE_KEYWORDS = [
    ("centrifugal pump", "Pump"), ("submersible pump", "Pump"), ("pump", "Pump"),
    ("pressure vessel", "Vessel"), ("vessel", "Vessel"),
    ("air compressor", "Compressor"), ("compressor", "Compressor"),
    ("tank mixer", "Mixer"), ("inline mixer", "Mixer"), ("mixer", "Mixer"),
    ("crane", "Crane"), ("hoist", "Crane"),
    ("loading arm", "Loading Arm"),
    ("tank accessories", "Tank"), ("tank", "Tank"),
    ("motor operated valve", "Valve"), ("mov", "Valve"), ("valve", "Valve"),
    ("strainer", "Strainer"),
    ("instrument", "Instrument"), ("motor", "Motor"),
    ("cable", "Electrical"), ("electrical", "Electrical"),
]


def split_letters(s: str):
    return list(s) if s.isalpha() and 1 < len(s) <= 3 else ([s] if s else [])


def expand_tt_tag(raw: str):
    m = re.match(r"(TT-[A-Z]{1,5}\d{3,5})([A-Z]{0,3})((?:[/&][A-Z0-9]+)*)", raw)
    if not m:
        return {raw}
    base, suffix, extra = m.groups()
    variants = set()
    if suffix:
        variants.add(base + suffix)
        variants.update(base + c for c in split_letters(suffix))
    else:
        variants.add(base)
    for piece in re.findall(r"[/&]([A-Z0-9]+)", extra):
        variants.add(base + piece)
        variants.update(base + c for c in split_letters(piece))
    return variants


def expand_type_code(raw: str):
    m = re.match(r"([A-Z]{1,2}\d{2,3})-(\d{2})((?:&\d{1,3})*)", raw)
    if not m:
        return {raw}
    base, first, extra = m.groups()
    variants = {f"{base}-{first}"}
    for piece in re.findall(r"&(\d{1,3})", extra):
        variants.add(f"{base}-{piece.zfill(len(first))}")
    return variants


def extract_tags(rel_path_upper: str):
    tags = set()
    for m in TAG_RE.finditer(rel_path_upper):
        tags |= expand_tt_tag(m.group(0))
    for m in TYPE_CODE_RE.finditer(rel_path_upper):
        tags |= expand_type_code(m.group(0))
    return tags


def guess_equipment_type(rel_path_lower: str):
    for kw, t in TYPE_KEYWORDS:
        if kw in rel_path_lower:
            return t
    return None


def main():
    db = SessionLocal()
    system_user = db.query(User).filter(User.role == "ADMIN").first()
    if system_user is None:
        print("ADMIN 사용자가 없어 종료합니다.")
        return

    existing_hashes = {r[0] for r in db.query(MdbFile.sha256).all()}

    total = created = skipped_existing = skipped_junk = 0
    tag_hit = common_hit = review_only = 0

    for dirpath, dirs, files in os.walk(MDB_ROOT):
        for fn in files:
            total += 1
            full = Path(dirpath) / fn
            rel = str(full.relative_to(MDB_ROOT))
            if fn.lower() in JUNK_NAMES:
                skipped_junk += 1
                continue
            ext = fn.rsplit(".", 1)[-1].lower() if "." in fn else ""
            if ext in JUNK_EXTS:
                skipped_junk += 1
                continue

            data = full.read_bytes()
            sha256 = hashlib.sha256(data).hexdigest()
            if sha256 in existing_hashes:
                skipped_existing += 1
                continue

            rel_upper = rel.upper()
            rel_lower = rel.lower()
            top_folder = rel.split(os.sep)[0]

            tags = extract_tags(rel_upper)
            equipment_type = guess_equipment_type(rel_lower)
            if tags:
                tag_hit += 1
            elif any(h in rel_lower for h in COMMON_PART_HINTS) or equipment_type:
                common_hit += 1
            else:
                review_only += 1

            project = get_or_create_project(db, project_name_for(rel))
            year_m = TOP_FOLDER_YEAR_RE.match(top_folder)
            year = int(year_m.group(1)) if year_m else None

            dest = mdb_file_path(rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

            mdb_file = MdbFile(
                storage_path=str(dest.relative_to(STORAGE_ROOT)).replace("\\", "/"),
                source_path=rel,
                original_filename=fn,
                file_ext=ext,
                file_size=len(data),
                sha256=sha256,
                is_pdf=(ext == "pdf"),
                equipment_type=equipment_type,
                project_id=project.id,
                year=year,
            )
            db.add(mdb_file)
            db.flush()

            for t in tags:
                db.add(MdbFileTag(mdb_file_id=mdb_file.id, tag_no=t))

            existing_hashes.add(sha256)
            created += 1

            if created % 200 == 0:
                db.commit()
                print(f"  ...{created}건 적재", flush=True)

    db.commit()
    print("완료", flush=True)
    print(f"전체 스캔 {total} / 신규 적재 {created} / 이미 있음(재실행) {skipped_existing} / 시스템자료 제외 {skipped_junk}", flush=True)
    print(f"태그 자동인식 {tag_hit} / 공용(설비유형만) {common_hit} / 확인필요 {review_only}", flush=True)


if __name__ == "__main__":
    main()
