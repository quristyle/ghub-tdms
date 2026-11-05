import hashlib
import re
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterable
from urllib.parse import quote

INTERNAL_VENDOR = "사내(자체 통합)"

KST = timezone(timedelta(hours=9))


def kst_now() -> datetime:
    """한국 표준시(KST, UTC+9) 기준 현재 시각. 파일명 생성 전용 — DB에 저장하는
    시각(distributed_at 등)은 계속 UTC를 쓴다."""
    return datetime.now(KST)


def filename_timestamp(dt: datetime | None = None) -> str:
    """파일명에 붙이는 시각 문자열. 항상 한국시간, 초단위까지: YYMMDD_HHMMSS."""
    if dt is None:
        dt = kst_now()
    elif dt.tzinfo is not None:
        dt = dt.astimezone(KST)
    return dt.strftime("%y%m%d_%H%M%S")


def build_export_filename(screen: str, title: str | None = None, *, suffix: str | None = None, ext: str = "xlsx") -> str:
    """엑셀(또는 zip) 내보내기 파일명 생성 (2026-08-11 CM 확정 규칙).

    형식: "화면이름_표또는팝업제목_YYMMDD_HHMMSS" (제목 없으면 "화면이름_YYMMDD_HHMMSS").
    suffix(도면번호 등 자료 식별자)는 제목 뒤·시각 앞에 붙는다.
    호출부의 screen/title 문자열은 화면에 실제로 표시되는 제목과 항상 같아야 한다 —
    화면·표·팝업 제목이 바뀌면 이 값도 같이 바꾼다.
    """
    parts = [screen]
    if title:
        parts.append(title)
    if suffix:
        parts.append(suffix)
    parts.append(filename_timestamp())
    return "_".join(parts) + f".{ext}"


def content_disposition_header(disposition: str, filename: str) -> str:
    """한글 등 비-ASCII 파일명을 latin-1 헤더 인코딩 오류 없이 안전하게 내려준다."""
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "file"
    encoded = quote(filename)
    return f"{disposition}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"


def sanitize_path_component(name: str) -> str:
    """폴더/파일명에 쓸 수 없는 문자를 밑줄로 바꾼다.

    점으로만 된 이름("." · "..")도 밑줄로 바꾼다 — 그대로 두면 경로를 이을 때 "위 폴더로
    올라가기"로 해석돼, 압축파일 속 폴더 이름을 ".."로 꾸며 저장 폴더(storage) 밖에 파일을
    쓸 수 있었다(2026-09-17 시큐어코딩). 예전부터 저장돼 있던 이름 중엔 이런 것이 없어 기존
    파일 위치는 바뀌지 않는다.
    """
    invalid = '\\/:*?"<>|'
    for ch in invalid:
        name = name.replace(ch, "_")
    name = name.strip()
    if not name or set(name) == {"."}:
        return "_"
    return name


def neutralize_formulas(workbook) -> None:
    """엑셀 내보내기 파일을 저장하기 직전에 부른다.

    openpyxl은 '='로 시작하는 글자를 수식으로 저장한다. 비고·자료명처럼 사람이 적은 글자가
    '=HYPERLINK(...)'이면, 내려받은 사람이 엑셀로 열 때 그 수식이 실행된다(가짜 링크 심기 등).
    우리 내보내기는 수식을 쓰지 않으므로 수식으로 잡힌 칸은 전부 적힌 글자 그대로 되돌린다
    (2026-09-17 시큐어코딩).
    """
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    cell.data_type = "s"


def extract_labeled_rev(filename: str) -> str | None:
    """파일명에서 업체 표기 리비전(예: _R0, Rev2)을 추출한다. 참고용(D-14)."""
    match = re.search(r"(?:^|[^A-Za-z])R(?:ev)?\.?\s*(\d+)", filename, re.IGNORECASE)
    if match:
        return f"R{match.group(1)}"
    return None


def labeled_rev_number(labeled_rev: str | None) -> int | None:
    if not labeled_rev:
        return None
    match = re.search(r"(\d+)", labeled_rev)
    return int(match.group(1)) if match else None


# 원본(도면)과 사본(PDF)이 나뉘어 들어오는 짝 폴더 이름.
DWG_FOLDER_NAME = "DWG"
PDF_FOLDER_NAME = "PDF"
PAIRING_FOLDER_NAMES = (DWG_FOLDER_NAME.lower(), PDF_FOLDER_NAME.lower())


def is_pairing_name(name: str) -> bool:
    """폴더 **이름**이 짝 폴더 후보인지 (정확히 'DWG'·'PDF', 대소문자 무관).

    이름만으로는 짝 폴더인지 결정되지 않는다 — 아래 pairing_folder_paths 참고.
    '01.DWG'처럼 번호가 붙은 폴더, 'CAD' 폴더는 그냥 보통 폴더다.
    """
    return name.lower() in PAIRING_FOLDER_NAMES


