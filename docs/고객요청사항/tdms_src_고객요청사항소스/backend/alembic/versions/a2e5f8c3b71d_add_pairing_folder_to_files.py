"""add pairing_folder to files

Revision ID: a2e5f8c3b71d
Revises: b1c4d7e9f2a3
Create Date: 2026-08-16 10:20:00.000000

DWG·PDF 형제 폴더를 한 자료로 합칠 때, 예전에는 폴더 이름을 아예 버려서 원본이 어느
폴더에 있었는지가 사라졌다(그래서 반출할 때도 폴더를 재현할 수 없었다). 이제 파일마다
"이 파일이 있던 DWG/PDF 폴더 이름"을 남긴다 — 화면에서는 계속 숨기고, 실제 저장 위치와
반출 폴더에서만 되살린다 (2026-08-16 CM 확정).

기존 행은 전부 NULL(=폴더 없음)이 맞다. 초기 적재분은 폴더 경로를 그대로 갖고 있고,
지금까지 Zip으로 합쳐 등록된 것들은 폴더 이름이 이미 지워져 복원할 방법이 없다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a2e5f8c3b71d'
down_revision: Union[str, Sequence[str], None] = 'b1c4d7e9f2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('files', sa.Column('pairing_folder', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('files', 'pairing_folder')
