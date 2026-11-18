"""Общие помощники тестов саги удаления."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from conftest import DOMAINS
from sqlalchemy import select

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_identity.deletion.models import DeletionAttempt, DeletionDomainAck, DeletionRequest
from tilhero_identity.deletion.sweeper import SweepResult, sweep_once
from tilhero_identity.models import User

ACK_CONSUMER = "identity-consent.deletion_acks"
CONFIRM = {"confirm_word": "УДАЛИТЬ"}

__all__ = ["ACK_CONSUMER", "CONFIRM", "DOMAINS"]


def ack(user_id: str, request_id: str, domain: str, mode: str = "deleted") -> Envelope:
    return make_envelope(
        "user.domain.deleted.v1",
        {"user_id": user_id, "request_id": request_id, "domain": domain, "mode": mode},
        producer=domain,
    )


async def request_deletion(env: Any, **login: Any) -> tuple[str, str]:
    uid = await env.new_user(**login)
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)
    assert r.status_code == 202, r.text
    return uid, r.json()["request_id"]


async def load(env: Any, request_id: str) -> DeletionRequest:
    async with env.runtime.transaction() as s:
        return (await s.execute(
            select(DeletionRequest).where(DeletionRequest.request_id == uuid.UUID(request_id))
        )).scalar_one()


async def request_of(env: Any, user_id: str) -> DeletionRequest:
    async with env.runtime.transaction() as s:
        return (await s.execute(
            select(DeletionRequest).where(DeletionRequest.user_id == uuid.UUID(user_id))
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
