"""폐기 보관함 — "삭제"와 다른, 지금 최신본에는 없지만 이력으로 남겨두는 자료의 자리
(2026-08-30 CM 확정). TDB·MDB가 같은 규칙을 쓰므로 여기 한 곳에만 둔다.

삭제와 폐기의 차이 (CM 설명 그대로):
  삭제 — 오류 등으로 자료가 온전한 기능을 하지 못할 때 완전히 없애는 것. 삭제 보관함에
         들어가고, 용량이 문제가 되면 [완전 삭제]까지 갈 수 있다(D-38).
  폐기 — 과거에는 온전한 기능을 했지만 리비전이 진행되면서 최신본에 포함되지 못하게 된 것.
         (A폴더에 도면 1~10번이 있는데 리비전 후 10번이 더 이상 필요 없어진 경우)
         폴더 트리에서는 사라지되 **나중에 이력을 찾을 수 있어야 하므로 계속 보관한다.**
         그래서 폐기 보관함에는 완전 삭제가 없고 [복구]만 있다.

담는 방식은 삭제 보관함과 같은 표(archive_batches)를 쓰고 kind로만 구분한다. 자료를 화면에서
감추는 일은 이미 documents.is_archived / mdb_files.is_archived 한 값이 하고 있어서(트리·목록·
검색·반출·엑셀이 전부 이 값만 본다) 폐기도 같은 스위치를 쓰면 어느 화면으로도 새어나오지
않는다. 삭제 보관함 목록·건수·완전삭제는 전부 kind로 걸러 조회하므로 폐기 건이 그쪽에
섞이지도 않는다.

**자료 1건 = 폐기 이력 1건**이다(삭제 보관함은 폴더째 묶어 한 줄인 것과 다르다). 폐기 보관함
표는 자료마다 한 줄이고 줄마다 비고를 쓰므로, 여러 건을 한 번에 폐기해도 자료마다 따로 남긴다.
"""

from typing import Optional

from sqlalchemy.orm import Session

from app.models import ArchiveBatch

# archive_batches.kind 값 — 삭제 보관함(FOLDER/DOCUMENT, MDB_FOLDER/MDB_FILE)과 겹치지 않는다.
TDB_RETIRE_KIND = "RETIRE"
MDB_RETIRE_KIND = "MDB_RETIRE"


def is_retired_row(db: Session, archive_batch_id: Optional[int], kind: str) -> bool:
    """이 자료가 (삭제가 아니라) 폐기된 것이고 아직 복구되지 않았는지.

    폐기 자료는 상세보기·미리보기가 열려야 하지만(이력을 찾는 것이 폐기의 목적) 삭제 보관함에
    들어간 자료는 지금처럼 안 열려야 한다. 둘 다 is_archived=true라 이 확인이 필요하다.
    """
    if archive_batch_id is None:
        return False
    batch = db.get(ArchiveBatch, archive_batch_id)
    return batch is not None and batch.kind == kind and batch.restored_at is None

