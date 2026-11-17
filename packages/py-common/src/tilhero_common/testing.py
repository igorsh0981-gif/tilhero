"""Помощники для тестов сервисов: временная схема в tilhero_test, внутренние заголовки, шина в памяти.

Стенд: `infra/dev/stack.sh up`. Переменные (значения по умолчанию — локальный стенд):
  TEST_DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/tilhero_test
  TEST_REDIS_URL=redis://127.0.0.1:6379/15
  TEST_NATS_URL=nats://127.0.0.1:4222
"""

from __future__ import annotations

import os
import secrets
import uuid
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import asyncpg
from sqlalchemy import MetaData
from sqlalchemy.engine import make_url

from tilhero_common.db import make_engine, validate_schema
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.settings import ServiceSettings

TEST_ADMIN_URL = os.getenv("TEST_DATABASE_ADMIN_URL", "postgresql://postgres@127.0.0.1:5432/tilhero_test")
TEST_REDIS_URL = os.getenv("TEST_REDIS_URL", "redis://127.0.0.1:6379/15")
TEST_NATS_URL = os.getenv("TEST_NATS_URL", "nats://127.0.0.1:4222")


def unique_schema(prefix: str) -> str:
    return validate_schema(f"t_{prefix}_{uuid.uuid4().hex[:8]}")


async def create_schema(schema: str, admin_url: str = TEST_ADMIN_URL) -> None:
    conn = await asyncpg.connect(admin_url)
    try:
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{validate_schema(schema)}"')
    finally:
        await conn.close()


async def drop_schema(schema: str, admin_url: str = TEST_ADMIN_URL) -> None:
    conn = await asyncpg.connect(admin_url)
    try:
        await conn.execute(f'DROP SCHEMA IF EXISTS "{validate_schema(schema)}" CASCADE')
    finally:
        await conn.close()


async def create_tables(schema: str, metadatas: Iterable[MetaData], admin_url: str = TEST_ADMIN_URL) -> None:
    engine = make_engine(admin_url, schema, pool_size=1)
    async with engine.begin() as conn:
        for md in metadatas:
            await conn.run_sync(md.create_all)
    await engine.dispose()


def internal_headers(
    settings: ServiceSettings,
    *,
    issuer: str = "telegram-bff",
    subject: str | None = None,
    actor: Actor | None = None,
    audience: str | None = None,
) -> dict[str, str]:
    # dev/test: ключ издателя выводится из секрета (как у реальных сервисов на стенде)
    token = issue_token(
        settings.internal_jwt_secret.get_secret_value(),
        issuer=issuer,
        audience=audience or settings.service_name,
        subject=subject,
        actor=actor,
    )
    return {HEADER: token}


async def migrate(service_dir: str, settings: ServiceSettings, revision: str = "head") -> None:
    """Прогоняет Alembic-миграции сервиса в схему settings.db_schema (тестирует и сами миграции)."""
    import asyncio
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(service_dir) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(service_dir) / "migrations"))
    cfg.attributes["settings"] = settings
    await asyncio.to_thread(command.upgrade, cfg, revision)


def _contracts_dir():
    from pathlib import Path

    return Path(__file__).resolve().parents[4] / "packages" / "contracts" / "events"


def assert_event_conforms(envelope) -> None:
    """Проверяет конверт и payload по JSON Schema из packages/contracts/events (contract test)."""
    import json

    import jsonschema

    base = _contracts_dir()
    env_schema = json.loads((base / "envelope.schema.json").read_text())
    data = json.loads(envelope.to_json())
    jsonschema.validate(data, env_schema, format_checker=jsonschema.FormatChecker())
    path = base / f"{envelope.event_type}.schema.json"
    if not path.exists():
        raise AssertionError(f"no contract for {envelope.event_type}: add it to infra/scripts/gen_event_schemas.py")
    jsonschema.validate(data["payload"], json.loads(path.read_text()), format_checker=jsonschema.FormatChecker())


# ---------------------------------------------------------------- роли БД (как infra/db/bootstrap.sql)

@dataclass(frozen=True)
class ServiceRoles:
    """Временные роли для схемы теста: владелец (миграции) и роль сервиса (рантайм, только DML)."""

    schema: str
    owner: str
    runtime: str
    owner_url: str
    runtime_url: str


def _role_url(admin_url: str, role: str, password: str) -> str:
    return make_url(admin_url).set(username=role, password=password).render_as_string(hide_password=False)


def grants_sql(schema: str, owner: str, runtime: str) -> list[str]:
    """Схема ролей сервиса (зеркало infra/db/bootstrap.sql): схема и таблицы принадлежат владельцу,
    роль сервиса получает USAGE и DML на таблицы, создаваемые владельцем (DEFAULT PRIVILEGES)."""
    s, o, r = (validate_schema(x) for x in (schema, owner, runtime))
    return [
        f'CREATE SCHEMA IF NOT EXISTS "{s}" AUTHORIZATION "{o}"',
        f'ALTER SCHEMA "{s}" OWNER TO "{o}"',
        f'GRANT USAGE ON SCHEMA "{s}" TO "{r}"',
        f'ALTER DEFAULT PRIVILEGES FOR ROLE "{o}" IN SCHEMA "{s}" '
        f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{r}"',
        f'ALTER DEFAULT PRIVILEGES FOR ROLE "{o}" IN SCHEMA "{s}" GRANT USAGE, SELECT ON SEQUENCES TO "{r}"',
    ]


