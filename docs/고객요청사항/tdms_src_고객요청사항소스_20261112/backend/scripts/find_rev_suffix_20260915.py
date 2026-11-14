"""TDB 자료명(drawing_no)에 리비전 표기(R0, r1, Rev.0, rev 0 등)가 박혀 있는 것을 찾아
목록만 엑셀로 뽑는 조회 전용 스크립트 (2026-09-15, CM 요청, 3차 개정).

자료명에 R0/R1/Rev.0 같은 리비전 번호가 박혀 있으면, 나중에 리비전이 올라가 업체가
파일명을 R1로 바꿔 보낼 때 시스템은 그것을 "다른 자료"로 인식해 리비전 이력이 이어지지
않는다. CM이 이 목록을 보고 "표기를 떼도 되는지" 눈으로 확인한 뒤, 문제없는 것만 별도
지시로 일괄 정리한다. 이 스크립트는 DB를 전혀 바꾸지 않는다(조회만).

이번 개정: C열 "자료명(변경계획)"을 추가해 B열에서 리비전·날짜 표기만 기계적으로 제거한
미리보기를 넣는다. B열에서 실제로 사라지는 글자는 빨간색으로 표시한다(리치 텍스트).
CM이 이 자동 제거안을 보고 맞는지 확인하는 용도이며, 이 시점에는 실제 자료명은 하나도
바뀌지 않는다.

실행:
    venv\\Scripts\\python.exe scripts\\find_rev_suffix_20260915.py
"""

import re
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal  # noqa: E402
from app.models import Document  # noqa: E402

import openpyxl  # noqa: E402
from openpyxl.cell.rich_text import CellRichText, TextBlock  # noqa: E402
from openpyxl.cell.text import InlineFont  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

# --- 1) 목록을 뽑을 때 쓰는 "찾기" 패턴 (2차 개정과 동일, 문자열 어디든) ---
PATTERN_SQL = r"(_|-|\.|\s|\()\s*r\.?\s*[0-9]{1,3}[a-z]?(\s|\)|_|-|\.|$)|rev\.?\s*[0-9]{1,3}"
FIND_PATTERN = re.compile(
    r"(?:_|-|\.|\s|\()\s*r\.?\s*[0-9]{1,3}[a-z]?(?=\s|\)|_|-|\.|$)|rev\.?\s*[0-9]{1,3}",
    re.IGNORECASE,
)

# --- 2) 제거 계획을 세울 때 쓰는 패턴. 괄호로 감싼 표기·뒤에 붙은 날짜까지 한 덩어리로 잡는다 ---
SEP = r"[\s_\-,]"
REV_TOKEN = r"(?:rev\.?\s*[0-9]{1,3}|r\.?[0-9]{1,3}[a-z]?)"
# 괄호로 감싼 경우엔 괄호 자체가 경계라 앞에 글자가 와도 되고("chk(r.2)"), 안 감싼 경우엔
# 앞이 영문자로 이어지면(=다른 단어의 일부) 매칭하지 않는다("AR001" 안의 "R0" 오매칭 방지)
CORE = r"(?:\(\s*" + REV_TOKEN + r"\s*\)|(?<![A-Za-z])" + REV_TOKEN + r")"
DATEPART = r"(?:" + SEP + r"+[0-9]{4,8})?"

REMOVE_PATTERN = re.compile(
    r"(?P<lead>" + SEP + r"*)"
    r"(?P<core>" + CORE + DATEPART + r")"
    r"(?P<trail>" + SEP + r"*)",
    re.IGNORECASE,
)


