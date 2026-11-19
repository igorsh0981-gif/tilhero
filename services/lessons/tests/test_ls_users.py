"""Сага удаления, проекция профиля («липкий» детский режим), доверенный издатель, планировщик."""

from __future__ import annotations

import uuid

from conftest import Env

from tilhero_common.messaging import make_envelope


async def _publish(env: Env, event_type: str, payload: dict, producer: str = "identity-consent") -> None:
    await env.bus.publish(make_envelope(event_type, payload, producer=producer))
    await env.flush()


async def test_deletion_saga(env: Env, user: uuid.UUID) -> None:
    await env.complete_lesson(user, items="wrong")
    s = await env.lesson(user, "l-02-where-from")
    kid = uuid.uuid4()
    await env.lesson(kid, account=user)  # сессия детского профиля, начатая из аккаунта
    other = uuid.uuid4()
    await env.lesson(other)
    request_id = str(uuid.uuid4())
    payload = {"user_id": str(user), "request_id": request_id, "requested_at": "2026-11-19T10:00:00Z"}
    await _publish(env, "user.deletion.requested.v1", payload)
    for table in ("sessions", "review_items"):
        rows = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        assert rows[0][0] == 0, table
    for table in ("steps", "turns", "status_history"):
        rows = await env.sql(f"SELECT count(*) FROM {table} WHERE session_id = :s",  # noqa: S608
                             s=uuid.UUID(s["session_id"]))
        assert rows[0][0] == 0, table
    assert (await env.sql("SELECT count(*) FROM sessions WHERE account_id = :u", u=user))[0][0] == 0
    assert (await env.sql("SELECT count(*) FROM sessions WHERE user_id = :u", u=other))[0][0] == 1
    acks = await env.events("user.domain.deleted.v1")
    assert [(a.payload["domain"], a.payload["mode"], a.payload["request_id"]) for a in acks] == [
        ("lessons", "deleted", request_id)]
    r = await env.c.get("/internal/v1/sessions/active", headers=env.h(user))
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    # повтор саги снова подтверждается; профиль после удаления не воскрешается
    await _publish(env, "user.deletion.requested.v1", {**payload, "attempt": 2})
    assert len(await env.events("user.domain.deleted.v1")) == 2
    await _publish(env, "user.profile.created.v1", {"user_id": str(user), "kind": "account", "age_band": "18+",
                                                    "created_at": "2026-11-19T10:00:00Z"})
    assert (await env.sql("SELECT count(*) FROM learner_profiles WHERE user_id = :u", u=user))[0][0] == 0


async def test_untrusted_producer_ignored(env: Env, user: uuid.UUID) -> None:
    await env.lesson(user)
    await _publish(env, "user.deletion.requested.v1",
                   {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-19T10:00:00Z"},
                   producer="social")
    assert (await env.sql("SELECT count(*) FROM sessions WHERE user_id = :u", u=user))[0][0] == 1
    assert await env.events("user.domain.deleted.v1") == []


async def test_profile_projection_makes_kids_sticky(env: Env, user: uuid.UUID) -> None:
    await _publish(env, "user.profile.created.v1", {"user_id": str(user), "kind": "child", "age_band": "10-13",
                                                    "created_at": "2026-11-19T06:00:00Z"})
    s = await env.lesson(user, age_band="18+", params={"audience": "adults"})
    assert s["ai_mode"] == "choices"
    step = await env.current(user, s["session_id"])
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/steps/{step['step_id']}", json={"text": "Hi"},
                         headers=env.h(user))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    # возраст из проекции, если BFF не передал
    teen = uuid.uuid4()
    await _publish(env, "user.profile.created.v1", {"user_id": str(teen), "kind": "account", "age_band": "14-17",
                                                    "created_at": "2026-11-19T06:00:00Z"})
    s = await env.lesson(teen, "l-03-phone-number", age_band=None)
    assert s["ai_mode"] == "full"
    # запоздавшее событие не откатывает новое значение
    await _publish(env, "user.profile.updated.v1", {"user_id": str(teen), "changed_fields": ["age_band"],
                                                    "age_band": "18+"})
    rows = await env.sql("SELECT age_band FROM learner_profiles WHERE user_id = :u", u=teen)
    assert rows[0][0] == "18+"


async def test_scheduler_auth(env: Env, user: uuid.UUID) -> None:
    r = await env.c.post("/internal/v1/lessons:tick")
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    r = await env.c.post("/internal/v1/lessons:tick", headers={"Authorization": "Bearer wrong-token"})
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/lessons:tick", headers=env.h(user))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    out = await env.tick()
    assert out == {"auto_paused": 0, "expired": 0, "redacted_turns": 0, "redacted_answers": 0,
                   "redacted_evaluations": 0, "evaluations_sent": 0, "evaluations_failed": 0,
                   "evaluations_given_up": 0}
