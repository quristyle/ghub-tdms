"""연도별 Rev 폴더(P&ID·PFD)에서 "최신이 아닌 폴더"를 가려내는 규칙 (2026-09-29 CM 지시).

P&ID(5.2)·PFD(3.2)는 다른 폴더와 달리 리비전을 자료 안의 Revision 이력이 아니라
`Rev0 (2012)`·`Rev6 (2026)`처럼 **연도별 하위 폴더**로 나눠 보관한다(D-60·D-61).
그래서 사용자가 최신 폴더가 아닌 과거 폴더의 자료를 열어도 화면만 봐서는 구본인 줄 모르고,
그대로 업무에 쓰면 사고가 된다. 과거 폴더 자료를 열 때 안내창을 띄우기 위한 판정을
여기 한 곳에만 둔다(화면·API가 함께 쓴다).

판정 방법 (2026-09-29 CM 확정 — 폴더 이름을 코드에 박지 않는다):
  ① 폴더 이름이 `Rev<번호> (<연도>)` 모양이면 Rev 폴더로 본다(대소문자·괄호 앞뒤 공백 무관).
  ② 같은 상위 폴더 바로 밑에 그런 폴더가 **둘 이상** 있을 때만 최신/과거를 가른다.
     하나뿐이면 견줄 상대가 없으므로 아무것도 안내하지 않는다.
  ③ 그중 **Rev 번호가 가장 큰 것이 최신**이고 나머지는 전부 과거다(연도가 아니라 번호로 정한다
     — CM이 "Rev 넘버가 높은 게 최신"이라고 확정).
그래서 앞으로 PFD Rev1·Rev2를 채우거나 다른 폴더를 같은 방식으로 정리해도 코드를 안 고쳐도 된다.

자료가 하나도 없는 빈 폴더(folder_placeholders)는 세지 않는다 — 새 Rev 폴더를 먼저 만들어
두고 자료를 아직 안 올린 사이에 "최신은 (비어 있는) Rev7"이라고 안내하면 갈 곳이 없어진다.
"""

import re
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Document

# `Rev0 (2012)` · `REV 6(2026)` 까지 같은 것으로 본다. 연도는 참고 표시라 없어도 된다.
REV_FOLDER_RE = re.compile(r"^rev\s*(\d+)\s*(?:\(\s*(\d{4})\s*\))?$", re.IGNORECASE)


def parse_rev_folder(name: str) -> Optional[int]:
    """폴더 이름이 Rev 폴더 모양이면 Rev 번호, 아니면 None."""
    m = REV_FOLDER_RE.match((name or "").strip())
    return int(m.group(1)) if m else None


def split_parent(path: str) -> tuple[str, str]:
    """경로를 (상위 폴더, 마지막 폴더 이름)으로 나눈다."""
    head, sep, tail = (path or "").rpartition("\\")
    return (head, tail) if sep else ("", path or "")


def outdated_rev_folders(db: Session) -> dict[str, dict]:
    """최신이 아닌 Rev 폴더 → {"folder": 그 폴더 이름, "latest": 같은 자리 최신 폴더 이름}.

    키는 그 폴더의 전체 경로(documents.source_path 그대로)다.
    """
    paths = [
        p for (p,) in db.query(Document.source_path)
        .filter(Document.is_archived.is_(False), Document.source_path.isnot(None))
        .distinct()
        if p
    ]

    # 상위 폴더별로 Rev 폴더를 모은다 → {상위 경로: [(번호, 폴더 이름, 전체 경로), ...]}
    groups: dict[str, list[tuple[int, str, str]]] = {}
    for path in paths:
        parent, name = split_parent(path)
        rev = parse_rev_folder(name)
        if rev is None:
            continue
        groups.setdefault(parent, []).append((rev, name, path))

    outdated: dict[str, dict] = {}
    for siblings in groups.values():
        if len(siblings) < 2:
            continue  # 혼자 있는 Rev 폴더는 견줄 상대가 없다
        latest_rev, latest_name, _ = max(siblings, key=lambda s: s[0])
        for rev, name, path in siblings:
            if rev == latest_rev:
                continue
            outdated[path] = {"folder": name, "latest": latest_name}
    return outdated
