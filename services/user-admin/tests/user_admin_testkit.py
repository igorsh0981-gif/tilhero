"""Помощники тестов user-admin (уникальное имя модуля — без конфликтов с другими сервисами).

FakeSource — источник сверки (httpx.MockTransport) с семантикой курсора (updated_at, user_id) по возрастанию:
identity-consent `GET /admin/v1/users[?updated_after&cursor&limit]` и `/admin/v1/users/{id}` (контракт
INTERNAL_API §3 — эндпоинт делает другой исполнитель), learning-plan `GET /admin/v1/plans`.
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
from tilhero_user_admin.domain.sync import Reconciler
from tilhero_user_admin.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
MASK = "•"
ID = "identity-consent"
LP = "learning-plan"
SCHEDULER_TOKEN = "s" * 43

VIEWER = Actor(id=str(uuid.uuid4()), role="support", name="Оператор Тест",
               permissions=frozenset({"users.read", "dashboard.read", "support.read"}))
METHODIST = Actor(id=str(uuid.uuid4()), role="methodist", permissions=frozenset({"users.read", "dashboard.read"}))
ANALYST = Actor(id=str(uuid.uuid4()), role="read_only", permissions=frozenset({"dashboard.read"}))
OUTSIDER = Actor(id=str(uuid.uuid4()), role="auditor", permissions=frozenset({"audit.read"}))


def now() -> datetime:
    return datetime.now(UTC)


def iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


def snapshot(user_id: uuid.UUID | str | None = None, *, n: int = 0, updated_at: datetime | None = None,
             kind: str = "account", guardian: str | None = None, **kw: Any) -> dict[str, Any]:
    """Снимок identity-consent (поля AdminLearnerRow identity + consent/security/notifications + updated_at)."""
    uid = str(user_id or uuid.uuid4())
    at = updated_at or now()
    child = kind == "child"
    base: dict[str, Any] = {
        "user_id": uid,
        "kind": kind,
        "guardian_user_id": guardian if child else None,
        "display_name": f"Тестовый Ученик {n}",
        "username": None if child else f"tester_{n}",
        "telegram_id_masked": None if child else MASK * 6 + f"{n:03d}"[-3:],
        "locale": "ru",
        "age_band": "6-9" if child else "18+",
        "guardian_consent": "not_required",
        "status": "ACTIVE",
        "created_at": iso(at - timedelta(days=1)),
        "updated_at": iso(at),
        "consent": {"policy_version": "1.0", "purposes": ["terms", "privacy"], "accepted_at": iso(at),
                    "revoked_at": None, "basis": "guardian" if child else "self"},
        "security": {"pin_enabled": False, "pin_reset_pending": False},
        "notifications": {"enabled": True, "categories": {"reminders": True, "missed": True, "social": False,
                                                           "support": True, "product": False}},
        # поля других доменов (identity их может прислать) read-модель не берёт из снимка
        "children_count": 99, "open_tickets": 99, "goal": "exam",
    }
    base.update(kw)
    return base


def plan(user_id: uuid.UUID | str, *, updated_at: datetime | None = None, **kw: Any) -> dict[str, Any]:
    """Элемент learning-plan GET /admin/v1/plans."""
    at = updated_at or now()
    base: dict[str, Any] = {
        "user_id": str(user_id), "goal": "travel", "level_self": "beginner", "ui_lang": "ru",
        "schedule": {"preset": "weekdays", "days": [1, 2, 3, 4, 5], "preferred_time": "19:00", "duration_min": 20,
                     "reminders_enabled": True, "timezone": "Asia/Tashkent"},
        "onboarding_completed_at": iso(at - timedelta(minutes=5)), "updated_at": iso(at),
    }
    base.update(kw)
    return base


def _key(s: dict[str, Any]) -> tuple[datetime, str]:
    at = datetime.fromisoformat(s["updated_at"].replace("Z", "+00:00"))
    return (at if at.tzinfo else at.replace(tzinfo=UTC)), s["user_id"]  # «битый» снимок без зоны — тоже в выдаче


@dataclass
class FakeSource:
    audience: str
    list_path: str
    items: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[httpx.Request] = field(default_factory=list)
    down: bool = False
    status_on_down: int | None = None  # None → сетевой сбой, иначе HTTP-статус

    def put(self, item: dict[str, Any]) -> dict[str, Any]:
        self.items[item["user_id"]] = item
        return item

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        claims = jwt.decode(request.headers["x-internal-token"], options={"verify_signature": False})
        assert claims["iss"] == "user-admin" and claims["aud"] == self.audience
        assert "actor" not in claims and "sub" not in claims
        if self.down:
            if self.status_on_down is None:
                raise httpx.ConnectError("source is down")
            return httpx.Response(self.status_on_down, json={"code": "X", "message": "x", "trace_id": "t",
                                                             "details": {}})
        path = request.url.path
        if path == self.list_path:
            return httpx.Response(200, json=self._page(request.url.params))
        uid = path.rsplit("/", 1)[-1]
        if path.startswith(self.list_path + "/") and uid in self.items:
            return httpx.Response(200, json=self.items[uid])
        return httpx.Response(404, json={"code": "USER_NOT_FOUND", "message": "x", "trace_id": "t", "details": {}})

    def _page(self, params: httpx.QueryParams) -> dict[str, Any]:
        items = sorted(self.items.values(), key=_key)
        if "updated_after" in params:
            after = datetime.fromisoformat(params["updated_after"])
            items = [s for s in items if _key(s)[0] > after]
        if "cursor" in params:
            c = json.loads(base64.urlsafe_b64decode(params["cursor"] + "=" * (-len(params["cursor"]) % 4)))
            ck = (datetime.fromisoformat(c["t"]), c["u"])
            items = [s for s in items if _key(s) > ck]
        limit = int(params.get("limit", 100))
        page = items[:limit]
        nxt = None
        if len(items) > limit:
            t, u = _key(page[-1])
            nxt = base64.urlsafe_b64encode(json.dumps({"t": t.isoformat(), "u": u}).encode()).decode().rstrip("=")
        return {"items": page, "next_cursor": nxt}


def fake_identity() -> FakeSource:
    return FakeSource(ID, "/admin/v1/users")


def fake_plans() -> FakeSource:
    return FakeSource(LP, "/admin/v1/plans")


@dataclass
class UAEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    bus: InMemoryBus
    identity: FakeSource
    plans: FakeSource
    reconciler: Reconciler

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

    async def seed(self, n: int = 0, **kw: Any) -> dict[str, Any]:
        snap = self.identity.put(snapshot(n=n, **kw))
        await self.reconciler.identity.run_once()
        return snap

    async def wait_for(self, predicate, within: float = 5.0) -> None:
        deadline = asyncio.get_running_loop().time() + within
        while True:
            if await predicate():
                return
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("condition not met in time")
            await asyncio.sleep(0.05)
