"""저장소 폴더 규칙 (한 곳에서만 관리).

storage/
  최신/     ← 지금 유효한 승인본만. 원본 공유폴더 구조를 그대로 재현한다.
             파일명은 {도면번호}_Rev00.{확장자}(P&ID·PFD는 꼬리 없이) — 리비전이 오르면 이름이
             바뀌고 예전 현재본은 이력으로 내려간다(app/rev_naming.py, 2026-10-01).
             시스템을 그만 쓸 때 이 폴더만 가져가면 그대로 쓸 수 있다.
  이력/     ← 구본·반려본·분기본. 문서별/리비전별 하위 폴더로 나눠 충돌을 막는다.
  검수대기/  ← 아직 승인 안 된 업로드. 승인되면 최신으로, 반려되면 이력으로 간다.
  반출/     ← 업체에 나간 사본 (리비전이 아니므로 따로 둔다)
  즐겨찾기/  ← 미리보기에서 그린 표시를 담아 둔 것(사람마다 폴더 하나). 도면 파일이 아니라
             그린 내용만 적어 둔 작은 JSON이다.
  폐기/     ← 폐기 보관함으로 보낸 자료. "최신"과 같은 폴더 모양을 그대로 유지한다.
             최신본에서 빠진 자료이므로 최신 폴더에 남겨두면 안 되고(그 자리에 같은 이름
             자료가 새로 들어오면 폐기본 파일이 조용히 덮어써진다), 복구하면 다시 최신으로
             돌아간다. MDB 자료는 폐기/MDB/ 밑에 같은 모양으로 들어간다.
  미리보기변환/ ← DWG·엑셀·워드 원본을 미리보기용 PDF로 바꿔 둔 것(D-102). 원본 파일 내용
             (sha256)으로 이름을 붙여 같은 파일은 한 번만 바꾼다. 언제 지워도 되는 자리다 —
             지우면 다음에 열 때 다시 만든다.

원본 공유폴더(주요자료\\...)는 시스템이 절대 건드리지 않는다.
"""

import shutil
from pathlib import Path
from typing import Optional

from app.config import STORAGE_ROOT
from app.rev_naming import rev_name
from app.utils import sanitize_path_component

LATEST = "최신"
HISTORY = "이력"
PENDING = "검수대기"
DISTRIBUTED = "반출"
QUARANTINE = "검수대기_확인필요"
RETIRED = "폐기"
FAVORITES = "즐겨찾기"
PREVIEW_CACHE = "미리보기변환"
# 백업 변경분을 계산할 때 쓰는 목록표를 두는 곳 (D-105). 만든 묶음(BACKUP_ROOT)은 외장하드처럼
# 늘 꽂혀 있지 않을 수 있는데 목록표는 늘 있어야 하므로 storage 안에 둔다.
# 도면 백업 대상에서는 빠진다(app/backup.py의 TDB_TOPS·MDB_TOPS에 없다).
BACKUP_LOG = "백업기록"


def rev_dir_name(rev: int, branch: Optional[str]) -> str:
    return f"rev{rev}{branch or ''}"


def source_parts(source_path: Optional[str]) -> list[str]:
    """DB의 원본경로("5. DRAWINGS\\5.1 ...")를 폴더 조각으로. 각 조각은 파일명 안전화."""
    if not source_path:
        return []
    raw = source_path.replace("/", "\\").split("\\")
    return [sanitize_path_component(p) for p in raw if p.strip()]


