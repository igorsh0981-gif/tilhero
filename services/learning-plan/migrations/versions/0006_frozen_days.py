"""спринт 6 (INTERNAL_API §2): дни, закрытые заморозкой серии (game.streak.frozen.v1 от gamification) — пропуск
такого дня не рвёт серию и цепочку пропусков; неделя TodayPlan показывает frozen

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "frozen_days",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("op_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("frozen_days")
