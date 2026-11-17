"""ops_deliveries — оповещения операторам в Telegram (спринт 8, docs/sprint8/INTERNAL_API.md §6)

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-15
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ops_deliveries",
        sa.Column("delivery_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("dedup_key", sa.String(200), nullable=False),
        sa.Column("alert_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("template", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(64)),
        sa.Column("telegram_message_id", sa.BigInteger()),
        sa.Column("source_event_id", pg.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("dedup_key", name="uq_ops_deliveries_dedup_key"),
        sa.CheckConstraint("status IN ('pending','sent','skipped','failed')", name="ck_ops_deliveries_status"),
        sa.CheckConstraint("attempts >= 0", name="ck_ops_deliveries_attempts"),
    )
    op.create_index("ix_ops_deliveries_created", "ops_deliveries", ["created_at"])


def downgrade() -> None:
    op.drop_table("ops_deliveries")
