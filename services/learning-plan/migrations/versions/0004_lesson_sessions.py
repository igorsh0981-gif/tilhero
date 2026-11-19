"""спринт 4: занятия из событий уроков (activities.session_id — идемпотентность по сессии) и пройденные уроки
(completed_lessons — по одной строке на завершённую сессию урока; актуальна последняя сессия урока)

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    # Занятие из lesson.session.completed.v1: одна запись на сессию (повтор события — без второй записи)
    op.add_column("activities", sa.Column("session_id", pg.UUID(as_uuid=True)))
    op.create_index("uq_activities_session", "activities", ["session_id"], unique=True,
                    postgresql_where=sa.text("session_id IS NOT NULL"))
    op.create_table(
        "completed_lessons",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(64), nullable=False),
        sa.Column("lesson_id", sa.String(200), nullable=False),
        sa.Column("passed", sa.Boolean()),
        sa.Column("evaluation_id", pg.UUID(as_uuid=True)),
        sa.Column("completed_at", TS, nullable=False),
        sa.Column("recorded_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_completed_lessons_user_lesson", "completed_lessons",
                    ["user_id", "pair_id", "lesson_id", "completed_at"])
    op.create_index("ix_completed_lessons_user_evaluation", "completed_lessons", ["user_id", "evaluation_id"])


def downgrade() -> None:
    op.drop_index("ix_completed_lessons_user_evaluation", table_name="completed_lessons")
    op.drop_index("ix_completed_lessons_user_lesson", table_name="completed_lessons")
    op.drop_table("completed_lessons")
    op.drop_index("uq_activities_session", table_name="activities")
    op.drop_column("activities", "session_id")
