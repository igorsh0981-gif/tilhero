"""Окружение тестов identity-consent.

Временная схема в tilhero_test + миграции Alembic, Redis db 15, InMemoryBus.

PII в тестах только синтетическая/маскированная (Telegram ID — случайные, имена — «Тест»).
"""

from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, InMemoryBus, outbox_table
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_identity.main import build_app
from tilhero_identity.models import User
from tilhero_identity.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SECRET = "identity-consent-test-secret-" + "x" * 24
VALID_PIN = "2580"
VALID_PIN6 = "402913"


def make_settings(schema: str, **kw: Any) -> Settings:
    base: dict[str, Any] = {
        "env": "test",
        "database_url": TEST_ADMIN_URL,
        "db_schema": schema,
        "redis_url": TEST_REDIS_URL,
        "internal_jwt_secret": SECRET,
        "log_level": "INFO",
        # таймер саги выключен: тесты вызывают deletion.sweeper.sweep_once с явным временем
        "deletion_sweep_seconds": 0,
    }
    base.update(kw)
    return Settings(**base)


@dataclass
class FakeNotifications:
    """notifications POST /internal/v1/notifications/transactional (httpx.MockTransport).
    responses — очередь: int (HTTP-статус ошибки), dict (тело 200) или Exception; по умолчанию «sent»."""

    calls: list[dict[str, Any]] = field(default_factory=list)
    headers: list[dict[str, str]] = field(default_factory=list)
    responses: list[Any] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/notifications/transactional"
        body = json.loads(request.content)
        self.calls.append(body)
        self.headers.append(dict(request.headers))
        item = self.responses.pop(0) if self.responses else None
        if isinstance(item, Exception):
            raise item
        if isinstance(item, int):
            return httpx.Response(item, json={"code": "X", "message": "x", "trace_id": "t", "details": {}})
        return httpx.Response(200, json=item or {"notification_id": body["notification_id"], "status": "sent"})

    def codes(self, user_id: str) -> list[str]:
        return [c["params"]["code"] for c in self.calls if c["user_id"] == user_id]


@dataclass
class FakeAudit:
    """audit POST /internal/v1/records (httpx.MockTransport). responses — очередь: int (HTTP-статус ошибки) или
    Exception; по умолчанию — 201 с эхо записи."""

    calls: list[dict[str, Any]] = field(default_factory=list)
    issuers: list[str] = field(default_factory=list)
    responses: list[Any] = field(default_factory=list)
    # детерминированные гонки: ответ audit задерживается, пока не придут `gate` вызовов (все команды — в одной фазе)
    gate: int = 0
    _arrived: int = 0
    _open: asyncio.Event = field(default_factory=asyncio.Event)

    async def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/records"
        if self.gate:
            self._arrived += 1
            if self._arrived >= self.gate:
                self._open.set()
            await asyncio.wait_for(self._open.wait(), timeout=10)
        import jwt

        self.issuers.append(jwt.decode(request.headers["x-internal-token"], options={"verify_signature": False})["iss"])
        body = json.loads(request.content)
        item = self.responses.pop(0) if self.responses else None
        if isinstance(item, Exception):
            raise item
        if isinstance(item, int):
            return httpx.Response(item, json={"code": "X", "message": "x", "trace_id": "t", "details": {}})
        self.calls.append(body)
        return httpx.Response(201, json={**body, "seq": len(self.calls)})


