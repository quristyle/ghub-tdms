"""add employment_status, updated_at to users

Revision ID: b4c9d1e7f302
Revises: a3f7c2e8b1d4
Create Date: 2026-08-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4c9d1e7f302'
down_revision: Union[str, Sequence[str], None] = 'a3f7c2e8b1d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    사용자 관리 화면에 재직/퇴직/삭제 3단계 상태를 보여주기 위한 컬럼. "삭제"도 D-6에 따라
    실제로는 비활성화일 뿐이라, 기존 is_active는 그대로 두고 화면 표시용 값만 추가한다.
    기존 계정은 is_active 값 그대로 ACTIVE/RETIRED로 나눠 채운다(과거엔 "삭제" 구분이 없었으므로).
    """
    op.add_column(
        'users',
        sa.Column('employment_status', sa.Text(), server_default='ACTIVE', nullable=False),
    )
    op.add_column(
        'users',
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    conn = op.get_bind()
    conn.execute(sa.text("UPDATE users SET employment_status = 'RETIRED' WHERE is_active = false"))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'updated_at')
    op.drop_column('users', 'employment_status')
