"""Ревью P6/P7: модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL."""

from __future__ import annotations

import uuid

import httpx
from support_testkit import CONTEXT, OPERATOR, SERVICE_DIR

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import ddl_allowed_for, internal_headers, migrated_under_roles, schema_drift
from tilhero_support.main import build_app
from tilhero_support.models import Base
from tilhero_support.settings import Settings


async def test_models_match_migrations_and_runtime_role() -> None:
    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "sup_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("tickets", "messages", "deleted_users", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        user = uuid.uuid4()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sup") as c:
                created = await c.post(
                    "/internal/v1/me/tickets",
                    json={"category": "OTHER", "subject": "Тема", "message": "Текст", "context": CONTEXT},
                    headers={**internal_headers(settings, subject=str(user)), "Idempotency-Key": uuid.uuid4().hex},
                )
                assert created.status_code == 201, created.text  # nextval(ticket_number_seq) под ролью сервиса
                reply = await c.post(
                    f"/admin/v1/support/tickets/{created.json()['ticket_id']}/messages",
                    json={"text": "Ответ", "visibility": "public"},
                    headers=internal_headers(settings, issuer="admin-bff", actor=OPERATOR),
                )
                assert reply.status_code == 200, reply.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-10-08T10:00:00Z"},
                    producer="identity-consent",
                ))
                gone = await c.get("/internal/v1/me/tickets", headers=internal_headers(settings, subject=str(user)))
                assert gone.status_code == 410
            assert runtime.relay is not None
            await runtime.relay.drain()
            assert bus.of_type("user.domain.deleted.v1")
