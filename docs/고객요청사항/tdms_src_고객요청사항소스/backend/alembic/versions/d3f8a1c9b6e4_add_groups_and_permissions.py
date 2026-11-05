"""add groups, group_permissions, users.group_id

Revision ID: d3f8a1c9b6e4
Revises: b4c9d1e7f302
Create Date: 2026-08-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd3f8a1c9b6e4'
down_revision: Union[str, Sequence[str], None] = 'b4c9d1e7f302'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    권한 관리 화면(2026-08-11 CM 요청): 그룹 + 그룹별 권한 트리(leaf 노드만 저장).
    """
    op.create_table(
        'groups',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('name'),
    )

    op.create_table(
        'group_permissions',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('group_id', sa.Integer(), sa.ForeignKey('groups.id'), nullable=False),
        sa.Column('node_key', sa.Text(), nullable=False),
        sa.Column('allowed', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('group_id', 'node_key', name='uq_group_permissions_group_node'),
    )
    op.create_index('ix_group_permissions_group_id', 'group_permissions', ['group_id'])

    op.add_column('users', sa.Column('group_id', sa.Integer(), sa.ForeignKey('groups.id'), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'group_id')
    op.drop_index('ix_group_permissions_group_id', table_name='group_permissions')
    op.drop_table('group_permissions')
    op.drop_table('groups')
