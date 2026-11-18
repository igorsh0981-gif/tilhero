"""plan:tick пачками (ревью P-1): повтор во время идущего tick не ждёт и отвечает skipped; у каждой пачки своя
транзакция, last_tick_at — после всех пачек, сбой посреди прохода не дублирует и не теряет события; серия и
consecutive_missed пакетными запросами совпадают с поштучным расчётом; нагрузка 10 000 планов."""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from tilhero_learning_plan.domain import tick as tick_mod
from tilhero_learning_plan.domain.plans import streak_days


def z(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC)


async def _tick_raw(env) -> dict:
    r = await env.c.post("/internal/v1/plan:tick", headers=env.sched)
    assert r.status_code == 200, r.text
    return r.json()


async def test_retry_during_running_tick_is_skipped_without_waiting(env, user, monkeypatch) -> None:
    await env.onboard(user, at=z(16, 3))
    await env.set_last_tick(z(16, 13, 55))
    entered, release = asyncio.Event(), asyncio.Event()
    original = tick_mod._process_batch

    async def slow_batch(*args, **kwargs):
        entered.set()
        await release.wait()
        await original(*args, **kwargs)

    monkeypatch.setattr(tick_mod, "_process_batch", slow_batch)
    env.now = z(16, 14, 0)
    first = asyncio.create_task(env.c.post("/internal/v1/plan:tick", headers=env.sched))
    await asyncio.wait_for(entered.wait(), 5)
    # повтор n8n, пока первый держит блокировку: сразу 200 skipped, окно и события не тронуты
    started = time.perf_counter()
    for _ in range(2):
        assert await _tick_raw(env) == {"plans_checked": 0, "reminders": 0, "missed": 0, "skipped": True}
    assert time.perf_counter() - started < 2
    [(last,)] = await env.sql("SELECT last_tick_at FROM tick_state")
    assert last == z(16, 13, 55)
    release.set()
    r = await asyncio.wait_for(first, 10)
    assert r.json() == {"plans_checked": 1, "reminders": 1, "missed": 0, "skipped": False}
    # блокировка снята: следующий вызов работает (окно пустое), напоминание одно
    assert await env.tick(z(16, 14, 5)) == {"plans_checked": 1, "reminders": 0, "missed": 0}
    assert len(await env.events("learning.reminder.due.v1", user)) == 1


async def test_batches_commit_separately_and_failure_does_not_duplicate(env, monkeypatch) -> None:
    users = [uuid.uuid4() for _ in range(25)]
    for u in users:
        await env.onboard(u, at=z(16, 3))
    env.settings.tick_batch_size = 10
    await env.set_last_tick(z(16, 13, 55))
    original = tick_mod._process_batch
    calls = 0

    async def failing_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("boom")
        await original(*args, **kwargs)

    monkeypatch.setattr(tick_mod, "_process_batch", failing_second)
    env.now = z(16, 14, 0)
    with pytest.raises(RuntimeError, match="boom"):  # 500 INTERNAL_ERROR; ASGITransport пробрасывает исключение
        await env.c.post("/internal/v1/plan:tick", headers=env.sched)
    # первая пачка зафиксирована, окно не сдвинуто
    assert len(await env.events("learning.reminder.due.v1")) == 10
    [(n,)] = await env.sql("SELECT count(*) FROM slot_marks")
    assert n == 10
    [(last,)] = await env.sql("SELECT last_tick_at FROM tick_state")
    assert last == z(16, 13, 55)
    monkeypatch.setattr(tick_mod, "_process_batch", original)
    # блокировка снята после сбоя; следующий проход того же окна дописывает остальные 15 без дублей
    assert await env.tick(z(16, 14, 5)) == {"plans_checked": 25, "reminders": 15, "missed": 0}
    rem = await env.events("learning.reminder.due.v1")
    assert sorted(e.payload["user_id"] for e in rem) == sorted(str(u) for u in users)
    [(last,)] = await env.sql("SELECT last_tick_at FROM tick_state")
    assert last == z(16, 14, 5)


async def test_batched_streaks_and_consecutive_match_per_user_calculation(env) -> None:
    """Разные истории в одной пачке: серия и consecutive_missed каждого — как поштучный расчёт."""
    env.settings.tick_batch_size = 10
    fresh, steady, lapsed, back = (uuid.uuid4() for _ in range(4))
    for u in (fresh, steady, lapsed, back):
        await env.onboard(u, at=z(12, 3))  # чт 12.11, 08:00 Ташкент; слот 19:00 = 14:00Z
    await env.practice(steady, at=z(13, 5))
    await env.practice(steady, at=z(14, 5))
    await env.practice(steady, at=z(15, 5))
    await env.practice(lapsed, at=z(12, 5))  # только чт, дальше — пропуски
    await env.practice(back, at=z(13, 5))
    await env.practice(back, at=z(16, 5))  # сегодня (пн) — напоминания нет
    t = z(12, 19)
    await env.set_last_tick(t - timedelta(minutes=5))
    while t <= z(15, 19):  # концы чт…вс: пропуски по дням без занятий
        await env.tick(t)
        t += timedelta(days=1)
    r = await env.tick(z(16, 19), since=z(16, 13, 55))  # пн: напоминание в 19:00 и пропуск в полночь
    assert r == {"plans_checked": 4, "reminders": 3, "missed": 3}
    rem = {e.payload["user_id"]: e.payload["streak_days"] for e in await env.events("learning.reminder.due.v1")
           if e.payload["local_date"] == "2026-11-16"}
    assert rem == {str(fresh): 0, str(steady): 3, str(lapsed): 0}
    async with env.runtime.transaction() as s:  # эталон — поштучная функция TodayPlan
        for u in (fresh, steady, lapsed):
            assert rem[str(u)] == await streak_days(s, u, date(2026, 11, 16))
    missed = {(e.payload["user_id"], e.payload["local_date"]): e.payload["consecutive_missed"]
              for e in await env.events("learning.session.missed.v1")}
    assert missed[(str(fresh), "2026-11-16")] == 5  # чт, пт, сб, вс, пн
    assert missed[(str(lapsed), "2026-11-16")] == 4  # после занятия чт: пт, сб, вс, пн
    assert missed[(str(steady), "2026-11-16")] == 1  # пт–вс с занятиями
    assert (str(back), "2026-11-16") not in missed
    assert missed[(str(back), "2026-11-15")] == 2  # сб, вс после занятия пт


