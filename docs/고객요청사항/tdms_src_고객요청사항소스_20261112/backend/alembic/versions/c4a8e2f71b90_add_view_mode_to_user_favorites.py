"""add view_mode to user_favorites

Revision ID: c4a8e2f71b90
Revises: b7d3e9a15c42
Create Date: 2026-09-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4a8e2f71b90'
down_revision: Union[str, Sequence[str], None] = 'b7d3e9a15c42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    보관할 때 미리보기에서 사본(PDF)을 보고 있었는지 원본(DWG·엑셀 등)을 보고 있었는지를
    적어 둔다(D-102 ⑦ — 다시 열면 보관할 때 보던 쪽으로 연다). 비어 있으면 사본이다
    (이 칸이 생기기 전에 보관한 것은 전부 사본을 보면서 보관한 것이다).
    """
    op.add_column('user_favorites', sa.Column('view_mode', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('user_favorites', 'view_mode')
