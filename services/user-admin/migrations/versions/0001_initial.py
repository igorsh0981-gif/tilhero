"""admin_learner_summary, ticket_refs, reconcile_state + outbox/inbox

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
# Значения CHECK — как в моделях (tilhero_user_admin.models); миграция от моделей не зависит
CONSENT_DEFAULT = ("'{\"policy_version\": null, \"purposes\": [], \"accepted_at\": null, \"revoked_at\": null, "
                   "\"basis\": null}'::jsonb")
SECURITY_DEFAULT = "'{\"pin_enabled\": false, \"pin_reset_pending\": false}'::jsonb"


def upgrade() -> None:
    op.create_table(
        "admin_learner_summary",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False, server_default="account"),
        sa.Column("guardian_user_id", pg.UUID(as_uuid=True)),
        sa.Column("display_name", sa.String(160)),
        sa.Column("username", sa.String(64)),
        sa.Column("telegram_id_masked", sa.String(16)),
        sa.Column("search_text", sa.Text()),
        sa.Column("source_updated_at", TS),
        sa.Column("locale", sa.String(2)),
        sa.Column("age_band", sa.String(5)),
        sa.Column("guardian_consent", sa.String(16), nullable=False, server_default="not_required"),
        sa.Column("profile_at", TS),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("profile_known", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("status", sa.String(24), nullable=False, server_default="ACTIVE"),
        sa.Column("status_at", TS),
        sa.Column("consent", pg.JSONB(), nullable=False, server_default=sa.text(CONSENT_DEFAULT)),
        sa.Column("consent_at", TS),
        sa.Column("security", pg.JSONB(), nullable=False, server_default=sa.text(SECURITY_DEFAULT)),
        sa.Column("pin_at", TS),
        sa.Column("pin_reset_at", TS),
        sa.Column("notifications", pg.JSONB()),
        sa.Column("notifications_at", TS),
        sa.Column("plan", pg.JSONB()),
        sa.Column("plan_at", TS),
        sa.Column("goal", sa.String(16)),
        sa.Column("reminders_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("last_activity_at", TS),
        sa.Column("open_tickets", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tickets_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("refreshed_at", TS),
        sa.Column("erased_at", TS),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IN ('account','child')", name="ck_learner_kind"),
        sa.CheckConstraint("status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')", name="ck_learner_status"),
        sa.CheckConstraint("locale IS NULL OR locale IN ('ru','uz')", name="ck_learner_locale"),
        sa.CheckConstraint("age_band IS NULL OR age_band IN ('6-9','10-13','14-17','18+')", name="ck_learner_age_band"),
        sa.CheckConstraint("guardian_consent IN ('not_required','pending','granted','declined')",
                           name="ck_learner_guardian_consent"),
        sa.CheckConstraint("goal IS NULL OR goal IN ('work','career','travel','daily','study','exam')",
                           name="ck_learner_goal"),
        sa.CheckConstraint("open_tickets >= 0 AND tickets_total >= open_tickets", name="ck_learner_tickets"),
        sa.CheckConstraint("telegram_id_masked IS NULL OR telegram_id_masked ~ '^•{6}[0-9]{3}$'",
                           name="ck_learner_mask"),
        sa.CheckConstraint("kind <> 'child' OR (telegram_id_masked IS NULL AND username IS NULL)",
                           name="ck_learner_child_no_telegram"),
        sa.CheckConstraint("kind = 'child' OR guardian_user_id IS NULL", name="ck_learner_guardian_child_only"),
        sa.CheckConstraint("guardian_user_id IS NULL OR guardian_user_id <> user_id",
                           name="ck_learner_guardian_not_self"),
        sa.CheckConstraint(
            "status <> 'DELETED' OR (username IS NULL AND display_name IS NULL AND telegram_id_masked IS NULL "
            "AND search_text IS NULL AND guardian_user_id IS NULL AND plan IS NULL AND notifications IS NULL)",
            name="ck_learner_deleted_erased",
        ),
    )
    op.create_index("ix_learner_created", "admin_learner_summary", ["created_at", "user_id"])
    op.create_index("ix_learner_status", "admin_learner_summary", ["status"])
    op.create_index("ix_learner_guardian", "admin_learner_summary", ["guardian_user_id"],
                    postgresql_where=sa.text("guardian_user_id IS NOT NULL"))
    op.create_index("ix_learner_activity", "admin_learner_summary", ["last_activity_at"])

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
        "reconcile_state",
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
    op.drop_table("reconcile_state")
    op.drop_table("ticket_refs")
    op.drop_table("admin_learner_summary")
