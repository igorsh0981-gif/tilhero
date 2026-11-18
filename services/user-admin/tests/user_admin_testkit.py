"""Помощники тестов user-admin (уникальное имя модуля — без конфликтов с другими сервисами).

FakeIdentity — identity-consent `GET /admin/v1/users[?updated_after&cursor&limit]` и `/admin/v1/users/{id}`
(httpx.MockTransport) с той же семантикой курсора (updated_at, user_id) по возрастанию.
PII только синтетическая: username/имена вида «tester_…», «Тестовый …», Telegram ID — только маска.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import jwt

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import internal_headers
from tilhero_user_admin.domain.sync import IdentitySync
from tilhero_user_admin.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
MASK = "•"

VIEWER = Actor(id=str(uuid.uuid4()), role="support", permissions=frozenset({"users.read", "dashboard.read"}),
               name="Оператор Тест")
ANALYST = Actor(id=str(uuid.uuid4()), role="analyst", permissions=frozenset({"dashboard.read"}))
OUTSIDER = Actor(id=str(uuid.uuid4()), role="auditor", permissions=frozenset({"audit.read"}))


def now() -> datetime:
    return datetime.now(UTC)


def snapshot(user_id: uuid.UUID | str | None = None, *, n: int = 0, updated_at: datetime | None = None,
             **kw: Any) -> dict[str, Any]:
    uid = str(user_id or uuid.uuid4())
    at = updated_at or now()
    base: dict[str, Any] = {
        "user_id": uid,
        "username": f"tester_{n}",
        "display_name": f"Тестовый Пользователь {n}",
        "telegram_id_masked": MASK * 6 + f"{n:03d}"[-3:],
        "locale": "ru",
        "status": "ACTIVE",
        "created_at": (at - timedelta(days=1)).isoformat(),
        "updated_at": at.isoformat(),
        "last_seen_at": at.isoformat(),
        "consent": {"policy_version": "1.0", "purposes": ["personalization"], "accepted_at": at.isoformat(),
                    "age_confirmed_18_plus": True, "revoked_at": None},
        "security": {"pin_enabled": False, "biometric_enabled": False},
    }
    base.update(kw)
    return base


@dataclass
class FakeIdentity:
    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[httpx.Request] = field(default_factory=list)
    down: bool = False
    status_on_down: int | None = None  # None → сетевой сбой, иначе HTTP-статус

    def put(self, snap: dict[str, Any]) -> dict[str, Any]:
        self.users[snap["user_id"]] = snap
        return snap

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        claims = jwt.decode(request.headers["x-internal-token"], options={"verify_signature": False})
        assert claims["iss"] == "user-admin" and claims["aud"] == "identity-consent"
        assert "actor" not in claims and "sub" not in claims
        if self.down:
            if self.status_on_down is None:
                raise httpx.ConnectError("identity-consent is down")
            return httpx.Response(self.status_on_down, json={"code": "X", "message": "x", "trace_id": "t",
                                                             "details": {}})
        path = request.url.path
        if path == "/admin/v1/users":
            return httpx.Response(200, json=self._page(request.url.params))
        uid = path.rsplit("/", 1)[-1]
        if uid in self.users:
            return httpx.Response(200, json=self.users[uid])
        return httpx.Response(404, json={"code": "USER_NOT_FOUND", "message": "x", "trace_id": "t", "details": {}})

    def _page(self, params: httpx.QueryParams) -> dict[str, Any]:
        def key(s: dict[str, Any]) -> tuple[datetime, str]:
            return datetime.fromisoformat(s["updated_at"]), s["user_id"]

        items = sorted(self.users.values(), key=key)
        if "updated_after" in params:
            after = datetime.fromisoformat(params["updated_after"])
            items = [s for s in items if key(s)[0] > after]
        if "cursor" in params:
            c = json.loads(base64.urlsafe_b64decode(params["cursor"] + "=" * (-len(params["cursor"]) % 4)))
            ck = (datetime.fromisoformat(c["t"]), c["u"])
            items = [s for s in items if key(s) > ck]
        limit = int(params.get("limit", 20))
        page = items[:limit]
        nxt = None
        if len(items) > limit:
            last = page[-1]
            nxt = base64.urlsafe_b64encode(json.dumps({"t": last["updated_at"], "u": last["user_id"]}).encode()
                                           ).decode().rstrip("=")
        return {"items": page, "next_cursor": nxt}


@dataclass
class UAEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    bus: InMemoryBus
    identity: FakeIdentity
    sync: IdentitySync

    def staff(self, actor: Actor | None = VIEWER, *, issuer: str = "admin-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, actor=actor)

    async def get(self, path: str, actor: Actor | None = VIEWER, **kw: Any) -> httpx.Response:
        return await self.client.get(path, headers=self.staff(actor), **kw)

    async def deliver(self, env: Envelope, times: int = 1) -> None:
        """Доставка события потребителю напрямую (как JetStream при повторной доставке — тот же event_id)."""
        [spec] = [s for s in self.bus.specs if s.durable == "user-admin.projection"]
        for _ in range(times):
            await spec.handler(env)

    async def emit(self, event_type: str, payload: dict[str, Any], *, producer: str,
                   occurred_at: datetime | None = None, times: int = 1) -> Envelope:
        env = make_envelope(event_type, payload, producer=producer)
        if occurred_at is not None:
            env = env.model_copy(update={"occurred_at": occurred_at})
        await self.deliver(env, times)
        return env

    async def wait_for(self, predicate, within: float = 5.0) -> None:
        deadline = asyncio.get_running_loop().time() + within
        while True:
            if await predicate():
                return
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("condition not met in time")
            await asyncio.sleep(0.05)
