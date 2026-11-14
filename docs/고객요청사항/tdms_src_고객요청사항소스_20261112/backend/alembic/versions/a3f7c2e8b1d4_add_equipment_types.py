"""add equipment_types

Revision ID: a3f7c2e8b1d4
Revises: f1a4b6c8d9e2
Create Date: 2026-08-10 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3f7c2e8b1d4'
down_revision: Union[str, Sequence[str], None] = 'f1a4b6c8d9e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 지금까지 mdb.py DEFAULT_EQUIPMENT_TYPES에 하드코딩돼 있던 후보 목록. 이 값들로 시드하고,
# 실제 mdb_files.equipment_type에 이미 쓰인 값 중 여기 없는 것도 함께 넣어 하나도 잃지 않는다.
DEFAULT_EQUIPMENT_TYPES = [
    "Pump", "Valve", "Tank", "Vessel", "Compressor", "Mixer", "Crane",
    "Loading Arm", "Instrument", "Motor", "Strainer", "Electrical", "기타",
]


def upgrade() -> None:
    """Upgrade schema.

    설비유형을 자유 입력(datalist 힌트만 있는 텍스트 필드)에서 projects와 같은 마스터
    테이블 기반 드롭다운으로 바꾼다. 기존에 실제 자료에 쓰인 값을 하나도 잃지 않도록,
    하드코딩돼 있던 기본 후보 + mdb_files에 이미 쓰인 distinct 값을 함께 시드한다.
    """
    op.create_table(
        'equipment_types',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('is_hidden', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )

    conn = op.get_bind()
    existing = [
        row[0] for row in conn.execute(
            sa.text("SELECT DISTINCT equipment_type FROM mdb_files WHERE equipment_type IS NOT NULL")
        )
    ]
    names = sorted({*DEFAULT_EQUIPMENT_TYPES, *existing})
    equipment_types = sa.table(
        'equipment_types',
        sa.column('name', sa.Text()),
    )
    if names:
        conn.execute(equipment_types.insert(), [{"name": n} for n in names])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('equipment_types')