def latest_file_path(
    source_path: Optional[str], drawing_no: str, ext: str, pairing_folder: Optional[str] = None,
    *, rev: int, branch: Optional[str] = None,
) -> Path:
    """최신/{원본경로}/[DWG|PDF/]{도면번호}_Rev00.{확장자}

    파일 이름 끝의 `_Rev00`은 그 파일의 리비전 번호로 만든다(app/rev_naming.py — 2026-10-01 CM
    지시). P&ID·PFD 폴더 하위는 꼬리 없이 `{도면번호}.{확장자}` 그대로다. 리비전이 오르면 이름이
    바뀌므로 승인할 때 예전 현재본은 이력으로 내려가고 새 이름으로 들어온다.

    pairing_folder는 원본과 사본이 DWG·PDF 폴더로 나뉘어 있던 경우의 그 폴더 이름이다
    (그 두 폴더가 나란히 있는 자리에서만 채워진다 — 한쪽만 있으면 보통 폴더다, D-47).
    화면에서는 자료를 한 건으로 합쳐 보여주지만(그 폴더는 트리에 안 나온다), 저장소에는
    원본 공유폴더와 같은 모양으로 남긴다 — 시스템을 그만 쓸 때 '최신' 폴더만 가져가면
    그대로 쓸 수 있어야 하기 때문이다 (2026-08-16 CM 확정).
    """
    return _doc_file_path(LATEST, source_path, drawing_no, ext, pairing_folder, rev, branch)


def retired_file_path(
    source_path: Optional[str], drawing_no: str, ext: str, pairing_folder: Optional[str] = None,
    *, rev: int, branch: Optional[str] = None,
) -> Path:
    """폐기/{원본경로}/[DWG|PDF/]{도면번호}_Rev00.{확장자} — 폐기 보관함으로 보낸 자료의 현재본 자리.

    "최신"과 폴더 모양이 같아서 복구할 때 그대로 되돌리기만 하면 된다. 최신에서 비켜나 있어야
    같은 폴더에 같은 이름 자료가 새로 등록돼도 폐기본 파일이 덮어써지지 않는다 (2026-08-30).
    """
    return _doc_file_path(RETIRED, source_path, drawing_no, ext, pairing_folder, rev, branch)


def _doc_file_path(
    top: str, source_path: Optional[str], drawing_no: str, ext: str, pairing_folder: Optional[str],
    rev: int, branch: Optional[str],
) -> Path:
    parts = source_parts(source_path)
    if pairing_folder:
        parts = parts + [sanitize_path_component(pairing_folder)]
    name = f"{sanitize_path_component(rev_name(drawing_no, rev, branch, source_path))}.{ext}"
    return Path(STORAGE_ROOT).joinpath(top, *parts, name)


def history_file_path(
    source_path: Optional[str], drawing_no: str, rev: int, branch: Optional[str], filename: str
) -> Path:
    """이력/{원본경로}/{도면번호}/rev{N}/{원래 파일명}"""
    parts = source_parts(source_path)
    return Path(STORAGE_ROOT).joinpath(
        HISTORY, *parts, sanitize_path_component(drawing_no),
        rev_dir_name(rev, branch), sanitize_path_component(filename),
    )


def pending_file_path(
    document_id: int, drawing_no: str, rev: int, branch: Optional[str], filename: str
) -> Path:
    """검수대기/{문서ID}_{도면번호}/rev{N}/{원래 파일명}

    승인 전이라 원본 폴더 구조에 섞이면 안 된다. 문서ID로 구분해 평평하게 둔다.
    """
    return Path(STORAGE_ROOT).joinpath(
        PENDING, f"{document_id}_{sanitize_path_component(drawing_no)}",
        rev_dir_name(rev, branch), sanitize_path_component(filename),
    )


def quarantine_file_path(issue_id_placeholder: str, filename: str) -> Path:
    """검수대기_확인필요/{임시키}_{원래 파일명}

    아직 문서가 안 정해졌으니 도면번호 기반 폴더를 못 쓴다. 임시키(업로드 시각 등)로만 구분.
    """
    return Path(STORAGE_ROOT).joinpath(
        QUARANTINE, f"{issue_id_placeholder}_{sanitize_path_component(filename)}",
    )


