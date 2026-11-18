"""Спринт 7: уровень доступа к AI в read-модели (docs/sprint7/INTERNAL_API.md §2.7, §4).

admin_user_summary += access_level, access_level_source, access_level_expires_at — проекция
`user.access_level.changed.v1` от ai-control; access_level_version — версия назначения в ai-control (монотонна на
пользователя): событие со старой версией состояние не меняет. Нет данных (событий не было) — уровень по умолчанию.
DELETED — поля очищаются (CHECK, как для username/имени). Индекс — для фильтра списка по ручным назначениям.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
TABLE = "admin_user_summary"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("access_level", sa.String(32)))
    op.add_column(TABLE, sa.Column("access_level_source", sa.String(16)))
    op.add_column(TABLE, sa.Column("access_level_expires_at", TS))
    op.add_column(TABLE, sa.Column("access_level_version", sa.Integer()))
    op.create_check_constraint(
        "ck_summary_access_level_source", TABLE,
        "access_level_source IS NULL OR access_level_source IN ('default','manual')")
    op.create_check_constraint(
        "ck_summary_access_level_code", TABLE,
        "access_level IS NULL OR access_level ~ '^[a-z][a-z0-9_]{1,31}$'")
    # ручное назначение — всегда с уровнем; срок есть только у ручного назначения
    op.create_check_constraint(
        "ck_summary_access_level_manual", TABLE,
        "(access_level_source IS DISTINCT FROM 'manual' OR access_level IS NOT NULL) "
        "AND (access_level_expires_at IS NULL OR access_level_source = 'manual')")
    op.create_check_constraint(
        "ck_summary_access_level_version", TABLE,
        "(access_level_version IS NULL) = (access_level_source IS NULL) AND "
        "(access_level_version IS NULL OR access_level_version >= 1)")
    op.create_check_constraint(
        "ck_summary_deleted_access_level", TABLE,
        "status <> 'DELETED' OR (access_level IS NULL AND access_level_source IS NULL "
        "AND access_level_expires_at IS NULL)")
    op.create_index("ix_summary_access_level", TABLE, ["access_level"],
                    postgresql_where=sa.text("access_level_source = 'manual'"))


def downgrade() -> None:
    op.drop_index("ix_summary_access_level", table_name=TABLE)
    for name in ("ck_summary_deleted_access_level", "ck_summary_access_level_version",
                 "ck_summary_access_level_manual", "ck_summary_access_level_code", "ck_summary_access_level_source"):
        op.drop_constraint(name, TABLE, type_="check")
    for col in ("access_level_version", "access_level_expires_at", "access_level_source", "access_level"):
        op.drop_column(TABLE, col)
