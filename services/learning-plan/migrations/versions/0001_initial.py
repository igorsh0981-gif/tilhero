"""learning-plan: plans, activities, slot_marks, tick_state, deleted_users + outbox/inbox

Revision ID: 0001
Revises:
Create Date: 2026-11-18
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
        "plans",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("goal", sa.String(16)),
        sa.Column("level_self", sa.String(16)),
        sa.Column("topics", pg.ARRAY(sa.Text()), nullable=False, server_default=sa.text("'{}'::text[]")),
        sa.Column("ui_lang", sa.String(2), nullable=False),
        sa.Column("explain_lang", sa.String(2), nullable=False),
        sa.Column("course_pair", sa.String(8), nullable=False),
        sa.Column("preset", sa.String(16), nullable=False),
        sa.Column("days", pg.ARRAY(sa.SmallInteger()), nullable=False),
        sa.Column("preferred_time", sa.Time(), nullable=False),
        sa.Column("duration_min", sa.SmallInteger(), nullable=False),
        sa.Column("reminders_enabled", sa.Boolean(), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("schedule_set_at", TS),
        sa.Column("onboarding_completed_at", TS),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("goal IS NULL OR goal IN ('work','career','travel','daily','study','exam')",
                           name="ck_plans_goal"),
        sa.CheckConstraint("level_self IS NULL OR level_self IN ('zero','beginner','some','confident')",
                           name="ck_plans_level"),
        sa.CheckConstraint("cardinality(topics) <= 5", name="ck_plans_topics"),
        sa.CheckConstraint("ui_lang IN ('ru','uz')", name="ck_plans_ui_lang"),
        sa.CheckConstraint("explain_lang IN ('ru','uz')", name="ck_plans_explain_lang"),
        sa.CheckConstraint("course_pair IN ('ru-en')", name="ck_plans_course_pair"),
        sa.CheckConstraint("preset IN ('daily','weekdays','three_per_week','custom')", name="ck_plans_preset"),
        sa.CheckConstraint("cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]",
                           name="ck_plans_days"),
        sa.CheckConstraint("duration_min IN (10,15,20,30)", name="ck_plans_duration"),
        sa.CheckConstraint("version >= 1", name="ck_plans_version"),
    )
    op.create_table(
        "activities",
        sa.Column("activity_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("minutes", sa.SmallInteger(), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("recorded_at", TS, nullable=False),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_activities_user_idempotency"),
        sa.CheckConstraint("kind IN ('lesson','review','practice','diagnostic')", name="ck_activities_kind"),
        sa.CheckConstraint("minutes BETWEEN 0 AND 240", name="ck_activities_minutes"),
    )
    op.create_index("ix_activities_user_date", "activities", ["user_id", "local_date"])
    op.create_table(
        "slot_marks",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("kind", sa.String(8), primary_key=True),
        sa.Column("emitted_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IN ('reminder','missed')", name="ck_slot_marks_kind"),
    )
    op.create_table(
        "tick_state",
        sa.Column("id", sa.SmallInteger(), primary_key=True, autoincrement=False),
        sa.Column("last_tick_at", TS, nullable=False),
        sa.CheckConstraint("id = 1", name="ck_tick_state_single"),
    )
    # окно первого tick начинается с момента миграции: прошлые слоты не «догоняются»
    op.execute("INSERT INTO tick_state (id, last_tick_at) VALUES (1, now())")
    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )
    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("deleted_users")
    op.drop_table("tick_state")
    op.drop_table("slot_marks")
    op.drop_index("ix_activities_user_date", table_name="activities")
    op.drop_table("activities")
    op.drop_table("plans")
