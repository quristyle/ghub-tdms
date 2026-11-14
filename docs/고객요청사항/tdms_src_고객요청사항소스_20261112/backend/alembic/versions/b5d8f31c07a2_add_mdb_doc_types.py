"""add mdb_doc_types and mdb_files.doc_type

Revision ID: b5d8f31c07a2
Revises: a4c7e2b91d05
Create Date: 2026-08-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b5d8f31c07a2'
down_revision: Union[str, Sequence[str], None] = 'a4c7e2b91d05'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    MDB 자료에 "자료유형"을 붙일 수 있게 한다 (2026-08-28 CM 확정).
    설비유형(equipment_types)과 성격이 완전히 같은 마스터 목록 + 자료 쪽 문자열 컬럼 구성이다.

    처음 값은 넣지 않는다 — 어떤 자료유형을 쓸지는 CM이 정할 문제라, 자료명·정보 변경 팝업의
    ✎(자료유형 목록 편집)에서 직접 추가한다. 설비유형처럼 기존 데이터에서 끌어올 값도 없다.
    """
    op.create_table(
        'mdb_doc_types',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('is_hidden', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.add_column('mdb_files', sa.Column('doc_type', sa.Text(), nullable=True))
    op.create_index('ix_mdb_files_doc_type', 'mdb_files', ['doc_type'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_mdb_files_doc_type', table_name='mdb_files')
    op.drop_column('mdb_files', 'doc_type')
    op.drop_table('mdb_doc_types')
