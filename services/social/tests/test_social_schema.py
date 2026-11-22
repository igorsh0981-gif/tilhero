"""Модели = миграции (schema_drift); миграции под ролью-владельцем, сервис — под своей ролью без DDL; откат/подъём."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import httpx
from conftest import SERVICE_DIR, IdentityStub, make_settings

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import ddl_allowed_for, internal_headers, migrated_under_roles, schema_drift
from tilhero_social.main import build_app
from tilhero_social.models import Base

TABLES = ("invites", "invite_redemptions", "families", "family_members", "friendships", "profiles", "deleted_users",
          "outbox", "member_ids", "community_profiles", "friend_requests", "blocks", "cases", "sanctions", "appeals",
          "referral_campaigns", "referrals", "referral_lessons", "learner_activity", "learner_idempotency",
          "nickname_stoplist", "counters")


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "soc_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        identity = IdentityStub()
        app = build_app(settings, runtime, identity_transport=httpx.MockTransport(identity.handler))
        owner, guest = identity.add("Мама"), identity.add("Папа")
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://social") as c:
                r = await c.post("/internal/v1/me/invites", json={"kind": "family"},
                                 headers={**internal_headers(settings, subject=str(owner)),
                                          "Idempotency-Key": str(uuid.uuid4())})
                assert r.status_code == 201, r.text
                token = r.json()["link"].split("inv_")[1]
                gh = internal_headers(settings, subject=str(guest))
                assert (await c.post("/internal/v1/invites:open", json={"token": token}, headers=gh)).status_code == 200
                acc = await c.post(f"/internal/v1/invites/{r.json()['invite_id']}/accept", headers=gh)
                assert acc.status_code == 200, acc.text
                tick = await c.post("/internal/v1/invites:tick",
                                    headers={"authorization": f"Bearer {settings.scheduler_token.get_secret_value()}"})
                assert tick.status_code == 200
                for user in (owner, guest):
                    await bus.publish(make_envelope(
                        "user.deletion.requested.v1",
                        {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-18T10:00:00Z"},
                        producer="identity-consent"))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
            assert [e.payload["domain"] for e in bus.of_type("user.domain.deleted.v1")] == ["social", "social"]
            assert bus.dlq == []


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "soc_rb") as (settings, _roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")
