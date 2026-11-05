"""검수 대기에 남아있던 '표기 불일치'(rev_mismatch_warning) 건을 확인필요로 옮기는 1회성 보정 스크립트.

2026-08-18 CM 확정: 표기 불일치는 검수대기에서 빨간 줄로 보여주고 승인/반려로 판단하게
하던 방식을 버리고, 확인필요 큐에서 [비교]로 확인한 뒤 [재검수]로 통과시키는 방식으로
바꿨다(CLAUDE.md D-14 재확인). 이 규칙은 앞으로의 반입에는 자동으로 적용되지만
(app/routers/imports.py), 이미 검수대기에 올라와 있던 건은 코드가 바뀐다고 저절로
안 옮겨지므로 이 스크립트로 한 번 옮겨준다. 실행은 한 번이면 충분하다 — 그 뒤로는
반입 파이프라인이 알아서 확인필요로 보낸다.

옮겨진 파일은 지우지 않는다(D-6) — 반려(REJECTED)로 이력에 남고, 확인필요 항목이
새로 생긴다.

실행 예:
    venv\\Scripts\\python.exe scripts\\migrate_pending_mismatch_to_issues.py
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.config import STORAGE_ROOT  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, Distribution, Document  # noqa: E402
from app.models import File as FileModel  # noqa: E402
from app.routers.imports import IncomingFile, move_to_history, save_issue  # noqa: E402
from bulk_import import get_or_create_system_user  # noqa: E402


def main():
    session = SessionLocal()
    system_user = get_or_create_system_user(session)
    session.commit()
    now = datetime.now(timezone.utc)

    doc_ids = {
        row[0] for row in session.query(FileModel.document_id)
        .filter(FileModel.review_status == "PENDING_REVIEW", FileModel.rev_mismatch_warning.is_(True))
        .distinct()
    }
    if not doc_ids:
        print("표기 불일치로 검수대기에 남아있는 건이 없습니다. 할 일이 없습니다.")
        return

    moved = 0
    for document_id in doc_ids:
        doc = session.get(Document, document_id)
        if doc is None:
            continue
        rows = (
            session.query(FileModel)
            .filter(FileModel.document_id == document_id, FileModel.review_status == "PENDING_REVIEW")
            .all()
        )
        groups: dict[tuple, list[FileModel]] = {}
        for f in rows:
            groups.setdefault((f.rev, f.branch), []).append(f)

        for (rev, branch), files in groups.items():
            if not any(f.rev_mismatch_warning for f in files):
                continue

            vendor_name = files[0].vendor_name
            project_id = files[0].project_id
            labeled = sorted({f.vendor_labeled_rev for f in files if f.vendor_labeled_rev})
            incoming = [
                IncomingFile(
                    folder=None, filename=f.original_filename, ext=f.file_ext,
                    data=(Path(STORAGE_ROOT) / f.file_path).read_bytes(),
                    zip_path=f.original_filename,
                )
                for f in files
            ]
            detail = {
                "text": f"'{doc.drawing_no}'의 시스템 리비전은 {rev}인데, 첨부 파일에 표기된 "
                        f"리비전은 {', '.join(labeled) or '(표기 없음)'}(으)로 다릅니다. "
                        f"확인 후 문제없으면 [재검수]를 눌러 검수 대기로 등록하세요. "
                        f"(2026-08-18 규칙 변경으로 검수대기에서 옮겨진 건입니다.)",
            }
            save_issue(
                session, system_user, now,
                intended_document_id=document_id, vendor_name=vendor_name,
                project_id=project_id, reasons=["REV_MISMATCH"], detail=detail, incoming=incoming,
            )

            # 표기 불일치도 반려와 같은 방식으로 이력에 남긴다(D-6) — 정수는 그대로 두고
            # 글자(a, b, c…)만 붙인다. review_revision의 REJECT 처리와 같은 규칙.
            reject_letter = branch
            if reject_letter is None:
                prior = {
                    b for (b,) in session.query(FileModel.branch)
                    .filter(FileModel.document_id == document_id, FileModel.rev == rev,
                            FileModel.branch.isnot(None), FileModel.review_status == "REJECTED")
                    .distinct()
                }
                reject_letter = chr(ord("a") + len(prior))
            # 반려된 파일이 반출 건의 반납으로 연결돼 있었으면 다시 '미반납'으로 되돌린다
            # (review_revision의 REJECT 처리와 같은 규칙 — 안 하면 반출 건이 반납된 것으로
            # 잘못 남아, 나중에 [재검수]할 때 '기 반입 완료'로 잘못 걸린다).
            file_ids = [f.id for f in files]
            reopened = session.query(Distribution).filter(Distribution.returned_file_id.in_(file_ids)).all()
            for d in reopened:
                d.returned_at = None
                d.returned_file_id = None

            for f in files:
                f.review_status = "REJECTED"
                f.review_note = "표기 불일치 확인을 위해 확인필요로 이동 (2026-08-18 규칙 변경, 자동 보정)"
                f.branch = reject_letter
                move_to_history(doc, f)
            doc.updated_at = now

            session.add(AuditLog(
                user_id=system_user.id, action="REV_MISMATCH_TO_ISSUE", screen="반입·검수",
                document_id=document_id, detail={"rev": rev, "branch": reject_letter},
            ))
            moved += 1

    session.commit()
    print(f"{moved}건을 확인필요로 옮겼습니다.")


if __name__ == "__main__":
    main()
