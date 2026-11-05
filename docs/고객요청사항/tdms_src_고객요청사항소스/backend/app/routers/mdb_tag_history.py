"""MDB 관리 "Tag No 이력관리" — Tag No 변경이력 (2026-08-30 CM 확정).

설비 Tag No가 현장에서 바뀌는 일이 있다(예: P1000A 펌프가 P1700A로 바뀜). 이때 그 설비의
자료 수십 건에 새 Tag No를 함께 달아두어야 옛 번호로 찾아도 자료가 나오고, 나중에 보는
사람이 "왜 Tag No가 두 개지?" 하지 않도록 그 사연을 Note에 남겨야 한다. 자료를 하나씩
찾아 고치는 것은 사실상 불가능해서, 이력 한 줄을 등록하면 **그 Tag No가 붙은 자료 전부**에
같은 처리가 한 번에 들어가게 한 것이 이 기능이다.

여기서 하는 일은 넷이다(action).
    ADD       새 Tag No를 함께 달기          (P1000A 자료에 P1700A도 붙임)
    REMOVE    대상 Tag No 빼기
    RENAME    대상 Tag No를 새 것으로 바꾸기 (뺀 자리에 새 것을 넣음)
    NOTE_ONLY Tag No는 그대로 두고 Note 문구만 남기기

Note는 덮어쓰지 않고 **한 줄씩 쌓인다**(CM 확정) — 한 자료에 이력이 여러 번 적용되면
그 자료의 Note가 곧 그 설비의 변경 내력이 된다. 문구를 자유롭게 적으면 자료마다 표현이
달라지므로, 사유는 목록에서 고르고(mdb_tag_change_reasons) 연도·공사명·비고만 직접 적는다.

    Tag No 변경_P1000A → P1700A_2011_배관확장 공사_Pump 유종 변경으로 인해 Tag No 변경

되돌리기를 정확히 하기 위해 **실제로 손댄 파일과 바꾼 내용**을 이력에 적어둔다
(mdb_tag_histories.applied_changes) — 원래부터 그 Tag No를 갖고 있던 자료의 값을 되돌리기가
잘못 빼앗아 가면 안 되기 때문이다. 이력 자체는 지우지 않고, 되돌린 것은 "취소됨"으로 남는다.
"""

from datetime import datetime, timezone
from io import BytesIO
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.mdb_group import MdbGroup, build_groups, load_tags_map, row_key
from app.mdb_utils import project_name_for, year_for
from app.mdb_note import NOTE_ARROW, append_note_line, build_note_line, remove_note_line
from app.models import (
    AuditLog, MdbFile, MdbFileTag, MdbFolderPlaceholder, MdbTagHistory, Project, User,
)
from app.permissions import require_permission
from app.schemas import (
    MdbTagAutoApplied,
    MdbTagHistoryApplyResult,
    MdbTagHistoryCreate,
    MdbTagHistoryItem,
    MdbTagHistoryMeta,
    MdbTagHistoryTarget,
    MdbTagHistoryTargetList,
    MdbProjectFolder,
)
from app.utils import build_export_filename, content_disposition_header, neutralize_formulas

# 이 기능은 MDB 관리 화면의 "자료 편집" 칸 안에 있고 하는 일도 자료 편집이라, 권한도
# 그 권한(screen.mdb_editor.document) 하나를 그대로 쓴다 — 새 권한을 만들지 않는다.
require_document_edit = require_permission("screen.mdb_editor.document")

router = APIRouter(
    prefix="/mdb-tag-history", tags=["mdb-tag-history"],
    dependencies=[Depends(require_document_edit)],
)

# 화면·엑셀에 그대로 쓰는 문구. 화면(mdb-editor.js)의 작업 드롭다운 문구와 항상 같아야 한다.
ACTION_LABELS = {
    "ADD": "Tag No 추가",
    "REMOVE": "Tag No 삭제",
    "RENAME": "Tag No 변경",
    "NOTE_ONLY": "Note만 작성",
}
# 새 Tag No를 받아야 하는 작업
ACTIONS_NEEDING_NEW_TAG = ("ADD", "RENAME")

# Note 한 줄을 만들고·붙이고·떼는 규칙은 app/mdb_note.py 한 곳에 있다(NOTE_ARROW 포함) —
# 화면에 보여주려고 도로 조각내는 규칙(build_note_items)과 짝이라 같은 파일에 둔다.

# 자동 적용이 꼬리를 물 때 멈추는 한도 — 아래 apply_auto_rules 설명 참고.
AUTO_RULE_MAX_ROUNDS = 10

