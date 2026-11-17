"""Общие константы и помощники тестов support (уникальное имя модуля — без конфликтов с другими сервисами)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import internal_headers
from tilhero_support.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])

# Имя оператора приходит только в claim actor.name токена admin-bff (ревью P5)
OPERATOR = Actor(
    id="support.01", role="support", permissions=frozenset({"support.read", "support.reply"}), name="Алина Петрова"
)
OPERATOR_2 = Actor(id="support.02", role="support", permissions=frozenset({"support.read", "support.reply"}))
READER = Actor(id="viewer.01", role="viewer", permissions=frozenset({"support.read"}))
MANAGER = Actor(
    id="lead.01",
    role="support_lead",
    permissions=frozenset({"support.read", "support.reply", "support.manage"}),
)
OUTSIDER = Actor(id="ops.01", role="operations", permissions=frozenset({"usage.read"}))

CONTEXT = {
    "event_id": "evt_f1_auh_2026",
    "offer_id": "off_987",
    "provider_id": "ticket_provider_x",
    "deeplink": "https://www.abudhabigp.com/en/tickets",
    "price_snapshot": {"amount": "850.00", "currency": "USD", "fetched_at": "2026-10-07T13:42:00Z"},
    "event_title": "Formula 1 Abu Dhabi Grand Prix",
    "client_version": "telegram-miniapp-2.0",
}


@dataclass
class SupportEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    bus: InMemoryBus

    def user(
        self, user_id: uuid.UUID | str, *, issuer: str = "telegram-bff", idem: str | None = None
    ) -> dict:
        h = internal_headers(self.settings, issuer=issuer, subject=str(user_id))
        if idem:
            h["Idempotency-Key"] = idem
        return h

    def staff(
        self, actor: Actor | None = OPERATOR, *, issuer: str = "admin-bff", idem: str | None = None
    ) -> dict:
        h = internal_headers(self.settings, issuer=issuer, actor=actor)
        if idem:
            h["Idempotency-Key"] = idem
        return h

    async def create(
        self, user_id: uuid.UUID | str, *, expect: int = 201, idem: str | None = None, **overrides: Any
    ) -> dict:
        body = {"category": "OTHER", "subject": "Не приходят уведомления", "message": "Включил, но тишина"}
        body.update(overrides)
        r = await self.client.post(
            "/internal/v1/me/tickets", json=body, headers=self.user(user_id, idem=idem or uuid.uuid4().hex)
        )
        assert r.status_code == expect, r.text
        return r.json()

    async def reply(
        self,
        ref: str,
        text: str = "Проверили, всё исправлено",
        *,
        visibility: str = "public",
        actor: Actor = OPERATOR,
    ) -> httpx.Response:
        body: dict[str, Any] = {"text": text, "visibility": visibility}
        return await self.client.post(
            f"/admin/v1/support/tickets/{ref}/messages", json=body, headers=self.staff(actor)
        )

    async def flush(self) -> list[Envelope]:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()
        return self.bus.published

    async def events(self, event_type: str) -> list[Envelope]:
        await self.flush()
        return self.bus.of_type(event_type)
