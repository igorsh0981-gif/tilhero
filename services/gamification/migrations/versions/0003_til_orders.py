"""спринт 8: тилы за деньги (INTERNAL_API спринта 8 §6).

- til_orders — пакет тилов по заказу billing (одна строка на заказ): получатель, сколько тилов, операция `purchase`
  (ключ `purchase:<order_id>`), обратная запись при возврате; статус credited → reversed (тилы списаны обратной
  записью) | tils_spent (на балансе уже меньше пакета — обратной записи нет, billing заводит пункт сверки).
  Строки удаляются сагой вместе с реестром ученика.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-22
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "til_orders",
        sa.Column("order_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("til", sa.Integer(), nullable=False),
        sa.Column("op_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("reversal_op_id", pg.UUID(as_uuid=True)),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("credited_at", TS, nullable=False),
        sa.Column("reversed_at", TS),
        sa.CheckConstraint("til BETWEEN 1 AND 100000", name="ck_til_orders_til"),
        sa.CheckConstraint("status IN ('credited','reversed','tils_spent')", name="ck_til_orders_status"),
        sa.CheckConstraint("(status = 'reversed') = (reversal_op_id IS NOT NULL)", name="ck_til_orders_reversal"),
        sa.CheckConstraint("(status = 'credited') = (reversed_at IS NULL)", name="ck_til_orders_reversed_at"),
    )
    op.create_index("ix_til_orders_user", "til_orders", ["user_id"])


def downgrade() -> None:
    op.drop_table("til_orders")
