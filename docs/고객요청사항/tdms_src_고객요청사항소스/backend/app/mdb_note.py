"""MDB 자료 Note 한 줄을 **만들고·붙이고·떼고·다시 조각내는** 규칙 — 이 파일 한 곳에만 둔다.

MDB 자료의 Note는 사람이 자유롭게 적는 글이 아니라 "Tag No 이력관리"가 한 줄씩 쌓아 만든
기록이다(2026-08-30 CM 확정). 한 줄은 조각을 밑줄로 이어 붙인 문장이다.

    Tag No 변경_P1000A → P1700A_2022년_U-Plus Project_Tank Mixer 이설
    └ 구분 ┘ └─ Tag No 변경 ─┘ └연도┘ └── 공사명 ──┘ └── 사유·비고 ──┘

만드는 규칙(build_note_line)과 화면에 보여주려고 도로 조각내는 규칙(build_note_items)이
서로 어긋나면 안 되므로 한 파일에 둔다 — mdb_group.py(자료 1건의 정의)·mdb_types.py(설비유형·
자료유형)와 같은 판단이다.

**조각낼 때 밑줄로 쪼개지 않는다.** 빈 칸은 그 자리째 빠지므로(연도를 안 적으면 세 번째가
공사명이 된다) 밑줄만 보고는 어느 조각인지 알 수 없다. 대신 그 줄을 남긴 이력을 찾아
등록할 때 적은 값을 그대로 가져온다 — 서버가 되돌릴 때 쓰는 기준(문장이 글자까지 같은지)과
같은 방법이다. 이력에서 온 줄이 아니면(사람이 예전에 적어둔 것 등) 원문 그대로 보여준다.
"""

from typing import Optional

from sqlalchemy.orm import Session

from app.models import MdbTagHistory
from app.schemas import MdbNoteLine

# Note 문구의 조각을 잇는 기호 (CM이 정한 형식: Tag No 변경_P1000A → P1700A_2011_...)
NOTE_SEPARATOR = "_"
# Tag No가 바뀐 것을 나타내는 화살표. "->" 같은 흉내가 아니라 화살표 기호를 쓴다
# (2026-08-30 CM 지시). 화면(mdb-tag-history.js의 NOTE_ARROW)과 반드시 같은 글자여야
# 미리보기와 실제 Note가 같다.
NOTE_ARROW = "→"


def build_note_line(
    *, label: Optional[str], base_tag: str, new_tag: Optional[str],
    year: Optional[str], project: Optional[str], reason: Optional[str], memo: Optional[str],
) -> str:
    """Note에 들어갈 한 줄을 만든다. 빈 칸은 그 자리째 빠지고 밑줄도 생기지 않는다."""
    change = f"{base_tag} {NOTE_ARROW} {new_tag}" if new_tag else base_tag
    parts = [p for p in (label, change, year, project, reason, memo) if p]
    return NOTE_SEPARATOR.join(parts)


def append_note_line(note: Optional[str], line: str) -> tuple[Optional[str], bool]:
    """Note 맨 아래에 한 줄을 더한다. 이미 같은 줄이 있으면 그대로 둔다(다시 적용해도 안 늘어남).
    돌려주는 값: (새 Note, 실제로 더했는지)"""
    lines = [ln for ln in (note or "").split("\n") if ln.strip()]
    if any(ln.strip() == line for ln in lines):
        return note, False
    lines.append(line)
    return "\n".join(lines), True


def remove_note_line(note: Optional[str], line: str) -> tuple[Optional[str], bool]:
    """Note에서 그 한 줄만 뺀다(되돌리기). 사람이 직접 적어둔 다른 줄은 건드리지 않는다."""
    lines = [ln for ln in (note or "").split("\n") if ln.strip()]
    kept = [ln for ln in lines if ln.strip() != line]
    if len(kept) == len(lines):
        return note, False
    return ("\n".join(kept) or None), True


def build_note_items(db: Session, note: Optional[str]) -> list[MdbNoteLine]:
    """자료 Note를 화면에 표로 보여주기 위해 줄마다 조각으로 나눈다 (2026-09-01 CM 확정).

    밑줄로 이어 붙인 한 줄을 그대로 보여주면 "Tag No가 어떻게 됐고, 언제, 어떤 공사에서,
    무슨 사유인지"가 눈에 안 들어온다는 CM 지적으로 만든 것이다. 화면(mdb-detail.js)이 이
    값을 받아 구분·Tag No·연도·공사명·사유·비고를 세로로 줄 맞춰 표로 그린다.

    이력이 남긴 줄이 아니면 조각을 알 수 없으므로 from_history=false로 두고 원문만 담는다 —
    화면은 그런 줄을 칸을 합쳐 한 줄로 보여준다.
    """
    lines = [ln.strip() for ln in (note or "").split("\n") if ln.strip()]
    if not lines:
        return []

    # 이력은 많아야 수십 건이라 한 번에 다 읽어 문장으로 찾아 쓴다(줄마다 조회하지 않는다).
    by_line: dict[str, MdbTagHistory] = {}
    for h in db.query(MdbTagHistory).order_by(MdbTagHistory.id).all():
        key = (h.note_line or "").strip()
        if key and key not in by_line:
            by_line[key] = h  # 같은 문장을 남긴 이력이 둘 이상이면 먼저 등록된 쪽

    items: list[MdbNoteLine] = []
    for line in lines:
        h = by_line.get(line)
        if h is None:
            items.append(MdbNoteLine(text=line, from_history=False))
            continue
        change = (
            f"{h.base_tag} {NOTE_ARROW} {h.new_tag}" if h.new_tag else (h.base_tag or "")
        )
        items.append(MdbNoteLine(
            text=line, from_history=True, history_id=h.id,
            label=h.note_label, base_tag=h.base_tag, new_tag=h.new_tag, tag_change=change,
            year=h.note_year, project=h.note_project, reason=h.note_reason, memo=h.note_memo,
        ))
    return items
