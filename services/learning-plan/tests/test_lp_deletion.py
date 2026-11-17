"""Сага удаления (TG-FR-006, AT-14): план, занятия и отметки удаляются, ACK domain=learning-plan; повтор саги снова
подтверждается; дубль доставки — inbox; план не воскрешается; tick удалённого не трогает; битый payload — DLQ."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms

CONSUMER = "learning-plan.user_deletion"
MON = datetime(2026, 11, 16, 3, 0, tzinfo=UTC)


def requested(user: uuid.UUID, request_id: uuid.UUID, attempt: int | None = None) -> Envelope:
    payload: dict = {"user_id": str(user), "request_id": str(request_id), "requested_at": "2026-11-18T09:00:00Z"}
    if attempt is not None:
        payload["attempt"] = attempt
    ev = make_envelope("user.deletion.requested.v1", payload, producer="identity-consent")
    assert_event_conforms(ev)
    return ev


async def rows(env, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for table in ("plans", "activities", "slot_marks"):
        [(n,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        out[table] = n
    return out


async def seed(env, user: uuid.UUID) -> None:
    await env.onboard(user, at=MON)
    await env.practice(user, at=datetime(2026, 11, 16, 5, 0, tzinfo=UTC))
    await env.tick(datetime(2026, 11, 17, 19, 0, tzinfo=UTC), since=datetime(2026, 11, 16, 19, 0, tzinfo=UTC))
    assert all(v > 0 for v in (await rows(env, user)).values())


async def test_deletion_removes_data_and_acks(env) -> None:
    user, other, rid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    await seed(env, other)
    before_other = await rows(env, other)
    await env.bus.publish(requested(user, rid))
    acks = [e for e in await env.events("user.domain.deleted.v1")]
    assert [e.payload for e in acks] == [{"user_id": str(user), "request_id": str(rid), "domain": "learning-plan",
                                          "mode": "deleted"}]
    assert await rows(env, user) == {"plans": 0, "activities": 0, "slot_marks": 0}
    assert await rows(env, other) == before_other
    # после удаления план не воскрешается запросом с ещё живым токеном
    for method, path in (("GET", "/internal/v1/me/plan"), ("PATCH", "/internal/v1/me/plan"),
                         ("GET", "/internal/v1/me/plan/today")):
        r = await env.c.request(method, path, json={"goal": "work"}, headers=env.h(user))
        assert r.status_code == 410 and r.json()["code"] == "USER_DELETED", path
    r = await env.practice(user, at=datetime(2026, 11, 18, 5, 0, tzinfo=UTC))
    assert r.status_code == 410
    assert await rows(env, user) == {"plans": 0, "activities": 0, "slot_marks": 0}
    # tick удалённого ученика больше не видит
    r = await env.tick(datetime(2026, 11, 18, 19, 0, tzinfo=UTC))
    assert r["plans_checked"] == 1
    assert env.bus.dlq == []


async def test_retry_and_redelivery_are_acked_once_per_event(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    first, retry = requested(user, rid, 1), requested(user, rid, 2)
    spec = next(s for s in env.bus.specs if s.durable == CONSUMER)
    await asyncio.gather(spec.handler(first), spec.handler(retry), spec.handler(first))  # дубль доставки — inbox
    acks = [e for e in await env.events("user.domain.deleted.v1") if e.payload["request_id"] == str(rid)]
    assert len(acks) == 2 and sorted(e.causation_id for e in acks) == sorted([first.event_id, retry.event_id])
    assert await rows(env, user) == {"plans": 0, "activities": 0, "slot_marks": 0}


async def test_unknown_user_still_acked(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await env.bus.publish(requested(user, rid))
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload["user_id"] == str(user) and ack.payload["domain"] == "learning-plan"


async def test_invalid_payload_goes_to_dlq(env) -> None:
    bad = make_envelope("user.deletion.requested.v1", {"user_id": "nope"}, producer="identity-consent")
    await env.bus.publish(bad)
    assert [d for d, _ in env.bus.dlq] == [CONSUMER]
    assert await env.events("user.domain.deleted.v1") == []
