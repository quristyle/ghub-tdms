"""add auto_apply to mdb_tag_histories

Revision ID: e4b1d7a30c58
Revises: c7e2a9d43b16
Create Date: 2026-09-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e4b1d7a30c58'
down_revision: Union[str, Sequence[str], None] = 'c7e2a9d43b16'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Tag No 이력에 "앞으로 자동 적용" 스위치를 단다 (2026-09-01 CM 확정).

    이력은 등록하는 그때 있던 자료에만 들어간다. 나중에 어떤 자료에 그 Tag No를 새로 달면
    같은 처리를 또 손으로 해야 했는데, 이 값이 켜져 있으면 시스템이 그 자리에서 자동으로
    넣어준다(Tag No 추가·Note 한 줄).

    **새로 등록하는 이력은 켜짐이 기본이고(server_default true), 이 컬럼이 생기기 전에
    등록돼 있던 이력은 꺼짐으로 넣는다** — 예전에 등록한 이력이 어떤 것인지 다 기억하지
    못하는 상태에서 Tag No를 넣을 때마다 옛 이력이 저절로 발동하면 놀라기 때문이다.
    필요한 이력은 목록에서 [수정]으로 켜면 된다.
    """
    op.add_column(
        'mdb_tag_histories',
        sa.Column('auto_apply', sa.Boolean(), server_default='true', nullable=False),
    )
    op.execute('UPDATE mdb_tag_histories SET auto_apply = false')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('mdb_tag_histories', 'auto_apply')
