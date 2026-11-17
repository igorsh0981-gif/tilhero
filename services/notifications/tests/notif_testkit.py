"""Помощники тестов notifications: фейковые identity-consent и telegram-bot-gateway (httpx.MockTransport)."""

from __future__ import annotations

import itertools
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import internal_headers
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.models import Notification
from tilhero_notifications.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SCHEDULER_TOKEN = "sched-" + "n" * 40
# Обычное «немедленное» уведомление для сценариев доставки (код PIN через шину не принимается — ревью P2)
CRIT = "watch.critical"
EVENT_ID = "3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90"  # события — UUID (deep link event_<uuid>)
CRIT_PARAMS = {"event_id": EVENT_ID, "event_title": "Desert Sounds Festival", "change": "postponed"}


def api_error(status: int, code: str, details: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status, json={"code": code, "message": "x", "trace_id": "t", "details": details or {}}
    )


@dataclass
class FakeIdentity:
    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    fail: list[int] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        user_id = request.url.path.split("/")[4]
        if self.fail:
            return api_error(self.fail.pop(0), "UPSTREAM")
        if user_id not in self.users:
            return api_error(404, "USER_NOT_FOUND")
        return httpx.Response(200, json=self.users[user_id])


@dataclass
class FakeGateway:
    calls: list[dict[str, Any]] = field(default_factory=list)
    headers: list[dict[str, str]] = field(default_factory=list)
    queue: list[Any] = field(default_factory=list)
    _ids: Any = field(default_factory=lambda: itertools.count(9001))

    # спринт 8: POST /internal/v1/ops-messages (оповещения операторам) — свои вызовы и очередь ответов
    ops_calls: list[dict[str, Any]] = field(default_factory=list)
    ops_queue: list[Any] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/internal/v1/ops-messages":
            self.ops_calls.append(json.loads(request.content))
            self.headers.append(dict(request.headers))
            if self.ops_queue:
                item = self.ops_queue.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item
            return httpx.Response(200, json={"message_id": next(self._ids)})
        assert request.url.path == "/internal/v1/messages"
        self.calls.append(json.loads(request.content))
        self.headers.append(dict(request.headers))
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return httpx.Response(200, json={"message_id": next(self._ids)})


@dataclass
class NotifEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    bus: InMemoryBus
    identity: FakeIdentity
    gateway: FakeGateway
    dispatcher: Dispatcher
    digest: Any = None  # DigestRunner (app.state.digest)
    _tg: Any = field(default_factory=lambda: itertools.count(918273645))

    def add_user(
        self,
        *,
        locale: str = "ru",
        enabled: bool = True,
        quiet: dict[str, str] | None = None,
        tz: str | None = "Asia/Tashkent",
        status: str = "ACTIVE",
        digest_time: str | None = "09:00",
    ) -> uuid.UUID:
        user_id = uuid.uuid4()
        self.identity.users[str(user_id)] = {
            "telegram_user_id": next(self._tg),
            "locale": locale,
            "notifications_enabled": enabled,
            "quiet_hours": quiet,
            "digest_time": digest_time,
            "timezone": tz,
            "status": status,
        }
        return user_id

    def telegram_id(self, user_id: uuid.UUID) -> int:
        return int(self.identity.users[str(user_id)]["telegram_user_id"])

    async def publish(
        self, event_type: str, payload: dict[str, Any], producer: str = "identity-consent"
    ) -> Envelope:
        env = make_envelope(event_type, payload, producer=producer)
        await self.bus.publish(env)
        return env

    async def transactional(
        self,
        user_id: uuid.UUID,
        code: str = "482913",
        *,
        notification_id: uuid.UUID | None = None,
        dedup_key: str | None = None,
        issuer: str = "identity-consent",
        params: dict[str, Any] | None = None,
        template: str = "pin.reset_code",
    ) -> httpx.Response:
        nid = notification_id or uuid.uuid4()
        return await self.client.post(
            "/internal/v1/notifications/transactional",
            json={
                "notification_id": str(nid),
                "user_id": str(user_id),
                "template": template,
                "params": params if params is not None else {"code": code},
                "dedup_key": dedup_key or f"pin_reset:{nid}",
            },
            headers=internal_headers(self.settings, issuer=issuer),
        )

    async def critical(self, user_id: uuid.UUID, **kw: Any) -> uuid.UUID:
        return await self.request(user_id, CRIT, dict(CRIT_PARAMS), kind="critical", **kw)

    async def request(
        self,
        user_id: uuid.UUID,
        template: str,
        params: dict[str, Any] | None,
        *,
        kind: str = "transactional",
        dedup_key: str | None = None,
        startapp: str | None = None,
        notification_id: uuid.UUID | None = None,
    ) -> uuid.UUID:
        nid = notification_id or uuid.uuid4()
        payload: dict[str, Any] = {
            "notification_id": str(nid),
            "user_id": str(user_id),
            "kind": kind,
            "template": template,
            "params": params,
            "dedup_key": dedup_key or f"t:{nid}",
        }
        if startapp:
            payload["startapp"] = startapp
        await self.publish("notification.requested.v1", payload)
        return nid

    async def reply_event(
        self, user_id: uuid.UUID, number: str = "TCK-3081", message_id: uuid.UUID | None = None
    ) -> Envelope:
        return await self.publish(
            "support.ticket.replied.v1",
            {
                "ticket_id": str(uuid.uuid4()),
                "number": number,
                "user_id": str(user_id),
                "message_id": str(message_id or uuid.uuid4()),
                "sender_type": "operator",
                "replied_at": "2026-10-08T10:00:00Z",
            },
            producer="support",
        )

    async def dispatch(self, now: datetime | None = None) -> int:
        return await self.dispatcher.run_once(now)

    async def rows(self, user_id: uuid.UUID | None = None) -> list[Notification]:
        async with self.runtime.transaction() as s:
            stmt = select(Notification).order_by(Notification.created_at)
            if user_id:
                stmt = stmt.where(Notification.user_id == user_id)
            return list((await s.execute(stmt)).scalars().all())

    async def row(self, notification_id: uuid.UUID) -> Notification:
        async with self.runtime.transaction() as s:
            return (
                await s.execute(select(Notification).where(Notification.notification_id == notification_id))
            ).scalar_one()

    async def events(self, event_type: str) -> list[Envelope]:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()
        return self.bus.of_type(event_type)
