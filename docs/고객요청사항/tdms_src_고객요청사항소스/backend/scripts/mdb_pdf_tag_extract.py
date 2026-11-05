# -*- coding: utf-8 -*-
"""PDF 안쪽 글자에서 태그(ITEM NO./TAG NO. 등으로 적힌 TT-P1101A 같은 값)를 찾아
기존 태그에 추가한다. 경로/파일명만으로는 못 찾는 자료(공용 데이터시트에 여러 설비가
한 파일에 뭉쳐 있는 경우 등)를 보완하기 위한 것 — 기존 태그는 지우지 않고 더할 뿐이다.

읽을 수 없는(스캔 이미지 등 글자층이 없는) PDF는 조용히 건너뛴다.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import MdbFile, MdbFileTag  # noqa: E402
from pypdf import PdfReader  # noqa: E402
from pypdf.errors import PdfReadError  # noqa: E402

TAG_RE = re.compile(r"TT-[A-Z]{1,5}\d{3,5}[A-Z]{0,3}(?:[/&][A-Z0-9]+)*")


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


def extract_tags_from_text(text: str):
    tags = set()
    for m in TAG_RE.finditer(text.upper()):
        tags |= expand_tt_tag(m.group(0))
    return tags


def main():
    db = SessionLocal()
    rows = db.query(MdbFile).filter(MdbFile.file_ext == "pdf").order_by(MdbFile.id).all()
    print(f"대상 PDF {len(rows)}건 스캔 시작", flush=True)

    existing_tags_by_file = {}
    for t in db.query(MdbFileTag).all():
        existing_tags_by_file.setdefault(t.mdb_file_id, set()).add(t.tag_no)

    added_files = 0
    added_tags = 0
    unreadable = 0

    for i, row in enumerate(rows, start=1):
        path = Path(STORAGE_ROOT) / row.storage_path
        try:
            reader = PdfReader(str(path))
            text_parts = []
            for page in reader.pages:
                text_parts.append(page.extract_text() or "")
            text = "\n".join(text_parts)
        except (PdfReadError, Exception):
            unreadable += 1
            continue

        found = extract_tags_from_text(text)
        current = existing_tags_by_file.get(row.id, set())
        new_tags = found - current
        if new_tags:
            for t in new_tags:
                db.add(MdbFileTag(mdb_file_id=row.id, tag_no=t))
            existing_tags_by_file.setdefault(row.id, set()).update(new_tags)
            added_files += 1
            added_tags += len(new_tags)

        if i % 100 == 0:
            db.commit()
            print(f"  ...{i}/{len(rows)}건 처리, 지금까지 태그 추가 {added_tags}건", flush=True)

    db.commit()
    print("완료", flush=True)
    print(f"글자 못 읽음(스캔본 등) {unreadable}건 / 태그 보강된 자료 {added_files}건 / 새로 추가된 태그 {added_tags}건", flush=True)


if __name__ == "__main__":
    main()