# 시스템 로그의 화면 이름(내부 키) — 화면 이름이 바뀌어도 이 키는 안 바꾼다(audit.py 참고)
SCREEN = "MDB 편집"


# ---------------------------------------------------------------------------
# 대상 자료 찾기
# ---------------------------------------------------------------------------

def load_target_groups(db: Session, base_tag: str, project_id: Optional[int]) -> list[MdbGroup]:
    """그 Tag No가 붙은 자료(원본+사본을 묶은 1건) 목록. 대소문자는 가리지 않는다.

    자료 수가 1,200건대라 한 번에 다 읽어 파이썬에서 묶는다 — 행마다 쿼리를 돌리지 않는다.
    """
    rows = db.query(MdbFile).filter(MdbFile.is_archived.is_(False)).all()
    tags_map = load_tags_map(db, [r.id for r in rows])
    needle = base_tag.strip().upper()
    groups = [g for g in build_groups(rows, tags_map) if needle in {t.upper() for t in g.tags}]
    if project_id:
        groups = [g for g in groups if g.project_id == project_id]
    return groups


def clean_tag(value: Optional[str]) -> Optional[str]:
    return (value or "").strip() or None


# ---------------------------------------------------------------------------
# 적용 / 되돌리기 — 이력 1건이 실제로 자료를 고치는 부분
# ---------------------------------------------------------------------------

def merge_changes(old: Optional[list], new: list[dict]) -> list[dict]:
    """[다시 적용]했을 때, 예전에 손댄 것과 이번에 손댄 것을 합친다.

    합치지 않으면 되돌리기가 "마지막 적용분"만 취소하게 되어, 처음 적용 때 Tag No가 붙은
    자료들이 그대로 남는다. 파일 단위로 합치고, 표시는 하나라도 참이면 참으로 둔다.
    """
    merged: dict[int, dict] = {}
    for item in list(old or []) + new:
        cur = merged.setdefault(
            int(item["id"]), {"id": int(item["id"]), "tag_changed": False, "note_added": False}
        )
        cur["tag_changed"] = cur["tag_changed"] or bool(item.get("tag_changed"))
        cur["note_added"] = cur["note_added"] or bool(item.get("note_added"))
    return sorted(merged.values(), key=lambda c: c["id"])


def apply_to_groups(
    db: Session, history: MdbTagHistory, user: User, groups: list[MdbGroup],
    *, accumulate_count: bool = False,
) -> MdbTagHistoryApplyResult:
    """이력 1건을 넘겨받은 자료들에 적용한다 — **자료를 실제로 고치는 부분**.

    부르는 곳은 둘이다.
      · apply_to_documents  그 Tag No가 붙은 자료 **전부**(등록·[다시 적용]·[수정])
      · apply_auto_rules    방금 저장한 자료 **한 건**(자동 적용, 2026-09-01 CM 확정)

    accumulate_count=True면 "적용 자료" 수를 덮어쓰지 않고 더한다 — 자동 적용은 한 건씩
    들어가므로 덮어쓰면 예전에 적용한 수십 건이 1로 줄어든다. [다시 적용]을 누르면 전체를
    다시 세어 정확한 값으로 돌아온다.

    시스템 로그 남기기와 저장(commit)은 부르는 쪽에서 한다. [수정]이 "예전 내용 되돌리기 +
    새 내용 적용"을 한 번에 묶어 저장해야 하기 때문이다(중간에 실패하면 반쪽만 반영된다).
    등록·[다시 적용]은 아래 apply_history가 감싼다.
    """
    base_up = history.base_tag.strip().upper()
    new_tag = clean_tag(history.new_tag)
    now = datetime.now(timezone.utc)

    changes: list[dict] = []
    tag_changed_docs = 0
    note_changed_docs = 0

    for group in groups:
        doc_tag_changed = False
        doc_note_changed = False
        for row in group.rows:
            # Tag No는 자료에 딸린 파일 전부에 같이 달아둔다(원본·사본 어느 쪽으로 찾아도
            # 같은 자료가 잡히게 하기 위함 — "자료명·정보 변경"과 같은 규칙).
            existing = db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id == row.id).all()
            have = {t.tag_no.upper() for t in existing}
            row_tag_changed = False

            if history.action in ACTIONS_NEEDING_NEW_TAG and new_tag and new_tag.upper() not in have:
                db.add(MdbFileTag(mdb_file_id=row.id, tag_no=new_tag))
                row_tag_changed = True
            if history.action in ("REMOVE", "RENAME"):
                for tag_row in existing:
                    if tag_row.tag_no.upper() == base_up:
                        db.delete(tag_row)
                        row_tag_changed = True

            row_note_added = False
            if history.note_line:
                new_note, added = append_note_line(row.note, history.note_line)
                if added:
                    row.note = new_note
                    row_note_added = True

            if row_tag_changed or row_note_added:
                row.updated_at = now
                changes.append({
                    "id": row.id, "tag_changed": row_tag_changed, "note_added": row_note_added,
                })
            doc_tag_changed = doc_tag_changed or row_tag_changed
            doc_note_changed = doc_note_changed or row_note_added

        tag_changed_docs += 1 if doc_tag_changed else 0
        note_changed_docs += 1 if doc_note_changed else 0

    # 되돌린 뒤 다시 적용하는 경우는 예전 기록이 이미 취소된 것이므로 새로 시작한다.
    history.applied_changes = (
        changes if history.reverted_at else merge_changes(history.applied_changes, changes)
    )
    history.applied_doc_count = (
        (history.applied_doc_count or 0) + len(groups) if accumulate_count else len(groups)
    )
    history.applied_at = now
    history.applied_by = user.id
    history.reverted_at = None
    history.reverted_by = None

    return MdbTagHistoryApplyResult(
        id=history.id, doc_count=len(groups),
        tag_changed_docs=tag_changed_docs, note_changed_docs=note_changed_docs,
    )


