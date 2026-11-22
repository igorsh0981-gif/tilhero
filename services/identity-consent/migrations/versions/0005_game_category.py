"""спринт 7 (INTERNAL_API §5, §6): категория уведомлений `game` — игра и лиги (значки, рост героя, спасённая серия,
итоги лиги, дуэли)

- `users.notify_categories`: CHECK допускает `game`; по умолчанию у новых учеников — `{support,game}` (категория
  включена: выключенная — уведомления остаются в центре без Telegram, notifications `GAME_CATEGORY_GATE=game`).
- Действующим ученикам (и детским профилям) `game` добавляется: в спринте 6 игровые уведомления шли по выключателю
  `reminders`, новая категория по решению §5 включена по умолчанию. Порядок массива — канонический (game последняя).

Откат: `game` убирается из массивов, CHECK и значение по умолчанию — как в 0001.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-21
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

# снимки (миграция не зависит от будущих правок models.py)
CATEGORIES_V1 = "ARRAY['reminders','missed','social','support','product']::text[]"
CATEGORIES_V5 = "ARRAY['reminders','missed','social','support','product','game']::text[]"


def upgrade() -> None:
    op.drop_constraint("ck_users_notify_categories", "users", type_="check")
    op.create_check_constraint("ck_users_notify_categories", "users", f"notify_categories <@ {CATEGORIES_V5}")
    op.alter_column("users", "notify_categories", server_default=sa.text("'{support,game}'::text[]"))
    op.execute("UPDATE users SET notify_categories = array_append(notify_categories, 'game') "
               "WHERE NOT ('game' = ANY (notify_categories))")


def downgrade() -> None:
    op.execute("UPDATE users SET notify_categories = array_remove(notify_categories, 'game') "
               "WHERE 'game' = ANY (notify_categories)")
    op.alter_column("users", "notify_categories", server_default=sa.text("'{support}'::text[]"))
    op.drop_constraint("ck_users_notify_categories", "users", type_="check")
    op.create_check_constraint("ck_users_notify_categories", "users", f"notify_categories <@ {CATEGORIES_V1}")
