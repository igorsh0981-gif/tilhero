"""Контракт саги удаления (спринт 9, ADR-009, INTERNAL_API §1.3): повтор `user.deletion.requested.v1` — тот же
`request_id`, новый `event_id`, `attempt` — снова подтверждается `user.domain.deleted.v1` без ошибок; данные удалены."""

from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import text

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms

DOMAIN, MODE, CONSUMER = "support", "anonymized", "support.user_deleted"


def requested(user: uuid.UUID, request_id: uuid.UUID, attempt: int) -> Envelope:
    ev = make_envelope("user.deletion.requested.v1",
                       {"user_id": str(user), "request_id": str(request_id),
                        "requested_at": "2026-10-16T09:00:00.000Z", "attempt": attempt},
                       producer="identity-consent")
    assert_event_conforms(ev)
    return ev


async def acks(env, request_id: uuid.UUID) -> list[Envelope]:
    assert env.runtime.relay is not None
    await env.runtime.relay.drain()
    found = [e for e in env.bus.of_type("user.domain.deleted.v1") if e.payload["request_id"] == str(request_id)]
    for e in found:
        assert_event_conforms(e)
        assert e.producer == DOMAIN
    return found


async def seed(env, user: uuid.UUID) -> None:
    await env.create(user, message=f"Мой телефон +998 {user.hex[:12]}")
    assert await left(env, user) > 0


async def left(env, user: uuid.UUID) -> int:
    """Обращения, связанные с пользователем, и его тексты (после обезличивания user_id = NULL, тексты стёрты)."""
    async with env.runtime.transaction() as s:
        linked = (await s.execute(text("SELECT count(*) FROM tickets WHERE user_id = :u"), {"u": user})).scalar_one()
        texts = (await s.execute(text("SELECT count(*) FROM messages WHERE text LIKE :m"),
                                 {"m": f"%{user.hex[:12]}%"})).scalar_one()
    return int(linked) + int(texts)



async def test_retry_is_acked_again(env) -> None:
    user, other, rid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    await seed(env, other)
    other_before = await left(env, other)
    first, retry = requested(user, rid, 1), requested(user, rid, 2)
    assert first.event_id != retry.event_id
    await env.bus.publish(first)
    assert len(await acks(env, rid)) == 1 and await left(env, user) == 0
    await env.bus.publish(retry)
    found = await acks(env, rid)
    assert len(found) == 2
    expected = {"user_id": str(user), "request_id": str(rid), "domain": DOMAIN, "mode": MODE}
    assert [e.payload for e in found] == [expected, expected]
    assert await left(env, user) == 0 and await left(env, other) == other_before
    assert env.bus.dlq == []


async def test_parallel_retries_and_redelivery(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    events = [requested(user, rid, n) for n in (1, 2, 3)]
    spec = next(s for s in env.bus.specs if s.durable == CONSUMER)
    await asyncio.gather(*[spec.handler(e) for e in events], spec.handler(events[0]))
    assert len(await acks(env, rid)) == 3  # по ACK на каждый event_id; повторная доставка — inbox
    assert await left(env, user) == 0 and env.bus.dlq == []
