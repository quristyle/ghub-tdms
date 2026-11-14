# -*- coding: utf-8 -*-
"""P&ID·PFD의 Rev0 (2012) 자료를 등록하는 1회성 스크립트 (2026-08-30 CM 지시).

CM이 압축파일 두 개를 주면서 "Rev0 (2012) 자료도 폴더화 시켜라"고 지시했다.
  - 5.2   Process & Instrument Diagram.zip  → P&ID의 Rev0 (2012)
  - 3.2  Process Flow Diagram.zip           → PFD의 Rev0 (2012)

같이 지시한 세 가지를 그대로 반영한다.

① **DWG·PDF 폴더로 나눠 담는다** — 원본은 `Rev0 (2012)\\DWG\\`, 사본은 `Rev0 (2012)\\PDF\\`에
   저장한다. 두 폴더가 나란히 있으므로 시스템이 짝 폴더로 알아보고 화면에서는 자료 1건으로
   합쳐 보여주며 폴더 자체는 숨긴다(TDB 관리에서 [숨김 폴더 보기]를 켜야 보인다).

② **PDF는 무조건 가로 보기로 저장한다** — CM이 준 PDF는 종이가 세로로 서 있어(A3 세로,
   842x1191) 열면 도면이 옆으로 누워 보인다. 세로인 것을 시계 반대방향으로 90도 돌려
   제목란이 오른쪽 아래에 오는 정상 가로 방향(A3 가로, 1191x842)으로 만든다.
   그림을 다시 그리는 게 아니라 좌표만 돌리는 것이라 화질 손실이 없다.

   돌린 뒤 그 회전을 **종이 자체에 구워 넣는다**(회전값 /Rotate는 0으로 되돌리고 종이
   크기를 가로로 바꾼다). 회전값만 남겨두면 프로그램에 따라 미리보기 그림(썸네일)이
   여전히 세로로 보이는 경우가 있어서다 — 지금 시스템에 있는 P&ID Rev5 자료 대부분도
   종이 자체가 가로인 방식이라 그쪽에 맞춘다. 그래서 어떤 뷰어로 열어도 가로로 보인다.

③ **P&ID는 PDF 파일명을 기준으로 DWG 파일명을 맞춘다** — 파일명 맨 앞 숫자가 같으면
   같은 도면이다(예: `55.TT01-10-04-704.r.3(120425).dwg`와 `55.TT01-10-04-704.pdf`).
   그 DWG를 `55.TT01-10-04-704.dwg`로 바꿔 저장한다. 바뀐 이름 목록은 실행할 때 화면에
   전부 찍고 시스템 로그에도 남긴다(원래 이름을 잃지 않게).
   PFD는 원래부터 이름이 전부 같아 바꿀 것이 없다.

이미 같은 자리에 같은 이름의 자료가 있으면 새로 만들지 않고 건너뛴다(두 번 실행해도
자료가 두 벌 생기지 않는다).

실행:  python scripts/pid_pfd_rev0_register_20260830.py --dry-run   (무엇을 할지 보기만)
       python scripts/pid_pfd_rev0_register_20260830.py             (실제 실행)
"""

import argparse
import io
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")

from pypdf import PdfReader, PdfWriter

from app import storage
from app.database import SessionLocal
from app.models import AuditLog, Document, File
from app.utils import DWG_FOLDER_NAME, PDF_FOLDER_NAME, save_upload

SYSTEM_USER_ID = 1  # 일괄등록 계정
REV0_FOLDER = "Rev0 (2012)"
DESKTOP = os.path.join(os.path.expanduser("~"), "바탕화면")

# (이름, 압축파일, 부모 폴더)
TARGETS = [
    (
        "P&ID",
        os.path.join(DESKTOP, "5.2   Process & Instrument Diagram.zip"),
        "5. DRAWINGS\\5.2 Process & Instrument Diagram (P&ID)",
    ),
    (
        "PFD",
        os.path.join(DESKTOP, "3.2  Process Flow Diagram.zip"),
        "3. PROCESS & FACILITIES DESCRIPTION\\3.2 Process Flow Diagram (PFD)",
    ),
]


def pair_key(stem: str) -> str | None:
    """파일명 맨 앞의 숫자(예: "55.TT01-..." → "55", "00a.pfd_COVER" → "00a").
    이 값이 같은 DWG와 PDF가 같은 도면이다 (CM 확정)."""
    match = re.match(r"^(\d+[A-Za-z]?)\.", stem)
    return match.group(1) if match else None


