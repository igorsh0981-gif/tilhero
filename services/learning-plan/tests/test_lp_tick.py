"""plan:tick (AT-07, AT-08): напоминание в момент слота по местному времени, пропуск после местной полуночи,
занятие в тот же день отменяет пропуск, consecutive_missed, повтор без дублей, смена графика между тиками,
часовые пояса и DST, окно ≤ 24 ч, параллельные запуски, вход только по SCHEDULER_TOKEN."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import SecretStr, ValidationError

from tilhero_learning_plan.settings import Settings

# Ташкент UTC+5: слот 19:00 = 14:00Z, местная полночь = 19:00Z предыдущей даты UTC
MON_MORNING = datetime(2026, 11, 16, 3, 0, tzinfo=UTC)  # пн 08:00 Ташкент


def z(day: int, hour: int, minute: int = 0, month: int = 11) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


async def test_scheduler_auth(env, user) -> None:
    path = "/internal/v1/plan:tick"
    r = await env.c.post(path)
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    assert (await env.c.post(path, headers={"authorization": "Bearer wrong"})).status_code == 401
    assert (await env.c.post(path, headers={"authorization": f"Basic {'s' * 43}"})).status_code == 401
    # внутренний JWT любого сервиса (даже telegram-bff) → 403: вызывающий — только планировщик
    for issuer in ("telegram-bff", "notifications", "learning-plan"):
        r = await env.c.post(path, headers=env.h(user, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    assert (await env.c.post(path, headers={"x-internal-token": "garbage"})).status_code == 401
    assert (await env.c.post(path, headers=env.sched)).status_code == 200
    # пустой SCHEDULER_TOKEN выключает вход
    env.settings.scheduler_token = SecretStr("")
    assert (await env.c.post(path, headers=env.sched)).status_code == 401
    assert (await env.c.post(path, headers={"authorization": "Bearer "})).status_code == 401


async def test_reminder_at_slot_once(env, user) -> None:
    await env.onboard(user, at=MON_MORNING)
    assert await env.tick(z(16, 13, 55), since=z(16, 13, 50)) == {"plans_checked": 1, "reminders": 0, "missed": 0}
    assert await env.tick(z(16, 14, 0)) == {"plans_checked": 1, "reminders": 1, "missed": 0}
    [ev] = await env.events("learning.reminder.due.v1", user)
    assert ev.payload == {"user_id": str(user), "local_date": "2026-11-16", "slot_time": "19:00",
                          "timezone": "Asia/Tashkent", "duration_min": 20, "streak_days": 0}
    # повтор того же окна (n8n retry, сбой после записи) не дублирует; следующее окно — пусто
    assert (await env.tick(z(16, 14, 0), since=z(16, 13, 55)))["reminders"] == 0
    assert (await env.tick(z(16, 14, 5)))["reminders"] == 0
    assert len(await env.events("learning.reminder.due.v1", user)) == 1
    [(last,)] = await env.sql("SELECT last_tick_at FROM tick_state")
    assert last == z(16, 14, 5)


async def test_no_reminder_without_opt_in_or_after_activity(env) -> None:
    off, done, fresh = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await env.onboard(off, at=MON_MORNING, reminders=False)
    await env.onboard(done, at=MON_MORNING)
    await env.onboard(fresh, at=MON_MORNING)
    await env.practice(done, at=z(16, 10, 0))
    # не онбордингованный ученик не проверяется вовсе
    await env.c.get("/internal/v1/me/plan", headers=env.h(uuid.uuid4()))
    r = await env.tick(z(16, 14, 0), since=z(16, 13, 55))
    assert r == {"plans_checked": 3, "reminders": 1, "missed": 0}
    assert [e.payload["user_id"] for e in await env.events("learning.reminder.due.v1")] == [str(fresh)]
    # после полуночи: пропуск выпускается и без reminders_enabled, а занятие в тот же день отменяет пропуск
    r = await env.tick(z(16, 19, 0), since=z(16, 18, 55))
    assert r["missed"] == 2
    assert sorted(e.payload["user_id"] for e in await env.events("learning.session.missed.v1")) == sorted(
        [str(off), str(fresh)])


async def test_missed_after_local_midnight_and_same_day_activity_cancels(env) -> None:
    lazy, late = uuid.uuid4(), uuid.uuid4()
    await env.onboard(lazy, at=MON_MORNING)
    await env.onboard(late, at=MON_MORNING)
    await env.tick(z(16, 14, 0), since=z(16, 13, 55))
    await env.practice(late, at=z(16, 18, 58))  # 23:58 местного — тот же день
    assert (await env.tick(z(16, 18, 55), since=z(16, 18, 50)))["missed"] == 0  # день ещё не кончился
    assert (await env.tick(z(16, 19, 0)))["missed"] == 1
    [ev] = await env.events("learning.session.missed.v1")
    assert ev.payload == {"user_id": str(lazy), "local_date": "2026-11-16", "slot_time": "19:00",
                          "timezone": "Asia/Tashkent", "consecutive_missed": 1, "next_slot_date": "2026-11-17"}
    # занятие после полуночи — уже следующий день, пропуск за понедельник не отменяет
    await env.practice(lazy, at=z(16, 19, 1))
    assert (await env.tick(z(16, 19, 5), since=z(16, 18, 55)))["missed"] == 0  # повтор окна — без дублей
    assert len(await env.events("learning.session.missed.v1")) == 1


async def test_consecutive_missed_counts_and_resets(env, user) -> None:
    await env.onboard(user, at=MON_MORNING)
    t = z(16, 19, 0)
    await env.set_last_tick(t - timedelta(minutes=5))
    for _ in range(3):  # пн, вт, ср — без занятий
        await env.tick(t)
        t += timedelta(days=1)
    await env.practice(user, at=z(19, 6, 0))  # чт — занятие
    await env.tick(t)  # конец чт
    t += timedelta(days=1)
    await env.tick(t)  # конец пт — снова пропуск
    events = await env.events("learning.session.missed.v1", user)
    assert [(e.payload["local_date"], e.payload["consecutive_missed"]) for e in events] == [
        ("2026-11-16", 1), ("2026-11-17", 2), ("2026-11-18", 3), ("2026-11-20", 1)]
    # серия в напоминании считает дни с занятием после последнего пропуска
    await env.tick(z(21, 14, 0), since=z(21, 13, 55))
    [rem] = (await env.events("learning.reminder.due.v1", user))[-1:]
    assert rem.payload["local_date"] == "2026-11-21" and rem.payload["streak_days"] == 0
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    week = {d["local_date"]: (d["done"], d["missed"]) for d in today["week"]}
    assert week["2026-11-19"] == (True, False) and week["2026-11-20"] == (False, True)


async def test_weekdays_schedule_and_next_slot(env, user) -> None:
    await env.onboard(user, at=MON_MORNING, preset="weekdays", time="08:00")
    # пт 20.11: напоминание в 08:00 (03:00Z), пропуск в полночь, следующий слот — пн 23.11
    await env.tick(z(20, 3, 0), since=z(20, 2, 55))
    await env.tick(z(20, 19, 0), since=z(20, 18, 55))
    # сб и вс вне графика: целые сутки окон без событий
    t = z(20, 19, 0)
    while t < z(22, 19, 0):
        t += timedelta(hours=6)
        await env.tick(t)
    rem = await env.events("learning.reminder.due.v1", user)
    missed = await env.events("learning.session.missed.v1", user)
    assert [e.payload["local_date"] for e in rem] == ["2026-11-20"]
    assert [(e.payload["local_date"], e.payload["next_slot_date"]) for e in missed] == [("2026-11-20", "2026-11-23")]


async def test_onboarding_after_slot_does_not_count_today(env, user) -> None:
    await env.onboard(user, at=z(16, 15, 0))  # пн 20:00 местного — слот 19:00 уже прошёл
    assert (await env.tick(z(16, 15, 5), since=z(16, 13, 0)))["reminders"] == 0
    assert (await env.tick(z(16, 19, 0)))["missed"] == 0  # за понедельник «пропуска» нет
    assert (await env.tick(z(17, 14, 0)))["reminders"] == 1  # со вторника — по графику


async def test_schedule_change_between_ticks(env) -> None:
    earlier, moved = uuid.uuid4(), uuid.uuid4()
    await env.onboard(earlier, at=MON_MORNING)
    await env.onboard(moved, at=MON_MORNING)
    await env.set_last_tick(z(16, 4, 0))
    t = z(16, 4, 0)

    async def run_until(end: datetime) -> None:
        nonlocal t
        while t < end:
            t += timedelta(minutes=30)
            await env.tick(t)

    await run_until(z(16, 14, 0))  # пн 19:00 Ташкент — напоминание обоим
    # «moved» после напоминания переезжает в Москву: там 19:00 того же дня = 16:00Z — напоминание не повторяется
    env.now = z(16, 14, 10)
    assert (await env.c.patch("/internal/v1/me/plan", json={"schedule": {"timezone": "Europe/Moscow"}},
                              headers=env.h(moved))).status_code == 200
    await run_until(z(17, 5, 0))
    # вт 10:00 Ташкент: «earlier» переносит занятие на 08:00 (уже прошло) — сегодня слота нет, со среды — в 08:00
    assert (await env.c.patch("/internal/v1/me/plan", json={"schedule": {"preferred_time": "08:00"}},
                              headers=env.h(earlier))).status_code == 200
    await run_until(z(18, 22, 0))
    rem = [(e.payload["user_id"], e.payload["local_date"], e.payload["slot_time"], e.payload["timezone"])
           for e in await env.events("learning.reminder.due.v1")]
    assert [r for r in rem if r[0] == str(moved)] == [
        (str(moved), "2026-11-16", "19:00", "Asia/Tashkent"), (str(moved), "2026-11-17", "19:00", "Europe/Moscow"),
        (str(moved), "2026-11-18", "19:00", "Europe/Moscow")]
    assert [r for r in rem if r[0] == str(earlier)] == [
        (str(earlier), "2026-11-16", "19:00", "Asia/Tashkent"), (str(earlier), "2026-11-18", "08:00", "Asia/Tashkent")]
    missed = [(e.payload["user_id"], e.payload["local_date"]) for e in await env.events("learning.session.missed.v1")]
    # пн и ср пропущены обоими; вт у «earlier» слота не было (перенос на прошедшее время) — пропуска за вт нет
    assert sorted(missed) == sorted([(str(earlier), "2026-11-16"), (str(earlier), "2026-11-18"),
                                     (str(moved), "2026-11-16"), (str(moved), "2026-11-17"),
                                     (str(moved), "2026-11-18")])


async def test_new_york_dst_gap_reminder_once(env, user) -> None:
    """08.03.2026: 02:00 → 03:00 в Нью-Йорке. Слот 02:30 — один раз в 07:30Z; полночь и следующие сутки — по EDT."""
    await env.onboard(user, at=z(6, 12, 0, month=3), time="02:30", tz="America/New_York")
    await env.set_last_tick(z(7, 0, 0, month=3))
    t = z(7, 0, 0, month=3)
    while t < z(10, 0, 0, month=3):
        t += timedelta(minutes=5)
        await env.tick(t)
    rem = [e for e in await env.events("learning.reminder.due.v1", user)]
    assert [e.payload["local_date"] for e in rem] == ["2026-03-07", "2026-03-08", "2026-03-09"]
    missed = await env.events("learning.session.missed.v1", user)
    assert [e.payload["local_date"] for e in missed] == ["2026-03-07", "2026-03-08"]
    marks = await env.sql("SELECT local_date, kind, emitted_at FROM slot_marks ORDER BY emitted_at")
    emitted = {(str(d), k): at for d, k, at in marks}
    assert emitted[("2026-03-07", "reminder")] == z(7, 7, 30, month=3)  # 02:30 EST
    assert emitted[("2026-03-08", "reminder")] == z(8, 7, 30, month=3)  # 03:30 EDT (02:30 не существует)
    assert emitted[("2026-03-09", "reminder")] == z(9, 6, 30, month=3)  # 02:30 EDT
    assert emitted[("2026-03-08", "missed")] == z(9, 4, 0, month=3)  # полночь EDT


async def test_window_capped_at_24h(env, user) -> None:
    await env.onboard(user, at=MON_MORNING)
    r = await env.tick(z(20, 15, 0), since=z(16, 0, 0))  # простой 4,5 дня
    assert r == {"plans_checked": 1, "reminders": 1, "missed": 1}  # только последние 24 ч: пропуск чт, напоминание пт
    assert [e.payload["local_date"] for e in await env.events("learning.session.missed.v1", user)] == ["2026-11-19"]


async def test_clock_behind_and_concurrent_ticks(env, user) -> None:
    await env.onboard(user, at=MON_MORNING)
    await env.set_last_tick(z(16, 13, 0))
    env.now = z(16, 12, 0)  # часы позади last_tick_at
    r = await env.c.post("/internal/v1/plan:tick", headers=env.sched)
    assert r.json() == {"plans_checked": 0, "reminders": 0, "missed": 0, "skipped": False}
    [(last,)] = await env.sql("SELECT last_tick_at FROM tick_state")
    assert last == z(16, 13, 0)  # назад не двигается
    env.now = z(16, 14, 1)
    results = await asyncio.gather(*[env.c.post("/internal/v1/plan:tick", headers=env.sched) for _ in range(4)])
    assert [r.status_code for r in results] == [200] * 4
    assert sum(r.json()["reminders"] for r in results) == 1
    assert len(await env.events("learning.reminder.due.v1", user)) == 1


async def test_late_slot_before_midnight(env, user) -> None:
    await env.onboard(user, at=MON_MORNING, time="23:55")
    await env.tick(z(16, 18, 55), since=z(16, 18, 50))  # 23:55 местного
    await env.tick(z(16, 19, 0))  # 00:00 — пропуск
    assert [e.payload["local_date"] for e in await env.events("learning.reminder.due.v1", user)] == ["2026-11-16"]
    assert [e.payload["local_date"] for e in await env.events("learning.session.missed.v1", user)] == ["2026-11-16"]


def test_scheduler_token_length_guard_in_secure_env() -> None:
    """P-8: в stage/prod SCHEDULER_TOKEN пустой (вход выключен) или не короче 32 символов; dev/test — любой."""
    prod = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43,
            "catalog_url": "http://catalog.railway.internal:8110"}
    for env_name in ("stage", "prod"):
        for short in ("abc", "x" * 31, " " + "y" * 31 + " "):
            with pytest.raises(ValidationError, match="SCHEDULER_TOKEN"):
                Settings(env=env_name, scheduler_token=short, **prod)
        assert Settings(env=env_name, scheduler_token="z" * 32, **prod).scheduler_token.get_secret_value() == "z" * 32
        assert Settings(env=env_name, scheduler_token="", **prod).scheduler_token.get_secret_value() == ""
    assert Settings(env="test", internal_jwt_secret="t" * 40, scheduler_token="abc").scheduler_token