@dataclass
class Env:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    bus: InMemoryBus
    schema: str
    notifications: FakeNotifications
    audit: FakeAudit = field(default_factory=FakeAudit)

    # ---------- заголовки ----------
    def h(self, user_id: str | None = None, *, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=user_id)

    @property
    def redis(self):
        return self.runtime.redis

    # ---------- вызовы ----------
    async def login(self, telegram_user_id: int | None = None, **kw: Any) -> dict[str, Any]:
        body = {
            "telegram_user_id": telegram_user_id or random.randint(10**8, 10**10),
            "first_name": "Тест",
            "username": "demo_user",
            "language_code": "ru",
        }
        body.update(kw)
        r = await self.client.post("/internal/v1/users/telegram-login", json=body, headers=self.h())
        assert r.status_code == 200, r.text
        return r.json()

    async def new_user(self, **kw: Any) -> str:
        return (await self.login(**kw))["user"]["user_id"]

    async def call(
        self, method: str, path: str, user_id: str | None, json: Any = None, issuer: str = "telegram-bff"
    ) -> httpx.Response:
        return await self.client.request(method, path, json=json, headers=self.h(user_id, issuer=issuer))

    async def set_pin(self, user_id: str, pin: str = VALID_PIN) -> None:
        r = await self.call("PUT", "/internal/v1/me/pin", user_id, {"pin": pin})
        assert r.status_code == 200, r.text

    async def consent(self, user_id: str, purposes: list[str] | None = None) -> httpx.Response:
        return await self.call(
            "POST",
            "/internal/v1/me/consent",
            user_id,
            {
                "policy_version": self.settings.current_policy_version,
                "purposes": purposes if purposes is not None else ["personalization", "notifications"],
                "age_confirmed_18_plus": True,
            },
        )

    # ---------- события ----------
    async def flush(self) -> None:
        """Дожидается публикации всего outbox в шину (relay работает и в фоне — SKIP LOCKED безопасен)."""
        assert self.runtime.relay is not None
        for _ in range(100):
            await self.runtime.relay.flush_once()
            async with self.runtime.transaction() as s:
                pending = (
                    await s.execute(
                        select(func.count())
                        .select_from(outbox_table)
                        .where(outbox_table.c.published_at.is_(None))
                    )
                ).scalar_one()
            if not pending:
                return
            await asyncio.sleep(0.02)
        raise AssertionError("outbox was not drained")

    async def events(self, event_type: str, user_id: str | None = None) -> list[Envelope]:
        await self.flush()
        found = [
            e for e in self.bus.of_type(event_type) if user_id is None or e.payload.get("user_id") == user_id
        ]
        for e in found:
            assert_event_conforms(e)
        return found

    async def security_changes(self, user_id: str) -> list[str]:
        return [e.payload["change"] for e in await self.events("user.security.changed.v1", user_id)]

    async def outbox_dump(self) -> str:
        async with self.runtime.transaction() as s:
            rows = (await s.execute(select(outbox_table.c.envelope))).scalars().all()
        return repr(rows)


@pytest.fixture
async def env():
    schema = unique_schema("identity")
    await create_schema(schema)
    settings = make_settings(schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    notifications = FakeNotifications()
    audit = FakeAudit()
    app = build_app(settings, runtime, notifications_transport=httpx.MockTransport(notifications.handler),
                    audit_transport=httpx.MockTransport(audit.handler))
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://identity-consent")
        environment = Env(
            settings=settings, client=client, runtime=runtime, bus=bus, schema=schema, notifications=notifications,
            audit=audit,
        )
        yield environment
        await client.aclose()
        # Контракт: каждое событие, опубликованное сервисом за тест, соответствует схеме из packages/contracts
        # (события «других доменов», которые тесты подают в шину, в т.ч. намеренно битые, не проверяем).
        await environment.flush()
        for envelope in bus.published:
            if envelope.producer == settings.service_name:
                assert_event_conforms(envelope)
        # Уборка Redis db 15: ключи попыток и кодов пользователей этого теста.
        async with runtime.transaction() as s:
            user_ids = (await s.execute(select(User.user_id))).scalars().all()
        keys = [
            k
            for uid in user_ids
            for k in (
                f"pin:fail:{uid}",
                f"pin:lock:{uid}",
                f"pin_reset:code:{uid}",
                f"pin_reset:cooldown:{uid}",
                f"pin_reset:daily:{uid}",
            )
        ]
        if keys:
            await runtime.redis.delete(*keys)
    await drop_schema(schema)
