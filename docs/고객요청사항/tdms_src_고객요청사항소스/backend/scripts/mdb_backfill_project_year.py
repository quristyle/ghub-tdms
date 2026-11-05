# -*- coding: utf-8 -*-
"""일회성 보정: mdb_files의 소속공사·연도를 지금의 source_path(최상위 폴더) 기준으로 다시 계산해 채운다.

폴더 이동 시 자동으로 다시 계산하도록 고치기 전에(2026-08-04) 옮겨진 자료들이 옛 소속공사·연도를
그대로 갖고 있어서, 한 번만 전체를 훑어 맞춰준다. 태그·설비유형·비고는 건드리지 않는다.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal  # noqa: E402
from app.mdb_utils import get_or_create_project, project_name_for, year_for  # noqa: E402
from app.models import MdbFile  # noqa: E402


def main():
    db = SessionLocal()
    rows = db.query(MdbFile).all()
    changed = 0
    for r in rows:
        project = get_or_create_project(db, project_name_for(r.source_path))
        year = year_for(r.source_path)
        if r.project_id != project.id or r.year != year:
            r.project_id = project.id
            r.year = year
            changed += 1
    db.commit()
    print(f"전체 {len(rows)}건 중 {changed}건 소속공사/연도 갱신")


if __name__ == "__main__":
    main()
