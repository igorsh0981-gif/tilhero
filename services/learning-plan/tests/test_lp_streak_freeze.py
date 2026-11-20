"""Спринт 6 (INTERNAL_API §2, AT-66): game.streak.frozen.v1 (только от gamification) → frozen_days. Замороженный
пропуск не рвёт серию (но занятием не считается), разрывает цепочку consecutive_missed, неделя TodayPlan показывает
frozen (missed остаётся true); день с занятием важнее заморозки; повтор события — без изменений; чужой издатель —
без действия; streak_days в learning.activity.recorded.v1."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from tilhero_common.messaging import Envelope, make_envelope

FROZEN = "game.streak.frozen.v1"
ACTIVITY = "learning.activity.recorded.v1"
MISSED = "learning.session.missed.v1"
REMINDER = "learning.reminder.due.v1"
DURABLE = "learning-plan.game"
# Ташкент UTC+5: слот 19:00 = 14:00Z, местная полночь = 19:00Z предыдущей даты UTC
MON_MORNING = datetime(2026, 11, 16, 3, 0, tzinfo=UTC)  # пн 08:00 Ташкент


def z(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC)


async def frozen(env, user: uuid.UUID, local_date: str, *, op_id: uuid.UUID | None = None,
                 producer: str = "gamification", freeze_left: int = 1) -> Envelope:
    return await env.publish(FROZEN, {
        "user_id": str(user), "local_date": local_date, "op_id": str(op_id or uuid.uuid4()),
        "freeze_left": freeze_left, "frozen_at": "2026-11-17T19:05:00Z"}, producer=producer)


async def frozen_rows(env, user: uuid.UUID) -> list[tuple[Any, ...]]:
    rows = await env.sql("SELECT local_date::text, op_id FROM frozen_days WHERE user_id = :u ORDER BY local_date",
                         u=user)
    return [tuple(r) for r in rows]


async def today(env, user: uuid.UUID, at: datetime) -> dict[str, Any]:
    env.now = at
    r = await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))
    assert r.status_code == 200, r.text
    return r.json()


def week(t: dict[str, Any]) -> dict[str, tuple[bool, bool, bool]]:
    return {d["local_date"]: (d["done"], d["missed"], d["frozen"]) for d in t["week"]}


async def missed_tuesday(env, *users: uuid.UUID) -> None:
    """Каждый день 19:00, занятие в пн, вт — без занятия: пропуск вт выпущен tick после местной полуночи."""
    for u in users:
        await env.onboard(u, at=MON_MORNING)
        await env.practice(u, at=z(16, 5))
    r = await env.tick(z(17, 19, 0), since=z(17, 18, 55))
    assert r["missed"] == len(users)


async def test_freeze_between_two_activity_days_keeps_streak(env) -> None:
    """AT-66: пн занятие, вт пропуск с заморозкой, ср занятие → серия 2 (вт не засчитан, но и не рвёт);
    без заморозки серия рвётся (только ср)."""
    saved, broken = uuid.uuid4(), uuid.uuid4()
    await missed_tuesday(env, saved, broken)
    op = uuid.uuid4()
    await frozen(env, saved, "2026-11-17", op_id=op)
    assert await frozen_rows(env, saved) == [("2026-11-17", op)]
    assert await frozen_rows(env, broken) == []
    # до занятия в ср: серия сохранена заморозкой (пн), без заморозки — 0
    assert (await today(env, saved, z(18, 4)))["streak_days"] == 1
    assert (await today(env, broken, z(18, 4)))["streak_days"] == 0
    for u in (saved, broken):
        r = await env.practice(u, at=z(18, 5))
        assert r.status_code == 200, r.text
    t_saved, t_broken = await today(env, saved, z(18, 8)), await today(env, broken, z(18, 8))
    assert t_saved["streak_days"] == 2 and t_broken["streak_days"] == 1
    # неделя: вт — пропуск, закрытый заморозкой (missed остаётся true); пн и ср — занятия
    assert week(t_saved)["2026-11-17"] == (False, True, True)
    assert week(t_broken)["2026-11-17"] == (False, True, False)
    assert week(t_saved)["2026-11-16"] == week(t_saved)["2026-11-18"] == (True, False, False)
    # streak_days в learning.activity.recorded.v1 — серия после записи занятия (схема — assert_event_conforms)
    assert [e.payload["streak_days"] for e in await env.events(ACTIVITY, saved)] == [1, 2]
    assert [e.payload["streak_days"] for e in await env.events(ACTIVITY, broken)] == [1, 1]
    assert env.bus.dlq == []


async def test_frozen_day_breaks_consecutive_missed_chain(env) -> None:
    """consecutive_missed в tick не считает замороженные дни: заморозка пн → пропуск вт снова первый."""
    saved, control = uuid.uuid4(), uuid.uuid4()
    for u in (saved, control):
        await env.onboard(u, at=MON_MORNING)
    await env.set_last_tick(z(16, 18, 55))
    await env.tick(z(16, 19, 0))  # конец пн
    await frozen(env, saved, "2026-11-16")
    await env.tick(z(17, 19, 0))  # конец вт
    await env.tick(z(18, 19, 0))  # конец ср
    chain = {u: [(e.payload["local_date"], e.payload["consecutive_missed"]) for e in await env.events(MISSED, u)]
             for u in (saved, control)}
    assert chain[saved] == [("2026-11-16", 1), ("2026-11-17", 1), ("2026-11-18", 2)]
    assert chain[control] == [("2026-11-16", 1), ("2026-11-17", 2), ("2026-11-18", 3)]


async def test_reminder_streak_counts_through_frozen_day(env) -> None:
    """Серия в напоминании tick (_STREAKS) — как TodayPlan: замороженный пропуск её не рвёт."""
    saved, broken = uuid.uuid4(), uuid.uuid4()
    await missed_tuesday(env, saved, broken)
    await frozen(env, saved, "2026-11-17")
    r = await env.tick(z(18, 14, 0), since=z(18, 13, 55))  # слот ср 19:00
    assert r["reminders"] == 2
    streaks = {e.payload["user_id"]: e.payload["streak_days"] for e in await env.events(REMINDER)
               if e.payload["local_date"] == "2026-11-18"}
    assert streaks == {str(saved): 1, str(broken): 0}


@pytest.mark.parametrize("freeze_first", [True, False])
async def test_activity_same_day_wins_over_freeze(env, user, freeze_first: bool) -> None:
    """Гонка: заморозка и занятие того же дня (позднее событие урока). Занятие важнее: день done, не missed и не
    frozen; серия считает его занятием. Строка заморозки хранится, но ни на что не влияет."""
    await missed_tuesday(env, user)
    lesson = {
        "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
        "lesson_id": "l-greet", "scenario_id": None, "asset_id": None, "status": "completed", "outcome": "success",
        "minutes": 15, "local_date": "2026-11-17", "evaluation_id": str(uuid.uuid4()), "passed": True,
        "practice_only": False, "finished_at": "2026-11-17T18:50:00Z"}
    if freeze_first:
        await frozen(env, user, "2026-11-17")
        await env.publish("lesson.session.completed.v1", lesson, producer="lessons")
    else:
        await env.publish("lesson.session.completed.v1", lesson, producer="lessons")
        await frozen(env, user, "2026-11-17")
    assert len(await frozen_rows(env, user)) == 1
    t = await today(env, user, z(18, 4))
    assert week(t)["2026-11-17"] == (True, False, False)
    assert t["streak_days"] == 2  # пн + вт (занятие), а не пн + заморозка
    [_, ev] = await env.events(ACTIVITY, user)
    assert ev.payload["local_date"] == "2026-11-17" and ev.payload["streak_days"] == 2
    assert env.bus.dlq == []


async def test_retroactive_activity_restores_streak_in_event(env, user) -> None:
    """Занятие задним числом за пропущенный день: событие несёт восстановленную серию на последний день с занятием."""
    await missed_tuesday(env, user)
    await env.practice(user, at=z(18, 5))  # ср
    env.now = z(18, 8)
    r = await env.c.post("/internal/v1/me/activities", json={"kind": "lesson", "minutes": 20,
                                                              "occurred_at": "2026-11-17T10:00:00Z"},
                         headers={**env.h(user), "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 200 and r.json()["streak_days"] == 3
    assert [e.payload["streak_days"] for e in await env.events(ACTIVITY, user)] == [1, 1, 3]


async def test_repeat_event_changes_nothing(env, user) -> None:
    await missed_tuesday(env, user)
    op = uuid.uuid4()
    ev = await frozen(env, user, "2026-11-17", op_id=op)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки — inbox
    await frozen(env, user, "2026-11-17", op_id=op)  # повторная публикация (новый event_id)
    await frozen(env, user, "2026-11-17", op_id=uuid.uuid4())  # тот же день другой операцией — первая остаётся
    assert await frozen_rows(env, user) == [("2026-11-17", op)]
    t = await today(env, user, z(18, 4))
    assert week(t)["2026-11-17"] == (False, True, True) and t["streak_days"] == 1
    # learning-plan на заморозку событий не выпускает (игра не меняет учёбу; обратного эха нет)
    await env.flush()
    assert [e.event_type for e in env.bus.published if e.producer == "learning-plan"
            and e.event_type not in (MISSED, ACTIVITY, "learning.plan.updated.v1")] == []
    assert env.bus.dlq == []


async def test_foreign_producer_rejected_and_invalid_payload_to_dlq(env, user, caplog) -> None:
    await missed_tuesday(env, user)
    for producer in ("lessons", "learning-plan", "telegram-bff", "notifications", "memory", "admin-bff"):
        await frozen(env, user, "2026-11-17", producer=producer)
    assert await frozen_rows(env, user) == []
    t = await today(env, user, z(18, 4))
    assert week(t)["2026-11-17"] == (False, True, False) and t["streak_days"] == 0
    warned = [r for r in caplog.records if r.getMessage() == "event from unexpected producer ignored"]
    assert len(warned) == 6 and all(str(user) not in str(r.__dict__) for r in warned)
    assert env.bus.dlq == []
    bad = make_envelope(FROZEN, {"user_id": str(user), "local_date": "17.11.2026"}, producer="gamification")
    await env.bus.publish(bad)
    assert [(d, e.event_id) for d, e in env.bus.dlq] == [(DURABLE, bad.event_id)]
    assert await frozen_rows(env, user) == []


async def test_learners_isolated(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await missed_tuesday(env, a, b)
    await frozen(env, a, "2026-11-17")
    assert week(await today(env, b, z(18, 4)))["2026-11-17"] == (False, True, False)
    assert week(await today(env, a, z(18, 4)))["2026-11-17"] == (False, True, True)


async def test_freeze_without_plan_and_after_deletion(env, user) -> None:
    """Заморозка до плана хранится (план не создаётся); после удаления ученика (сага) — не воскрешается."""
    stranger = uuid.uuid4()
    await frozen(env, stranger, "2026-11-17")
    assert len(await frozen_rows(env, stranger)) == 1
    assert await env.sql("SELECT 1 FROM plans WHERE user_id = :u", u=stranger) == []
    await missed_tuesday(env, user)
    await frozen(env, user, "2026-11-17")
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-18T09:00:00Z"},
                      producer="identity-consent")
    assert await frozen_rows(env, user) == []
    await frozen(env, user, "2026-11-18")
    assert await frozen_rows(env, user) == []
    assert env.bus.dlq == []


async def test_week_frozen_only_for_current_week(env, user) -> None:
    """frozen прошлой недели в week текущей не попадает; серия через неё продолжается."""
    await missed_tuesday(env, user)
    await frozen(env, user, "2026-11-17")
    for day in (18, 19, 20, 21, 22, 23):
        await env.practice(user, at=z(day, 5))
    t = await today(env, user, z(23, 8) + timedelta(minutes=1))  # пн следующей недели
    assert all(not d["frozen"] for d in t["week"])
    assert t["streak_days"] == 7  # пн 16 + ср…пн 23 (вт 17 заморожен)