def apply_to_documents(db: Session, history: MdbTagHistory, user: User) -> MdbTagHistoryApplyResult:
    """이력 1건을 **그 Tag No가 붙은 자료 전부**에 적용한다(등록·[다시 적용]·[수정])."""
    groups = load_target_groups(db, history.base_tag, history.project_id)
    return apply_to_groups(db, history, user, groups)


def apply_history(db: Session, history: MdbTagHistory, user: User) -> MdbTagHistoryApplyResult:
    """등록·[다시 적용] — 적용한 뒤 시스템 로그를 남기고 저장한다."""
    result = apply_to_documents(db, history, user)
    db.add(AuditLog(
        user_id=user.id, action="MDB_TAG_HISTORY_APPLY", screen=SCREEN,
        detail={
            "scope": "mdb", "history_id": history.id, "base_tag": history.base_tag,
            "action": history.action, "new_tag": clean_tag(history.new_tag),
            "project_id": history.project_id, "note_line": history.note_line,
            "doc_count": result.doc_count, "tag_changed_docs": result.tag_changed_docs,
            "note_changed_docs": result.note_changed_docs,
        },
    ))
    db.commit()
    return result


# ---------------------------------------------------------------------------
# 자동 적용 — 나중에 그 Tag No가 붙는 자료에도 시스템이 알아서 넣어준다 (2026-09-01 CM 확정)
# ---------------------------------------------------------------------------

def find_auto_histories(db: Session) -> list[MdbTagHistory]:
    """지금 "앞으로 자동 적용"이 켜져 있는 이력들. 되돌린(취소됨) 이력은 빠진다 —
    취소해 둔 처리가 자동으로 되살아나면 안 되기 때문이다."""
    return (
        db.query(MdbTagHistory)
        .filter(MdbTagHistory.auto_apply.is_(True), MdbTagHistory.reverted_at.is_(None))
        .order_by(MdbTagHistory.id)
        .all()
    )


def group_of_rows(db: Session, rows: list[MdbFile]) -> MdbGroup:
    """방금 저장한 자료 한 건을 지금 DB에 저장돼 있는 그대로 묶어온다(Tag No 포함)."""
    tags_map = load_tags_map(db, [r.id for r in rows])
    return MdbGroup(row_key(rows[0]), rows, [t for r in rows for t in tags_map.get(r.id, [])])


