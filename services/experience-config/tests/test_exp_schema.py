"""Ревью P6/P7: модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL."""

from __future__ import annotations

import uuid
from pathlib import Path

import httpx
import pytest
from conftest import SERVICE_DIR
from exp_actors import PUBLISHER
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, messaging_metadata
from tilhero_common.testing import (
    TEST_REDIS_URL,
    ddl_allowed_for,
    internal_headers,
    migrated_under_roles,
    schema_drift,
)
from tilhero_experience.main import build_app
from tilhero_experience.models import Base
from tilhero_experience.settings import Settings


async def test_models_match_migrations_and_runtime_role() -> None:
    namespace = f"t:expcfg:{uuid.uuid4().hex[:10]}"

    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, redis_url=TEST_REDIS_URL,
                        cache_namespace=namespace, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "exp_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("config_versions", "activations", "release_notes", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        runtime = Runtime(settings, bus=InMemoryBus())
        app = build_app(settings, runtime)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://exp") as c:
                cur = await c.get("/internal/v1/experience/miniapp/current",
                                  headers=internal_headers(settings, issuer="telegram-bff"))
                assert cur.status_code == 200 and cur.json()["version"] == "2.0.3"
                rb = await c.post("/admin/v1/experience/miniapp/rollback", json={"reason": "Проверка ролей"},
                                  headers=internal_headers(settings, issuer="admin-bff", actor=PUBLISHER))
                assert rb.status_code == 201, rb.text
            # журнал активаций неизменяем и для роли сервиса (триггер, снять который она не может)
            with pytest.raises(Exception, match="append-only"):
                async with runtime.transaction() as s:
                    await s.execute(text("DELETE FROM activations"))
            # 9.4 (ревью, roles_rollback.py): опубликованную заметку роль сервиса не удалит и не очистит таблицу
            async with runtime.transaction() as s:
                await s.execute(text("UPDATE release_notes SET status = 'published', published_at = now(), "
                                     "published_by = 'x', version = version + 1"))
            for stmt in ("DELETE FROM release_notes", "TRUNCATE release_notes"):
                with pytest.raises(Exception, match=r"release note|append-only|permission denied"):
                    async with runtime.transaction() as s:
                        await s.execute(text(stmt))
            # откат миграций под владельцем с опубликованной заметкой и повторный подъём (ON CONFLICT в 0004)
            import asyncio

            from alembic import command
            from alembic.config import Config

            cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
            cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
            cfg.attributes["settings"] = settings
            await asyncio.to_thread(command.downgrade, cfg, "0003")
            await asyncio.to_thread(command.upgrade, cfg, "head")
            await asyncio.to_thread(command.downgrade, cfg, "0002")
            await asyncio.to_thread(command.upgrade, cfg, "head")
            assert runtime.redis is not None
            keys = [k async for k in runtime.redis.scan_iter(match=f"{namespace}*")]
            if keys:
                await runtime.redis.delete(*keys)
