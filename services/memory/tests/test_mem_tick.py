"""memory-tick (INTERNAL_API §1.8, AT-59): вечернее напоминание по поясу плана (раз в день, ≥ 5 к сроку, без
повторения сегодня, лимит за tick, дети — тоже: адресат решает notifications), сроки хранения, доступ, блокировка."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
from sqlalchemy.engine import make_url

from tilhero_common.testing import TEST_ADMIN_URL
from tilhero_memory.domain.tick import TICK_LOCK_CLASS, tick_lock_object

EVENING = datetime(2026, 11, 20, 14, 5, tzinfo=UTC)  # 19:05 в Ташкенте


async def learner(env: Any, *, tz: str = "Asia/Tashkent", reminders: bool = True, due: int = 10,
                  age_band: str = "18+") -> uuid.UUID:
    u = uuid.uuid4()
    await env.get(u, "overview", age_band=age_band)
    await env.plan(u, tz=tz, reminders=reminders)
    await env.lesson_done(u)
    await env.make_review(u)
    if due < 10:
        await env.sql("UPDATE cards SET due_at = :d WHERE card_id IN (SELECT card_id FROM cards WHERE user_id = :u "
                      "ORDER BY card_id LIMIT :n)", d=env.now + timedelta(days=5), u=u, n=10 - due)
    return u


async def test_evening_reminders(env) -> None:  # type: ignore[no-untyped-def]
    a = await learner(env)
    off = await learner(env, reminders=False)
    few = await learner(env, due=4)
    kid = await learner(env, age_band="6-9")
    moscow = await learner(env, tz="Europe/Moscow")
    done = await learner(env)
    s = await env.start(done)
    await env.play(done, s["session_id"])
    await env.post(done, f"review-sessions/{s['session_id']}/finish")
    await env.make_review(done)
    assert (await env.tick())["reminders_sent"] == 0  # 10:00 по Ташкенту — рано
    env.now = EVENING - timedelta(minutes=6)  # 18:59
    assert (await env.tick())["reminders_sent"] == 0
    env.now = EVENING
    assert (await env.tick())["reminders_sent"] == 2
    events = await env.events("memory.reviews.due.v1")
    assert {e.payload["user_id"] for e in events} == {str(a), str(kid)}
    ev = next(e for e in events if e.payload["user_id"] == str(a))
    assert ev.payload == {"user_id": str(a), "local_date": "2026-11-20", "due_count": 10, "timezone": "Asia/Tashkent"}
    env.now = EVENING + timedelta(minutes=8)
    assert (await env.tick())["reminders_sent"] == 0  # раз в день
    env.now = EVENING + timedelta(minutes=11)  # 19:16 — окно закрыто
    assert (await env.tick())["reminders_sent"] == 0
    env.now = datetime(2026, 11, 20, 16, 5, tzinfo=UTC)  # 19:05 в Москве
    assert (await env.tick())["reminders_sent"] == 1
    assert (await env.events("memory.reviews.due.v1", moscow))[0].payload["timezone"] == "Europe/Moscow"
    env.now = EVENING + timedelta(days=1)
    assert (await env.tick())["reminders_sent"] == 3  # новый день (done — повторения сегодня ещё не было)
    assert not await env.events("memory.reviews.due.v1", off) and not await env.events("memory.reviews.due.v1", few)
    assert len(await env.events("memory.reviews.due.v1", done)) == 1


async def test_reminders_budget_per_tick(env) -> None:  # type: ignore[no-untyped-def]
    env.settings.reminders_per_tick = 2
    users = [await learner(env) for _ in range(3)]
    env.now = EVENING
    assert (await env.tick())["reminders_sent"] == 2
    env.now += timedelta(minutes=5)
    assert (await env.tick())["reminders_sent"] == 1  # остаток — следующим tick в том же окне
    assert {e.payload["user_id"] for e in await env.events("memory.reviews.due.v1")} == {str(u) for u in users}


async def test_retention_sweep(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, voice=True)
    await env.lesson_done(user, errors=[{"turn_id": "T1", "evidence": "I from Tashkent",
                                         "correction": "I am from Tashkent.", "error_code": "missing_be",
                                         "severity": "high"}])
    s = await env.start(user)
    await env.play(user, s["session_id"])
    await env.post(user, f"review-sessions/{s['session_id']}/finish")
    r = await env.c.post("/internal/v1/pronunciation", params={"target": "sentence:reading:r-a1-coffee:1:s1"},
                         content=_wav(), headers={**env.h(user), "content-type": "audio/wav"})
    assert r.status_code == 200
    env.now += timedelta(days=89)
    out = await env.tick()
    assert out["error_cards_archived"] == 0 and out["answers_redacted"] == 0
    env.now += timedelta(days=2)
    out = await env.tick()
    assert out["error_cards_archived"] == 1 and out["evidence_wiped"] == 1 and out["answers_redacted"] >= 1
    [(status, evidence)] = await env.sql("SELECT status, error->>'evidence' FROM cards WHERE user_id = :u AND "
                                         "kind = 'error'", u=user)
    assert (status, evidence) == ("archived", None)
    assert await env.sql("SELECT count(*) FROM review_tasks WHERE answer IS NOT NULL") == [(0,)]
    assert await env.sql("SELECT actor, reason FROM review_log WHERE reason = 'retention_90d'") == [
        ("system", "retention_90d")]
    assert (await env.tick())["error_cards_archived"] == 0  # повтор безопасен
    assert (await env.sql("SELECT count(*) FROM pronunciation_attempts"))[0][0] == 1
    env.now += timedelta(days=90)
    assert (await env.tick())["pronunciation_deleted"] == 1


def _wav() -> bytes:
    from mem_testkit import wav

    return wav(1.0)


async def test_tick_auth_and_single_runner(env) -> None:  # type: ignore[no-untyped-def]
    assert (await env.c.post("/internal/v1/memory:tick")).status_code == 401
    r = await env.c.post("/internal/v1/memory:tick", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    r = await env.c.post("/internal/v1/memory:tick", headers=env.h(uuid.uuid4()))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    conn = await asyncpg.connect(make_url(TEST_ADMIN_URL).render_as_string(hide_password=False))
    try:
        await conn.execute("SELECT pg_advisory_lock($1, $2)", TICK_LOCK_CLASS,
                           tick_lock_object(env.settings.db_schema))
        assert await env.tick() == {"skipped": True}
    finally:
        await conn.close()
    assert (await env.tick())["skipped"] is False