def apply_auto_rules(
    db: Session, rows: list[MdbFile], added_tags: list[str], user: User,
) -> list[MdbTagAutoApplied]:
    """자료에 Tag No를 새로 달았을 때, 그 Tag No에 걸린 "자동 적용" 이력을 그 자리에서 넣는다.

    이력은 등록하는 그때 있던 자료에만 들어간다. 나중에 들어온 자료나, 뒤늦게 그 설비 것으로
    확인돼 Tag No를 달아준 자료에는 같은 처리를 또 손으로 해야 했다 — 그 되풀이를 없애려고
    CM이 요청한 기능이다. 등록 팝업의 [앞으로 이 Tag No가 붙는 자료에도 자동으로 적용]이 곧
    이 스위치이고, 새 이력은 켜짐이 기본이다.

    부르는 곳은 "자료명·정보 변경" 저장 한 곳뿐이다(mdb_editor.py update_file_info — MDB 관리
    팝업과 MDB 자료 상세보기의 Tag No ✎가 같이 쓴다). **묻지 않고 넣되 무엇이 들어갔는지는
    알려준다**가 CM이 고른 방식이라, 넣은 내용을 그대로 돌려주어 화면이 알림으로 보여준다.

    꼬리를 무는 경우도 이어서 처리한다 — A를 달아 규칙이 B를 붙였는데 B에도 규칙이 걸려 있으면
    그것까지 넣는다. 한 번 처리한 이력은 다시 보지 않으므로(done) A↔B처럼 서로 가리켜도 맴돌지
    않고, 그래도 만약을 위해 AUTO_RULE_MAX_ROUNDS번까지만 돈다.

    자료 여러 건에 한 번에 넣는 [다시 적용]은 이 자동 처리를 부르지 않는다 — 그건 CM이 대상을
    보고 직접 누르는 것이라, 거기서 또 다른 규칙이 줄줄이 발동하면 무엇이 바뀌었는지 알기
    어렵기 때문이다.
    """
    results: list[MdbTagAutoApplied] = []
    pending = {t.strip().upper() for t in added_tags if t and t.strip()}
    if not rows or not pending:
        return results

    # 방금 저장한 Tag No가 아래 조회에 보이도록 먼저 내려보낸다(이 프로그램의 세션은
    # autoflush=False라 db.add만 해둔 것은 조회에 안 잡힌다 — D-58에서 겪은 것과 같은 자리).
    db.flush()

    done: set[int] = set()
    for _ in range(AUTO_RULE_MAX_ROUNDS):
        candidates = [
            h for h in find_auto_histories(db)
            if h.id not in done and h.base_tag.strip().upper() in pending
        ]
        pending = set()
        if not candidates:
            break
        for history in candidates:
            done.add(history.id)
            group = group_of_rows(db, rows)
            # 적용 범위를 한 공사로 좁혀둔 이력이면 그 공사 자료에만 넣는다(같은 번호라도
            # 공사가 다르면 다른 기기일 수 있다 — D-55의 교훈).
            if history.project_id and group.project_id != history.project_id:
                continue
            result = apply_to_groups(db, history, user, [group], accumulate_count=True)
            if not (result.tag_changed_docs or result.note_changed_docs):
                continue  # 이미 들어가 있어 바뀐 것이 없으면 알릴 것도 없다
            db.flush()
            results.append(MdbTagAutoApplied(
                history_id=history.id,
                base_tag=history.base_tag,
                action=history.action,
                action_label=ACTION_LABELS.get(history.action, history.action),
                new_tag=clean_tag(history.new_tag),
                note_line=history.note_line,
                tag_added=bool(result.tag_changed_docs),
                note_added=bool(result.note_changed_docs),
            ))
            new_tag = clean_tag(history.new_tag)
            if result.tag_changed_docs and history.action in ACTIONS_NEEDING_NEW_TAG and new_tag:
                pending.add(new_tag.upper())

    if results:
        db.add(AuditLog(
            user_id=user.id, action="MDB_TAG_HISTORY_AUTO_APPLY", screen=SCREEN,
            detail={
                "scope": "mdb", "mdb_file_ids": [r.id for r in rows],
                "added_tags": [t for t in added_tags if t],
                "histories": [
                    {"history_id": r.history_id, "base_tag": r.base_tag,
                     "action_label": r.action_label, "new_tag": r.new_tag,
                     "note_line": r.note_line if r.note_added else None}
                    for r in results
                ],
            },
        ))
    return results


