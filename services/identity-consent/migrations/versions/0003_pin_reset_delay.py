"""Сброс кода родителя через бота — с задержкой (ревью T-8, INTERNAL_API «Сброс кода родителя через бота»)

pin_credentials.reset_*: ожидающий сброс. Новый код (Argon2id) хранится рядом с действующим и начинает действовать
с `reset_effective_at` (now + PIN_RESET_DELAY_HOURS) — при следующей проверке кода; до этого действует прежний,
любой его верный ввод сброс отменяет. Все четыре поля заданы вместе или все NULL.

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

# те же фрагменты, что в models.PinCredential (schema_drift сверяет имена ограничений)
PIN_RESET_COMPLETE_SQL = (
    "(reset_pin_hash IS NULL) = (reset_pin_length IS NULL) AND (reset_pin_hash IS NULL) = (reset_requested_at IS NULL)"
    " AND (reset_pin_hash IS NULL) = (reset_effective_at IS NULL)"
)
PIN_RESET_LENGTH_SQL = "reset_pin_length IS NULL OR reset_pin_length IN (4, 6)"


def upgrade() -> None:
    op.add_column("pin_credentials", sa.Column("reset_pin_hash", sa.Text()))
    op.add_column("pin_credentials", sa.Column("reset_pin_length", sa.SmallInteger()))
    op.add_column("pin_credentials", sa.Column("reset_requested_at", sa.DateTime(timezone=True)))
    op.add_column("pin_credentials", sa.Column("reset_effective_at", sa.DateTime(timezone=True)))
    op.create_check_constraint("ck_pin_reset_complete", "pin_credentials", PIN_RESET_COMPLETE_SQL)
    op.create_check_constraint("ck_pin_reset_length", "pin_credentials", PIN_RESET_LENGTH_SQL)


def downgrade() -> None:
    op.drop_constraint("ck_pin_reset_length", "pin_credentials", type_="check")
    op.drop_constraint("ck_pin_reset_complete", "pin_credentials", type_="check")
    op.drop_column("pin_credentials", "reset_effective_at")
    op.drop_column("pin_credentials", "reset_requested_at")
    op.drop_column("pin_credentials", "reset_pin_length")
    op.drop_column("pin_credentials", "reset_pin_hash")
