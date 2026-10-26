"""엑셀 내보내기.

기존 시스템은 17종의 엑셀 내보내기를 요청 스레드에서 만들었다. 1만 행이면 화면이 멈췄다.
여기서는 워커가 만들고 진행률을 보고하며, 결과는 blob 으로 저장해 nginx 가 직송한다.

보안: 셀 값이 =, +, -, @ 로 시작하면 엑셀이 수식으로 해석한다(CSV injection).
기존 시스템의 neutralize_formulas 와 같은 처리를 유지한다.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import psycopg
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .. import blob
from ..config import Config

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def neutralize(value: Any) -> Any:
    """사람이 적은 글자가 수식으로 해석되지 않게 한다."""
    if isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
        return "'" + value
    return value


# 내보내기 대상별 (제목, 컬럼 라벨, SQL).
# 화면의 검색 조건을 그대로 받아 같은 결과를 전량 뽑는다.
SPECS: dict[str, dict[str, Any]] = {
    "tdb_documents": {
        "sheet": "TDB 자료",
        "columns": [
            ("No", 6), ("자료명", 22), ("내용", 40), ("폴더", 20), ("분류", 14),
            ("Rev", 7), ("상태", 12), ("원본/사본", 12), ("대여중", 18), ("최종수정", 13),
        ],
        "sql": """
            SELECT row_number() OVER (ORDER BY d.updated_at DESC, d.id DESC) AS no,
                   d.drawing_no, d.title, f.name AS folder, d.doc_type,
                   'Rev' || d.current_rev AS rev,
                   CASE d.status WHEN 'ACTIVE' THEN '정상' WHEN 'PENDING' THEN '검수'
                                 WHEN 'SUPERSEDED' THEN '구본'
                                 WHEN 'MERGE_REQUIRED' THEN '병합 필요'
                                 ELSE '폐기' END AS status,
                   concat_ws('/', CASE WHEN d.has_dwg THEN 'DWG' END,
                                  CASE WHEN d.has_pdf THEN 'PDF' END) AS hold,
                   lent.vendor_name,
                   to_char(d.updated_at, 'YYYY-MM-DD') AS updated
              FROM documents d
              JOIN folders f ON f.id = d.folder_id
         LEFT JOIN LATERAL (SELECT vendor_name FROM distributions
                             WHERE document_id = d.id AND returned_at IS NULL
                             ORDER BY distributed_at DESC LIMIT 1) lent ON true
             WHERE d.status <> 'RETIRED' AND NOT d.is_archived
               AND (%(include_isometric)s OR NOT d.is_isometric)
               AND (%(q)s IS NULL OR d.search_text ILIKE '%%' || %(q)s || '%%')
               AND (%(folder_ids)s IS NULL OR d.folder_id = ANY(%(folder_ids)s))
             ORDER BY d.updated_at DESC, d.id DESC
        """,
    },
    "audit_log": {
        "sheet": "시스템 로그",
        "columns": [("No", 6), ("시각", 20), ("사용자", 14), ("화면", 16),
                    ("동작", 18), ("자료명", 32), ("접속 주소", 16)],
        "sql": """
            SELECT row_number() OVER (ORDER BY occurred_at DESC) AS no,
                   to_char(occurred_at, 'YYYY-MM-DD HH24:MI:SS') AS at,
                   user_name, screen, action, target, host(client_ip) AS ip
              FROM audit_log
             WHERE (%(q)s IS NULL OR target ILIKE '%%' || %(q)s || '%%')
             ORDER BY occurred_at DESC
        """,
    },
}

HEADER_FILL = PatternFill("solid", fgColor="F0F0EE")


def run(
    conn: psycopg.Connection,
    cfg: Config,
    payload: dict[str, Any],
    progress: Callable[..., None],
) -> dict[str, Any]:
    target = payload["target"]
    spec = SPECS.get(target)
    if spec is None:
        raise ValueError(f"지원하지 않는 내보내기 대상: {target}")

    filters = payload.get("filters") or {}

    if target == "tdb_documents":
        where_clauses = ["d.status <> 'RETIRED'"]
        status = filters.get("status", "all")
        if status == "normal":
            where_clauses.append("d.status = 'ACTIVE' AND NOT d.is_archived")
        elif status == "review":
            where_clauses.append("d.status = 'PENDING'")
        elif status == "distributed":
            where_clauses.append("lent.vendor_name IS NOT NULL")
        elif status == "archived":
            where_clauses.append("d.is_archived")
        else:
            where_clauses.append("NOT d.is_archived")

        hold = filters.get("hold", "all")
        if hold == "both":
            where_clauses.append("d.has_dwg AND d.has_pdf")
        elif hold == "dwg_only":
            where_clauses.append("d.has_dwg AND NOT d.has_pdf")
        elif hold == "pdf_only":
            where_clauses.append("d.has_pdf AND NOT d.has_dwg")

        if not bool(filters.get("includeIsometric", False)):
            where_clauses.append("NOT d.is_isometric")

        params: dict[str, Any] = {}
        q = filters.get("q")
        if q:
            params["q"] = f"%{q}%"
            search_target = filters.get("searchTarget", "title")
            if search_target == "folder":
                where_clauses.append("f.name ILIKE %(q)s")
            else:
                where_clauses.append("d.search_text ILIKE %(q)s")

        folder_ids = filters.get("folderIds")
        if folder_ids:
            params["folder_ids"] = list(folder_ids)
            where_clauses.append("d.folder_id = ANY(%(folder_ids)s)")

        sql = f"""
            SELECT row_number() OVER (ORDER BY d.updated_at DESC, d.id DESC) AS no,
                   d.drawing_no, d.title, f.name AS folder, d.doc_type,
                   'Rev' || d.current_rev AS rev,
                   CASE d.status WHEN 'ACTIVE' THEN '정상' WHEN 'PENDING' THEN '검수'
                                 WHEN 'SUPERSEDED' THEN '구본'
                                 WHEN 'MERGE_REQUIRED' THEN '병합 필요'
                                 ELSE '폐기' END AS status,
                   concat_ws('/', CASE WHEN d.has_dwg THEN 'DWG' END,
                                  CASE WHEN d.has_pdf THEN 'PDF' END) AS hold,
                   lent.vendor_name,
                   to_char(d.updated_at, 'YYYY-MM-DD') AS updated
              FROM documents d
              JOIN folders f ON f.id = d.folder_id
         LEFT JOIN LATERAL (SELECT vendor_name FROM distributions
                             WHERE document_id = d.id AND returned_at IS NULL
                             ORDER BY distributed_at DESC LIMIT 1) lent ON true
             WHERE {' AND '.join(where_clauses)}
             ORDER BY d.updated_at DESC, d.id DESC
        """
    else:
        params = {
            "q": filters.get("q") or None,
        }
        sql = spec["sql"]

    progress(5, "자료를 읽는 중")

    wb = Workbook(write_only=True)
    ws = wb.create_sheet(spec["sheet"])
    ws.freeze_panes = "A2"

    from openpyxl.cell import WriteOnlyCell

    header = []
    for label, width in spec["columns"]:
        cell = WriteOnlyCell(ws, value=label)
        cell.font = Font(bold=True)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        header.append(cell)
    ws.append(header)
    ws.column_dimensions  # noqa: B018 — write_only 에서는 append 전에 폭을 잡는다
    for i, (_label, width) in enumerate(spec["columns"], start=1):
        ws.column_dimensions[get_column_letter(i)].width = width

    written = 0
    with conn.cursor(name="export_cursor") as cur:   # 서버 커서 — 전량을 메모리에 올리지 않는다
        cur.itersize = 2000
        cur.execute(sql, params)
        for row in cur:
            ws.append([neutralize(v) for v in row])
            written += 1
            if written % 2000 == 0:
                progress(min(90, 5 + written // 500), f"{written:,}행 기록")

    progress(92, "파일로 쓰는 중")

    cfg.tmp.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    tmp_path: Path = cfg.tmp / f"export-{target}-{stamp}.xlsx"
    wb.save(tmp_path)

    progress(97, "저장소에 넣는 중")
    sha_hex, size = blob.store_file(cfg.blobs, tmp_path)

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO blobs (sha256, byte_size) VALUES (decode(%s,'hex'), %s)"
            " ON CONFLICT (sha256) DO NOTHING",
            (sha_hex, size),
        )
    conn.commit()

    filename = payload.get("filename") or f"{spec['sheet']}_{stamp}.xlsx"
    progress(100, f"{written:,}행 완료")
    return {"filename": filename, "sha256": sha_hex, "byteSize": size, "rowCount": written}
