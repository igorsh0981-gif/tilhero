"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL; сквозной прогон под ролями."""

from __future__ import annotations

import uuid

import httpx
from notif_testkit import SERVICE_DIR, FakeGateway, FakeIdentity, at, local_day

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import (
    TEST_REDIS_URL,
    ddl_allowed_for,
    internal_headers,
    migrated_under_roles,
    schema_drift,
)
from tilhero_notifications.main import build_app
from tilhero_notifications.models import Base
from tilhero_notifications.settings import Settings

TABLES = ("notifications", "deleted_users", "missed_state", "family_owners", "broadcasts", "inbox_state", "outbox")


async def test_models_match_migrations_and_runtime_role() -> None:
    prefix = "t_notif_roles_" + uuid.uuid4().hex[:8]

    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, redis_url=TEST_REDIS_URL, redis_key_prefix=prefix,
                        dispatcher_enabled=False, identity_consent_url="http://identity.test",
                        bot_gateway_url="http://botgw.test", **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "ntf_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        identity, gateway, bus = FakeIdentity(), FakeGateway(), InMemoryBus()
        user = uuid.uuid4()
        identity.delivery[str(user)] = {
            "recipient_telegram_user_id": 918273645, "locale": "ru", "notifications_enabled": True,
            "categories": ["support", "reminders"], "quiet_hours": None, "timezone": "Asia/Tashkent",
            "status": "ACTIVE",
        }
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime, identity_transport=httpx.MockTransport(identity.handler),
                        botgw_transport=httpx.MockTransport(gateway.handler))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ntf") as c:
                r = await c.post(
                    "/internal/v1/notifications/transactional",
                    json={"notification_id": str(uuid.uuid4()), "user_id": str(user), "template": "pin.reset_code",
                          "params": {"code": "123456"}, "dedup_key": "pin:roles"},
                    headers=internal_headers(settings, issuer="identity-consent"),
                )
                assert r.status_code == 200 and r.json()["status"] == "sent", r.text
                day = local_day(1)
                await bus.publish(make_envelope(
                    "learning.reminder.due.v1",
                    {"user_id": str(user), "local_date": day.isoformat(), "slot_time": "10:00",
                     "timezone": "Asia/Tashkent", "duration_min": 20},
                    producer="learning-plan",
                ))
                assert sum((await app.state.dispatcher.run_once(at(day, "10:00"))).values()) == 1
                inbox = await c.get("/internal/v1/me/inbox", headers=internal_headers(settings, subject=str(user)))
                assert [i["category"] for i in inbox.json()["items"]] == ["reminders"]
                read = await c.post("/internal/v1/me/inbox:read", json={"all": True},
                                    headers=internal_headers(settings, subject=str(user)))
                assert read.json() == {"unread": 0}
            await bus.publish(make_envelope(
                "user.deletion.requested.v1",
                {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-18T10:00:00Z"},
                producer="identity-consent",
            ))
            assert runtime.relay is not None
            await runtime.relay.drain()
            assert len(gateway.calls) == 2 and bus.of_type("user.domain.deleted.v1")
            assert runtime.redis is not None
            keys = [k async for k in runtime.redis.scan_iter(match=f"{prefix}:*")]
            if keys:
                await runtime.redis.delete(*keys)
