"""Учёт занятий и «план на сегодня»: Idempotency-Key, local_date по зоне плана (полночь), серия и неделя."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

MON = datetime(2026, 11, 16, 8, 0, tzinfo=UTC)  # пн 13:00 Ташкент


async def test_practice_recorded_with_event(env, user) -> None:
    r = await env.practice(user, at=MON, minutes=12, key="practice-key-1")
    assert r.status_code == 200, r.text
    today = r.json()
    assert today["local_date"] == "2026-11-16" and today["minutes_today"] == 12 and today["done_today"] is True
    assert today["is_scheduled_today"] is True and today["slot_time"] == "19:00" and today["duration_min"] == 20
    assert today["streak_days"] == 1 and today["next_slot"] == {"local_date": "2026-11-17", "time": "19:00"}
    assert today["week"][0] == {"local_date": "2026-11-16", "scheduled": True, "done": True, "missed": False}
    [ev] = await env.events("learning.activity.recorded.v1", user)
    assert ev.payload == {"user_id": str(user), "activity_id": ev.payload["activity_id"], "local_date": "2026-11-16",
                          "kind": "practice", "minutes": 12, "recorded_at": "2026-11-16T08:00:00Z"}
    # план по умолчанию создан при первом занятии
    assert (await env.c.get("/internal/v1/me/plan", headers=env.h(user))).status_code == 200


async def test_idempotency_key(env, user) -> None:
    first = await env.practice(user, at=MON, minutes=10, key="k-12345678")
    env.now = MON + timedelta(minutes=1)
    again = await env.practice(user, at=env.now, minutes=10, key="k-12345678")
    assert again.status_code == 200 and again.headers.get("idempotent-replayed") == "true"
    assert again.json()["minutes_today"] == first.json()["minutes_today"] == 10
    assert len(await env.events("learning.activity.recorded.v1", user)) == 1
    reused = await env.practice(user, at=env.now, minutes=20, key="k-12345678")
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # тот же ключ другого ученика — независимая запись
    other = uuid.uuid4()
    assert (await env.practice(other, at=env.now, minutes=5, key="k-12345678")).json()["minutes_today"] == 5
    missing = await env.c.post("/internal/v1/me/activities", headers=env.h(user), json={"kind": "practice",
                                                                                         "minutes": 5})
    assert missing.status_code == 400 and missing.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    bad = await env.c.post("/internal/v1/me/activities", headers={**env.h(user), "Idempotency-Key": "short"},
                           json={"kind": "practice", "minutes": 5})
    assert bad.status_code == 422 and bad.json()["code"] == "IDEMPOTENCY_KEY_INVALID"


async def test_local_date_follows_plan_timezone_across_midnight(env) -> None:
    tashkent, moscow = uuid.uuid4(), uuid.uuid4()
    await env.c.patch("/internal/v1/me/plan", json={"schedule": {"timezone": "Europe/Moscow"}}, headers=env.h(moscow))
    late = datetime(2026, 11, 16, 19, 30, tzinfo=UTC)  # 00:30 вт в Ташкенте, 22:30 пн в Москве
    assert (await env.practice(tashkent, at=late)).json()["local_date"] == "2026-11-17"
    assert (await env.practice(moscow, at=late)).json()["local_date"] == "2026-11-16"
    just_before = datetime(2026, 11, 16, 18, 59, 59, tzinfo=UTC)  # 23:59:59 пн в Ташкенте
    t2 = uuid.uuid4()
    assert (await env.practice(t2, at=just_before)).json()["local_date"] == "2026-11-16"
    env.now = datetime(2026, 11, 16, 19, 0, tzinfo=UTC)  # ровно полночь
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(t2))).json()
    assert today["local_date"] == "2026-11-17" and today["done_today"] is False and today["streak_days"] == 1


async def test_occurred_at_bounds(env, user) -> None:
    env.now = MON

    async def post(body):
        return await env.c.post("/internal/v1/me/activities", json=body,
                                headers={**env.h(user), "Idempotency-Key": str(uuid.uuid4())})

    future = await post({"kind": "lesson", "minutes": 20, "occurred_at": "2026-11-16T08:10:00Z"})
    assert future.status_code == 422 and future.json()["code"] == "ACTIVITY_INVALID"
    old = await post({"kind": "lesson", "minutes": 20, "occurred_at": "2026-11-08T08:00:00Z"})
    assert old.status_code == 422 and old.json()["details"] == {"field": "occurred_at", "reason": "out_of_range"}
    naive = await post({"kind": "lesson", "minutes": 20, "occurred_at": "2026-11-16T07:00:00"})
    assert naive.status_code == 422 and naive.json()["code"] == "VALIDATION_ERROR"
    yesterday = await post({"kind": "review", "minutes": 5, "occurred_at": "2026-11-15T18:30:00+00:00"})
    assert yesterday.status_code == 200  # вс 23:30 Ташкент → дата воскресенья
    [ev] = await env.events("learning.activity.recorded.v1", user)
    assert ev.payload["local_date"] == "2026-11-15" and ev.payload["kind"] == "review"
    assert yesterday.json()["done_today"] is False and yesterday.json()["streak_days"] == 1
    skew = await post({"kind": "practice", "minutes": 1, "occurred_at": "2026-11-16T08:04:00Z"})
    assert skew.status_code == 200  # допуск часов клиента 5 мин


async def test_activity_validation(env, user) -> None:
    for body in ({"kind": "practice", "minutes": 0}, {"kind": "practice", "minutes": 241},
                 {"kind": "game", "minutes": 5}, {"kind": "practice"}, {"kind": "practice", "minutes": 5, "x": 1},
                 {"kind": "practice", "minutes": 5, "user_id": str(uuid.uuid4())}):
        r = await env.c.post("/internal/v1/me/activities", json=body,
                             headers={**env.h(user), "Idempotency-Key": str(uuid.uuid4())})
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", body
    ok = await env.c.post("/internal/v1/me/activities", json={"kind": "practice", "minutes": 240},
                          headers={**env.h(user), "Idempotency-Key": str(uuid.uuid4())})
    assert ok.status_code == 200 and ok.json()["minutes_today"] == 240


async def test_streak_and_week_use_missed_marks(env, user) -> None:
    await env.c.patch("/internal/v1/me/plan", json={"schedule": {"preset": "custom", "days": [1, 3, 5]}},
                      headers=env.h(user))
    # пн и ср — занятия, вт (вне графика) — ничего, сб — занятие вне графика
    for day in (16, 18, 21):
        await env.practice(user, at=datetime(2026, 11, day, 8, 0, tzinfo=UTC))
    env.now = datetime(2026, 11, 22, 8, 0, tzinfo=UTC)  # вс
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    # пт без занятия, но пропуск ещё не выпущен (tick) → серия не прервана
    assert today["streak_days"] == 3 and today["next_slot"] == {"local_date": "2026-11-23", "time": "19:00"}
    await env.sql("INSERT INTO slot_marks (user_id, local_date, kind) VALUES (:u, '2026-11-20', 'missed')", u=user)
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    assert today["streak_days"] == 1  # только сб после пропуска пт
    week = {d["local_date"]: d for d in today["week"]}
    assert week["2026-11-20"] == {"local_date": "2026-11-20", "scheduled": True, "done": False, "missed": True}
    assert week["2026-11-21"] == {"local_date": "2026-11-21", "scheduled": False, "done": True, "missed": False}
    assert week["2026-11-17"]["missed"] is False
    # занятие задним числом за пт снимает пропуск в неделе и серию больше не рвёт
    env.now = datetime(2026, 11, 22, 8, 0, tzinfo=UTC)
    r = await env.c.post("/internal/v1/me/activities", json={"kind": "lesson", "minutes": 20,
                                                              "occurred_at": "2026-11-20T10:00:00Z"},
                         headers={**env.h(user), "Idempotency-Key": str(uuid.uuid4())})
    assert r.json()["streak_days"] == 4
    assert {d["local_date"]: d for d in r.json()["week"]}["2026-11-20"]["missed"] is False


async def test_today_isolated_between_users(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await env.practice(a, at=MON, minutes=30)
    tb = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(b))).json()
    assert tb["minutes_today"] == 0 and tb["done_today"] is False and tb["streak_days"] == 0
