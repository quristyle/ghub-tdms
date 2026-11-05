from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Distribution, Project
from app.schemas import ProjectCreate, ProjectItem, ProjectRename

router = APIRouter(prefix="/projects", tags=["projects"])


def find_duplicate_project(db: Session, name: str, exclude_id: int | None = None) -> Project | None:
    """공사명은 대소문자·앞뒤 공백 차이만으로 다른 공사가 되지 않게, 숨김 여부와 무관하게
    전부 대상으로 중복을 검사한다(숨긴 공사와 같은 이름으로 새로 만드는 것도 막는다)."""
    query = db.query(Project).filter(func.lower(Project.name) == name.lower())
    if exclude_id is not None:
        query = query.filter(Project.id != exclude_id)
    return query.first()


@router.get("", response_model=list[ProjectItem])
def list_projects(only_outstanding: bool = False, db: Session = Depends(get_db)):
    """only_outstanding=true면 지금 미반납 상태로 나가 있는 반출 건이 있는 공사만 준다.
    반입 화면에서 실제로 반출된 적 없는 공사를 잘못 고르는 걸 막기 위함."""
    query = db.query(Project).filter(Project.is_hidden.is_(False))
    if only_outstanding:
        query = query.filter(
            Project.id.in_(
                select(Distribution.project_id).where(
                    Distribution.purpose == "MODIFY",
                    Distribution.returned_at.is_(None),
                    Distribution.project_id.isnot(None),
                )
            )
        )
    return query.order_by(Project.name).all()


@router.post("", response_model=ProjectItem)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="공사명을 입력해주세요")
    duplicate = find_duplicate_project(db, name)
    if duplicate:
        raise HTTPException(status_code=409, detail=f"이미 등록된 공사명입니다: {duplicate.name}")

    project = Project(
        name=name,
        project_no=body.project_no,
        vendor=body.vendor,
        note=body.note,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.patch("/{project_id}", response_model=ProjectItem)
def rename_project(project_id: int, body: ProjectRename, db: Session = Depends(get_db)):
    """공사명을 바꾼다. project_id는 documents/files/distributions가 전부 FK로 참조하므로,
    이름만 바꾸면 과거에 그 공사로 반출·등록된 기록들의 표시도 자동으로 같이 바뀐다."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="존재하지 않는 공사입니다")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="공사명을 입력해주세요")
    duplicate = find_duplicate_project(db, name, exclude_id=project_id)
    if duplicate:
        raise HTTPException(status_code=409, detail=f"이미 등록된 공사명입니다: {duplicate.name}")
    project.name = name
    db.commit()
    db.refresh(project)
    return project


@router.post("/{project_id}/hide")
def hide_project(project_id: int, db: Session = Depends(get_db)):
    """공사를 드롭다운에서만 안 보이게 한다. D-6: 실제 행은 지우지 않는다(과거 반출·리비전 기록의 FK 보존)."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="존재하지 않는 공사입니다")
    project.is_hidden = True
    db.commit()
    return {"ok": True}
