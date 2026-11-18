from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, verify_token
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_social.main import build_app
from tilhero_social.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SCHEDULER_TOKEN = "s" * 43
SECRET = "t" * 40
APP_LINK = "https://t.me/tilhero_test_bot/app"
_PUBLIC = re.compile(r"^/internal/v1/users/([0-9a-f-]{36})/public$")


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": SECRET, "scheduler_token": SCHEDULER_TOKEN,
                            "telegram_app_link": APP_LINK, "identity_consent_url": "http://identity-consent"}
    base.update(kw)
    return Settings(**base)


DEFAULT_PURPOSES = ("terms", "privacy", "learning", "social")


class IdentityStub:
    """identity-consent GET /internal/v1/users/{id}/public: проверяет внутренний JWT (iss=social,
    aud=identity-consent) и отдаёт {user_id, display_name, kind, age_band, status, consent_accepted, purposes}
    (INTERNAL_API §11, P-3); `legacy=True` — ответ старой версии без полей согласия. Неизвестный — 404."""

    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.calls: list[str] = []
        self.down = False

    def add(self, name: str = "Азиза", *, age: str | None = "18+", kind: str = "account",
            status: str = "ACTIVE", consent: bool = True, purposes: tuple[str, ...] = DEFAULT_PURPOSES,
            legacy: bool = False) -> uuid.UUID:
        user = uuid.uuid4()
        self.users[str(user)] = {"user_id": str(user), "display_name": name, "kind": kind, "age_band": age,
                                 "status": status}
        if not legacy:
            self.set_consent(user, consent, purposes)
        return user

    def set_consent(self, user: uuid.UUID, accepted: bool, purposes: tuple[str, ...] = DEFAULT_PURPOSES) -> None:
        self.users[str(user)].update({"consent_accepted": accepted, "purposes": list(purposes) if accepted else []})

    def handler(self, request: httpx.Request) -> httpx.Response:
        principal = verify_token(request.headers[HEADER], SECRET, audience="identity-consent",
                                 allowed_issuers={"social"})
        assert principal.subject is None  # имя запрашивается от имени сервиса, не пользователя
        m = _PUBLIC.match(request.url.path)
        assert m and request.method == "GET", request.url.path
        self.calls.append(m.group(1))
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "down", "details": {}})
        user = self.users.get(m.group(1))
        if user is None:
            return httpx.Response(404, json={"code": "USER_NOT_FOUND", "message": "нет", "details": {}})
        return httpx.Response(200, content=json.dumps(user).encode(), headers={"content-type": "application/json"})


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus,
                 app: Any, identity: IdentityStub) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.identity = identity
        self.now = datetime(2026, 11, 16, 8, 0, tzinfo=UTC)
        app.state.clock = lambda: self.now

    def h(self, user: uuid.UUID | str | None = None, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    @property
    def sched(self) -> dict[str, str]:
        return {"authorization": f"Bearer {SCHEDULER_TOKEN}"}

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str) -> list[Envelope]:
        await self.flush()
        found = self.bus.of_type(event_type)
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "social"
        return found

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def create(self, user: uuid.UUID, kind: str = "friend", key: str | None = None) -> httpx.Response:
        return await self.c.post("/internal/v1/me/invites", json={"kind": kind},
                                 headers={**self.h(user), "Idempotency-Key": key or str(uuid.uuid4())})

    async def invite(self, user: uuid.UUID, kind: str = "friend") -> tuple[str, str]:
        """→ (invite_id, token из ссылки startapp=inv_<token>)."""
        r = await self.create(user, kind)
        assert r.status_code == 201, r.text
        link = r.json()["link"]
        assert link.startswith(f"{APP_LINK}?startapp=inv_")
        return r.json()["invite_id"], link.split("startapp=inv_", 1)[1]

    async def open(self, user: uuid.UUID, token: str) -> httpx.Response:
        return await self.c.post("/internal/v1/invites:open", json={"token": token}, headers=self.h(user))

    async def accept(self, user: uuid.UUID, invite_id: str) -> httpx.Response:
        return await self.c.post(f"/internal/v1/invites/{invite_id}/accept", headers=self.h(user))

    async def decline(self, user: uuid.UUID, invite_id: str) -> httpx.Response:
        return await self.c.post(f"/internal/v1/invites/{invite_id}/decline", headers=self.h(user))

    async def tick(self) -> dict[str, int]:
        r = await self.c.post("/internal/v1/invites:tick", headers=self.sched)
        assert r.status_code == 200, r.text
        return r.json()

    async def profile_event(self, event_type: str, payload: dict[str, Any],
                            producer: str = "identity-consent") -> Envelope:
        ev = make_envelope(event_type, payload, producer=producer)
        assert_event_conforms(ev)
        await self.bus.publish(ev)
        await self.flush()
        return ev

    async def grant_guardian_consent(self, teen: uuid.UUID, value: str = "granted") -> None:
        await self.profile_event("user.profile.updated.v1", {
            "user_id": str(teen), "changed_fields": ["guardian_consent"], "guardian_consent": value})


@pytest.fixture
async def env():
    schema = unique_schema("soc")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    identity = IdentityStub()
    app = build_app(settings, runtime, identity_transport=httpx.MockTransport(identity.handler))
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://social")
        e = Env(settings, client, runtime, bus, app, identity)
        await e.flush()  # прогрев пула
        yield e
        await client.aclose()
    await drop_schema(schema)
