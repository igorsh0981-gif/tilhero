"""Сага удаления (INTERNAL_API §1.12, AT-62): всё персональное удаляется физически, ACK user.domain.deleted.v1
{domain: memory}; общий кеш переводов остаётся; события и запросы после удаления данных не воскрешают."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from mem_testkit import wav

from tilhero_memory.domain.glossary import gloss_key

TABLES = ("cards", "review_log", "review_sessions", "retention_checks", "pronunciation_attempts",
          "learner_projection", "skill_projection", "reminders_sent", "activity_days", "feed_log", "idempotency")


async def counts(env: Any, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for t in TABLES:
        out[t] = (await env.sql(f"SELECT count(*) FROM {t} WHERE user_id = :u", u=user))[0][0]  # noqa: S608
    out["review_tasks"] = (await env.sql("SELECT count(*) FROM review_tasks t JOIN review_sessions s USING "
                                         "(session_id) WHERE s.user_id = :u", u=user))[0][0]
    return out


async def deletion(env: Any, user: uuid.UUID, producer: str = "identity-consent") -> str:
    request_id = str(uuid.uuid4())
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": request_id,
                                                     "requested_at": "2026-11-20T10:00:00Z"}, producer)
    return request_id


async def test_deletion_saga(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    keep = uuid.uuid4()
    for u in (user, keep):
        env.identity.set(u, voice=True)
        await env.plan(u)
        await env.lesson_done(u, errors=[{"turn_id": "T1", "evidence": "I from Tashkent",
                                          "correction": "I am from Tashkent.", "error_code": "missing_be",
                                          "severity": "high"}])
        s = await env.start(u)
        await env.play(u, s["session_id"])
        await env.post(u, f"review-sessions/{s['session_id']}/finish")
        await env.post(u, "cards", {"text_en": "barista", "source": {"kind": "reading", "key": "r-a1-coffee",
                                                                     "version": 1}}, 201, key=f"k-{u}")
        r = await env.c.post("/internal/v1/pronunciation", params={"target": "sentence:reading:r-a1-coffee:1:s1"},
                             content=wav(), headers={**env.h(u), "content-type": "audio/wav"})
        assert r.status_code == 200
        await env.publish("skills.state.changed.v1", {
            "user_id": str(u), "pair_id": "ru-en", "occurred_at": "2026-11-20T05:00:00Z",
            "changes": [{"skill_id": "en.func.greet", "from": "learning", "to": "demonstrated", "source": "lesson"}]},
            "diagnostics")
    await env.sql("INSERT INTO reminders_sent (user_id, local_date, due_count, sent_at) VALUES (:u, :d, 5, :t)",
                  u=user, d=env.now.date(), t=env.now)
    before = await counts(env, user)
    assert all(v > 0 for v in before.values()), before
    cache = gloss_key(env.settings, "ru-en", "barista")
    assert await env.runtime.redis.exists(cache)

    await deletion(env, user, producer="social")  # чужой издатель саги — игнор
    assert await counts(env, user) == before
    request_id = await deletion(env, user)
    assert all(v == 0 for v in (await counts(env, user)).values())
    assert all(v > 0 for k, v in (await counts(env, keep)).items() if k != "reminders_sent")
    [ack] = await env.events("user.domain.deleted.v1", user)
    assert ack.payload == {"user_id": str(user), "request_id": request_id, "domain": "memory", "mode": "deleted"}
    assert await env.runtime.redis.exists(cache)  # общий кеш переводов не персональный — остаётся
    r = await env.c.get("/internal/v1/overview", headers=env.h(user))
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    r = await env.c.post("/internal/v1/review-sessions", headers={**env.h(user), "Idempotency-Key": "k-after-del"})
    assert r.status_code == 410
    # события после удаления данных не воскрешают
    await env.lesson_done(user)
    await env.plan(user)
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
        "status": "completed", "minutes": 5, "practice_only": False, "local_date": "2026-11-20",
        "finished_at": "2026-11-20T10:00:00Z"}, "lessons")
    assert all(v == 0 for v in (await counts(env, user)).values())
    await deletion(env, user)  # повтор саги — снова ACK
    assert len(await env.events("user.domain.deleted.v1", user)) == 2
    env.now += timedelta(days=1)
    assert (await env.get(keep, "overview"))["total_cards"] == 12  # 10 слов + ошибка + barista
