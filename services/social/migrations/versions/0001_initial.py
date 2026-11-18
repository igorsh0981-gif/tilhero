"""social: invites, invite_redemptions, families, family_members, friendships, profiles, deleted_users + outbox/inbox

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
UUID = pg.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "invites",
        sa.Column("invite_id", UUID, primary_key=True),
        sa.Column("inviter_user_id", UUID, nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("max_uses", sa.Integer()),
        sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", TS),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.UniqueConstraint("inviter_user_id", "idempotency_key", name="uq_invites_inviter_idempotency"),
        sa.CheckConstraint("kind IN ('family','friend','referral')", name="ck_invites_kind"),
        sa.CheckConstraint("status IN ('active','accepted','revoked','expired')", name="ck_invites_status"),
        sa.CheckConstraint("max_uses IS NULL OR max_uses >= 1", name="ck_invites_max_uses"),
        sa.CheckConstraint("uses >= 0", name="ck_invites_uses"),
    )
    op.create_index("ix_invites_inviter_created", "invites", ["inviter_user_id", "created_at"])
    op.create_index("ix_invites_status_expires", "invites", ["status", "expires_at"])
    op.create_table(
        "invite_redemptions",
        sa.Column("invite_id", UUID, sa.ForeignKey("invites.invite_id", ondelete="CASCADE",
                                                   name="fk_redemptions_invite"), primary_key=True),
        sa.Column("invitee_user_id", UUID, primary_key=True),
        sa.Column("opened_at", TS, nullable=False),
        sa.Column("accepted_at", TS),
        sa.Column("declined_at", TS),
        sa.Column("reminded_at", TS),
    )
    op.create_index("ix_redemptions_invitee", "invite_redemptions", ["invitee_user_id"])
    op.create_index("ix_redemptions_opened", "invite_redemptions", ["opened_at"])
    op.create_table(
        "families",
        sa.Column("family_id", UUID, primary_key=True),
        sa.Column("owner_user_id", UUID, nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "family_members",
        sa.Column("family_id", UUID, sa.ForeignKey("families.family_id", ondelete="CASCADE",
                                                   name="fk_family_members_family"), primary_key=True),
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("joined_at", TS, nullable=False),
        sa.UniqueConstraint("user_id", name="uq_family_members_user"),
        sa.CheckConstraint("role IN ('owner','adult','teen','child')", name="ck_family_members_role"),
    )
    op.create_table(
        "friendships",
        sa.Column("user_a", UUID, primary_key=True),
        sa.Column("user_b", UUID, primary_key=True),
        sa.Column("invite_id", UUID),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("user_a < user_b", name="ck_friendships_order"),
    )
    op.create_index("ix_friendships_user_b", "friendships", ["user_b"])
    op.create_table(
        "profiles",
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("kind", sa.String(8)),
        sa.Column("guardian_consent", sa.String(16)),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IS NULL OR kind IN ('account','child')", name="ck_profiles_kind"),
        sa.CheckConstraint("guardian_consent IS NULL OR guardian_consent IN "
                           "('not_required','pending','granted','declined')", name="ck_profiles_guardian_consent"),
    )
    op.create_table(
        "deleted_users",
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("request_id", UUID, nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )
    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("deleted_users")
    op.drop_table("profiles")
    op.drop_index("ix_friendships_user_b", table_name="friendships")
    op.drop_table("friendships")
    op.drop_table("family_members")
    op.drop_table("families")
    op.drop_index("ix_redemptions_opened", table_name="invite_redemptions")
    op.drop_index("ix_redemptions_invitee", table_name="invite_redemptions")
    op.drop_table("invite_redemptions")
    op.drop_index("ix_invites_status_expires", table_name="invites")
    op.drop_index("ix_invites_inviter_created", table_name="invites")
    op.drop_table("invites")
