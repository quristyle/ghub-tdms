"""add reason to archive_batches

Revision ID: f1a4b6c8d9e2
Revises: e3a7c9d21f08
Create Date: 2026-08-10 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1a4b6c8d9e2'
down_revision: Union[str, Sequence[str], None] = 'e3a7c9d21f08'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    폴더·자료 삭제(보관함으로 이동) 시 CM이 남기는 선택 입력 사유. 보관함 화면에서
    나중에도 고쳐 쓸 수 있는 메모칸으로 쓴다(Revision 이력 비고와 같은 성격).
    """
    op.add_column('archive_batches', sa.Column('reason', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('archive_batches', 'reason')