async def test_missed_and_reminder_in_one_window_counted_in_streak(env, user) -> None:
    """Слот 00:00: конец пн (пропуск) и слот вт — в одном окне. Серия в напоминании уже учитывает этот пропуск."""
    await env.onboard(user, at=z(15, 3), time="00:00")  # вс 08:00 Ташкент
    await env.practice(user, at=z(15, 5))  # занятие в вс
    await env.tick(z(15, 19), since=z(15, 18, 55))  # слот пн 00:00 — напоминание пн, вс сделан
    r = await env.tick(z(16, 19), since=z(16, 18, 55))  # пн без занятия: пропуск пн + напоминание вт
    assert r == {"plans_checked": 1, "reminders": 1, "missed": 1}
    [rem] = [e for e in await env.events("learning.reminder.due.v1", user) if e.payload["local_date"] == "2026-11-17"]
    assert rem.payload["streak_days"] == 0
    [miss] = await env.events("learning.session.missed.v1", user)
    assert (miss.payload["local_date"], miss.payload["consecutive_missed"]) == ("2026-11-16", 1)


@pytest.mark.slow
async def test_load_10k_plans_one_slot(env) -> None:
    """Регресс P-1: 10 000 планов с одним слотом (19:00 Ташкент) — напоминания и пропуски; до исправления
    ~33 с на проход, после — около секунды. Запрос ученика во время tick не ждёт пул."""
    n = 10_000
    await env.sql("""
        INSERT INTO plans (user_id, goal, level_self, topics, ui_lang, explain_lang, course_pair, preset, days,
          preferred_time, duration_min, reminders_enabled, timezone, schedule_set_at, onboarding_completed_at,
          version, created_at, updated_at)
        SELECT gen_random_uuid(), 'travel', 'beginner', '{}', 'ru', 'ru', 'ru-en', 'daily', '{1,2,3,4,5,6,7}',
          '19:00', 20, true, 'Asia/Tashkent', '2026-11-10T00:00Z', '2026-11-10T00:00Z', 2, now(), now()
        FROM generate_series(1, :n)""", n=n)
    # у каждого десятого — занятие в день слота (ни напоминания, ни пропуска), у каждого пятого — занятие вчера
    await env.sql("""
        INSERT INTO activities (activity_id, user_id, local_date, kind, minutes, idempotency_key, recorded_at)
        SELECT gen_random_uuid(), user_id, d, 'practice', 10, 'seed-' || user_id::text || d::text, now()
        FROM (SELECT user_id, row_number() OVER (ORDER BY user_id) AS i FROM plans) p,
             LATERAL (VALUES (CASE WHEN p.i % 10 = 0 THEN DATE '2026-11-16' WHEN p.i % 5 = 0 THEN DATE '2026-11-15'
                              END)) v(d)
        WHERE v.d IS NOT NULL""")
    await env.set_last_tick(z(16, 13, 55))
    env.now = z(16, 14, 0)
    started = time.perf_counter()
    task = asyncio.create_task(env.c.post("/internal/v1/plan:tick", headers=env.sched))
    await asyncio.sleep(0.05)
    learner = time.perf_counter()
    assert (await env.c.get("/internal/v1/me/plan", headers=env.h(uuid.uuid4()))).status_code == 200
    learner_s = time.perf_counter() - learner
    r = (await task).json()
    reminders_s = time.perf_counter() - started
    assert r == {"plans_checked": n, "reminders": n - n // 10, "missed": 0, "skipped": False}
    started = time.perf_counter()
    assert await env.tick(z(16, 19, 0)) == {"plans_checked": n, "reminders": 0, "missed": n - n // 10}
    missed_s = time.perf_counter() - started
    print(f"\nplan:tick {n} plans: reminders {reminders_s:.2f}s, missed {missed_s:.2f}s, "
          f"learner GET during tick {learner_s:.2f}s")
    [(outbox,)] = await env.sql("SELECT count(*) FROM outbox")
    assert outbox == 2 * (n - n // 10)
    rows = await env.sql("""
        SELECT (envelope->'payload'->>'streak_days')::int AS s, count(*) FROM outbox
        WHERE event_type = 'learning.reminder.due.v1' GROUP BY 1 ORDER BY 1""")
    assert rows == [(0, n - n // 5), (1, n // 5 - n // 10)]
    assert reminders_s < 15 and missed_s < 15 and learner_s < 5
