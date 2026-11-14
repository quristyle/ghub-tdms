"""대기함 — TDB 조회의 반출대기함과 MDB 조회의 다운대기함을 사람마다 서버에 둔다 (D-112).

## 왜 서버에 두는가

예전에는 담은 목록을 브라우저 탭 안(sessionStorage)에만 기억했다. 그래서 탭을 닫으면 사라지고,
로그아웃해도 남아 같은 PC에서 다음 사람이 로그인하면 앞사람이 담은 것이 그대로 보였다.
2026-10-14 CM 지시로 **로그인한 사람마다 서버(user_cart_items)에** 둔다. PC를 바꾸든 탭을
닫든 같은 사람이 로그인하면 그대로 보이고, 남의 대기함은 어떤 방법으로도 보이지 않는다.

저장하는 것은 대기함에 **실제로 담긴 것만**이다. 목록 표에서 체크만 해 둔 것은 지금처럼
그 탭 안에서만 기억한다(CM 확정). 담는 개수에 한도는 없다.

## 담은 뒤 자료가 삭제·폐기되면

목록에서 빼지 않고 그대로 두되 `상태` 칸에 알린다(CM 확정). 상태는 저장해 두지 않고 볼 때마다
자료를 읽어 정한다 — 저장해 두면 자료가 지워지거나 되살아날 때마다 같이 고쳐 줘야 해서 어긋난다.
  · 정상   — 지금 반출·다운로드할 수 있다
  · 삭제됨 — 삭제 보관함에 들어갔거나 [완전 삭제]로 아예 없어졌다
  · 폐기됨 — 폐기 보관함에 들어갔다(이력으로 열어 볼 수는 있다 — D-62)
삭제됨·폐기됨인 자료는 **반출·다운로드하지 않는다.** 화면이 먼저 막고, 반출(POST /distributions)과
MDB zip 다운로드(GET /mdb/download-zip) 서버도 한 번 더 거절한다.

## 빼기

대기함에서 빼는 것(팝업 [삭제], TDB 반출을 마친 뒤 반출한 것 비우기)은 이 표의 줄을 지우는 것이다. 보관 목록처럼 자료를 가리키는 개인
목록일 뿐이라 자료·이력은 하나도 변하지 않는다(원칙 1의 예외 문단에 함께 적어 두었다).

## 권한

로그인만 하면 누구나 자기 대기함을 쓴다(권한 트리에 넣지 않는다 — 보관 목록과 같은 취급).
대기함을 여는 화면 자체는 "페이지 접속" 권한이 막고, 수정용 반출 같은 실제 기능은 각자의
권한이 그대로 막는다. 언제나 자기 것만 보이고 만져진다.
"""

from datetime import datetime
from io import BytesIO
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import mdb_group
from app.auth import current_user
from app.database import get_db
from app.models import AuditLog, Document, User, UserCartItem
from app.retire import MDB_RETIRE_KIND, TDB_RETIRE_KIND, is_retired_row
from app.rev_naming import document_display_name
from app.routers.documents import attach_holding_flags, path_after_category
from app.routers.mdb import load_all_groups, to_item as mdb_to_item
from app.schemas import DocumentListItem, MdbFileItem
from app.utils import build_export_filename, content_disposition_header, neutralize_formulas

router = APIRouter(prefix="/cart", tags=["cart"])

# 주소의 {kind} → 표에 적는 값. 화면이 쓰는 이름(tdb/mdb)을 그대로 받는다.
KINDS = {"tdb": "TDB", "mdb": "MDB"}

# 상태 — 위 설명 참고. 화면 표와 엑셀이 같은 글자를 쓰도록 이름표도 여기서 내려준다.
STATE_OK = "OK"
STATE_DELETED = "DELETED"
STATE_RETIRED = "RETIRED"
STATE_LABELS = {STATE_OK: "정상", STATE_DELETED: "삭제됨", STATE_RETIRED: "폐기됨"}

# 화면 제목 — 엑셀 파일명·시트 이름이 이 값을 따라간다(제목이 바뀌면 같이 바꾼다).
SCREEN_NAMES = {"TDB": "TDB 조회", "MDB": "MDB 조회"}
POPUP_TITLES = {"TDB": "반출대기함", "MDB": "다운대기함"}
# 시스템 로그의 화면 이름 — 예전 대기함 엑셀 기록과 같은 값을 써서 한 화면이 두 이름으로 갈리지 않게 한다.
AUDIT_SCREENS = {"TDB": "도면 목록", "MDB": "MDB"}


