"""add mdb_tag_histories and mdb_tag_change_reasons

Revision ID: c7e2a9d43b16
Revises: b5d8f31c07a2
Create Date: 2026-08-30 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c7e2a9d43b16'
down_revision: Union[str, Sequence[str], None] = 'b5d8f31c07a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    MDB 관리 화면의 "이력관리" — 어떤 Tag No가 붙은 자료 전부에 Tag No 추가·삭제·변경과
    Note 문구를 한 번에 적용하고, 그 내역을 이력으로 남긴다 (2026-08-30 CM 확정).

    표 두 개를 만든다.
      · mdb_tag_change_reasons : Note 문구에 넣을 "사유"를 고르는 목록. 설비유형·자료유형과
        성격이 같아 서버 코드도 같은 자리(routers/type_lists.py)에서 만든다. 처음에는 비워둔다 —
        어떤 사유를 쓸지는 CM이 [사유 목록 편집]에서 직접 넣는다(자료유형 신설 때와 같은 방식).
      · mdb_tag_histories : 이력 1건. 되돌리기를 정확히 하기 위해 실제로 손댄 파일과 바꾼
        내용을 applied_changes(JSON)에 그대로 적어둔다.
    """
    op.create_table(
        'mdb_tag_change_reasons',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('is_hidden', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )

    op.create_table(
        'mdb_tag_histories',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('base_tag', sa.Text(), nullable=False),
        sa.Column('action', sa.Text(), nullable=False),
        sa.Column('new_tag', sa.Text(), nullable=True),
        sa.Column('project_id', sa.Integer(), nullable=True),
        sa.Column('note_label', sa.Text(), nullable=True),
        sa.Column('note_year', sa.Text(), nullable=True),
        sa.Column('note_project', sa.Text(), nullable=True),
        sa.Column('note_reason', sa.Text(), nullable=True),
        sa.Column('note_memo', sa.Text(), nullable=True),
        sa.Column('note_line', sa.Text(), nullable=True),
        sa.Column('applied_changes', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('applied_doc_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('applied_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('applied_by', sa.Integer(), nullable=True),
        sa.Column('reverted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('reverted_by', sa.Integer(), nullable=True),
        sa.Column('created_by', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ),
        sa.ForeignKeyConstraint(['applied_by'], ['users.id'], ),
        sa.ForeignKeyConstraint(['reverted_by'], ['users.id'], ),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_mdb_tag_histories_base_tag', 'mdb_tag_histories', ['base_tag'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_mdb_tag_histories_base_tag', table_name='mdb_tag_histories')
    op.drop_table('mdb_tag_histories')
    op.drop_table('mdb_tag_change_reasons')
