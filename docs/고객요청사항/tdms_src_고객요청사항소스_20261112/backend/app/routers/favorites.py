"""보관 목록 — 사용자마다 "미리보기에서 보관해 둔 자료"를 담아 두는 곳
(2026-09-05 CM 지시로 신설, 같은 날 CM 지시로 "즐겨찾기"에서 이 모양으로 고쳤다).

## 무엇을 보관하는가

보관하는 것은 **자료를 가리키는 바로가기 + 미리보기에서 그린 편집 내용**이지 자료의
사본이 아니다. 그래서 보관해도 자료는 하나도 변하지 않고, 지워도 자료·이력은 그대로 남는다
(그래서 이 표만은 본인이 지울 수 있다 — 원칙 1의 "삭제 기능 없음"은 자료를 지키기 위한
것이라 여기엔 해당하지 않는다).

편집 내용(도형·문구·형광펜·도장)이 있어도 **PDF를 통째로 복사하지 않는다**.
"무엇을 어디에 그렸는지"만 JSON으로 뽑아 storage/즐겨찾기/{사용자ID}/{보관ID}.json에
적어 둔다. 이유는 둘이다.
  ㉠ 자료 한 건이 몇 MB~수백 MB라, 사람마다 50벌씩 사본을 두면 디스크가 남아나지 않는다.
  ㉡ 그린 내용만 남기면 다시 열었을 때 **그리기 상태 그대로** 되살아나 옮기고 지우고 색을
     바꾸는 것까지 그대로 된다. PDF 사본으로 남기면 그림으로 굳어 이어서 손보기 어렵다.

## 보관하기 / 다른 이름으로 보관

미리보기 도구모음의 [»] 안에 두 버튼이 있다(2026-09-05 CM 지시).
  · [보관하기]          — 처음이면 새로 보관하고, 이미 보관해 둔 것이 있으면 그 자리에 덮어쓴다.
  · [다른 이름으로 보관] — 이름을 새로 적어 한 벌 더 보관한다. **처음 보관할 때는 쓸 수 없다**
                          (덮어쓸 원본이 아직 없으므로 화면에서 흐리게 막는다).
편집하지 않은 자료는 이미 보관돼 있으면 다시 보관할 수 없다 — 똑같은 것이 두 벌 생기기만
하기 때문이다(중복 보관 금지, CM 지시). 그 판단은 화면(뷰어)이 하고, 여기서는 개수 상한만 지킨다.

## 이름

[보관하기]는 언제나 자료명 그대로 보관한다 — 편집 내용이 있어도 뒤에 아무것도 붙이지 않는다
(2026-09-05 CM 지시. 미리보기에서 [다운로드]할 때 파일 이름에 붙는 "(Markup)"과는 다른 이야기다).
이름은 화면이 만들어 보내고, [다른 이름으로 보관]은 사용자가 적은 이름을 그대로 쓴다.

보관할 때의 **자료명**은 source_name에 따로 적어 둔다. 목록의 "상태" 칸이 그 값과 지금
자료명을 견주어 "이름 바뀜"을 알려주기 때문이다(보관 이름만으로는 알 수 없다 — 사용자가
직접 적었을 수도, 옛 보관분에는 "(Markup)"이 붙어 있을 수도 있다).

## 상태 — 삭제됐거나 이름이 바뀌었을 때만 알린다

CM 지시: **완전히 삭제되거나 이름이 바뀌지 않았다면 그대로 보여준다.** 그래서 리비전이
올라가 PDF가 바뀐 것 정도로는 아무 표시도 하지 않는다. 폐기 보관함에 들어간 자료도 그대로
열리므로(D-62 ⑦) 정상으로 본다. 표시가 붙는 것은 둘뿐이다.
  · 삭제됨   — 자료가 아예 없어졌거나(완전 삭제) 삭제 보관함에 들어가 열 수 없는 상태
  · 이름 바뀜 — 자료는 그대로 있는데 자료명이 보관할 때와 달라진 상태(열리기는 그대로 열린다)

## 권한

로그인만 하면 누구나 자기 것을 보관하고 볼 수 있다(권한 트리에 넣지 않는다 — 트리에 없는 것은
다 같이 쓰는 기능이라는 D-29 방침 그대로). 남의 보관 목록은 어떤 방법으로도 보이지 않는다.
"""

