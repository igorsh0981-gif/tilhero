"""Общие помощники тестов саги удаления (спринт 9)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select

from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import internal_headers
from tilhero_identity.deletion.models import DeletionAttempt, DeletionDomainAck, DeletionRequest
from tilhero_identity.deletion.sweeper import SweepResult, sweep_once
from tilhero_identity.models import User

DOMAINS = ["preferences", "support", "notifications", "offers", "recommendations", "watch", "news",
           "ai-concierge", "ai-control"]
ACK_CONSUMER = "identity-consent.deletion_acks"
READER = Actor(id=str(uuid.uuid4()), role="support", permissions=frozenset({"users.read"}))
OPERATOR = Actor(id=str(uuid.uuid4()), role="operations",
                 permissions=frozenset({"users.read", "ops.queues.manage"}))
REASON = "Домен не ответил, сервис поднят — повторяем запрос"


def ack(user_id: str, request_id: str, domain: str, mode: str = "deleted") -> Envelope:
    return make_envelope(
        "user.domain.deleted.v1",
        {"user_id": user_id, "request_id": request_id, "domain": domain, "mode": mode},
        producer=domain,
    )


def bff(env: Any, actor: Actor | None = OPERATOR) -> dict[str, str]:
    return internal_headers(env.settings, issuer="admin-bff", actor=actor)


def ops(env: Any, issuer: str = "ops-monitor", **kw: Any) -> dict[str, str]:
    return internal_headers(env.settings, issuer=issuer, **kw)


def cmd(env: Any, key: str | None = None, actor: Actor | None = OPERATOR) -> dict[str, str]:
    h = bff(env, actor)
    h["Idempotency-Key"] = key or f"retry-{uuid.uuid4().hex}"
    return h


async def request_deletion(env: Any, **login: Any) -> tuple[str, str]:
    uid = await env.new_user(**login)
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    assert r.status_code == 202, r.text
    return uid, r.json()["request_id"]


async def load(env: Any, request_id: str) -> DeletionRequest:
    async with env.runtime.transaction() as s:
        return (await s.execute(
            select(DeletionRequest).where(DeletionRequest.request_id == uuid.UUID(request_id))
        )).scalar_one()


async def attempts(env: Any, request_id: str) -> list[DeletionAttempt]:
    async with env.runtime.transaction() as s:
        return list((await s.execute(
            select(DeletionAttempt).where(DeletionAttempt.request_id == uuid.UUID(request_id))
            .order_by(DeletionAttempt.attempt)
        )).scalars())


async def acks(env: Any, request_id: str) -> dict[str, DeletionDomainAck]:
    async with env.runtime.transaction() as s:
        return {a.domain: a for a in (await s.execute(
            select(DeletionDomainAck).where(DeletionDomainAck.request_id == uuid.UUID(request_id))
        )).scalars()}


async def user(env: Any, uid: str) -> User:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(User).where(User.user_id == uuid.UUID(uid)))).scalar_one()


async def sweep_at(env: Any, request_id: str, *, minutes: float = 0, hours: float = 0) -> SweepResult:
    """Тик таймера в момент requested_at + смещение."""
    req = await load(env, request_id)
    return await sweep_once(env.runtime, now=req.requested_at + timedelta(minutes=minutes, hours=hours))


async def requested_events(env: Any, request_id: str) -> list[Envelope]:
    return [e for e in await env.events("user.deletion.requested.v1") if e.payload["request_id"] == request_id]


async def ack_all(env: Any, uid: str, request_id: str, domains: list[str] | None = None) -> None:
    for d in domains if domains is not None else DOMAINS:
        await env.bus.publish(ack(uid, request_id, d))
    await env.flush()


async def backdate_last_sent(env: Any, request_id: str, seconds: int) -> datetime:
    """Сдвигает last_sent_at в прошлое (ручной повтор не чаще раза в 5 мин)."""
    async with env.runtime.transaction() as s:
        req = (await s.execute(
            select(DeletionRequest).where(DeletionRequest.request_id == uuid.UUID(request_id)).with_for_update()
        )).scalar_one()
        assert req.last_sent_at is not None
        req.last_sent_at = req.last_sent_at - timedelta(seconds=seconds)
        return req.last_sent_at
