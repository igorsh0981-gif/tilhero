"""notifications спринт 2, ревью P2-7: серия неудач шага рассылки (last_error) в campaigns

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("campaigns", sa.Column("error_code", sa.String(64)))
    op.add_column("campaigns", sa.Column("error_since", sa.DateTime(timezone=True)))
    op.add_column("campaigns", sa.Column("error_attempts", sa.Integer(), nullable=False, server_default="0"))
    op.add_column(
        "campaigns", sa.Column("error_reported", sa.Boolean(), nullable=False, server_default=sa.text("false"))
    )
    op.create_check_constraint("ck_campaigns_error_attempts", "campaigns", "error_attempts >= 0")


def downgrade() -> None:
    op.drop_constraint("ck_campaigns_error_attempts", "campaigns", type_="check")
    for column in ("error_reported", "error_attempts", "error_since", "error_code"):
        op.drop_column("campaigns", column)
