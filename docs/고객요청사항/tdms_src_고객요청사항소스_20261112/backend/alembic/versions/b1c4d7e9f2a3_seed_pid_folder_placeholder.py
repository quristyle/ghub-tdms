"""seed P&ID(5.2) folder as a real folder_placeholders row

Revision ID: b1c4d7e9f2a3
Revises: a7b2e5f9c3d1
Create Date: 2026-08-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b1c4d7e9f2a3'
down_revision: Union[str, Sequence[str], None] = 'a7b2e5f9c3d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PID_PATH = "5. DRAWINGS\\5.2   Process & Instrument Diagram"
SYSTEM_USERNAME = "bulk_import_system"


def upgrade() -> None:
    """Upgrade schema.

    D-9: P&ID(5.2)는 실데이터 0건이지만 폴더 자체는 있어야 하므로, 지금까지 editor.py/
    documents.py에 하드코딩된 경로 문자열("always_show")로만 화면에 표시해왔다. 그 방식은
    folder_placeholders 테이블에 실제 행이 없어 폴더명 변경(reparent)이 적용될 대상이 없고,
    화면을 새로고침할 때마다 코드에 박힌 원래 이름으로 계속 되돌아오는 문제가 있었다.
    이 폴더를 다른 빈 폴더와 동일하게 folder_placeholders에 실제로 등록해, 이름 변경·이동이
    다른 폴더와 똑같이 동작하도록 한다.
    """
    conn = op.get_bind()
    system_user_id = conn.execute(
        sa.text("SELECT id FROM users WHERE username = :u"), {"u": SYSTEM_USERNAME}
    ).scalar()
    if system_user_id is None:
        # 초기 적재를 아직 안 돌린 신규 환경 등 — 계정이 없으면 조용히 건너뛴다.
        return

    already = conn.execute(
        sa.text("SELECT 1 FROM folder_placeholders WHERE path = :p"), {"p": PID_PATH}
    ).scalar()
    already_real = conn.execute(
        sa.text("SELECT 1 FROM documents WHERE source_path = :p AND is_archived = false LIMIT 1"),
        {"p": PID_PATH},
    ).scalar()
    if already or already_real:
        return

    conn.execute(
        sa.text(
            "INSERT INTO folder_placeholders (path, created_by, created_at) "
            "VALUES (:p, :u, now())"
        ),
        {"p": PID_PATH, "u": system_user_id},
    )


def downgrade() -> None:
    """Downgrade schema."""
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM folder_placeholders WHERE path = :p"), {"p": PID_PATH})
