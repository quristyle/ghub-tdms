"""add purpose_note to distributions

Revision ID: b7e2a19f4c3d
Revises: 4f504958f91b
Create Date: 2026-08-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e2a19f4c3d'
down_revision: Union[str, Sequence[str], None] = '4f504958f91b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    반출목적에 '기타'를 고르면 사유를 적을 수 있게 한다. purpose 값 자체는 여전히
    자유 텍스트 컬럼이라(D-23 MODIFY/REFERENCE) 'OTHER' 추가에 스키마 변경이 필요 없고,
    이 사유만 담을 컬럼을 새로 둔다.
    """
    op.add_column('distributions', sa.Column('purpose_note', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('distributions', 'purpose_note')
