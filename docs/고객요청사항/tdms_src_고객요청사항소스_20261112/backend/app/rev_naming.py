"""TDB 자료명·파일명 끝의 리비전 꼬리(`_Rev00`) 규칙 (2026-10-01 CM 지시).

업체가 Rev1을 받아 가서 Rev1 이름 그대로 돌려주면 "수정한 자료"인지 "받아 간 자료"인지
헷갈린다. 그래서 TDB 자료는 화면·다운로드·저장 파일 이름 끝에 늘 리비전 번호를 붙인다.

    도면번호(DB drawing_no)   TT01-10-65-057          ← 바뀌지 않는다. 꼬리는 여기 넣지 않는다
    화면 자료명               TT01-10-65-057_Rev00    ← 리비전 번호로 만들어 붙인다
    파일 이름                 TT01-10-65-057_Rev00.dwg
    반입 정상                 TT01-10-65-057_Rev01.dwg (반출 Rev + 1)

꼬리를 DB에 넣지 않는 이유: 리비전이 오를 때마다 자료명이 바뀌면 예전 반출 기록·시스템
로그·보관 목록이 가리키는 이름이 전부 어긋난다. 꼬리는 늘 리비전 번호에서 만들어 낸다.

형식은 정확히 `_Rev` + 두 자리 이상 숫자이고, 그 뒤에는 아무것도 붙지 않는다.
`REV01`·`_R01`·`rev01`·`_Revision01`·`_Rev1`·`_Rev_01`·`_Rev01_a`·`_Rev01(완료)`·`_Rev01.`
같은 변형은 전부 형식 오류다(대소문자까지 정확히). 분기·반려 이력만 `_Rev02a`처럼 글자가
붙는데, 이것은 시스템이 이력에 붙이는 표시라 사람이 적거나 업체가 보내는 이름에는 쓰지 않는다.

P&ID·PFD는 리비전을 `Rev0 (2012)` 같은 연도별 폴더로 나눠 관리하므로 꼬리를 붙이지 않는다 —
폴더 이름에 `(P&ID)`·`(PFD)`가 들어 있는 자리의 하위 전부가 대상에서 빠진다.

이 규칙은 여기 한 곳에만 둔다(저장 위치·화면·다운로드·반출·반입 검수가 함께 쓴다).
"""

import re
from typing import Optional

REV_TAG = "_Rev"

# 이 표시가 들어 있는 폴더의 하위 전부는 꼬리를 붙이지 않는다(대소문자 무관).
EXCLUDED_FOLDER_MARKERS = ("(P&ID)", "(PFD)")

# 정상 형식 — 이름 끝이 정확히 `_Rev` + 숫자. 숫자 자리 수가 맞는지는 아래 함수가 따로 본다.
STRICT_TAIL_RE = re.compile(r"^(?P<base>.+)_Rev(?P<num>[0-9]+)$")

# 리비전 표기로 보이는 꼬리(형식이 틀린 것까지). 구분자(공백·_·-·.·괄호) 뒤에 Rev/R/Revision과
# 숫자가 오고, 그 뒤에 짧은 군더더기(`.`·`_a`·`(완료)` 등)만 남은 모양이다.
# 앞이 구분자여야 하므로 `11022pdr01`·`03-OR01`처럼 도면번호 일부인 것은 잡지 않는다.
LOOSE_TAIL_RE = re.compile(
    r"[\s_\-.(]+(?:revision|rev|r)[\s_\-.]*(?P<num>[0-9]{1,3})(?![0-9]).{0,12}$",
    re.IGNORECASE,
)

# 도면번호를 이미 알 때, 도면번호 **뒤에 남은 부분**이 리비전 표기(변형 포함)인지. 이때는 앞의
# 구분자가 없어도(`이름Rev01`) 형식 오류로 잡는다.
REMAINDER_TAIL_RE = re.compile(
    r"^[\s_\-.(]*(?:revision|rev|r)[\s_\-.]*[0-9]{1,3}(?![0-9]).{0,12}$",
    re.IGNORECASE,
)


def applies_to(source_path: Optional[str]) -> bool:
    """이 경로의 자료에 꼬리를 붙이는지. P&ID·PFD 폴더 하위면 False."""
    upper = (source_path or "").upper()
    return not any(marker in upper for marker in EXCLUDED_FOLDER_MARKERS)


def rev_text(rev: int, branch: Optional[str] = None) -> str:
    """`Rev00`, `Rev02a` — 두 자리에 못 미치면 앞에 0을 채운다(100 이상은 그대로)."""
    return f"Rev{rev:02d}{branch or ''}"


def rev_suffix(rev: int, branch: Optional[str] = None) -> str:
    return f"_{rev_text(rev, branch)}"


