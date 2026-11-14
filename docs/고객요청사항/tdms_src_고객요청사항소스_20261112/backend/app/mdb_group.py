"""MDB "자료 1건"의 정의 — 이 파일 한 곳에만 둔다 (2026-08-17 CM 확정).

MDB는 원래 파일 1개가 곧 자료 1건이었다. 그래서 같은 자료의 원본(xls·dwg 등)과 PDF 사본이
목록에 두 줄로 나왔다. 이제 TDB처럼 한 줄로 보여준다.

**자료 1건 = 같은 폴더 + 같은 자료명(확장자를 뗀 이름)을 가진 파일들.**

    7.1 Equipment Data Sheet\\TT01-DS-10-PR-019.xls   ┐
    7.1 Equipment Data Sheet\\TT01-DS-10-PR-019.pdf   ┘ → 자료 1건 (원본·사본)

묶음을 DB에 따로 저장하지 않는 이유: 이미 폴더와 이름으로 그렇게 저장돼 있어서 새로 기억할
값이 없고, 따로 저장하면 파일을 옮기거나 이름을 바꿀 때마다 같이 고쳐야 해서 어긋날 위험만
생긴다. 대신 묶는 규칙을 여기 한 곳에 모아 조회·관리 화면이 같은 답을 보게 한다.

원본과 사본이 DWG·PDF 폴더로 나뉘어 들어온 경우는 그 폴더 이름을 mdb_files.pairing_folder에
옮겨두어(= source_path에서 뺀다) 위 규칙에 그대로 얹힌다. 그 폴더는 화면에서 숨기고 실제
저장 위치에만 재현한다 — TDB와 같은 방식이다.
"""

from typing import Iterable, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import MdbFile, MdbFileTag

PDF_EXT = "pdf"


# ---------------------------------------------------------------------------
# 경로·이름 조각 내기 — source_path는 "폴더\\...\\파일명.확장자" 형태다.
# ---------------------------------------------------------------------------

def normalize(path: Optional[str]) -> str:
    return (path or "").replace("/", "\\")


def folder_of(source_path: Optional[str]) -> str:
    p = normalize(source_path)
    return p.rsplit("\\", 1)[0] if "\\" in p else ""


def filename_of(source_path: Optional[str]) -> str:
    return normalize(source_path).rsplit("\\", 1)[-1]


def doc_name(filename: str, file_ext: Optional[str]) -> str:
    """파일명에서 확장자를 뗀 자료명. "NF410-04.xlsx"(ext=xlsx) → "NF410-04".

    실제 확장자(file_ext)를 받아 그것만 정확히 떼어낸다. 마지막 점 뒤를 무조건 떼면
    "10. Inspection & Test Procedure"처럼 확장자 없이 이름에 점이 있는 파일이 "10"으로
    잘려 엉뚱한 자료끼리 묶인다. MDB 자료명에는 이런 번호 표기가 흔하다.
    """
    name = filename.rsplit("\\", 1)[-1]
    suffix = f".{file_ext}".lower() if file_ext else ""
    if suffix and name.lower().endswith(suffix):
        return name[: -len(suffix)]
    return name


def group_key(source_path: Optional[str], file_ext: Optional[str]) -> str:
    """이 파일이 속한 자료의 열쇠 = "폴더\\자료명" (확장자만 뗀 전체 경로).

    **대소문자까지 정확히 같아야 한 자료다** (2026-08-21 CM 확정, D-47 ④) — `A.xlsx`와
    `a.pdf`는 별개 자료로 남는다. MDB는 화면에 원래 파일명을 그대로 쓰므로, 대소문자를
    무시해 묶으면 `A`로 보이던 자료의 PDF를 받았을 때 `a.pdf`가 되어 사용자가 잘못
    받은 줄 안다. 안 묶인 것을 눈으로 확인하고 이름을 바로잡게 하는 것이 맞다.
    """
    p = normalize(source_path)
    folder = folder_of(p)
    name = doc_name(filename_of(p), file_ext)
    return f"{folder}\\{name}" if folder else name


def row_key(row: MdbFile) -> str:
    return group_key(row.source_path, row.file_ext)


