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


TABLES = ("plans", "activities", "slot_marks", "trajectories", "learner_diagnostics", "skill_states",
          "learner_audience", "completed_lessons", "lesson_evaluations", "frozen_days")
EMPTY = dict.fromkeys(TABLES, 0)


async def rows(env, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for table in TABLES:
        [(n,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        out[table] = n
    return out


async def seed(env, user: uuid.UUID) -> None:
    await env.onboard(user, at=MON)
    await env.practice(user, at=datetime(2026, 11, 16, 5, 0, tzinfo=UTC))
    await env.tick(datetime(2026, 11, 17, 19, 0, tzinfo=UTC), since=datetime(2026, 11, 16, 19, 0, tzinfo=UTC))
    # спринт 3: проекции входов траектории и сама траектория
    await env.profile(user)
    await env.diagnostic(user)
    await env.skills(user, {"s.greet": "demonstrated"})
    # спринт 4: пройденный урок из события lessons и его оценка из события assessment
    sid, eid = uuid.uuid4(), uuid.uuid4()
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(sid), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
        "lesson_id": "l-be", "scenario_id": None, "asset_id": None, "status": "completed", "outcome": "success",
        "minutes": 15, "local_date": "2026-11-16", "evaluation_id": str(eid), "passed": True,
        "practice_only": False, "finished_at": "2026-11-16T05:30:00Z"}, producer="lessons")
    await env.publish("assessment.completed.v1", {
        "evaluation_id": str(eid), "user_id": str(user), "pair_id": "ru-en", "session_id": str(sid), "kind": "lesson",
        "skill_outcomes": [], "passed": True, "practice_only": False, "supersedes": None,
        "created_at": "2026-11-16T05:30:00Z"}, producer="assessment")
    await env.trajectory(user)
    # спринт 6: пропуск вт (tick выше) закрыт заморозкой серии
    await env.publish("game.streak.frozen.v1", {
        "user_id": str(user), "local_date": "2026-11-17", "op_id": str(uuid.uuid4()), "freeze_left": 1,
        "frozen_at": "2026-11-17T19:05:00Z"}, producer="gamification")
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
    assert await rows(env, user) == EMPTY
    assert await rows(env, other) == before_other
    # после удаления план не воскрешается запросом с ещё живым токеном
    for method, path in (("GET", "/internal/v1/me/plan"), ("PATCH", "/internal/v1/me/plan"),
                         ("GET", "/internal/v1/me/plan/today")):
        r = await env.c.request(method, path, json={"goal": "work"}, headers=env.h(user))
        assert r.status_code == 410 and r.json()["code"] == "USER_DELETED", path
    r = await env.practice(user, at=datetime(2026, 11, 18, 5, 0, tzinfo=UTC))
    assert r.status_code == 410
    assert await rows(env, user) == EMPTY
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
    assert await rows(env, user) == EMPTY


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


async def test_deletion_from_other_producer_is_ignored(env, caplog) -> None:
    """P-7: сагу ведёт только identity-consent; событие чужого издателя подтверждается шине без действия и без ACK,
    в логе — только тип события и издатель (без user_id)."""
    user, rid = uuid.uuid4(), uuid.uuid4()
    await seed(env, user)
    before = await rows(env, user)
    for producer in ("support", "notifications", "learning-plan"):
        ev = make_envelope("user.deletion.requested.v1",
                           {"user_id": str(user), "request_id": str(rid), "requested_at": "2026-11-18T09:00:00Z"},
                           producer=producer)
        await env.bus.publish(ev)
    assert await env.events("user.domain.deleted.v1") == []
    assert await rows(env, user) == before
    assert env.bus.dlq == []
    warned = [r for r in caplog.records if r.getMessage() == "deletion request from unexpected producer ignored"]
    assert len(warned) == 3 and all(str(user) not in r.getMessage() + str(r.__dict__) for r in warned)
    # тот же запрос от identity-consent исполняется
    await env.bus.publish(requested(user, rid))
    assert len(await env.events("user.domain.deleted.v1")) == 1
    assert await rows(env, user) == EMPTY
