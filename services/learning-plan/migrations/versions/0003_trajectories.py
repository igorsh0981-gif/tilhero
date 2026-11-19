"""спринт 3: траектория уроков — trajectories (ревизии), course_snapshots (кеш снимка курса по ETag), проекции
learner_diagnostics, skill_states, learner_audience

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
    op.create_table(
        "trajectories",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(64), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("course_id", sa.String(64), nullable=False),
        sa.Column("basis", pg.JSONB(), nullable=False),
        sa.Column("next_lesson_id", sa.String(64)),
        sa.Column("items", pg.JSONB(), nullable=False),
        sa.Column("computed_at", TS, nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_trajectories_revision"),
    )
    # Ревизии неизменяемы (история плана, AT-36): UPDATE запрещён и роли сервиса (защита в глубину);
    # DELETE разрешён — сага удаления ученика (TG-FR-006)
    op.execute(
        """
        CREATE OR REPLACE FUNCTION trajectories_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'trajectories revisions are immutable (% is not allowed)', TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER trajectories_no_update BEFORE UPDATE ON trajectories "
        "FOR EACH ROW EXECUTE FUNCTION trajectories_immutable()"
    )
    op.create_table(
        "course_snapshots",
        sa.Column("course_id", sa.String(64), primary_key=True),
        sa.Column("pair_id", sa.String(64), nullable=False),
        sa.Column("etag", sa.String(200), nullable=False),
        sa.Column("snapshot_version", sa.String(200), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("fetched_at", TS, nullable=False),
        sa.Column("checked_at", TS, nullable=False),
        sa.Column("stale_since", TS),
    )
    op.create_table(
        "learner_diagnostics",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(64), primary_key=True),
        sa.Column("result_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("test_id", sa.String(200), nullable=False),
        sa.Column("test_version", sa.Integer(), nullable=False),
        sa.Column("provisional_level", sa.String(2)),
        sa.Column("areas", pg.JSONB(), nullable=False),
        sa.Column("recommended_start_lesson_id", sa.String(200)),
        sa.Column("completed_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_learner_diagnostics_revision"),
    )
    op.create_table(
        "skill_states",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(64), primary_key=True),
        sa.Column("skill_id", sa.String(200), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("state IN ('not_started','learning','demonstrated','retained')",
                           name="ck_skill_states_state"),
    )
    op.create_table(
        "learner_audience",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_learner_audience_audience"),
    )


def downgrade() -> None:
    op.drop_table("learner_audience")
    op.drop_table("skill_states")
    op.drop_table("learner_diagnostics")
    op.drop_table("course_snapshots")
    op.execute("DROP TRIGGER IF EXISTS trajectories_no_update ON trajectories")
    op.drop_table("trajectories")
    op.execute("DROP FUNCTION IF EXISTS trajectories_immutable()")
