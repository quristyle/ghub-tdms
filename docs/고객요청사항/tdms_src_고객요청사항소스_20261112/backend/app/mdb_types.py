"""설비유형·자료유형처럼 자료 1건에 여러 개를 붙일 수 있는 "유형" 값 다루기
(2026-08-28 CM 확정). 규칙을 이 파일 한 곳에만 둔다 — mdb_group.py가 "자료 1건"의
정의를 한 곳에 모아둔 것과 같은 이유다.

값은 슬래시로 이어 붙인 문자열 하나로 저장한다.

    mdb_files.equipment_type = "Pump/Strainer"
    mdb_files.doc_type       = "Data Sheet/Manual"

따로 표를 만들지 않은 이유: 자료 1건이 파일 여러 개(원본+PDF 사본)로 이뤄져 있어 어차피
파일마다 같은 값을 써주고 있고, 표를 더 두면 자료를 옮기거나 파일을 붙일 때 같이 고쳐야
할 자리만 늘어난다. 화면에 보이는 그대로("Pump/Strainer")가 저장값이라 읽기도 쉽다.

검색은 **하나라도 맞으면 걸린다** — Pump로 검색하면 "Pump/Strainer"인 자료도 나온다.
그래서 목록(equipment_types·mdb_doc_types)에 등록하는 이름에는 슬래시를 못 쓰게 막는다
(이름 안에 슬래시가 있으면 두 개로 쪼개져 보인다 — type_lists.py에서 검사).
"""

from typing import Iterable, Optional

SEPARATOR = "/"


def split_types(value: Optional[str]) -> list[str]:
    """저장된 문자열 → 유형 목록. 빈 조각과 앞뒤 공백은 버린다."""
    if not value:
        return []
    return [part.strip() for part in value.split(SEPARATOR) if part.strip()]


def join_types(values: Optional[Iterable[str]], *, sort: bool = False) -> Optional[str]:
    """유형 목록 → 저장할 문자열. 대소문자만 다른 중복은 하나만 남기고, 하나도 없으면 None
    (컬럼이 비어 있는 것 = 유형 미지정).

    sort=True면 알파벳순(대소문자 무시)으로 정렬해 이어 붙인다 — 자료유형(doc_type)만 쓴다
    (2026-08-31 CM 확정: "Schedule과 List를 선택하면 List/Schedule"). 고른 순서를 그대로
    지키는 설비유형(equipment_type)에는 쓰지 않는다."""
    result: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        name = (value or "").strip()
        if not name or name.upper() in seen:
            continue
        seen.add(name.upper())
        result.append(name)
    if sort:
        result.sort(key=str.upper)
    return SEPARATOR.join(result) or None


def normalize(value: Optional[str], *, sort: bool = False) -> Optional[str]:
    """화면에서 온 문자열을 저장할 모양으로 정리한다(빈 조각·중복 제거, sort=True면 알파벳순)."""
    return join_types(split_types(value), sort=sort)


def matches(value: Optional[str], wanted: Optional[str]) -> bool:
    """검색 조건에 걸리는지 — 붙어 있는 유형 중 하나라도 wanted와 같으면 True(대소문자 무시)."""
    if not wanted:
        return True
    needle = wanted.strip().upper()
    return any(t.upper() == needle for t in split_types(value))


def type_set(value: Optional[str]) -> set[str]:
    """대소문자를 무시하고 비교할 때 쓰는 집합(Tag No 검색의 공용자료 찾기 등)."""
    return {t.upper() for t in split_types(value)}


def rename_type(value: Optional[str], old: str, new: str, *, sort: bool = False) -> tuple[Optional[str], bool]:
    """목록에서 이름을 바꿨을 때, 저장값 안의 그 조각만 갈아끼운다.
    ("Pump/Strainer", "Pump" → "펌프") → ("펌프/Strainer", True)

    sort=True(자료유형)면 갈아끼운 뒤 알파벳순으로 다시 정렬한다 — 새 이름이 원래 자리와
    다른 알파벳 순서에 놓이면 저장값이 정렬 규칙에서 어긋나므로."""
    parts: list[str] = []
    changed = False
    for t in split_types(value):
        if t.upper() == old.upper():
            parts.append(new)
            changed = True
        else:
            parts.append(t)
    return (join_types(parts, sort=sort), changed) if changed else (value, False)
