"""add zip_filename to distributions

Revision ID: e3a7c9d21f08
Revises: b7e2a19f4c3d
Create Date: 2026-08-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e3a7c9d21f08'
down_revision: Union[str, Sequence[str], None] = 'b7e2a19f4c3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    반출이력 화면의 "Zip" 모드용: 반출하기 한 번에 생성된 zip 파일명을 그 묶음의
    모든 distributions 행에 같이 저장해, zip 파일명 기준으로 묶어 보여줄 수 있게 한다.
    """
    op.add_column('distributions', sa.Column('zip_filename', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('distributions', 'zip_filename')
