"""staff, roles, role_permissions, approvals + outbox/inbox; сид ролей и матрицы прав (INTERNAL_API спринта 2)

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

ALL_PERMISSIONS = [
    "dashboard.read", "users.read", "users.sensitive.read", "ai.content.read", "export.csv",
    "support.read", "support.reply", "support.manage", "subscriptions.override", "billing.refund",
    "skills.edit", "skills.publish", "audit.read", "config.read", "config.edit", "config.publish",
    "ops.kill_switch", "staff.manage", "roles.manage",
]

# (code, name_ru, name_en, privileged, permissions) — матрица по умолчанию; дальше меняется через four-eyes
ROLES = [
    ("super_admin", "Суперадминистратор", "Super Admin", True, ALL_PERMISSIONS),
    ("operations", "Операции", "Operations", True,
     ["dashboard.read", "users.read", "support.read", "config.read", "ops.kill_switch", "audit.read"]),
    ("support", "Поддержка", "Support", False, ["dashboard.read", "users.read", "support.read", "support.reply"]),
    ("billing", "Биллинг", "Billing", True,
     ["dashboard.read", "users.read", "subscriptions.override", "billing.refund"]),
    ("agent_manager", "Менеджер агентов", "Agent Manager", True, ["dashboard.read", "skills.edit"]),
    ("analyst", "Аналитик", "Analyst", False, ["dashboard.read", "users.read"]),
    ("auditor", "Аудитор", "Auditor", False, ["dashboard.read", "audit.read"]),
    ("read_only", "Только просмотр", "Read Only", False, ["dashboard.read"]),
]


def upgrade() -> None:
    roles = op.create_table(
        "roles",
        sa.Column("code", sa.String(32), primary_key=True),
        sa.Column("name_ru", sa.String(80), nullable=False),
        sa.Column("name_en", sa.String(80), nullable=False),
        sa.Column("privileged", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", pg.UUID(as_uuid=True)),
    )
    role_permissions = op.create_table(
        "role_permissions",
        sa.Column("role", sa.String(32), sa.ForeignKey("roles.code", ondelete="CASCADE"), primary_key=True),
        sa.Column("permission", sa.String(64), primary_key=True),
    )
    op.create_table(
        "staff",
        sa.Column("staff_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(254), nullable=False, unique=True),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("role", sa.String(32), sa.ForeignKey("roles.code"), nullable=False),
        sa.Column("auth_provider", sa.String(8), nullable=False, server_default="local"),
        sa.Column("password_hash", sa.Text()),
        sa.Column("password_changed_at", sa.DateTime(timezone=True)),
        sa.Column("temp_password_expires_at", sa.DateTime(timezone=True)),
        sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("mfa_secret_enc", sa.LargeBinary()),
        sa.Column("mfa_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("mfa_last_step", sa.BigInteger()),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("session_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", pg.UUID(as_uuid=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("email = lower(email)", name="ck_staff_email_lower"),
        sa.CheckConstraint("auth_provider IN ('local','ad')", name="ck_staff_auth_provider"),
        sa.CheckConstraint("status IN ('ACTIVE','LOCKED','DISABLED')", name="ck_staff_status"),
    )
    op.create_index("ix_staff_role", "staff", ["role"])
    op.create_index("ix_staff_created_at", "staff", ["created_at"])
    op.create_table(
        "approvals",
        sa.Column("approval_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("target", sa.String(80), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("summary", pg.JSONB(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("requested_by", pg.UUID(as_uuid=True), sa.ForeignKey("staff.staff_id"), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("decided_by", pg.UUID(as_uuid=True), sa.ForeignKey("staff.staff_id")),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("decision_note", sa.Text()),
        sa.Column("waived", sa.String(32)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change')",
                           name="ck_approval_kind"),
        sa.CheckConstraint("status IN ('PENDING','APPROVED','REJECTED','EXPIRED','APPLIED')",
                           name="ck_approval_status"),
        sa.CheckConstraint("waived IS NULL OR waived = 'single_super_admin'", name="ck_approval_waived"),
    )
    op.create_index("ix_approvals_status_requested_at", "approvals", ["status", "requested_at"])
    op.create_index("ux_approvals_pending_target", "approvals", ["target"], unique=True,
                    postgresql_where=sa.text("status = 'PENDING'"))

    op.bulk_insert(roles, [
        {"code": code, "name_ru": ru, "name_en": en, "privileged": privileged}
        for code, ru, en, privileged, _ in ROLES
    ])
    op.bulk_insert(role_permissions, [
        {"role": code, "permission": perm} for code, _, _, _, perms in ROLES for perm in perms
    ])

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("approvals")
    op.drop_table("staff")
    op.drop_table("role_permissions")
    op.drop_table("roles")
