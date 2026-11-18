"""approvals.kind += staff.reactivate_privileged (ревью P2-2: включение отключённого сотрудника с привилегированной
ролью — только four-eyes). Отдельной ревизией: 0001 уже накатана на стенде.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

_KINDS_OLD = ("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
              "'staff.privileged_revoke','staff.privileged_reset')")
_KINDS_NEW = ("kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
              "'staff.privileged_revoke','staff.privileged_reset','staff.reactivate_privileged')")


def upgrade() -> None:
    op.drop_constraint("ck_approval_kind", "approvals", type_="check")
    op.create_check_constraint("ck_approval_kind", "approvals", _KINDS_NEW)


def downgrade() -> None:
    # открытые и исторические заявки нового вида не переживают откат CHECK
    op.execute("DELETE FROM approvals WHERE kind = 'staff.reactivate_privileged'")
    op.drop_constraint("ck_approval_kind", "approvals", type_="check")
    op.create_check_constraint("ck_approval_kind", "approvals", _KINDS_OLD)
