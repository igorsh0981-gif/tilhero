"""спринт 7 (INTERNAL_API §5, §6): категория уведомлений `game` в карточке ученика (admin.ts
AdminLearnerCard.notifications.categories — все категории, кроме service)

identity-consent (миграция 0005) включает `game` всем ученикам (по умолчанию включена) без отдельного события
`user.notification_settings.changed.v1`. Read-модель повторяет это: в спроецированных настройках `categories.game =
true`, если ключа ещё нет (свежее событие или сверка после миграции перезапишут значение источником). Строки без
настроек (`notifications IS NULL`) не трогаются — их заполнит событие или сверка.

Откат: ключ `game` удаляется из спроецированных настроек.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-21
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE admin_learner_summary "
               "SET notifications = jsonb_set(notifications, '{categories,game}', 'true'::jsonb, true) "
               "WHERE notifications IS NOT NULL AND jsonb_typeof(notifications->'categories') = 'object' "
               "AND NOT (notifications->'categories' ? 'game')")


def downgrade() -> None:
    op.execute("UPDATE admin_learner_summary SET notifications = notifications #- '{categories,game}' "
               "WHERE notifications IS NOT NULL AND notifications->'categories' ? 'game'")
