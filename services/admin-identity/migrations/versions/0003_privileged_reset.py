"""approvals.kind += staff.privileged_reset (four-eyes на сброс пароля/MFA привилегированного сотрудника, ревью N1)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-09
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

_KINDS_OLD = ("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
              "'staff.privileged_revoke')")
_KINDS_NEW = ("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
              "'staff.privileged_revoke','staff.privileged_reset')")


def upgrade() -> None:
    op.drop_constraint("ck_approval_kind", "approvals", type_="check")
    op.create_check_constraint("ck_approval_kind", "approvals", _KINDS_NEW)


def downgrade() -> None:
    op.execute("DELETE FROM approvals WHERE kind = 'staff.privileged_reset'")
    op.drop_constraint("ck_approval_kind", "approvals", type_="check")
    op.create_check_constraint("ck_approval_kind", "approvals", _KINDS_OLD)
