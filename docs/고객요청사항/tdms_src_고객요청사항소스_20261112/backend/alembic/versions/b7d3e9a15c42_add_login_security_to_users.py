"""add login security columns to users

Revision ID: b7d3e9a15c42
Revises: a5e9c1d63b28
Create Date: 2026-09-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d3e9a15c42'
down_revision: Union[str, Sequence[str], None] = 'a5e9c1d63b28'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Azure 시험 설치를 앞둔 시큐어코딩으로 로그인 보안 칸 셋을 더한다 (2026-09-17 CM 지시).
      must_change_password : 임시 비밀번호로 들어온 사람은 새 비밀번호로 바꾸기 전엔 다른 화면을 못 쓴다
      failed_login_count   : 비밀번호를 연속으로 틀린 횟수(5번이면 잠근다)
      locked_until         : 이 시각까지 로그인 잠김

    지금 있는 계정은 비밀번호를 그대로 둔다(must_change_password = false) — 처음엔 전부 다음 로그인 때
    바꾸게 했다가 같은 날 CM 지시("비밀번호는 그대로 둬라")로 되돌렸다.
    """
    op.add_column('users', sa.Column('must_change_password', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('users', sa.Column('failed_login_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('users', sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'locked_until')
    op.drop_column('users', 'failed_login_count')
    op.drop_column('users', 'must_change_password')
