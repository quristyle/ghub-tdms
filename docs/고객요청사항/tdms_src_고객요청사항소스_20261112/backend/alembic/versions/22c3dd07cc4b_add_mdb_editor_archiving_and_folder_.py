"""add mdb editor archiving and folder placeholders

Revision ID: 22c3dd07cc4b
Revises: c655edc9305d
Create Date: 2026-08-03 19:20:44.132066

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '22c3dd07cc4b'
down_revision: Union[str, Sequence[str], None] = 'c655edc9305d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('mdb_folder_placeholders',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('path', sa.Text(), nullable=False),
    sa.Column('created_by', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('path')
    )
    op.add_column('mdb_files', sa.Column('is_archived', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('mdb_files', sa.Column('archive_batch_id', sa.Integer(), nullable=True))
    op.create_index('ix_mdb_files_is_archived', 'mdb_files', ['is_archived'], unique=False)
    op.create_foreign_key(None, 'mdb_files', 'archive_batches', ['archive_batch_id'], ['id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(None, 'mdb_files', type_='foreignkey')
    op.drop_index('ix_mdb_files_is_archived', table_name='mdb_files')
    op.drop_column('mdb_files', 'archive_batch_id')
    op.drop_column('mdb_files', 'is_archived')
    op.drop_table('mdb_folder_placeholders')