def revert_from_documents(db: Session, history: MdbTagHistory, user: User) -> MdbTagHistoryApplyResult:
    """적용한 것을 되돌린다 — **이 이력이 실제로 손댄 것만** 원래대로 돌려놓는다.

    apply_to_documents와 같은 이유로 시스템 로그·저장은 부르는 쪽에서 한다. [수정]이
    "예전 내용 빼내기"에 이 코드를 그대로 쓴다.
    """
    base_tag = history.base_tag.strip()
    base_up = base_tag.upper()
    new_tag = clean_tag(history.new_tag)
    now = datetime.now(timezone.utc)

    tag_reverted_keys: set[str] = set()
    note_reverted_keys: set[str] = set()
    touched_keys: set[str] = set()

    for change in history.applied_changes or []:
        row = db.get(MdbFile, int(change["id"]))
        if row is None:
            continue  # 그 사이 완전삭제된 자료 — 되돌릴 것이 없다
        key = row_key(row)
        touched_keys.add(key)

        if change.get("tag_changed"):
            existing = db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id == row.id).all()
            have = {t.tag_no.upper() for t in existing}
            if history.action in ACTIONS_NEEDING_NEW_TAG and new_tag:
                for tag_row in existing:
                    if tag_row.tag_no.upper() == new_tag.upper():
                        db.delete(tag_row)
            if history.action in ("REMOVE", "RENAME") and base_up not in have:
                db.add(MdbFileTag(mdb_file_id=row.id, tag_no=base_tag))
            row.updated_at = now
            tag_reverted_keys.add(key)

        if change.get("note_added") and history.note_line:
            new_note, removed = remove_note_line(row.note, history.note_line)
            if removed:
                row.note = new_note
                row.updated_at = now
                note_reverted_keys.add(key)

    history.reverted_at = now
    history.reverted_by = user.id

    return MdbTagHistoryApplyResult(
        id=history.id, doc_count=len(touched_keys),
        tag_changed_docs=len(tag_reverted_keys), note_changed_docs=len(note_reverted_keys),
    )


def revert_history(db: Session, history: MdbTagHistory, user: User) -> MdbTagHistoryApplyResult:
    """[되돌리기] — 되돌린 뒤 시스템 로그를 남기고 저장한다."""
    result = revert_from_documents(db, history, user)
    db.add(AuditLog(
        user_id=user.id, action="MDB_TAG_HISTORY_REVERT", screen=SCREEN,
        detail={
            "scope": "mdb", "history_id": history.id, "base_tag": history.base_tag,
            "action": history.action, "new_tag": clean_tag(history.new_tag),
            "doc_count": result.doc_count, "tag_changed_docs": result.tag_changed_docs,
            "note_changed_docs": result.note_changed_docs,
        },
    ))
    db.commit()
    return result


# ---------------------------------------------------------------------------
# 목록 · 미리보기
# ---------------------------------------------------------------------------

def to_item(history: MdbTagHistory, names: dict[int, str], projects: dict[int, str]) -> MdbTagHistoryItem:
    return MdbTagHistoryItem(
        id=history.id,
        base_tag=history.base_tag,
        action=history.action,
        action_label=ACTION_LABELS.get(history.action, history.action),
        new_tag=history.new_tag,
        project_id=history.project_id,
        project_name=projects.get(history.project_id) if history.project_id else None,
        note_label=history.note_label,
        note_year=history.note_year,
        note_project=history.note_project,
        note_reason=history.note_reason,
        note_memo=history.note_memo,
        note_line=history.note_line,
        write_note=history.note_line is not None,
        auto_apply=bool(history.auto_apply),
        applied_doc_count=history.applied_doc_count,
        applied_at=history.applied_at,
        applied_by_name=names.get(history.applied_by) if history.applied_by else None,
        reverted_at=history.reverted_at,
        reverted_by_name=names.get(history.reverted_by) if history.reverted_by else None,
        status="취소됨" if history.reverted_at else "적용됨",
        created_at=history.created_at,
        created_by_name=names.get(history.created_by) if history.created_by else None,
    )


def load_items(
    db: Session, *,
    year: Optional[str] = None, note_project: Optional[str] = None, q: Optional[str] = None,
) -> list[MdbTagHistoryItem]:
    """이력 목록 — 최근 등록한 것이 위로. 사람 이름·공사명은 한 번에 읽어와 붙인다
    (행마다 따로 조회하면 목록이 느려진다).

    검색 조건(연도·공사명·Note 문구)은 읽어온 목록에서 파이썬으로 걸러낸다(2026-08-31 CM 지시).
    이력은 많아야 수십 건이라 이게 더 간단하고, 무엇보다 **Note 문구는 조각을 밑줄(_)로 이어
    만든 문장**이라 DB의 LIKE로 찾으면 밑줄이 "아무 글자 하나"라는 뜻이 되어 엉뚱한 줄까지
    걸린다. 목록 화면과 엑셀 내보내기가 같은 함수를 쓰므로 둘의 결과가 어긋나지 않는다.
    """
    histories = db.query(MdbTagHistory).order_by(MdbTagHistory.id.desc()).all()
    names = {u.id: u.name for u in db.query(User).all()}
    projects = {p.id: p.name for p in db.query(Project).all()}
    items = [to_item(h, names, projects) for h in histories]

    # 연도·공사명은 드롭다운에서 고른 값이라 정확히 같은 것만, Note 문구는 적어 넣는 칸이라
    # 일부만 적어도 걸리게(대소문자 무관) 한다.
    year = (year or "").strip()
    note_project = (note_project or "").strip()
    needle = (q or "").strip().lower()
    if year:
        items = [it for it in items if (it.note_year or "").strip() == year]
    if note_project:
        items = [it for it in items if (it.note_project or "").strip() == note_project]
    if needle:
        items = [it for it in items if needle in (it.note_line or "").lower()]
    return items


