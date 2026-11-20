"""Дефекты сквозного e2e спринта 6 (по тесту на каждый): привязка наград навыков к занятию по evidence_id в любом
порядке событий; пояс, неизвестный PostgreSQL; daily_stats по дате STATS_TIMEZONE; первая выкладка — бонус
регистрации ученикам до спринта 6 и без уведомлений по старым событиям."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from conftest import Env


async def rewards(env: Env, user: uuid.UUID, sid: uuid.UUID) -> dict[str, Any]:
    return dict(await env.get(user, "rewards", params={"source_session_id": str(sid)}))


async def test_skill_rewards_follow_evidence_in_any_order(env: Env, user: uuid.UUID) -> None:
    """1: навыки → занятие по evidence_id = evaluation_id урока; порядок событий любой; без evidence — 10 минут."""
    await env.send("PUT", user, "hero", {"hero_code": "pet_0"})
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    await env.demonstrate(user, 4)  # без урока рядом — ни к какому занятию
    # (а) урок раньше навыков; затем другой урок; навыки первого урока приходят последними
    e1, e2 = uuid.uuid4(), uuid.uuid4()
    s1 = await env.lesson(user, evaluation_id=e1)
    s2 = await env.lesson(user, evaluation_id=e2)
    await env.skills(user, [("en.e1", "learning", "demonstrated")], evidence=e1)  # 5-й навык → ступень 2
    r1, r2 = await rewards(env, user, s1), await rewards(env, user, s2)
    assert {o["reason"] for o in r1["operations"]} >= {"lesson", "skill_demonstrated"}
    assert r1["hero_stage_up"] == {"from": 1, "to": 2}
    assert "skill_demonstrated" not in {o["reason"] for o in r2["operations"]} and r2["hero_stage_up"] is None
    # (б) навыки раньше урока: итоги ждут урок с тем же evaluation_id (уже позже 10 минут после прошлого урока)
    env.now += timedelta(minutes=30)
    e3 = uuid.uuid4()
    await env.skills(user, [(f"en.e3.{i}", "learning", "demonstrated") for i in range(10)], evidence=e3)
    assert await env.sql("SELECT count(*) FROM evidence_rewards WHERE user_id = :u", u=user) == [(1,)]
    assert (await rewards(env, user, s2))["hero_stage_up"] is None
    s3 = await env.lesson(user, evaluation_id=e3)
    r3 = await rewards(env, user, s3)
    skill_xp = [o for o in r3["operations"] if o["reason"] == "skill_demonstrated" and o["currency"] == "xp"]
    assert len(skill_xp) == 10 and r3["hero_stage_up"] == {"from": 2, "to": 3}  # 10 навыков (тилы — под лимитом)
    assert "skills_10" in {b["code"] for b in r3["badges"]}
    assert {o["reason"] for o in r3["operations"]} >= {"lesson"}
    assert await env.sql("SELECT count(*) FROM evidence_rewards WHERE user_id = :u", u=user) == [(0,)]
    # реестр не менялся: связь — в итогах занятия, source_session_id у операций навыков пуст
    rows = await env.sql("SELECT count(*) FROM ledger WHERE user_id = :u AND reason = 'skill_demonstrated' "
                         "AND source_session_id IS NULL", u=user)
    assert rows[0][0] >= 10
    # без evidence_id — правило 10 минут: последний урок (следующий день — дневной лимит XP уже исчерпан)
    env.now += timedelta(days=1)
    s4 = await env.lesson(user)
    await env.skills(user, [("en.no_evidence", "learning", "demonstrated")])
    assert "skill_demonstrated" in {o["reason"] for o in (await rewards(env, user, s4))["operations"]}


async def test_tick_survives_timezone_unknown_to_postgres(env: Env, user: uuid.UUID) -> None:
    """2: пояс, который знает zoneinfo, но не PostgreSQL, не роняет tick; проекция такой пояс не сохраняет."""
    await env.get(user, "quests")
    other = uuid.uuid4()
    await env.get(other, "quests")
    # пояс, сохранённый до исправления (напрямую), — tick всё равно считает полночь ученика в Python
    await env.sql("UPDATE learners SET timezone = 'America/Godthab' WHERE user_id = :u", u=user)
    env.now += timedelta(days=1, hours=6)
    out = await env.tick()
    assert out["quests_expired"] == 6
    assert {s for (s,) in await env.sql("SELECT status FROM quests")} == {"expired"}
    for tz in ("America/Godthab", "Asia/Rangoon"):
        await env.plan(user, tz=tz)
        assert await env.sql("SELECT timezone FROM learners WHERE user_id = :u", u=user) == [(None,)]
    await env.plan(user, tz="America/Nuuk")
    assert await env.sql("SELECT timezone FROM learners WHERE user_id = :u", u=user) == [("America/Nuuk",)]


async def test_daily_stats_by_stats_timezone(env: Env, user: uuid.UUID) -> None:
    """3: ученик восточнее Ташкента после своей полуночи попадает в обзор (daily_stats — по дате STATS_TIMEZONE)."""
    env.now = datetime(2026, 11, 20, 16, 30, tzinfo=UTC)  # Токио 01:30 21.11, Ташкент 21:30 20.11
    await env.plan(user, tz="Asia/Tokyo")
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    await env.lesson(user, passed=True)
    [(op_day,)] = await env.sql("SELECT DISTINCT local_date FROM ledger WHERE user_id = :u AND reason = 'lesson'",
                                u=user)
    assert op_day.isoformat() == "2026-11-21"  # день ученика — его пояс
    days = {d.isoformat() for (d,) in await env.sql("SELECT DISTINCT local_date FROM daily_stats")}
    assert days == {"2026-11-20"}
    out = await env.adm("GET", "overview?period=7d", perms=("game.read",))
    assert out["earned"]["xp"] == 30 and out["freezes"]["granted"] == 2


async def test_first_rollout_bonus_for_existing_learners(env: Env, user: uuid.UUID) -> None:
    """4а: ученик, зарегистрированный до спринта 6 (его user.profile.created давно прочитан), получает бонус
    регистрации при первом ходе; поздний user.profile.created того же ученика дубля не даёт."""
    await env.lesson(user)  # первое событие ученика
    [bonus] = [op for op in await env.ops(user, bonus=True) if op.reason == "registration_bonus"]
    assert (bonus.amount, bonus.idempotency_key) == (2, f"registration_bonus:{user}")
    await env.profile(user)
    assert len([op for op in await env.ops(user, bonus=True) if op.reason == "registration_bonus"]) == 1
    assert (await env.wallet(user))["freeze"] == 2
    # первый запрос нового ученика (строки ещё нет) и ученик, созданный проекцией плана, — тоже с бонусом
    fresh, planned = uuid.uuid4(), uuid.uuid4()
    assert (await env.get(fresh, "summary"))["freeze_stock"] == 2
    await env.plan(planned)
    assert (await env.get(planned, "summary"))["freeze_stock"] == 2
    kid, parent = uuid.uuid4(), uuid.uuid4()
    assert (await env.get(kid, "shop", age_band="6-9", account=parent))["freeze_stock"] == 2


async def test_first_rollout_no_notifications_for_old_events(env: Env, user: uuid.UUID) -> None:
    """4б: по событиям старше часа notify=false (значки, рост героя); пропуск старше суток заморозку не тратит и
    game.streak.frozen.v1 не выпускает."""
    await env.send("PUT", user, "hero", {"hero_code": "robot_0"})
    old = env.now - timedelta(hours=2)
    await env.lesson(user, finished_at=old)
    await env.skills(user, [(f"en.o{i}", "learning", "demonstrated") for i in range(5)], occurred_at=old)
    badges = {e.payload["badge_code"]: e.payload["notify"] for e in await env.events("game.badge.earned.v1", user)}
    assert badges == {"first_lesson": False}
    [stage] = await env.events("game.hero.stage_reached.v1", user)
    assert stage.payload["notify"] is False and stage.payload["stage"] == 2
    # свежие — с уведомлением
    fresh = uuid.uuid4()
    await env.lesson(fresh)
    [b] = await env.events("game.badge.earned.v1", fresh)
    assert b.payload["notify"] is True
    # пропуск старше суток после конца дня — без списания и без события
    await env.missed(user, env.today - timedelta(days=2))
    assert await env.events("game.streak.frozen.v1", user) == []
    assert (await env.wallet(user))["freeze"] == 2
