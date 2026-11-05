# -*- coding: utf-8 -*-
"""TDB "최신" 폴더 파일 이름 끝에 리비전 꼬리(`_Rev00`)를 붙이는 1회성 스크립트 (2026-10-01 CM 지시).

규칙은 app/rev_naming.py에 있다. 이 스크립트는 그 규칙대로 **지금 있는 파일의 이름만** 바꾼다.

무엇을 바꾸나
  - files.is_current=true 이고 "최신" 폴더에 있는 파일 — 확장자 가리지 않고 전부
    (DWG·PDF·엑셀·캐디안 보조 파일까지. 반입·리비전 관리를 한 규칙으로 맞추기 위함 — CM 확정)
  - 삭제 보관함 자료도 파일이 "최신" 폴더에 그대로 있으므로 같이 바꾼다(되살리면 바로 쓰이므로)
  - 파일은 **그 자리에서 이름만** 바꾼다(폴더 이동 없음). files.file_path도 새 이름으로 고친다
  - 예외로 "이력" 폴더라도 HISTORY_DOC_IDS의 3건(실제로 리비전을 올린 자료)은 과거 파일도 바꾼다

무엇을 안 바꾸나
  - P&ID·PFD 폴더 하위(폴더 이름에 `(P&ID)`·`(PFD)`) — 연도별 Rev 폴더로 관리하므로
  - "이력"·"반출"·"폐기" 폴더의 파일 (CM 확정) — 폐기 자료는 복구할 때 새 이름이 붙는다
  - documents.drawing_no·title — 꼬리는 DB에 넣지 않고 리비전 번호로 만들어 붙인다
  - files.original_filename — 업체가 보낸 이름 그대로 남긴다
  - 아래 경우는 건드리지 않고 목록에 사유를 남긴다: 디스크에 파일이 없음 / 다른 자료와 한
    파일을 같이 씀 / 바뀔 이름의 파일이 이미 있음 / 같은 이름으로 바뀌는 파일이 둘 이상

실행 (backend 폴더에서)
  venv\\Scripts\\python.exe scripts\\apply_rev_tail_20261001.py            미리보기 + 엑셀 목록만 (기본값)
  venv\\Scripts\\python.exe scripts\\apply_rev_tail_20261001.py --apply    실제 반영

  --apply는 app/storage.py가 같은 규칙으로 바뀐 뒤에 함께 돌려야 한다. 시스템은 파일 위치를 이름
  규칙으로 계산하는 곳이 있어서(자료 이동·이름변경), 둘 중 하나만 바뀌면 파일을 못 찾는다.

되돌리기
  venv\\Scripts\\python.exe scripts\\restore_rev_tail_20261001.py <기록파일.jsonl>
  반영할 때 파일 하나를 바꾸기 **직전마다** 기록 파일에 한 줄씩 적는다. 중간에 멈춰도 그 기록으로
  바뀐 것만 정확히 되돌린다.
"""

import argparse
import io
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path, PurePosixPath

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent
sys.path.insert(0, str(BACKEND_ROOT))

import openpyxl  # noqa: E402
from openpyxl.styles import Font, PatternFill  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402
from sqlalchemy import and_, or_  # noqa: E402

from app import storage  # noqa: E402
from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, Document, File, User  # noqa: E402
from app.rev_naming import applies_to, rev_name  # noqa: E402
from app.utils import sanitize_path_component  # noqa: E402

BATCH_NAME = "rev_tail_20261001"
BACKUP_DIR = PROJECT_ROOT / "backup"
REPORT_PATH = BACKEND_ROOT / "scripts" / "Rev꼬리_파일이름_변경계획_20261001.xlsx"
COMMIT_EVERY = 500

# "이력" 폴더는 원래 안 바꾸지만, 실제로 리비전을 올린 자료 3건만은 과거 파일(rev0)도 바꾼다
# (2026-10-01 CM 지시 — 실제 업데이트는 이 3건이 전부라 이력까지 맞춰 두는 게 보기 좋다).
# 도면번호는 겹칠 수 있으므로 자료 ID로 정한다.
HISTORY_DOC_IDS = (
    10465,  # TT01-10-65-046
    10479,  # TT01-10-65-057
    10495,  # TT01-10-65-067
)