def distributed_dir_path(vendor: str, date_str: str, drawing_no: str) -> Path:
    """반출/{업체}/{일자}_{도면번호}/  (D-17)"""
    return Path(STORAGE_ROOT).joinpath(
        DISTRIBUTED, sanitize_path_component(vendor),
        f"{date_str}_{sanitize_path_component(drawing_no)}",
    )


def distributed_file_path(dest_dir: Path, filename: str, pairing_folder: Optional[str]) -> Path:
    """반출 폴더 안에서 파일이 놓일 자리. 원본과 사본이 DWG·PDF 폴더로 나뉘어 있던 자료면
    반출 사본도 같은 모양(.../DWG/도면.dwg, .../PDF/도면.pdf)으로 만든다 (2026-08-16 CM 확정)."""
    if pairing_folder:
        return dest_dir / sanitize_path_component(pairing_folder) / filename
    return dest_dir / filename


MDB = "MDB"


def mdb_file_path(source_rel_path: str, pairing_folder: Optional[str] = None) -> Path:
    """MDB/{원본 MDB 폴더 기준 상대경로} — 원본 폴더 구조를 그대로 재현한 백업 사본.

    source_rel_path는 파일명까지 포함한 경로다(documents와 달리 MDB는 이 한 값에 다 들어있다).
    pairing_folder는 원본과 사본이 DWG·PDF 폴더로 나뉘어 있던 경우의 그 폴더 이름으로,
    화면에서는 자료를 한 건으로 합쳐 보여주려고 source_path에서 빼두지만 실제 저장 위치에는
    파일명 바로 앞에 다시 끼워 원본 폴더와 같은 모양으로 남긴다 (2026-08-17 CM 확정,
    TDB의 latest_file_path와 같은 방식).
    """
    return Path(STORAGE_ROOT).joinpath(MDB, *_mdb_parts(source_rel_path, pairing_folder))


def retired_mdb_file_path(source_rel_path: str, pairing_folder: Optional[str] = None) -> Path:
    """폐기/MDB/{원본 MDB 폴더 기준 상대경로} — 폐기 보관함으로 보낸 MDB 자료의 파일 자리.

    TDB의 retired_file_path와 같은 목적이다(최신 자리에서 비켜나 있게 한다). MDB 폴더 모양을
    그대로 유지해 복구할 때 되돌리기만 하면 된다.
    """
    return Path(STORAGE_ROOT).joinpath(RETIRED, MDB, *_mdb_parts(source_rel_path, pairing_folder))


def _mdb_parts(source_rel_path: str, pairing_folder: Optional[str]) -> list[str]:
    parts = [sanitize_path_component(p) for p in source_rel_path.replace("/", "\\").split("\\") if p.strip()]
    if pairing_folder and parts:
        parts.insert(-1, sanitize_path_component(pairing_folder))
    return parts


def favorite_markup_path(user_id: int, favorite_id: int) -> Path:
    """즐겨찾기/{사용자ID}/{저장ID}.json — 미리보기에서 그린 편집 내용을 담아 두는 자리.

    도면 파일이 아니라 "무엇을 어디에 그렸는지"만 적어 둔 작은 JSON이다. 자료(PDF)는
    원래 자리에 그대로 두고 이 표시만 덧입혀 다시 보여주므로, 6.5GB짜리 자료를 사람마다
    복사해 둘 필요가 없다.

    화면에서 부르는 이름이 "즐겨찾기"에서 "저장 목록"으로 바뀐 뒤에도(2026-09-05) 이
    폴더 이름은 그대로 둔다 — DB(user_favorites.markup_path)가 이 경로를 그대로 들고 있어
    폴더를 바꾸면 이미 저장해 둔 편집 내용을 못 찾는다. 사용자에게 보이지 않는 자리다.
    """
    return Path(STORAGE_ROOT).joinpath(FAVORITES, str(user_id), f"{favorite_id}.json")


def preview_cache_dir() -> Path:
    """미리보기변환/ — 원본을 미리보기용 PDF로 바꿔 둔 자리(D-102)."""
    return Path(STORAGE_ROOT) / PREVIEW_CACHE


