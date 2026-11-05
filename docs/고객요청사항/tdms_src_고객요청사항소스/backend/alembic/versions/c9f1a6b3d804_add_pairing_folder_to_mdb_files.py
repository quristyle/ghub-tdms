"""add pairing_folder to mdb_files

Revision ID: c9f1a6b3d804
Revises: a2e5f8c3b71d
Create Date: 2026-08-17 15:10:00.000000

MDB도 TDB처럼 "원본 + PDF 사본"을 자료 1건으로 보여주기로 했다(2026-08-17 CM 확정).

MDB 자료 1건의 기준은 "같은 폴더 + 같은 자료명(확장자 뗀 이름)"이다. 같은 폴더에 나란히
있는 A.xls + A.pdf는 이 규칙만으로 저절로 한 건이 되므로 옮길 데이터가 없다(실데이터 42쌍).

이 컬럼이 필요한 건 원본과 사본이 CAD·PDF 폴더로 나뉘어 들어온 경우다 — 그 폴더 이름을
여기 적어두고 source_path에서는 빼야 두 파일의 "폴더 + 자료명"이 같아져 한 건으로 묶인다.
files.pairing_folder와 같은 역할이고, 화면에서는 숨기되 실제 저장 위치에는 재현한다.

기존 행은 전부 NULL(=그런 폴더 없음)이 맞다. 지금 등록된 CAD 폴더 4개는 짝이 될 PDF 폴더가
없어 아직 병합 대상이 아니고, 병합은 MDB 관리의 [DWG·PDF 폴더 병합]에서 CM이 직접 한다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9f1a6b3d804'
down_revision: Union[str, Sequence[str], None] = 'a2e5f8c3b71d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('mdb_files', sa.Column('pairing_folder', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('mdb_files', 'pairing_folder')
