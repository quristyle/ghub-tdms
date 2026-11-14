"""add screen tag to audit log

Revision ID: 4f504958f91b
Revises: 22c3dd07cc4b
Create Date: 2026-08-03 19:31:55.061748

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4f504958f91b'
down_revision: Union[str, Sequence[str], None] = '22c3dd07cc4b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    screen 컬럼을 추가하고, 기존 행은 action(+일부는 detail 안의 실마리)으로 최대한
    화면을 되짚어 채운다. 앞으로 새로 남는 로그는 코드에서 직접 screen을 넣으므로 정확하고,
    이 백필은 과거 기록에 한해서만 하는 최선의 추정이다 — action 하나(EXPORT/DOWNLOAD/
    REGISTER/APPROVE)가 여러 화면에서 재사용돼 detail 힌트가 없으면 화면 미상(NULL)으로 남는다.
    """
    op.add_column('audit_log', sa.Column('screen', sa.Text(), nullable=True))
    op.create_index('ix_audit_log_screen', 'audit_log', ['screen'], unique=False)

    # 화면이 하나로 고정되는 action들
    op.execute("""
        UPDATE audit_log SET screen = '로그인' WHERE action = 'LOGIN'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '반입·검수'
        WHERE action IN (
            'UPLOAD', 'MERGE_REQUIRED', 'REJECT', 'BRANCH_MERGE_APPROVE',
            'IMPORT_ISSUE_RETARGET', 'IMPORT_ISSUE_RESOLVE', 'IMPORT_ISSUE_RECHECK',
            'IMPORT_ISSUE_REATTACH', 'IMPORT_ISSUE_DISCARD'
        )
    """)
    op.execute("""
        UPDATE audit_log SET screen = '폴더·자료 편집'
        WHERE action IN (
            'ADD_FOLDER', 'RENAME_FOLDER', 'DELETE_EMPTY_FOLDER', 'ARCHIVE_FOLDER',
            'RENAME_DOCUMENT', 'MOVE_DOCUMENT', 'ARCHIVE_DOCUMENT',
            'RESTORE_FROM_TRASH', 'ZIP_REGISTER'
        )
    """)
    op.execute("""
        UPDATE audit_log SET screen = 'MDB' WHERE action = 'MDB_EDIT'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '반출 이력' WHERE action = 'RETURN'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '도면 목록' WHERE action IN ('DISTRIBUTE', 'UPDATE_NOTE')
    """)

    # EXPORT — detail.kind/scope/table로 구분
    op.execute("""
        UPDATE audit_log SET screen = '도면 목록'
        WHERE action = 'EXPORT' AND (
            detail->>'kind' IN ('Revision이력', '반출이력(상세)')
            OR (detail IS NOT NULL AND NOT (detail ? 'kind') AND NOT (detail ? 'scope') AND NOT (detail ? 'table'))
        )
    """)
    op.execute("""
        UPDATE audit_log SET screen = '반입·검수'
        WHERE action = 'EXPORT' AND detail->>'kind' IN ('검수대기', '중복반출현황', '확인필요', '자료검색')
    """)
    op.execute("""
        UPDATE audit_log SET screen = '반출 이력'
        WHERE action = 'EXPORT' AND detail->>'kind' IN ('미입고현황', '반출이력')
    """)
    op.execute("""
        UPDATE audit_log SET screen = '폴더·자료 편집'
        WHERE action = 'EXPORT' AND detail->>'kind' = '보관함'
    """)
    op.execute("""
        UPDATE audit_log SET screen = 'MDB' WHERE action = 'EXPORT' AND detail->>'scope' = 'mdb'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '감사로그' WHERE action = 'EXPORT' AND detail->>'table' = 'audit_log'
    """)

    # DOWNLOAD — mdb_file_id/kind로 구분, 그 외(files.py, document_id 있음)는 도면 목록
    op.execute("""
        UPDATE audit_log SET screen = 'MDB' WHERE action = 'DOWNLOAD' AND detail ? 'mdb_file_id'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '폴더·자료 편집' WHERE action = 'DOWNLOAD' AND detail->>'kind' = '보관함'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '도면 목록'
        WHERE action = 'DOWNLOAD' AND NOT (detail ? 'mdb_file_id') AND COALESCE(detail->>'kind', '') <> '보관함'
    """)

    # REGISTER / APPROVE — editor.py만 detail.via를 쓴다
    op.execute("""
        UPDATE audit_log SET screen = '폴더·자료 편집'
        WHERE action IN ('REGISTER', 'APPROVE') AND detail ? 'via'
    """)
    op.execute("""
        UPDATE audit_log SET screen = '반입·검수'
        WHERE action IN ('REGISTER', 'APPROVE') AND NOT (detail ? 'via')
    """)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_audit_log_screen', table_name='audit_log')
    op.drop_column('audit_log', 'screen')
