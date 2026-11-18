"""Спринт 8: индекс last_seen_at — «активные за период» на дашборде (docs/sprint8/INTERNAL_API.md §7.1).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-15
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_summary_last_seen", "admin_user_summary", ["last_seen_at"])


def downgrade() -> None:
    op.drop_index("ix_summary_last_seen", table_name="admin_user_summary")
