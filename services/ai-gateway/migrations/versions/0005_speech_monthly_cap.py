"""спринт 5 (решение владельца 20.11.2026): подлимит оценки произношения внутри месячного потолка ИИ

`budget.speech_monthly_cap_usd` — по умолчанию 5 $ (≈ 3,8 ч аудио по 1,32 $/ч), 0..monthly_cap_usd. Исчерпан (расход
речи за календарный месяц UTC + оценка записи) — оценка произношения `unavailable: budget_exceeded`,
`speech_available=false`; вызовы агентов подлимит не затрагивает (речь по-прежнему входит в общий monthly_cap_usd).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("budget", sa.Column("speech_monthly_cap_usd", sa.Numeric(10, 2), nullable=False,
                                      server_default="5.00"))
    # потолок месяца меньше 5 $ (правка сотрудника) — подлимит не больше потолка
    op.execute("UPDATE budget SET speech_monthly_cap_usd = LEAST(speech_monthly_cap_usd, monthly_cap_usd)")
    op.create_check_constraint("ck_budget_speech", "budget",
                               "speech_monthly_cap_usd >= 0 AND speech_monthly_cap_usd <= monthly_cap_usd")


def downgrade() -> None:
    op.drop_constraint("ck_budget_speech", "budget", type_="check")
    op.drop_column("budget", "speech_monthly_cap_usd")
