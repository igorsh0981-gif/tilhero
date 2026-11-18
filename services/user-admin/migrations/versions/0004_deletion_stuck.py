"""Спринт 9: признак «удаление зависло» в read-модели (docs/sprint9/INTERNAL_API.md §1.5, ADR-009).

admin_user_summary += deletion_stuck_at — проекция `user.deletion.stuck.v1` от identity-consent (запрос удаления
открыт дольше DELETION_STUCK_HOURS). При DELETED поле стирается (CHECK, как username/имя). Таблица — read-модель,
колонка без значения по умолчанию: ADD COLUMN без перезаписи таблицы.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-16
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TABLE = "admin_user_summary"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("deletion_stuck_at", sa.DateTime(timezone=True)))
    op.create_check_constraint("ck_summary_deleted_stuck", TABLE, "status <> 'DELETED' OR deletion_stuck_at IS NULL")


def downgrade() -> None:
    op.drop_constraint("ck_summary_deleted_stuck", TABLE, type_="check")
    op.drop_column(TABLE, "deletion_stuck_at")