def rev_name(drawing_no: str, rev: int, branch: Optional[str], source_path: Optional[str]) -> str:
    """화면 자료명·파일 이름(확장자 앞)에 쓸 이름. P&ID·PFD면 도면번호 그대로."""
    if not applies_to(source_path):
        return drawing_no
    return f"{drawing_no}{rev_suffix(rev, branch)}"


def parse_rev_name(stem: str) -> Optional[tuple[str, int]]:
    """정상 형식(`이름_Rev01`)이면 (이름, 번호), 아니면 None.

    `_Rev1`(한 자리)·`_Rev001`(쓸데없는 0)처럼 숫자 모양이 시스템이 만드는 모양과 다르면
    형식 오류로 본다 — 시스템이 붙이는 꼬리와 글자 하나까지 같아야 한다.
    """
    match = STRICT_TAIL_RE.match(stem or "")
    if not match:
        return None
    num = int(match.group("num"))
    if match.group("num") != f"{num:02d}":
        return None
    return match.group("base"), num


def has_rev_tail(name: str) -> bool:
    """이름 끝에 리비전 표기(정상이든 변형이든)가 붙어 있는지.

    사람이 자료명을 적는 자리에서 쓴다 — 꼬리는 시스템이 붙이므로 사람이 적으면 안 된다
    (그대로 받으면 `이름_Rev00_Rev00`이 된다).
    """
    return parse_rev_name(name) is not None or LOOSE_TAIL_RE.search(name or "") is not None


def guess_base(stem: str) -> Optional[str]:
    """리비전 표기로 보이는 꼬리를 뗀 이름(형식이 틀렸어도). 꼬리가 없으면 None.

    어느 자료 것인지 모르는 반입 파일의 짝을 찾을 때만 쓴다 — 찾은 뒤의 판정은
    check_incoming_name이 한다.
    """
    parsed = parse_rev_name(stem)
    if parsed:
        return parsed[0]
    match = LOOSE_TAIL_RE.search(stem or "")
    if match and match.start() > 0:
        return stem[: match.start()]
    return None


# check_incoming_name 결과
NAME_OK = "OK"                # 형식 맞고 번호도 기대한 번호
NAME_MISSING = "MISSING"      # 꼬리가 아예 없음
NAME_MALFORMED = "MALFORMED"  # 꼬리 모양이 규칙과 다름
NAME_MISMATCH = "MISMATCH"    # 형식은 맞는데 번호가 기대한 번호와 다름
NAME_OTHER = "OTHER"          # 아예 다른 자료 이름


def check_incoming_name(stem: str, drawing_no: str, expected_rev: int) -> tuple[str, Optional[int]]:
    """반입 파일 이름(확장자 뗀 것)을 그 자료의 도면번호·기대 Rev와 견준다.

    반환: (판정, 파일에 적힌 번호 — 정상 형식일 때만). 도면번호 부분은 지금까지 반입 검수가
    해 온 대로 대소문자를 가리지 않는다. 꼬리(`_Rev`)만 대소문자까지 정확히 본다.
    """
    stem = stem or ""
    base_lower = (drawing_no or "").lower()
    if stem.lower() == base_lower:
        return NAME_MISSING, None
    parsed = parse_rev_name(stem)
    if parsed and parsed[0].lower() == base_lower:
        number = parsed[1]
        return (NAME_OK if number == expected_rev else NAME_MISMATCH), number
    # 도면번호 뒤에 남은 것이 리비전 표기 모양일 때만 형식 오류다. `T01-10-50-1_Rev01`처럼
    # 다른 자료 이름이 우연히 같은 글자로 시작하는 것은 형식 오류가 아니라 다른 자료다.
    if stem.lower().startswith(base_lower) and REMAINDER_TAIL_RE.match(stem[len(base_lower):]):
        return NAME_MALFORMED, None
    return NAME_OTHER, None


# --- ORM 행에서 바로 쓰는 도우미 (documents·files 행의 속성만 읽는다) -------------------------

def document_display_name(doc) -> str:
    """목록·상세보기에 보이는 자료명 — 지금 승인된 리비전 번호로 꼬리를 붙인다."""
    return rev_name(doc.drawing_no, doc.current_rev or 0, None, doc.source_path)


def file_display_name(doc, file_row) -> str:
    """파일 한 개(또는 같은 리비전 세트)의 자료명 — 그 파일의 리비전·분기 글자로 꼬리를 붙인다.

    이력 파일은 디스크 이름이 업체가 보낸 그대로(`_R0` 등)일 수 있지만, 화면과 다운로드에는
    이 이름으로 보여 준다(2026-10-01 CM — 이력 폴더 파일 이름은 안 바꾸기로 함).
    """
    return rev_name(doc.drawing_no, file_row.rev, file_row.branch, doc.source_path)


