"""add backup_runs

Revision ID: d1f5b83a9c47
Revises: c4a8e2f71b90
Create Date: 2026-09-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd1f5b83a9c47'
down_revision: Union[str, Sequence[str], None] = 'c4a8e2f71b90'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    백업 관리 화면의 이력 표 (2026-09-29 CM 지시, D-105 — 원칙 12·D-18 개정).
    묶음 파일 하나가 한 줄이고, 한 번에 여러 종류를 만들면 set_key가 같은 줄이 여러 개 생긴다.
    변경분은 앞 회차가 있어야 완전하므로, 무엇을 언제 만들고 받았는지가 남아 있어야 한다.
    """
    op.create_table(
        'backup_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('scope', sa.Text(), nullable=False),
        sa.Column('seq', sa.Integer(), nullable=False),
        sa.Column('base_run_id', sa.Integer(), nullable=True),
        sa.Column('set_key', sa.Text(), nullable=False),
        sa.Column('filename', sa.Text(), nullable=False),
        sa.Column('dest_dir', sa.Text(), nullable=True),
        sa.Column('delivery', sa.Text(), nullable=False),
        sa.Column('file_size', sa.BigInteger(), server_default='0', nullable=False),
        sa.Column('source_bytes', sa.BigInteger(), server_default='0', nullable=False),
        sa.Column('file_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('removed_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('manifest_path', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('downloaded_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('download_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['base_run_id'], ['backup_runs.id'], ),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_backup_runs_kind_seq', 'backup_runs', ['kind', 'seq'], unique=False)
    op.create_index('ix_backup_runs_set_key', 'backup_runs', ['set_key'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_backup_runs_set_key', table_name='backup_runs')
    op.drop_index('ix_backup_runs_kind_seq', table_name='backup_runs')
    op.drop_table('backup_runs')