# 판정
DO_RENAME = "바꿈"
ALREADY = "이미 맞음"
EXCLUDED = "제외 (P&ID·PFD)"
NOT_LATEST = "제외 (최신 폴더 아님)"
SKIP_MISSING = "건너뜀 — 디스크에 파일 없음"
SKIP_SHARED = "건너뜀 — 다른 자료와 한 파일을 같이 씀"
SKIP_EXISTS = "건너뜀 — 바뀔 이름의 파일이 이미 있음"
SKIP_COLLIDE = "건너뜀 — 같은 이름으로 바뀌는 파일이 둘 이상"


def build_plan(db) -> list[dict]:
    rows = (
        db.query(File, Document)
        .join(Document, Document.id == File.document_id)
        .filter(or_(
            File.is_current.is_(True),
            and_(File.document_id.in_(HISTORY_DOC_IDS), File.file_path.like(f"{storage.HISTORY}/%")),
        ))
        .order_by(Document.id, File.id)
        .all()
    )
    owners = Counter((f.file_path or "").lower() for f, _d in rows)

    plan: list[dict] = []
    for f, d in rows:
        item = {
            "file": f, "doc": d,
            "doc_id": d.id, "file_id": f.id, "archived": d.is_archived,
            "source_path": d.source_path or "", "drawing_no": d.drawing_no,
            "rev": f.rev, "branch": f.branch, "ext": f.file_ext,
            "old_rel": f.file_path, "new_rel": None, "new_stem": None,
            "status": None, "note": "",
        }
        plan.append(item)

        if not applies_to(d.source_path):
            item["status"] = EXCLUDED
            continue
        in_history = not f.is_current
        if not in_history and PurePosixPath(f.file_path).parts[:1] != (storage.LATEST,):
            item["status"] = NOT_LATEST
            continue

        new_stem = sanitize_path_component(rev_name(d.drawing_no, f.rev, f.branch, d.source_path))
        old_rel = PurePosixPath(f.file_path)
        new_rel = old_rel.with_name(f"{new_stem}.{f.file_ext}")
        item["new_stem"] = new_stem
        item["new_rel"] = str(new_rel)

        if in_history:
            item["note"] = "이력 파일 (CM 지정 3건)"
        else:
            # 바뀐 이름이 시스템 규칙(app/storage.py)이 계산하는 자리와 다르면 알려만 둔다(이름은
            # 그 자리에서 바꾼다). 다르면 나중에 자료를 옮기거나 이름을 바꿀 때 파일을 못 찾는다.
            rule_rel = storage.to_relative(storage.latest_file_path(
                d.source_path, d.drawing_no, f.file_ext, f.pairing_folder, rev=f.rev, branch=f.branch,
            ))
            if rule_rel.lower() != str(new_rel).lower():
                item["note"] = f"참고: 규칙 위치와 다름 ({rule_rel})"

        if owners[f.file_path.lower()] > 1:
            item["status"] = SKIP_SHARED
        elif not (Path(STORAGE_ROOT) / f.file_path).is_file():
            item["status"] = SKIP_MISSING
        elif str(old_rel) == str(new_rel):
            item["status"] = ALREADY
        else:
            item["status"] = DO_RENAME

    # 바뀔 이름끼리 겹치는지(대소문자 무관 — Windows는 같은 파일로 본다)
    target_count = Counter(i["new_rel"].lower() for i in plan if i["status"] == DO_RENAME)
    current_paths = {(i["old_rel"] or "").lower() for i in plan}
    for i in plan:
        if i["status"] != DO_RENAME:
            continue
        if target_count[i["new_rel"].lower()] > 1:
            i["status"] = SKIP_COLLIDE
            continue
        new_abs = Path(STORAGE_ROOT) / i["new_rel"]
        old_abs = Path(STORAGE_ROOT) / i["old_rel"]
        # 이미 있는 파일이 자기 자신(대소문자만 다른 이름)이 아니면 덮어쓰면 안 된다.
        # 다른 자료의 현재 파일이 지금 그 이름이라도 마찬가지다.
        if new_abs.exists() and not storage.is_same_file(old_abs, new_abs):
            i["status"] = SKIP_EXISTS
        elif i["new_rel"].lower() in current_paths and i["new_rel"].lower() != i["old_rel"].lower():
            i["status"] = SKIP_EXISTS
    return plan


