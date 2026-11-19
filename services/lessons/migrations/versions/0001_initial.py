"""lessons: sessions, status_history, steps, turns, review_items, learner_profiles, deleted_users + outbox/inbox;
неизменяемость истории статусов, показанных шагов и реплик — триггерами (роль сервиса не может их снять)

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
STATUSES = "IN ('ready','in_progress','paused','completed','failed','cancelled')"
STAGES = "IN ('retrieval','explanation','roleplay','assessment','summary','listen','exercises')"
STEP_TYPES = "IN ('notice','explanation','item','roleplay','roleplay_end','listen','open_answer','done')"
REASONS = ("IN ('started','pause','resume','auto_pause','finish','fail','cancel','expired',"
           "'content_unpublished')")


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("course_id", sa.String(64)),
        sa.Column("lesson_id", sa.String(64)),
        sa.Column("scenario_id", sa.String(64)),
        sa.Column("asset_id", sa.String(64)),
        sa.Column("source_session_id", pg.UUID(as_uuid=True)),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("level", sa.String(2)),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("locale", sa.String(2), nullable=False, server_default=sa.text("'ru'")),
        sa.Column("ai_mode", sa.String(8), nullable=False),
        sa.Column("ai_degraded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("ai_used", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("hints_used", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("seed", sa.String(64), nullable=False),
        sa.Column("content_versions", pg.JSONB(), nullable=False),
        sa.Column("plan", pg.JSONB(), nullable=False),
        sa.Column("state", pg.JSONB(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("stage", sa.String(16)),
        sa.Column("step_index", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("duration_min", sa.SmallInteger(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("started_at", TS),
        sa.Column("paused_at", TS),
        sa.Column("finished_at", TS),
        sa.Column("last_activity_at", TS),
        sa.Column("active_seconds", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("minutes", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("outcome", sa.String(12)),
        sa.Column("practice_only", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("evaluation_status", sa.String(12), nullable=False, server_default=sa.text("'none'")),
        sa.Column("evaluation_id", pg.UUID(as_uuid=True)),
        sa.Column("evaluation", pg.JSONB()),
        sa.Column("evaluation_attempts", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("summary", pg.JSONB()),
        sa.Column("fail_reason", sa.String(32)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_hash", sa.String(64)),
        sa.CheckConstraint("kind IN ('lesson','scenario','media','review')", name="ck_sessions_kind"),
        sa.CheckConstraint(f"status {STATUSES}", name="ck_sessions_status"),
        sa.CheckConstraint(f"stage IS NULL OR stage {STAGES}", name="ck_sessions_stage"),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_sessions_audience"),
        sa.CheckConstraint("locale IN ('ru','uz')", name="ck_sessions_locale"),
        sa.CheckConstraint("ai_mode IN ('full','choices')", name="ck_sessions_ai_mode"),
        sa.CheckConstraint("outcome IS NULL OR outcome IN ('success','alt_success','fail')",
                           name="ck_sessions_outcome"),
        sa.CheckConstraint(f"level IS NULL OR level {BAND_CHECK}", name="ck_sessions_level"),
        sa.CheckConstraint("evaluation_status IN ('none','pending','done','failed')", name="ck_sessions_evaluation"),
        sa.CheckConstraint("minutes BETWEEN 0 AND 600", name="ck_sessions_minutes"),
        sa.CheckConstraint("active_seconds >= 0 AND hints_used >= 0 AND step_index >= 0",
                           name="ck_sessions_counters"),
        sa.CheckConstraint("(kind <> 'lesson' OR lesson_id IS NOT NULL) AND (kind <> 'scenario' OR scenario_id IS NOT "
                           "NULL) AND (kind <> 'media' OR asset_id IS NOT NULL) AND (kind <> 'review' OR "
                           "source_session_id IS NOT NULL)", name="ck_sessions_target"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_sessions_user_idempotency"),
    )
    op.create_index("uq_sessions_active", "sessions", ["user_id"], unique=True,
                    postgresql_where=sa.text("status IN ('ready','in_progress','paused')"))
    op.create_index("ix_sessions_user_created", "sessions", ["user_id", "created_at"])
    op.create_index("ix_sessions_account", "sessions", ["account_id"])
    op.create_index("ix_sessions_created", "sessions", ["created_at"])
    op.create_index("ix_sessions_status_activity", "sessions", ["status", "last_activity_at"])
    op.create_index("ix_sessions_evaluation_pending", "sessions", ["finished_at"],
                    postgresql_where=sa.text("evaluation_status = 'pending'"))

    op.create_table(
        "status_history",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.SmallInteger(), primary_key=True),
        sa.Column("from_status", sa.String(12)),
        sa.Column("to_status", sa.String(12), nullable=False),
        sa.Column("reason", sa.String(24), nullable=False),
        sa.Column("at", TS, nullable=False),
        sa.CheckConstraint(f"from_status IS NULL OR from_status {STATUSES}", name="ck_status_history_from"),
        sa.CheckConstraint(f"to_status {STATUSES}", name="ck_status_history_to"),
        sa.CheckConstraint(f"reason {REASONS}", name="ck_status_history_reason"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                                name="fk_status_history_session"),
    )

    op.create_table(
        "steps",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.Integer(), primary_key=True),
        sa.Column("step_id", sa.String(8), nullable=False),
        sa.Column("stage", sa.String(16), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("ref", pg.JSONB(), nullable=False),
        sa.Column("answer", pg.JSONB()),
        sa.Column("result", sa.String(12)),
        sa.Column("hints", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("response", pg.JSONB()),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("answered_at", TS),
        sa.Column("redacted_at", TS),
        sa.CheckConstraint(f"stage {STAGES}", name="ck_steps_stage"),
        sa.CheckConstraint(f"type {STEP_TYPES}", name="ck_steps_type"),
        sa.CheckConstraint("result IS NULL OR result IN ('correct','incorrect','skipped')", name="ck_steps_result"),
        sa.CheckConstraint("hints >= 0", name="ck_steps_hints"),
        sa.CheckConstraint("(answered_at IS NULL) = (response IS NULL)", name="ck_steps_answered"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                                name="fk_steps_session"),
        sa.UniqueConstraint("session_id", "step_id", name="uq_steps_session_step"),
    )

    op.create_table(
        "turns",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.Integer(), primary_key=True),
        sa.Column("turn_id", sa.String(8), nullable=False),
        sa.Column("step_seq", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.SmallInteger(), nullable=False),
        sa.Column("node_id", sa.String(64), nullable=False),
        sa.Column("speaker", sa.String(10), nullable=False),
        sa.Column("character_id", sa.String(64)),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("text", sa.String(500)),
        sa.Column("intent", sa.String(64)),
        sa.Column("hinted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("ai_call_id", sa.String(64)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("redacted_at", TS),
        sa.CheckConstraint("speaker IN ('learner','character')", name="ck_turns_speaker"),
        sa.CheckConstraint("mode IN ('choice','text')", name="ck_turns_mode"),
        sa.CheckConstraint("attempt IN (1, 2)", name="ck_turns_attempt"),
        sa.CheckConstraint("text IS NOT NULL OR redacted_at IS NOT NULL", name="ck_turns_text"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                                name="fk_turns_session"),
        sa.UniqueConstraint("session_id", "turn_id", name="uq_turns_session_turn"),
    )
    op.create_index("ix_turns_redact", "turns", ["created_at"],
                    postgresql_where=sa.text("mode = 'text' AND redacted_at IS NULL"))

    op.create_table(
        "review_items",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("lesson_id", sa.String(64), nullable=False),
        sa.Column("lesson_version", sa.Integer(), nullable=False),
        sa.Column("item_id", sa.String(64), nullable=False),
        sa.Column("skill_id", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(8), nullable=False),
        sa.Column("due_at", TS, nullable=False),
        sa.Column("resolved_at", TS),
        sa.Column("source_session_id", pg.UUID(as_uuid=True)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("reason IN ('wrong','hinted')", name="ck_review_items_reason"),
        sa.CheckConstraint("lesson_version >= 1", name="ck_review_items_version"),
    )
    op.create_index("uq_review_items_open", "review_items", ["user_id", "pair_id", "lesson_id", "item_id"],
                    unique=True, postgresql_where=sa.text("resolved_at IS NULL"))
    op.create_index("ix_review_items_due", "review_items", ["user_id", "pair_id", "due_at"])

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

    # Защита в глубину (роль сервиса не может снять триггеры — только владелец схемы).
    # История статусов — append-only (DELETE — только каскадом с сессией в саге удаления).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION lessons_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only (UPDATE is not allowed)', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER status_history_immutable BEFORE UPDATE ON status_history "
               "FOR EACH ROW EXECUTE FUNCTION lessons_append_only()")
    # Показанный шаг неизменяем; ответ записывается один раз (повтор — тот же результат); после ответа допустимо
    # только стирание текста ответа по сроку хранения (answer → NULL вместе с redacted_at).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION steps_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.seq IS DISTINCT FROM OLD.seq
            OR NEW.step_id IS DISTINCT FROM OLD.step_id OR NEW.stage IS DISTINCT FROM OLD.stage
            OR NEW.type IS DISTINCT FROM OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload
            OR NEW.ref IS DISTINCT FROM OLD.ref OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'steps: shown step is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.answered_at IS NOT NULL THEN
            IF NEW.answered_at IS DISTINCT FROM OLD.answered_at OR NEW.result IS DISTINCT FROM OLD.result
              OR NEW.hints IS DISTINCT FROM OLD.hints OR NEW.response IS DISTINCT FROM OLD.response
              OR (NEW.answer IS DISTINCT FROM OLD.answer AND NOT (NEW.answer IS NULL AND NEW.redacted_at IS NOT NULL))
              OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at) THEN
              RAISE EXCEPTION 'steps: answer is written once' USING ERRCODE = 'insufficient_privilege';
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER steps_guard BEFORE UPDATE ON steps FOR EACH ROW EXECUTE FUNCTION steps_guard()")
    # Реплики неизменяемы; допустимо только стирание текста по сроку хранения (text → NULL вместе с redacted_at).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION turns_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.seq IS DISTINCT FROM OLD.seq
            OR NEW.turn_id IS DISTINCT FROM OLD.turn_id OR NEW.step_seq IS DISTINCT FROM OLD.step_seq
            OR NEW.attempt IS DISTINCT FROM OLD.attempt OR NEW.node_id IS DISTINCT FROM OLD.node_id
            OR NEW.speaker IS DISTINCT FROM OLD.speaker OR NEW.character_id IS DISTINCT FROM OLD.character_id
            OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.intent IS DISTINCT FROM OLD.intent
            OR NEW.hinted IS DISTINCT FROM OLD.hinted OR NEW.ai_call_id IS DISTINCT FROM OLD.ai_call_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR (NEW.text IS DISTINCT FROM OLD.text AND NOT (NEW.text IS NULL AND NEW.redacted_at IS NOT NULL))
            OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at) THEN
            RAISE EXCEPTION 'turns: turn is immutable (only text redaction)' USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER turns_guard BEFORE UPDATE ON turns FOR EACH ROW EXECUTE FUNCTION turns_guard()")

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS turns_guard ON turns")
    op.execute("DROP TRIGGER IF EXISTS steps_guard ON steps")
    op.execute("DROP TRIGGER IF EXISTS status_history_immutable ON status_history")
    for table in ("deleted_users", "learner_profiles", "review_items", "turns", "steps", "status_history",
                  "sessions"):
        op.drop_table(table)
    op.execute("DROP FUNCTION IF EXISTS turns_guard()")
    op.execute("DROP FUNCTION IF EXISTS steps_guard()")
    op.execute("DROP FUNCTION IF EXISTS lessons_append_only()")
