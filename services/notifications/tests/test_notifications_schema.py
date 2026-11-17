"""Ревью P6/P7: модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL."""

from __future__ import annotations

import uuid

import httpx
from notif_testkit import CRIT, CRIT_PARAMS, SERVICE_DIR, FakeGateway, FakeIdentity

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


async def test_models_match_migrations_and_runtime_role() -> None:
    prefix = "t_notif_roles_" + uuid.uuid4().hex[:8]

    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, redis_url=TEST_REDIS_URL, redis_key_prefix=prefix,
                        dispatcher_enabled=False, identity_consent_url="http://identity.test",
                        bot_gateway_url="http://botgw.test", **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "ntf_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("notifications", "deleted_users", "digest_queue", "ops_deliveries", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        identity, gateway, bus = FakeIdentity(), FakeGateway(), InMemoryBus()
        user = uuid.uuid4()
        identity.users[str(user)] = {"telegram_user_id": 918273645, "locale": "ru", "notifications_enabled": True,
                                     "quiet_hours": None, "timezone": None, "status": "ACTIVE"}
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
            await bus.publish(make_envelope(
                "notification.requested.v1",
                {"notification_id": str(uuid.uuid4()), "user_id": str(user), "kind": "critical", "template": CRIT,
                 "params": CRIT_PARAMS, "dedup_key": "crit:roles"},
                producer="watch",
            ))
            assert await app.state.dispatcher.run_once() == 1
            await bus.publish(make_envelope(
                "user.deletion.requested.v1",
                {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-10-08T10:00:00Z"},
                producer="identity-consent",
            ))
            assert runtime.relay is not None
            await runtime.relay.drain()
            assert len(gateway.calls) == 2 and bus.of_type("user.domain.deleted.v1")
            assert runtime.redis is not None
            keys = [k async for k in runtime.redis.scan_iter(match=f"{prefix}:*")]
            if keys:
                await runtime.redis.delete(*keys)
