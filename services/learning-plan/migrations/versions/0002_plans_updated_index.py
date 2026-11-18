"""plans: индекс (updated_at, user_id) для сверки read-модели админки (GET /admin/v1/plans)

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_plans_updated", "plans", ["updated_at", "user_id"])


def downgrade() -> None:
    op.drop_index("ix_plans_updated", table_name="plans")