import json
from io import BytesIO
from pathlib import Path
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import mdb_group, storage
from app.auth import current_user
from app.config import STORAGE_ROOT
from app.database import get_db
from app.models import AuditLog, Document, File, MdbFile, User, UserFavorite
from app.retire import MDB_RETIRE_KIND, TDB_RETIRE_KIND, is_retired_row
from app.rev_naming import document_display_name, strip_rev_tail
from app.utils import build_export_filename, content_disposition_header, neutralize_formulas

router = APIRouter(prefix="/favorites", tags=["favorites"])

SCREEN = "저장 목록"

# 화면에 실제로 보이는 팝업 제목 (2026-09-05 CM 지시로 "저장 목록" → "사용자 저장 목록",
# 2026-09-07 CM 지시로 "저장"이라는 말을 "보관"으로 바꿔 "사용자 보관 목록"이 됐다).
# 엑셀 파일명·시트 이름이 이 값을 그대로 따라간다(제목이 바뀌면 파일명도 따라간다는 공통 규칙).
# 위 SCREEN은 시스템 로그의 화면 이름이라 "저장 목록" 그대로 둔다 — 로그에 이미 쌓여 있는
# 옛 기록이 그 이름으로 남아 있어, 여기만 바꾸면 같은 화면이 두 이름으로 갈린다.
LIST_POPUP_TITLE = "사용자 보관 목록"

# 한 사람이 보관해 둘 수 있는 개수. CM이 "총 50개, 수량은 나중에 필요시 수정하겠다"고 해서
# 고칠 곳이 여기 한 줄뿐이도록 상수로 둔다(화면은 서버가 내려주는 값을 그대로 보여준다).
FAVORITE_LIMIT = 50

# 편집 내용(마크업) JSON 한 건의 크기 상한. 도장을 여러 개 찍으면 그림이 통째로 담겨 커질 수
# 있어서 선을 그어 둔다 — 넘으면 보관하지 않고 이유를 알려준다(조용히 잘리면 다시 열었을 때
# 편집 내용이 일부만 살아나 더 헷갈린다).
MAX_MARKUP_BYTES = 8 * 1024 * 1024


class SaveFavoriteRequest(BaseModel):
    kind: str                                  # TDB / MDB
    document_id: Optional[int] = None          # kind=TDB
    mdb_file_id: Optional[int] = None          # kind=MDB
    name: str                                  # 보관 이름(자료명 그대로 또는 사용자가 적은 이름)
    source_name: Optional[str] = None          # 보관할 때의 자료명 — "이름 바뀜" 판단에 쓴다
    description: Optional[str] = None
    pdf_file_id: Optional[int] = None          # 편집 내용을 그릴 때 보고 있던 PDF
    markup: Optional[list] = None              # 그린 편집 내용(사본). 없으면 자료 바로가기만 보관한다
    original_markup: Optional[list] = None     # 원본 미리보기(DWG 등)에 그린 편집 내용(D-102)
    overwrite_id: Optional[int] = None         # 이 보관 자리를 덮어쓴다(없으면 새로 보관한다)
    view_mode: Optional[str] = None            # "original"이면 원본 미리보기를 보다가 보관한 것(D-102)


class FavoriteNoteRequest(BaseModel):
    """설명만 고친다 — 다른 화면의 "비고" 칸과 주소·형식을 똑같이 맞춘다.

    그래야 목록 표의 설명 칸에 ui.js의 공용 비고 편집(연필 → [확인])을 그대로 쓸 수 있고,
    비고 칸이 화면마다 다르게 동작하는 일이 없다.
    """

    note: Optional[str] = None


