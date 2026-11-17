"""Индекс users(updated_at, user_id) для курсорной сверки read-модели user-admin (спринт 2)

Поле updated_at есть с 0001; с этой версии его двигает любое изменение пользователя, включая PIN, биометрию
и согласие (IdentityService._emit).

Таблица users рабочая: индекс строится CONCURRENTLY (без блокировки записи) вне транзакции миграции
(autocommit_block). Повторный запуск безопасен: IF NOT EXISTS; невалидный остаток прерванной сборки
(CONCURRENTLY при сбое оставляет индекс с indisvalid=false) сначала удаляется.
search_path задаётся на уровне сессии (tilhero_common.db.make_engine) и переживает фиксацию autocommit-блока.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

INDEX = "ix_users_updated_at"


def _index_valid() -> bool | None:
    """None — индекса нет; True/False — есть и валиден/невалиден (в схеме из search_path)."""
    return op.get_bind().execute(
        sa.text(
            "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
            "WHERE c.relname = :name AND c.relnamespace = current_schema()::regnamespace"
        ),
        {"name": INDEX},
    ).scalar()


def upgrade() -> None:
    valid = _index_valid()
    with op.get_context().autocommit_block():
        if valid is False:
            op.drop_index(INDEX, table_name="users", postgresql_concurrently=True, if_exists=True)
        op.create_index(INDEX, "users", ["updated_at", "user_id"], postgresql_concurrently=True, if_not_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(INDEX, table_name="users", postgresql_concurrently=True, if_exists=True)
