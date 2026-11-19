"""diagnostics: tests, sessions, answers, results, skill_states, skill_evidence, learner_profiles, deleted_users
+ outbox/inbox; неизменяемость опубликованных тестов, ответов, результатов и свидетельств — триггерами

Revision ID: 0001
Revises:
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
BAND_CHECK = "IN ('A0','A1','A2','B1','B2')"
AREA_CHECK = "IN ('vocabulary','grammar','reading','listening')"


def upgrade() -> None:
    op.create_table(
        "tests",
        sa.Column("test_id", sa.String(64), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("config", pg.JSONB(), nullable=False),
        sa.Column("items", pg.JSONB(), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("published_at", TS),
        sa.Column("published_by", sa.String(64)),
        sa.Column("archived_at", TS),
        sa.CheckConstraint("status IN ('draft','published','archived')", name="ck_tests_status"),
        sa.CheckConstraint("audience IN ('adults','kids')", name="ck_tests_audience"),
        sa.CheckConstraint("version >= 1", name="ck_tests_version"),
    )
    op.create_index("uq_tests_published_audience", "tests", ["pair_id", "audience"], unique=True,
                    postgresql_where=sa.text("status = 'published'"))

    op.create_table(
        "sessions",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("test_id", sa.String(64), nullable=False),
        sa.Column("test_version", sa.Integer(), nullable=False),
        sa.Column("seed", sa.String(64), nullable=False),
        sa.Column("segment", sa.String(8), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("listening_available", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("followup_area", sa.String(16)),
        sa.Column("result_id", pg.UUID(as_uuid=True)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("started_at", TS, nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("finished_at", TS),
        sa.CheckConstraint("status IN ('in_progress','finished','abandoned')", name="ck_sessions_status"),
        sa.CheckConstraint("segment IN ('kids','teens','adults')", name="ck_sessions_segment"),
        sa.CheckConstraint(f"followup_area IS NULL OR followup_area {AREA_CHECK}", name="ck_sessions_followup_area"),
        sa.CheckConstraint("(followup_area IS NULL) = (result_id IS NULL)", name="ck_sessions_followup_pair"),
        sa.ForeignKeyConstraint(["test_id", "test_version"], ["tests.test_id", "tests.version"],
                                name="fk_sessions_test"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_sessions_user_idempotency"),
    )
    op.create_index("uq_sessions_in_progress", "sessions", ["user_id", "pair_id"], unique=True,
                    postgresql_where=sa.text("status = 'in_progress'"))
    op.create_index("ix_sessions_user_pair", "sessions", ["user_id", "pair_id", "started_at"])
    op.create_index("ix_sessions_result", "sessions", ["result_id"])
    op.create_index("ix_sessions_started", "sessions", ["started_at"])

    op.create_table(
        "answers",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.SmallInteger(), primary_key=True),
        sa.Column("item_id", sa.String(64), nullable=False),
        sa.Column("area", sa.String(16), nullable=False),
        sa.Column("band", sa.String(2), nullable=False),
        sa.Column("answer", pg.JSONB()),
        sa.Column("correct", sa.Boolean(), nullable=False),
        sa.Column("dont_know", sa.Boolean(), nullable=False),
        sa.Column("time_ms", sa.Integer(), nullable=False),
        sa.Column("answered_at", TS, nullable=False),
        sa.CheckConstraint(f"area {AREA_CHECK}", name="ck_answers_area"),
        sa.CheckConstraint(f"band {BAND_CHECK}", name="ck_answers_band"),
        sa.CheckConstraint("time_ms BETWEEN 0 AND 3600000", name="ck_answers_time"),
        sa.CheckConstraint("NOT dont_know OR (answer IS NULL AND NOT correct)", name="ck_answers_dont_know"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                                name="fk_answers_session"),
        sa.UniqueConstraint("session_id", "item_id", name="uq_answers_session_item"),
    )

    op.create_table(
        "results",
        sa.Column("result_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("revision", sa.SmallInteger(), primary_key=True),
        sa.Column("session_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("test_id", sa.String(64), nullable=False),
        sa.Column("test_version", sa.Integer(), nullable=False),
        sa.Column("profile", pg.JSONB(), nullable=False),
        sa.Column("provisional_level", sa.String(2)),
        sa.Column("recommended_start_lesson_id", sa.String(64)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_results_revision"),
        sa.CheckConstraint(f"provisional_level IS NULL OR provisional_level {BAND_CHECK}", name="ck_results_level"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.session_id"], name="fk_results_session"),
        sa.UniqueConstraint("session_id", name="uq_results_session"),
    )
    op.create_index("ix_results_user_pair", "results", ["user_id", "pair_id", "created_at"])
    op.create_index("ix_results_created", "results", ["created_at"])

    op.create_table(
        "skill_states",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(16), primary_key=True),
        sa.Column("skill_id", sa.String(64), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Float()),
        sa.Column("updated_at", TS, nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.CheckConstraint("state IN ('not_started','learning','demonstrated','retained')",
                           name="ck_skill_states_state"),
        sa.CheckConstraint("source IN ('diagnostic','lesson','retention')", name="ck_skill_states_source"),
        sa.CheckConstraint("confidence IS NULL OR confidence BETWEEN 0 AND 1", name="ck_skill_states_confidence"),
    )

    op.create_table(
        "skill_evidence",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("skill_id", sa.String(64), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("ref_id", sa.String(64), nullable=False),
        sa.Column("outcome", sa.String(8), nullable=False),
        sa.Column("band", sa.String(2)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("source IN ('diagnostic','lesson','retention')", name="ck_skill_evidence_source"),
        sa.CheckConstraint("outcome IN ('positive','negative')", name="ck_skill_evidence_outcome"),
        sa.CheckConstraint(f"band IS NULL OR band {BAND_CHECK}", name="ck_skill_evidence_band"),
    )
    op.create_index("ix_skill_evidence_skill", "skill_evidence", ["user_id", "pair_id", "skill_id", "created_at"])

    op.create_table(
        "learner_profiles",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(8)),
        sa.Column("age_band", sa.String(8)),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IS NULL OR kind IN ('account','child')", name="ck_learner_profiles_kind"),
        sa.CheckConstraint("age_band IS NULL OR age_band IN ('6-9','10-13','14-17','18+')",
                           name="ck_learner_profiles_age_band"),
    )

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )

    # Защита в глубину (роль сервиса не может снять триггеры — только владелец схемы):
    # опубликованная/архивная версия теста неизменяема, допустимы только переходы статуса; удалить можно лишь черновик
    op.execute(
        """
        CREATE OR REPLACE FUNCTION tests_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status <> 'draft' THEN
              RAISE EXCEPTION 'tests: % version cannot be deleted', OLD.status
                USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN OLD;
          END IF;
          IF OLD.status <> 'draft' AND (
               NEW.test_id IS DISTINCT FROM OLD.test_id OR NEW.version IS DISTINCT FROM OLD.version
            OR NEW.pair_id IS DISTINCT FROM OLD.pair_id OR NEW.audience IS DISTINCT FROM OLD.audience
            OR NEW.config IS DISTINCT FROM OLD.config OR NEW.items IS DISTINCT FROM OLD.items
            OR NEW.checksum IS DISTINCT FROM OLD.checksum OR NEW.created_by IS DISTINCT FROM OLD.created_by
            OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
            RAISE EXCEPTION 'tests: % version is immutable', OLD.status USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
               (OLD.status = 'draft' AND NEW.status = 'published')
            OR (OLD.status = 'published' AND NEW.status = 'archived')
            OR (OLD.status = 'archived' AND NEW.status = 'published')) THEN
            RAISE EXCEPTION 'tests: transition % -> % is not allowed', OLD.status, NEW.status
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER tests_guard BEFORE UPDATE OR DELETE ON tests "
               "FOR EACH ROW EXECUTE FUNCTION tests_guard()")
    # ответы, результаты и свидетельства — append-only (UPDATE запрещён; DELETE — только сага удаления ученика)
    op.execute(
        """
        CREATE OR REPLACE FUNCTION diagnostics_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only (UPDATE is not allowed)', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    for table in ("answers", "results", "skill_evidence"):
        op.execute(f"CREATE TRIGGER {table}_immutable BEFORE UPDATE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION diagnostics_append_only()")

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    for table in ("answers", "results", "skill_evidence"):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_immutable ON {table}")
    op.execute("DROP TRIGGER IF EXISTS tests_guard ON tests")
    for table in ("deleted_users", "learner_profiles", "skill_evidence", "skill_states", "results", "answers",
                  "sessions", "tests"):
        op.drop_table(table)
    op.execute("DROP FUNCTION IF EXISTS diagnostics_append_only()")
    op.execute("DROP FUNCTION IF EXISTS tests_guard()")
