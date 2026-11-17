"""users, consents (неизменяемая история), pin/biometric credentials, deletion_requests + outbox/inbox

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
        "users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("telegram_user_id", sa.BigInteger(), nullable=True),
        sa.Column("username", sa.String(64)),
        sa.Column("display_name", sa.String(160)),
        sa.Column("locale", sa.String(2), nullable=False, server_default="ru"),
        sa.Column("status", sa.String(24), nullable=False, server_default="ACTIVE"),
        sa.Column("age_confirmed_18_plus", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("age_confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("notifications_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("quiet_hours_start", sa.Time()),
        sa.Column("quiet_hours_end", sa.Time()),
        sa.Column("digest_time", sa.Time(), nullable=False, server_default=sa.text("'09:00'")),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="Asia/Tashkent"),
        sa.Column("bot_blocked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        # NULL допускается многократно: после обезличивания Telegram ID освобождается для новой регистрации.
        sa.UniqueConstraint("telegram_user_id", name="uq_users_telegram_user_id"),
        sa.CheckConstraint("locale IN ('ru','en')", name="ck_users_locale"),
        sa.CheckConstraint("status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')", name="ck_users_status"),
        sa.CheckConstraint("(quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)",
                           name="ck_users_quiet_hours_pair"),
        sa.CheckConstraint(
            "status <> 'DELETED' OR (telegram_user_id IS NULL AND username IS NULL AND display_name IS NULL)",
            name="ck_users_deleted_anonymized",
        ),
    )

    op.create_table(
        "consents",
        sa.Column("consent_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id"), nullable=False),
        sa.Column("policy_version", sa.String(20), nullable=False),
        sa.Column("purposes", pg.ARRAY(sa.String(32)), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoke_reason", sa.String(16)),
        sa.Column("channel", sa.String(16), nullable=False, server_default="telegram"),
        sa.Column("locale", sa.String(2), nullable=False),
        sa.Column("age_confirmed_18_plus", sa.Boolean(), nullable=False),
        sa.Column("policy_text_sha256", sa.String(64), nullable=False),
        sa.Column("evidence_hash", sa.String(64), nullable=False, unique=True),
        sa.CheckConstraint("revoke_reason IS NULL OR revoke_reason IN ('user','superseded','deletion')",
                           name="ck_consents_revoke_reason"),
        sa.CheckConstraint("(revoked_at IS NULL) = (revoke_reason IS NULL)", name="ck_consents_revoke_pair"),
    )
    op.create_index("ix_consents_user_accepted", "consents", ["user_id", "accepted_at"])
    op.create_index("uq_consents_active", "consents", ["user_id"], unique=True,
                    postgresql_where=sa.text("revoked_at IS NULL"))
    # Согласие — юридическое доказательство: удалять нельзя, менять можно только однократно отметку отзыва.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION consents_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'consents are immutable evidence (DELETE is not allowed)'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.consent_id IS DISTINCT FROM OLD.consent_id
             OR NEW.user_id IS DISTINCT FROM OLD.user_id
             OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
             OR NEW.purposes IS DISTINCT FROM OLD.purposes
             OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
             OR NEW.channel IS DISTINCT FROM OLD.channel
             OR NEW.locale IS DISTINCT FROM OLD.locale
             OR NEW.age_confirmed_18_plus IS DISTINCT FROM OLD.age_confirmed_18_plus
             OR NEW.policy_text_sha256 IS DISTINCT FROM OLD.policy_text_sha256
             OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash THEN
            RAISE EXCEPTION 'consents are immutable evidence (only revocation may be recorded)'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
                                             OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
            RAISE EXCEPTION 'consents are immutable evidence (revocation is final)'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON consents "
        "FOR EACH ROW EXECUTE FUNCTION consents_guard()"
    )

    op.create_table(
        "pin_credentials",
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("pin_hash", sa.Text(), nullable=False),
        sa.Column("pin_length", sa.SmallInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("pin_length IN (4, 6)", name="ck_pin_length"),
    )
    op.create_table(
        "biometric_credentials",
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "deletion_requests",
        sa.Column("request_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="REQUESTED"),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("expected_domains", pg.ARRAY(sa.String(64)), nullable=False),
        sa.Column("acked_domains", pg.ARRAY(sa.String(64)), nullable=False,
                  server_default=sa.text("'{}'::varchar[]")),
        sa.CheckConstraint("status IN ('REQUESTED','COMPLETED')", name="ck_deletion_status"),
    )
    op.create_index("ix_deletion_requests_user", "deletion_requests", ["user_id"])
    op.create_index("uq_deletion_requests_open", "deletion_requests", ["user_id"], unique=True,
                    postgresql_where=sa.text("status = 'REQUESTED'"))

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("deletion_requests")
    op.drop_table("biometric_credentials")
    op.drop_table("pin_credentials")
    op.execute("DROP TRIGGER IF EXISTS consents_immutable ON consents")
    op.drop_table("consents")
    op.execute("DROP FUNCTION IF EXISTS consents_guard()")
    op.drop_table("users")
