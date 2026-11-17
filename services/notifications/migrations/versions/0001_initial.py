"""notifications TilHero: журнал = центр уведомлений, отметки удаления, состояние пропусков, проекция семей,
рассылки «Что нового» (только центр) + outbox/inbox

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

CATEGORIES = "'reminders','missed','social','support','product','service'"
STATUSES = "'scheduled','sent','in_app_only','failed','skipped'"


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("notification_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("template", sa.String(64), nullable=False),
        sa.Column("params", pg.JSONB()),
        sa.Column("subject_user_id", pg.UUID(as_uuid=True)),
        sa.Column("title", sa.String(200)),
        sa.Column("body", sa.String(1000)),
        sa.Column("startapp", sa.String(64)),
        sa.Column("dedup_key", sa.String(200), nullable=False),
        sa.Column("telegram_status", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(64)),
        sa.Column("center_only", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("not_before", sa.DateTime(timezone=True)),
        sa.Column("stale_after", sa.DateTime(timezone=True)),
        sa.Column("scheduled_for", sa.DateTime(timezone=True)),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("limit_day", sa.Date()),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("telegram_message_id", sa.BigInteger()),
        sa.Column("read_at", sa.DateTime(timezone=True)),
        sa.Column("source_event_id", pg.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("dedup_key", name="uq_notifications_dedup_key"),
        sa.CheckConstraint(f"category IN ({CATEGORIES})", name="ck_notifications_category"),
        sa.CheckConstraint("kind IN ('standard','transactional')", name="ck_notifications_kind"),
        sa.CheckConstraint(f"telegram_status IN ({STATUSES})", name="ck_notifications_telegram_status"),
        sa.CheckConstraint("attempts >= 0", name="ck_notifications_attempts"),
        sa.CheckConstraint(
            "telegram_status = 'scheduled' OR params IS NULL", name="ck_notifications_params_cleared"
        ),
        sa.CheckConstraint(
            "telegram_status <> 'scheduled' OR scheduled_for IS NOT NULL", name="ck_notifications_scheduled_for"
        ),
    )
    op.create_index("ix_notifications_inbox", "notifications", ["user_id", "created_at", "notification_id"])
    op.create_index(
        "ix_notifications_due",
        "notifications",
        ["scheduled_for"],
        postgresql_where=sa.text("telegram_status = 'scheduled'"),
    )
    op.create_index(
        "ix_notifications_limit",
        "notifications",
        ["user_id", "limit_day"],
        postgresql_where=sa.text("limit_day IS NOT NULL"),
    )
    op.create_index(
        "ix_notifications_subject",
        "notifications",
        ["subject_user_id"],
        postgresql_where=sa.text("subject_user_id IS NOT NULL"),
    )
    op.create_index("ix_notifications_created", "notifications", ["created_at"])

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "missed_state",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("last_notified_date", sa.Date(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "family_owners",
        sa.Column("family_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_family_owners_owner", "family_owners", ["owner_user_id"])
    op.create_table(
        "broadcasts",
        sa.Column("broadcast_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(200), nullable=False),
        sa.Column("audience", sa.String(16), nullable=False),
        sa.Column("segments", pg.JSONB()),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("audience IN ('new','existing','all')", name="ck_broadcasts_audience"),
    )
    op.create_index("ix_broadcasts_received", "broadcasts", ["received_at"])
    op.create_table(
        "inbox_state",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("broadcasts_seen_at", sa.DateTime(timezone=True), nullable=False),
    )
    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    for table in ("inbox_state", "broadcasts", "family_owners", "missed_state", "deleted_users", "notifications"):
        op.drop_table(table)
