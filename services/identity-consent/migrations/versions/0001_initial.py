"""TilHero identity-consent: users (аккаунты и детские профили), guardian_links, guardian_consent_requests,
consents (неизменяемая история с основанием и возрастом), pin/biometric credentials, сага удаления + outbox/inbox

Prod-БД ещё нет: схема собрана с нуля одной миграцией (форк aievent 0001–0003 + изменения TilHero, INTERNAL_API §1).

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

AGE_BANDS = "('6-9','10-13','14-17','18+')"
CATEGORIES = "ARRAY['reminders','missed','social','support','product']::text[]"
OPEN = "status IN ('REQUESTED','STUCK')"


def _ts(name: str, **kw):
    return sa.Column(name, sa.DateTime(timezone=True), **kw)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False, server_default="account"),
        sa.Column("telegram_user_id", sa.BigInteger(), nullable=True),
        sa.Column("username", sa.String(64)),
        sa.Column("display_name", sa.String(160)),
        sa.Column("locale", sa.String(2), nullable=False, server_default="ru"),
        sa.Column("status", sa.String(24), nullable=False, server_default="ACTIVE"),
        sa.Column("age_band", sa.String(5)),
        _ts("age_set_at"),
        sa.Column("guardian_consent", sa.String(16), nullable=False, server_default="not_required"),
        sa.Column("notifications_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("notify_categories", pg.ARRAY(sa.Text()), nullable=False,
                  server_default=sa.text("'{support}'::text[]")),
        sa.Column("quiet_hours_start", sa.Time(), server_default=sa.text("'22:00'")),
        sa.Column("quiet_hours_end", sa.Time(), server_default=sa.text("'08:00'")),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="Asia/Tashkent"),
        sa.Column("bot_blocked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        _ts("created_at", nullable=False, server_default=sa.func.now()),
        _ts("last_seen_at", nullable=False, server_default=sa.func.now()),
        _ts("updated_at", nullable=False, server_default=sa.func.now()),
        # NULL допускается многократно: дети без Telegram; после обезличивания Telegram ID освобождается.
        sa.UniqueConstraint("telegram_user_id", name="uq_users_telegram_user_id"),
        sa.CheckConstraint("kind IN ('account','child')", name="ck_users_kind"),
        sa.CheckConstraint("locale IN ('ru','uz')", name="ck_users_locale"),
        sa.CheckConstraint("status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')", name="ck_users_status"),
        sa.CheckConstraint(f"age_band IS NULL OR age_band IN {AGE_BANDS}", name="ck_users_age_band"),
        sa.CheckConstraint("guardian_consent IN ('not_required','pending','granted','declined')",
                           name="ck_users_guardian_consent"),
        sa.CheckConstraint("kind <> 'account' OR age_band IS NULL OR age_band IN ('14-17','18+')",
                           name="ck_users_account_age"),
        sa.CheckConstraint("kind <> 'child' OR (telegram_user_id IS NULL AND username IS NULL)",
                           name="ck_users_child_no_telegram"),
        sa.CheckConstraint("kind <> 'child' OR status = 'DELETED' OR age_band IN ('6-9','10-13')",
                           name="ck_users_child_age"),
        sa.CheckConstraint(f"notify_categories <@ {CATEGORIES}", name="ck_users_notify_categories"),
        sa.CheckConstraint("(quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)",
                           name="ck_users_quiet_hours_pair"),
        sa.CheckConstraint(
            "status <> 'DELETED' OR (telegram_user_id IS NULL AND username IS NULL AND display_name IS NULL)",
            name="ck_users_deleted_anonymized",
        ),
    )

    op.create_table(
        "guardian_links",
        sa.Column("child_user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("guardian_user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id"), nullable=False),
        _ts("created_at", nullable=False, server_default=sa.func.now()),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_fingerprint", sa.String(64)),
        sa.CheckConstraint("child_user_id <> guardian_user_id", name="ck_guardian_links_not_self"),
        sa.UniqueConstraint("guardian_user_id", "idempotency_key", name="uq_guardian_links_idempotency"),
    )
    op.create_index("ix_guardian_links_guardian", "guardian_links", ["guardian_user_id"])

    op.create_table(
        "guardian_consent_requests",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("teen_user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("guardian_user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id")),
        sa.Column("idempotency_key", sa.String(128)),
        _ts("created_at", nullable=False),
        _ts("decided_at"),
        _ts("expires_at", nullable=False),
        sa.CheckConstraint("status IN ('pending','granted','declined','expired','revoked')",
                           name="ck_guardian_consent_requests_status"),
        sa.CheckConstraint("(status IN ('granted','declined')) = (guardian_user_id IS NOT NULL)",
                           name="ck_guardian_consent_requests_guardian"),
        sa.CheckConstraint("(status IN ('granted','declined')) = (decided_at IS NOT NULL)",
                           name="ck_guardian_consent_requests_decided"),
        sa.CheckConstraint("expires_at > created_at", name="ck_guardian_consent_requests_expiry"),
        sa.UniqueConstraint("teen_user_id", "idempotency_key", name="uq_guardian_consent_requests_idempotency"),
    )
    op.create_index("ix_guardian_consent_requests_teen", "guardian_consent_requests", ["teen_user_id"])
    op.create_index("uq_guardian_consent_requests_pending", "guardian_consent_requests", ["teen_user_id"],
                    unique=True, postgresql_where=sa.text("status = 'pending'"))

    op.create_table(
        "consents",
        sa.Column("consent_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id"), nullable=False),
        sa.Column("policy_version", sa.String(20), nullable=False),
        sa.Column("purposes", pg.ARRAY(sa.String(32)), nullable=False),
        _ts("accepted_at", nullable=False),
        _ts("revoked_at"),
        sa.Column("revoke_reason", sa.String(16)),
        sa.Column("channel", sa.String(16), nullable=False, server_default="telegram"),
        sa.Column("locale", sa.String(2), nullable=False),
        sa.Column("age_band", sa.String(5)),
        sa.Column("basis", sa.String(16), nullable=False, server_default="self"),
        sa.Column("granted_by_user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id")),
        sa.Column("policy_text_sha256", sa.String(64), nullable=False),
        sa.Column("evidence_hash", sa.String(64), nullable=False, unique=True),
        sa.CheckConstraint("revoke_reason IS NULL OR revoke_reason IN ('user','superseded','deletion')",
                           name="ck_consents_revoke_reason"),
        sa.CheckConstraint("(revoked_at IS NULL) = (revoke_reason IS NULL)", name="ck_consents_revoke_pair"),
        sa.CheckConstraint("locale IN ('ru','uz')", name="ck_consents_locale"),
        sa.CheckConstraint(f"age_band IS NULL OR age_band IN {AGE_BANDS}", name="ck_consents_age_band"),
        sa.CheckConstraint("basis IN ('self','guardian')", name="ck_consents_basis"),
        sa.CheckConstraint("(basis = 'guardian') = (granted_by_user_id IS NOT NULL)", name="ck_consents_granted_by"),
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
             OR NEW.age_band IS DISTINCT FROM OLD.age_band
             OR NEW.basis IS DISTINCT FROM OLD.basis
             OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
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
        _ts("created_at", nullable=False, server_default=sa.func.now()),
        _ts("updated_at", nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("pin_length IN (4, 6)", name="ck_pin_length"),
    )
    op.create_table(
        "biometric_credentials",
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        _ts("created_at", nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "deletion_requests",
        sa.Column("request_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.user_id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="REQUESTED"),
        _ts("requested_at", nullable=False),
        _ts("completed_at"),
        sa.Column("expected_domains", pg.ARRAY(sa.String(64)), nullable=False),
        sa.Column("acked_domains", pg.ARRAY(sa.String(64)), nullable=False,
                  server_default=sa.text("'{}'::varchar[]")),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="1"),
        _ts("last_sent_at"),
        _ts("next_retry_at"),
        _ts("stuck_at"),
        sa.Column("last_retry_by", sa.String(64)),
        sa.Column("parent_request_id", pg.UUID(as_uuid=True), sa.ForeignKey("deletion_requests.request_id")),
        sa.CheckConstraint("status IN ('REQUESTED','STUCK','COMPLETED')", name="ck_deletion_status"),
        sa.CheckConstraint("attempts >= 1", name="ck_deletion_attempts"),
        sa.CheckConstraint("(status = 'COMPLETED') = (completed_at IS NOT NULL)", name="ck_deletion_completed"),
        sa.CheckConstraint("status <> 'STUCK' OR stuck_at IS NOT NULL", name="ck_deletion_stuck_at"),
    )
    op.create_index("ix_deletion_requests_user", "deletion_requests", ["user_id"])
    op.create_index("ix_deletion_requests_parent", "deletion_requests", ["parent_request_id"])
    op.create_index("uq_deletion_requests_open", "deletion_requests", ["user_id"], unique=True,
                    postgresql_where=sa.text(OPEN))
    op.create_index("ix_deletion_requests_due", "deletion_requests", ["next_retry_at"],
                    postgresql_where=sa.text(OPEN))

    op.create_table(
        "deletion_domain_acks",
        sa.Column("request_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("deletion_requests.request_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("domain", sa.String(64), primary_key=True),
        _ts("acked_at"),
        sa.Column("mode", sa.String(16)),
        sa.Column("event_id", pg.UUID(as_uuid=True)),
        sa.CheckConstraint("mode IS NULL OR mode IN ('deleted','anonymized')", name="ck_deletion_ack_mode"),
    )
    op.create_table(
        "deletion_attempts",
        sa.Column("request_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("deletion_requests.request_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("attempt", sa.Integer(), primary_key=True),
        _ts("sent_at", nullable=False),
        sa.Column("sent_by", sa.String(64), nullable=False),
        sa.Column("event_id", pg.UUID(as_uuid=True)),
        sa.CheckConstraint("attempt >= 1", name="ck_deletion_attempt_positive"),
    )

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("deletion_attempts")
    op.drop_table("deletion_domain_acks")
    op.drop_table("deletion_requests")
    op.drop_table("biometric_credentials")
    op.drop_table("pin_credentials")
    op.execute("DROP TRIGGER IF EXISTS consents_immutable ON consents")
    op.drop_table("consents")
    op.execute("DROP FUNCTION IF EXISTS consents_guard()")
    op.drop_table("guardian_consent_requests")
    op.drop_table("guardian_links")
    op.drop_table("users")