def like_escape(value: str) -> str:
    """LIKE에서 특별한 뜻을 갖는 문자를 막는다. 백슬래시를 PostgreSQL이 이스케이프 문자로
    먹어버리는 문제가 있어 mdb.py matches_folder와 같은 형태를 유지한다."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def same_group_filter(key: str):
    """이 자료에 속할 "수 있는" 행을 좁히는 조건. 확장자만 다른 같은 경로를 고른다.

    LIKE만으로는 "A.b.pdf"처럼 이름 안에 점이 있는 다른 자료까지 걸리므로, 이 조건으로
    후보를 좁힌 뒤 group_key로 한 번 더 확인해야 한다(rows_in_group이 그렇게 한다).
    """
    escaped = like_escape(key)
    return or_(MdbFile.source_path == key, MdbFile.source_path.like(f"{escaped}.%", escape="\\"))


# ---------------------------------------------------------------------------
# 자료 1건 (파일 여러 개를 묶어 화면에 보여줄 값들)
# ---------------------------------------------------------------------------

class MdbGroup:
    """같은 폴더·같은 자료명을 가진 파일들을 묶은 "자료 1건"."""

    def __init__(self, key: str, rows: list[MdbFile], tags: Optional[Iterable[str]] = None):
        # 대표는 항상 가장 먼저 등록된 행(id가 가장 작은 것)이다. 원본을 대표로 삼으면
        # PDF만 있던 자료에 나중에 원본을 붙일 때 대표가 바뀌어, 저장해둔 상세보기 주소나
        # 다운대기함에 담아둔 항목이 다른 자료를 가리키게 된다.
        self.key = key
        self.rows = sorted(rows, key=lambda r: r.id)
        self.tags = sorted({t for t in (tags or []) if t})

    # --- 식별 -------------------------------------------------------------
    @property
    def rep(self) -> MdbFile:
        """대표 행 — 화면·주소에서 이 자료를 가리키는 id의 주인."""
        return self.rows[0]

    @property
    def id(self) -> int:
        return self.rep.id

    @property
    def file_ids(self) -> list[int]:
        return [r.id for r in self.rows]

    @property
    def name(self) -> str:
        """화면에 보여줄 자료명 — 확장자를 뗀 이름 (2026-08-17 CM 확정).

        한 자료에 묶인 파일들은 대소문자까지 이름이 같으므로(group_key) 어느 행에서 읽어도
        같은 값이다.
        """
        return doc_name(self.rep.original_filename, self.rep.file_ext)

    @property
    def folder(self) -> str:
        return folder_of(self.rep.source_path)

    # --- 파일 구성 ---------------------------------------------------------
    @property
    def original_row(self) -> Optional[MdbFile]:
        return next((r for r in self.rows if not r.is_pdf), None)

    @property
    def pdf_row(self) -> Optional[MdbFile]:
        return next((r for r in self.rows if r.is_pdf), None)

    @property
    def has_original(self) -> bool:
        return self.original_row is not None

    @property
    def has_pdf(self) -> bool:
        return self.pdf_row is not None

    @property
    def exts(self) -> list[str]:
        return [(r.file_ext or "").lower() for r in self.rows]

    @property
    def file_size(self) -> int:
        return sum(r.file_size or 0 for r in self.rows)

    # --- 자료 정보 ---------------------------------------------------------
    # 정보(설비유형·자료유형·공사·연도·Note)는 자료 단위 값이라 파일마다 같아야 한다. 편집할 때
    # 자료에 속한 행 전부에 같이 써주므로 보통은 다 같지만, 혹시 어긋나 있어도 화면과
    # 검색이 서로 다른 답을 내지 않도록 "비어 있지 않은 첫 값"으로 통일해서 읽는다.
    def _first(self, attr: str):
        for r in self.rows:
            value = getattr(r, attr)
            if value not in (None, ""):
                return value
        return None

    @property
    def equipment_type(self) -> Optional[str]:
        return self._first("equipment_type")

    @property
    def doc_type(self) -> Optional[str]:
        """자료유형. 설비유형과 마찬가지로 여러 개면 슬래시로 이어진 문자열이다(app/mdb_types.py)."""
        return self._first("doc_type")

    @property
    def project_id(self) -> Optional[int]:
        return self._first("project_id")

    @property
    def project_name(self) -> Optional[str]:
        for r in self.rows:
            if r.project is not None:
                return r.project.name
        return None

    @property
    def year(self) -> Optional[int]:
        return self._first("year")

    @property
    def note(self) -> Optional[str]:
        return self._first("note")

    @property
    def category(self) -> str:
        """전용(Tag No가 붙음) / 공용(Tag No는 없고 설비유형만 있음) / 확인필요(둘 다 없음)."""
        if self.tags:
            return "전용"
        return "공용" if self.equipment_type else "확인필요"

    @property
    def uploaded_at(self):
        return min(r.uploaded_at for r in self.rows)

    @property
    def updated_at(self):
        return max(r.updated_at for r in self.rows)


# ---------------------------------------------------------------------------
# 정렬 — 표 헤더를 누르면 화면의 50건이 아니라 조회 결과 전체가 정렬돼야 한다(공통 규칙,
# documents.py의 apply_sort와 같은 목적). MDB 자료는 SQL이 아니라 파이썬에서 묶으므로
# 여기서도 파이썬으로 정렬한다.
# ---------------------------------------------------------------------------

def _ext_present(group: "MdbGroup", wanted: set[str]) -> int:
    return 1 if set(group.exts) & wanted else 0


MDB_SORT_KEYS = {
    "name": lambda g: g.name.lower(),
    "year": lambda g: g.year or 0,
    "project": lambda g: (g.project_name or "").lower(),
    "path": lambda g: g.folder.lower(),
    "equipment_type": lambda g: (g.equipment_type or "").lower(),
    "doc_type": lambda g: (g.doc_type or "").lower(),
    "dwg": lambda g: _ext_present(g, {"dwg"}),
    "xlsx": lambda g: _ext_present(g, {"xlsx", "xls"}),
    "etc": lambda g: 1 if set(g.exts) - {"dwg", "xlsx", "xls", "pdf"} else 0,
    "pdf": lambda g: 1 if g.has_pdf else 0,
    "updated_at": lambda g: g.updated_at,
}


def sort_groups(groups: list["MdbGroup"], sort: Optional[str], direction: str) -> list["MdbGroup"]:
    """sort가 없거나 모르는 값이면 기본 순서(자료명순).

    같은 값이 여러 건일 때 순서가 흔들리지 않도록, 항상 자료명·id 오름차순으로 먼저
    정렬해둔 뒤(파이썬 sort는 안정 정렬이라 이 순서가 동점자 사이에 유지된다) 그 위에
    실제 정렬 기준을 얹는다 — documents.py apply_sort의 "정렬열, drawing_no, id" 규칙과 동일.
    """
    baseline = sorted(groups, key=lambda g: (g.name.lower(), g.id))
    key_fn = MDB_SORT_KEYS.get(sort or "")
    if key_fn is None:
        return baseline
    return sorted(baseline, key=key_fn, reverse=(direction == "desc"))


def build_groups(rows: Iterable[MdbFile], tags_map: Optional[dict[int, list[str]]] = None) -> list[MdbGroup]:
    """파일 행들을 자료 단위로 묶는다. 자료 안의 Tag No는 파일들의 것을 합친다."""
    tags_map = tags_map or {}
    buckets: dict[str, list[MdbFile]] = {}
    for r in rows:
        buckets.setdefault(row_key(r), []).append(r)
    groups = [
        MdbGroup(key, group_rows, [t for r in group_rows for t in tags_map.get(r.id, [])])
        for key, group_rows in buckets.items()
    ]
    groups.sort(key=lambda g: (g.key.lower(), g.id))
    return groups


def load_tags_map(db: Session, file_ids: list[int]) -> dict[int, list[str]]:
    if not file_ids:
        return {}
    rows = db.query(MdbFileTag).filter(MdbFileTag.mdb_file_id.in_(file_ids)).all()
    result: dict[int, list[str]] = {}
    for r in rows:
        result.setdefault(r.mdb_file_id, []).append(r.tag_no)
    return result


# ---------------------------------------------------------------------------
# 파일 id 하나로 그 자료 전체를 집어오기 — 편집 API들이 "자료 단위"로 움직이게 하는 열쇠.
# 화면은 대표 id 하나만 보내오지만, 이동·삭제·정보수정은 원본과 사본에 함께 적용해야 한다.
# ---------------------------------------------------------------------------

def rows_in_group(db: Session, file_id: int, *, include_archived: bool = False) -> list[MdbFile]:
    """file_id가 속한 자료의 파일 행 전부(원본+사본). 없는 id면 빈 목록."""
    row = db.get(MdbFile, file_id)
    if row is None:
        return []
    key = row_key(row)
    query = db.query(MdbFile).filter(same_group_filter(key))
    if not include_archived:
        query = query.filter(MdbFile.is_archived.is_(False))
    # LIKE로 좁힌 후보 중 정말 같은 자료인 것만 남긴다(위 same_group_filter 설명 참고).
    rows = [r for r in query.all() if row_key(r) == key]
    return sorted(rows, key=lambda r: r.id)


def group_of(db: Session, file_id: int, *, include_archived: bool = False) -> Optional[MdbGroup]:
    rows = rows_in_group(db, file_id, include_archived=include_archived)
    if not rows:
        return None
    return MdbGroup(row_key(rows[0]), rows, _tags_of(db, rows))


def _tags_of(db: Session, rows: list[MdbFile]) -> list[str]:
    tags_map = load_tags_map(db, [r.id for r in rows])
    return [t for values in tags_map.values() for t in values]


def find_group_rows(db: Session, folder: str, name: str, *, include_archived: bool = False) -> list[MdbFile]:
    """폴더와 자료명(확장자 뗀 이름)으로 이미 등록된 자료를 찾는다.
    신규추가·Zip 등록에서 "같은 자리에 같은 자료가 이미 있는지" 볼 때 쓴다."""
    key = f"{folder}\\{name}" if folder else name
    query = db.query(MdbFile).filter(same_group_filter(key))
    if not include_archived:
        query = query.filter(MdbFile.is_archived.is_(False))
    return sorted((r for r in query.all() if row_key(r) == key), key=lambda r: r.id)