def to_landscape(data: bytes) -> tuple[bytes, bool]:
    """PDF를 가로 보기로 만든다. (바뀐 내용, 실제로 손댔는지)를 돌려준다.

    ① 종이가 세로면 시계 반대방향 90도로 눕힌다 — 이 도면들은 그래야 제목란이 오른쪽
       아래에 오는 정상 방향이 된다(2026-08-30 실제 파일을 그림으로 뽑아 확인).
    ② 그 회전을 종이 자체에 구워 넣어(회전값 0, 종이 크기 1191x842) 어떤 뷰어로 열어도
       — 미리보기 썸네일까지 — 가로로 보이게 한다.

    이미 종이 자체가 가로이고 회전값도 0인 PDF는 손대지 않는다.
    """
    reader = PdfReader(BytesIO(data))
    writer = PdfWriter(clone_from=reader)
    changed = False
    for page in writer.pages:
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        current = int(page.get("/Rotate") or 0) % 360
        if current in (90, 270):
            width, height = height, width
        if width <= height:  # 세로 → 눕힌다
            page.rotate(270)
            changed = True
        if int(page.get("/Rotate") or 0) % 360:  # 회전값을 종이에 구워 넣는다
            page.transfer_rotation_to_content()
            changed = True
    if not changed:
        return data, False
    out = BytesIO()
    writer.write(out)
    return out.getvalue(), True


def is_landscape(path: Path) -> bool:
    """저장된 PDF가 이미 '종이 자체가 가로'인지 (회전값에 기대지 않고)."""
    page = PdfReader(str(path)).pages[0]
    rotate = int(page.get("/Rotate") or 0) % 360
    return rotate == 0 and float(page.mediabox.width) > float(page.mediabox.height)


def read_pairs(zip_path: str) -> tuple[list[dict], list[str]]:
    """압축파일에서 (앞 숫자)별로 DWG·PDF 한 쌍씩 뽑는다."""
    zf = zipfile.ZipFile(zip_path)
    groups: dict[str, dict[str, tuple[str, bytes]]] = {}
    problems: list[str] = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        filename = info.filename.replace("\\", "/").split("/")[-1]
        stem, ext = os.path.splitext(filename)
        ext = ext.lower().lstrip(".")
        key = pair_key(stem)
        if key is None:
            problems.append(f"{filename}: 파일명 앞에 숫자가 없어 짝을 못 찾음")
            continue
        slot = groups.setdefault(key, {})
        if ext in slot:
            problems.append(f"{filename}: 앞 숫자 {key}에 {ext.upper()}가 이미 있음(중복)")
            continue
        slot[ext] = (filename, zf.read(info))

    pairs = []
    for key in sorted(groups, key=lambda k: (int(re.match(r"\d+", k).group()), k)):
        slot = groups[key]
        pdf = slot.get("pdf")
        others = {e: v for e, v in slot.items() if e != "pdf"}
        if pdf is None:
            problems.append(f"앞 숫자 {key}: PDF가 없음 — 이름 기준을 못 정해 건너뜀")
            continue
        if len(others) > 1:
            problems.append(f"앞 숫자 {key}: 원본이 {len(others)}개라 어느 것인지 알 수 없음")
            continue
        name = os.path.splitext(pdf[0])[0]  # 자료명 = PDF 파일명 (CM 확정)
        pairs.append({"key": key, "name": name, "pdf": pdf,
                      "src": next(iter(others.items()), None)})
    return pairs, problems


