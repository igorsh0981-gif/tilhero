"""memory: cards, review_log, review_sessions, review_tasks, retention_checks, pronunciation_attempts,
learner_projection, skill_projection, reminders_sent, activity_days, feed_log, idempotency, deleted_users +
outbox/inbox; неизменяемость истории планирования и показанных заданий — триггерами (роль сервиса не может их снять)

Revision ID: 0001
Revises:
Create Date: 2026-11-20
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
EMPTY = sa.text("'[]'::jsonb")


def upgrade() -> None:
    op.create_table(
        "cards",
        sa.Column("card_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("key", sa.String(200), nullable=False),
        sa.Column("text_en", sa.String(200), nullable=False),
        sa.Column("gloss", pg.JSONB(), nullable=False),
        sa.Column("gloss_source", sa.String(10), nullable=False),
        sa.Column("example_en", sa.String(200)),
        sa.Column("answers_en", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("distractors", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("error", pg.JSONB()),
        sa.Column("error_code", sa.String(32)),
        sa.Column("origin_lesson_id", sa.String(64)),
        sa.Column("sources", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("fsrs_state", sa.String(10), nullable=False),
        sa.Column("stability", sa.Float()),
        sa.Column("difficulty", sa.Float()),
        sa.Column("reps", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("lapses", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("last_review_at", TS),
        sa.Column("due_at", TS),
        sa.Column("archived_by", sa.String(8)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("kind IN ('word','phrase','error')", name="ck_cards_kind"),
        sa.CheckConstraint("status IN ('new','learning','review','known','frozen','archived')",
                           name="ck_cards_status"),
        sa.CheckConstraint("fsrs_state IN ('new','learning','review')", name="ck_cards_fsrs_state"),
        sa.CheckConstraint("gloss_source IN ('course','methodist','ai')", name="ck_cards_gloss_source"),
        sa.CheckConstraint("archived_by IS NULL OR archived_by IN ('learner','system')", name="ck_cards_archived_by"),
        sa.CheckConstraint("(kind = 'error') = (error IS NOT NULL)", name="ck_cards_error"),
        sa.CheckConstraint("reps >= 0 AND lapses >= 0", name="ck_cards_counters"),
        sa.CheckConstraint("fsrs_state = 'new' OR (stability IS NOT NULL AND difficulty IS NOT NULL)",
                           name="ck_cards_fsrs"),
        sa.CheckConstraint("difficulty IS NULL OR difficulty BETWEEN 1 AND 10", name="ck_cards_difficulty"),
        sa.CheckConstraint("stability IS NULL OR stability > 0", name="ck_cards_stability"),
        sa.UniqueConstraint("user_id", "pair_id", "kind", "key", name="uq_cards_user_key"),
    )
    op.create_index("ix_cards_user_status_due", "cards", ["user_id", "pair_id", "status", "due_at"])
    op.create_index("ix_cards_user_created", "cards", ["user_id", "created_at"])
    op.create_index("ix_cards_error_created", "cards", ["created_at"],
                    postgresql_where=sa.text("kind = 'error' AND status <> 'archived'"))

    op.create_table(
        "review_log",
        sa.Column("log_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("card_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", pg.UUID(as_uuid=True)),
        sa.Column("task_id", pg.UUID(as_uuid=True)),
        sa.Column("task_type", sa.String(16), nullable=False),
        sa.Column("answer_mode", sa.String(10), nullable=False),
        sa.Column("grade", sa.String(6)),
        sa.Column("hinted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("revealed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("elapsed_days", sa.Float()),
        sa.Column("before", pg.JSONB(), nullable=False),
        sa.Column("after", pg.JSONB(), nullable=False),
        sa.Column("algorithm", sa.String(16), nullable=False),
        sa.Column("params_version", sa.String(32), nullable=False),
        sa.Column("actor", sa.String(80), nullable=False),
        sa.Column("actor_name", sa.String(120)),
        sa.Column("reason", sa.String(300)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("answer_mode IN ('choice','typed','assemble','listen','manual')",
                           name="ck_review_log_mode"),
        sa.CheckConstraint("grade IS NULL OR grade IN ('again','hard','good')", name="ck_review_log_grade"),
        sa.CheckConstraint("actor IN ('learner','system') OR actor LIKE 'staff:%'", name="ck_review_log_actor"),
        sa.ForeignKeyConstraint(["card_id"], ["cards.card_id"], ondelete="CASCADE", name="fk_review_log_card"),
    )
    op.create_index("ix_review_log_card", "review_log", ["card_id", "created_at"])
    op.create_index("ix_review_log_user", "review_log", ["user_id", "created_at"])
    op.create_index("ix_review_log_created", "review_log", ["created_at"])

    op.create_table(
        "review_sessions",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("age_band", sa.String(8)),
        sa.Column("locale", sa.String(2), nullable=False),
        sa.Column("started_at", TS, nullable=False),
        sa.Column("last_activity_at", TS, nullable=False),
        sa.Column("finished_at", TS),
        sa.Column("active_seconds", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("minutes", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("plan", pg.JSONB(), nullable=False),
        sa.Column("stats", pg.JSONB(), nullable=False),
        sa.Column("summary", pg.JSONB()),
        sa.Column("idempotency_key", sa.String(128)),
        sa.CheckConstraint("status IN ('active','completed','expired','cancelled')",
                           name="ck_review_sessions_status"),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_review_sessions_audience"),
        sa.CheckConstraint("locale IN ('ru','uz')", name="ck_review_sessions_locale"),
        sa.CheckConstraint("minutes BETWEEN 0 AND 60 AND active_seconds >= 0", name="ck_review_sessions_counters"),
        sa.CheckConstraint("(status = 'active') = (finished_at IS NULL)", name="ck_review_sessions_finished"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_review_sessions_idempotency"),
    )
    op.create_index("uq_review_sessions_active", "review_sessions", ["user_id"], unique=True,
                    postgresql_where=sa.text("status = 'active'"))
    op.create_index("ix_review_sessions_user_date", "review_sessions", ["user_id", "local_date"])
    op.create_index("ix_review_sessions_status_activity", "review_sessions", ["status", "last_activity_at"])
    op.create_index("ix_review_sessions_finished", "review_sessions", ["finished_at"])

    op.create_table(
        "review_tasks",
        sa.Column("task_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("session_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("card_id", pg.UUID(as_uuid=True)),
        sa.Column("check_id", pg.UUID(as_uuid=True)),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("key", pg.JSONB(), nullable=False),
        sa.Column("requeued_from", pg.UUID(as_uuid=True)),
        sa.Column("hints", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("skipped", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("answer", pg.JSONB()),
        sa.Column("result", sa.String(10)),
        sa.Column("grade", sa.String(6)),
        sa.Column("response", pg.JSONB()),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("answered_at", TS),
        sa.Column("redacted_at", TS),
        sa.CheckConstraint("type IN ('intro','meaning_choice','listen_choice','typed','cloze','assemble',"
                           "'error_fix','check_item')", name="ck_review_tasks_type"),
        sa.CheckConstraint("result IS NULL OR result IN ('correct','almost','incorrect')",
                           name="ck_review_tasks_result"),
        sa.CheckConstraint("grade IS NULL OR grade IN ('again','hard','good')", name="ck_review_tasks_grade"),
        sa.CheckConstraint("(answered_at IS NULL) = (response IS NULL)", name="ck_review_tasks_answered"),
        sa.CheckConstraint("(type = 'check_item') = (check_id IS NOT NULL)", name="ck_review_tasks_target"),
        sa.ForeignKeyConstraint(["session_id"], ["review_sessions.session_id"], ondelete="CASCADE",
                                name="fk_review_tasks_session"),
        sa.UniqueConstraint("session_id", "seq", name="uq_review_tasks_seq"),
    )
    op.create_index("ix_review_tasks_card", "review_tasks", ["card_id"])
    op.create_index("ix_review_tasks_answered", "review_tasks", ["answered_at"],
                    postgresql_where=sa.text("answer IS NOT NULL AND redacted_at IS NULL"))

    op.create_table(
        "retention_checks",
        sa.Column("check_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("skill_id", sa.String(64), nullable=False),
        sa.Column("chain_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("stage", sa.String(4), nullable=False),
        sa.Column("demonstrated_at", TS, nullable=False),
        sa.Column("evidence_id", pg.UUID(as_uuid=True)),
        sa.Column("due_at", TS, nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("attempt", sa.SmallInteger(), nullable=False, server_default=sa.text("1")),
        sa.Column("consecutive_failures", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("postponed", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("items", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("session_id", pg.UUID(as_uuid=True)),
        sa.Column("result", pg.JSONB()),
        sa.Column("skill_title", pg.JSONB()),
        sa.Column("cancel_reason", sa.String(32)),
        sa.Column("checked_at", TS),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("stage IN ('d7','d30')", name="ck_retention_checks_stage"),
        sa.CheckConstraint("status IN ('scheduled','in_session','passed','failed','cancelled')",
                           name="ck_retention_checks_status"),
        sa.CheckConstraint("consecutive_failures BETWEEN 0 AND 2 AND attempt >= 1 AND postponed >= 0",
                           name="ck_retention_checks_counters"),
    )
    op.create_index("uq_retention_checks_open", "retention_checks", ["user_id", "pair_id", "skill_id"], unique=True,
                    postgresql_where=sa.text("status IN ('scheduled','in_session')"))
    op.create_index("ix_retention_checks_due", "retention_checks", ["status", "due_at"])
    op.create_index("ix_retention_checks_user", "retention_checks", ["user_id", "created_at"])
    op.create_index("ix_retention_checks_pair_checked", "retention_checks", ["pair_id", "checked_at"])

    op.create_table(
        "pronunciation_attempts",
        sa.Column("attempt_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("target", pg.JSONB(), nullable=False),
        sa.Column("card_id", pg.UUID(as_uuid=True)),
        sa.Column("reference_text", sa.String(200), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("scores", pg.JSONB()),
        sa.Column("intelligibility", sa.String(16)),
        sa.Column("words", pg.JSONB(), nullable=False),
        sa.Column("confidence", sa.Float()),
        sa.Column("tips", pg.JSONB(), nullable=False),
        sa.Column("audio_ms", sa.Integer(), nullable=False),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('ok','insufficient_evidence','unavailable')", name="ck_pron_status"),
        sa.CheckConstraint("intelligibility IS NULL OR intelligibility IN ('clear','mostly_clear','needs_practice')",
                           name="ck_pron_intelligibility"),
        sa.CheckConstraint("audio_ms BETWEEN 0 AND 60000", name="ck_pron_audio_ms"),
    )
    op.create_index("ix_pron_user_card", "pronunciation_attempts", ["user_id", "card_id", "created_at"])
    op.create_index("ix_pron_created", "pronunciation_attempts", ["created_at"])

    op.create_table(
        "learner_projection",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("timezone", sa.String(64)),
        sa.Column("course_pair", sa.String(16)),
        sa.Column("reminders_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("ui_lang", sa.String(2)),
        sa.Column("age_band", sa.String(8)),
        sa.Column("plan_updated_at", TS),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("age_band IS NULL OR age_band IN ('6-9','10-13','14-17','18+')",
                           name="ck_learner_projection_age_band"),
        sa.CheckConstraint("ui_lang IS NULL OR ui_lang IN ('ru','uz')", name="ck_learner_projection_ui_lang"),
    )
    op.create_index("ix_learner_projection_reminders", "learner_projection", ["user_id"],
                    postgresql_where=sa.text("reminders_enabled"))

    op.create_table(
        "skill_projection",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(16), primary_key=True),
        sa.Column("skill_id", sa.String(64), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("changed_at", TS, nullable=False),
        sa.CheckConstraint("state IN ('not_started','learning','demonstrated','retained')",
                           name="ck_skill_projection_state"),
    )

    op.create_table(
        "reminders_sent",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("due_count", sa.Integer(), nullable=False),
        sa.Column("sent_at", TS, nullable=False),
    )

    op.create_table(
        "activity_days",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("source", sa.String(8), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("source IN ('review','lesson')", name="ck_activity_days_source"),
    )

    op.create_table(
        "feed_log",
        sa.Column("evaluation_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", pg.UUID(as_uuid=True)),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("cards_added", sa.Integer(), nullable=False),
        sa.Column("processed_at", TS, nullable=False),
    )
    op.create_index("ix_feed_log_user", "feed_log", ["user_id"])

    op.create_table(
        "idempotency",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("scope", sa.String(32), primary_key=True),
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("status_code", sa.SmallInteger(), nullable=False),
        sa.Column("response", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_idempotency_created", "idempotency", ["created_at"])

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )

    # Защита в глубину (роль сервиса не может снять триггеры — только владелец схемы).
    # История планирования — неизменяема (DELETE — только каскадом с карточкой в саге удаления).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION memory_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is immutable (UPDATE is not allowed)', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER review_log_immutable BEFORE UPDATE ON review_log "
               "FOR EACH ROW EXECUTE FUNCTION memory_append_only()")
    # DELETE строки истории напрямую запрещён; разрешён только каскад от удаления карточки (сага удаления):
    # каскад FK выполняется триггером ссылочной целостности — глубина вложенности триггеров > 1
    op.execute(
        """
        CREATE OR REPLACE FUNCTION review_log_no_delete() RETURNS trigger AS $$
        BEGIN
          IF pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'review_log is immutable (DELETE only with the card)'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER review_log_no_delete BEFORE DELETE ON review_log "
               "FOR EACH ROW EXECUTE FUNCTION review_log_no_delete()")
    # Показанное задание неизменяемо (содержимое и ключ); подсказки и пропуск — только до ответа; ответ записывается
    # один раз (повтор — тот же результат); после ответа — только стирание ввода по сроку (answer → NULL + redacted_at,
    # в тот же момент — ввод ученика в сохранённом итоге проверки).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION review_tasks_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
            OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.card_id IS DISTINCT FROM OLD.card_id
            OR NEW.check_id IS DISTINCT FROM OLD.check_id OR NEW.type IS DISTINCT FROM OLD.type
            OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.key IS DISTINCT FROM OLD.key
            OR NEW.requeued_from IS DISTINCT FROM OLD.requeued_from
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'review_tasks: shown task is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.answered_at IS NOT NULL OR OLD.skipped THEN
            IF NEW.answered_at IS DISTINCT FROM OLD.answered_at OR NEW.result IS DISTINCT FROM OLD.result
              OR NEW.grade IS DISTINCT FROM OLD.grade
              OR (NEW.response IS DISTINCT FROM OLD.response
                  AND NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL))
              OR NEW.hints IS DISTINCT FROM OLD.hints OR NEW.skipped IS DISTINCT FROM OLD.skipped
              OR (NEW.answer IS DISTINCT FROM OLD.answer AND NOT (NEW.answer IS NULL AND NEW.redacted_at IS NOT NULL))
              OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at) THEN
              RAISE EXCEPTION 'review_tasks: answer is written once' USING ERRCODE = 'insufficient_privilege';
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER review_tasks_guard BEFORE UPDATE ON review_tasks "
               "FOR EACH ROW EXECUTE FUNCTION review_tasks_guard()")

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS review_tasks_guard ON review_tasks")
    op.execute("DROP TRIGGER IF EXISTS review_log_no_delete ON review_log")
    op.execute("DROP TRIGGER IF EXISTS review_log_immutable ON review_log")
    for table in ("deleted_users", "idempotency", "feed_log", "activity_days", "reminders_sent", "skill_projection",
                  "learner_projection", "pronunciation_attempts", "retention_checks", "review_tasks",
                  "review_sessions", "review_log", "cards"):
        op.drop_table(table)
    op.execute("DROP FUNCTION IF EXISTS review_tasks_guard()")
    op.execute("DROP FUNCTION IF EXISTS review_log_no_delete()")
    op.execute("DROP FUNCTION IF EXISTS memory_append_only()")