async def create_service_roles(schema: str, admin_url: str = TEST_ADMIN_URL) -> ServiceRoles:
    owner, runtime = f"{schema}_owner", f"{schema}_rt"
    password = secrets.token_urlsafe(16)
    conn = await asyncpg.connect(admin_url)
    try:
        for role in (owner, runtime):
            await conn.execute(f'CREATE ROLE "{validate_schema(role)}" LOGIN PASSWORD \'{password}\'')
        for stmt in grants_sql(schema, owner, runtime):
            await conn.execute(stmt)
    finally:
        await conn.close()
    return ServiceRoles(schema, owner, runtime, _role_url(admin_url, owner, password),
                        _role_url(admin_url, runtime, password))


async def drop_service_roles(roles: ServiceRoles, admin_url: str = TEST_ADMIN_URL) -> None:
    conn = await asyncpg.connect(admin_url)
    try:
        await conn.execute(f'DROP SCHEMA IF EXISTS "{validate_schema(roles.schema)}" CASCADE')
        for role in (roles.runtime, roles.owner):
            await conn.execute(f'DROP OWNED BY "{validate_schema(role)}"')
            await conn.execute(f'DROP ROLE IF EXISTS "{validate_schema(role)}"')
    finally:
        await conn.close()


@asynccontextmanager
async def migrated_under_roles(
    service_dir: str, make_settings: Callable[..., ServiceSettings], prefix: str
) -> AsyncIterator[tuple[ServiceSettings, ServiceRoles]]:
    """Схема с ролями как в prod: миграции под владельцем (MIGRATION_DATABASE_URL), настройки рантайма —
    под ролью сервиса (DATABASE_URL). make_settings(database_url=…, migration_database_url=…, db_schema=…)."""
    schema = unique_schema(prefix)
    roles = await create_service_roles(schema)
    try:
        settings = make_settings(
            database_url=roles.runtime_url, migration_database_url=roles.owner_url, db_schema=schema
        )
        await migrate(service_dir, settings)
        yield settings, roles
    finally:
        await drop_service_roles(roles)


async def ddl_allowed_for(url: str, schema: str, table: str) -> list[str]:
    """DDL, которые роль смогла выполнить в схеме сервиса (каждая проба — в откатываемой транзакции).
    Для роли сервиса ожидается пустой список: менять структуру и снимать триггеры может только владелец."""
    probes = [
        f'CREATE TABLE "{schema}".ddl_probe (id int)',
        f'ALTER TABLE "{schema}"."{table}" ADD COLUMN ddl_probe int',
        f'ALTER TABLE "{schema}"."{table}" DISABLE TRIGGER ALL',
        f'DROP TABLE "{schema}"."{table}"',
        f'TRUNCATE "{schema}"."{table}"',
    ]
    allowed: list[str] = []
    conn = await asyncpg.connect(make_url(url).set(drivername="postgresql").render_as_string(hide_password=False))
    try:
        for stmt in probes:
            tr = conn.transaction()
            await tr.start()
            try:
                await conn.execute(stmt)
                allowed.append(stmt)
            except asyncpg.PostgresError:
                pass
            finally:
                await tr.rollback()
    finally:
        await conn.close()
    return allowed


# ---------------------------------------------------------------- сверка моделей и миграций

async def schema_drift(
    url: str, schema: str, metadatas: MetaData | Sequence[MetaData]
) -> list[Any]:
    """Расхождения моделей SQLAlchemy со схемой БД после миграций: diff Alembic autogenerate
    (таблицы, колонки, типы, nullable, индексы, UNIQUE, FK) + имена CHECK-ограничений (Alembic их не сравнивает).
    Пустой список — модели соответствуют миграциям."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import inspect

    mds = [metadatas] if isinstance(metadatas, MetaData) else list(metadatas)
    engine = make_engine(url, schema, pool_size=1)

    def _compare(sync_conn: Any) -> list[Any]:
        ctx = MigrationContext.configure(
            sync_conn,
            opts={
                "compare_type": True,
                "target_metadata": mds,
                "include_object": lambda obj, name, type_, reflected, compare_to: not (
                    type_ == "table" and name == "alembic_version"
                ),
            },
        )
        diff: list[Any] = list(compare_metadata(ctx, mds))  # type: ignore[arg-type]
        insp = inspect(sync_conn)
        for md in mds:
            for table in md.tables.values():
                if not insp.has_table(table.name):
                    continue
                expected = {
                    c.name for c in table.constraints
                    if c.__class__.__name__ == "CheckConstraint" and isinstance(c.name, str)
                }
                actual = {c["name"] for c in insp.get_check_constraints(table.name)}
                for name in sorted(expected - actual):
                    diff.append(("missing_check_in_db", table.name, name))
                for name in sorted(actual - expected):
                    diff.append(("missing_check_in_model", table.name, name))
        return diff

    try:
        async with engine.connect() as conn:
            return await conn.run_sync(_compare)
    finally:
        await engine.dispose()
