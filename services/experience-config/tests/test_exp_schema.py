"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL (как infra/db/bootstrap.sql)."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import httpx
import pytest
from conftest import SERVICE_DIR
from exp_actors import EDITOR, PUBLISHER, WN_PUBLISHER
from sqlalchemy import text
from test_exp_validation import DARK_TOKENS

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
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

TABLES = ("config_versions", "activations", "release_notes", "release_note_views", "deleted_users", "outbox", "inbox")


async def test_models_match_migrations_and_runtime_role() -> None:
    namespace = f"t:expcfg:{uuid.uuid4().hex[:10]}"

    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, redis_url=TEST_REDIS_URL,
                        cache_namespace=namespace, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "exp_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        staff = internal_headers(settings, issuer="admin-bff", actor=PUBLISHER)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://exp") as c:
                cur = await c.get("/internal/v1/experience/miniapp/current",
                                  headers=internal_headers(settings, issuer="telegram-bff"))
                assert cur.status_code == 200 and cur.json()["version"] == "1.0.0"
                payload = (await c.get("/admin/v1/experience/miniapp/versions/1.0.0", headers=staff)).json()["payload"]
                payload["theme"] = {"id": "notebook_dark", "version": "1.0.1",
                                    "tokens": {**payload["theme"]["tokens"], **DARK_TOKENS}}
                created = await c.post("/admin/v1/experience/miniapp/versions",
                                       json={"version": "1.0.1", "payload": payload, "change_note": "Тёмная"},
                                       headers=internal_headers(settings, issuer="admin-bff", actor=EDITOR))
                assert created.status_code == 201, created.text
                act = await c.post("/admin/v1/experience/miniapp/activate",
                                   json={"version": "1.0.1", "reason": "Проверка ролей"}, headers=staff)
                assert act.status_code == 201, act.text
                rb = await c.post("/admin/v1/experience/miniapp/rollback", json={"reason": "Проверка ролей"},
                                  headers=staff)
                assert rb.status_code == 201, rb.text
                # ученик: знакомство, отметка просмотра, удаление — DML роли сервиса хватает
                learner = uuid.uuid4()
                lh = internal_headers(settings, issuer="telegram-bff", subject=str(learner))
                wn = await c.get("/internal/v1/release-notes/for-me",
                                 params={"onboarded_at": "2026-11-17T09:00:00Z", "lang": "uz", "age": "kids"},
                                 headers=lh)
                assert wn.status_code == 200 and wn.json()["mode"] == "welcome", wn.text
                note_id = wn.json()["notes"][0]["release_note_id"]
                seen = await c.post("/internal/v1/release-notes/seen", json={"release_note_ids": [note_id]},
                                    params={"lang": "uz", "age": "kids"}, headers=lh)
                assert seen.status_code == 204
                # статистика и сводка — чтение под ролью сервиса
                wh = internal_headers(settings, issuer="admin-bff", actor=WN_PUBLISHER)
                st = await c.get(f"/admin/v1/release-notes/{note_id}/stats", headers=wh)
                assert st.status_code == 200 and st.json()["views_by_age"]["kids"] == 1, st.text
                sm = await c.get("/admin/v1/release-notes/summary", headers=wh)
                assert sm.status_code == 200 and sm.json()["latest"]["views_total"] == 1, sm.text
                await bus.publish(make_envelope("user.deletion.requested.v1",
                                                {"user_id": str(learner), "request_id": str(uuid.uuid4()),
                                                 "requested_at": "2026-11-18T09:00:00Z"},
                                                producer="identity-consent"))
                assert bus.dlq == []
            # журнал активаций неизменяем и для роли сервиса (триггер, снять который она не может)
            with pytest.raises(Exception, match="append-only"):
                async with runtime.transaction() as s:
                    await s.execute(text("DELETE FROM activations"))
            # опубликованную заметку (welcome-1) роль сервиса не изменит, не удалит и не очистит таблицу
            for stmt in ("UPDATE release_notes SET audience = 'all' WHERE status = 'published'",
                         "DELETE FROM release_notes", "TRUNCATE release_notes"):
                with pytest.raises(Exception, match=r"release note|append-only|permission denied"):
                    async with runtime.transaction() as s:
                        await s.execute(text(stmt))
            async with runtime.transaction() as s:
                assert (await s.execute(text("SELECT count(*) FROM release_note_views"))).scalar() == 0
                assert (await s.execute(text("SELECT count(*) FROM deleted_users"))).scalar() == 1
            # откат миграций под владельцем с опубликованной заметкой и повторный подъём (ON CONFLICT в 0004)
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
