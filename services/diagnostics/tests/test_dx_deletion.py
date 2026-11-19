"""Сага удаления (TG-FR-006): сессии, ответы, результаты, состояния и свидетельства навыков, проекция профиля
удаляются → ACK user.domain.deleted.v1 {domain: diagnostics, mode: deleted}; повтор саги снова подтверждается;
дубль доставки — inbox; данные не воскрешаются; чужой издатель игнорируется."""

from __future__ import annotations

import asyncio
import uuid

from dx_testkit import always, up_to

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms

CONSUMER = "diagnostics.user_deletion"
TABLES = ("sessions", "results", "skill_states", "skill_evidence", "learner_profiles")


def requested(user: uuid.UUID, request_id: uuid.UUID, attempt: int | None = None,
              producer: str = "identity-consent") -> Envelope:
    payload: dict = {"user_id": str(user), "request_id": str(request_id), "requested_at": "2026-11-19T09:00:00Z"}
    if attempt is not None:
        payload["attempt"] = attempt
    ev = make_envelope("user.deletion.requested.v1", payload, producer=producer)
    assert_event_conforms(ev)
    return ev


async def rows(env, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for table in TABLES:
        [(n,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        out[table] = n
    [(n,)] = await env.sql("SELECT count(*) FROM answers a JOIN sessions s USING (session_id) WHERE s.user_id = :u",
                           u=user)
    out["answers"] = n
    return out


async def seed(env, user: uuid.UUID) -> dict:
    await env.bus.publish(make_envelope("user.profile.created.v1", {
        "user_id": str(user), "kind": "account", "age_band": "18+", "created_at": "2026-11-18T10:00:00Z"},
        producer="identity-consent"))
    result = await env.complete(user, up_to("A1"))
    assert all(v > 0 for v in (await rows(env, user)).values())
    return result


async def test_deletion_removes_data_and_acks(env) -> None:
    user, other, rid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    result = await seed(env, user)
    await seed(env, other)
    before_other = await rows(env, other)
    [(answers_total,)] = await env.sql("SELECT count(*) FROM answers")
    await env.bus.publish(requested(user, rid))
    acks = await env.events("user.domain.deleted.v1")
    assert [e.payload for e in acks] == [{"user_id": str(user), "request_id": str(rid), "domain": "diagnostics",
                                          "mode": "deleted"}]
    assert await rows(env, user) == dict.fromkeys((*TABLES, "answers"), 0)
    assert await rows(env, other) == before_other
    [(answers_left,)] = await env.sql("SELECT count(*) FROM answers")
    assert answers_left == answers_total - 24
    # после удаления запросы с ещё живым токеном не воскрешают данные
    for method, path in (("GET", "/internal/v1/diagnostics/state"), ("GET", "/internal/v1/diagnostics/results"),
                         ("GET", f"/internal/v1/diagnostics/results/{result['result_id']}"),
                         ("GET", "/internal/v1/skills/map")):
        r = await env.c.request(method, path, headers=env.h(user))
        assert r.status_code == 410 and r.json()["code"] == "USER_DELETED", path
    r = await env.c.post("/internal/v1/diagnostics/sessions", headers={**env.h(user), "Idempotency-Key": "k-del-123"})
    assert r.status_code == 410
    # запоздавшее событие профиля не создаёт проекцию
    await env.bus.publish(make_envelope("user.profile.updated.v1", {
        "user_id": str(user), "changed_fields": ["age_band"], "age_band": "18+"}, producer="identity-consent"))
    assert (await rows(env, user))["learner_profiles"] == 0
    assert env.bus.dlq == []


async def test_retry_and_redelivery_are_acked_once_per_event(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    first, retry = requested(user, rid, 1), requested(user, rid, 2)
    spec = next(s for s in env.bus.specs if s.durable == CONSUMER)
    await asyncio.gather(spec.handler(first), spec.handler(retry), spec.handler(first))  # дубль доставки — inbox
    acks = [e for e in await env.events("user.domain.deleted.v1") if e.payload["request_id"] == str(rid)]
    assert len(acks) == 2 and sorted(e.causation_id for e in acks) == sorted([first.event_id, retry.event_id])
    assert await rows(env, user) == dict.fromkeys((*TABLES, "answers"), 0)


async def test_unknown_user_acked_and_foreign_producer_ignored(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await env.bus.publish(requested(user, rid))
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload["user_id"] == str(user)
    victim = uuid.uuid4()
    await env.complete(victim, always("correct"))
    await env.bus.publish(requested(victim, uuid.uuid4(), producer="social"))
    assert len(await env.events("user.domain.deleted.v1")) == 1
    assert (await rows(env, victim))["results"] == 1
    assert env.bus.dlq == []
