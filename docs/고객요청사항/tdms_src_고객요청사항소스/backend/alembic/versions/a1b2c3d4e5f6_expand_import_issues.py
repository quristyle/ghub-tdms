"""expand import_issues: intended_document_id, detail, files

Revision ID: a1b2c3d4e5f6
Revises: 26b8c0ea4e15
Create Date: 2026-07-20 09:00:00.000000

반입 진단 엔진 재작성에 따른 확장.
- intended_document_id: 확인 필요 항목이 어느 도면(반출된 도면) 것으로 추정되는지 (반출 대상 아님이면 NULL)
- detail: 상세 설명용 구조 데이터(기대 경로/이름 vs 실제 등) + 사람이 읽을 문장(text)
- files: 한 확인필요 항목이 여러 파일(원본+PDF)을 가질 수 있어 파일 목록을 JSON으로 저장
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "26b8c0ea4e15"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "import_issues",
        sa.Column("intended_document_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "import_issues",
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "import_issues",
        sa.Column("files", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_foreign_key(
        "fk_import_issues_intended_document",
        "import_issues",
        "documents",
        ["intended_document_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_import_issues_intended_document", "import_issues", type_="foreignkey"
    )
    op.drop_column("import_issues", "files")
    op.drop_column("import_issues", "detail")
    op.drop_column("import_issues", "intended_document_id")
