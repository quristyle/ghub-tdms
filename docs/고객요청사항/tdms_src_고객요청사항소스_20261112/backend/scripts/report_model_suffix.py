# -*- coding: utf-8 -*-
"""'-Model' 접미사 자료 <-> 원본 자료 매칭 조사 리포트 (일회성 조사용 스크립트, 2차 수정판).

CM 지적사항 반영: 이름이 같은 후보가 여러 개일 때, 폴더가 다른 것끼리도 후보로
섞여 나와서 혼란을 줬음. -> 이번 버전은 **폴더 경로가 완전히 같은 것만** 매칭으로
인정한다. 폴더가 다르면 이름이 같아도 다른 자료로 취급하고, 매칭 후보에서 제외한다
(참고용으로만 별도 표시).
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.append(".")

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

from app.database import SessionLocal
from app.models import Document

SUFFIX_RE = re.compile(r'^(.*)-model$', re.IGNORECASE)

session = SessionLocal()
all_docs = session.query(Document).all()

by_name_lower = defaultdict(list)
for d in all_docs:
    by_name_lower[d.drawing_no.strip().lower()].append(d)

model_docs = [d for d in all_docs if SUFFIX_RE.match(d.drawing_no.strip())]
model_docs.sort(key=lambda d: d.drawing_no)

def holding(d):
    parts = []
    if d.has_dwg:
        parts.append("DWG")
    if d.has_pdf:
        parts.append("PDF")
    return "+".join(parts) if parts else "-"

report_rows = []
matched_count = 0        # 동일 폴더 후보가 1건 이상 있어 매칭됨
no_folder_match_count = 0  # 이름은 같은 게 있지만 같은 폴더엔 없음
truly_no_name_count = 0  # 이름 자체가 같은 게 하나도 없음

for d in model_docs:
    base_name = SUFFIX_RE.match(d.drawing_no.strip()).group(1).strip()
    all_same_name = [c for c in by_name_lower.get(base_name.lower(), []) if c.id != d.id]
    same_folder = [c for c in all_same_name if c.source_path == d.source_path]

    if same_folder:
        matched_count += 1
        for c in same_folder:
            report_rows.append({
                "model_doc": d, "base_name": base_name,
                "cand": c, "status": "매칭(동일 폴더)",
                "other_folder_count": 0,
            })
    else:
        if all_same_name:
            no_folder_match_count += 1
            status = "이름은 같으나 동일 폴더 후보 없음"
        else:
            truly_no_name_count += 1
            status = "짝 이름 자체가 없음"
        report_rows.append({
            "model_doc": d, "base_name": base_name,
            "cand": None, "status": status,
            "other_folder_count": len(all_same_name),
        })

# ---- 엑셀 작성 ----
wb = Workbook()
ws = wb.active
ws.title = "Model접미사 매칭(동일폴더만)"

headers = [
    "No", "Model문서ID", "Model 자료명", "Model 폴더경로", "Model 보유파일",
    "매칭문서ID", "매칭 자료명(짝)", "매칭 폴더경로", "매칭 보유파일",
    "상태", "다른 폴더 동명 후보수",
    "승인(예/아니오)", "비고",
]
ws.append(headers)
header_fill = PatternFill(start_color="1C1C1B", end_color="1C1C1B", fill_type="solid")
for col_idx, h in enumerate(headers, start=1):
    c = ws.cell(row=1, column=col_idx)
    c.font = Font(color="FFFFFF", bold=True)
    c.fill = header_fill
    c.alignment = Alignment(horizontal="center", vertical="center")

warn_fill = PatternFill(start_color="FFF3CD", end_color="FFF3CD", fill_type="solid")
same_fill = PatternFill(start_color="E6F4EA", end_color="E6F4EA", fill_type="solid")

# 정렬: 매칭된 것 먼저, 그다음 상태별로 묶어서 보기 쉽게
order_key = {"매칭(동일 폴더)": 0, "이름은 같으나 동일 폴더 후보 없음": 1, "짝 이름 자체가 없음": 2}
report_rows.sort(key=lambda r: (order_key[r["status"]], r["model_doc"].drawing_no))

row_no = 0
for r in report_rows:
    d = r["model_doc"]
    c = r["cand"]
    row_no += 1
    note = ""
    if c is not None:
        if c.has_pdf and d.has_pdf:
            note = "⚠ 매칭 문서에도 이미 PDF가 있음 - 합치면 충돌 가능, 확인 필요"
    else:
        if r["other_folder_count"] > 0:
            note = f"참고: 다른 폴더에 이름 같은 자료가 {r['other_folder_count']}건 있음(매칭 대상 아님)"
        else:
            note = "원본 이름의 자료를 DB에서 찾을 수 없음"

    values = [
        row_no,
        d.id,
        d.drawing_no,
        d.source_path or "",
        holding(d),
        c.id if c else "",
        c.drawing_no if c else "",
        (c.source_path or "") if c else "",
        holding(c) if c else "",
        r["status"],
        r["other_folder_count"],
        "",
        note,
    ]
    ws.append(values)
    excel_row = ws.max_row
    if r["status"] == "매칭(동일 폴더)":
        ws.cell(row=excel_row, column=10).fill = same_fill
    else:
        for col in range(1, len(headers) + 1):
            ws.cell(row=excel_row, column=col).fill = warn_fill

# 승인 컬럼에 드롭다운(예/아니오) 적용 - 매칭된 행에만
dv = DataValidation(type="list", formula1='"예,아니오"', allow_blank=True)
ws.add_data_validation(dv)
for i, r in enumerate(report_rows, start=2):
    if r["cand"] is not None:
        dv.add(ws.cell(row=i, column=12))

widths = [5, 11, 26, 40, 12, 11, 26, 40, 12, 24, 14, 14, 45]
for i, w in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(i)].width = w

ws.freeze_panes = "A2"
ws.auto_filter.ref = ws.dimensions

out_path = Path("..") / "Model접미사_매칭조사_동일폴더_20260806.xlsx"
wb.save(out_path)

print(f"'-Model' 접미사 문서 총 {len(model_docs)}건")
print(f"  - 동일 폴더 매칭됨: {matched_count}건")
print(f"  - 이름은 같은게 있으나 동일 폴더엔 없음(수동확인 필요): {no_folder_match_count}건")
print(f"  - 짝 이름 자체가 없음: {truly_no_name_count}건")
print(f"저장 위치: {out_path.resolve()}")
