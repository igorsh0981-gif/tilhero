"""Сага удаления (TG-FR-006): оценки (с цепочками переоценок), апелляции и QA-флаги ученика удаляются →
ACK user.domain.deleted.v1 {domain: assessment, mode: deleted}; повтор саги снова подтверждается; дубль доставки —
inbox; данные не воскрешаются (410); чужой издатель игнорируется; другие ученики не затронуты."""

from __future__ import annotations

import asyncio
import uuid

from as_testkit import lesson_request

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms

CONSUMER = "assessment.user_deletion"
TABLES = ("evaluations", "appeals", "flags")


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
    return out


async def seed(env, user: uuid.UUID) -> dict:
    created = await env.evaluate(user, lesson_request("l-01-greetings"))
    eid = created["evaluation_id"]
    appeal = await env.appeal(user, eid)
    staff = env.staff("qa.read", "qa.review")
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/flag", json={"reason": "проверить"}, headers=staff)
    assert r.status_code == 201
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", headers=staff, json={
        "scores": {"task": 2}, "skill_outcomes": created["skill_outcomes"], "confirmed_errors": [],
        "reason": "Переоценка по апелляции", "appeal_id": appeal["appeal_id"]})
    assert r.status_code == 201, r.text
    r = await env.c.post(f"/admin/v1/appeals/{appeal['appeal_id']}/decide", headers=staff, json={
        "decision": "corrected", "note": "Оценка исправлена", "new_evaluation_id": r.json()["evaluation_id"]})
    assert r.status_code == 200, r.text
    assert await rows(env, user) == {"evaluations": 2, "appeals": 1, "flags": 1}
    return created


async def test_deletion_removes_data_and_acks(env) -> None:
    user, other, rid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    created = await seed(env, user)
    await seed(env, other)
    await env.bus.publish(requested(user, rid))
    acks = await env.events("user.domain.deleted.v1")
    assert [e.payload for e in acks] == [{"user_id": str(user), "request_id": str(rid), "domain": "assessment",
                                          "mode": "deleted"}]
    assert await rows(env, user) == dict.fromkeys(TABLES, 0)
    assert await rows(env, other) == {"evaluations": 2, "appeals": 1, "flags": 1}
    # после удаления запросы с ещё живым токеном не воскрешают данные
    for method, path in (("GET", f"/internal/v1/evaluations/{created['evaluation_id']}"),
                         ("GET", "/internal/v1/appeals")):
        r = await env.c.request(method, path, headers=env.learner(user))
        assert r.status_code == 410 and r.json()["code"] == "USER_DELETED", path
    r = await env.c.post("/internal/v1/evaluations", json=lesson_request("l-01-greetings"), headers=env.lessons(user))
    assert r.status_code == 410
    r = await env.c.post("/internal/v1/evaluations", json={**lesson_request("l-01-greetings"),
                                                           "session_id": created["session_id"]},
                         headers=env.lessons(user))
    assert r.status_code == 410
    assert await rows(env, user) == dict.fromkeys(TABLES, 0)
    r = await env.c.get(f"/admin/v1/evaluations/{created['evaluation_id']}", headers=env.staff("qa.read"))
    assert r.status_code == 404
    assert env.bus.dlq == []


async def test_retry_and_redelivery_are_acked_once_per_event(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    first, retry = requested(user, rid, 1), requested(user, rid, 2)
    spec = next(s for s in env.bus.specs if s.durable == CONSUMER)
    await asyncio.gather(spec.handler(first), spec.handler(retry), spec.handler(first))  # дубль доставки — inbox
    acks = [e for e in await env.events("user.domain.deleted.v1") if e.payload["request_id"] == str(rid)]
    assert len(acks) == 2 and sorted(e.causation_id for e in acks) == sorted([first.event_id, retry.event_id])
    assert await rows(env, user) == dict.fromkeys(TABLES, 0)


async def test_unknown_user_acked_and_foreign_producer_ignored(env) -> None:
    user, rid = uuid.uuid4(), uuid.uuid4()
    await env.bus.publish(requested(user, rid))
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload["user_id"] == str(user)
    victim = uuid.uuid4()
    await seed(env, victim)
    await env.bus.publish(requested(victim, uuid.uuid4(), producer="lessons"))
    assert len(await env.events("user.domain.deleted.v1")) == 1
    assert (await rows(env, victim))["evaluations"] == 2
    assert env.bus.dlq == []
