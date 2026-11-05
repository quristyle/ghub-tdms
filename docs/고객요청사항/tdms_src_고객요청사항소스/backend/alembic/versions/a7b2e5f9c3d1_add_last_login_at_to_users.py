"""add last_login_at to users

Revision ID: a7b2e5f9c3d1
Revises: d3f8a1c9b6e4
Create Date: 2026-08-12 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7b2e5f9c3d1'
down_revision: Union[str, Sequence[str], None] = 'd3f8a1c9b6e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    사용자 관리 화면 "접속일" 컬럼(2026-08-12 CM 요청) — 로그인 성공 시각을 그대로 남긴다.
    """
    op.add_column('users', sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'last_login_at')