def to_relative(path: Path) -> str:
    """DB에는 STORAGE_ROOT 기준 상대경로로 저장한다 (나중에 폴더를 통째로 옮겨도 안 깨지게)."""
    return str(path.relative_to(STORAGE_ROOT)).replace("\\", "/")


def is_same_file(a: Path, b: Path) -> bool:
    """두 경로가 디스크에서 같은 파일을 가리키는지.

    Windows는 파일명 대소문자를 구분하지 않아 "A.pdf"와 "a.pdf"가 같은 파일이다. 경로
    문자열만 비교하면 다른 파일로 보여, 옮기기 전에 "이미 있으니 지운다"며 원본을 지워버리는
    사고가 난다 — 그래서 문자열이 아니라 실제 파일로 비교한다.
    """
    try:
        return a.is_file() and b.is_file() and a.samefile(b)
    except OSError:
        return False


def move_stored_file(old_dest: Path, new_dest: Path) -> bool:
    """'최신' 파일 하나를 새 자리로 옮긴다. 실제로 옮겼으면 True.

    같은 파일인데 이름의 대소문자만 다른 경우(Windows)는 지우고 옮기면 파일이 사라지므로,
    그 자리에서 이름만 바꾼다. 그 밖에 새 자리에 다른 파일이 이미 있으면 덮어쓴다.
    """
    if old_dest == new_dest or not old_dest.is_file():
        return False
    new_dest.parent.mkdir(parents=True, exist_ok=True)
    if is_same_file(old_dest, new_dest):
        old_dest.rename(new_dest)  # 대소문자만 바꾸는 이름 변경
        return True
    if new_dest.exists():
        new_dest.unlink()
    shutil.move(str(old_dest), str(new_dest))
    return True


# ---------------------------------------------------------------------------
# 완전삭제(삭제 보관함 비우기)용 — 실제로 디스크에서 지운다. 되돌릴 수 없으므로
# 이 두 함수는 삭제 보관함 완전삭제에서만 쓴다 (2026-08-17 CM 확정).
# ---------------------------------------------------------------------------

def prune_empty_dirs(directory: Path) -> None:
    """파일을 지운 뒤 빈 껍데기만 남은 폴더를 위로 거슬러 올라가며 정리한다.

    storage 루트와 그 바로 밑 큰 폴더(최신/이력/검수대기/반출/MDB/폐기)는 비어도 남긴다 —
    저장소의 기본 뼈대라 없어지면 다음 저장 때 다시 만들어야 하고, 폴더가 통째로
    사라진 것처럼 보여 혼란스럽기 때문이다.
    """
    root = Path(STORAGE_ROOT).resolve()
    current = directory.resolve()
    while current.is_dir() and current != root and root in current.parents:
        if current.parent == root:
            return  # 최신·이력 등 최상위 칸 자체는 비어도 그대로 둔다
        if any(current.iterdir()):
            return
        current.rmdir()
        current = current.parent


def delete_stored_file(relative_path: str) -> int:
    """DB에 적힌 상대경로의 실제 파일을 지우고 지운 크기(바이트)를 돌려준다.

    이미 없는 파일이면 0을 돌려주고 조용히 넘어간다 — 삭제하려던 것이 이미 없는 상태는
    목표와 같으므로 오류로 세울 이유가 없다.
    """
    path = Path(STORAGE_ROOT) / relative_path
    if not path.is_file():
        return 0
    size = path.stat().st_size
    path.unlink()
    prune_empty_dirs(path.parent)
    return size


def delete_stored_dir(relative_path: str) -> int:
    """폴더 하나를 통째로 지우고 지운 크기(바이트) 합을 돌려준다. 반출 사본 폴더용."""
    path = Path(STORAGE_ROOT) / relative_path
    if not path.is_dir():
        return 0
    size = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    shutil.rmtree(path, ignore_errors=True)
    prune_empty_dirs(path.parent)
    return size