def write_report(plan: list[dict]) -> None:
    wb = openpyxl.Workbook()

    summary = wb.active
    summary.title = "요약"
    counts = Counter(i["status"] for i in plan)
    doc_counts: dict[str, set] = {}
    for i in plan:
        doc_counts.setdefault(i["status"], set()).add(i["doc_id"])
    summary.append(["판정", "파일 수", "자료 수"])
    order = [DO_RENAME, ALREADY, EXCLUDED, NOT_LATEST, SKIP_MISSING, SKIP_SHARED, SKIP_EXISTS, SKIP_COLLIDE]
    for status in order:
        if counts.get(status):
            summary.append([status, counts[status], len(doc_counts[status])])
    summary.append(["합계", len(plan), len({i["doc_id"] for i in plan})])
    summary.append([])
    summary.append(["확장자별 (바꿈만)", "파일 수"])
    for ext, n in Counter(i["ext"] for i in plan if i["status"] == DO_RENAME).most_common():
        summary.append([ext, n])
    for cell in summary[1]:
        cell.font = Font(bold=True)
    summary.column_dimensions["A"].width = 40
    summary.column_dimensions["B"].width = 10
    summary.column_dimensions["C"].width = 10

    ws = wb.create_sheet("목록")
    headers = ["No", "판정", "자료ID", "삭제보관함", "경로", "자료명(지금)", "자료명(바뀐 뒤)",
               "Rev", "확장자", "지금 파일 위치", "바뀐 파일 이름", "참고"]
    ws.append(headers)
    skip_fill = PatternFill("solid", fgColor="FDE2E1")
    for n, i in enumerate(plan, start=1):
        rev_label = f"{i['rev']}-{i['branch']}" if i["branch"] else str(i["rev"])
        ws.append([
            n, i["status"], i["doc_id"], "Y" if i["archived"] else "", i["source_path"],
            i["drawing_no"], i["new_stem"] or "", rev_label, i["ext"], i["old_rel"],
            PurePosixPath(i["new_rel"]).name if i["new_rel"] and i["status"] == DO_RENAME else "",
            i["note"],
        ])
        if i["status"].startswith("건너뜀"):
            for cell in ws[ws.max_row]:
                cell.fill = skip_fill
    for cell in ws[1]:
        cell.font = Font(bold=True)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for idx, width in enumerate([7, 26, 8, 9, 50, 32, 38, 6, 7, 70, 40, 40], start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width

    wb.save(REPORT_PATH)


def system_user_id(db) -> int:
    user = db.query(User).filter(User.username == "일괄등록").one_or_none()
    if user is None:
        user = db.query(User).filter(User.role == "ADMIN").order_by(User.id).first()
    return user.id


def apply_plan(db, plan: list[dict]) -> None:
    targets = [i for i in plan if i["status"] == DO_RENAME]
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    journal_path = BACKUP_DIR / f"{BATCH_NAME}_기록_{stamp}.jsonl"

    done = 0
    with open(journal_path, "w", encoding="utf-8") as journal:
        for i in targets:
            f: File = i["file"]
            old_abs = Path(STORAGE_ROOT) / i["old_rel"]
            new_abs = Path(STORAGE_ROOT) / i["new_rel"]
            # 바꾸기 직전에 적어 둔다 — 중간에 멈춰도 되돌리기가 이 기록만 보고 정확히 찾는다
            journal.write(json.dumps({
                "file_id": f.id, "document_id": i["doc_id"],
                "old_file_path": i["old_rel"], "new_file_path": i["new_rel"],
            }, ensure_ascii=False) + "\n")
            journal.flush()
            if storage.move_stored_file(old_abs, new_abs):
                f.file_path = i["new_rel"]
                done += 1
            if done and done % COMMIT_EVERY == 0:
                db.commit()
                print(f"  {done} / {len(targets)}")

    db.add(AuditLog(
        user_id=system_user_id(db), action="RENAME_REV_TAIL", screen="폴더·자료 편집",
        detail={"batch": BATCH_NAME, "file_count": done,
                "document_count": len({i["doc_id"] for i in targets}),
                "journal": journal_path.name},
    ))
    db.commit()
    print(f"\n반영 완료: 파일 {done}개")
    print(f"기록 파일(되돌리기용): {journal_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(기본은 미리보기만)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        plan = build_plan(db)
        write_report(plan)
        counts = Counter(i["status"] for i in plan)
        print(f"대상 파일 {len(plan)}개 (현재본 + 이력 CM 지정분)")
        for status, n in counts.most_common():
            print(f"  {status}: {n}")
        print(f"목록 엑셀: {REPORT_PATH}")

        if not args.apply:
            print("\n(미리보기 모드입니다. 실제로 반영하려면 --apply 를 붙여 다시 실행하세요.)")
            return
        apply_plan(db, plan)
    finally:
        db.close()


if __name__ == "__main__":
    main()