class DeleteFavoritesRequest(BaseModel):
    """[선택 삭제] — 표에서 체크한 것을 한 번에 지운다(삭제 보관함의 [선택 완전 삭제]와 같은 방식)."""

    ids: list[int]


class FavoriteItem(BaseModel):
    id: int
    kind: str
    name: str
    description: Optional[str] = None
    has_markup: bool
    document_id: Optional[int] = None
    mdb_file_id: Optional[int] = None
    # 지금 그 자료가 실제로 어떤 상태인지 — 보관한 뒤에 자료명이 바뀌거나 삭제됐을 수 있어,
    # 목록을 그릴 때마다 다시 읽어 보여준다.
    current_name: Optional[str] = None
    path: Optional[str] = None
    pdf_file_id: Optional[int] = None          # 지금 열면 보게 될 PDF (미리보기 아이콘용)
    missing: bool = False                      # 삭제됨 — 완전 삭제됐거나 삭제 보관함에 들어감
    renamed: bool = False                      # 이름 바뀜 — 자료는 있는데 자료명이 달라짐
    view_mode: Optional[str] = None            # 다시 열 때 원본(original)·사본(비어 있음) 어느 쪽으로 열지
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# 자료 읽어오기 — TDB와 MDB가 표가 달라 여기서 한 번에 흡수한다
# ---------------------------------------------------------------------------

def _tdb_view(db: Session, document_id: Optional[int]) -> dict:
    """TDB 자료 한 건의 지금 상태.

    없어졌거나 삭제 보관함에 들어갔으면 missing. **폐기 보관함에 들어간 것은 정상으로 본다** —
    폐기 자료도 상세보기·미리보기·다운로드가 열리기 때문이다(D-62 ⑦).
    """
    if not document_id:
        return {"missing": True}
    doc = db.get(Document, document_id)
    if doc is None:
        return {"missing": True}
    if doc.is_archived and not is_retired_row(db, doc.archive_batch_id, TDB_RETIRE_KIND):
        return {"missing": True}
    pdf = (
        db.query(File)
        .filter(File.document_id == doc.id, File.is_current.is_(True), File.file_ext == "pdf")
        .first()
    )
    return {
        "missing": False,
        "current_name": document_display_name(doc),
        "path": doc.source_path,
        "pdf_file_id": pdf.id if pdf else None,
    }


def _mdb_view(db: Session, mdb_file_id: Optional[int]) -> dict:
    """MDB 자료 한 건의 지금 상태. 자료는 파일 여러 개가 묶인 것이라 그 묶음을 읽는다.

    폐기 자료까지 열어주는 판단은 mdb.py의 visible_group과 같은 규칙이다(그 함수를 여기서
    부르면 화면 라우터끼리 서로 물게 되므로 같은 두 줄을 여기 적었다).
    """
    if not mdb_file_id:
        return {"missing": True}
    group = mdb_group.group_of(db, mdb_file_id)
    if group is None:
        archived = mdb_group.group_of(db, mdb_file_id, include_archived=True)
        if archived is None or not is_retired_row(db, archived.rep.archive_batch_id, MDB_RETIRE_KIND):
            return {"missing": True}
        group = archived
    return {
        "missing": False,
        "current_name": group.name,
        "path": group.folder,
        # MDB 미리보기는 자료의 대표 id로 열면 서버가 그 자료의 PDF를 찾아 준다(mdb.py).
        "pdf_file_id": group.id if group.has_pdf else None,
    }


def _view(db: Session, fav: UserFavorite) -> dict:
    return _tdb_view(db, fav.document_id) if fav.kind == "TDB" else _mdb_view(db, fav.mdb_file_id)


