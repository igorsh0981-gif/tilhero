"""спринт 5: практика «Чтение» — kind `reading` (sessions.reading_id), этапы `reading` и `questions`, шаг `reading`;
индекс последних результатов чтения ученика (ReadingCard.last_result)

Откат удаляет сессии чтения (с шагами и историей — каскадом): старые CHECK их не допускают.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

KINDS_V1 = "kind IN ('lesson','scenario','media','review')"
KINDS_V2 = "kind IN ('lesson','scenario','media','review','reading')"
STAGES_V1 = "IN ('retrieval','explanation','roleplay','assessment','summary','listen','exercises')"
STAGES_V2 = "IN ('retrieval','explanation','roleplay','assessment','summary','listen','exercises','reading','questions')"
STEP_TYPES_V1 = "IN ('notice','explanation','item','roleplay','roleplay_end','listen','open_answer','done')"
STEP_TYPES_V2 = "IN ('notice','explanation','item','roleplay','roleplay_end','listen','open_answer','reading','done')"
TARGET_V1 = ("(kind <> 'lesson' OR lesson_id IS NOT NULL) AND (kind <> 'scenario' OR scenario_id IS NOT NULL) AND "
             "(kind <> 'media' OR asset_id IS NOT NULL) AND (kind <> 'review' OR source_session_id IS NOT NULL)")
TARGET_V2 = f"{TARGET_V1} AND (kind <> 'reading' OR reading_id IS NOT NULL)"


def _replace_checks(kinds: str, stages: str, step_types: str, target: str) -> None:
    for table, name in (("sessions", "ck_sessions_kind"), ("sessions", "ck_sessions_stage"),
                        ("sessions", "ck_sessions_target"), ("steps", "ck_steps_stage"), ("steps", "ck_steps_type")):
        op.drop_constraint(name, table, type_="check")
    op.create_check_constraint("ck_sessions_kind", "sessions", kinds)
    op.create_check_constraint("ck_sessions_stage", "sessions", f"stage IS NULL OR stage {stages}")
    op.create_check_constraint("ck_sessions_target", "sessions", target)
    op.create_check_constraint("ck_steps_stage", "steps", f"stage {stages}")
    op.create_check_constraint("ck_steps_type", "steps", f"type {step_types}")


def upgrade() -> None:
    op.add_column("sessions", sa.Column("reading_id", sa.String(64)))
    _replace_checks(KINDS_V2, STAGES_V2, STEP_TYPES_V2, TARGET_V2)
    op.create_index("ix_sessions_reading_results", "sessions", ["user_id", "reading_id", "finished_at"],
                    postgresql_where=sa.text("kind = 'reading' AND status = 'completed'"))


def downgrade() -> None:
    op.drop_index("ix_sessions_reading_results", table_name="sessions")
    op.execute("DELETE FROM sessions WHERE kind = 'reading'")
    _replace_checks(KINDS_V1, STAGES_V1, STEP_TYPES_V1, TARGET_V1)
    op.drop_column("sessions", "reading_id")
