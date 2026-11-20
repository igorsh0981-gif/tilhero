"""Спринт 5 (INTERNAL_API §6, AT-59): memory.review.completed.v1 (только от memory) → занятие kind review (минуты,
local_date по поясу плана из finished_at, идемпотентно по session_id, 0 минут не засчитывается) →
learning.activity.recorded.v1; день графика, серия, пропуски и напоминания его учитывают. Плюс kind reading у
lesson.session.completed.v1 → занятие practice, у assessment.completed.v1 — принимается без влияния на уроки."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from tilhero_common.messaging import Envelope, make_envelope

REVIEW = "memory.review.completed.v1"
ACTIVITY = "learning.activity.recorded.v1"
DURABLE = "learning-plan.memory"
MON_MORNING = datetime(2026, 11, 16, 3, 0, tzinfo=UTC)  # пн 08:00 Ташкент


def z(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC)


async def review_done(env, user: uuid.UUID, *, minutes: int = 4, status: str = "completed",
                      finished_at: str = "2026-11-16T10:00:00Z", session_id: uuid.UUID | None = None,
                      producer: str = "memory") -> Envelope:
    return await env.publish(REVIEW, {
        "session_id": str(session_id or uuid.uuid4()), "user_id": str(user), "pair_id": "ru-en", "status": status,
        "minutes": minutes, "reviewed": 12, "correct": 9, "finished_at": finished_at,
    }, producer=producer)


async def activities(env, user: uuid.UUID) -> list[tuple[Any, ...]]:
    rows = await env.sql("SELECT kind, minutes, local_date::text, session_id FROM activities WHERE user_id = :u "
                         "ORDER BY recorded_at", u=user)
    return [tuple(r) for r in rows]


async def today(env, user: uuid.UUID, at: datetime) -> dict[str, Any]:
    env.now = at
    r = await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))
    assert r.status_code == 200, r.text
    return r.json()


async def test_review_becomes_activity_with_event(env, user) -> None:
    sid = uuid.uuid4()
    await review_done(env, user, session_id=sid, minutes=4)
    assert await activities(env, user) == [("review", 4, "2026-11-16", sid)]
    [ev] = await env.events(ACTIVITY, user)
    assert ev.payload == {"user_id": str(user), "activity_id": ev.payload["activity_id"], "local_date": "2026-11-16",
                          "kind": "review", "minutes": 4, "recorded_at": "2026-11-16T10:00:00Z"}
    t = await today(env, user, z(16, 12))
    assert t["done_today"] is True and t["minutes_today"] == 4 and t["streak_days"] == 1
    assert env.bus.dlq == []


async def test_expired_with_answers_counts_too(env, user) -> None:
    await review_done(env, user, status="expired", minutes=2)
    assert [(r[0], r[1]) for r in await activities(env, user)] == [("review", 2)]


async def test_idempotent_by_session_redelivery_and_republish(env, user) -> None:
    sid = uuid.uuid4()
    ev = await review_done(env, user, session_id=sid, minutes=5)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки — inbox
    await review_done(env, user, session_id=sid, minutes=5)  # повторная публикация (новый event_id)
    await review_done(env, user, session_id=sid, status="expired", minutes=7)  # та же сессия — не второе занятие
    assert len(await activities(env, user)) == 1
    assert len(await env.events(ACTIVITY, user)) == 1
    assert (await today(env, user, z(16, 12)))["minutes_today"] == 5


async def test_zero_minutes_not_counted(env, user) -> None:
    await review_done(env, user, minutes=0)
    assert await activities(env, user) == []
    assert await env.events(ACTIVITY, user) == []
    t = await today(env, user, z(16, 12))
    assert t["done_today"] is False and t["streak_days"] == 0


async def test_local_date_by_plan_timezone_from_finished_at(env) -> None:
    moscow, tashkent, no_plan = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    r = await env.c.patch("/internal/v1/me/plan", json={"schedule": {"timezone": "Europe/Moscow"}},
                          headers=env.h(moscow))
    assert r.status_code == 200
    await env.c.get("/internal/v1/me/plan", headers=env.h(tashkent))
    late = "2026-11-16T19:30:00Z"  # 00:30 вт в Ташкенте, 22:30 пн в Москве
    for u in (moscow, tashkent, no_plan):
        await review_done(env, u, finished_at=late)
    assert (await activities(env, moscow))[0][2] == "2026-11-16"
    assert (await activities(env, tashkent))[0][2] == "2026-11-17"
    assert (await activities(env, no_plan))[0][2] == "2026-11-17"  # плана нет — зона по умолчанию (Ташкент)
    assert await env.sql("SELECT 1 FROM plans WHERE user_id = :u", u=no_plan) == []  # план событием не создаётся


async def test_foreign_producer_ignored_and_invalid_payload_to_dlq(env, user) -> None:
    for producer in ("lessons", "assessment", "learning-plan", "telegram-bff", "notifications"):
        await review_done(env, user, producer=producer)
    assert await activities(env, user) == []
    bad = make_envelope(REVIEW, {"session_id": str(uuid.uuid4()), "user_id": str(user)}, producer="memory")
    await env.bus.publish(bad)
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]


async def test_review_day_counts_for_schedule_streak_missed_and_reminders(env, user) -> None:
    """AT-59: повторение — занятие дня: напоминание и пропуск не выпускаются, серия растёт."""
    await env.onboard(user, at=MON_MORNING)  # каждый день, 19:00 Ташкент, напоминания включены
    await review_done(env, user, finished_at="2026-11-16T09:00:00Z")
    r = await env.tick(z(16, 14, 0), since=z(16, 13, 55))  # слот пн 19:00
    assert r == {"plans_checked": 1, "reminders": 0, "missed": 0}
    assert (await env.tick(z(16, 19, 0)))["missed"] == 0  # местная полночь — пропуска нет
    await review_done(env, user, finished_at="2026-11-17T09:00:00Z", status="expired", minutes=1)
    assert (await env.tick(z(17, 14, 0), since=z(17, 13, 55)))["reminders"] == 0
    assert (await env.tick(z(17, 19, 0)))["missed"] == 0
    t = await today(env, user, z(18, 8))
    assert t["streak_days"] == 2 and t["done_today"] is False
    week = {d["local_date"]: d for d in t["week"]}
    assert week["2026-11-16"]["done"] and week["2026-11-17"]["done"]
    # ср — без занятия: напоминание и пропуск; повторение с 0 минут день не засчитывает
    await review_done(env, user, finished_at="2026-11-18T09:00:00Z", minutes=0)
    assert (await env.tick(z(18, 14, 0), since=z(18, 13, 55)))["reminders"] == 1
    assert (await env.tick(z(18, 19, 0)))["missed"] == 1


async def test_review_and_lesson_same_day_add_up(env, user) -> None:
    await review_done(env, user, minutes=3)
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
        "lesson_id": "l-greet", "scenario_id": None, "asset_id": None, "status": "completed", "outcome": "success",
        "minutes": 15, "local_date": "2026-11-16", "evaluation_id": str(uuid.uuid4()), "passed": True,
        "practice_only": False, "finished_at": "2026-11-16T11:00:00Z"}, producer="lessons")
    t = await today(env, user, z(16, 12))
    assert t["minutes_today"] == 18 and t["streak_days"] == 1
    assert sorted(r[0] for r in await activities(env, user)) == ["lesson", "review"]


async def test_learners_isolated(env, user) -> None:
    other = uuid.uuid4()
    await review_done(env, user)
    assert await activities(env, other) == []
    assert (await today(env, other, z(16, 12)))["done_today"] is False


async def test_deletion_then_late_review_ignored(env, user) -> None:
    await review_done(env, user)
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-18T09:00:00Z"},
                      producer="identity-consent")
    assert await activities(env, user) == []
    await review_done(env, user)
    assert await activities(env, user) == []
    assert env.bus.dlq == []


async def test_reading_session_is_practice_and_reading_evaluation_accepted(env, user) -> None:
    """kind reading: сессия — занятие practice (не пройденный урок); оценка вопросов — принимается (не DLQ) и на
    пройденные уроки не влияет."""
    sid = uuid.uuid4()
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(sid), "user_id": str(user), "kind": "reading", "pair_id": "ru-en", "lesson_id": None,
        "scenario_id": None, "asset_id": None, "status": "completed", "outcome": None, "minutes": 6,
        "local_date": "2026-11-16", "evaluation_id": str(uuid.uuid4()), "passed": None, "practice_only": True,
        "finished_at": "2026-11-16T10:00:00Z"}, producer="lessons")
    await env.publish("assessment.completed.v1", {
        "evaluation_id": str(uuid.uuid4()), "user_id": str(user), "pair_id": "ru-en", "session_id": str(sid),
        "kind": "reading", "skill_outcomes": [], "passed": None, "practice_only": True, "supersedes": None,
        "created_at": "2026-11-16T10:00:01Z"}, producer="assessment")
    assert await activities(env, user) == [("practice", 6, "2026-11-16", sid)]
    [ev] = await env.events(ACTIVITY, user)
    assert ev.payload["kind"] == "practice"
    assert await env.sql("SELECT 1 FROM completed_lessons WHERE user_id = :u", u=user) == []
    assert await env.sql("SELECT 1 FROM lesson_evaluations WHERE user_id = :u", u=user) == []
    assert env.bus.dlq == []


async def test_retention_skill_change_projected(env, user) -> None:
    """skills.state.changed.v1 с source retention (спринт 5: diagnostics по проверкам удержания) принимается:
    retained — освоенный навык проекции траектории; понижение до learning — тоже."""
    await env.publish("skills.state.changed.v1", {
        "user_id": str(user), "pair_id": "ru-en", "occurred_at": "2026-11-16T07:01:00Z",
        "changes": [{"skill_id": "s.greet", "from": "demonstrated", "to": "retained", "source": "retention",
                     "evidence_id": str(uuid.uuid4())},
                    {"skill_id": "s.be", "from": "demonstrated", "to": "learning", "source": "retention",
                     "evidence_id": str(uuid.uuid4())}]}, producer="diagnostics")
    rows = await env.sql("SELECT skill_id, state FROM skill_states WHERE user_id = :u ORDER BY skill_id", u=user)
    assert [tuple(r) for r in rows] == [("s.be", "learning"), ("s.greet", "retained")]
    assert env.bus.dlq == []
