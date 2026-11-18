"""staff, roles, role_permissions, approvals + outbox/inbox; сид ролей и матрицы прав TilHero

Одна миграция вместо истории форка (prod-БД админки пуста). Матрица по умолчанию — docs/sprint2/PLAN.md
§«Роли и права»; права и роли — packages/contracts/src/admin.ts (`Permission`, `RoleCode`, `PRIVILEGED_ROLES`),
сверка — tests/test_aid_contract.py. Дальше матрица меняется только через four-eyes (role.permissions_change).
Значения зафиксированы здесь, а не импортируются из кода: миграция не должна меняться вместе с каталогом.

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

ALL_PERMISSIONS = [
    "dashboard.read", "users.read", "users.sensitive.read", "support.read", "support.reply", "support.manage",
    "audit.read", "config.read", "config.edit", "config.publish", "whatsnew.manage", "whatsnew.publish",
    "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send", "staff.manage", "roles.manage",
]
# MFA обязательна, назначение — four-eyes (admin.ts PRIVILEGED_ROLES)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
# Роль с любым из этих прав тоже привилегированна (domain/catalog.py PRIVILEGED_PERMISSIONS)
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send"]

# (code, name_ru, name_en, permissions) — порядок ролей = RoleCode в admin.ts
ROLES = [
    ("super_admin", "Суперадминистратор", "Super Admin", ALL_PERMISSIONS),
    ("operations", "Операции", "Operations",
     ["dashboard.read", "users.read", "support.read", "config.read", "config.edit", "config.publish", "audit.read"]),
    ("communications", "Коммуникации", "Communications",
     ["dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage",
      "notif.campaigns.send"]),
    ("support", "Поддержка", "Support", ["dashboard.read", "users.read", "support.read", "support.reply"]),
    # контент и сценарии — спринт 3; пока только чтение (users.read без раскрытия)
    ("methodist", "Методист", "Methodologist", ["dashboard.read", "users.read"]),
    ("analyst", "Аналитик", "Analyst", ["dashboard.read", "users.read"]),
    ("auditor", "Аудитор", "Auditor", ["dashboard.read", "audit.read"]),
    ("read_only", "Только просмотр", "Read Only", ["dashboard.read"]),
]

APPROVAL_KINDS = ("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
                  "'staff.privileged_revoke','staff.privileged_reset')")


def _privileged(code: str, perms: list[str]) -> bool:
    return code in PRIVILEGED_ROLES or any(p in PRIVILEGED_PERMISSIONS for p in perms)


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
        sa.CheckConstraint(APPROVAL_KINDS, name="ck_approval_kind"),
        sa.CheckConstraint("status IN ('PENDING','APPROVED','REJECTED','EXPIRED','APPLIED')",
                           name="ck_approval_status"),
        sa.CheckConstraint("waived IS NULL OR waived = 'single_super_admin'", name="ck_approval_waived"),
    )
    op.create_index("ix_approvals_status_requested_at", "approvals", ["status", "requested_at"])
    op.create_index("ux_approvals_pending_target", "approvals", ["target"], unique=True,
                    postgresql_where=sa.text("status = 'PENDING'"))

    op.bulk_insert(roles, [
        {"code": code, "name_ru": ru, "name_en": en, "privileged": _privileged(code, perms)}
        for code, ru, en, perms in ROLES
    ])
    op.bulk_insert(role_permissions, [
        {"role": code, "permission": perm} for code, _, _, perms in ROLES for perm in perms
    ])

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("approvals")
    op.drop_table("staff")
    op.drop_table("role_permissions")
    op.drop_table("roles")