class CartIdsRequest(BaseModel):
    ids: list[int]


class CartItem(BaseModel):
    item_id: int
    state: str          # OK / DELETED / RETIRED
    state_label: str    # 정상 / 삭제됨 / 폐기됨
    name: str           # 자료명 — 완전 삭제된 것은 담을 때 적어 둔 이름
    added_at: datetime
    # 자료가 아직 남아 있으면(삭제 보관함·폐기 보관함 포함) 목록 표와 같은 모양의 값.
    # 완전 삭제돼 아무것도 없으면 둘 다 비어 있다.
    tdb: Optional[DocumentListItem] = None
    mdb: Optional[MdbFileItem] = None


class CartResponse(BaseModel):
    kind: str
    items: list[CartItem]


def kind_of(kind: str) -> str:
    value = KINDS.get(kind.lower())
    if value is None:
        raise HTTPException(status_code=404, detail="없는 대기함입니다")
    return value


def my_rows(db: Session, user: User, kind: str) -> list[UserCartItem]:
    """내 대기함 전부 — 담은 순서대로."""
    return (
        db.query(UserCartItem)
        .filter(UserCartItem.user_id == user.id, UserCartItem.kind == kind)
        .order_by(UserCartItem.added_at, UserCartItem.id)
        .all()
    )


def count_of(db: Session, user: User, kind: str) -> int:
    return db.query(UserCartItem).filter(UserCartItem.user_id == user.id, UserCartItem.kind == kind).count()


# ---------------------------------------------------------------------------
# 지금 상태 읽기 — TDB와 MDB가 표가 달라 따로 만든다
# ---------------------------------------------------------------------------

def tdb_items(db: Session, rows: list[UserCartItem]) -> list[CartItem]:
    docs = db.query(Document).filter(Document.id.in_([r.item_id for r in rows])).all() if rows else []
    docs_by_id = {d.id: d for d in docs}
    listed = {item.id: item for item in attach_holding_flags(db, docs)}

    result = []
    for row in rows:
        doc = docs_by_id.get(row.item_id)
        if doc is None:
            state = STATE_DELETED
        elif not doc.is_archived:
            state = STATE_OK
        elif is_retired_row(db, doc.archive_batch_id, TDB_RETIRE_KIND):
            state = STATE_RETIRED
        else:
            state = STATE_DELETED
        result.append(CartItem(
            item_id=row.item_id, state=state, state_label=STATE_LABELS[state],
            name=document_display_name(doc) if doc else row.item_name,
            added_at=row.added_at, tdb=listed.get(row.item_id),
        ))
    return result


def mdb_items(db: Session, rows: list[UserCartItem]) -> list[CartItem]:
    # 보관함에 안 들어간 자료는 목록 화면과 같은 방법으로 한 번에 읽는다. 담아 둔 id가 그 자료의
    # 어느 파일 id든 찾아지도록 파일 id마다 자료를 걸어 둔다.
    group_by_file_id = {}
    if rows:
        for group in load_all_groups(db):
            for file_id in group.file_ids:
                group_by_file_id[file_id] = group

    result = []
    for row in rows:
        group = group_by_file_id.get(row.item_id)
        state = STATE_OK
        if group is None:
            # 보관함에 들어간 것까지 찾아 본다. 그래도 없으면 완전 삭제된 것이다.
            group = mdb_group.group_of(db, row.item_id, include_archived=True)
            if group is not None and is_retired_row(db, group.rep.archive_batch_id, MDB_RETIRE_KIND):
                state = STATE_RETIRED
            else:
                state = STATE_DELETED
        result.append(CartItem(
            item_id=row.item_id, state=state, state_label=STATE_LABELS[state],
            name=group.name if group else row.item_name,
            added_at=row.added_at, mdb=mdb_to_item(group) if group else None,
        ))
    return result


def cart_items(db: Session, user: User, kind: str) -> list[CartItem]:
    rows = my_rows(db, user, kind)
    return tdb_items(db, rows) if kind == "TDB" else mdb_items(db, rows)


# ---------------------------------------------------------------------------
# 조회
# ---------------------------------------------------------------------------