def _name_key(kind: str, name: str) -> str:
    """"이름 바뀜"을 견줄 때 쓰는 이름. TDB 자료명 끝의 리비전 꼬리(`_Rev01`)는 떼고 견준다 —
    리비전이 오른 것만으로는 아무 표시도 하지 않는다(D-89 ⑥). 꼬리가 생기기 전에 보관한 것은
    꼬리 없는 도면번호가 적혀 있어 그대로 견주면 된다(rev_naming, 2026-10-01)."""
    return strip_rev_tail(name) if kind == "TDB" else name


def to_item(db: Session, fav: UserFavorite) -> FavoriteItem:
    view = _view(db, fav)
    current_name = view.get("current_name")
    return FavoriteItem(
        id=fav.id, kind=fav.kind, name=fav.name, description=fav.description,
        has_markup=fav.has_markup, document_id=fav.document_id, mdb_file_id=fav.mdb_file_id,
        current_name=current_name, path=view.get("path"),
        pdf_file_id=view.get("pdf_file_id"), missing=view.get("missing", False),
        # 보관할 때의 자료명과 지금 자료명이 다르면 알려준다. 옛 보관분에 source_name이
        # 없으면(그 값이 생기기 전에 보관한 것) 견줄 것이 없으므로 알리지 않는다.
        renamed=bool(
            not view.get("missing") and fav.source_name and current_name
            and _name_key(fav.kind, fav.source_name) != _name_key(fav.kind, current_name)
        ),
        view_mode=fav.view_mode,
        created_at=fav.created_at.isoformat() if fav.created_at else None,
        updated_at=fav.updated_at.isoformat() if fav.updated_at else None,
    )


def load_my(db: Session, user: User) -> list[UserFavorite]:
    """내 보관 목록 전부 — 최근에 보관한 것이 위로."""
    return (
        db.query(UserFavorite)
        .filter(UserFavorite.user_id == user.id)
        .order_by(UserFavorite.updated_at.desc(), UserFavorite.id.desc())
        .all()
    )


def owned(db: Session, favorite_id: int, user: User) -> UserFavorite:
    """내 보관 1건. 남의 것은 있는지조차 알려주지 않는다(똑같이 404)."""
    fav = db.get(UserFavorite, favorite_id)
    if fav is None or fav.user_id != user.id:
        raise HTTPException(status_code=404, detail="보관한 자료를 찾을 수 없습니다")
    return fav


# ---------------------------------------------------------------------------
# 조회
# ---------------------------------------------------------------------------

@router.get("/summary")
def summary(db: Session = Depends(get_db), user: User = Depends(current_user)):
    """상단 [보관 목록] 버튼에 보이는 건수. 목록 전체를 받지 않도록 따로 둔다(D-38 ㉡와 같은 이유)."""
    count = db.query(UserFavorite).filter(UserFavorite.user_id == user.id).count()
    return {"count": count, "limit": FAVORITE_LIMIT}