class Runner:
    def __init__(self, db, dry_run: bool):
        self.db = db
        self.dry = dry_run
        self.now = datetime.now(timezone.utc)

    def normalize_stored_pdfs(self, doc: Document) -> int:
        """이미 등록된 자료의 PDF가 세로면 그 자리에서 가로로 고친다. 고친 파일 수."""
        fixed = 0
        files = (
            self.db.query(File)
            .filter(File.document_id == doc.id, File.file_ext == "pdf")
            .all()
        )
        for f in files:
            path = Path(storage.STORAGE_ROOT) / f.file_path
            if not path.is_file() or is_landscape(path):
                continue
            new_data, changed = to_landscape(path.read_bytes())
            if not changed:
                continue
            if not self.dry:
                file_size, sha256_hex = save_upload(new_data, path)
                f.file_size = file_size
                f.sha256 = sha256_hex
            fixed += 1
        return fixed

    def run_target(self, label: str, zip_path: str, parent: str) -> dict:
        target_path = f"{parent}\\{REV0_FOLDER}"
        print("=" * 78)
        print(f"{label}  —  {target_path}")
        print(f"   {os.path.basename(zip_path)}")
        print("=" * 78)

        if not os.path.isfile(zip_path):
            print(f"   [오류] 압축파일이 없습니다: {zip_path}")
            return {"label": label, "error": "zip not found"}

        pairs, problems = read_pairs(zip_path)
        created = skipped = rotated = 0
        renames: list[str] = []

        for pair in pairs:
            name = pair["name"]
            exists = (
                self.db.query(Document)
                .filter(Document.source_path == target_path,
                        Document.drawing_no == name,
                        Document.is_archived.is_(False))
                .first()
            )
            if exists:
                # 이미 등록된 자료는 새로 만들지 않는다. 다만 저장된 PDF가 아직 가로가
                # 아니면 그 자리에서 눕혀준다 — 이 스크립트를 다시 돌려도 안전하도록.
                fixed = self.normalize_stored_pdfs(exists)
                rotated += fixed
                print(f"   [이미 있음] {name}" + ("  (PDF 가로로 고침)" if fixed else ""))
                skipped += 1
                continue

            items = []  # (확장자, 짝폴더, 저장할 파일명, 내용)
            pdf_name, pdf_data = pair["pdf"]
            pdf_data, did_rotate = to_landscape(pdf_data)
            if did_rotate:
                rotated += 1
            items.append(("pdf", PDF_FOLDER_NAME, f"{name}.pdf", pdf_data))

            if pair["src"]:
                ext, (src_name, src_data) = pair["src"]
                old_stem = os.path.splitext(src_name)[0]
                if old_stem != name:
                    renames.append(f"{src_name}  →  {name}.{ext}")
                items.append((ext, DWG_FOLDER_NAME, f"{name}.{ext}", src_data))

            doc = Document(
                doc_class="DRAWING", drawing_no=name, title=name,
                source_path=target_path, current_rev=0, status="ACTIVE",
                has_dwg=any(e == "dwg" for e, _p, _f, _d in items),
                has_pdf=any(e == "pdf" for e, _p, _f, _d in items),
                is_archived=False, created_at=self.now, updated_at=self.now,
            )
            if not self.dry:
                self.db.add(doc)
                self.db.flush()

            for ext, pairing, filename, data in items:
                dest = storage.latest_file_path(target_path, name, ext, pairing)
                if self.dry:
                    continue
                file_size, sha256_hex = save_upload(data, dest)
                self.db.add(File(
                    document_id=doc.id, rev=0, branch=None, file_ext=ext,
                    file_path=storage.to_relative(dest), pairing_folder=pairing,
                    original_filename=filename, file_size=file_size, sha256=sha256_hex,
                    uploaded_by=SYSTEM_USER_ID, vendor_name=None, project_id=None,
                    vendor_labeled_rev=None, rev_mismatch_warning=False,
                    review_status="APPROVED", uploaded_at=self.now, is_current=True,
                ))
            exts = "+".join(sorted(e.upper() for e, _p, _f, _d in items))
            print(f"   [등록] {exts:9} {name}")
            created += 1

        print()
        print(f"   → 등록한 자료      : {created}건")
        if skipped:
            print(f"   → 이미 있어 건너뜀 : {skipped}건")
        print(f"   → 가로로 돌린 PDF  : {rotated}개")
        print(f"   → 이름 바꾼 원본   : {len(renames)}개")
        for line in renames:
            print(f"        {line}")
        if problems:
            print(f"   → 확인 필요        : {len(problems)}건")
            for line in problems:
                print(f"        {line}")

        return {"label": label, "target_path": target_path, "created": created,
                "skipped_existing": skipped, "rotated_pdfs": rotated,
                "renamed_sources": renames, "problems": problems}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="실제로 바꾸지 않고 무엇을 할지만 보여준다")
    args = ap.parse_args()

    db = SessionLocal()
    r = Runner(db, args.dry_run)
    try:
        results = []
        for label, zip_path, parent in TARGETS:
            results.append(r.run_target(label, zip_path, parent))
            print()

        print("=" * 78)
        for res in results:
            if res.get("error"):
                print(f"  {res['label']}: {res['error']}")
                continue
            print(f"  {res['label']}: 자료 {res['created']}건 등록, "
                  f"PDF {res['rotated_pdfs']}개 가로로, 원본 이름 {len(res['renamed_sources'])}개 변경")
        print("=" * 78)

        if args.dry_run:
            db.rollback()
            print("\n[미리보기] 아무것도 바꾸지 않았습니다.")
            return

        db.add(AuditLog(
            user_id=SYSTEM_USER_ID, action="PID_PFD_REV0_REGISTER",
            screen="폴더·자료 편집(스크립트)",
            detail={
                "note": "P&ID·PFD의 Rev0 (2012) 자료 등록 — DWG·PDF 짝 폴더, PDF 가로 보기, "
                        "PDF 파일명 기준 원본 이름 통일 (2026-08-30 CM 지시)",
                "results": results,
            },
        ))
        db.commit()
        print("\n완료 — 시스템 로그에 PID_PFD_REV0_REGISTER로 남겼습니다.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
