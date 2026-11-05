"""add keep_paths to distributions

Revision ID: a4c7e2b91d05
Revises: c9f1a6b3d804
Create Date: 2026-08-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a4c7e2b91d05'
down_revision: Union[str, Sequence[str], None] = 'c9f1a6b3d804'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    반출하기 팝업의 [폴더 경로 유지]를 껐는지 여부. 화면에 보이는 칸이 아니라,
    나중에 반출이력 화면에서 같은 zip을 다시 받을 때 그때와 같은 모양으로 내려주기
    위한 기록이다(2026-08-28 CM 확정). 예전 반출 기록은 전부 폴더 구조를 유지한
    것이므로 기본값 true로 채운다.
    """
    op.add_column(
        'distributions',
        sa.Column('keep_paths', sa.Boolean(), nullable=False, server_default=sa.text('true')),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('distributions', 'keep_paths')
