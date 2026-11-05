"""add user_favorites

Revision ID: f2c6a8b41d97
Revises: e4b1d7a30c58
Create Date: 2026-09-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2c6a8b41d97'
down_revision: Union[str, Sequence[str], None] = 'e4b1d7a30c58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    즐겨찾기 표를 만든다 (2026-09-05 CM 지시).

    사용자 한 사람이 "나중에 다시 볼 자료"로 담아 둔 것 1건 = 1행이다. 자료 자체와는
    아무 상관이 없는 개인 바로가기라, 담아도 자료는 변하지 않고 지워도 자료는 그대로 남는다.
    미리보기에서 그린 표시(도형·문구·형광펜·도장)를 함께 담아 두면 나중에 이어서 그릴 수
    있는데, 그 표시는 PDF를 통째로 복사하지 않고 그린 내용만 JSON 파일로 남기고
    여기에는 그 파일의 경로만 적는다(파일 자체를 DB에 넣지 않는다는 프로젝트 규칙 그대로).
    """
    op.create_table(
        'user_favorites',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('document_id', sa.Integer(), nullable=True),
        sa.Column('mdb_file_id', sa.Integer(), nullable=True),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('has_markup', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('markup_path', sa.Text(), nullable=True),
        sa.Column('pdf_file_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ),
        sa.ForeignKeyConstraint(['mdb_file_id'], ['mdb_files.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_user_favorites_user_id', 'user_favorites', ['user_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_user_favorites_user_id', table_name='user_favorites')
    op.drop_table('user_favorites')
