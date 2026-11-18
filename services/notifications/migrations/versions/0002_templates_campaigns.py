"""notifications спринт 2: версии шаблонов уведомлений, рассылки (campaigns, campaign_recipients); журнал — kind
campaign и статус cancelled

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

STATUSES_V1 = "'scheduled','sent','in_app_only','failed','skipped'"
STATUSES_V2 = "'scheduled','sent','in_app_only','failed','skipped','cancelled'"


def upgrade() -> None:
    op.drop_constraint("ck_notifications_kind", "notifications", type_="check")
    op.create_check_constraint(
        "ck_notifications_kind", "notifications", "kind IN ('standard','transactional','campaign')"
    )
    op.drop_constraint("ck_notifications_telegram_status", "notifications", type_="check")
    op.create_check_constraint(
        "ck_notifications_telegram_status", "notifications", f"telegram_status IN ({STATUSES_V2})"
    )
    op.create_index(
        "ix_notifications_campaign_sent",
        "notifications",
        ["sent_at"],
        postgresql_where=sa.text("kind = 'campaign'"),
    )

    op.create_table(
        "notification_template_versions",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("texts", pg.JSONB(), nullable=False),
        sa.Column("note", sa.String(300), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("activated_by", sa.String(64)),
        sa.Column("activated_at", sa.DateTime(timezone=True)),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_hash", sa.String(64)),
        sa.CheckConstraint("status IN ('draft','active','archived')", name="ck_template_versions_status"),
        sa.CheckConstraint("version >= 1", name="ck_template_versions_version"),
    )
    op.create_index(
        "uq_template_versions_active",
        "notification_template_versions",
        ["key"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "uq_template_versions_idempotency",
        "notification_template_versions",
        ["created_by", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )

    op.create_table(
        "campaigns",
        sa.Column("campaign_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("texts", pg.JSONB(), nullable=False),
        sa.Column("route", sa.String(32)),
        sa.Column("segment", pg.JSONB(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("send_at", sa.DateTime(timezone=True)),
        sa.Column("audience_count", sa.Integer()),
        sa.Column("cursor", sa.String(512)),
        sa.Column("audience_complete", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scheduled_by", sa.String(64)),
        sa.Column("scheduled_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("stopped_by", sa.String(64)),
        sa.Column("stopped_at", sa.DateTime(timezone=True)),
        sa.Column("stop_reason", sa.String(300)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_hash", sa.String(64)),
        sa.CheckConstraint(
            "status IN ('draft','scheduled','sending','done','stopped')", name="ck_campaigns_status"
        ),
        sa.CheckConstraint("version >= 1", name="ck_campaigns_version"),
    )
    op.create_index("ix_campaigns_created", "campaigns", ["created_at", "campaign_id"])
    op.create_index("ix_campaigns_status_send_at", "campaigns", ["status", "send_at"])
    op.create_index(
        "uq_campaigns_idempotency",
        "campaigns",
        ["created_by", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )

    op.create_table(
        "campaign_recipients",
        sa.Column(
            "campaign_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("campaigns.campaign_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("notification_id", pg.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('pending','created','skipped_frequency','cancelled')", name="ck_campaign_recipients_status"
        ),
    )
    op.create_index(
        "ix_campaign_recipients_pending",
        "campaign_recipients",
        ["campaign_id", "user_id"],
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "ix_campaign_recipients_user_created",
        "campaign_recipients",
        ["user_id", "processed_at"],
        postgresql_where=sa.text("status = 'created'"),
    )
    op.create_index("ix_campaign_recipients_user", "campaign_recipients", ["user_id"])


def downgrade() -> None:
    op.drop_table("campaign_recipients")
    op.drop_table("campaigns")
    op.drop_table("notification_template_versions")
    op.drop_index("ix_notifications_campaign_sent", table_name="notifications")
    op.execute("DELETE FROM notifications WHERE kind = 'campaign'")
    op.drop_constraint("ck_notifications_telegram_status", "notifications", type_="check")
    op.create_check_constraint(
        "ck_notifications_telegram_status", "notifications", f"telegram_status IN ({STATUSES_V1})"
    )
    op.drop_constraint("ck_notifications_kind", "notifications", type_="check")
    op.create_check_constraint("ck_notifications_kind", "notifications", "kind IN ('standard','transactional')")
