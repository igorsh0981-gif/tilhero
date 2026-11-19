"""assessment: evaluations, appeals, flags, deleted_users + outbox/inbox; неизменяемость оценок и флагов,
переходы апелляций — триггерами

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


def upgrade() -> None:
    op.create_table(
        "evaluations",
        sa.Column("evaluation_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("session_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("content_refs", pg.JSONB(), nullable=False),
        sa.Column("rubric_id", sa.String(64), nullable=False),
        sa.Column("rubric_version", sa.Integer(), nullable=False),
        sa.Column("rubric", pg.JSONB(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("scores", pg.JSONB(), nullable=False),
        sa.Column("weighted", sa.Float()),
        sa.Column("passed", sa.Boolean()),
        sa.Column("task_completed", sa.Boolean()),
        sa.Column("outcome", sa.String(12)),
        sa.Column("confirmed_errors", pg.JSONB(), nullable=False),
        sa.Column("items", pg.JSONB(), nullable=False),
        sa.Column("turns", pg.JSONB(), nullable=False),
        sa.Column("skill_outcomes", pg.JSONB(), nullable=False),
        sa.Column("practice_only", sa.Boolean(), nullable=False),
        sa.Column("support_used", sa.Boolean(), nullable=False),
        sa.Column("evaluator", pg.JSONB()),
        sa.Column("ai_status", sa.String(16), nullable=False),
        sa.Column("ai_reason", sa.String(32)),
        sa.Column("requires_human_review", sa.Boolean(), nullable=False),
        sa.Column("supersedes", pg.UUID(as_uuid=True)),
        sa.Column("appeal_id", pg.UUID(as_uuid=True)),
        sa.Column("created_by", sa.String(64)),
        sa.Column("reason", sa.String(500)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("kind IN ('lesson','scenario','media','review')", name="ck_evaluations_kind"),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_evaluations_audience"),
        sa.CheckConstraint("status IN ('ok','partial','insufficient_evidence','pending_review')",
                           name="ck_evaluations_status"),
        sa.CheckConstraint("outcome IS NULL OR outcome IN ('success','alt_success','fail')",
                           name="ck_evaluations_outcome"),
        sa.CheckConstraint("ai_status IN ('not_used','ok','unavailable','refused')", name="ck_evaluations_ai_status"),
        sa.CheckConstraint("rubric_version >= 1", name="ck_evaluations_rubric_version"),
        sa.CheckConstraint("weighted IS NULL OR weighted BETWEEN 0 AND 3", name="ck_evaluations_weighted"),
        sa.CheckConstraint("(weighted IS NULL) = (passed IS NULL)", name="ck_evaluations_verdict"),
        sa.CheckConstraint("passed IS NULL OR status IN ('ok','partial')", name="ck_evaluations_passed_status"),
        sa.CheckConstraint(
            "(supersedes IS NULL AND created_by IS NULL AND reason IS NULL AND appeal_id IS NULL "
            "AND idempotency_key IS NULL) "
            "OR (supersedes IS NOT NULL AND created_by IS NOT NULL AND reason IS NOT NULL)",
            name="ck_evaluations_origin"),
        sa.CheckConstraint("supersedes IS DISTINCT FROM evaluation_id", name="ck_evaluations_not_self"),
        sa.ForeignKeyConstraint(["supersedes"], ["evaluations.evaluation_id"], name="fk_evaluations_supersedes"),
        sa.UniqueConstraint("supersedes", name="uq_evaluations_supersedes"),
        sa.UniqueConstraint("created_by", "idempotency_key", name="uq_evaluations_staff_idempotency"),
    )
    op.create_index("uq_evaluations_session_root", "evaluations", ["session_id"], unique=True,
                    postgresql_where=sa.text("supersedes IS NULL"))
    op.create_index("ix_evaluations_session", "evaluations", ["session_id", "created_at"])
    op.create_index("ix_evaluations_user", "evaluations", ["user_id", "created_at"])
    op.create_index("ix_evaluations_created", "evaluations", ["created_at"])

    op.create_table(
        "appeals",
        sa.Column("appeal_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("evaluation_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("taken_by", sa.String(64)),
        sa.Column("taken_at", TS),
        sa.Column("decided_by", sa.String(64)),
        sa.Column("decision_note", sa.String(500)),
        sa.Column("decided_at", TS),
        sa.Column("new_evaluation_id", pg.UUID(as_uuid=True)),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('new','in_review','upheld','corrected')", name="ck_appeals_status"),
        sa.CheckConstraint("char_length(reason) BETWEEN 1 AND 500", name="ck_appeals_reason"),
        sa.CheckConstraint("status = 'new' OR (taken_by IS NOT NULL AND taken_at IS NOT NULL)",
                           name="ck_appeals_taken"),
        sa.CheckConstraint(
            "(status IN ('upheld','corrected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL "
            "AND decision_note IS NOT NULL)", name="ck_appeals_decision"),
        sa.CheckConstraint("(status = 'corrected') = (new_evaluation_id IS NOT NULL)", name="ck_appeals_corrected"),
        sa.ForeignKeyConstraint(["evaluation_id"], ["evaluations.evaluation_id"], name="fk_appeals_evaluation"),
        sa.ForeignKeyConstraint(["new_evaluation_id"], ["evaluations.evaluation_id"],
                                name="fk_appeals_new_evaluation"),
        sa.UniqueConstraint("session_id", name="uq_appeals_session"),
        sa.UniqueConstraint("evaluation_id", name="uq_appeals_evaluation"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_appeals_user_idempotency"),
    )
    op.create_index("ix_appeals_status_created", "appeals", ["status", "created_at"])
    op.create_index("ix_appeals_user_created", "appeals", ["user_id", "created_at"])

    op.create_table(
        "flags",
        sa.Column("flag_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("evaluation_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("char_length(reason) BETWEEN 1 AND 500", name="ck_flags_reason"),
        sa.ForeignKeyConstraint(["evaluation_id"], ["evaluations.evaluation_id"], name="fk_flags_evaluation"),
        sa.UniqueConstraint("created_by", "idempotency_key", name="uq_flags_staff_idempotency"),
    )
    op.create_index("ix_flags_evaluation", "flags", ["evaluation_id", "created_at"])
    op.create_index("ix_flags_user", "flags", ["user_id"])

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )

    # Защита в глубину (роль сервиса не может снять триггеры — только владелец схемы):
    # оценки и QA-флаги append-only — UPDATE запрещён; DELETE — только сага удаления ученика
    op.execute(
        """
        CREATE OR REPLACE FUNCTION assessment_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only (UPDATE is not allowed)', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    for table in ("evaluations", "flags"):
        op.execute(f"CREATE TRIGGER {table}_immutable BEFORE UPDATE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION assessment_append_only()")
    # апелляция: поля подачи неизменяемы; переходы new → in_review → upheld|corrected (и new → решение);
    # решённая апелляция не меняется
    op.execute(
        """
        CREATE OR REPLACE FUNCTION appeals_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.appeal_id IS DISTINCT FROM OLD.appeal_id OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
            OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'appeals: submitted fields are immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status IN ('upheld', 'corrected') THEN
            RAISE EXCEPTION 'appeals: decided appeal is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
               (OLD.status = 'new' AND NEW.status IN ('in_review', 'upheld', 'corrected'))
            OR (OLD.status = 'in_review' AND NEW.status IN ('upheld', 'corrected'))) THEN
            RAISE EXCEPTION 'appeals: transition % -> % is not allowed', OLD.status, NEW.status
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER appeals_guard BEFORE UPDATE ON appeals FOR EACH ROW EXECUTE FUNCTION appeals_guard()")

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS appeals_guard ON appeals")
    for table in ("evaluations", "flags"):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_immutable ON {table}")
    for table in ("deleted_users", "flags", "appeals", "evaluations"):
        op.drop_table(table)
    op.execute("DROP FUNCTION IF EXISTS appeals_guard()")
    op.execute("DROP FUNCTION IF EXISTS assessment_append_only()")
