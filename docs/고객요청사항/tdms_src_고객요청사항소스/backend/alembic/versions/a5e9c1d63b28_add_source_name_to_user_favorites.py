"""add source_name to user_favorites

Revision ID: a5e9c1d63b28
Revises: f2c6a8b41d97
Create Date: 2026-09-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a5e9c1d63b28'
down_revision: Union[str, Sequence[str], None] = 'f2c6a8b41d97'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    저장 목록(옛 즐겨찾기)에 "저장할 때의 자료명"을 함께 적어 둔다 (2026-09-05 CM 지시).

    저장 이름(name)은 [다른 이름으로 저장]으로 사용자가 직접 적었을 수도 있고, 편집 내용이
    있으면 뒤에 "(Markup)"이 붙기도 한다. 그래서 그 값만으로는 "자료명이 그 사이에 바뀌었는지"를
    알 수 없다. 목록의 `상태` 칸이 그것을 알려줘야 하므로(CM 지시: 삭제되었거나 이름이 바뀌었을
    때만 표시), 저장 당시의 자료명을 따로 적어 둔다.

    이 컬럼이 생기기 전에 저장돼 있던 것은 이름 끝의 "(Markup)"만 떼어 채운다 — 그때는
    저장 이름이 곧 자료명이었으므로 그것으로 정확히 복원된다.
    """
    op.add_column('user_favorites', sa.Column('source_name', sa.Text(), nullable=True))
    op.execute(
        "UPDATE user_favorites "
        "SET source_name = CASE WHEN name LIKE '%(Markup)' "
        "THEN left(name, length(name) - length('(Markup)')) ELSE name END"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('user_favorites', 'source_name')
