"""admin_user_summary, ticket_refs, sync_state + outbox/inbox

Revision ID: 0001
Revises:
Create Date: 2026-10-09
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
MASK_NONE = "•" * 9


def upgrade() -> None:
    op.create_table(
        "admin_user_summary",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("username", sa.String(64)),
        sa.Column("display_name", sa.String(160)),
        sa.Column("telegram_id_masked", sa.String(16), nullable=False, server_default=MASK_NONE),
        sa.Column("locale", sa.String(8)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("profile_known", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("last_seen_at", TS),
        sa.Column("identity_version", TS),
        sa.Column("status", sa.String(24), nullable=False, server_default="ACTIVE"),
        sa.Column("status_at", TS),
        sa.Column("consent_policy_version", sa.String(20)),
        sa.Column("consent_purposes", pg.ARRAY(sa.String(32)), nullable=False,
                  server_default=sa.text("'{}'::varchar[]")),
        sa.Column("consent_accepted_at", TS),
        sa.Column("consent_revoked_at", TS),
        sa.Column("age_confirmed_18_plus", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("consent_at", TS),
        sa.Column("pin_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("pin_at", TS),
        sa.Column("biometric_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("biometric_at", TS),
        sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("onboarding_at", TS),
        sa.Column("preferences_updated_at", TS),
        sa.Column("preferences_changed_fields", pg.ARRAY(sa.String(64)), nullable=False,
                  server_default=sa.text("'{}'::varchar[]")),
        sa.Column("open_tickets", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tickets_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("refreshed_at", TS),
        sa.Column("erased_at", TS),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')",
                           name="ck_summary_status"),
        sa.CheckConstraint("open_tickets >= 0 AND tickets_total >= open_tickets", name="ck_summary_tickets"),
        sa.CheckConstraint("status <> 'DELETED' OR (username IS NULL AND display_name IS NULL)",
                           name="ck_summary_deleted_erased"),
    )
    op.create_index("ix_summary_created", "admin_user_summary", ["created_at", "user_id"])
    op.create_index("ix_summary_status", "admin_user_summary", ["status"])

    op.create_table(
        "ticket_refs",
        sa.Column("ticket_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("number", sa.BigInteger(), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True)),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("status_at", TS, nullable=False),
        sa.Column("anonymized", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.UniqueConstraint("number", name="uq_ticket_refs_number"),
        sa.CheckConstraint("status IN ('NEW','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED')",
                           name="ck_ticket_refs_status"),
        sa.CheckConstraint("NOT anonymized OR user_id IS NULL", name="ck_ticket_refs_anonymized"),
    )
    op.create_index("ix_ticket_refs_user", "ticket_refs", ["user_id"])

    op.create_table(
        "sync_state",
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("watermark", TS),
        sa.Column("last_run_at", TS),
        sa.Column("last_success_at", TS),
        sa.Column("last_error_at", TS),
        sa.Column("last_error", sa.String(64)),
        sa.Column("synced_total", sa.BigInteger(), nullable=False, server_default="0"),
    )

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("sync_state")
    op.drop_table("ticket_refs")
    op.drop_table("admin_user_summary")
