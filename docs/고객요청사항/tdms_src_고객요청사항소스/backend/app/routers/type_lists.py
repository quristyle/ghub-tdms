"""드롭다운에서 고를 수 있는 "값 목록" 세 가지 — 설비유형(equipment_types)·
자료유형(mdb_doc_types)·Tag No 변경사유(mdb_tag_change_reasons) — 의 조회·추가·이름변경·
숨기기·삭제.

둘은 화면 모양(드롭다운 + 옆의 ✎ 목록 편집 팝업)도 규칙도 완전히 같아서, 같은 코드를 두 벌
두면 한쪽만 고쳐지고 어긋나기 쉽다. 그래서 아래 make_type_router()로 한 번만 만들고 대상
테이블·컬럼·화면 이름만 바꿔 끼운다 (2026-08-28 CM 확정으로 자료유형이 생기면서 정리).

주의: mdb_files의 값은 이 표를 가리키는 외래키가 아니라 **이름 문자열을 그대로 들고 있다**
(공사·업체와 다르다). 그래서
  · 이름을 바꾸면 이미 그 유형으로 지정된 자료들의 표시도 함께 바뀌어야 한다 → 아래에서 직접 갱신
  · 목록에서 지워도(D-31 예외) 이미 지정된 자료의 값은 그대로 남고, 새로 고를 후보에서만 빠진다
값은 슬래시로 여러 개를 이어 붙일 수 있으므로("Pump/Strainer"), 이름 변경은 그 조각만
갈아끼우고(mdb_types.rename_type) 이름 자체에는 슬래시를 못 쓰게 막는다.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.mdb_types import SEPARATOR, rename_type
from app.models import EquipmentType, MdbDocType, MdbFile, MdbTagChangeReason
from app.schemas import EquipmentTypeCreate, EquipmentTypeItem, EquipmentTypeRename


def make_type_router(*, model, value_column=None, sort_value: bool = False, prefix: str, tag: str, label: str) -> APIRouter:
    """값 목록 하나에 대한 API 묶음을 만든다.

    model        : 목록을 담는 테이블 모델 (EquipmentType / MdbDocType / MdbTagChangeReason)
    value_column : 자료 쪽에서 이 값을 들고 있는 컬럼 (MdbFile.equipment_type / MdbFile.doc_type).
                   None이면 자료가 이 값을 들고 있지 않다는 뜻이라 이름을 바꿔도 자료는 손대지
                   않는다 — Tag No 변경사유가 그런 경우다(이미 자료 Note에 적혀 나간 문장은
                   그때의 기록이라 나중에 바꾸면 안 된다).
    sort_value   : 이름을 바꿔 자료의 값을 갈아끼울 때 알파벳순으로 다시 정렬할지
                   (2026-08-31 CM 확정, 자료유형만 True — mdb_types.join_types 참고).
    prefix       : 주소 앞머리 ("/equipment-types" 등)
    label        : 오류 문구에 쓸 화면 이름 ("설비유형" / "자료유형" / "사유")
    """
    router = APIRouter(prefix=prefix, tags=[tag])

    def find_duplicate(db: Session, name: str, exclude_id: int | None = None):
        """projects.py의 공사명 중복 검사와 같은 규칙 — 대소문자·공백 차이만으로 다른 값이 되지
        않게, 숨김 여부와 무관하게 전부 대상으로 검사한다."""
        query = db.query(model).filter(func.lower(model.name) == name.lower())
        if exclude_id is not None:
            query = query.filter(model.id != exclude_id)
        return query.first()

    def clean_name(raw: str) -> str:
        """입력한 이름을 검사해서 저장할 모양으로. 슬래시는 여러 유형을 이어 붙일 때 쓰는
        구분자라(mdb_types.py) 이름 안에 들어가면 두 개로 쪼개져 보이므로 막는다."""
        name = (raw or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail=f"{label}명을 입력해주세요")
        if SEPARATOR in name:
            raise HTTPException(
                status_code=400,
                detail=f"{label}명에는 '{SEPARATOR}'를 쓸 수 없습니다 (여러 {label}을 구분하는 기호입니다)",
            )
        return name

    def get_or_404(db: Session, type_id: int):
        item = db.get(model, type_id)
        if item is None:
            raise HTTPException(status_code=404, detail=f"존재하지 않는 {label}입니다")
        return item

    @router.get("", response_model=list[EquipmentTypeItem])
    def list_types(include_hidden: bool = False, db: Session = Depends(get_db)):
        """드롭다운에서는 숨긴 항목을 뺀 목록만 쓰고, 목록 편집 팝업에서는 include_hidden=true로
        숨긴 것까지 받아 흐리게 보여주고 복구할 수 있게 한다."""
        query = db.query(model)
        if not include_hidden:
            query = query.filter(model.is_hidden.is_(False))
        return query.order_by(model.name).all()

    @router.post("", response_model=EquipmentTypeItem)
    def create_type(body: EquipmentTypeCreate, db: Session = Depends(get_db)):
        name = clean_name(body.name)
        duplicate = find_duplicate(db, name)
        if duplicate:
            raise HTTPException(status_code=409, detail=f"이미 등록된 {label}입니다: {duplicate.name}")

        item = model(name=name)
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    @router.patch("/{type_id}", response_model=EquipmentTypeItem)
    def rename(type_id: int, body: EquipmentTypeRename, db: Session = Depends(get_db)):
        """이름을 바꾼다. 자료 쪽은 이 표를 가리키는 외래키가 아니라 이름 문자열을 들고 있으므로,
        이미 이 유형으로 지정된 자료들의 값도 여기서 함께 갈아끼운다.

        값이 "Pump/Strainer"처럼 여러 개일 수 있어 통째로 비교하면 안 되고, 그 안의 조각
        하나만 바꿔야 한다(mdb_types.rename_type). 자료가 1,200건대라 전부 읽어 고쳐도 금방이다.
        """
        item = get_or_404(db, type_id)
        name = clean_name(body.name)
        duplicate = find_duplicate(db, name, exclude_id=type_id)
        if duplicate:
            raise HTTPException(status_code=409, detail=f"이미 등록된 {label}입니다: {duplicate.name}")

        old_name = item.name
        if value_column is not None:
            for row in db.query(MdbFile).filter(value_column.isnot(None)).all():
                new_value, changed = rename_type(getattr(row, value_column.key), old_name, name, sort=sort_value)
                if changed:
                    setattr(row, value_column.key, new_value)
        item.name = name
        db.commit()
        db.refresh(item)
        return item

    @router.post("/{type_id}/hide")
    def hide(type_id: int, db: Session = Depends(get_db)):
        """드롭다운에서만 안 보이게 한다. 실제 행은 지우지 않는다(이미 쓰인 자료의 값은 그대로)."""
        item = get_or_404(db, type_id)
        item.is_hidden = True
        db.commit()
        return {"ok": True}

    @router.post("/{type_id}/unhide")
    def unhide(type_id: int, db: Session = Depends(get_db)):
        """숨긴 항목을 다시 드롭다운에 보이게 한다."""
        item = get_or_404(db, type_id)
        item.is_hidden = False
        db.commit()
        return {"ok": True}

    @router.delete("/{type_id}")
    def delete(type_id: int, db: Session = Depends(get_db)):
        """목록에서 완전히 지운다(원칙 1의 예외 — D-31). 자료 쪽은 이름 문자열을 그대로 들고
        있으므로, 목록에서 지워도 이미 이 유형으로 지정된 자료들의 값은 그대로 남는다 —
        새로 고를 수 있는 후보에서만 빠질 뿐이다."""
        item = get_or_404(db, type_id)
        db.delete(item)
        db.commit()
        return {"ok": True}

    return router


# 설비유형 — 예전 routers/equipment_types.py가 하던 일. 주소(/equipment-types)는 그대로다.
equipment_types_router = make_type_router(
    model=EquipmentType, value_column=MdbFile.equipment_type,
    prefix="/equipment-types", tag="equipment-types", label="설비유형",
)

# 자료유형 — 2026-08-28 신설. 주소가 TDB의 도면종류(documents.doc_type)와 헷갈리지 않도록
# MDB 것임을 앞에 붙여 /mdb-doc-types로 둔다.
doc_types_router = make_type_router(
    model=MdbDocType, value_column=MdbFile.doc_type, sort_value=True,
    prefix="/mdb-doc-types", tag="mdb-doc-types", label="자료유형",
)

# Tag No 변경사유 — 2026-08-30 신설. MDB 관리 "Tag No 이력관리"에서 Note 문구에 넣을 사유를 고르는
# 목록이다. 위 둘과 달리 자료(mdb_files)가 이 값을 들고 있지 않다(자료에는 완성된 Note 문장이
# 통째로 적혀 나간다). 그래서 value_column이 없고, 이름을 바꿔도 이미 나간 Note 문장은
# 그대로 둔다 — 그 문장은 "그때 그렇게 기록했다"는 이력 자체이기 때문이다.
tag_change_reasons_router = make_type_router(
    model=MdbTagChangeReason, prefix="/mdb-tag-reasons",
    tag="mdb-tag-reasons", label="사유",
)