def pairing_folder_paths(folders: "Iterable[str]") -> set[str]:
    """폴더 목록("/" 구분)에서 **짝 폴더로 볼 자리**만 골라 그 전체 경로를 돌려준다.

    판정 기준은 하나다 — **한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 둘 다 있을 때만**
    그 둘을 짝(원본·사본) 폴더로 본다 (2026-08-21 CM 확정).

        상위/DWG + 상위/PDF   → 둘 다 짝 폴더 (숨기고 자료를 1건으로 합침)
        상위/DWG 만          → 그냥 보통 폴더 (안 숨김, 안 합침)
        상위/PDF 만          → 그냥 보통 폴더 (안 숨김, 안 합침)

    한쪽만 있는데 짝으로 취급하면, 그 폴더가 화면에서 사라지면서 안에 든 자료가 상위 폴더로
    올라와 보인다. 원본이 상위 폴더에 그냥 있고 PDF 폴더만 따로 있는 자리에서 이러면
    "상위 폴더만 보고 하위를 놓치는" 문제가 생기므로 짝으로 보지 않는다.

    깊이가 다르면(예: "상위/중간/DWG"와 "상위/PDF") 같은 자리가 아니므로 짝이 아니다 —
    바로 위 폴더가 같은 것끼리만 짝을 이룬다.
    """
    by_parent: dict[str, set[str]] = {}
    for folder in folders:
        if not folder:
            continue
        parts = folder.split("/")
        if not is_pairing_name(parts[-1]):
            continue
        by_parent.setdefault("/".join(parts[:-1]), set()).add(parts[-1].lower())

    paths: set[str] = set()
    for folder in folders:
        if not folder:
            continue
        parts = folder.split("/")
        if not is_pairing_name(parts[-1]):
            continue
        found = by_parent.get("/".join(parts[:-1]), set())
        if len(found) == len(PAIRING_FOLDER_NAMES):  # DWG·PDF 둘 다 있을 때만
            paths.add(folder)
    return paths


def split_pairing_folder(folder: str, pair_paths: "Iterable[str]") -> tuple[str, str | None]:
    """경로("/" 구분)를 (상위 경로, 짝 폴더 이름)으로 나눈다.

    pair_paths는 pairing_folder_paths()가 골라준 "짝으로 볼 폴더" 모음이다. 그 안에 있는
    경로일 때만 마지막 조각을 떼어낸다 — 이름이 DWG/PDF여도 짝 상대가 없으면 보통 폴더라
    그대로 둔다. 떼어낸 이름은 원본 대소문자 그대로 돌려준다(반출 폴더를 원본과 같은
    이름으로 재현해야 하므로).
    """
    if not folder or folder not in set(pair_paths):
        return folder, None
    parts = folder.split("/")
    return "/".join(parts[:-1]), parts[-1]


def strip_pairing_segment(folder: str, pair_paths: "Iterable[str]") -> str:
    """짝 폴더 조각을 떼어낸 상위 경로만 (반입 검수의 경로 비교용)."""
    return split_pairing_folder(folder, pair_paths)[0]


def pairing_folder_for_ext(existing_pairs: list[tuple[str, str | None]], ext: str) -> str | None:
    """이미 등록된 자료에 파일을 새로 붙일 때, 그 파일이 들어갈 DWG/PDF 폴더 이름을 정한다.

    existing_pairs = [(확장자, 그 파일의 DWG/PDF 폴더 이름 또는 None), ...] — 그 자료의 현재 파일들.

    - 같은 확장자를 쓰던 파일이 있으면 그 폴더를 그대로 쓴다(자료 교체 등).
    - 이 자료가 DWG/PDF 폴더를 아예 안 쓰면 새 파일도 안 쓴다(None).
    - DWG/PDF 폴더를 쓰는 자료인데 이 확장자는 처음이면, PDF는 'PDF' 폴더로 나머지는 'DWG'
      폴더로 보낸다 — DWG 폴더엔 도면·엑셀 등 원본, PDF 폴더엔 사본이 들어간다.
    """
    for file_ext, folder in existing_pairs:
        if file_ext == ext and folder:
            return folder
    if not any(folder for _ext, folder in existing_pairs):
        return None
    return PDF_FOLDER_NAME if ext == "pdf" else DWG_FOLDER_NAME


def same_name_ignoring_case(a: str, b: str) -> bool:
    """대소문자만 다른 이름인지 (같은 이름은 False — 이미 맞는 것은 알릴 필요가 없다).

    **짝을 맺는 판정에는 절대 쓰지 않는다.** 원본과 사본은 대소문자까지 정확히 같아야 한 자료로
    묶인다(2026-08-21 CM 확정, D-47 ④). 이 함수는 "대소문자만 달라서 안 묶인 것"을 CM에게
    알려주기 위한 안내용이다.
    """
    return a != b and a.lower() == b.lower()


def duplicate_ext_groups(items: list[tuple[str, str]]) -> list[str]:
    """items = [(파일명, 확장자), ...]. 같은 확장자가 2개 이상이면 비정상(원본 또는 PDF는
    이름당 1개씩만 있어야 함) — 그런 확장자 목록을 돌려준다(없으면 빈 리스트)."""
    counts = Counter(ext for _filename, ext in items)
    return sorted(ext for ext, c in counts.items() if c > 1)


def save_upload(data: bytes, dest: Path) -> tuple[int, str]:
    """업로드된 바이트를 dest에 저장하고 (크기, sha256)을 반환한다."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    sha256 = hashlib.sha256(data).hexdigest()
    return len(data), sha256
