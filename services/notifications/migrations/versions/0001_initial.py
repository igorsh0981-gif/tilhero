"""notifications (журнал доставки, дедупликация, отложенные и повторы) + outbox/inbox

Revision ID: 0001
Revises:
Create Date: 2026-10-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("notification_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("template", sa.String(64), nullable=False),
        sa.Column("params", pg.JSONB()),
        sa.Column("startapp", sa.String(64)),
        sa.Column("dedup_key", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True)),
        sa.Column("scheduled_for", sa.DateTime(timezone=True)),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("telegram_message_id", sa.BigInteger()),
        sa.Column("failure_reason", sa.String(64)),
        sa.Column("source_event_id", pg.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        # Дедупликация (AT-27: одно уведомление без дублей)
        sa.UniqueConstraint("dedup_key", name="uq_notifications_dedup_key"),
        sa.CheckConstraint(
            "kind IN ('critical','transactional','standard','digest')", name="ck_notifications_kind"
        ),
        sa.CheckConstraint(
            "status IN ('queued','scheduled','sent','failed','skipped')", name="ck_notifications_status"
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_notifications_attempts"),
        # Код сброса PIN и прочие параметры не хранятся после конечного статуса
        sa.CheckConstraint(
            "status IN ('queued','scheduled') OR params IS NULL", name="ck_notifications_params_cleared"
        ),
    )
    op.create_index("ix_notifications_user", "notifications", ["user_id"])
    op.create_index(
        "ix_notifications_due",
        "notifications",
        ["next_attempt_at"],
        postgresql_where=sa.text("status IN ('queued','scheduled')"),
    )
    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("notifications")
