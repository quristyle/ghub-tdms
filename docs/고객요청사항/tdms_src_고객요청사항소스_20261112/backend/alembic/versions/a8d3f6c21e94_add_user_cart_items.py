"""add user_cart_items (반출대기함·다운대기함을 사람마다 서버에 저장, 2026-10-14 CM 지시 D-112)

Revision ID: a8d3f6c21e94
Revises: f2c8a4d19e60
Create Date: 2026-10-14 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a8d3f6c21e94'
down_revision: Union[str, Sequence[str], None] = 'f2c8a4d19e60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """item_id에는 외래키를 걸지 않는다 — 담아 둔 자료가 [완전 삭제]돼도 이 줄은 남아
    "삭제됨"으로 보여야 하기 때문이다(models.UserCartItem 설명 참고)."""
    op.create_table(
        'user_cart_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('item_id', sa.Integer(), nullable=False),
        sa.Column('item_name', sa.Text(), nullable=False),
        sa.Column('added_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'kind', 'item_id', name='uq_user_cart_items_user_kind_item'),
    )
    op.create_index('ix_user_cart_items_user_kind', 'user_cart_items', ['user_id', 'kind'])


def downgrade() -> None:
    op.drop_index('ix_user_cart_items_user_kind', table_name='user_cart_items')
    op.drop_table('user_cart_items')
