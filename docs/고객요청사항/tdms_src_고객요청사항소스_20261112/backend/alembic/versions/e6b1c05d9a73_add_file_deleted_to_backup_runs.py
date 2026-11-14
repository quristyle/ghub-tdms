"""add file_deleted_at/by to backup_runs

Revision ID: e6b1c05d9a73
Revises: d1f5b83a9c47
Create Date: 2026-09-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e6b1c05d9a73'
down_revision: Union[str, Sequence[str], None] = 'd1f5b83a9c47'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    백업 이력 줄은 그대로 두고 묶음 파일만 지우는 기능 (2026-09-29 CM 지시, D-107).
    한 번 받아 둔 묶음이 서버 용량을 계속 차지하므로 파일만 지우고, 언제·누가 지웠는지를
    여기 적는다. 이 값이 있으면 화면 상태 칸이 "삭제됨"이고, 값이 없는데 파일도 없으면
    "없음"이다(탐색기에서 지웠거나 옮긴 것).
    """
    op.add_column('backup_runs', sa.Column('file_deleted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('backup_runs', sa.Column('file_deleted_by', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_backup_runs_file_deleted_by_users', 'backup_runs', 'users',
        ['file_deleted_by'], ['id'],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_backup_runs_file_deleted_by_users', 'backup_runs', type_='foreignkey')
    op.drop_column('backup_runs', 'file_deleted_by')
    op.drop_column('backup_runs', 'file_deleted_at')
