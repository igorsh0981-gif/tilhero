"""Ревью P6/P7: модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL."""

from __future__ import annotations

import random

import httpx
import pytest
from conftest import SERVICE_DIR, make_settings
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, messaging_metadata
from tilhero_common.testing import ddl_allowed_for, internal_headers, migrated_under_roles, schema_drift
from tilhero_identity.main import build_app
from tilhero_identity.models import Base


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(
        SERVICE_DIR, lambda db_schema, **kw: make_settings(db_schema, **kw), "id_roles"
    ) as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("consents", "users", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://id") as c:
                login = await c.post(
                    "/internal/v1/users/telegram-login",
                    json={"telegram_user_id": random.randint(10**8, 10**10), "first_name": "Тест"},
                    headers=internal_headers(settings),
                )
                assert login.status_code == 200, login.text
                uid = login.json()["user"]["user_id"]
                h = internal_headers(settings, subject=uid)
                consent = await c.post(
                    "/internal/v1/me/consent",
                    json={"policy_version": "1.0", "purposes": ["personalization"], "age_confirmed_18_plus": True},
                    headers=h,
                )
                assert consent.status_code == 200, consent.text
                assert (await c.put("/internal/v1/me/pin", json={"pin": "2580"}, headers=h)).status_code == 200
            assert runtime.relay is not None
            while await runtime.relay.flush_once():  # SELECT … FOR UPDATE + UPDATE outbox под ролью сервиса
                pass
            assert bus.of_type("consent.accepted.v1")
            # согласие неизменяемо: у роли сервиса есть UPDATE, но триггер (который она не может снять) запрещает
            with pytest.raises(Exception, match="consents"):
                async with runtime.transaction() as s:
                    await s.execute(text("UPDATE consents SET purposes = '[]'::jsonb"))
