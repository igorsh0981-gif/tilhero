"""спринт 4: навыки по оценкам уроков — skill_states.state_ref (свидетельство, установившее текущее состояние) и
lesson_evaluations (полученные оценки assessment: идемпотентность, цепочка переоценок, practice_only)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    # ref_id свидетельства, установившего текущее состояние (result_id диагностики | evaluation_id оценки урока):
    # переоценка возвращает в learning только навык, демонстрация которого держалась на заменённой оценке
    op.add_column("skill_states", sa.Column("state_ref", sa.String(64)))
    op.create_table(
        "lesson_evaluations",
        sa.Column("evaluation_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("session_id", pg.UUID(as_uuid=True)),
        sa.Column("supersedes", pg.UUID(as_uuid=True)),
        sa.Column("practice_only", sa.Boolean(), nullable=False),
        sa.Column("outcomes", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("received_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("jsonb_typeof(outcomes) = 'array'", name="ck_lesson_evaluations_outcomes"),
    )
    op.create_index("ix_lesson_evaluations_supersedes", "lesson_evaluations", ["user_id", "supersedes"])
    # полученная оценка не меняется (UPDATE запрещён; DELETE — только сага удаления ученика)
    op.execute("CREATE TRIGGER lesson_evaluations_immutable BEFORE UPDATE ON lesson_evaluations "
               "FOR EACH ROW EXECUTE FUNCTION diagnostics_append_only()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS lesson_evaluations_immutable ON lesson_evaluations")
    op.drop_index("ix_lesson_evaluations_supersedes", table_name="lesson_evaluations")
    op.drop_table("lesson_evaluations")
    op.drop_column("skill_states", "state_ref")
