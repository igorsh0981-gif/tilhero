"""Доступ к PostgreSQL: у каждого сервиса своя схема (search_path) и своя роль.

Таблицы в моделях объявляются без схемы — они попадают в схему сервиса через search_path.
Cross-service SQL невозможен на уровне прав: роль сервиса видит только свою схему.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from tilhero_common.settings import to_async_url

_SCHEMA_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def validate_schema(schema: str) -> str:
    if not _SCHEMA_RE.match(schema):
        raise ValueError(f"invalid schema name: {schema!r}")
    return schema


def make_engine(url: str, schema: str | None, pool_size: int = 10, max_overflow: int | None = None) -> AsyncEngine:
    """Пул: `pool_size` постоянных + `max_overflow` временных соединений (None — столько же, сколько постоянных)."""
    connect_args: dict = {}
    if schema:
        connect_args["server_settings"] = {"search_path": validate_schema(schema)}
    return create_async_engine(
        to_async_url(url),
        pool_pre_ping=True,
        pool_size=pool_size,
        max_overflow=pool_size if max_overflow is None else max_overflow,
        pool_recycle=280,
        hide_parameters=True,  # параметры SQL (PII) не попадают в тексты ошибок и логи
        connect_args=connect_args,
    )


class Database:
    def __init__(self, url: str, schema: str | None, pool_size: int = 10, max_overflow: int | None = None) -> None:
        self.schema = schema
        self.engine = make_engine(url, schema, pool_size, max_overflow)
        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        """Транзакция: commit при успехе, rollback при исключении."""
        async with self.sessionmaker() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    async def ping(self) -> None:
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()
