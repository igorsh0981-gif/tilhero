"""Спринт 4 (INTERNAL_API §5, AT-46/47): lesson.session.completed.v1 → занятие дня (kind lesson/practice, минуты,
local_date из события или по зоне плана; идемпотентно по session_id) и пройденный урок → траектория (completed,
следующий — первый не пройденный успешно, без зачёта — «повторить»); график, серия, пропуски и напоминания — по
реальным урокам; ручная активность Mini App — по-прежнему; assessment.completed.v1 / assessment.reevaluated.v1 →
исход урока по session_id в любом порядке событий (R1-05: оценка, полученная после завершения сессии)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from lp_course import ADULT_CORE, KIDS_CORE, course

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import internal_headers

COMPLETED = "lesson.session.completed.v1"
REEVALUATED = "assessment.reevaluated.v1"
ASSESSED = "assessment.completed.v1"
ACTIVITY = "learning.activity.recorded.v1"
UPDATED = "learning.trajectory.updated.v1"
DURABLE = "learning-plan.lessons"
MON_MORNING = datetime(2026, 11, 16, 3, 0, tzinfo=UTC)  # пн 08:00 Ташкент


def z(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC)


def mandatory(body: dict[str, Any]) -> list[str]:
    return [x["lesson_id"] for x in body["mandatory"]]


async def session_done(env, user: uuid.UUID, *, kind: str = "lesson", lesson_id: str | None = "l-greet",
                       status: str = "completed", minutes: int = 18, local_date: str | None = "2026-11-16",
                       passed: bool | None = True, evaluation_id: uuid.UUID | None = None,
                       finished_at: str = "2026-11-16T10:00:00Z", session_id: uuid.UUID | None = None,
                       producer: str = "lessons", outcome: str | None = "success",
                       evaluated: bool = True) -> Envelope:
    """evaluated=False — assessment был недоступен при finish: evaluation_id и passed = null."""
    sid = session_id or uuid.uuid4()
    ev = evaluation_id if evaluation_id is not None else (
        uuid.uuid4() if status == "completed" and evaluated else None)
    if not evaluated:
        passed = None
    return await env.publish(COMPLETED, {
        "session_id": str(sid), "user_id": str(user), "kind": kind, "pair_id": "ru-en",
        "lesson_id": lesson_id if kind == "lesson" else None,
        "scenario_id": "sc-cafe" if kind == "scenario" else None,
        "asset_id": "m-coffee" if kind == "media" else None,
        "status": status, "outcome": outcome, "minutes": minutes, "local_date": local_date,
        "evaluation_id": str(ev) if ev else None, "passed": passed if status == "completed" else None,
        "practice_only": kind == "review", "finished_at": finished_at,
    }, producer=producer)


async def reevaluated(env, user: uuid.UUID, supersedes: uuid.UUID, *, passed: bool | None, session_id: uuid.UUID,
                      producer: str = "assessment", new_id: uuid.UUID | None = None,
                      created_at: str = "2026-11-17T09:00:00Z") -> uuid.UUID:
    """assessment.reevaluated.v1 — с session_id (обязателен в схеме после ревью спринта 4)."""
    new_id = new_id or uuid.uuid4()
    await env.publish(REEVALUATED, {
        "evaluation_id": str(new_id), "supersedes": str(supersedes), "session_id": str(session_id),
        "user_id": str(user), "pair_id": "ru-en",
        "skill_outcomes": [{"skill_id": "s.greet", "outcome": "demonstrated" if passed else "learning"}],
        "passed": passed, "appeal_id": str(uuid.uuid4()), "created_at": created_at,
    }, producer=producer)
    return new_id


async def assessed(env, user: uuid.UUID, session_id: uuid.UUID, *, passed: bool | None,
                   evaluation_id: uuid.UUID | None = None, kind: str = "lesson", producer: str = "assessment",
                   created_at: str = "2026-11-16T10:30:00Z") -> Envelope:
    """assessment.completed.v1 — оценка сессии (в т. ч. полученная tick-ом lessons после завершения)."""
    eid = evaluation_id or uuid.uuid4()
    return await env.publish(ASSESSED, {
        "evaluation_id": str(eid), "user_id": str(user), "pair_id": "ru-en", "session_id": str(session_id),
        "kind": kind, "skill_outcomes": [] if passed is None else [
            {"skill_id": "s.greet", "outcome": "demonstrated" if passed else "learning"}],
        "passed": passed, "practice_only": kind == "review", "supersedes": None, "created_at": created_at,
    }, producer=producer)


def latest_result(body: dict[str, Any], lesson_id: str = "l-greet") -> tuple[bool | None, str | None]:
    done = next(c for c in body["completed"] if c["lesson_id"] == lesson_id)
    return done["passed"], done["evaluation_id"]


async def activities(env, user: uuid.UUID) -> list[Any]:
    return await env.sql("SELECT kind, minutes, local_date::text, session_id FROM activities WHERE user_id = :u "
                         "ORDER BY recorded_at", u=user)


# ---------------------------------------------------------------- занятие дня


async def test_lesson_session_becomes_activity_with_event(env, user) -> None:
    sid = uuid.uuid4()
    await session_done(env, user, session_id=sid, minutes=18, local_date="2026-11-16")
    rows = await activities(env, user)
    assert [tuple(r) for r in rows] == [("lesson", 18, "2026-11-16", sid)]
    [ev] = await env.events(ACTIVITY, user)
    assert ev.payload == {"user_id": str(user), "activity_id": ev.payload["activity_id"], "local_date": "2026-11-16",
                          "kind": "lesson", "minutes": 18, "recorded_at": "2026-11-16T10:00:00Z",
                          "streak_days": 1}
    env.now = z(16, 12)
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    assert today["done_today"] is True and today["minutes_today"] == 18 and today["streak_days"] == 1
    assert env.bus.dlq == []


async def test_idempotent_by_session_redelivery_and_republish(env, user) -> None:
    sid = uuid.uuid4()
    ev = await session_done(env, user, session_id=sid)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки того же события — inbox
    # lessons опубликовал повторно (новый event_id, та же сессия) — минуты не удваиваются
    await session_done(env, user, session_id=sid)
    assert len(await activities(env, user)) == 1
    assert len(await env.events(ACTIVITY, user)) == 1
    [(n,)] = await env.sql("SELECT count(*) FROM completed_lessons WHERE user_id = :u", u=user)
    assert n == 1
    env.now = z(16, 12)
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    assert today["minutes_today"] == 18


async def test_practice_kinds_and_not_completed_statuses(env, user) -> None:
    await session_done(env, user, kind="scenario", minutes=7)
    await session_done(env, user, kind="media", minutes=6)
    await session_done(env, user, kind="review", minutes=3, passed=None)
    for status in ("cancelled", "failed"):
        await session_done(env, user, status=status, minutes=12, outcome=None)
    rows = await activities(env, user)
    assert sorted((r[0], r[1]) for r in rows) == [("practice", 3), ("practice", 6), ("practice", 7)]
    # пройденный урок — только kind lesson со status completed
    assert await env.sql("SELECT 1 FROM completed_lessons WHERE user_id = :u", u=user) == []
    assert len(await env.events(ACTIVITY, user)) == 3


async def test_local_date_from_event_or_plan_timezone(env) -> None:
    moscow, tashkent, no_plan = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    r = await env.c.patch("/internal/v1/me/plan", json={"schedule": {"timezone": "Europe/Moscow"}},
                          headers=env.h(moscow))
    assert r.status_code == 200
    await env.c.get("/internal/v1/me/plan", headers=env.h(tashkent))
    late = "2026-11-16T19:30:00Z"  # 00:30 вт в Ташкенте, 22:30 пн в Москве
    for u in (moscow, tashkent, no_plan):
        await session_done(env, u, local_date=None, finished_at=late)
    assert (await activities(env, moscow))[0][2] == "2026-11-16"
    assert (await activities(env, tashkent))[0][2] == "2026-11-17"
    assert (await activities(env, no_plan))[0][2] == "2026-11-17"  # плана нет — зона по умолчанию (Ташкент)
    # дата из события важнее зоны плана; план событием не создаётся
    other = uuid.uuid4()
    await session_done(env, other, local_date="2026-11-15", finished_at=late)
    assert (await activities(env, other))[0][2] == "2026-11-15"
    assert await env.sql("SELECT 1 FROM plans WHERE user_id = :u", u=no_plan) == []


async def test_minutes_are_capped(env, user) -> None:
    await session_done(env, user, minutes=300)
    await session_done(env, user, kind="scenario", minutes=0)
    assert sorted(r[1] for r in await activities(env, user)) == [0, 240]


async def test_foreign_producer_and_invalid_payload(env, user) -> None:
    await session_done(env, user, producer="assessment")
    await session_done(env, user, producer="telegram-bff")
    assert await activities(env, user) == []
    eid = uuid.uuid4()
    await reevaluated(env, user, eid, passed=True, session_id=uuid.uuid4(), producer="lessons")  # только assessment
    bad = make_envelope(COMPLETED, {"session_id": str(uuid.uuid4()), "user_id": str(user)}, producer="lessons")
    await env.bus.publish(bad)
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]


async def test_manual_activity_still_works_and_adds_up(env, user) -> None:
    """Ручная активность Mini App (спринт 1) — совместимость: работает и суммируется с уроком."""
    r = await env.practice(user, at=z(16, 8), minutes=10, key="manual-key-1")
    assert r.status_code == 200 and r.json()["minutes_today"] == 10
    await session_done(env, user, minutes=20)
    env.now = z(16, 12)
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    assert today["minutes_today"] == 30 and today["done_today"] is True
    # ключ сессии клиенту недоступен: «/» не проходит проверку Idempotency-Key
    bad = await env.c.post("/internal/v1/me/activities", json={"kind": "practice", "minutes": 5},
                           headers={**env.h(user), "Idempotency-Key": f"lesson/{uuid.uuid4()}"})
    assert bad.status_code == 422 and bad.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    kinds = sorted(r[0] for r in await activities(env, user))
    assert kinds == ["lesson", "practice"]


# ---------------------------------------------------------------- график, серия, пропуски, напоминания


async def test_lesson_day_counts_for_schedule_streak_and_missed(env, user) -> None:
    """AT-46: день с уроком засчитан — напоминание и пропуск не выпускаются, серия растёт."""
    await env.onboard(user, at=MON_MORNING)  # каждый день, 19:00 Ташкент, напоминания включены
    await session_done(env, user, local_date="2026-11-16", finished_at="2026-11-16T09:00:00Z")
    r = await env.tick(z(16, 14, 0), since=z(16, 13, 55))  # слот пн 19:00
    assert r == {"plans_checked": 1, "reminders": 0, "missed": 0}
    assert (await env.tick(z(16, 19, 0)))["missed"] == 0  # местная полночь — пропуска нет
    # вт — практика сценария (тоже занятие), ср — ничего
    await session_done(env, user, kind="scenario", local_date="2026-11-17", finished_at="2026-11-17T09:00:00Z",
                       passed=None)
    assert (await env.tick(z(17, 14, 0), since=z(17, 13, 55)))["reminders"] == 0
    assert (await env.tick(z(17, 19, 0)))["missed"] == 0
    env.now = z(18, 8)
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    assert today["streak_days"] == 2 and today["done_today"] is False
    week = {d["local_date"]: d for d in today["week"]}
    assert week["2026-11-16"]["done"] and week["2026-11-17"]["done"] and not week["2026-11-16"]["missed"]
    assert (await env.tick(z(18, 14, 0), since=z(18, 13, 55)))["reminders"] == 1
    assert (await env.tick(z(18, 19, 0)))["missed"] == 1
    [missed] = await env.events("learning.session.missed.v1", user)
    assert missed.payload["local_date"] == "2026-11-18" and missed.payload["consecutive_missed"] == 1
    # отменённый урок день не засчитывает
    await session_done(env, user, status="cancelled", local_date="2026-11-19", outcome=None,
                       finished_at="2026-11-19T09:00:00Z")
    assert (await env.tick(z(19, 14, 0), since=z(19, 13, 55)))["reminders"] == 1


async def test_late_lesson_event_for_missed_day_restores_week(env, user) -> None:
    """Событие урока пришло после выпуска пропуска — неделя показывает занятие, серия не рвётся."""
    await env.onboard(user, at=MON_MORNING)
    await env.tick(z(16, 19, 0), since=z(16, 18, 55))
    assert len(await env.events("learning.session.missed.v1", user)) == 1
    await session_done(env, user, local_date="2026-11-16", finished_at="2026-11-16T18:50:00Z")
    env.now = z(17, 8)
    today = (await env.c.get("/internal/v1/me/plan/today", headers=env.h(user))).json()
    week = {d["local_date"]: d for d in today["week"]}
    assert week["2026-11-16"] == {"local_date": "2026-11-16", "scheduled": True, "done": True, "missed": False,
                                  "frozen": False}
    assert today["streak_days"] == 1


# ---------------------------------------------------------------- пройденные уроки → траектория


async def test_passed_lesson_leaves_plan_and_appears_in_completed(env, user) -> None:
    await env.profile(user)
    first = await env.trajectory(user)
    assert first["next"]["lesson_id"] == "l-greet" and first["lessons_available"] is True
    eid = uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", passed=True, evaluation_id=eid,
                       finished_at="2026-11-16T10:00:00Z")
    body = await env.trajectory(user)
    assert body["revision"] == 2 and mandatory(body) == ADULT_CORE[1:]
    assert body["next"]["lesson_id"] == "l-be" and body["next"]["reason_codes"] == ["no_diagnostic"]
    [done] = body["completed"]
    card_keys = {"lesson_id", "module_id", "title", "goal", "level", "kind", "duration_min", "primary_skill_id",
                 "scenario_id", "stages"}
    assert set(done) == card_keys | {"passed", "evaluation_id", "completed_at"}
    assert done["lesson_id"] == "l-greet" and done["passed"] is True and done["evaluation_id"] == str(eid)
    assert done["completed_at"] == "2026-11-16T10:00:00Z" and done["title"] == {"ru": "l-greet (ru)",
                                                                                "uz": "l-greet (uz)"}
    events = await env.events(UPDATED, user)
    assert [e.payload["next_lesson_id"] for e in events] == ["l-greet", "l-be"]
    # повтор чтения — та же ревизия
    assert (await env.trajectory(user))["revision"] == 2
    [(basis,)] = await env.sql("SELECT basis FROM trajectories WHERE user_id = :u AND revision = 2", u=user)
    assert basis["algorithm"] == "cp-3" and len(basis["completed_hash"]) == 24


async def test_failed_lesson_stays_with_repeat_and_latest_session_wins(env, user) -> None:
    await env.profile(user)
    await session_done(env, user, lesson_id="l-greet", passed=False, finished_at="2026-11-16T09:00:00Z")
    await session_done(env, user, lesson_id="l-be", passed=True, finished_at="2026-11-16T10:00:00Z")
    body = await env.trajectory(user)
    assert mandatory(body) == ["l-greet", *ADULT_CORE[2:]]
    nxt = body["next"]
    # спринт 4: код «повторить» — repeat (bff.ts ReasonCode)
    assert nxt["lesson_id"] == "l-greet" and nxt["reason_codes"] == ["no_diagnostic", "repeat"]
    assert nxt["explanation"]["ru"].startswith("Повторим этот урок — в прошлый раз зачёт не получен.")
    assert nxt["explanation"]["uz"].startswith("Bu darsni takrorlaymiz")
    assert [(c["lesson_id"], c["passed"]) for c in body["completed"]] == [("l-be", True), ("l-greet", False)]
    # повторная сессия урока с зачётом — актуальна последняя
    await session_done(env, user, lesson_id="l-greet", passed=True, finished_at="2026-11-17T10:00:00Z")
    body = await env.trajectory(user)
    assert mandatory(body) == ADULT_CORE[2:] and body["next"]["reason_codes"] == ["no_diagnostic"]
    assert [(c["lesson_id"], c["passed"]) for c in body["completed"]] == [("l-greet", True), ("l-be", True)]
    # пройденный без вердикта (insufficient_evidence) — тоже «повторить»
    await session_done(env, user, lesson_id="l-numbers", passed=None, finished_at="2026-11-17T11:00:00Z")
    body = await env.trajectory(user)
    assert body["next"]["lesson_id"] == "l-numbers" and "repeat" in body["next"]["reason_codes"]
    assert body["completed"][0] == {**body["completed"][0], "lesson_id": "l-numbers", "passed": None}


async def test_passed_lesson_closes_prerequisite(env, user) -> None:
    """Основной навык урока, пройденного с зачётом, закрывает предпосылки (урок-«учитель» не вставляется)."""
    await env.profile(user)
    await env.diagnostic(user, start="l-routine", level="A0", grammar="A0")
    before = await env.trajectory(user)
    assert mandatory(before)[:2] == ["l-present", "l-routine"]
    await session_done(env, user, lesson_id="l-present", passed=True)
    after = await env.trajectory(user)
    assert mandatory(after)[0] == "l-routine"
    assert after["next"]["reason_codes"] == ["start_after_diagnostic"]


async def test_kids_repeat_explanation_is_soft(env, user) -> None:
    await env.profile(user, kind="child", age_band="6-9")
    await session_done(env, user, lesson_id="l-greet", passed=False)
    body = await env.trajectory(user)
    assert mandatory(body) == KIDS_CORE
    # детям — тоже мягкий код repeat (без «слабой области»), объяснение мягкое
    assert body["next"]["reason_codes"] == ["no_diagnostic", "repeat"]
    assert body["next"]["explanation"]["ru"].startswith("Пройдём этот урок ещё раз — так дальше будет легче.")
    assert "зачёт" not in body["next"]["explanation"]["ru"]


async def test_reevaluation_updates_lesson_result(env, user) -> None:
    """AT-47: переоценка по апелляции меняет исход пройденного урока — план пересчитан, completed — новая оценка."""
    await env.profile(user)
    eid, sid = uuid.uuid4(), uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", passed=False, evaluation_id=eid, session_id=sid)
    assert (await env.trajectory(user))["next"]["lesson_id"] == "l-greet"
    await reevaluated(env, user, eid, passed=True, session_id=sid, producer="lessons")  # чужой издатель — без действия
    assert (await env.trajectory(user))["next"]["lesson_id"] == "l-greet"
    new_id = await reevaluated(env, user, eid, passed=True, session_id=sid)
    body = await env.trajectory(user)
    assert body["next"]["lesson_id"] == "l-be"
    assert body["completed"][0]["passed"] is True and body["completed"][0]["evaluation_id"] == str(new_id)
    # переоценка переоценки — по цепочке; чужая оценка другого ученика не трогается
    other = uuid.uuid4()
    await reevaluated(env, other, new_id, passed=False, session_id=sid)
    assert (await env.trajectory(user))["completed"][0]["passed"] is True
    newer = await reevaluated(env, user, new_id, passed=False, session_id=sid)
    body = await env.trajectory(user)
    assert body["next"]["lesson_id"] == "l-greet" and body["completed"][0]["evaluation_id"] == str(newer)
    assert env.bus.dlq == []


async def test_evaluation_received_after_session_event(env, user) -> None:
    """R1-05: при finish assessment был недоступен — событие сессии без оценки; оценку позже получил tick lessons —
    assessment.completed.v1 сопоставляется по session_id, урок уходит из «повторить»."""
    await env.profile(user)
    sid = uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", session_id=sid, evaluated=False)
    body = await env.trajectory(user)
    assert latest_result(body) == (None, None) and body["next"]["lesson_id"] == "l-greet"
    assert "repeat" in body["next"]["reason_codes"]
    eid = uuid.uuid4()
    ev = await assessed(env, user, sid, passed=True, evaluation_id=eid)
    body = await env.trajectory(user)
    assert latest_result(body) == (True, str(eid)) and body["next"]["lesson_id"] == "l-be"
    revision = body["revision"]
    # повтор доставки (inbox) и повторная публикация (новый event_id) — без изменений и без новой ревизии
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    assert ASSESSED in spec.event_types
    await spec.handler(ev)
    await assessed(env, user, sid, passed=True, evaluation_id=eid)
    body = await env.trajectory(user)
    assert body["revision"] == revision and latest_result(body) == (True, str(eid))
    [(n,)] = await env.sql("SELECT count(*) FROM lesson_evaluations WHERE user_id = :u", u=user)
    assert n == 1
    # оценка практики (сценарий, медиа, повтор) на пройденные уроки не влияет и не хранится
    for kind in ("scenario", "media", "review"):
        await assessed(env, user, uuid.uuid4(), passed=False, kind=kind)
    [(n,)] = await env.sql("SELECT count(*) FROM lesson_evaluations WHERE user_id = :u", u=user)
    assert n == 1
    assert env.bus.dlq == []


async def test_evaluation_before_session_event(env, user) -> None:
    """Порядок любой: оценка пришла раньше события сессии — применяется при его записи (событие без оценки или с
    той же оценкой)."""
    await env.profile(user)
    sid, eid = uuid.uuid4(), uuid.uuid4()
    await assessed(env, user, sid, passed=True, evaluation_id=eid)
    assert await env.sql("SELECT 1 FROM completed_lessons WHERE user_id = :u", u=user) == []
    await session_done(env, user, lesson_id="l-greet", session_id=sid, evaluated=False)
    body = await env.trajectory(user)
    assert latest_result(body) == (True, str(eid)) and body["next"]["lesson_id"] == "l-be"
    # событие сессии с той же оценкой — то же
    other_sid, other_eid = uuid.uuid4(), uuid.uuid4()
    await assessed(env, user, other_sid, passed=False, evaluation_id=other_eid)
    await session_done(env, user, lesson_id="l-be", session_id=other_sid, evaluation_id=other_eid, passed=False,
                       finished_at="2026-11-16T11:00:00Z")
    body = await env.trajectory(user)
    assert latest_result(body, "l-be") == (False, str(other_eid)) and body["next"]["lesson_id"] == "l-be"


async def test_foreign_producer_assessment_completed_ignored(env, user) -> None:
    await env.profile(user)
    sid = uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", session_id=sid, evaluated=False)
    await assessed(env, user, sid, passed=True, producer="lessons")
    await assessed(env, user, sid, passed=True, producer="diagnostics")
    assert latest_result(await env.trajectory(user)) == (None, None)
    assert await env.sql("SELECT 1 FROM lesson_evaluations WHERE user_id = :u", u=user) == []
    # чужой ученик: оценка другого ученика с той же session_id урок не трогает
    await assessed(env, uuid.uuid4(), sid, passed=True)
    assert latest_result(await env.trajectory(user)) == (None, None)
    assert env.bus.dlq == []


async def test_reevaluation_matched_by_session_after_late_evaluation(env, user) -> None:
    """Событие сессии без оценки → оценка позже → переоценка: сессия переоценки — по заменённой оценке из проекции
    (раньше сопоставлялось только по evaluation_id пройденного урока и терялось)."""
    await env.profile(user)
    sid, eid = uuid.uuid4(), uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", session_id=sid, evaluated=False)
    await assessed(env, user, sid, passed=False, evaluation_id=eid)
    assert latest_result(await env.trajectory(user)) == (False, str(eid))
    new_id = await reevaluated(env, user, eid, passed=True, session_id=sid)
    body = await env.trajectory(user)
    assert latest_result(body) == (True, str(new_id)) and body["next"]["lesson_id"] == "l-be"
    newer = await reevaluated(env, user, new_id, passed=False, session_id=sid, created_at="2026-11-18T09:00:00Z")
    assert latest_result(await env.trajectory(user)) == (False, str(newer))
    # повтор переоценки — без изменений
    await reevaluated(env, user, eid, passed=True, session_id=sid, new_id=new_id)
    assert latest_result(await env.trajectory(user)) == (False, str(newer))
    assert env.bus.dlq == []


@pytest.mark.parametrize("order", [("reeval", "assessed", "session"), ("reeval", "session", "assessed"),
                                   ("session", "reeval", "assessed"), ("assessed", "reeval", "session"),
                                   ("reeval", "session_with_evaluation")])
async def test_reevaluation_any_order(env, user, order: tuple[str, ...]) -> None:
    """Порядок любой: переоценка раньше заменённой оценки и раньше события сессии — ждёт её и применяется, когда
    session_id становится известен (из assessment.completed.v1 или из события сессии с оценкой)."""
    await env.profile(user)
    sid, eid, new_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    steps = {
        "reeval": lambda: reevaluated(env, user, eid, passed=True, session_id=sid, new_id=new_id),
        "assessed": lambda: assessed(env, user, sid, passed=False, evaluation_id=eid),
        "session": lambda: session_done(env, user, lesson_id="l-greet", session_id=sid, evaluated=False),
        "session_with_evaluation": lambda: session_done(env, user, lesson_id="l-greet", session_id=sid,
                                                        evaluation_id=eid, passed=False),
    }
    for name in order:
        await steps[name]()
    body = await env.trajectory(user)
    assert latest_result(body) == (True, str(new_id)) and body["next"]["lesson_id"] == "l-be"
    assert env.bus.dlq == []


async def test_reevaluation_chain_out_of_order(env, user) -> None:
    """Переоценка переоценки пришла раньше первой переоценки: сессия известна из события — актуальна последняя по
    created_at, запоздавшая промежуточная её не перебивает."""
    await env.profile(user)
    sid, eid, e2, e3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", session_id=sid, evaluation_id=eid, passed=False)
    await reevaluated(env, user, e2, passed=True, session_id=sid, new_id=e3, created_at="2026-11-18T09:00:00Z")
    assert latest_result(await env.trajectory(user)) == (True, str(e3))
    await reevaluated(env, user, eid, passed=False, session_id=sid, new_id=e2)
    assert latest_result(await env.trajectory(user)) == (True, str(e3))
    rows = await env.sql("SELECT evaluation_id, session_id FROM lesson_evaluations WHERE user_id = :u", u=user)
    assert {r[0]: r[1] for r in rows} == {e2: sid, e3: sid}


async def test_reevaluation_with_session_id_in_payload(env, user) -> None:
    """Если assessment добавит session_id в assessment.reevaluated.v1 (в схеме v1 его нет), он используется напрямую:
    заменённая оценка learning-plan может быть неизвестна."""
    await env.profile(user)
    sid, new_id = uuid.uuid4(), uuid.uuid4()
    await session_done(env, user, lesson_id="l-greet", session_id=sid, evaluated=False)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(make_envelope(REEVALUATED, {
        "evaluation_id": str(new_id), "supersedes": str(uuid.uuid4()), "user_id": str(user), "pair_id": "ru-en",
        "skill_outcomes": [], "passed": True, "appeal_id": None, "created_at": "2026-11-17T09:00:00Z",
        "session_id": str(sid)}, producer="assessment"))
    assert latest_result(await env.trajectory(user)) == (True, str(new_id))
    assert env.bus.dlq == []


async def test_completed_lesson_missing_from_course_is_hidden(env, user) -> None:
    await env.profile(user)
    await session_done(env, user, lesson_id="l-gone", passed=True, finished_at="2026-11-16T09:00:00Z")
    await session_done(env, user, lesson_id="l-greet", passed=True, finished_at="2026-11-16T10:00:00Z")
    body = await env.trajectory(user)
    assert [c["lesson_id"] for c in body["completed"]] == ["l-greet"]


async def test_learners_isolated_and_other_pair(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    for u in (a, b):
        await env.profile(u)
    await session_done(env, a, lesson_id="l-greet", passed=True)
    body_b = await env.trajectory(b)
    assert body_b["completed"] == [] and body_b["next"]["lesson_id"] == "l-greet"
    assert await activities(env, b) == []
    # урок другой пары в траекторию ru-en не попадает
    c = uuid.uuid4()
    await env.profile(c)
    await env.publish(COMPLETED, {
        "session_id": str(uuid.uuid4()), "user_id": str(c), "kind": "lesson", "pair_id": "ru-uz",
        "lesson_id": "l-greet", "scenario_id": None, "asset_id": None, "status": "completed", "outcome": "success",
        "minutes": 10, "local_date": "2026-11-16", "evaluation_id": str(uuid.uuid4()), "passed": True,
        "practice_only": False, "finished_at": "2026-11-16T10:00:00Z"}, producer="lessons")
    body_c = await env.trajectory(c)
    assert body_c["completed"] == [] and body_c["next"]["lesson_id"] == "l-greet"
    assert len(await activities(env, c)) == 1  # занятие дня засчитано независимо от пары


async def test_trajectory_callers_lessons_allowed(env, user) -> None:
    await env.profile(user)
    r = await env.c.get("/internal/v1/plan/trajectory", headers=env.h(user, issuer="lessons"))
    assert r.status_code == 200 and r.json()["next"]["lesson_id"] == "l-greet"
    for issuer in ("assessment", "diagnostics", "admin-bff"):
        r = await env.c.get("/internal/v1/plan/trajectory", headers=env.h(user, issuer=issuer))
        assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED"), issuer
    r = await env.c.get("/internal/v1/plan/trajectory", headers=internal_headers(env.settings, issuer="lessons"))
    assert (r.status_code, r.json()["code"]) == (401, "USER_CONTEXT_REQUIRED")
    # план и занятия — по-прежнему только telegram-bff
    for method, path in (("GET", "/internal/v1/me/plan"), ("POST", "/internal/v1/me/activities")):
        r = await env.c.request(method, path, headers=env.h(user, issuer="lessons"))
        assert r.status_code == 403, path


async def test_lessons_available_flag(env, user) -> None:
    env.settings.lessons_available = False
    assert (await env.trajectory(user, audience="adults"))["lessons_available"] is False
    env.settings.lessons_available = True
    assert (await env.trajectory(user, audience="adults"))["lessons_available"] is True


async def test_sprint3_revision_without_completed_renders_and_recomputes(env, user) -> None:
    """Ревизия спринта 3 (без completed в items, алгоритм cp-2) читается и пересчитывается по новым правилам."""
    await env.trajectory(user, audience="adults")
    await env.sql("DELETE FROM trajectories WHERE user_id = :u", u=user)
    await env.sql(
        "INSERT INTO trajectories (user_id, pair_id, revision, course_id, basis, next_lesson_id, items, computed_at) "
        "VALUES (:u, 'ru-en', 1, 'en-core', CAST(:b AS jsonb), 'l-greet', "
        "CAST('{\"next\": null, \"mandatory\": [], \"optional\": []}' AS jsonb), now())",
        u=user, b='{"algorithm": "cp-2"}')
    body = await env.trajectory(user, audience="adults")
    assert body["revision"] == 2 and body["completed"] == [] and mandatory(body) == ADULT_CORE


async def test_deletion_removes_completed_lessons_and_late_events_ignored(env, user) -> None:
    other = uuid.uuid4()
    for u in (user, other):
        await session_done(env, u, lesson_id="l-greet")
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-18T09:00:00Z"},
                      producer="identity-consent")
    for table in ("completed_lessons", "activities"):
        [(mine,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        [(theirs,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=other)  # noqa: S608
        assert (mine, theirs) == (0, 1), table
    sid = uuid.uuid4()
    await session_done(env, user, lesson_id="l-be", session_id=sid)
    await reevaluated(env, user, uuid.uuid4(), passed=True, session_id=sid)
    await assessed(env, user, sid, passed=True)
    assert await activities(env, user) == []
    assert await env.sql("SELECT 1 FROM completed_lessons WHERE user_id = :u", u=user) == []
    assert await env.sql("SELECT 1 FROM lesson_evaluations WHERE user_id = :u", u=user) == []
    assert env.bus.dlq == []


def test_course_fixture_unchanged() -> None:
    """Набор уроков фикстуры, на который опираются проверки «следующего»."""
    assert [x["lesson_id"] for x in course()["lessons"]][:3] == ["l-greet", "l-be", "l-numbers"]