def strip_rev_tail(text: str) -> str:
    """검색어 끝에 정상 꼬리(`_Rev01`)가 붙어 있으면 뗀다 — 화면에 보이는 이름을 그대로 붙여
    넣어 검색해도 찾히게. 꼬리는 DB에 없으므로 붙인 채로는 아무것도 안 걸린다."""
    parsed = parse_rev_name(text or "")
    return parsed[0] if parsed else (text or "")


def distribution_display_name(doc, dist) -> str:
    """반출 기록의 자료명 — 그때 업체에 나간 파일 이름 그대로(반출 당시 Rev의 꼬리)."""
    return rev_name(doc.drawing_no, dist.rev_at_distribution, None, doc.source_path)


# --- 사람이 올리는 파일·적는 자료명 검사 (반입 말고 다른 자리 — 2026-10-01 CM "형식 규칙을 다른 곳에도") ---
# 관리 화면(자료 교체·신규추가·Zip 등록·분기 병합본)에서 CM이 직접 올리는 파일은 꼬리가 없어도
# 된다 — 시스템이 저장할 때 붙인다. 꼬리를 붙였다면 정확한 형식에 그 작업의 Rev 번호여야 한다.

TAIL_RULE_TEXT = "'_Rev' + 두 자리 숫자, 뒤에 아무것도 붙이지 않음"


def upload_base_name(stem: str) -> str:
    """올린 파일 이름에서 정상 꼬리(`_Rev01`)를 뗀 이름 — 어느 자료 것인지 찾을 때 쓴다."""
    parsed = parse_rev_name(stem or "")
    return parsed[0] if parsed else (stem or "")


def upload_tail_problem(stem: str, drawing_no: str, source_path: Optional[str], target_rev: int) -> Optional[str]:
    """이 자료(drawing_no)에 올린 파일 이름의 꼬리가 잘못됐으면 그 설명, 괜찮으면 None.

    꼬리 없는 이름은 괜찮다. 다른 자료 이름(OTHER)도 여기서는 문제 삼지 않는다 — 이름이 그
    자료와 맞는지는 부르는 쪽이 원래 하던 대로 본다. P&ID·PFD는 이 규칙 밖이다.
    """
    if not applies_to(source_path):
        return None
    verdict, number = check_incoming_name(stem, drawing_no, target_rev)
    expected = f"{drawing_no}{rev_suffix(target_rev)}"
    if verdict == NAME_MALFORMED:
        return (f"'{stem}' — 리비전 표기 형식이 다릅니다({TAIL_RULE_TEXT}). "
                f"'{expected}'로 고치거나 표기 없이 '{drawing_no}'로 올려 주세요.")
    if verdict == NAME_MISMATCH:
        return (f"'{stem}' — 리비전 번호가 다릅니다. 이 작업은 Rev{target_rev:02d}이므로 "
                f"'{expected}'로 고치거나 표기 없이 '{drawing_no}'로 올려 주세요.")
    return None


def new_name_tail_problem(name: str, source_path: Optional[str]) -> Optional[str]:
    """사람이 새로 적는 자료명(자료명 변경·신규 등록)에 리비전 표기가 붙어 있으면 그 설명.

    꼬리는 시스템이 붙이므로 적으면 안 된다(그대로 받으면 `이름_Rev00_Rev00`이 된다).
    """
    if not applies_to(source_path) or not has_rev_tail(name):
        return None
    base = guess_base(name) or name
    return (f"자료명 끝에 리비전 표기를 적지 않습니다 — 시스템이 '_Rev00'처럼 자동으로 붙입니다. "
            f"'{base}'처럼 표기 없이 적어 주세요.")


def new_upload_name(stem: str, source_path: Optional[str], target_rev: int) -> tuple[str, Optional[str]]:
    """새 자료를 만들 파일(신규추가·Zip 등록)의 (자료명, 문제 설명).

    정상 꼬리면 떼고 그 번호가 등록할 Rev와 같은지 본다. 형식이 틀린 꼬리는 문제로 돌려준다.
    P&ID·PFD는 파일 이름 그대로가 자료명이다(예전과 같다).
    """
    if not applies_to(source_path):
        return stem, None
    parsed = parse_rev_name(stem)
    if parsed:
        base, number = parsed
        if number != target_rev:
            return base, (f"'{stem}' — 리비전 번호가 다릅니다. 이번 등록은 Rev{target_rev:02d}이므로 "
                          f"'{base}{rev_suffix(target_rev)}'로 고치거나 표기 없이 '{base}'로 올려 주세요.")
        return base, None
    if has_rev_tail(stem):
        base = guess_base(stem) or stem
        return stem, (f"'{stem}' — 리비전 표기 형식이 다릅니다({TAIL_RULE_TEXT}). "
                      f"'{base}{rev_suffix(target_rev)}'로 고치거나 표기 없이 '{base}'로 올려 주세요.")
    return stem, None
