"""notifications спринт 6 (INTERNAL_API спринта 6 §3): категория game в журнале — заморозка серии, новый значок,
ступень героя (шаблоны streak_frozen, badge_earned, hero_stage_reached — в коде, templates.py)

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-20
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

OLD = "category IN ('reminders','missed','social','support','product','service')"
NEW = "category IN ('reminders','missed','social','support','product','service','game')"


def upgrade() -> None:
    op.drop_constraint("ck_notifications_category", "notifications", type_="check")
    op.create_check_constraint("ck_notifications_category", "notifications", NEW)


def downgrade() -> None:
    # записи game до этой версии невозможны: они удаляются вместе с ограничением
    op.execute("DELETE FROM notifications WHERE category = 'game'")
    op.drop_constraint("ck_notifications_category", "notifications", type_="check")
    op.create_check_constraint("ck_notifications_category", "notifications", OLD)
