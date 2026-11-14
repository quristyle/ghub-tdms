"""업체 목록. 업체 마스터 테이블은 따로 두지 않고(관리 화면을 늘리지 않기 위해),
지금까지 반출·반입에 실제로 쓰인 업체명을 모아서 준다.

화면에서는 자유 입력 + 목록 선택을 함께 쓴다(datalist). 그래서 처음 쓰는 업체도
그냥 타이핑하면 되고, 한 번 쓰면 다음부터 목록에 나온다.

'삭제'는 실제 반출·리비전 기록(vendor_name)을 지우는 게 아니라(D-6), hidden_vendors에
이름을 등록해 드롭다운 후보에서만 빼는 것이다. 과거 기록은 그대로 남는다.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Distribution, File, HiddenVendor
from app.utils import INTERNAL_VENDOR

router = APIRouter(prefix="/vendors", tags=["vendors"])


@router.get("", response_model=list[str])
def list_vendors(
    project_id: Optional[int] = None,
    only_outstanding: bool = False,
    db: Session = Depends(get_db),
):
    """업체명 목록. project_id를 주면 그 공사에서 쓰인 업체만.

    only_outstanding=true면 지금 미반납 상태(purpose=MODIFY, 반납 안 됨)인
    반출 건이 실제로 있는 업체만 준다 — 반입 화면에서 실제로 나가지도 않은
    공사·업체 조합을 잘못 고르는 걸 막기 위함(File 테이블은 안 봄).
    """
    hidden = {name for (name,) in db.query(HiddenVendor.name)}

    if only_outstanding:
        dist_q = db.query(Distribution.vendor).filter(
            Distribution.vendor.isnot(None),
            Distribution.purpose == "MODIFY",
            Distribution.returned_at.is_(None),
        )
        if project_id:
            dist_q = dist_q.filter(Distribution.project_id == project_id)
        names = {v for (v,) in dist_q.distinct() if v}
        names -= hidden
        return sorted(names)

    dist_q = db.query(Distribution.vendor).filter(Distribution.vendor.isnot(None))
    file_q = db.query(File.vendor_name).filter(File.vendor_name.isnot(None))

    if project_id:
        dist_q = dist_q.filter(Distribution.project_id == project_id)
        file_q = file_q.filter(File.project_id == project_id)

    names = {v for (v,) in dist_q.distinct() if v}
    names |= {v for (v,) in file_q.distinct() if v}
    names.discard(INTERNAL_VENDOR)  # 사내 통합본은 업체가 아니므로 목록에서 뺀다
    names -= hidden

    return sorted(names)


class HideVendorRequest(BaseModel):
    name: str


def vendor_in_use(db: Session, name: str) -> bool:
    """이 업체명이 반출(distributions.vendor)·리비전(files.vendor_name) 기록에 쓰였는지.
    업체 마스터 테이블이 없어 이름 문자열로 대조한다.
    (2026-10-15 CM 지시: 사용 중인 업체는 드롭다운에서 삭제(숨기기)하지 못하게 막는다.)"""
    if db.query(Distribution.id).filter(Distribution.vendor == name).first() is not None:
        return True
    if db.query(File.id).filter(File.vendor_name == name).first() is not None:
        return True
    return False


@router.post("/hide")
def hide_vendor(body: HideVendorRequest, db: Session = Depends(get_db)):
    """업체명을 드롭다운 후보에서만 뺀다(과거 반출·리비전 기록은 그대로 유지, D-6).

    사용 중인 업체(반출·리비전 기록에 걸려 있는 업체)는 삭제하지 못하게 막는다(2026-10-15 CM 지시).
    """
    if vendor_in_use(db, body.name):
        raise HTTPException(
            status_code=409,
            detail="현재 사용 중인 업체라서 목록에서 삭제할 수 없습니다.\n(반출·리비전 기록에 포함돼 있습니다)",
        )
    existing = db.query(HiddenVendor).filter_by(name=body.name).one_or_none()
    if existing is None:
        db.add(HiddenVendor(name=body.name))
        db.commit()
    return {"ok": True}


class RenameVendorRequest(BaseModel):
    old_name: str
    new_name: str


@router.patch("")
def rename_vendor(body: RenameVendorRequest, db: Session = Depends(get_db)):
    """업체명 마스터 테이블이 없으므로(D-6), 과거 반출(distributions.vendor)·리비전(files.vendor_name)
    기록에 박힌 업체명 문자열을 전부 새 이름으로 바꿔치기한다. 그래야 그 업체로 나갔던
    기록들의 표시도 자동으로 같이 바뀐다."""
    old_name = body.old_name.strip()
    new_name = body.new_name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="업체명을 입력해주세요")
    if old_name == INTERNAL_VENDOR or new_name == INTERNAL_VENDOR:
        raise HTTPException(status_code=400, detail="'사내(자체 통합)'은 업체명으로 바꿀 수 없습니다")
    if old_name == new_name:
        return {"ok": True}

    db.query(Distribution).filter(Distribution.vendor == old_name).update(
        {Distribution.vendor: new_name}, synchronize_session=False
    )
    db.query(File).filter(File.vendor_name == old_name).update(
        {File.vendor_name: new_name}, synchronize_session=False
    )
    db.query(HiddenVendor).filter(HiddenVendor.name == old_name).update(
        {HiddenVendor.name: new_name}, synchronize_session=False
    )
    db.commit()
    return {"ok": True}
