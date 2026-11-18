"""Данные: email сотрудников вида «<a@b.ru>» (шаблон bootstrap-переменной заменили не целиком) → «a@b.ru».
С новой строгой проверкой email такой логин не нашёлся бы при входе. Только если исправленный адрес свободен.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-10
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE staff AS s SET email = btrim(s.email, ' <>"'''), updated_at = now()
        WHERE s.email ~ '^[ <"'']|[ >"'']$'
          AND btrim(s.email, ' <>"''') <> ''
          AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.email = btrim(s.email, ' <>"'''))
        """
    )


def downgrade() -> None:
    pass  # исправление данных не откатывается
