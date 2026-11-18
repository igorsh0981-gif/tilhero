from __future__ import annotations

import uuid

import httpx
import pytest
from aid_testkit import SERVICE_DIR, Env, Person, make_settings

from tilhero_admin_identity.main import build_app
from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    create_schema,
    drop_schema,
    migrate,
    unique_schema,
)


async def _cleanup_redis(runtime: Runtime, ns: str) -> None:
    assert runtime.redis is not None
    for pattern in (f"{ns}*", f"idem:{ns}*"):
        keys = [k async for k in runtime.redis.scan_iter(match=pattern)]
        if keys:
            await runtime.redis.delete(*keys)


@pytest.fixture
async def env_factory():
    """Фабрика окружений над одной схемой (повторный старт сервиса — проверка идемпотентности bootstrap)."""
    schema = unique_schema("adminid")
    await create_schema(schema)
    ns = f"t:adminid:{uuid.uuid4().hex[:10]}"
    opened: list[tuple[object, httpx.AsyncClient, Runtime]] = []
    migrated = False

    async def start(**overrides) -> Env:
        nonlocal migrated
        settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, redis_url=TEST_REDIS_URL,
                                 redis_namespace=ns, **overrides)
        if not migrated:
            await migrate(SERVICE_DIR, settings)
            migrated = True
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        ctx = app.router.lifespan_context(app)
        await ctx.__aenter__()
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://admin-identity")
        opened.append((ctx, client, runtime))
        e = Env(settings, client, runtime, bus, app)
        await e.flush()
        return e

    yield start
    for ctx, client, runtime in reversed(opened):
        await client.aclose()
        await _cleanup_redis(runtime, ns)
        await ctx.__aexit__(None, None, None)  # type: ignore[attr-defined]
    await drop_schema(schema)


@pytest.fixture
async def env(env_factory) -> Env:
    return await env_factory()


@pytest.fixture
async def root(env: Env) -> Person:
    """Первый super_admin (bootstrap) после первого входа: пароль сменён, MFA подключена."""
    from aid_testkit import ROOT_EMAIL, ROOT_PASSWORD

    return await env.first_login(ROOT_EMAIL, ROOT_PASSWORD)


@pytest.fixture
async def root2(env: Env, root: Person) -> Person:
    """Второй super_admin (создан, пока root единственный, — four-eyes waived)."""
    from aid_testkit import new_email

    return await env.onboard(root.actor, new_email("root2"), "super_admin", "Second Admin")
