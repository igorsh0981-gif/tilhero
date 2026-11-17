"""Общий env.py для Alembic: миграции идут в схему сервиса (search_path), version-таблица — там же.

env.py сервиса:
    from alembic import context
    from tilhero_common.migrations import run_migrations
    from tilhero_common.messaging import messaging_metadata
    from my_service.models import Base
    from my_service.settings import get_settings
    run_migrations(context, [Base.metadata, messaging_metadata], get_settings())

Роли PostgreSQL (infra/db/bootstrap.sql): миграции идут под ролью-владельцем схемы `<svc>_owner`
(MIGRATION_DATABASE_URL), сервис работает под ролью `<svc>` (DATABASE_URL) только с DML-правами.
Если MIGRATION_DATABASE_URL не задан (dev без разделения ролей), используется DATABASE_URL.
"""

from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import MetaData

from tilhero_common.db import make_engine
from tilhero_common.settings import ServiceSettings, to_async_url


def migration_url(settings: ServiceSettings) -> str:
    url = settings.migration_database_url or settings.database_url
    if not url:
        raise RuntimeError("MIGRATION_DATABASE_URL or DATABASE_URL is required for migrations")
    return url


def run_migrations(alembic_context: Any, target_metadata: MetaData | list[MetaData], settings: ServiceSettings) -> None:
    url = migration_url(settings)
    schema = settings.db_schema

    if alembic_context.is_offline_mode():
        alembic_context.configure(
            url=to_async_url(url),
            target_metadata=target_metadata,
            literal_binds=True,
            version_table_schema=schema,
        )
        with alembic_context.begin_transaction():
            alembic_context.run_migrations()
        return

    def _do_run(connection: Any) -> None:
        alembic_context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table_schema=schema,
            compare_type=True,
        )
        with alembic_context.begin_transaction():
            alembic_context.run_migrations()

    async def _run() -> None:
        engine = make_engine(url, schema, pool_size=1, max_overflow=0)  # одно соединение (бюджет Postgres, Q10)
        async with engine.connect() as connection:
            await connection.run_sync(_do_run)
            await connection.commit()
        await engine.dispose()

    asyncio.run(_run())


def settings_from_context(alembic_context: Any, default: ServiceSettings) -> ServiceSettings:
    """Тесты передают настройки через Config.attributes["settings"], прод — через окружение."""
    return alembic_context.config.attributes.get("settings") or default


def create_messaging_tables(op: Any) -> None:
    """Таблицы outbox/inbox для первой миграции каждого сервиса."""
    import sqlalchemy as sa
    from sqlalchemy.dialects import postgresql as pg

    op.create_table(
        "outbox",
        sa.Column("id", pg.UUID(as_uuid=False), primary_key=True),
        sa.Column("event_type", sa.String(120), nullable=False),
        sa.Column("envelope", pg.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_error", sa.Text()),
    )
    op.create_index("ix_outbox_published_at", "outbox", ["published_at"])
    op.create_table(
        "inbox",
        sa.Column("event_id", pg.UUID(as_uuid=False), primary_key=True),
        sa.Column("consumer", sa.String(120), primary_key=True),
        sa.Column("event_type", sa.String(120), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def drop_messaging_tables(op: Any) -> None:
    op.drop_table("inbox")
    op.drop_table("outbox")
