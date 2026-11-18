"""approvals.kind += staff.privileged_revoke (four-eyes на понижение/отключение super_admin);
roles.privileged пересчитывается по правам (роль из контракта или есть привилегированное право)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

PRIVILEGED_ROLES = ("super_admin", "operations", "billing", "agent_manager")
PRIVILEGED_PERMISSIONS = ("staff.manage", "roles.manage", "users.sensitive.read", "billing.refund",
                          "subscriptions.override", "config.publish", "ops.kill_switch", "ai.content.read",
                          "export.csv")

_KINDS_OLD = "kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change')"
_KINDS_NEW = ("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
              "'staff.privileged_revoke')")


def upgrade() -> None:
    op.drop_constraint("ck_approval_kind", "approvals", type_="check")
    op.create_check_constraint("ck_approval_kind", "approvals", _KINDS_NEW)
    op.execute(sa.text(
        "UPDATE roles SET privileged = (code = ANY(:roles) OR EXISTS (SELECT 1 FROM role_permissions rp "
        "WHERE rp.role = roles.code AND rp.permission = ANY(:perms)))"
    ).bindparams(roles=list(PRIVILEGED_ROLES), perms=list(PRIVILEGED_PERMISSIONS)))


def downgrade() -> None:
    op.execute("DELETE FROM approvals WHERE kind = 'staff.privileged_revoke'")
    op.drop_constraint("ck_approval_kind", "approvals", type_="check")
    op.create_check_constraint("ck_approval_kind", "approvals", _KINDS_OLD)