@router.get("", response_model=list[MdbTagHistoryItem])
def list_histories(
    year: Optional[str] = None, note_project: Optional[str] = None, q: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """이력 목록. 검색 조건 없이 부르면 전부 — MDB 자료 상세보기의 Note ✎(어느 이력이 그 줄을
    남겼는지 찾는 곳)가 그렇게 쓴다."""
    return load_items(db, year=year, note_project=note_project, q=q)


@router.get("/meta", response_model=MdbTagHistoryMeta)
def get_meta(db: Session = Depends(get_db)):
    """검색줄의 연도·공사명 드롭다운 값 — 실제 이력에 적혀 있는 값만 모은다."""
    rows = db.query(MdbTagHistory.note_year, MdbTagHistory.note_project).all()
    years = sorted({(y or "").strip() for y, _ in rows} - {""}, reverse=True)
    note_projects = sorted({(pj or "").strip() for _, pj in rows} - {""})
    return MdbTagHistoryMeta(years=years, note_projects=note_projects)


@router.get("/project-folders", response_model=list[MdbProjectFolder])
def list_project_folders(db: Session = Depends(get_db)):
    """등록·수정 팝업의 공사명 드롭다운 값 — MDB 폴더트리 최상위 폴더 (2026-09-01 CM 지시).

    위 /meta(검색줄용)와는 다르다. 저기는 "이미 등록된 이력에 적혀 있는 공사명"이고,
    여기는 "앞으로 고를 수 있는 공사명"이다. 공사 표(projects)를 안 쓰는 이유는
    MdbProjectFolder 스키마 주석 참고.

    자료가 아직 없이 빈 폴더로만 만들어 둔 최상위도 함께 넣는다 — 트리에 보이는 폴더는
    전부 고를 수 있어야 화면과 어긋나지 않는다.
    """
    tops: set[str] = set()
    rows = db.query(MdbFile.source_path).filter(MdbFile.is_archived.is_(False)).distinct().all()
    rows += db.query(MdbFolderPlaceholder.path).distinct().all()
    for (path,) in rows:
        top = project_name_for(path or "")
        if top:
            tops.add(top)
    return [MdbProjectFolder(folder=t, year=year_for(t)) for t in sorted(tops)]


@router.get("/targets", response_model=MdbTagHistoryTargetList)
def list_targets(
    tag: str = Query(..., min_length=1), project_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """등록 화면에서 "이 Tag No가 붙은 자료가 몇 건인지" 미리 보여주기 위한 목록.
    한 번에 수십 건이 바뀌는 기능이라, 적용 전에 무엇이 바뀔지 눈으로 확인할 수 있어야 한다."""
    groups = load_target_groups(db, tag, project_id)
    return MdbTagHistoryTargetList(
        doc_count=len(groups),
        file_count=sum(len(g.rows) for g in groups),
        items=[
            MdbTagHistoryTarget(
                id=g.id, name=g.name, source_path=g.key,
                project_name=g.project_name, tags=g.tags,
            ) for g in groups
        ],
    )


@router.get("/export")
def export_histories(
    year: Optional[str] = None, note_project: Optional[str] = None, q: Optional[str] = None,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """이력 목록 표를 그대로 엑셀로. 컬럼 구성은 화면 표와 같다(버튼만 있는 조치 칸은 제외).
    화면에서 검색 조건을 걸어두었으면 그 결과 그대로 나간다(목록과 같은 load_items를 쓴다)."""
    items = load_items(db, year=year, note_project=note_project, q=q)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Tag No 이력관리"
    # 컬럼 구성은 화면 표와 똑같이 맞춘다(버튼만 있는 "조치" 칸과 행 번호 "No"만 제외).
    # 표에 없는 열을 여기에만 더하면 화면과 엑셀이 어긋난다 — 예전에 실제로 났던 문제다.
    ws.append(["등록일", "구분", "대상 Tag No", "바뀐 Tag No", "연도", "공사명",
               "적용 자료", "Note 문구", "상태"])
    for it in items:
        ws.append([
            it.created_at.strftime("%Y-%m-%d %H:%M") if it.created_at else None,
            it.action_label, it.base_tag, it.new_tag, it.note_year, it.note_project,
            it.applied_doc_count, it.note_line,
            # 상태 칸에 자동 적용 여부를 함께 적는다 — 화면 표도 같은 칸에 함께 보여준다
            # (칸을 하나 더 두면 표와 엑셀 어느 한쪽만 늘어나기 쉽고 Note 문구 칸이 좁아진다).
            f"{it.status} (자동)" if it.auto_apply else it.status,
        ])
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"
    for idx, width in enumerate([17, 13, 15, 15, 10, 20, 10, 60, 14], start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = width

    buf = BytesIO()
    neutralize_formulas(wb)
    wb.save(buf)
    buf.seek(0)
    filename = build_export_filename("MDB 관리", "Tag No 이력관리")

    db.add(AuditLog(
        user_id=user.id, action="EXPORT", screen=SCREEN,
        detail={
            "scope": "mdb", "kind": "Tag No 이력관리", "count": len(items),
            "year": year, "note_project": note_project, "q": q,
        },
    ))
    db.commit()

    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition_header("attachment", filename)},
    )


# ---------------------------------------------------------------------------
# 등록 · 다시 적용 · 되돌리기
# ---------------------------------------------------------------------------

def check_input(db: Session, body: MdbTagHistoryCreate) -> tuple[str, Optional[str], Optional[str]]:
    """등록·[수정]이 함께 쓰는 입력 검사. (대상 Tag No, 새 Tag No, Note 한 줄)을 돌려준다."""
    base_tag = clean_tag(body.base_tag)
    if not base_tag:
        raise HTTPException(status_code=400, detail="대상 Tag No를 입력해주세요")
    if body.action not in ACTION_LABELS:
        raise HTTPException(status_code=400, detail="알 수 없는 작업입니다")

    new_tag = clean_tag(body.new_tag)
    if body.action in ACTIONS_NEEDING_NEW_TAG:
        if not new_tag:
            raise HTTPException(status_code=400, detail="새 Tag No를 입력해주세요")
        if new_tag.upper() == base_tag.upper():
            raise HTTPException(status_code=400, detail="대상 Tag No와 새 Tag No가 같습니다")
    else:
        new_tag = None

    if body.project_id and db.get(Project, body.project_id) is None:
        raise HTTPException(status_code=404, detail="존재하지 않는 공사입니다")

    note_line = build_note_line(
        label=clean_tag(body.note_label), base_tag=base_tag, new_tag=new_tag,
        year=clean_tag(body.note_year), project=clean_tag(body.note_project),
        reason=clean_tag(body.note_reason), memo=clean_tag(body.note_memo),
    ) if body.write_note else None

    if body.action == "NOTE_ONLY" and not note_line:
        raise HTTPException(
            status_code=400, detail="Tag No도 바꾸지 않고 Note도 쓰지 않으면 할 일이 없습니다",
        )
    return base_tag, new_tag, note_line


def fill_history(
    history: MdbTagHistory, body: MdbTagHistoryCreate,
    base_tag: str, new_tag: Optional[str], note_line: Optional[str],
) -> None:
    """등록·[수정]이 함께 쓰는 값 채우기 — 한쪽만 고쳐져 둘이 어긋나는 일이 없게 한곳에 둔다."""
    history.base_tag = base_tag
    history.action = body.action
    history.new_tag = new_tag
    history.project_id = body.project_id
    history.note_label = clean_tag(body.note_label) if body.write_note else None
    history.note_year = clean_tag(body.note_year) if body.write_note else None
    history.note_project = clean_tag(body.note_project) if body.write_note else None
    history.note_reason = clean_tag(body.note_reason) if body.write_note else None
    history.note_memo = clean_tag(body.note_memo) if body.write_note else None
    history.note_line = note_line
    # 앞으로 이 Tag No가 붙는 자료에도 자동으로 넣을지 — 새 이력은 켜짐이 기본이다(2026-09-01).
    history.auto_apply = bool(body.auto_apply)


@router.post("", response_model=MdbTagHistoryApplyResult)
def create_history(
    body: MdbTagHistoryCreate,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """이력을 등록하고 그 자리에서 바로 적용한다."""
    base_tag, new_tag, note_line = check_input(db, body)

    history = MdbTagHistory(base_tag=base_tag, action=body.action, created_by=user.id)
    fill_history(history, body, base_tag, new_tag, note_line)
    db.add(history)
    db.flush()  # 시스템 로그에 남길 id를 먼저 받는다
    return apply_history(db, history, user)


def get_or_404(db: Session, history_id: int) -> MdbTagHistory:
    history = db.get(MdbTagHistory, history_id)
    if history is None:
        raise HTTPException(status_code=404, detail="존재하지 않는 이력입니다")
    return history


@router.post("/{history_id}/apply", response_model=MdbTagHistoryApplyResult)
def apply_again(
    history_id: int, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """[다시 적용] — 나중에 들어온 자료에도 같은 처리를 한 번 더 넣는다. 이미 처리된 자료는
    그대로 두므로(같은 Tag No·같은 Note 줄은 안 늘어난다) 여러 번 눌러도 안전하다."""
    return apply_history(db, get_or_404(db, history_id), user)


@router.patch("/{history_id}", response_model=MdbTagHistoryApplyResult)
def update_history(
    history_id: int, body: MdbTagHistoryCreate,
    db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """[수정] — 이력 내용을 고치고, 자료에 이미 들어가 있던 예전 내용을 새 내용으로 갈아끼운다.

    "수정하면 기존에 반영되었던 이력이 수정된 내용으로 바뀐다"가 CM 요구라, **예전 내용을
    먼저 되돌린 뒤 새 내용을 적용**한다 — 이력이 실제로 손댄 것만 정확히 빼내는 되돌리기
    코드를 그대로 쓰므로, 사람이 직접 적어둔 Note 줄이나 원래부터 붙어 있던 Tag No는
    그대로 남는다. 되돌리기와 적용을 한 번에 저장하므로 반쪽만 반영되는 일도 없다.

    이미 [되돌리기]한(취소됨) 이력은 자료에 들어가 있는 것이 없으므로 내용만 고치고 취소됨
    그대로 둔다 — 자료에 넣으려면 목록에서 [다시 적용]을 누르면 된다.
    """
    history = get_or_404(db, history_id)
    base_tag, new_tag, note_line = check_input(db, body)

    before = {
        "base_tag": history.base_tag,
        "action_label": ACTION_LABELS.get(history.action, history.action),
        "new_tag": history.new_tag, "project_id": history.project_id,
        "note_line": history.note_line, "auto_apply": bool(history.auto_apply),
    }
    was_applied = history.reverted_at is None
    if was_applied:
        # 예전 내용으로 넣었던 Tag No·Note 줄을 먼저 빼낸다. 이때 reverted_at이 채워지므로
        # 이어지는 적용은 예전 기록과 합치지 않고 새로 시작한다(apply_to_documents 참고).
        revert_from_documents(db, history, user)
        # 되돌린 결과를 DB에 먼저 내려보낸다. 이 프로그램의 세션은 autoflush=False라
        # (database.py) 이걸 빼먹으면 이어지는 적용이 "되돌리기 전"의 Tag No를 보게 되어,
        # [Tag No 변경]·[Tag No 삭제] 이력을 고칠 때 대상 자료를 못 찾는다.
        db.flush()

    fill_history(history, body, base_tag, new_tag, note_line)

    result = (
        apply_to_documents(db, history, user) if was_applied
        else MdbTagHistoryApplyResult(
            id=history.id, doc_count=0, tag_changed_docs=0, note_changed_docs=0,
        )
    )

    db.add(AuditLog(
        user_id=user.id, action="MDB_TAG_HISTORY_UPDATE", screen=SCREEN,
        detail={
            "scope": "mdb", "history_id": history.id,
            "before": before,
            "after": {
                "base_tag": base_tag,
                "action_label": ACTION_LABELS.get(body.action, body.action),
                "new_tag": new_tag, "project_id": body.project_id, "note_line": note_line,
                "auto_apply": bool(body.auto_apply),
            },
            "reapplied": was_applied, "doc_count": result.doc_count,
            "tag_changed_docs": result.tag_changed_docs,
            "note_changed_docs": result.note_changed_docs,
        },
    ))
    db.commit()
    return result


@router.post("/{history_id}/revert", response_model=MdbTagHistoryApplyResult)
def revert(
    history_id: int, db: Session = Depends(get_db), user: User = Depends(require_document_edit),
):
    """[되돌리기] — 이 이력이 넣은 Tag No와 Note 줄을 도로 빼낸다."""
    history = get_or_404(db, history_id)
    if history.reverted_at:
        raise HTTPException(status_code=400, detail="이미 되돌린 이력입니다")
    return revert_history(db, history, user)