@router.get("", response_model=list[FavoriteItem])
def list_favorites(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return [to_item(db, f) for f in load_my(db, user)]


def _slot_row(db: Session, fav: UserFavorite, target: dict) -> dict:
    """보관 팝업 "보관 위치" 표의 한 줄.

    목록 팝업의 표와 같은 뜻의 값만 담는다(자료명·설명·구분·편집·보관 일시) —
    두 표가 다른 것을 보여주면 어느 쪽을 믿어야 할지 알 수 없기 때문이다.
    """
    view = _view(db, fav)
    same = (
        fav.document_id == target["document_id"] if target["kind"] == "TDB"
        else fav.mdb_file_id == target["mdb_file_id"]
    )
    return {
        "id": fav.id,
        "name": fav.name,
        "kind": fav.kind,
        "has_markup": fav.has_markup,
        "description": fav.description,
        "target_name": view.get("current_name"),
        "missing": view.get("missing", False),
        "updated_at": fav.updated_at.isoformat() if fav.updated_at else None,
        # 자료명 왼쪽 돋보기(미리보기)에 쓰는 값 — 목록 팝업 표와 같다(2026-09-05 CM 지시).
        "pdf_file_id": view.get("pdf_file_id"),
        "path": view.get("path"),
        "document_id": fav.document_id,
        "mdb_file_id": fav.mdb_file_id,
        "view_mode": fav.view_mode,
        # 지금 보고 있는 자료를 가리키는 보관인지 — 화면이 "이 자료" 배지를 붙인다.
        "same": bool(same),
    }


@router.get("/resolve/target")
def resolve_target(
    kind: str,
    pdf_file_id: Optional[int] = None,
    original_file_id: Optional[int] = None,
    db: Session = Depends(get_db), user: User = Depends(current_user),
):
    """미리보기(뷰어)가 "지금 보고 있는 것이 어느 자료이고 이미 보관돼 있는지" 물어보는 자리.

    뷰어가 들고 있는 것은 PDF 파일 번호뿐이라(주소의 file= 값) 그것만으로 자료를 찾아 준다.
    화면이 실어 둔 값은 표마다 뜻이 제각각이라(반출이력은 반출 번호, 목록은 자료 번호…)
    믿을 수 없다 — 잘못 알아보면 **엉뚱한 자료가 보관된다**.

    함께 내려주는 saved는 그 자료를 이 사람이 이미 보관해 둔 것들이다. 뷰어는 이 값으로
    [보관하기]·[다른 이름으로 보관] 두 버튼을 켜고 끈다(처음 보관이면 다른 이름으로 보관은 잠긴다).

    원본 미리보기(DWG·엑셀 등, D-102)를 보는 중이면 original_file_id로 묻는다 — 그 원본이
    속한 자료를 찾아 같은 값을 돌려준다. 이때 pdf_file_id는 그 자료의 지금 사본(PDF)이다
    (편집 내용은 사본에 그린 것이므로).
    """
    kind = (kind or "").upper()
    if pdf_file_id is None and original_file_id is None:
        raise HTTPException(status_code=400, detail="어느 파일인지 알 수 없습니다")
    if kind == "TDB" and pdf_file_id is None:
        orig = db.get(File, original_file_id)
        if orig is None or not orig.is_current:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        view = _tdb_view(db, orig.document_id)
        if view.get("missing"):
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        target = {"kind": "TDB", "document_id": orig.document_id, "mdb_file_id": None,
                  "name": view["current_name"], "pdf_file_id": view.get("pdf_file_id")}
        return _with_saved(db, user, target)
    if kind == "MDB" and pdf_file_id is None:
        pdf_file_id = original_file_id  # MDB는 자료에 속한 아무 파일 번호로 자료를 찾는다
    if kind == "TDB":
        row = db.get(File, pdf_file_id)
        # 아직 승인 전인 파일(검수대기 [비교]의 오른쪽 화면 등)은 보관 대상이 아니다 — 그 파일은
        # 반려되면 없어지고, 지금 자료가 가리키는 PDF도 아니어서 나중에 다시 열면 편집 내용이
        # 엉뚱한 자리에 얹힌다. 확인필요 미리보기(/import-issues/…)는 주소 모양이 달라 여기까지
        # 오지도 않는다(D-88 ⑫와 같은 방침).
        if row is None or not row.is_current:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        view = _tdb_view(db, row.document_id)
        if view.get("missing"):
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        target = {"kind": "TDB", "document_id": row.document_id, "mdb_file_id": None,
                  "name": view["current_name"], "pdf_file_id": pdf_file_id}
    elif kind == "MDB":
        group = mdb_group.group_of(db, pdf_file_id)
        if group is None:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다")
        # 자료를 가리키는 번호는 언제나 대표 파일의 번호다(원본·사본 어느 쪽을 보고 있든 같은 자료).
        target = {"kind": "MDB", "document_id": None, "mdb_file_id": group.id,
                  "name": group.name, "pdf_file_id": group.id if group.has_pdf else None}
    else:
        raise HTTPException(status_code=400, detail="보관할 자료의 종류를 알 수 없습니다")
    return _with_saved(db, user, target)


def _with_saved(db: Session, user: User, target: dict) -> dict:
    # 보관 위치 표에는 **보관해 둔 것 전부**를 담는다(2026-09-05 CM 지시).
    # 지금 보고 있는 자료 것만 보여주면 50자리 가운데 무엇이 자리를 차지하고 있는지 알 수 없어,
    # 덮어쓸지 새로 보관할지 판단할 수도 없고 필요 없는 것을 지울 수도 없다.
    rows = [_slot_row(db, f, target) for f in load_my(db, user)]
    target["all_saved"] = rows
    # 이 자료를 이미 보관해 둔 것 — 뷰어가 [보관하기]·[다른 이름으로 보관] 두 버튼을 켜고 끄는
    # 데 쓴다(위 표와 같은 값에서 골라내므로 둘이 어긋날 자리가 없다).
    target["saved"] = [r for r in rows if r["same"]]
    target["used"] = len(rows)
    target["limit"] = FAVORITE_LIMIT
    return target


@router.get("/{favorite_id}", response_model=FavoriteItem)
def get_favorite(favorite_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return to_item(db, owned(db, favorite_id, user))


@router.get("/{favorite_id}/markup")
def get_markup(favorite_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """보관해 둔 편집 내용. 미리보기가 자료를 연 뒤 이걸 받아 그대로 되살린다.

    markup은 사본(PDF)에 그린 것, original_markup은 원본 미리보기(DWG 등)에 그린 것이다(D-102).
    파일에는 옛 보관분처럼 목록 하나(= 사본 것)로 들어 있거나, 원본 것이 있으면
    {"pdf": [...], "original": [...]}로 들어 있다.
    """
    empty = {"markup": [], "original_markup": []}
    fav = owned(db, favorite_id, user)
    if not fav.has_markup or not fav.markup_path:
        return empty
    path = Path(STORAGE_ROOT) / fav.markup_path
    if not path.is_file():
        # 파일이 없어졌으면 편집 내용만 없는 것으로 보고 자료는 그대로 열어준다(에러로 막지 않는다).
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty
    if isinstance(data, dict):
        return {"markup": data.get("pdf") or [], "original_markup": data.get("original") or []}
    return {"markup": data, "original_markup": []}


# ---------------------------------------------------------------------------
# 보관 · 고치기 · 지우기
# ---------------------------------------------------------------------------

def _write_markup(fav: UserFavorite, markup: Optional[list], original_markup: Optional[list] = None) -> None:
    """편집 내용을 파일로 남긴다. 둘 다 비어 있으면 보관해 뒀던 것을 지운다(바로가기만 남음).

    원본 미리보기에 그린 것이 없으면 옛 모양(사본 목록 하나) 그대로 적는다 — 옛 보관분과 같은
    모양이라 읽는 쪽(get_markup)이 두 모양을 다 받는다.
    """
    path = storage.favorite_markup_path(fav.user_id, fav.id)
    if not markup and not original_markup:
        fav.has_markup = False
        fav.markup_path = None
        if path.is_file():
            path.unlink()
        return
    content = {"pdf": markup or [], "original": original_markup} if original_markup else markup
    text = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > MAX_MARKUP_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"편집 내용이 너무 많아 보관할 수 없습니다(최대 {MAX_MARKUP_BYTES // (1024 * 1024)}MB). "
                   "표시를 줄이거나, 미리보기에서 [다운로드]로 받아 두세요.",
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    fav.has_markup = True
    fav.markup_path = storage.to_relative(path)


@router.post("", response_model=FavoriteItem)
def save_favorite(
    body: SaveFavoriteRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    """보관한다. overwrite_id를 주면 그 자리를 덮어쓰고, 없으면 새로 보관한다."""
    kind = (body.kind or "").upper()
    if kind not in ("TDB", "MDB"):
        raise HTTPException(status_code=400, detail="보관할 자료의 종류를 알 수 없습니다")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="보관 이름이 비어 있습니다")

    # 가리키는 자료가 실제로 있는지 확인한다(없어진 자료를 보관해 두면 열 수 없다).
    view = _tdb_view(db, body.document_id) if kind == "TDB" else _mdb_view(db, body.mdb_file_id)
    if view.get("missing"):
        raise HTTPException(status_code=404, detail="보관하려는 자료를 찾을 수 없습니다")

    if body.overwrite_id:
        fav = owned(db, body.overwrite_id, user)
    else:
        count = db.query(UserFavorite).filter(UserFavorite.user_id == user.id).count()
        if count >= FAVORITE_LIMIT:
            raise HTTPException(
                status_code=400,
                detail=f"보관은 {FAVORITE_LIMIT}개까지 할 수 있습니다(지금 {count}개). "
                       "목록에서 쓰지 않는 것을 지우거나, 덮어쓸 자리를 골라 주세요.",
            )
        fav = UserFavorite(user_id=user.id, kind=kind, name=name)
        db.add(fav)
        db.flush()  # markup 파일 이름에 쓸 id를 여기서 받는다

    fav.kind = kind
    fav.document_id = body.document_id if kind == "TDB" else None
    fav.mdb_file_id = body.mdb_file_id if kind == "MDB" else None
    fav.name = name
    # 보관할 때의 자료명. 화면이 안 보내면 지금 자료명을 그대로 적어 둔다(견줄 값이 있어야
    # 나중에 "이름 바뀜"을 알릴 수 있다).
    fav.source_name = (body.source_name or "").strip() or view.get("current_name")
    fav.description = (body.description or "").strip() or None
    fav.pdf_file_id = body.pdf_file_id
    fav.view_mode = "original" if body.view_mode == "original" else None
    _write_markup(fav, body.markup, body.original_markup)

    db.add(AuditLog(
        user_id=user.id, action="FAVORITE_SAVE", screen=SCREEN,
        document_id=fav.document_id,
        detail={"favorite_id": fav.id, "kind": kind, "name": name,
                "has_markup": fav.has_markup, "overwrite": bool(body.overwrite_id)},
    ))
    db.commit()
    db.refresh(fav)
    return to_item(db, fav)


@router.post("/{favorite_id}/note")
def update_favorite_note(
    favorite_id: int, body: FavoriteNoteRequest,
    db: Session = Depends(get_db), user: User = Depends(current_user),
):
    """설명만 고친다. 이름은 보관할 때의 이름 그대로 두고 고치지 않는다(CM 확정).

    주소와 형식이 다른 화면의 "비고" 칸(POST …/note, {note: …})과 같아서, 목록 표가
    ui.js의 공용 비고 편집을 그대로 쓴다. 남의 것은 owned()에서 막힌다.
    """
    fav = owned(db, favorite_id, user)
    fav.description = (body.note or "").strip() or None
    db.commit()
    return {"status": "ok"}


def _purge(db: Session, fav: UserFavorite, user: User) -> None:
    """보관 1건과 그것이 남긴 편집 내용 파일을 실제로 지운다(자료는 건드리지 않는다)."""
    if fav.markup_path:
        path = Path(STORAGE_ROOT) / fav.markup_path
        if path.is_file():
            path.unlink()
        storage.prune_empty_dirs(path.parent)

    db.add(AuditLog(
        user_id=user.id, action="FAVORITE_DELETE", screen=SCREEN, document_id=fav.document_id,
        detail={"favorite_id": fav.id, "kind": fav.kind, "name": fav.name},
    ))
    db.delete(fav)


@router.post("/delete")
def delete_favorites(
    body: DeleteFavoritesRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    """표에서 체크한 것을 한 번에 지운다 — **자기 것만**.

    이 시스템에서 진짜로 지우는 몇 안 되는 자리다. 지우는 것은 자료가 아니라 개인 바로가기고,
    자료·파일·이력은 하나도 건드리지 않는다(원칙 1은 자료를 지키기 위한 것이라 해당하지 않는다).
    50개까지만 보관할 수 있으므로 지울 수 없으면 정리할 방법이 없어진다.
    """
    if not body.ids:
        raise HTTPException(status_code=400, detail="지울 항목을 하나 이상 선택하세요")
    for favorite_id in body.ids:
        _purge(db, owned(db, favorite_id, user), user)
    db.commit()
    return {"status": "ok", "deleted": len(body.ids)}


@router.delete("/{favorite_id}")
def delete_favorite(favorite_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """보관 1건 지우기 — 위 [선택 삭제]의 한 건짜리. 규칙은 똑같다."""
    _purge(db, owned(db, favorite_id, user), user)
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# 엑셀 내보내기 — 팝업 표와 같은 칸 구성 (공통 규칙)
# ---------------------------------------------------------------------------

def state_label(item: FavoriteItem) -> str:
    """목록 "상태" 칸과 같은 글자 — 표와 엑셀이 어긋나지 않게 한 곳에서 만든다."""
    if item.missing:
        return "삭제됨"
    if item.renamed:
        return "이름 바뀜"
    return "정상"


@router.get("/list/export")
def export_favorites(
    title: Optional[str] = None,
    columns: str = "list",
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """지금 보이는 목록 그대로. 표에서 행 번호·체크칸만 빼고 칸 구성이 같다.

    주소가 /favorites/export가 아닌 것은 그 자리를 /favorites/{favorite_id}가 이미
    쓰고 있어서다(그대로 두면 "export"를 보관 번호로 읽으려다 실패한다).

    title은 그 버튼이 달린 팝업의 제목이다(목록 팝업 "사용자 보관 목록", 보관 팝업
    "사용자 보관"). 화면에 보이는 제목을 그대로 받아 파일명·시트 이름에 쓰므로, 나중에
    제목 문구가 바뀌면 파일명도 저절로 따라간다(엑셀 내보내기 공통 규칙).

    columns는 어느 표에서 눌렀는지다 — 표마다 칸 구성이 달라야 하므로 나눠 만든다
    (엑셀 칸 = 그 표의 칸, 공통 규칙).
      · list — 목록 팝업의 표
      · slot — 보관 팝업 "보관 위치"의 표(선택·No·조치 칸은 버튼·순번 칸이라 빼고 나머지 그대로)
    """
    items = [to_item(db, f) for f in load_my(db, user)]
    popup_title = (title or "").strip() or LIST_POPUP_TITLE
    slot_view = columns == "slot"

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = popup_title[:31]   # 엑셀 시트 이름은 31자까지
    if slot_view:
        # 2026-09-05 CM 지시로 "보관 이름" 칸을 없애고 "자료" → "자료명"으로 고쳤다(표와 같은 구성).
        ws.append(["자료명", "설명", "구분", "편집", "보관 일시"])
        widths = [34, 46, 8, 8, 18]
        for it in items:
            ws.append([
                it.current_name if not it.missing else "(삭제됨)", it.description,
                it.kind, "있음" if it.has_markup else "",
                (it.created_at or "").replace("T", " ")[:16],
            ])
    else:
        ws.append(["자료명", "설명", "구분", "편집", "경로", "상태", "현재 자료명", "보관 일시"])
        widths = [34, 46, 8, 8, 52, 12, 30, 18]
        for it in items:
            ws.append([
                it.name, it.description, it.kind, "있음" if it.has_markup else "",
                it.path, state_label(it), it.current_name,
                (it.created_at or "").replace("T", " ")[:16],
            ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    # 이 기능은 화면(페이지)이 따로 없고 상단 버튼에 달린 팝업 하나가 곧 화면이라,
    # 팝업 제목 하나만 쓴다("보관 목록_사용자 보관 목록_…"처럼 두 번 적히지 않게).
    filename = build_export_filename(popup_title)

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen=SCREEN,
        detail={"kind": popup_title, "count": len(items)},
    ))
    db.commit()

    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )
