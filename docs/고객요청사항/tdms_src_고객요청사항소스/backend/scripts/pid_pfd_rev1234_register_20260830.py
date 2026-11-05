# -*- coding: utf-8 -*-
"""P&ID Rev1~Rev4 · PFD Rev3 자료를 등록하는 1회성 스크립트 (2026-08-30 CM 지시).

CM이 압축파일(`새 폴더.zip`) 하나로 나머지 리비전을 전부 줬다.

    P&ID  2019년 → Rev1 (2019)    DWG 58개 + PDF 1개(P&ID Total.pdf, 64쪽)
    P&ID  2020년 → Rev2 (2020)    DWG 58개 + PDF 1개(60쪽)
    P&ID  2022년 → Rev3 (2022)    DWG 59개 + PDF 1개(34쪽)
    P&ID  2024년 → Rev4 (2024)    DWG 64개 + PDF 1개(65쪽)
    PFD   2022   → Rev3 (2022)    DWG 1개 + PDF 1개(5쪽)

이름 고치는 규칙 세 가지 (CM 지시, **실제 파일 이름까지 바꿔서 저장한다**)

① **끝의 `_(숫자)`를 뗀다** — `0-0 PID COVER_(190401).dwg` → `0-0 PID COVER.dwg`.
   `5-1 SKCAG-N2-SKG-Y11-50M3 _(20240405).dwg`처럼 앞에 공백이 붙어 있어도 같이 정리한다.

② **맨 앞 넘버링을 "숫자. " 모양으로 통일한다** — 넘버링 숫자 뒤에 점을 찍고 한 칸 띄운다.
      `0-0 PID COVER`        → `0-0. PID COVER`
      `6 TT01-UCO-04-105`    → `6. TT01-UCO-04-105`
      `8.TT01-UCO-04-107`    → `8. TT01-UCO-04-107`
      `4-4 TT01-UCO.AR-04-106` → `4-4. TT01-UCO.AR-04-106`
   넘버링이 아예 없는 이름(`P&ID Total`, `PFD Total`)은 그대로 둔다.

③ **Rev3 (2022)만 넘버링을 다시 매긴다** — 업체 파일이 4번에서 멈춰 51개가 전부 `4`였다.
   CM 지시대로 순차 계산해 `4`부터 `54`까지 이어 붙인다(도면번호 순). 첫 번째는 4번 그대로다.
   **`0-1`이 네 번 겹치는 것은 그대로 둔다** — 2024년 자료와 시스템의 Rev6 (2026)도 같은
   모양이라 CM이 쓰는 묶음 표기이지 빠진 넘버링이 아니다(지시에 없는 것은 건드리지 않는다).

담는 방식
  - 원본은 `Rev1 (2019)\\DWG\\`, 사본은 `Rev1 (2019)\\PDF\\`에 넣는다. 두 폴더가 나란히
    있으므로 시스템이 짝 폴더로 알아보고 화면에서는 숨긴다.
  - **이름이 같은 원본·사본만 자료 1건으로 묶인다.** P&ID는 DWG 이름과 PDF 이름(`P&ID Total`)이
    서로 달라 묶이지 않고 각각 별개 자료가 된다 — CM이 "매칭 되는 게 없을 텐데 그냥 매칭없이
    규칙대로 등록하면 된다"고 확정한 그대로다. PFD는 `PFD Total`로 이름이 같아 1건으로 묶인다.
  - **PDF는 가로 보기로 저장한다** — 다만 이번 자료는 5개 PDF 228쪽이 **전부 이미 가로로
    보인다**(업체가 회전값을 넣어둠). 고칠 것이 없으므로 그대로 저장한다. 세로로 보이는 쪽이
    있으면 그 쪽만 눕혀서 저장한다(`to_landscape` 설명 참고).

이미 같은 자리에 같은 이름의 자료가 있으면 새로 만들지 않고 건너뛴다(두 번 돌려도 안전).

실행:  python scripts/pid_pfd_rev1234_register_20260830.py --dry-run
       python scripts/pid_pfd_rev1234_register_20260830.py
"""

import argparse
import io
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
sys.path.insert(0, ".")

from pypdf import PdfReader, PdfWriter

from app import storage
from app.database import SessionLocal
from app.models import AuditLog, Document, File
from app.utils import DWG_FOLDER_NAME, PDF_FOLDER_NAME, save_upload

SYSTEM_USER_ID = 1  # 일괄등록 계정
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
BACKUP_DIR = os.path.join(os.path.dirname(ROOT), "backup")
ZIP_PATH = os.path.join(os.path.expanduser("~"), "바탕화면", "새 폴더.zip")

PID = "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)"
PFD = "3. PROCESS & FACILITIES DESCRIPTION\\3.2 Process Flow Diagram (PFD)"

# (라벨, 부모 폴더, Rev 폴더명, rev번호, zip 안 폴더들, 다시 매길 넘버링)
TARGETS = [
    ("P&ID Rev1", PID, "Rev1 (2019)", 1,
     ["새 폴더/P&ID/2019년/2019 P&ID CAD/P&ID_190401", "새 폴더/P&ID/2019년/2019 P&ID PDF"], None),
    ("P&ID Rev2", PID, "Rev2 (2020)", 2,
     ["새 폴더/P&ID/2020년/2020 P&ID CAD", "새 폴더/P&ID/2020년/2020 P&ID PDF"], None),
    ("P&ID Rev3", PID, "Rev3 (2022)", 3,
     ["새 폴더/P&ID/2022년/2022 P&ID CAD", "새 폴더/P&ID/2022년/2022 P&ID PDF"], "4"),
    ("P&ID Rev4", PID, "Rev4 (2024)", 4,
     ["새 폴더/P&ID/2024년/2024 P&ID CAD", "새 폴더/P&ID/2024년/2024 P&ID PDF"], None),
    ("PFD Rev3", PFD, "Rev3 (2022)", 3,
     ["새 폴더/PFD/2022 PFD"], None),
]

DATE_SUFFIX = re.compile(r"_\(\d+\)\s*$")            # 끝의 _(190401) 등
NUM_PREFIX = re.compile(r"^(\d+(?:-\d+)?)[.\s]*")    # 맨 앞 넘버링 (0-0 / 6 / 8. / 48-0. )


def clean_stem(stem: str) -> str:
    """① 끝의 `_(숫자)` 제거 ② 맨 앞 넘버링을 `숫자. ` 모양으로 통일."""
    name = DATE_SUFFIX.sub("", stem).strip()
    match = NUM_PREFIX.match(name)
    if match:
        name = f"{match.group(1)}. {name[match.end():].strip()}"
    return name.strip()


def renumber(names: list[str], prefix: str) -> dict[str, str]:
    """넘버링이 `prefix`에서 멈춰 겹친 이름들을 그 번호부터 순차로 다시 매긴다.

    `4. A` `4. B` `4. C` → `4. A` `5. B` `6. C` (도면번호 순). 첫 번째는 그대로 둔다.
    """
    head = f"{prefix}. "
    group = sorted(n for n in names if n.startswith(head))
    start = int(prefix)
    return {n: f"{start + i}. {n[len(head):]}" for i, n in enumerate(group)}


def portrait_pages(data: bytes) -> list[int]:
    """열었을 때 **세로로 보이는** 쪽 번호. 종이 크기와 회전값을 함께 따진다."""
    found = []
    for index, page in enumerate(PdfReader(BytesIO(data)).pages):
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        if int(page.get("/Rotate") or 0) % 360 in (90, 270):
            width, height = height, width
        if width <= height:
            found.append(index)
    return found


def to_landscape(data: bytes) -> tuple[bytes, int]:
    """세로로 보이는 쪽만 가로로 눕힌다. (바뀐 내용, 고친 쪽 수).

    **이미 가로로 보이는 PDF는 아예 손대지 않는다** (2026-08-30). CM이 정한 "가로 보기"는
    "열었을 때 종이가 가로로 보이는 것"이므로, 업체가 회전값을 넣어 이미 가로로 보이는
    파일은 고칠 것이 없다. 지금 시스템에 있는 다른 업체 PDF들도 같은 모양이라 그쪽과도 맞다.

    고쳐야 하는 쪽(세로로 보이는 쪽)이 있을 때만 시계 반대방향 90도로 눕히고, 그 회전을
    종이 자체에 구워 넣는다(회전값 0) — 고친 것은 어떤 뷰어에서도 확실히 가로로 보이게.

    성능 주의: 굽는 작업(`transfer_rotation_to_content`)은 쪽마다 내용을 다시 쓰기 때문에
    쪽수 많은 큰 도면 PDF에서는 아주 느리다(11MB·64쪽에 10분 넘게). 그래서 고칠 쪽이
    하나도 없으면 파일을 열어 보기만 하고 **그대로 되돌려준다**.
    """
    targets = set(portrait_pages(data))
    if not targets:
        return data, 0

    reader = PdfReader(BytesIO(data))
    writer = PdfWriter(clone_from=reader)
    for index, page in enumerate(writer.pages):
        if index not in targets:
            continue
        page.rotate(270)
        page.transfer_rotation_to_content()
    out = BytesIO()
    writer.write(out)
    return out.getvalue(), len(targets)


class Runner:
    def __init__(self, db, zf, dry_run: bool):
        self.db = db
        self.zf = zf
        self.dry = dry_run
        self.now = datetime.now(timezone.utc)

    def read_folder(self, folder: str) -> list[tuple[str, bytes]]:
        out = []
        for info in self.zf.infolist():
            if info.is_dir():
                continue
            raw = info.filename.replace("\\", "/")
            if "/".join(raw.split("/")[:-1]) == folder:
                out.append((raw.split("/")[-1], self.zf.read(info)))
        return sorted(out)

    def run_target(self, label, parent, rev_folder, rev, folders, renumber_prefix) -> dict:
        target_path = f"{parent}\\{rev_folder}"
        print("=" * 88)
        print(f"{label}  →  {target_path}   (Rev {rev})")
        print("=" * 88)

        raw = []
        for folder in folders:
            files = self.read_folder(folder)
            if not files:
                print(f"   [경고] 압축파일에 '{folder}' 폴더가 비어 있거나 없습니다")
            raw.extend(files)
        if not raw:
            return {"label": label, "error": "압축파일에서 파일을 못 찾음"}

        # ①② 이름 정리
        cleaned = []  # (원래 파일명, 정리된 이름, 확장자, 내용)
        for filename, data in raw:
            stem, ext = os.path.splitext(filename)
            cleaned.append((filename, clean_stem(stem), ext.lower().lstrip("."), data))

        # ③ Rev3만 넘버링 다시 매기기
        remap = {}
        if renumber_prefix:
            remap = renumber([c[1] for c in cleaned], renumber_prefix)
            cleaned = [(f, remap.get(n, n), e, d) for f, n, e, d in cleaned]
            print(f"   넘버링 다시 매김: '{renumber_prefix}'번 {len(remap)}개 → "
                  f"{renumber_prefix} ~ {int(renumber_prefix) + len(remap) - 1}번")

        # 이름이 같은 원본·사본만 자료 1건으로 묶는다
        groups: dict[str, list[tuple[str, str, bytes]]] = {}
        for filename, name, ext, data in cleaned:
            groups.setdefault(name, []).append((filename, ext, data))

        created = skipped = rotated_pages = 0
        renames: list[dict] = []
        problems: list[str] = []

        for name in sorted(groups):
            items = items_sorted = sorted(groups[name])
            exts = [e for _f, e, _d in items]
            if len(exts) != len(set(exts)):
                problems.append(f"{name}: 같은 형식이 2개 이상이라 건너뜀 ({exts})")
                continue

            exists = (
                self.db.query(Document)
                .filter(Document.source_path == target_path,
                        Document.drawing_no == name,
                        Document.is_archived.is_(False))
                .first()
            )
            if exists:
                print(f"   [이미 있음] {name}")
                skipped += 1
                continue

            saved = []  # (확장자, 짝폴더, 저장 파일명, 내용)
            for filename, ext, data in items_sorted:
                if ext == "pdf":
                    # 여러 쪽짜리 큰 PDF는 굽는 데 몇 분 걸린다 — 멈춘 것처럼 보이지 않게 알린다.
                    print(f"   [PDF 확인 중] {filename} ({len(data) / 1024 / 1024:.1f}MB) …")
                    data, pages = to_landscape(data)
                    rotated_pages += pages
                    print(f"   [PDF 완료]   가로로 고친 쪽 {pages}쪽")
                    pairing = PDF_FOLDER_NAME
                else:
                    pairing = DWG_FOLDER_NAME
                new_filename = f"{name}.{ext}"
                if filename != new_filename:
                    renames.append({"before": filename, "after": new_filename,
                                    "folder": target_path})
                saved.append((ext, pairing, new_filename, data))

            doc = Document(
                doc_class="DRAWING", drawing_no=name, title=name,
                source_path=target_path, current_rev=rev, status="ACTIVE",
                has_dwg=any(e == "dwg" for e, _p, _f, _d in saved),
                has_pdf=any(e == "pdf" for e, _p, _f, _d in saved),
                is_archived=False, created_at=self.now, updated_at=self.now,
            )
            if not self.dry:
                self.db.add(doc)
                self.db.flush()

            for ext, pairing, filename, data in saved:
                dest = storage.latest_file_path(target_path, name, ext, pairing)
                if self.dry:
                    continue
                file_size, sha256_hex = save_upload(data, dest)
                self.db.add(File(
                    document_id=doc.id, rev=rev, branch=None, file_ext=ext,
                    file_path=storage.to_relative(dest), pairing_folder=pairing,
                    original_filename=filename, file_size=file_size, sha256=sha256_hex,
                    uploaded_by=SYSTEM_USER_ID, vendor_name=None, project_id=None,
                    vendor_labeled_rev=None, rev_mismatch_warning=False,
                    review_status="APPROVED", uploaded_at=self.now, is_current=True,
                ))
            created += 1

        print(f"   → 등록한 자료      : {created}건"
              + (f" (이미 있어 건너뜀 {skipped}건)" if skipped else ""))
        print(f"   → 이름 바꾼 파일   : {len(renames)}개")
        print(f"   → 가로로 고친 쪽   : {rotated_pages}쪽")
        if problems:
            print(f"   → 확인 필요        : {len(problems)}건")
            for line in problems:
                print(f"        {line}")
        print()

        return {"label": label, "target_path": target_path, "rev": rev,
                "created": created, "skipped_existing": skipped,
                "renamed_files": len(renames), "rotated_pages": rotated_pages,
                "renumbered": remap, "renames": renames, "problems": problems}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="실제로 바꾸지 않고 무엇을 할지만 보여준다")
    args = ap.parse_args()

    if not os.path.isfile(ZIP_PATH):
        print(f"[중단] 압축파일이 없습니다: {ZIP_PATH}")
        return

    db = SessionLocal()
    zf = zipfile.ZipFile(ZIP_PATH)
    r = Runner(db, zf, args.dry_run)
    try:
        results = [r.run_target(*t) for t in TARGETS]

        print("=" * 88)
        for res in results:
            if res.get("error"):
                print(f"  {res['label']}: {res['error']}")
                continue
            print(f"  {res['label']:12} → {res['target_path'].split(chr(92))[-1]:12} "
                  f"자료 {res['created']:3}건 / 이름변경 {res['renamed_files']:3}개 / "
                  f"가로로 고친 쪽 {res['rotated_pages']:3}쪽")
        print("=" * 88)

        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return

        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_path = os.path.join(BACKUP_DIR, "pid_pfd_rev1234_이름변경_%s.json" % stamp)
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(results, handle, ensure_ascii=False, indent=2)

        db.add(AuditLog(
            user_id=SYSTEM_USER_ID, action="PID_PFD_REV_REGISTER",
            screen="폴더·자료 편집(스크립트)",
            detail={
                "note": "P&ID Rev1~Rev4 · PFD Rev3 등록 — 끝의 _(숫자) 제거, 넘버링 '숫자. ' 통일, "
                        "Rev3 넘버링 다시 매김, PDF 가로 보기 (2026-08-30 CM 지시)",
                "summary": [{k: v for k, v in res.items()
                             if k not in ("renames", "renumbered")} for res in results],
                "rename_report": os.path.basename(report_path),
            },
        ))
        db.commit()
        print("\n이름 변경 내역 저장: %s" % report_path)
        print("완료 — 시스템 로그에 PID_PFD_REV_REGISTER로 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