def plan_removal(name: str):
    """자료명에서 리비전·날짜 표기를 제거한 새 이름과, 원본에서 빨갛게 표시할 구간(삭제될 부분)을 계산한다.

    반환: (new_name, removed_ranges) — removed_ranges는 원본 문자열 기준 (start, end) 목록
    """
    removed_ranges = []
    cursor = 0
    result_parts = []

    for m in REMOVE_PATTERN.finditer(name):
        core_s, core_e = m.span("core")
        lead_s, lead_e = m.span("lead")
        trail_s, trail_e = m.span("trail")

        # 진짜 리비전 표기가 아니면(= core가 사실상 빈 매칭이면) 건너뜀
        if core_s == core_e:
            continue

        at_start = lead_s == 0
        at_end = trail_e == len(name)

        if at_start or at_end:
            # 문자열 맨 앞이나 맨 끝에 붙어 있으면 표기+구분자를 통째로 없앤다
            remove_s, remove_e = lead_s, trail_e
        elif lead_e > lead_s:
            # 중간에 있고 앞쪽에 구분자가 있으면: 앞 구분자 하나만 남기고 표기+뒤 구분자를 없앤다
            remove_s, remove_e = core_s, trail_e
        elif trail_e > trail_s:
            # 앞쪽 구분자가 없고 뒤쪽에만 있으면: 뒤 구분자를 남기고 표기만 없앤다
            remove_s, remove_e = core_s, core_e
        else:
            # 앞뒤 다 구분자가 없는 예외적인 경우: 표기만 없앤다
            remove_s, remove_e = core_s, core_e

        if remove_s < cursor:
            continue  # 겹치는 매칭은 건너뜀(방어적)

        result_parts.append(name[cursor:remove_s])
        removed_ranges.append((remove_s, remove_e))
        cursor = remove_e

    result_parts.append(name[cursor:])
    new_name = "".join(result_parts).strip()
    # 끝에 구분자만 덜렁 남는 경우 정리 (예: 맨 끝 쉼표·대시)
    new_name = re.sub(r"[\s_\-,]+$", "", new_name)
    new_name = re.sub(r"^[\s_\-,]+", "", new_name)

    return new_name, removed_ranges


def build_rich_text(name: str, removed_ranges):
    """B열용 리치 텍스트: 삭제될 구간만 빨간색으로 표시."""
    if not removed_ranges:
        return name

    red_font = InlineFont(color="FFFF0000")
    blocks = []
    cursor = 0
    for s, e in removed_ranges:
        if s > cursor:
            blocks.append(name[cursor:s])
        blocks.append(TextBlock(red_font, name[s:e]))
        cursor = e
    if cursor < len(name):
        blocks.append(name[cursor:])

    return CellRichText(*blocks)


def main():
    db = SessionLocal()
    try:
        rows = (
            db.query(Document)
            .filter(Document.is_archived == False)  # noqa: E712
            .filter(Document.drawing_no.op("~*")(PATTERN_SQL))
            .order_by(Document.source_path, Document.drawing_no)
            .all()
        )

        print(f"매칭된 자료 수: {len(rows)}건")

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "리비전표기_목록"

        headers = [
            "No",
            "자료명",
            "자료명(변경계획)",
            "매칭된 표기(전부)",
            "구역",
            "현재Rev",
            "DWG보유",
            "PDF보유",
            "경로",
            "documents.id",
        ]
        ws.append(headers)

        for i, doc in enumerate(rows, start=1):
            name = doc.drawing_no or ""
            matches = [m.group(0).strip() for m in FIND_PATTERN.finditer(name)]
            matched = " / ".join(dict.fromkeys(matches))

            new_name, removed_ranges = plan_removal(name)

            row_idx = i + 1
            ws.cell(row=row_idx, column=1, value=i)
            ws.cell(row=row_idx, column=2, value=build_rich_text(name, removed_ranges))
            ws.cell(row=row_idx, column=3, value=new_name)
            ws.cell(row=row_idx, column=4, value=matched)
            ws.cell(row=row_idx, column=5, value=doc.area or "")
            ws.cell(row=row_idx, column=6, value=doc.current_rev)
            ws.cell(row=row_idx, column=7, value="Y" if doc.has_dwg else "N")
            ws.cell(row=row_idx, column=8, value="Y" if doc.has_pdf else "N")
            ws.cell(row=row_idx, column=9, value=doc.source_path or "")
            ws.cell(row=row_idx, column=10, value=doc.id)

        widths = [6, 55, 55, 22, 22, 8, 8, 8, 70, 12]
        for idx, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(idx)].width = w
        ws.freeze_panes = "A2"

        out_path = Path(__file__).resolve().parents[1] / "scripts" / "리비전표기_붙은_자료_20260915.xlsx"
        wb.save(out_path)
        print(f"저장 완료: {out_path}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
