"""спринт 4, R1-05: проекция оценок уроков (assessment.completed.v1 / assessment.reevaluated.v1) — оценка,
полученная после завершения сессии, и переоценка сопоставляются с пройденным уроком по session_id

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "lesson_evaluations",
        sa.Column("evaluation_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", pg.UUID(as_uuid=True)),
        sa.Column("supersedes", pg.UUID(as_uuid=True)),
        sa.Column("passed", sa.Boolean()),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("recorded_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_lesson_evaluations_user_session", "lesson_evaluations",
                    ["user_id", "session_id", "created_at"])
    op.create_index("ix_lesson_evaluations_user_supersedes", "lesson_evaluations", ["user_id", "supersedes"])


def downgrade() -> None:
    op.drop_index("ix_lesson_evaluations_user_supersedes", table_name="lesson_evaluations")
    op.drop_index("ix_lesson_evaluations_user_session", table_name="lesson_evaluations")
    op.drop_table("lesson_evaluations")