@router.get("/{kind}", response_model=CartResponse)
def list_cart(kind: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    kind = kind_of(kind)
    return CartResponse(kind=kind, items=cart_items(db, user, kind))


@router.get("/{kind}/export")
def export_cart(
    kind: str,
    ids: Optional[str] = Query(None, description="이 자료들만(쉼표 구분) — 반출대기함 팝업에서 빼 둔 채 저장 전일 때"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """대기함 팝업 표와 같은 칸으로 내보낸다. 언제나 내 대기함 안에서만 고른다."""
    kind = kind_of(kind)
    items = cart_items(db, user, kind)
    if ids is not None:
        wanted = {int(x) for x in ids.split(",") if x.strip().isdigit()}
        items = [it for it in items if it.item_id in wanted]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = POPUP_TITLES[kind]
    if kind == "TDB":
        # 반출대기함 표: No / 자료명 / 분류 / 경로 / 상태
        ws.append(["No", "자료명", "분류", "경로", "상태"])
        for i, it in enumerate(items, start=1):
            ws.append([
                i, it.name, it.tdb.category if it.tdb else None,
                path_after_category(it.tdb) if it.tdb else None, it.state_label,
            ])
        widths = [6, 30, 16, 60, 10]
    else:
        # 다운대기함 표: No / 자료명 / 경로 / 상태
        ws.append(["No", "자료명", "경로", "상태"])
        for i, it in enumerate(items, start=1):
            ws.append([i, it.name, it.mdb.source_path if it.mdb else None, it.state_label])
        widths = [6, 40, 60, 10]

    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen=AUDIT_SCREENS[kind], document_id=None,
        detail={"count": len(items), "columns": "cart"},
    ))
    db.commit()

    filename = build_export_filename(SCREEN_NAMES[kind], POPUP_TITLES[kind])
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---------------------------------------------------------------------------
# 담기 · 빼기
# ---------------------------------------------------------------------------

def addable_tdb(db: Session, ids: list[int]) -> dict[int, str]:
    """담을 수 있는 TDB 자료 {id: 자료명} — 삭제·폐기된 자료는 새로 담지 않는다.
    화면이 보낸 순서를 지킨다(대기함은 담은 순서대로 보여준다)."""
    docs = db.query(Document).filter(Document.id.in_(ids), Document.is_archived.is_(False)).all() if ids else []
    names = {d.id: document_display_name(d) for d in docs}
    return {i: names[i] for i in ids if i in names}


def addable_mdb(db: Session, ids: list[int]) -> dict[int, str]:
    """담을 수 있는 MDB 자료 {대표 id: 자료명}. 같은 자료의 다른 파일 id가 와도 대표 id 하나로 담는다.
    화면이 보낸 순서를 지킨다."""
    group_by_file_id = {}
    for group in load_all_groups(db):
        for file_id in group.file_ids:
            group_by_file_id[file_id] = group
    result = {}
    for i in ids:
        group = group_by_file_id.get(i)
        if group is not None and group.id not in result:
            result[group.id] = group.name
    return result


@router.post("/{kind}/add")
def add_to_cart(
    kind: str, body: CartIdsRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    """담기. 이미 담겨 있는 것은 그대로 두고(두 번 담기지 않는다) 새것만 더한다."""
    kind = kind_of(kind)
    names = addable_tdb(db, body.ids) if kind == "TDB" else addable_mdb(db, body.ids)
    before = count_of(db, user, kind)
    if names:
        stmt = insert(UserCartItem).values([
            {"user_id": user.id, "kind": kind, "item_id": item_id, "item_name": name}
            for item_id, name in names.items()
        ]).on_conflict_do_nothing(constraint="uq_user_cart_items_user_kind_item")
        db.execute(stmt)
        db.commit()
    after = count_of(db, user, kind)
    # addable = 보낸 것 가운데 담을 수 있는(삭제·폐기 아닌) 자료 수. 미리보기에서 한 건을 담을 때
    # "이미 담겨 있음"과 "담을 수 없는 자료(삭제·폐기됨)"를 구분해 알려주려고 함께 내려준다.
    return {"added": after - before, "count": after, "addable": len(names)}


@router.post("/{kind}/remove")
def remove_from_cart(
    kind: str, body: CartIdsRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    """빼기 — 내 대기함의 그 줄만 지운다. 자료·이력은 그대로다."""
    kind = kind_of(kind)
    removed = 0
    if body.ids:
        removed = (
            db.query(UserCartItem)
            .filter(
                UserCartItem.user_id == user.id, UserCartItem.kind == kind,
                UserCartItem.item_id.in_(body.ids),
            )
            .delete(synchronize_session=False)
        )
        db.commit()
    return {"removed": removed, "count": count_of(db, user, kind)}
