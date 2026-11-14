"""MDB 자료의 소속 공사·연도를 경로에서 추론하는 공용 로직.

최초 적재(mdb_import.py), 재동기화(mdb_resync.py), MDB 편집 화면의 폴더 이동/이름변경
(mdb_editor.py)이 전부 이 로직을 공유해야 "어느 경로로 옮기든 같은 규칙으로 공사·연도가
정해진다"가 보장된다.
"""
import os
import re

from app.models import Project

# 최상위 폴더명이 "{연도}. {월}. - {공사명}" 형식(2026-08-03 CM 재정리 규칙)이라
# 앞의 연도를 그대로 공사연도로 쓴다.
TOP_FOLDER_YEAR_RE = re.compile(r"^(\d{4})\.")


def project_name_for(rel: str) -> str:
    """MDB 폴더 최상위 = 공사 1개. 최상위 폴더명을 그대로 공사명으로 쓴다."""
    return rel.replace("\\", os.sep).split(os.sep)[0].strip()


def year_for(rel: str) -> int | None:
    top_folder = rel.replace("\\", os.sep).split(os.sep)[0]
    m = TOP_FOLDER_YEAR_RE.match(top_folder)
    return int(m.group(1)) if m else None


def get_or_create_project(db, name: str) -> Project:
    project = db.query(Project).filter(Project.name == name).first()
    if project is None:
        project = Project(name=name, vendor=None, note="MDB 자동 적재 시 생성")
        db.add(project)
        db.flush()
    return project
