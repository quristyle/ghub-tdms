"""drop backup_runs (백업 관리 기능 삭제, 2026-10-14 CM 지시)

Revision ID: f2c8a4d19e60
Revises: e6b1c05d9a73
Create Date: 2026-10-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f2c8a4d19e60'
down_revision: Union[str, Sequence[str], None] = 'e6b1c05d9a73'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table("backup_runs")


def downgrade() -> None:
    # 백업 기능을 다시 만들 때는 d1f5b83a9c47 이후 모양으로 새로 만든다 (되돌리기 없음).
    pass
